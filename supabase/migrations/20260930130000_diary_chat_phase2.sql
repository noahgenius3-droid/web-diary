-- Chat phase 2: delivery status & read-receipt privacy, retry-safe sending, forwarding, longer disappearing
-- timers, per-chat organisation (pin / archive / mark unread / mute), group reactions and @mentions.

-- ============================================================================
-- Delivery: every message carries the sender's own id for it (so a retry never makes a duplicate),
-- and is stamped "delivered" when it reaches the other person's device
-- ============================================================================
alter table public.diary_messages
    add column if not exists client_id uuid,
    add column if not exists delivered_at timestamptz,
    add column if not exists forwarded boolean not null default false;
create unique index if not exists diary_messages_client_idx on public.diary_messages (sender, client_id) where client_id is not null;
grant insert (client_id, forwarded) on public.diary_messages to authenticated;

alter table public.diary_community_messages
    add column if not exists client_id uuid,
    add column if not exists forwarded boolean not null default false;
create unique index if not exists diary_community_messages_client_idx on public.diary_community_messages (author, client_id) where client_id is not null;
grant insert (client_id, forwarded) on public.diary_community_messages to authenticated;

create or replace function public.diary_mark_delivered(ids bigint[])
returns void
language sql
security definer
set search_path = ''
as $$
    update public.diary_messages set delivered_at = now()
    where recipient = auth.uid() and delivered_at is null and id = any (ids[1:500]);
$$;
revoke all on function public.diary_mark_delivered(bigint[]) from public, anon;
grant execute on function public.diary_mark_delivered(bigint[]) to authenticated;

-- Reading a message also counts as delivered
create or replace function public.diary_mark_read(friend uuid)
returns void
language sql
security definer
set search_path = ''
as $$
    update public.diary_messages
    set read_at = now(),
        delivered_at = coalesce(delivered_at, now()),
        expires_at = case when vanish = 'seen' then least(expires_at, now() + interval '5 minutes') else expires_at end
    where recipient = auth.uid() and sender = friend and read_at is null;
$$;

-- ============================================================================
-- Read receipts are a privacy choice (and a two-way one: turn yours off and you don't see others')
-- ============================================================================
alter table public.diary_presence add column if not exists read_receipts boolean not null default true;

create or replace function public.diary_set_read_receipts(p_on boolean)
returns void
language sql
security definer
set search_path = ''
as $$
    insert into public.diary_presence (user_id, read_receipts) values (auth.uid(), coalesce(p_on, true))
    on conflict (user_id) do update set read_receipts = coalesce(p_on, true);
$$;
revoke all on function public.diary_set_read_receipts(boolean) from public, anon;
grant execute on function public.diary_set_read_receipts(boolean) to authenticated;

drop function if exists public.diary_get_presence(uuid[]);
create or replace function public.diary_get_presence(ids uuid[])
returns table (id uuid, online boolean, last_seen timestamptz, receipts boolean)
language sql
stable
security definer
set search_path = ''
as $$
    with me as (
        select auth.uid() as uid,
               coalesce((select show_last_seen from public.diary_presence where user_id = auth.uid()), 'everyone') as mine,
               coalesce((select read_receipts from public.diary_presence where user_id = auth.uid()), true) as my_receipts
    )
    select p.user_id,
        case when p.last_seen_at > now() - interval '75 seconds'
              and (p.show_online = 'everyone' or (p.show_online = 'friends' and private.diary_are_friends(p.user_id, (select uid from me))))
             then true else false end,
        case when (select mine from me) <> 'nobody'
              and (p.show_last_seen = 'everyone' or (p.show_last_seen = 'friends' and private.diary_are_friends(p.user_id, (select uid from me))))
             then p.last_seen_at end,
        p.read_receipts and (select my_receipts from me)
    from public.diary_presence p
    where (select uid from me) is not null
      and p.user_id = any (ids[1:200])
      and p.user_id <> (select uid from me);
$$;
revoke all on function public.diary_get_presence(uuid[]) from public, anon;
grant execute on function public.diary_get_presence(uuid[]) to authenticated;

