-- Communities (public or invite-only groups with posts, photos, likes) and comments for feed + community posts.

-- ---------- Communities ----------
create table public.diary_communities (
    id uuid primary key default gen_random_uuid(),
    name text not null check (char_length(trim(name)) between 2 and 60),
    description text not null default '' check (char_length(description) <= 400),
    emoji text not null default '📓' check (char_length(emoji) <= 8),
    color text not null default 'purple' check (color in ('yellow', 'pink', 'blue', 'green', 'purple')),
    visibility text not null default 'public' check (visibility in ('public', 'private')),
    invite_code text not null unique default substr(replace(gen_random_uuid()::text, '-', ''), 1, 8),
    owner uuid not null references public.diary_profiles (id) on delete cascade,
    created_at timestamptz not null default now()
);

create table public.diary_community_members (
    community_id uuid not null references public.diary_communities (id) on delete cascade,
    user_id uuid not null references public.diary_profiles (id) on delete cascade,
    role text not null default 'member' check (role in ('owner', 'admin', 'member')),
    joined_at timestamptz not null default now(),
    primary key (community_id, user_id)
);

create index diary_community_members_user on public.diary_community_members (user_id);

create function private.diary_is_member(cid uuid, uid uuid)
returns boolean
language sql stable security definer
set search_path = ''
as $$
    select exists (select 1 from public.diary_community_members m where m.community_id = cid and m.user_id = uid);
$$;

create function private.diary_is_moderator(cid uuid, uid uuid)
returns boolean
language sql stable security definer
set search_path = ''
as $$
    select exists (
        select 1 from public.diary_community_members m
        where m.community_id = cid and m.user_id = uid and m.role in ('owner', 'admin')
    );
$$;

create function private.diary_community_visible(cid uuid, uid uuid)
returns boolean
language sql stable security definer
set search_path = ''
as $$
    select exists (select 1 from public.diary_communities c where c.id = cid and c.visibility = 'public')
        or private.diary_is_member(cid, uid);
$$;

revoke execute on function private.diary_is_member(uuid, uuid) from public, anon;
revoke execute on function private.diary_is_moderator(uuid, uuid) from public, anon;
revoke execute on function private.diary_community_visible(uuid, uuid) from public, anon;
grant execute on function private.diary_is_member(uuid, uuid) to authenticated;
grant execute on function private.diary_is_moderator(uuid, uuid) to authenticated;
grant execute on function private.diary_community_visible(uuid, uuid) to authenticated;

alter table public.diary_communities enable row level security;
alter table public.diary_community_members enable row level security;

-- Invite codes of private communities are only readable by members (the row itself is hidden otherwise)
create policy "Public communities and your own are visible" on public.diary_communities
    for select to authenticated
    using (visibility = 'public' or private.diary_is_member(id, (select auth.uid())));
create policy "Moderators edit their community" on public.diary_communities
    for update to authenticated
    using (private.diary_is_moderator(id, (select auth.uid())))
    with check (private.diary_is_moderator(id, (select auth.uid())));
create policy "Owners delete their community" on public.diary_communities
    for delete to authenticated using (owner = (select auth.uid()));

create policy "Members are visible where the community is" on public.diary_community_members
    for select to authenticated
    using (private.diary_community_visible(community_id, (select auth.uid())));
create policy "Leave, or moderators remove members" on public.diary_community_members
    for delete to authenticated
    using (user_id = (select auth.uid()) or private.diary_is_moderator(community_id, (select auth.uid())));

grant select, delete on public.diary_communities to authenticated;
grant update (name, description, emoji, color, visibility) on public.diary_communities to authenticated;
grant select, delete on public.diary_community_members to authenticated;

-- Create / join / leave go through functions so roles and owners stay consistent
create function public.diary_create_community(p_name text, p_description text, p_emoji text, p_color text, p_visibility text)
returns public.diary_communities
language plpgsql security definer
set search_path = ''
as $$
declare
    result public.diary_communities;
