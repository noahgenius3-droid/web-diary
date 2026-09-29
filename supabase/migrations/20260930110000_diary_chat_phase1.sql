-- Chat phase 1: editing, delete for me / for everyone with 30-day recovery, presence & last seen with
-- privacy controls, and voice notes in group chats.

-- ============================================================================
-- Editing (DMs and group chats) with history
-- ============================================================================
alter table public.diary_messages add column if not exists edited_at timestamptz, add column if not exists restored_at timestamptz;
alter table public.diary_community_messages add column if not exists edited_at timestamptz, add column if not exists restored_at timestamptz;

create table if not exists public.diary_message_edits (
    id bigint generated always as identity primary key,
    kind text not null check (kind in ('dm', 'gc')),
    message_id bigint not null,
    body text not null,
    edited_at timestamptz not null default now()
);
create index if not exists diary_message_edits_msg_idx on public.diary_message_edits (kind, message_id, edited_at);
alter table public.diary_message_edits enable row level security;
-- Anyone who can read the message can see its earlier versions
create policy "Edit history follows the message" on public.diary_message_edits
    for select to authenticated using (
        (kind = 'dm' and exists (select 1 from public.diary_messages m where m.id = message_id and (select auth.uid()) in (m.sender, m.recipient)))
        or (kind = 'gc' and exists (select 1 from public.diary_community_messages m where m.id = message_id and private.diary_is_member(m.community_id, (select auth.uid()))))
    );
revoke all on public.diary_message_edits from anon, authenticated;
grant select on public.diary_message_edits to authenticated;

create or replace function public.diary_edit_message(p_id bigint, p_body text)
returns public.diary_messages
language plpgsql
security definer
set search_path = ''
as $$
declare
    m public.diary_messages;
begin
    select * into m from public.diary_messages where id = p_id and sender = auth.uid() for update;
    if not found or m.deleted_at is not null then raise exception 'Message not found'; end if;
    if m.created_at < now() - interval '24 hours' then raise exception 'Messages can be edited for 24 hours'; end if;
    if char_length(coalesce(p_body, '')) = 0 or char_length(p_body) > 20000 then raise exception 'Write something first'; end if;
    if p_body = m.body then return m; end if;
    insert into public.diary_message_edits (kind, message_id, body, edited_at) values ('dm', m.id, m.body, coalesce(m.edited_at, m.created_at));
    update public.diary_messages set body = p_body, edited_at = now() where id = m.id returning * into m;
    return m;
end;
$$;
revoke all on function public.diary_edit_message(bigint, text) from public, anon;
grant execute on function public.diary_edit_message(bigint, text) to authenticated;

create or replace function public.diary_edit_community_message(p_id bigint, p_body text)
returns public.diary_community_messages
language plpgsql
security definer
set search_path = ''
as $$
declare
    m public.diary_community_messages;
begin
    select * into m from public.diary_community_messages where id = p_id and author = auth.uid() for update;
    if not found or m.deleted_at is not null then raise exception 'Message not found'; end if;
    if not private.diary_is_member(m.community_id, auth.uid()) then raise exception 'Not allowed'; end if;
    if m.created_at < now() - interval '24 hours' then raise exception 'Messages can be edited for 24 hours'; end if;
    if char_length(btrim(coalesce(p_body, ''))) = 0 or char_length(p_body) > 4000 then raise exception 'Write something first'; end if;
    if p_body = m.body then return m; end if;
    insert into public.diary_message_edits (kind, message_id, body, edited_at) values ('gc', m.id, m.body, coalesce(m.edited_at, m.created_at));
    update public.diary_community_messages set body = p_body, edited_at = now() where id = m.id returning * into m;
    return m;
end;
$$;
revoke all on function public.diary_edit_community_message(bigint, text) from public, anon;
grant execute on function public.diary_edit_community_message(bigint, text) to authenticated;

-- ============================================================================
-- Delete for me (hidden just for you) and delete for everyone (kept 30 days so it can be restored)
-- ============================================================================
create table if not exists public.diary_message_hidden (
    user_id uuid not null default auth.uid() references public.diary_profiles (id) on delete cascade,
    kind text not null check (kind in ('dm', 'gc')),
    message_id bigint not null,
    hidden_at timestamptz not null default now(),
    primary key (user_id, kind, message_id)
);
alter table public.diary_message_hidden enable row level security;
create policy "See what you hid" on public.diary_message_hidden
    for select to authenticated using (user_id = (select auth.uid()));
