-- Chat phase 3: blocking & reporting, app moderation (admins, suspensions, audit log), call history and
-- recordings, custom status & more privacy controls, signed-in devices with new-login alerts, group bans.

-- ============================================================================
-- Blocking
-- ============================================================================
create table if not exists public.diary_blocks (
    blocker uuid not null default auth.uid() references public.diary_profiles (id) on delete cascade,
    blocked uuid not null references public.diary_profiles (id) on delete cascade,
    created_at timestamptz not null default now(),
    primary key (blocker, blocked),
    check (blocker <> blocked)
);
create index if not exists diary_blocks_blocked_idx on public.diary_blocks (blocked);
alter table public.diary_blocks enable row level security;
create policy "Your own block list" on public.diary_blocks for select to authenticated using (blocker = (select auth.uid()));
create policy "Block someone" on public.diary_blocks for insert to authenticated with check (blocker = (select auth.uid()));
create policy "Unblock someone" on public.diary_blocks for delete to authenticated using (blocker = (select auth.uid()));
revoke all on public.diary_blocks from anon, authenticated;
grant select, delete on public.diary_blocks to authenticated;
grant insert (blocked) on public.diary_blocks to authenticated;

create or replace function private.diary_blocked(a uuid, b uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
    select exists (select 1 from public.diary_blocks where (blocker = a and blocked = b) or (blocker = b and blocked = a));
$$;

-- Whether you blocked them / they blocked you (so the app can explain why you can't message)
create or replace function public.diary_block_state(other uuid)
returns table (i_blocked boolean, blocked_me boolean)
language sql
stable
security definer
set search_path = ''
as $$
    select exists (select 1 from public.diary_blocks where blocker = auth.uid() and blocked = other),
           exists (select 1 from public.diary_blocks where blocker = other and blocked = auth.uid());
$$;
revoke all on function public.diary_block_state(uuid) from public, anon;
grant execute on function public.diary_block_state(uuid) to authenticated;

-- A block stops messages both ways
create policy "No messages across a block" on public.diary_messages as restrictive
    for insert to authenticated with check (not private.diary_blocked(sender, recipient));

-- …and friend requests
create or replace function public.diary_send_friend_request(target_username text)
returns public.diary_friendships
language plpgsql
security definer
set search_path = ''
as $$
declare
    me uuid := auth.uid();
    target uuid;
    existing public.diary_friendships;
    result public.diary_friendships;
begin
    if me is null then raise exception 'Not signed in'; end if;
    select id into target from public.diary_profiles where username = lower(trim(target_username));
    if target is null then raise exception 'No one has the username "%"', target_username; end if;
    if target = me then raise exception 'You can''t add yourself'; end if;
    if private.diary_blocked(me, target) then raise exception 'You can’t add this person'; end if;
    select * into existing from public.diary_friendships
    where least(requester, addressee) = least(me, target) and greatest(requester, addressee) = greatest(me, target);
    if found then
        if existing.status = 'pending' and existing.addressee = me then
            update public.diary_friendships set status = 'accepted' where id = existing.id returning * into result;
            return result;
        end if;
        return existing;
    end if;
    insert into public.diary_friendships (requester, addressee) values (me, target) returning * into result;
    return result;
end;
$$;

-- ============================================================================
-- Custom status and more privacy settings
-- ============================================================================
alter table public.diary_presence
    add column if not exists status text check (status in ('available', 'busy', 'meeting', 'dnd', 'away')),
    add column if not exists status_text text check (char_length(status_text) <= 80),
    add column if not exists status_until timestamptz,
    add column if not exists allow_calls text not null default 'friends' check (allow_calls in ('friends', 'nobody')),
    add column if not exists photo_visibility text not null default 'everyone' check (photo_visibility in ('everyone', 'friends')),
    add column if not exists profile_visibility text not null default 'everyone' check (profile_visibility in ('everyone', 'friends'));

create or replace function public.diary_set_status(p_status text, p_text text default null, p_until timestamptz default null)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
    if p_status is not null and p_status not in ('available', 'busy', 'meeting', 'dnd', 'away') then raise exception 'Unknown status'; end if;
    insert into public.diary_presence (user_id, status, status_text, status_until)
    values (auth.uid(), p_status, nullif(btrim(left(coalesce(p_text, ''), 80)), ''), p_until)
    on conflict (user_id) do update set status = excluded.status, status_text = excluded.status_text, status_until = excluded.status_until;
end;
$$;
revoke all on function public.diary_set_status(text, text, timestamptz) from public, anon;
grant execute on function public.diary_set_status(text, text, timestamptz) to authenticated;

create or replace function public.diary_set_privacy(p_key text, p_value text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
    if p_key = 'allow_calls' and p_value in ('friends', 'nobody') then
        insert into public.diary_presence (user_id, allow_calls) values (auth.uid(), p_value) on conflict (user_id) do update set allow_calls = p_value;
    elsif p_key = 'photo_visibility' and p_value in ('everyone', 'friends') then
        insert into public.diary_presence (user_id, photo_visibility) values (auth.uid(), p_value) on conflict (user_id) do update set photo_visibility = p_value;
    elsif p_key = 'profile_visibility' and p_value in ('everyone', 'friends') then
        insert into public.diary_presence (user_id, profile_visibility) values (auth.uid(), p_value) on conflict (user_id) do update set profile_visibility = p_value;
    else
        raise exception 'Unknown setting';
    end if;
end;
$$;
revoke all on function public.diary_set_privacy(text, text) from public, anon;
grant execute on function public.diary_set_privacy(text, text) to authenticated;

drop function if exists public.diary_get_presence(uuid[]);
create or replace function public.diary_get_presence(ids uuid[])
returns table (id uuid, online boolean, last_seen timestamptz, receipts boolean, status text, status_text text, allow_calls text)
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
        p.read_receipts and (select my_receipts from me),
        case when p.status_until is null or p.status_until > now() then p.status end,
        case when p.status_until is null or p.status_until > now() then p.status_text end,
        p.allow_calls
    from public.diary_presence p
    where (select uid from me) is not null
      and p.user_id = any (ids[1:200])
      and p.user_id <> (select uid from me)
      and not private.diary_blocked(p.user_id, (select uid from me));
$$;
revoke all on function public.diary_get_presence(uuid[]) from public, anon;
grant execute on function public.diary_get_presence(uuid[]) to authenticated;

-- A profile as the viewer may see it: photo and details follow the person's privacy settings
create or replace function public.diary_profile_card(p_id uuid)
returns table (id uuid, username text, display_name text, avatar_path text, created_at timestamptz, limited boolean, blocked boolean)
language sql
stable
security definer
set search_path = ''
as $$
    with t as (select coalesce(pr.photo_visibility, 'everyone') as photo, coalesce(pr.profile_visibility, 'everyone') as prof
               from public.diary_profiles p left join public.diary_presence pr on pr.user_id = p.id where p.id = p_id),
         f as (select private.diary_are_friends(p_id, auth.uid()) or p_id = auth.uid() as friends)
    select p.id, p.username, p.display_name,
        case when (select photo from t) = 'everyone' or (select friends from f) then p.avatar_path end,
        case when (select prof from t) = 'everyone' or (select friends from f) then p.created_at end,
        (select prof from t) = 'friends' and not (select friends from f),
        private.diary_blocked(p.id, auth.uid())
    from public.diary_profiles p
    where p.id = p_id and auth.uid() is not null;
$$;
revoke all on function public.diary_profile_card(uuid) from public, anon;
grant execute on function public.diary_profile_card(uuid) to authenticated;

-- People search respects blocks (people who blocked you don't appear) and photo privacy
drop function if exists public.diary_search_people(text);
create or replace function public.diary_search_people(q text)
returns table (id uuid, username text, display_name text, avatar_path text, relation text, following boolean, follows_you boolean)
language sql
stable
security definer
set search_path = ''
as $$
    with me as (select auth.uid() as uid),
    term as (select lower(btrim(regexp_replace(coalesce(q, ''), '^@', ''))) as t)
    select p.id, p.username, p.display_name,
        case when coalesce(pr.photo_visibility, 'everyone') = 'everyone' or private.diary_are_friends(p.id, (select uid from me)) then p.avatar_path end,
        case
            when exists (select 1 from public.diary_blocks b where b.blocker = (select uid from me) and b.blocked = p.id) then 'blocked'
            else coalesce((
                select case when f.status = 'accepted' then 'friend' when f.requester = (select uid from me) then 'requested' else 'incoming' end
                from public.diary_friendships f
                where (f.requester = p.id and f.addressee = (select uid from me)) or (f.addressee = p.id and f.requester = (select uid from me))
                limit 1), 'none')
        end,
        exists (select 1 from public.diary_follows fo where fo.follower = (select uid from me) and fo.followee = p.id),
        exists (select 1 from public.diary_follows fo where fo.followee = (select uid from me) and fo.follower = p.id)
    from public.diary_profiles p
    left join public.diary_presence pr on pr.user_id = p.id, term
    where (select uid from me) is not null
      and char_length(replace(term.t, '%', '')) >= 2
      and p.id <> (select uid from me)
      and not exists (select 1 from public.diary_blocks b where b.blocker = p.id and b.blocked = (select uid from me))
      and (lower(p.username) like '%' || replace(replace(term.t, '%', ''), '_', '\_') || '%'
           or lower(p.display_name) like '%' || replace(term.t, '%', '') || '%')
    order by
        (lower(p.username) = term.t or lower(p.display_name) = term.t) desc,
        (lower(p.username) like term.t || '%' or lower(p.display_name) like term.t || '%') desc,
        p.display_name
    limit 25;
$$;
revoke all on function public.diary_search_people(text) from public, anon;
grant execute on function public.diary_search_people(text) to authenticated;

-- Calls: a block, or "no one can call me", stops rings and one-to-one call rooms
create or replace function private.diary_topic_allowed(topic text, sending boolean)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
    parts text[] := string_to_array(topic, ':');
    me uuid := auth.uid();
begin
    if me is null or parts is null then
        return false;
    end if;
    if parts[1] = 'diary_call' and parts[2] = 'c' and array_length(parts, 1) = 3 then
        return private.diary_is_member(parts[3]::uuid, me);
    end if;
    if parts[1] = 'diary_call' and parts[2] = 'd' and array_length(parts, 1) = 4 then
        return me::text in (parts[3], parts[4]) and not private.diary_blocked(parts[3]::uuid, parts[4]::uuid);
    end if;
    if parts[1] = 'diary_ring' and array_length(parts, 1) = 2 then
        if sending then
            return private.diary_can_reach(parts[2]::uuid, me)
                and not private.diary_blocked(parts[2]::uuid, me)
                and coalesce((select allow_calls from public.diary_presence where user_id = parts[2]::uuid), 'friends') <> 'nobody';
        end if;
        return parts[2] = me::text;
    end if;
    if parts[1] = 'diary_dm' and array_length(parts, 1) = 3 then
        return me::text in (parts[2], parts[3])
            and private.diary_are_friends(parts[2]::uuid, parts[3]::uuid);
    end if;
    if parts[1] = 'diary_comm' and array_length(parts, 1) = 2 then
        return private.diary_is_member(parts[2]::uuid, me);
    end if;
    if parts[1] = 'diary_live' and array_length(parts, 1) = 2 then
        return exists (
            select 1 from public.diary_live_streams s
            where s.id = parts[2]::uuid and s.ended_at is null
              and (s.host = me or private.diary_are_friends(s.host, me) or private.diary_is_follower(me, s.host))
        );
    end if;
    return false;
exception when others then
    return false;
end;
$$;

-- ============================================================================
-- App moderation: admins, reports, suspensions, audit log
-- ============================================================================
create table if not exists public.diary_app_admins (
    user_id uuid primary key references public.diary_profiles (id) on delete cascade,
    added_at timestamptz not null default now()
);
alter table public.diary_app_admins enable row level security;
revoke all on public.diary_app_admins from anon, authenticated;

create or replace function private.diary_is_app_admin(uid uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
    select exists (select 1 from public.diary_app_admins where user_id = uid);
$$;

-- (checked through the function, so the policy never reads its own table)
create policy "Admins see the admin list" on public.diary_app_admins for select to authenticated
    using (private.diary_is_app_admin((select auth.uid())));
grant select on public.diary_app_admins to authenticated;

create or replace function public.diary_am_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
    select private.diary_is_app_admin(auth.uid());
$$;
revoke all on function public.diary_am_admin() from public, anon;
grant execute on function public.diary_am_admin() to authenticated;

create table if not exists public.diary_suspensions (
    user_id uuid primary key references public.diary_profiles (id) on delete cascade,
    until timestamptz,                  -- null = until lifted
    reason text check (char_length(reason) <= 300),
    by_admin uuid references public.diary_profiles (id) on delete set null,
    created_at timestamptz not null default now()
);
alter table public.diary_suspensions enable row level security;
create policy "Admins, and the person suspended, see it" on public.diary_suspensions for select to authenticated
    using (user_id = (select auth.uid()) or private.diary_is_app_admin((select auth.uid())));
revoke all on public.diary_suspensions from anon, authenticated;
grant select on public.diary_suspensions to authenticated;

create or replace function private.diary_is_suspended(uid uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
    select exists (select 1 from public.diary_suspensions where user_id = uid and (until is null or until > now()));
$$;

-- Suspended accounts can read but not post anywhere
create policy "Suspended accounts can't send messages" on public.diary_messages as restrictive for insert to authenticated with check (not private.diary_is_suspended((select auth.uid())));
create policy "Suspended accounts can't post in groups" on public.diary_community_messages as restrictive for insert to authenticated with check (not private.diary_is_suspended((select auth.uid())));
create policy "Suspended accounts can't comment" on public.diary_comments as restrictive for insert to authenticated with check (not private.diary_is_suspended((select auth.uid())));
create policy "Suspended accounts can't post" on public.diary_community_posts as restrictive for insert to authenticated with check (not private.diary_is_suspended((select auth.uid())));
create policy "Suspended accounts can't share" on public.diary_shared_entries as restrictive for insert to authenticated with check (not private.diary_is_suspended((select auth.uid())));
create policy "Suspended accounts can't post stories" on public.diary_stories as restrictive for insert to authenticated with check (not private.diary_is_suspended((select auth.uid())));
create policy "Suspended accounts can't post reels" on public.diary_reels as restrictive for insert to authenticated with check (not private.diary_is_suspended((select auth.uid())));

create table if not exists public.diary_audit_log (
    id bigint generated always as identity primary key,
    actor uuid references public.diary_profiles (id) on delete set null,
    action text not null,
    target_user uuid references public.diary_profiles (id) on delete set null,
    details jsonb not null default '{}'::jsonb,
    created_at timestamptz not null default now()
);
create index if not exists diary_audit_log_time_idx on public.diary_audit_log (created_at desc);
alter table public.diary_audit_log enable row level security;
create policy "Admins read the audit log" on public.diary_audit_log for select to authenticated using (private.diary_is_app_admin((select auth.uid())));
revoke all on public.diary_audit_log from anon, authenticated;
grant select on public.diary_audit_log to authenticated;

create table if not exists public.diary_reports (
    id uuid primary key default gen_random_uuid(),
    reporter uuid not null default auth.uid() references public.diary_profiles (id) on delete cascade,
    kind text not null check (kind in ('user', 'dm', 'gc', 'post', 'entry', 'comment', 'listing')),
    target_id text check (char_length(target_id) <= 64),
    target_user uuid references public.diary_profiles (id) on delete set null,
    community_id uuid references public.diary_communities (id) on delete set null,
    reason text not null check (reason in ('spam', 'harassment', 'hate', 'violence', 'sexual', 'self_harm', 'scam', 'impersonation', 'other')),
    details text check (char_length(details) <= 1000),
    snapshot text check (char_length(snapshot) <= 4000),   -- what the reported content said at the time
    status text not null default 'open' check (status in ('open', 'actioned', 'dismissed')),
    resolution text check (char_length(resolution) <= 300),
    handled_by uuid references public.diary_profiles (id) on delete set null,
    handled_at timestamptz,
    created_at timestamptz not null default now()
);
create index if not exists diary_reports_status_idx on public.diary_reports (status, created_at desc);
alter table public.diary_reports enable row level security;
create policy "Reporters, admins and group staff see reports" on public.diary_reports for select to authenticated
    using (reporter = (select auth.uid())
        or private.diary_is_app_admin((select auth.uid()))
        or (community_id is not null and private.diary_is_moderator(community_id, (select auth.uid()))));
revoke all on public.diary_reports from anon, authenticated;
grant select on public.diary_reports to authenticated;

-- File a report. The reported content is copied into the report (as the reporter can see it), so
-- moderators can judge it without reading anyone's private messages.
create or replace function public.diary_report(p_kind text, p_target text, p_reason text, p_details text default null)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
    me uuid := auth.uid();
    tuser uuid;
    cid uuid;
    snap text;
    rid uuid;
begin
    if me is null then raise exception 'Sign in first'; end if;
    if (select count(*) from public.diary_reports where reporter = me and created_at > now() - interval '1 hour') >= 20 then
        raise exception 'Too many reports — try again later';
    end if;
    if p_kind = 'user' then
        tuser := p_target::uuid;
    elsif p_kind = 'dm' then
        select sender, left(body, 4000) into tuser, snap from public.diary_messages
        where id = p_target::bigint and me in (sender, recipient);
        if not found then raise exception 'Message not found'; end if;
    elsif p_kind = 'gc' then
        select author, community_id, left(body, 4000) into tuser, cid, snap from public.diary_community_messages
        where id = p_target::bigint and private.diary_is_member(community_id, me);
        if not found then raise exception 'Message not found'; end if;
    elsif p_kind = 'post' then
        select author, community_id, left(coalesce(body, ''), 4000) into tuser, cid, snap from public.diary_community_posts where id = p_target::uuid;
    elsif p_kind = 'entry' then
        select author, left(coalesce(title, '') || E'\n' || coalesce(body, ''), 4000) into tuser, snap from public.diary_shared_entries where id = p_target::uuid;
    elsif p_kind = 'comment' then
        select author, left(coalesce(body, ''), 4000) into tuser, snap from public.diary_comments where id = p_target::uuid;
    elsif p_kind = 'listing' then
        select seller, left(title || E'\n' || coalesce(description, ''), 4000) into tuser, snap from public.diary_book_listings where id = p_target::uuid;
    else
        raise exception 'Unknown report';
    end if;
    if tuser = me then raise exception 'You can’t report yourself'; end if;
    insert into public.diary_reports (reporter, kind, target_id, target_user, community_id, reason, details, snapshot)
    values (me, p_kind, p_target, tuser, cid, p_reason, nullif(btrim(left(coalesce(p_details, ''), 1000)), ''), snap)
    returning id into rid;
    return rid;
end;
$$;
revoke all on function public.diary_report(text, text, text, text) from public, anon;
grant execute on function public.diary_report(text, text, text, text) to authenticated;

-- Act on a report (app admins; group staff for reports from their group)
create or replace function public.diary_resolve_report(p_id uuid, p_action text, p_note text default null)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
    me uuid := auth.uid();
    r public.diary_reports;
    admin boolean := private.diary_is_app_admin(auth.uid());
begin
    select * into r from public.diary_reports where id = p_id for update;
    if not found then raise exception 'Report not found'; end if;
    if not admin and not (r.community_id is not null and private.diary_is_moderator(r.community_id, me)) then
        raise exception 'Not allowed';
    end if;
    if p_action in ('suspend_7d', 'suspend_30d', 'suspend') and not admin then raise exception 'Only app admins can suspend accounts'; end if;

    if p_action = 'remove' then
        if r.kind = 'gc' then
            update public.diary_community_messages set deleted_at = now(), deleted_by = me, body = '', attachments = '[]'::jsonb where id = r.target_id::bigint;
        elsif r.kind = 'dm' and admin then
            update public.diary_messages set deleted_at = now(), body = '', attachments = '[]'::jsonb where id = r.target_id::bigint;
        elsif r.kind = 'post' then
            delete from public.diary_community_posts where id = r.target_id::uuid;
        elsif r.kind = 'entry' and admin then
            delete from public.diary_shared_entries where id = r.target_id::uuid;
        elsif r.kind = 'comment' and admin then
            delete from public.diary_comments where id = r.target_id::uuid;
        elsif r.kind = 'listing' and admin then
            delete from public.diary_book_listings where id = r.target_id::uuid;
        end if;
    elsif p_action in ('suspend_7d', 'suspend_30d', 'suspend') and r.target_user is not null then
        insert into public.diary_suspensions (user_id, until, reason, by_admin)
        values (r.target_user, case p_action when 'suspend_7d' then now() + interval '7 days' when 'suspend_30d' then now() + interval '30 days' end, left(coalesce(p_note, r.reason), 300), me)
        on conflict (user_id) do update set until = excluded.until, reason = excluded.reason, by_admin = excluded.by_admin, created_at = now();
    elsif p_action not in ('dismiss', 'warn') then
        raise exception 'Unknown action';
    end if;

    update public.diary_reports
    set status = case when p_action = 'dismiss' then 'dismissed' else 'actioned' end,
        resolution = left(coalesce(p_note, p_action), 300), handled_by = me, handled_at = now()
    where id = p_id;
    insert into public.diary_audit_log (actor, action, target_user, details)
    values (me, 'report_' || p_action, r.target_user, jsonb_build_object('report', r.id, 'kind', r.kind, 'target', r.target_id, 'note', p_note));
end;
$$;
revoke all on function public.diary_resolve_report(uuid, text, text) from public, anon;
grant execute on function public.diary_resolve_report(uuid, text, text) to authenticated;

create or replace function public.diary_lift_suspension(p_user uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
    if not private.diary_is_app_admin(auth.uid()) then raise exception 'Not allowed'; end if;
    delete from public.diary_suspensions where user_id = p_user;
    insert into public.diary_audit_log (actor, action, target_user) values (auth.uid(), 'suspension_lifted', p_user);
end;
$$;
revoke all on function public.diary_lift_suspension(uuid) from public, anon;
grant execute on function public.diary_lift_suspension(uuid) to authenticated;

-- Numbers for the dashboard
create or replace function public.diary_admin_stats()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
    if not private.diary_is_app_admin(auth.uid()) then raise exception 'Not allowed'; end if;
    return jsonb_build_object(
        'users', (select count(*) from public.diary_profiles),
        'active_today', (select count(*) from public.diary_presence where last_seen_at > now() - interval '24 hours'),
        'messages_today', (select count(*) from public.diary_messages where created_at > now() - interval '24 hours')
                        + (select count(*) from public.diary_community_messages where created_at > now() - interval '24 hours'),
        'open_reports', (select count(*) from public.diary_reports where status = 'open'),
        'suspended', (select count(*) from public.diary_suspensions where until is null or until > now()),
        'blocks', (select count(*) from public.diary_blocks),
        'communities', (select count(*) from public.diary_communities)
    );
end;
$$;
revoke all on function public.diary_admin_stats() from public, anon;
grant execute on function public.diary_admin_stats() to authenticated;

-- ============================================================================
-- Group bans (remove and stop them rejoining)
-- ============================================================================
create table if not exists public.diary_community_bans (
    community_id uuid not null references public.diary_communities (id) on delete cascade,
    user_id uuid not null references public.diary_profiles (id) on delete cascade,
    by_user uuid references public.diary_profiles (id) on delete set null,
    reason text check (char_length(reason) <= 300),
    created_at timestamptz not null default now(),
    primary key (community_id, user_id)
);
alter table public.diary_community_bans enable row level security;
create policy "Group staff see bans" on public.diary_community_bans for select to authenticated
    using (private.diary_is_moderator(community_id, (select auth.uid())) or user_id = (select auth.uid()));
revoke all on public.diary_community_bans from anon, authenticated;
grant select on public.diary_community_bans to authenticated;

create or replace function public.diary_ban_member(p_cid uuid, p_user uuid, p_reason text default null)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
    rank_me int;
    rank_them int;
begin
    select case role when 'owner' then 3 when 'admin' then 2 when 'moderator' then 1 else 0 end into rank_me
    from public.diary_community_members where community_id = p_cid and user_id = auth.uid();
    select case role when 'owner' then 3 when 'admin' then 2 when 'moderator' then 1 else 0 end into rank_them
    from public.diary_community_members where community_id = p_cid and user_id = p_user;
    if coalesce(rank_me, 0) < 1 or coalesce(rank_them, 0) >= rank_me then raise exception 'Not allowed'; end if;
    delete from public.diary_community_members where community_id = p_cid and user_id = p_user;
    insert into public.diary_community_bans (community_id, user_id, by_user, reason) values (p_cid, p_user, auth.uid(), left(p_reason, 300))
    on conflict (community_id, user_id) do update set by_user = excluded.by_user, reason = excluded.reason, created_at = now();
    insert into public.diary_audit_log (actor, action, target_user, details) values (auth.uid(), 'group_ban', p_user, jsonb_build_object('community', p_cid, 'reason', p_reason));
end;
$$;
revoke all on function public.diary_ban_member(uuid, uuid, text) from public, anon;
grant execute on function public.diary_ban_member(uuid, uuid, text) to authenticated;

create or replace function public.diary_unban_member(p_cid uuid, p_user uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
    if not private.diary_is_moderator(p_cid, auth.uid()) then raise exception 'Not allowed'; end if;
    delete from public.diary_community_bans where community_id = p_cid and user_id = p_user;
end;
$$;
revoke all on function public.diary_unban_member(uuid, uuid) from public, anon;
grant execute on function public.diary_unban_member(uuid, uuid) to authenticated;

create or replace function public.diary_join_community(p_id uuid default null, p_code text default null)
returns public.diary_communities
language plpgsql
security definer
set search_path = ''
as $$
declare
    target public.diary_communities;
begin
    if auth.uid() is null then raise exception 'Not signed in'; end if;
    if p_code is not null and trim(p_code) <> '' then
        select * into target from public.diary_communities where invite_code = lower(trim(p_code));
        if target.id is null then raise exception 'That invite code doesn''t match any community'; end if;
    else
        select * into target from public.diary_communities where id = p_id;
        if target.id is null then raise exception 'Community not found'; end if;
        if target.visibility <> 'public' then raise exception 'This community is invite-only — ask a member for the code'; end if;
    end if;
    if exists (select 1 from public.diary_community_bans where community_id = target.id and user_id = auth.uid()) then
        raise exception 'You can’t join this community';
    end if;
    insert into public.diary_community_members (community_id, user_id) values (target.id, auth.uid())
    on conflict do nothing;
    return target;
end;
$$;

-- ============================================================================
-- Call history (each person keeps their own) and call recordings
-- ============================================================================
create table if not exists public.diary_call_log (
    id uuid primary key default gen_random_uuid(),
    owner uuid not null default auth.uid() references public.diary_profiles (id) on delete cascade,
    direction text not null check (direction in ('in', 'out')),
    status text not null check (status in ('answered', 'missed', 'declined', 'cancelled', 'no_answer', 'busy')),
    video boolean not null default false,
    peer uuid references public.diary_profiles (id) on delete set null,       -- one-to-one calls
    community_id uuid references public.diary_communities (id) on delete set null, -- group calls
    title text check (char_length(title) <= 120),
    participants int not null default 2,
    started_at timestamptz not null default now(),
    duration int not null default 0 check (duration >= 0)
);
create index if not exists diary_call_log_owner_idx on public.diary_call_log (owner, started_at desc);
alter table public.diary_call_log enable row level security;
create policy "Your own call history" on public.diary_call_log for all to authenticated
    using (owner = (select auth.uid())) with check (owner = (select auth.uid()));
revoke all on public.diary_call_log from anon, authenticated;
grant select, delete on public.diary_call_log to authenticated;
grant insert (direction, status, video, peer, community_id, title, participants, started_at, duration) on public.diary_call_log to authenticated;
grant update (status, duration, participants) on public.diary_call_log to authenticated;

create table if not exists public.diary_call_recordings (
    id uuid primary key default gen_random_uuid(),
    owner uuid not null default auth.uid() references public.diary_profiles (id) on delete cascade,
    title text check (char_length(title) <= 120),
    path text not null,
    mime text,
    duration int not null default 0,
    size bigint not null default 0,
    created_at timestamptz not null default now()
);
alter table public.diary_call_recordings enable row level security;
create policy "Your own recordings" on public.diary_call_recordings for all to authenticated
    using (owner = (select auth.uid())) with check (owner = (select auth.uid()) and split_part(path, '/', 1) = (select auth.uid())::text);
revoke all on public.diary_call_recordings from anon, authenticated;
grant select, delete on public.diary_call_recordings to authenticated;
grant insert (title, path, mime, duration, size) on public.diary_call_recordings to authenticated;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('diary-recordings', 'diary-recordings', false, 209715200, array['audio/webm', 'audio/ogg', 'audio/mp4', 'video/webm', 'video/mp4'])
on conflict (id) do nothing;
create policy "Diary: your own call recordings (read)" on storage.objects for select to authenticated
    using (bucket_id = 'diary-recordings' and private.diary_chat_path_part(name, 1) = (select auth.uid()));
create policy "Diary: your own call recordings (upload)" on storage.objects for insert to authenticated
    with check (bucket_id = 'diary-recordings' and private.diary_chat_path_part(name, 1) = (select auth.uid()));
create policy "Diary: your own call recordings (delete)" on storage.objects for delete to authenticated
    using (bucket_id = 'diary-recordings' and private.diary_chat_path_part(name, 1) = (select auth.uid()));

-- ============================================================================
-- Signed-in devices, with an alert when a new one signs in
-- ============================================================================
create table if not exists public.diary_devices (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null references public.diary_profiles (id) on delete cascade,
    device_id text not null check (char_length(device_id) between 8 and 64),
    label text check (char_length(label) <= 120),
    first_seen timestamptz not null default now(),
    last_seen timestamptz not null default now(),
    unique (user_id, device_id)
);
alter table public.diary_devices enable row level security;
create policy "Your own devices" on public.diary_devices for select to authenticated using (user_id = (select auth.uid()));
create policy "Forget one of your devices" on public.diary_devices for delete to authenticated using (user_id = (select auth.uid()));
revoke all on public.diary_devices from anon, authenticated;
grant select, delete on public.diary_devices to authenticated;

alter table public.diary_notifications drop constraint diary_notifications_type_check;
alter table public.diary_notifications add constraint diary_notifications_type_check check (type = any (array[
  'friend_request','friend_accepted','entry_like','entry_comment','post_like','post_comment','community_post','community_join',
  'call_started','missed_call','entry_repost','reel_like','reel_comment','library_like','live_started','new_follower',
  'book_request','book_request_update','book_message','entry_reaction','story_reaction','mention','reply','new_login']));

create or replace function public.diary_register_device(p_device text, p_label text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
    me uuid := auth.uid();
    fresh boolean;
begin
    if me is null then return false; end if;
    fresh := not exists (select 1 from public.diary_devices where user_id = me and device_id = p_device);
    insert into public.diary_devices (user_id, device_id, label) values (me, p_device, left(p_label, 120))
    on conflict (user_id, device_id) do update set last_seen = now(), label = excluded.label;
    -- A new device while others exist: tell the person (it shows on all their devices)
    if fresh and exists (select 1 from public.diary_devices where user_id = me and device_id <> p_device) then
        insert into public.diary_notifications (user_id, actor, type, data)
        values (me, me, 'new_login', jsonb_build_object('label', left(p_label, 120)));
    end if;
    return fresh;
end;
$$;
revoke all on function public.diary_register_device(text, text) from public, anon;
grant execute on function public.diary_register_device(text, text) to authenticated;

-- New-login alerts also reach phones
create or replace function private.diary_push_notification()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
    cfg private.diary_push_config;
begin
    if new.type not in ('friend_request', 'friend_accepted', 'new_follower', 'live_started', 'mention', 'reply', 'new_login') then
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

-- The first app admin (chosen by the owner of the app)
insert into public.diary_app_admins (user_id) select id from public.diary_profiles where username = 'noahodus' on conflict do nothing;