-- ============================================================================
-- Disappearing messages: 24 hours, 7 days or 30 days (alongside "after seen" and 1 hour)
-- ============================================================================
alter table public.diary_messages drop constraint if exists diary_messages_vanish_check;
alter table public.diary_messages add constraint diary_messages_vanish_check check (vanish in ('seen', '1h', '24h', '7d', '30d'));
alter table public.diary_incognito drop constraint if exists diary_incognito_mode_check;
alter table public.diary_incognito add constraint diary_incognito_mode_check check (mode in ('off', 'seen', '1h', '24h', '7d', '30d'));

create or replace function public.diary_set_incognito(friend uuid, p_mode text)
returns public.diary_incognito
language plpgsql
security definer
set search_path = ''
as $$
declare
    me uuid := auth.uid();
    rec public.diary_incognito;
begin
    if me is null or friend is null or friend = me then raise exception 'Choose a friend'; end if;
    if p_mode not in ('off', 'seen', '1h', '24h', '7d', '30d') then raise exception 'Unknown setting'; end if;
    if not private.diary_are_friends(me, friend) then raise exception 'Only between friends'; end if;
    insert into public.diary_incognito (user_a, user_b, mode, set_by, updated_at)
    values (least(me, friend), greatest(me, friend), p_mode, me, now())
    on conflict (user_a, user_b) do update set mode = excluded.mode, set_by = excluded.set_by, updated_at = now()
    returning * into rec;
    perform private.diary_purge_expired();
    return rec;
end;
$$;

create or replace function private.diary_stamp_incognito()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
    m text;
begin
    select i.mode into m from public.diary_incognito i
    where i.user_a = least(new.sender, new.recipient) and i.user_b = greatest(new.sender, new.recipient);
    if m is null or m = 'off' then
        new.vanish := null;
        new.expires_at := null;
    else
        new.vanish := m;
        new.expires_at := now() + case m
            when '1h' then interval '1 hour'
            when '7d' then interval '7 days'
            when '30d' then interval '30 days'
            else interval '24 hours' end;
    end if;
    perform private.diary_purge_expired();
    return new;
end;
$$;

-- ============================================================================
-- Per-chat organisation, synced across your devices
-- ============================================================================
create table if not exists public.diary_chat_prefs (
    user_id uuid not null default auth.uid() references public.diary_profiles (id) on delete cascade,
    kind text not null check (kind in ('dm', 'gc')),
    peer text not null check (char_length(peer) <= 64),
    pinned_at timestamptz,
    archived boolean not null default false,
    marked_unread boolean not null default false,
    muted_until timestamptz,
    sound text check (sound in ('chime', 'pop', 'bell', 'soft', 'none')),
    updated_at timestamptz not null default now(),
    primary key (user_id, kind, peer)
);
alter table public.diary_chat_prefs enable row level security;
create policy "Your own chat settings" on public.diary_chat_prefs
    for all to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
revoke all on public.diary_chat_prefs from anon, authenticated;
grant select, delete on public.diary_chat_prefs to authenticated;
grant insert (kind, peer, pinned_at, archived, marked_unread, muted_until, sound, updated_at) on public.diary_chat_prefs to authenticated;
grant update (pinned_at, archived, marked_unread, muted_until, sound, updated_at) on public.diary_chat_prefs to authenticated;

-- ============================================================================
-- Reactions on group messages
-- ============================================================================
create table if not exists public.diary_community_message_reactions (
    message_id bigint not null references public.diary_community_messages (id) on delete cascade,
    user_id uuid not null default auth.uid() references public.diary_profiles (id) on delete cascade,
    emoji text not null check (char_length(emoji) between 1 and 16),
    created_at timestamptz not null default now(),
    primary key (message_id, user_id, emoji)
);
create index if not exists diary_cmr_user_idx on public.diary_community_message_reactions (user_id);
alter table public.diary_community_message_reactions enable row level security;
create policy "Members see reactions" on public.diary_community_message_reactions
    for select to authenticated using (exists (select 1 from public.diary_community_messages m where m.id = message_id and private.diary_is_member(m.community_id, (select auth.uid()))));
create policy "Members react" on public.diary_community_message_reactions
    for insert to authenticated with check (user_id = (select auth.uid()) and exists (select 1 from public.diary_community_messages m where m.id = message_id and m.deleted_at is null and private.diary_is_member(m.community_id, (select auth.uid()))));
