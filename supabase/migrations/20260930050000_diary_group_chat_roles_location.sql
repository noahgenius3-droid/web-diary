-- Community group chat, moderator role + moderation tools, and live location sharing (DMs and group chats).

-- ---------- Roles: owner > admin > moderator > member ----------
alter table public.diary_community_members drop constraint diary_community_members_role_check;
alter table public.diary_community_members add constraint diary_community_members_role_check
    check (role = any (array['owner', 'admin', 'moderator', 'member']));

-- Moderators can moderate (delete posts, comments and chat messages, pin, mute); editing the community stays with admins
create or replace function private.diary_is_moderator(cid uuid, uid uuid)
returns boolean language sql stable security definer set search_path = '' as $$
    select exists (
        select 1 from public.diary_community_members m
        where m.community_id = cid and m.user_id = uid and m.role in ('owner', 'admin', 'moderator')
    );
$$;

create or replace function private.diary_is_admin(cid uuid, uid uuid)
returns boolean language sql stable security definer set search_path = '' as $$
    select exists (
        select 1 from public.diary_community_members m
        where m.community_id = cid and m.user_id = uid and m.role in ('owner', 'admin')
    );
$$;

create or replace function private.diary_role(cid uuid, uid uuid)
returns text language sql stable security definer set search_path = '' as $$
    select m.role from public.diary_community_members m where m.community_id = cid and m.user_id = uid;
$$;

-- Editing name/description/visibility/chat settings: admins and the owner only
drop policy "Moderators edit their community" on public.diary_communities;
create policy "Admins edit their community" on public.diary_communities
    for update to authenticated
    using (private.diary_is_admin(id, (select auth.uid())))
    with check (private.diary_is_admin(id, (select auth.uid())));

-- Removing members: moderators may remove plain members; admins may also remove moderators; nobody removes the owner
drop policy "Leave, or moderators remove members" on public.diary_community_members;
create policy "Leave, or staff remove members below them" on public.diary_community_members
    for delete to authenticated
    using (
        (user_id = (select auth.uid()) and role <> 'owner')
        or (role = 'member' and private.diary_is_moderator(community_id, (select auth.uid())))
        or (role = 'moderator' and private.diary_is_admin(community_id, (select auth.uid())))
    );

-- Promote / demote. Owner: admin, moderator, member. Admin: moderator, member (for members and moderators only).
create function public.diary_set_member_role(cid uuid, target uuid, new_role text)
returns void language plpgsql security definer set search_path = '' as $$
declare
    me uuid := auth.uid();
    my_role text := private.diary_role(cid, me);
    their_role text := private.diary_role(cid, target);
begin
    if me is null or my_role is null then raise exception 'Not a member'; end if;
    if their_role is null then raise exception 'They are not a member'; end if;
    if target = me then raise exception 'You can''t change your own role'; end if;
    if new_role not in ('admin', 'moderator', 'member') then raise exception 'Unknown role'; end if;
    if their_role = 'owner' then raise exception 'The owner''s role can''t be changed'; end if;
    if my_role = 'owner' then
        null;
    elsif my_role = 'admin' then
        if their_role = 'admin' or new_role = 'admin' then raise exception 'Only the owner can manage admins'; end if;
    else
        raise exception 'Only admins can change roles';
    end if;
    update public.diary_community_members set role = new_role where community_id = cid and user_id = target;
end;
$$;
revoke execute on function public.diary_set_member_role(uuid, uuid, text) from public, anon;
grant execute on function public.diary_set_member_role(uuid, uuid, text) to authenticated;