create policy "Hide messages for yourself" on public.diary_message_hidden
    for insert to authenticated with check (user_id = (select auth.uid()));
-- Restoring is possible for 30 days
create policy "Unhide within 30 days" on public.diary_message_hidden
    for delete to authenticated using (user_id = (select auth.uid()) and hidden_at > now() - interval '30 days');
revoke all on public.diary_message_hidden from anon, authenticated;
grant select, delete on public.diary_message_hidden to authenticated;
grant insert (kind, message_id) on public.diary_message_hidden to authenticated;

-- Messages you hid are left out when you read the conversation
drop policy if exists "Users read their own conversations" on public.diary_messages;
create policy "Users read their own conversations" on public.diary_messages
    for select to authenticated
    using (((select auth.uid()) = sender or (select auth.uid()) = recipient)
        and (expires_at is null or expires_at > now())
        and not exists (select 1 from public.diary_message_hidden h where h.user_id = (select auth.uid()) and h.kind = 'dm' and h.message_id = diary_messages.id));
drop policy if exists "Members read their group chat" on public.diary_community_messages;
create policy "Members read their group chat" on public.diary_community_messages
    for select to authenticated
    using (private.diary_is_member(community_id, (select auth.uid()))
        and not exists (select 1 from public.diary_message_hidden h where h.user_id = (select auth.uid()) and h.kind = 'gc' and h.message_id = diary_community_messages.id));

-- What was removed for everyone, so whoever removed it can bring it back
create table if not exists public.diary_message_trash (
    kind text not null check (kind in ('dm', 'gc')),
    message_id bigint not null,
    deleted_by uuid not null references public.diary_profiles (id) on delete cascade,
    author uuid not null references public.diary_profiles (id) on delete cascade,
    body text not null default '',
    attachments jsonb not null default '[]'::jsonb,
    deleted_at timestamptz not null default now(),
    primary key (kind, message_id)
);
alter table public.diary_message_trash enable row level security;
create policy "See what you removed" on public.diary_message_trash
    for select to authenticated using (deleted_by = (select auth.uid()));
revoke all on public.diary_message_trash from anon, authenticated;
grant select on public.diary_message_trash to authenticated;