create policy "Take back your reaction" on public.diary_community_message_reactions
    for delete to authenticated using (user_id = (select auth.uid()));
revoke all on public.diary_community_message_reactions from anon, authenticated;
grant select, delete on public.diary_community_message_reactions to authenticated;
grant insert (message_id, emoji) on public.diary_community_message_reactions to authenticated;

-- ============================================================================
-- @mentions in group chats (and @everyone for admins/moderators)
-- ============================================================================
alter table public.diary_notifications drop constraint diary_notifications_type_check;
alter table public.diary_notifications add constraint diary_notifications_type_check check (type = any (array[
  'friend_request','friend_accepted','entry_like','entry_comment','post_like','post_comment','community_post','community_join',
  'call_started','missed_call','entry_repost','reel_like','reel_comment','library_like','live_started','new_follower',
  'book_request','book_request_update','book_message','entry_reaction','story_reaction','mention','reply']));

create or replace function private.diary_on_community_message()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
    c public.diary_communities;
    names text[];
    everyone boolean;
    target record;
    snippet text := left(regexp_replace(coalesce(new.body, ''), '\s+', ' ', 'g'), 120);
    replied_to uuid;
begin
    if new.body is null or new.body = '' then return new; end if;
    select * into c from public.diary_communities where id = new.community_id;
    select array_agg(distinct lower(m[1])) into names from regexp_matches(new.body, '@([A-Za-z0-9_]{3,20})', 'g') as m;
    everyone := new.body ~* '@(everyone|all)\M' and private.diary_is_moderator(new.community_id, new.author);
    for target in
        select distinct mem.user_id
        from public.diary_community_members mem
        join public.diary_profiles p on p.id = mem.user_id
        where mem.community_id = new.community_id and mem.user_id <> new.author
          and (everyone or lower(p.username) = any (coalesce(names, '{}')))
        limit 500
    loop
        perform private.diary_notify(target.user_id, new.author, 'mention', jsonb_build_object(
            'community_id', new.community_id, 'community_name', c.name, 'emoji', c.emoji, 'message_id', new.id, 'snippet', snippet, 'everyone', everyone));
    end loop;
    -- A reply lets the person you replied to know (unless they were already mentioned)
    if new.reply_to is not null then
        select author into replied_to from public.diary_community_messages where id = new.reply_to;
        if replied_to is not null and replied_to <> new.author
           and not exists (select 1 from public.diary_profiles p where p.id = replied_to and (everyone or lower(p.username) = any (coalesce(names, '{}')))) then
            perform private.diary_notify(replied_to, new.author, 'reply', jsonb_build_object(
                'community_id', new.community_id, 'community_name', c.name, 'emoji', c.emoji, 'message_id', new.id, 'snippet', snippet));
        end if;
    end if;
    return new;
end;
$$;
drop trigger if exists diary_community_messages_mentions on public.diary_community_messages;
create trigger diary_community_messages_mentions after insert on public.diary_community_messages
    for each row execute function private.diary_on_community_message();

-- Mentions and replies also reach phones
create or replace function private.diary_push_notification()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
    cfg private.diary_push_config;
begin
    if new.type not in ('friend_request', 'friend_accepted', 'new_follower', 'live_started', 'mention', 'reply') then
        return new;
    end if;
    if not exists (select 1 from public.diary_push_subscriptions where user_id = new.user_id) then
        return new;
    end if;
    select * into cfg from private.diary_push_config where id;
    if not found then
        return new;
    end if;
    perform net.http_post(
        url := cfg.function_url,
        body := jsonb_build_object('notification_id', new.id),
        headers := jsonb_build_object('Content-Type', 'application/json', 'x-push-secret', cfg.trigger_secret),
        timeout_milliseconds := 8000
    );
    return new;
exception when others then
    return new;
end;
$$;

alter publication supabase_realtime add table public.diary_chat_prefs, public.diary_community_message_reactions;

-- Upserting a chat setting updates the same row (the key columns are part of the update)
grant update (kind, peer) on public.diary_chat_prefs to authenticated;