-- Hand the community to another member (the old owner becomes an admin)
create function public.diary_transfer_community(cid uuid, target uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare me uuid := auth.uid();
begin
    if private.diary_role(cid, me) is distinct from 'owner' then raise exception 'Only the owner can do that'; end if;
    if private.diary_role(cid, target) is null or target = me then raise exception 'Pick another member'; end if;
    update public.diary_community_members set role = 'admin' where community_id = cid and user_id = me;
    update public.diary_community_members set role = 'owner' where community_id = cid and user_id = target;
    update public.diary_communities set owner = target where id = cid;
end;
$$;
revoke execute on function public.diary_transfer_community(uuid, uuid) from public, anon;
grant execute on function public.diary_transfer_community(uuid, uuid) to authenticated;

-- ---------- Chat settings on the community ----------
alter table public.diary_communities
    add column chat_mode text not null default 'everyone' check (chat_mode in ('everyone', 'staff')),
    add column slow_mode integer not null default 0 check (slow_mode between 0 and 3600),
    add column pinned_message bigint;
grant update (chat_mode, slow_mode) on public.diary_communities to authenticated;

-- ---------- Group chat ----------
create table public.diary_community_messages (
    id bigint generated always as identity primary key,
    community_id uuid not null references public.diary_communities (id) on delete cascade,
    author uuid not null default auth.uid() references public.diary_profiles (id) on delete cascade,
    body text not null default '' check (char_length(body) <= 4000),
    attachments jsonb not null default '[]'::jsonb check (jsonb_typeof(attachments) = 'array' and jsonb_array_length(attachments) <= 6 and length(attachments::text) <= 4000),
    reply_to bigint references public.diary_community_messages (id) on delete set null,
    created_at timestamptz not null default now(),
    deleted_at timestamptz,
    deleted_by uuid,
    constraint diary_community_messages_not_empty check (body <> '' or jsonb_array_length(attachments) > 0 or deleted_at is not null)
);
create index diary_community_messages_recent on public.diary_community_messages (community_id, id desc);

create table public.diary_community_mutes (
    community_id uuid not null references public.diary_communities (id) on delete cascade,
    user_id uuid not null references public.diary_profiles (id) on delete cascade,
    until timestamptz not null,
    muted_by uuid not null,
    primary key (community_id, user_id)
);

alter table public.diary_community_messages enable row level security;
alter table public.diary_community_mutes enable row level security;

create policy "Members read their group chat" on public.diary_community_messages
    for select to authenticated using (private.diary_is_member(community_id, (select auth.uid())));

-- Posting: be a member, not muted, respect announcement-only mode and slow mode
create function private.diary_can_chat(cid uuid, uid uuid)
returns boolean language plpgsql stable security definer set search_path = '' as $$
declare
    cm public.diary_communities;
    role text := private.diary_role(cid, uid);
    last_at timestamptz;
begin
    if role is null then return false; end if;
    select * into cm from public.diary_communities where id = cid;
    if role in ('owner', 'admin', 'moderator') then return true; end if;
    if cm.chat_mode = 'staff' then return false; end if;
    if exists (select 1 from public.diary_community_mutes mu where mu.community_id = cid and mu.user_id = uid and mu.until > now()) then
        return false;
    end if;
    if cm.slow_mode > 0 then
        select max(created_at) into last_at from public.diary_community_messages m where m.community_id = cid and m.author = uid;
        if last_at is not null and last_at > now() - make_interval(secs => cm.slow_mode) then return false; end if;
    end if;
    return true;
end;
$$;

create policy "Members post in their group chat" on public.diary_community_messages
    for insert to authenticated
    with check (author = (select auth.uid()) and deleted_at is null and private.diary_can_chat(community_id, (select auth.uid())));

revoke all on public.diary_community_messages from anon, authenticated;
grant select on public.diary_community_messages to authenticated;
grant insert (community_id, body, attachments, reply_to) on public.diary_community_messages to authenticated;

create policy "Members see mutes" on public.diary_community_mutes
    for select to authenticated using (private.diary_is_member(community_id, (select auth.uid())));
revoke all on public.diary_community_mutes from anon, authenticated;
grant select on public.diary_community_mutes to authenticated;

-- Delete a message: your own, or anyone's (below you) if you're staff. It stays as "message removed".
create function public.diary_delete_community_message(mid bigint)
returns void language plpgsql security definer set search_path = '' as $$
declare
    me uuid := auth.uid();
    msg public.diary_community_messages;
begin
    select * into msg from public.diary_community_messages where id = mid;
    if msg.id is null then raise exception 'Message not found'; end if;
    if msg.author <> me and not private.diary_is_moderator(msg.community_id, me) then raise exception 'Not allowed'; end if;
    update public.diary_community_messages set deleted_at = now(), deleted_by = me, body = '', attachments = '[]'::jsonb where id = mid;
    update public.diary_communities set pinned_message = null where id = msg.community_id and pinned_message = mid;
end;
$$;

create function public.diary_pin_community_message(cid uuid, mid bigint)
returns void language plpgsql security definer set search_path = '' as $$
begin
    if not private.diary_is_moderator(cid, auth.uid()) then raise exception 'Only moderators can pin'; end if;
    if mid is not null and not exists (select 1 from public.diary_community_messages where id = mid and community_id = cid and deleted_at is null) then
        raise exception 'Message not found';
    end if;
    update public.diary_communities set pinned_message = mid where id = cid;
end;
$$;

-- Mute a member for some minutes (0 unmutes). Staff can't be muted.
create function public.diary_mute_member(cid uuid, target uuid, minutes integer)
returns void language plpgsql security definer set search_path = '' as $$
begin
    if not private.diary_is_moderator(cid, auth.uid()) then raise exception 'Only moderators can mute'; end if;
    if private.diary_role(cid, target) is distinct from 'member' then raise exception 'Only members can be muted'; end if;
    if minutes <= 0 then
        delete from public.diary_community_mutes where community_id = cid and user_id = target;
    else
        insert into public.diary_community_mutes (community_id, user_id, until, muted_by)
        values (cid, target, now() + make_interval(mins => least(minutes, 43200)), auth.uid())
        on conflict (community_id, user_id) do update set until = excluded.until, muted_by = excluded.muted_by;
    end if;
end;
$$;

revoke execute on function public.diary_delete_community_message(bigint) from public, anon;
revoke execute on function public.diary_pin_community_message(uuid, bigint) from public, anon;
revoke execute on function public.diary_mute_member(uuid, uuid, integer) from public, anon;
grant execute on function public.diary_delete_community_message(bigint) to authenticated;
grant execute on function public.diary_pin_community_message(uuid, bigint) to authenticated;
grant execute on function public.diary_mute_member(uuid, uuid, integer) to authenticated;

-- ---------- Live location (in a DM or a group chat) ----------
create table public.diary_live_locations (
    id uuid primary key default gen_random_uuid(),
    owner uuid not null default auth.uid() references public.diary_profiles (id) on delete cascade,
    peer uuid references public.diary_profiles (id) on delete cascade,          -- a DM: the friend you share with
    community_id uuid references public.diary_communities (id) on delete cascade, -- or a group chat
    lat double precision not null check (lat between -90 and 90),
    lng double precision not null check (lng between -180 and 180),
    accuracy real,
    heading real,
    speed real,
    started_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    expires_at timestamptz not null,
    stopped_at timestamptz,
    constraint diary_live_locations_one_target check (num_nonnulls(peer, community_id) = 1),
    constraint diary_live_locations_duration check (expires_at <= started_at + interval '12 hours')
);
create index diary_live_locations_peer on public.diary_live_locations (peer) where peer is not null;
create index diary_live_locations_community on public.diary_live_locations (community_id) where community_id is not null;

alter table public.diary_live_locations enable row level security;

create policy "See live locations shared with you" on public.diary_live_locations
    for select to authenticated using (
        owner = (select auth.uid())
        or peer = (select auth.uid())
        or (community_id is not null and private.diary_is_member(community_id, (select auth.uid())))
    );
create policy "Share your live location with a friend or your group" on public.diary_live_locations
    for insert to authenticated with check (
        owner = (select auth.uid()) and (
            (peer is not null and private.diary_are_friends(owner, peer))
            or (community_id is not null and private.diary_is_member(community_id, (select auth.uid())))
        )
    );
create policy "Update or stop your own live location" on public.diary_live_locations
    for update to authenticated using (owner = (select auth.uid())) with check (owner = (select auth.uid()));

revoke all on public.diary_live_locations from anon, authenticated;
grant select on public.diary_live_locations to authenticated;
grant insert (peer, community_id, lat, lng, accuracy, heading, speed, expires_at) on public.diary_live_locations to authenticated;
grant update (lat, lng, accuracy, heading, speed, updated_at, stopped_at) on public.diary_live_locations to authenticated;

alter publication supabase_realtime add table public.diary_community_messages, public.diary_community_mutes, public.diary_live_locations, public.diary_communities;
