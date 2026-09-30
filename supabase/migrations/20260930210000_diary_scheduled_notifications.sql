-- Phase B: scheduled posts (feed posts, group posts / announcements, messages) published by the server on
-- time, drafts, and a notification centre you can tune by category. Also: photos on "Everyone" posts are
-- visible to everyone who can see the post (not just the author's friends).

create extension if not exists pg_cron;

-- ---------- Photos on posts anyone can see ----------
create policy "Diary: photos on posts you can see" on storage.objects for select to authenticated
    using (bucket_id = 'diary-feed' and exists (
        select 1 from public.diary_shared_entries e
        where e.photos @> jsonb_build_array(jsonb_build_object('path', objects.name))));

-- ---------- Scheduled posts and drafts ----------
create table if not exists public.diary_scheduled (
    id uuid primary key default gen_random_uuid(),
    author uuid not null default auth.uid() references public.diary_profiles (id) on delete cascade,
    target text not null check (target in ('feed', 'group', 'message')),
    community_id uuid references public.diary_communities (id) on delete cascade,
    recipient uuid references public.diary_profiles (id) on delete cascade,
    title text not null default '' check (char_length(title) <= 200),
    body text not null default '' check (char_length(body) <= 20000),
    audience text not null default 'friends' check (audience in ('friends', 'public')),
    photos jsonb not null default '[]' check (jsonb_typeof(photos) = 'array' and jsonb_array_length(photos) <= 10),
    announce boolean not null default false,
    publish_at timestamptz,
    status text not null default 'scheduled' check (status in ('draft', 'scheduled', 'published', 'failed', 'cancelled')),
    published_ref text,
    error text,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    check (target <> 'group' or community_id is not null),
    check (target <> 'message' or recipient is not null),
    check (status <> 'scheduled' or publish_at is not null),
    check (btrim(body) <> '' or btrim(title) <> '' or jsonb_array_length(photos) > 0 or status = 'draft')
);
create index if not exists diary_scheduled_due on public.diary_scheduled (publish_at) where status = 'scheduled';
create index if not exists diary_scheduled_author on public.diary_scheduled (author, status);
alter table public.diary_scheduled enable row level security;
create policy "Your scheduled posts" on public.diary_scheduled for select to authenticated using (author = (select auth.uid()));
create policy "Schedule posts" on public.diary_scheduled for insert to authenticated with check (
    author = (select auth.uid()) and status in ('draft', 'scheduled')
    and (publish_at is null or publish_at < now() + interval '366 days')
    and (target <> 'group' or private.diary_is_member(community_id, (select auth.uid())))
    and (target <> 'message' or private.diary_are_friends(recipient, (select auth.uid()))));
create policy "Edit posts that haven't gone out" on public.diary_scheduled for update to authenticated
    using (author = (select auth.uid()) and status in ('draft', 'scheduled', 'failed'))
    with check (author = (select auth.uid()) and status in ('draft', 'scheduled', 'cancelled')
        and (publish_at is null or publish_at < now() + interval '366 days')
        and (target <> 'group' or private.diary_is_member(community_id, (select auth.uid())))
        and (target <> 'message' or private.diary_are_friends(recipient, (select auth.uid()))));
create policy "Delete your scheduled posts" on public.diary_scheduled for delete to authenticated using (author = (select auth.uid()));
revoke all on public.diary_scheduled from anon, authenticated;
grant select, delete on public.diary_scheduled to authenticated;
grant insert (target, community_id, recipient, title, body, audience, photos, announce, publish_at, status) on public.diary_scheduled to authenticated;
grant update (target, community_id, recipient, title, body, audience, photos, announce, publish_at, status, updated_at) on public.diary_scheduled to authenticated;

-- Editing clears an old failure
create or replace function private.diary_scheduled_touch() returns trigger language plpgsql set search_path = '' as $$
begin
    new.updated_at := now();
    if tg_op = 'UPDATE' and new.status in ('draft', 'scheduled') then
        new.error := null;
    end if;
    return new;
end;
$$;
create trigger diary_scheduled_touch before insert or update on public.diary_scheduled
    for each row execute function private.diary_scheduled_touch();

-- ---------- Notifications about them ----------
alter table public.diary_notifications drop constraint diary_notifications_type_check;
alter table public.diary_notifications add constraint diary_notifications_type_check check (type in (
    'friend_request', 'friend_accepted', 'entry_like', 'entry_comment', 'post_like', 'post_comment', 'community_post',
    'community_join', 'call_started', 'missed_call', 'entry_repost', 'reel_like', 'reel_comment', 'library_like',
    'live_started', 'new_follower', 'book_request', 'book_request_update', 'book_message', 'entry_reaction',
    'story_reaction', 'mention', 'reply', 'new_login', 'post_activity', 'scheduled_published', 'scheduled_failed'));

-- ---------- Publishing ----------
-- Publishes one scheduled item as its author. Everything the app would check is checked here again,
-- because the author may have been blocked, removed from the group or suspended since scheduling.
create or replace function private.diary_publish_one(p_id uuid)
returns text language plpgsql security definer set search_path = '' as $$
declare
    x public.diary_scheduled;
    cm public.diary_communities;
    ref text;
    what text;
begin
    select * into x from public.diary_scheduled where id = p_id and status = 'scheduled' for update skip locked;
    if not found then return null; end if;
    begin
        if private.diary_is_suspended(x.author) then
            raise exception 'Your account is suspended, so it couldn’t be posted';
        end if;
        if x.target = 'feed' then
            insert into public.diary_shared_entries (author, local_id, title, body, photos, audience, written_at, shared_at, updated_at)
            values (x.author, 'sched-' || x.id, x.title, x.body, x.photos, x.audience, now(), now(), now())
            on conflict (author, local_id) do update set title = excluded.title, body = excluded.body, photos = excluded.photos,
                audience = excluded.audience, shared_at = now(), updated_at = now()
            returning id::text into ref;
            what := 'feed';
        elsif x.target = 'group' then
            if not private.diary_is_member(x.community_id, x.author) then
                raise exception 'You’re no longer in that group';
            end if;
            select * into cm from public.diary_communities where id = x.community_id;
            insert into public.diary_community_posts (community_id, author, kind, title, body, photos, pinned_at)
            values (x.community_id, x.author, 'update', x.title, x.body, x.photos,
                case when x.announce and private.diary_is_moderator(x.community_id, x.author) then now() end)
            returning id::text into ref;
            what := 'group';
        else
            if not private.diary_are_friends(x.author, x.recipient) or private.diary_blocked(x.author, x.recipient) then
                raise exception 'You can only message friends';
            end if;
            insert into public.diary_messages (sender, recipient, body, attachments)
            values (x.author, x.recipient, x.body, '[]'::jsonb)
            returning id::text into ref;
            what := 'message';
        end if;
        update public.diary_scheduled set status = 'published', published_ref = ref, error = null, updated_at = now() where id = x.id;
        insert into public.diary_notifications (user_id, actor, type, data)
        values (x.author, x.author, 'scheduled_published', jsonb_build_object(
            'target', what, 'ref', ref, 'community_id', x.community_id, 'community_name', cm.name, 'emoji', cm.emoji,
            'recipient', x.recipient, 'snippet', private.diary_snippet(coalesce(nullif(x.title, ''), nullif(x.body, ''), '📷 Photo'))));
        return ref;
    exception when others then
        update public.diary_scheduled set status = 'failed', error = left(sqlerrm, 300), updated_at = now() where id = x.id;
        insert into public.diary_notifications (user_id, actor, type, data)
        values (x.author, x.author, 'scheduled_failed', jsonb_build_object(
            'target', x.target, 'scheduled_id', x.id, 'reason', left(sqlerrm, 200),
            'snippet', private.diary_snippet(coalesce(nullif(x.title, ''), nullif(x.body, ''), '📷 Photo'))));
        return null;
    end;
end;
$$;

create or replace function private.diary_publish_due()
returns int language plpgsql security definer set search_path = '' as $$
declare
    r record;
    n int := 0;
begin
    for r in select id from public.diary_scheduled where status = 'scheduled' and publish_at <= now() order by publish_at limit 100 loop
        perform private.diary_publish_one(r.id);
        n := n + 1;
    end loop;
    return n;
end;
$$;

-- "Post now" from the scheduled list
create or replace function public.diary_publish_now(p_id uuid)
returns text language plpgsql security definer set search_path = '' as $$
declare
    ref text;
begin
    update public.diary_scheduled set status = 'scheduled', publish_at = now()
    where id = p_id and author = auth.uid() and status in ('draft', 'scheduled', 'failed');
    if not found then raise exception 'Nothing to publish'; end if;
    ref := private.diary_publish_one(p_id);
    if ref is null then
        raise exception '%', coalesce((select error from public.diary_scheduled where id = p_id), 'Couldn’t publish that');
    end if;
    return ref;
end;
$$;
revoke all on function public.diary_publish_now(uuid) from public, anon;
grant execute on function public.diary_publish_now(uuid) to authenticated;
revoke all on function private.diary_publish_one(uuid), private.diary_publish_due() from public, anon, authenticated;

-- Every minute
select cron.unschedule(jobid) from cron.job where jobname = 'diary-publish-scheduled';
select cron.schedule('diary-publish-scheduled', '* * * * *', 'select private.diary_publish_due()');

-- ---------- Notification categories you can turn off ----------
create or replace function private.diary_notif_category(t text)
returns text language sql immutable set search_path = '' as $$
    select case
        when t in ('entry_like', 'post_like', 'reel_like', 'library_like', 'entry_reaction', 'story_reaction', 'entry_repost') then 'reactions'
        when t in ('entry_comment', 'post_comment', 'reel_comment', 'post_activity') then 'comments'
        when t in ('mention', 'reply') then 'mentions'
        when t in ('new_follower', 'friend_request', 'friend_accepted') then 'people'
        when t in ('community_post', 'community_join', 'call_started') then 'groups'
        when t in ('live_started') then 'live'
        when t in ('scheduled_published', 'scheduled_failed') then 'scheduled'
        when t in ('book_request', 'book_request_update', 'book_message') then 'market'
        when t in ('missed_call') then 'calls'
        else 'account'
    end;
$$;

create table if not exists public.diary_notification_prefs (
    user_id uuid primary key default auth.uid() references public.diary_profiles (id) on delete cascade,
    muted text[] not null default '{}',
    updated_at timestamptz not null default now()
);
alter table public.diary_notification_prefs enable row level security;
create policy "Your notification settings" on public.diary_notification_prefs for select to authenticated using (user_id = (select auth.uid()));
create policy "Add your notification settings" on public.diary_notification_prefs for insert to authenticated with check (user_id = (select auth.uid()));
create policy "Change your notification settings" on public.diary_notification_prefs for update to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
revoke all on public.diary_notification_prefs from anon, authenticated;
grant select, insert (muted, updated_at), update (muted, updated_at) on public.diary_notification_prefs to authenticated;

-- A turned-off category is never stored (so it isn't pushed either). Sign-in alerts can't be turned off.
create or replace function private.diary_notif_filter() returns trigger language plpgsql security definer set search_path = '' as $$
begin
    if private.diary_notif_category(new.type) <> 'account' and exists (
        select 1 from public.diary_notification_prefs p
        where p.user_id = new.user_id and private.diary_notif_category(new.type) = any (p.muted)) then
        return null;
    end if;
    return new;
end;
$$;
drop trigger if exists diary_notif_filter on public.diary_notifications;
create trigger diary_notif_filter before insert on public.diary_notifications
    for each row execute function private.diary_notif_filter();

-- Scheduled posts also reach your phone
create or replace function private.diary_push_notification()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
    cfg private.diary_push_config;
begin
    if new.type not in ('friend_request', 'friend_accepted', 'new_follower', 'live_started', 'mention', 'reply', 'new_login', 'call_started',
                        'scheduled_published', 'scheduled_failed', 'post_activity') then
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