begin
    if auth.uid() is null then raise exception 'Not signed in'; end if;
    insert into public.diary_communities (name, description, emoji, color, visibility, owner)
    values (trim(p_name), coalesce(p_description, ''), coalesce(nullif(p_emoji, ''), '📓'), coalesce(p_color, 'purple'), coalesce(p_visibility, 'public'), auth.uid())
    returning * into result;
    insert into public.diary_community_members (community_id, user_id, role) values (result.id, auth.uid(), 'owner');
    return result;
end;
$$;

create function public.diary_join_community(p_id uuid default null, p_code text default null)
returns public.diary_communities
language plpgsql security definer
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
    insert into public.diary_community_members (community_id, user_id) values (target.id, auth.uid())
    on conflict do nothing;
    return target;
end;
$$;

create function public.diary_leave_community(p_id uuid)
returns void
language plpgsql security definer
set search_path = ''
as $$
declare
    next_owner uuid;
begin
    if not exists (select 1 from public.diary_communities where id = p_id and owner = auth.uid()) then
        delete from public.diary_community_members where community_id = p_id and user_id = auth.uid();
        return;
    end if;
    -- The owner is leaving: hand over to the longest-standing admin, else member; delete if nobody is left
    select user_id into next_owner from public.diary_community_members
    where community_id = p_id and user_id <> auth.uid()
    order by (role = 'admin') desc, joined_at
    limit 1;
    if next_owner is null then
        delete from public.diary_communities where id = p_id;
    else
        update public.diary_communities set owner = next_owner where id = p_id;
        update public.diary_community_members set role = 'owner' where community_id = p_id and user_id = next_owner;
        delete from public.diary_community_members where community_id = p_id and user_id = auth.uid();
    end if;
end;
$$;

revoke execute on function public.diary_create_community(text, text, text, text, text) from public, anon;
revoke execute on function public.diary_join_community(uuid, text) from public, anon;
revoke execute on function public.diary_leave_community(uuid) from public, anon;
grant execute on function public.diary_create_community(text, text, text, text, text) to authenticated;
grant execute on function public.diary_join_community(uuid, text) to authenticated;
grant execute on function public.diary_leave_community(uuid) to authenticated;

-- ---------- Community posts ----------
create table public.diary_community_posts (
    id uuid primary key default gen_random_uuid(),
    community_id uuid not null references public.diary_communities (id) on delete cascade,
    author uuid not null default auth.uid() references public.diary_profiles (id) on delete cascade,
    kind text not null default 'update' check (kind in ('update', 'note')),
    title text not null default '' check (char_length(title) <= 200),
    body text not null default '' check (char_length(body) <= 20000),
    html text not null default '' check (char_length(html) <= 60000),
    photos jsonb not null default '[]'::jsonb check (jsonb_typeof(photos) = 'array' and jsonb_array_length(photos) <= 10),
    created_at timestamptz not null default now(),
    check (body <> '' or title <> '' or jsonb_array_length(photos) > 0)
);

create index diary_community_posts_feed on public.diary_community_posts (community_id, created_at desc);

create table public.diary_community_likes (
    post_id uuid not null references public.diary_community_posts (id) on delete cascade,
    user_id uuid not null default auth.uid() references public.diary_profiles (id) on delete cascade,
    created_at timestamptz not null default now(),
    primary key (post_id, user_id)
);

alter table public.diary_community_posts enable row level security;
alter table public.diary_community_likes enable row level security;

create policy "Posts are visible where the community is" on public.diary_community_posts
    for select to authenticated
    using (private.diary_community_visible(community_id, (select auth.uid())));
create policy "Members post in their communities" on public.diary_community_posts
    for insert to authenticated
    with check (author = (select auth.uid()) and private.diary_is_member(community_id, (select auth.uid())));
create policy "Authors and moderators delete posts" on public.diary_community_posts
    for delete to authenticated
    using (author = (select auth.uid()) or private.diary_is_moderator(community_id, (select auth.uid())));

