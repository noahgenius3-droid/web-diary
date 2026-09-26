-- Notifications: rows are created by triggers (and two RPCs) so nobody can forge them for someone else.

create table public.diary_notifications (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null default auth.uid() references public.diary_profiles (id) on delete cascade,
    actor uuid references public.diary_profiles (id) on delete cascade,
    type text not null check (type in (
        'friend_request', 'friend_accepted', 'entry_like', 'entry_comment',
        'post_like', 'post_comment', 'community_post', 'community_join', 'call_started', 'missed_call')),
    data jsonb not null default '{}'::jsonb check (jsonb_typeof(data) = 'object' and length(data::text) <= 2000),
    read_at timestamptz,
    created_at timestamptz not null default now()
);

create index diary_notifications_inbox on public.diary_notifications (user_id, created_at desc);

alter table public.diary_notifications enable row level security;

create policy "Read your own notifications" on public.diary_notifications
    for select to authenticated using (user_id = (select auth.uid()));
create policy "Mark your own notifications read" on public.diary_notifications
    for update to authenticated
    using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy "Clear your own notifications" on public.diary_notifications
    for delete to authenticated using (user_id = (select auth.uid()));
-- The only kind you write yourself: a missed call logged by your own device
create policy "Log your own missed calls" on public.diary_notifications
    for insert to authenticated
    with check (user_id = (select auth.uid()) and type = 'missed_call');

grant select, delete on public.diary_notifications to authenticated;
grant update (read_at) on public.diary_notifications to authenticated;
grant insert (actor, type, data) on public.diary_notifications to authenticated;

-- ---------- Helpers ----------
create function private.diary_snippet(t text, n int default 70)
returns text
language sql immutable
set search_path = ''
as $$
    select case when char_length(coalesce(t, '')) > n then left(t, n - 1) || '…' else coalesce(t, '') end;
$$;

create function private.diary_notify(p_user uuid, p_actor uuid, p_type text, p_data jsonb)
returns void
language plpgsql security definer
set search_path = ''
as $$
begin
    if p_user is null or p_user = p_actor then
        return;
    end if;
    insert into public.diary_notifications (user_id, actor, type, data) values (p_user, p_actor, p_type, coalesce(p_data, '{}'::jsonb));
end;
$$;

revoke execute on function private.diary_notify(uuid, uuid, text, jsonb) from public, anon, authenticated;

-- ---------- Triggers ----------
create function private.diary_on_friendship()
returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
    if tg_op = 'INSERT' and new.status = 'pending' then
        perform private.diary_notify(new.addressee, new.requester, 'friend_request', jsonb_build_object('friendship_id', new.id));
    elsif tg_op = 'UPDATE' and old.status = 'pending' and new.status = 'accepted' then
        perform private.diary_notify(new.requester, new.addressee, 'friend_accepted', '{}'::jsonb);
        -- the request itself has been dealt with
        delete from public.diary_notifications
        where user_id = new.addressee and type = 'friend_request' and data->>'friendship_id' = new.id::text;
    end if;
    return new;
end;
$$;

create trigger diary_notify_friendship
    after insert or update on public.diary_friendships
    for each row execute function private.diary_on_friendship();

create function private.diary_on_entry_like()
returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
    e public.diary_shared_entries;
begin
    select * into e from public.diary_shared_entries where id = new.entry_id;
    perform private.diary_notify(e.author, new.user_id, 'entry_like',
        jsonb_build_object('entry_id', e.id, 'snippet', private.diary_snippet(coalesce(nullif(e.title, ''), e.body), 60)));
    return new;
end;
$$;

create trigger diary_notify_entry_like
    after insert on public.diary_entry_likes
    for each row execute function private.diary_on_entry_like();

create function private.diary_on_comment()
returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
    e public.diary_shared_entries;
    p public.diary_community_posts;
    cm public.diary_communities;
begin
    if new.entry_id is not null then
        select * into e from public.diary_shared_entries where id = new.entry_id;
        perform private.diary_notify(e.author, new.author, 'entry_comment',
            jsonb_build_object('entry_id', e.id, 'snippet', private.diary_snippet(new.body)));
    else
        select * into p from public.diary_community_posts where id = new.post_id;
        select * into cm from public.diary_communities where id = p.community_id;
        perform private.diary_notify(p.author, new.author, 'post_comment',
            jsonb_build_object('post_id', p.id, 'community_id', cm.id, 'community_name', cm.name, 'emoji', cm.emoji,
                'snippet', private.diary_snippet(new.body)));
    end if;
    return new;
end;
$$;

create trigger diary_notify_comment
    after insert on public.diary_comments
    for each row execute function private.diary_on_comment();

create function private.diary_on_post_like()
returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
    p public.diary_community_posts;
    cm public.diary_communities;
begin
    select * into p from public.diary_community_posts where id = new.post_id;
    select * into cm from public.diary_communities where id = p.community_id;
    perform private.diary_notify(p.author, new.user_id, 'post_like',
        jsonb_build_object('post_id', p.id, 'community_id', cm.id, 'community_name', cm.name, 'emoji', cm.emoji));
    return new;
end;
$$;

create trigger diary_notify_post_like
    after insert on public.diary_community_likes
    for each row execute function private.diary_on_post_like();

create function private.diary_on_community_post()
returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
    cm public.diary_communities;
begin
    select * into cm from public.diary_communities where id = new.community_id;
    insert into public.diary_notifications (user_id, actor, type, data)
    select m.user_id, new.author, 'community_post',
        jsonb_build_object('post_id', new.id, 'community_id', cm.id, 'community_name', cm.name, 'emoji', cm.emoji,
            'snippet', private.diary_snippet(coalesce(nullif(new.title, ''), nullif(new.body, ''), '📷 Photo')))
    from public.diary_community_members m
    where m.community_id = new.community_id and m.user_id <> new.author;
    return new;
end;
$$;

create trigger diary_notify_community_post
    after insert on public.diary_community_posts
    for each row execute function private.diary_on_community_post();

create function private.diary_on_community_join()
returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
    cm public.diary_communities;
begin
    if new.role = 'owner' then
        return new;
    end if;
    select * into cm from public.diary_communities where id = new.community_id;
    perform private.diary_notify(cm.owner, new.user_id, 'community_join',
        jsonb_build_object('community_id', cm.id, 'community_name', cm.name, 'emoji', cm.emoji));
    return new;
end;
$$;

create trigger diary_notify_community_join
    after insert on public.diary_community_members
    for each row execute function private.diary_on_community_join();

-- ---------- Calls ----------
-- Called by the first person into a community call; at most one alert per community every 10 minutes
create function public.diary_notify_call(p_community uuid)
returns boolean
language plpgsql security definer
set search_path = ''
as $$
declare
    cm public.diary_communities;
begin
    if not private.diary_is_member(p_community, auth.uid()) then
        return false;
    end if;
    if exists (
        select 1 from public.diary_notifications
        where type = 'call_started' and data->>'community_id' = p_community::text
          and created_at > now() - interval '10 minutes'
    ) then
        return false;
    end if;
    select * into cm from public.diary_communities where id = p_community;
    insert into public.diary_notifications (user_id, actor, type, data)
    select m.user_id, auth.uid(), 'call_started',
        jsonb_build_object('community_id', cm.id, 'community_name', cm.name, 'emoji', cm.emoji)
    from public.diary_community_members m
    where m.community_id = p_community and m.user_id <> auth.uid();
    return true;
end;
$$;

revoke execute on function public.diary_notify_call(uuid) from public, anon;
grant execute on function public.diary_notify_call(uuid) to authenticated;

alter publication supabase_realtime add table public.diary_notifications;