-- Files: which bucket a vanished/purged file lives in (the owner's app deletes it)
alter table public.diary_incognito_trash add column if not exists bucket text not null default 'diary-chat';

create or replace function public.diary_unsend_message(p_id bigint)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
    m public.diary_messages;
begin
    select * into m from public.diary_messages where id = p_id and sender = auth.uid() and deleted_at is null for update;
    if not found then raise exception 'Message not found'; end if;
    insert into public.diary_message_trash (kind, message_id, deleted_by, author, body, attachments)
    values ('dm', m.id, auth.uid(), m.sender, m.body, m.attachments)
    on conflict (kind, message_id) do update set body = excluded.body, attachments = excluded.attachments, deleted_at = now();
    update public.diary_messages
    set deleted_at = now(), body = '', attachments = '[]'::jsonb, reactions = '{}'::jsonb, restored_at = null
    where id = p_id;
    return '[]'::jsonb; -- files are kept for 30 days so the message can be restored
end;
$$;

create or replace function public.diary_delete_community_message(mid bigint)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
    me uuid := auth.uid();
    msg public.diary_community_messages;
begin
    select * into msg from public.diary_community_messages where id = mid;
    if msg.id is null or msg.deleted_at is not null then raise exception 'Message not found'; end if;
    if msg.author <> me and not private.diary_is_moderator(msg.community_id, me) then raise exception 'Not allowed'; end if;
    insert into public.diary_message_trash (kind, message_id, deleted_by, author, body, attachments)
    values ('gc', msg.id, me, msg.author, msg.body, msg.attachments)
    on conflict (kind, message_id) do update set deleted_by = excluded.deleted_by, body = excluded.body, attachments = excluded.attachments, deleted_at = now();
    update public.diary_community_messages set deleted_at = now(), deleted_by = me, body = '', attachments = '[]'::jsonb, restored_at = null where id = mid;
    update public.diary_communities set pinned_message = null where id = msg.community_id and pinned_message = mid;
end;
$$;

create or replace function public.diary_restore_message(p_kind text, p_id bigint)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
    t public.diary_message_trash;
begin
    select * into t from public.diary_message_trash where kind = p_kind and message_id = p_id and deleted_by = auth.uid();
    if not found then raise exception 'Nothing to restore'; end if;
    if t.deleted_at < now() - interval '30 days' then raise exception 'It’s been more than 30 days'; end if;
    if p_kind = 'dm' then
        update public.diary_messages set body = t.body, attachments = t.attachments, deleted_at = null, restored_at = now() where id = p_id;
    else
        if not private.diary_is_member((select community_id from public.diary_community_messages where id = p_id), auth.uid()) then
            raise exception 'Not allowed';
        end if;
        update public.diary_community_messages set body = t.body, attachments = t.attachments, deleted_at = null, deleted_by = null, restored_at = now() where id = p_id;
    end if;
    delete from public.diary_message_trash where kind = p_kind and message_id = p_id;
end;
$$;
revoke all on function public.diary_restore_message(text, bigint) from public, anon;
grant execute on function public.diary_restore_message(text, bigint) to authenticated;

-- "Recently deleted": what you hid for yourself or removed for everyone in the last 30 days
create or replace function public.diary_recently_deleted(p_kind text default null, p_scope text default null)
returns table (kind text, message_id bigint, how text, author uuid, body text, attachments jsonb, created_at timestamptz, deleted_at timestamptz, scope text)
language sql
stable
security definer
set search_path = ''
as $$
    select 'dm', m.id, 'me', m.sender, m.body, m.attachments, m.created_at, h.hidden_at,
           (case when m.sender = auth.uid() then m.recipient else m.sender end)::text
    from public.diary_message_hidden h
    join public.diary_messages m on m.id = h.message_id
    where h.user_id = auth.uid() and h.kind = 'dm' and h.hidden_at > now() - interval '30 days'
      and auth.uid() in (m.sender, m.recipient) and m.deleted_at is null
      and (p_kind is null or p_kind = 'dm')
      and (p_scope is null or p_scope = (case when m.sender = auth.uid() then m.recipient else m.sender end)::text)
    union all
    select 'gc', m.id, 'me', m.author, m.body, m.attachments, m.created_at, h.hidden_at, m.community_id::text
    from public.diary_message_hidden h
    join public.diary_community_messages m on m.id = h.message_id
    where h.user_id = auth.uid() and h.kind = 'gc' and h.hidden_at > now() - interval '30 days'
      and private.diary_is_member(m.community_id, auth.uid()) and m.deleted_at is null
      and (p_kind is null or p_kind = 'gc') and (p_scope is null or p_scope = m.community_id::text)
    union all
    select t.kind, t.message_id, 'everyone', t.author, t.body, t.attachments,
           coalesce(dm.created_at, gc.created_at), t.deleted_at,
           case when t.kind = 'dm' then (case when dm.sender = auth.uid() then dm.recipient else dm.sender end)::text else gc.community_id::text end
    from public.diary_message_trash t
    left join public.diary_messages dm on t.kind = 'dm' and dm.id = t.message_id
    left join public.diary_community_messages gc on t.kind = 'gc' and gc.id = t.message_id
    where t.deleted_by = auth.uid() and t.deleted_at > now() - interval '30 days'
      and (dm.id is not null or gc.id is not null)
      and (p_kind is null or p_kind = t.kind)
      and (p_scope is null or p_scope = case when t.kind = 'dm' then (case when dm.sender = auth.uid() then dm.recipient else dm.sender end)::text else gc.community_id::text end)
    order by 8 desc
    limit 200;
$$;
revoke all on function public.diary_recently_deleted(text, text) from public, anon;
grant execute on function public.diary_recently_deleted(text, text) to authenticated;

-- After 30 days removed messages are gone for good; their files go to the owner's clean-up list
create or replace function private.diary_purge_expired()
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
    insert into public.diary_incognito_trash (owner, path)
    select m.sender, a->>'path'
    from public.diary_messages m, jsonb_array_elements(m.attachments) a
    where m.expires_at <= now() and jsonb_typeof(a) = 'object' and a ? 'path';
    delete from public.diary_messages where expires_at <= now();

    insert into public.diary_incognito_trash (owner, path, bucket)
    select t.author, a->>'path', case when t.kind = 'dm' then 'diary-chat' else 'diary-community' end
    from public.diary_message_trash t, jsonb_array_elements(t.attachments) a
    where t.deleted_at <= now() - interval '30 days' and jsonb_typeof(a) = 'object' and a ? 'path';
    delete from public.diary_message_trash where deleted_at <= now() - interval '30 days';
end;
$$;

-- ============================================================================
-- Presence: online now and last seen, each with its own privacy setting
-- ============================================================================
create table if not exists public.diary_presence (
    user_id uuid primary key references public.diary_profiles (id) on delete cascade,
    last_seen_at timestamptz,
    show_online text not null default 'everyone' check (show_online in ('everyone', 'friends', 'nobody')),
    show_last_seen text not null default 'everyone' check (show_last_seen in ('everyone', 'friends', 'nobody'))
);
alter table public.diary_presence enable row level security;
create policy "Your own presence settings" on public.diary_presence
    for select to authenticated using (user_id = (select auth.uid()));
revoke all on public.diary_presence from anon, authenticated;
grant select on public.diary_presence to authenticated;

create or replace function public.diary_heartbeat()
returns void
language sql
security definer
set search_path = ''
as $$
    insert into public.diary_presence (user_id, last_seen_at) values (auth.uid(), now())
    on conflict (user_id) do update set last_seen_at = now();
$$;
revoke all on function public.diary_heartbeat() from public, anon;
grant execute on function public.diary_heartbeat() to authenticated;

create or replace function public.diary_set_presence_privacy(p_online text, p_last_seen text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
    if p_online not in ('everyone', 'friends', 'nobody') or p_last_seen not in ('everyone', 'friends', 'nobody') then
        raise exception 'Unknown setting';
    end if;
    insert into public.diary_presence (user_id, show_online, show_last_seen) values (auth.uid(), p_online, p_last_seen)
    on conflict (user_id) do update set show_online = p_online, show_last_seen = p_last_seen;
end;
$$;
revoke all on function public.diary_set_presence_privacy(text, text) from public, anon;
grant execute on function public.diary_set_presence_privacy(text, text) to authenticated;

-- Online / last seen for a list of people, as far as each of them allows you to see.
-- Fair play (like WhatsApp): if you hide your own last seen, you can't see other people's.
create or replace function public.diary_get_presence(ids uuid[])
returns table (id uuid, online boolean, last_seen timestamptz)
language sql
stable
security definer
set search_path = ''
as $$
    with me as (
        select auth.uid() as uid,
               coalesce((select show_last_seen from public.diary_presence where user_id = auth.uid()), 'everyone') as mine
    )
    select p.user_id,
        case when p.last_seen_at > now() - interval '75 seconds'
              and (p.show_online = 'everyone' or (p.show_online = 'friends' and private.diary_are_friends(p.user_id, (select uid from me))))
             then true else false end,
        case when (select mine from me) <> 'nobody'
              and (p.show_last_seen = 'everyone' or (p.show_last_seen = 'friends' and private.diary_are_friends(p.user_id, (select uid from me))))
             then p.last_seen_at end
    from public.diary_presence p
    where (select uid from me) is not null
      and p.user_id = any (ids[1:200])
      and p.user_id <> (select uid from me);
$$;
revoke all on function public.diary_get_presence(uuid[]) from public, anon;
grant execute on function public.diary_get_presence(uuid[]) to authenticated;

-- ============================================================================
-- Voice notes in group chats
-- ============================================================================
update storage.buckets
set allowed_mime_types = array['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'audio/webm', 'audio/ogg', 'audio/mp4', 'audio/mpeg', 'audio/wav', 'audio/aac', 'audio/x-m4a']
where id = 'diary-community';

alter publication supabase_realtime add table public.diary_message_hidden;

-- Lock-screen alerts also when someone you know goes live
create or replace function private.diary_push_notification()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
    cfg private.diary_push_config;
begin
    if new.type not in ('friend_request', 'friend_accepted', 'new_follower', 'live_started') then
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