create policy "Likes on visible posts are visible" on public.diary_community_likes
    for select to authenticated
    using (exists (select 1 from public.diary_community_posts p where p.id = post_id));
create policy "Members like posts" on public.diary_community_likes
    for insert to authenticated
    with check (user_id = (select auth.uid()) and exists (
        select 1 from public.diary_community_posts p
        where p.id = post_id and private.diary_is_member(p.community_id, (select auth.uid()))));
create policy "Remove your own likes" on public.diary_community_likes
    for delete to authenticated using (user_id = (select auth.uid()));

grant select, delete on public.diary_community_posts to authenticated;
grant insert (community_id, kind, title, body, html, photos) on public.diary_community_posts to authenticated;
grant select, delete on public.diary_community_likes to authenticated;
grant insert (post_id) on public.diary_community_likes to authenticated;

-- ---------- Comments (feed entries and community posts) ----------
create table public.diary_comments (
    id uuid primary key default gen_random_uuid(),
    entry_id uuid references public.diary_shared_entries (id) on delete cascade,
    post_id uuid references public.diary_community_posts (id) on delete cascade,
    author uuid not null default auth.uid() references public.diary_profiles (id) on delete cascade,
    body text not null check (char_length(trim(body)) between 1 and 2000),
    created_at timestamptz not null default now(),
    check ((entry_id is null) <> (post_id is null))
);

create index diary_comments_entry on public.diary_comments (entry_id, created_at);
create index diary_comments_post on public.diary_comments (post_id, created_at);

alter table public.diary_comments enable row level security;

-- The subqueries run under the parent tables' own policies, so comments follow their post's visibility
create policy "Comments on visible posts are visible" on public.diary_comments
    for select to authenticated
    using (
        (entry_id is not null and exists (select 1 from public.diary_shared_entries e where e.id = entry_id))
        or (post_id is not null and exists (select 1 from public.diary_community_posts p where p.id = post_id))
    );
create policy "Comment where you can see and take part" on public.diary_comments
    for insert to authenticated
    with check (
        author = (select auth.uid()) and (
            (entry_id is not null and exists (select 1 from public.diary_shared_entries e where e.id = entry_id))
            or (post_id is not null and exists (
                select 1 from public.diary_community_posts p
                where p.id = post_id and private.diary_is_member(p.community_id, (select auth.uid()))))
        )
    );
create policy "Delete your comments, or ones on your posts" on public.diary_comments
    for delete to authenticated
    using (
        author = (select auth.uid())
        or exists (select 1 from public.diary_shared_entries e where e.id = entry_id and e.author = (select auth.uid()))
        or exists (select 1 from public.diary_community_posts p where p.id = post_id
                   and (p.author = (select auth.uid()) or private.diary_is_moderator(p.community_id, (select auth.uid()))))
    );

grant select, delete on public.diary_comments to authenticated;
grant insert (entry_id, post_id, body) on public.diary_comments to authenticated;

-- ---------- Community photos ----------
-- Objects live at <community id>/<author id>/<random>.<ext>
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('diary-community', 'diary-community', false, 10485760, array['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

create policy "Diary: members upload community photos" on storage.objects
    for insert to authenticated
    with check (
        bucket_id = 'diary-community'
        and private.diary_chat_path_part(name, 2) = (select auth.uid())
        and private.diary_is_member(private.diary_chat_path_part(name, 1), (select auth.uid()))
    );
create policy "Diary: community photos follow community visibility" on storage.objects
    for select to authenticated
    using (bucket_id = 'diary-community' and private.diary_community_visible(private.diary_chat_path_part(name, 1), (select auth.uid())));
create policy "Diary: delete your own community photos" on storage.objects
    for delete to authenticated
    using (bucket_id = 'diary-community' and private.diary_chat_path_part(name, 2) = (select auth.uid()));

-- ---------- Realtime ----------
alter publication supabase_realtime add table public.diary_community_posts, public.diary_comments;
