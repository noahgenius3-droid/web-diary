-- Social core (phase A): full profiles, one reaction per person (Like is 👍), public posts for followers,
-- hide / follow-a-post, profile stats, follower lists, richer people search and "people you may know".

-- ---------- Profile details (bio, location, interests) ----------
-- Kept apart from diary_profiles (which every signed-in user can read) so privacy settings can hide them.
create table if not exists public.diary_profile_details (
    user_id uuid primary key references public.diary_profiles (id) on delete cascade default auth.uid(),
    bio text not null default '' check (char_length(bio) <= 300),
    location text not null default '' check (char_length(location) <= 60),
    interests text[] not null default '{}' check (cardinality(interests) <= 12),
    updated_at timestamptz not null default now()
);
alter table public.diary_profile_details enable row level security;
create policy "Your own profile details" on public.diary_profile_details for select to authenticated using (user_id = (select auth.uid()));
create policy "Add your profile details" on public.diary_profile_details for insert to authenticated with check (user_id = (select auth.uid()));
create policy "Edit your profile details" on public.diary_profile_details for update to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
revoke all on public.diary_profile_details from anon, authenticated;
grant select, insert (user_id, bio, location, interests, updated_at), update (bio, location, interests, updated_at) on public.diary_profile_details to authenticated;

-- Interests are short lowercase words
create or replace function private.diary_clean_details() returns trigger language plpgsql set search_path = '' as $$
begin
    new.bio := btrim(new.bio);
    new.location := btrim(new.location);
    new.interests := coalesce((select array_agg(distinct x) from (
        select lower(btrim(i)) as x from unnest(new.interests) i where char_length(btrim(i)) between 2 and 30 limit 12) t), '{}');
    new.updated_at := now();
    return new;
end;
$$;
create trigger diary_clean_details before insert or update on public.diary_profile_details
    for each row execute function private.diary_clean_details();

-- ---------- Privacy: who sees your stats and lists; can people find you by email ----------
alter table public.diary_presence
    add column if not exists stats_visibility text not null default 'everyone' check (stats_visibility in ('everyone', 'friends', 'nobody')),
    add column if not exists email_search boolean not null default false;

create or replace function public.diary_set_privacy(p_key text, p_value text)
returns void language plpgsql security definer set search_path = '' as $$
begin
    if p_key = 'allow_calls' and p_value in ('friends', 'nobody') then
        insert into public.diary_presence (user_id, allow_calls) values (auth.uid(), p_value) on conflict (user_id) do update set allow_calls = p_value;
    elsif p_key = 'photo_visibility' and p_value in ('everyone', 'friends') then
        insert into public.diary_presence (user_id, photo_visibility) values (auth.uid(), p_value) on conflict (user_id) do update set photo_visibility = p_value;
    elsif p_key = 'profile_visibility' and p_value in ('everyone', 'friends') then
        insert into public.diary_presence (user_id, profile_visibility) values (auth.uid(), p_value) on conflict (user_id) do update set profile_visibility = p_value;
    elsif p_key = 'stats_visibility' and p_value in ('everyone', 'friends', 'nobody') then
        insert into public.diary_presence (user_id, stats_visibility) values (auth.uid(), p_value) on conflict (user_id) do update set stats_visibility = p_value;
    elsif p_key = 'email_search' and p_value in ('on', 'off') then
        insert into public.diary_presence (user_id, email_search) values (auth.uid(), p_value = 'on') on conflict (user_id) do update set email_search = (p_value = 'on');
    else
        raise exception 'Unknown setting';
    end if;
end;
$$;

-- Can `viewer` see `owner`'s stats / follower lists / details?
create or replace function private.diary_can_see(owner uuid, viewer uuid, setting text)
returns boolean language sql stable security definer set search_path = '' as $$
    select owner = viewer or (
        not private.diary_blocked(owner, viewer) and
        case coalesce((select case setting when 'stats' then pr.stats_visibility else pr.profile_visibility end
                       from public.diary_presence pr where pr.user_id = owner), 'everyone')
            when 'everyone' then true
            when 'friends' then private.diary_are_friends(owner, viewer)
            else false
        end);
$$;

-- ---------- One reaction per person: Like is 👍, and you can change it ----------
alter table public.diary_entry_likes add column if not exists emoji text not null default '👍';
alter table public.diary_community_likes add column if not exists emoji text not null default '👍';
alter table public.diary_entry_likes drop constraint if exists diary_entry_likes_emoji_check;
alter table public.diary_entry_likes add constraint diary_entry_likes_emoji_check check (emoji in ('👍', '❤️', '😂', '🙏', '👏', '😮'));
alter table public.diary_community_likes drop constraint if exists diary_community_likes_emoji_check;
alter table public.diary_community_likes add constraint diary_community_likes_emoji_check check (emoji in ('👍', '❤️', '😂', '🙏', '👏', '😮'));

-- Bring each person's latest separate emoji reaction into their like (without re-notifying anyone)
alter table public.diary_entry_likes disable trigger diary_notify_entry_like;
insert into public.diary_entry_likes (entry_id, user_id, emoji, created_at)
select distinct on (entry_id, user_id) entry_id, user_id,
    case emoji when '😍' then '❤️' when '😢' then '❤️' when '🔥' then '👏' else emoji end, created_at
from public.diary_entry_reactions order by entry_id, user_id, created_at desc
on conflict (entry_id, user_id) do update set emoji = excluded.emoji;
alter table public.diary_entry_likes enable trigger diary_notify_entry_like;

alter table public.diary_community_likes disable trigger diary_notify_post_like;
insert into public.diary_community_likes (post_id, user_id, emoji, created_at)
select distinct on (post_id, user_id) post_id, user_id,
    case emoji when '🔥' then '👏' else emoji end, created_at
from public.diary_community_reactions order by post_id, user_id, created_at desc
on conflict (post_id, user_id) do update set emoji = excluded.emoji;
alter table public.diary_community_likes enable trigger diary_notify_post_like;

grant insert (emoji), update (emoji) on public.diary_entry_likes to authenticated;
grant insert (emoji), update (emoji) on public.diary_community_likes to authenticated;
create policy "Change your own reaction" on public.diary_entry_likes for update to authenticated
    using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy "Change your own reaction" on public.diary_community_likes for update to authenticated
    using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

-- The like notification says which reaction it was
create or replace function private.diary_on_entry_like()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
    e public.diary_shared_entries;
begin
    select * into e from public.diary_shared_entries where id = new.entry_id;
    perform private.diary_notify(e.author, new.user_id, 'entry_like',
        jsonb_build_object('entry_id', e.id, 'emoji', new.emoji, 'snippet', private.diary_snippet(coalesce(nullif(e.title, ''), e.body), 60)));
    return new;
end;
$$;

-- ---------- Posts for everyone (followers and discovery) or friends only ----------
alter table public.diary_shared_entries add column if not exists audience text not null default 'friends' check (audience in ('friends', 'public'));
grant insert (audience), update (audience) on public.diary_shared_entries to authenticated;
create policy "Public posts are visible to everyone signed in" on public.diary_shared_entries for select to authenticated
    using (audience = 'public' and not private.diary_blocked(author, (select auth.uid())));

-- ---------- Hide a post; follow a post for new comments ----------
create table if not exists public.diary_hidden_posts (
    user_id uuid not null default auth.uid() references public.diary_profiles (id) on delete cascade,
    kind text not null check (kind in ('entry', 'post')),
    item_id uuid not null,
    created_at timestamptz not null default now(),
    primary key (user_id, kind, item_id)
);
create table if not exists public.diary_post_watch (
    user_id uuid not null default auth.uid() references public.diary_profiles (id) on delete cascade,
    kind text not null check (kind in ('entry', 'post')),
    item_id uuid not null,
    created_at timestamptz not null default now(),
    primary key (user_id, kind, item_id)
);
create index if not exists diary_post_watch_item on public.diary_post_watch (kind, item_id);
alter table public.diary_hidden_posts enable row level security;
alter table public.diary_post_watch enable row level security;
create policy "Your hidden posts" on public.diary_hidden_posts for select to authenticated using (user_id = (select auth.uid()));
create policy "Hide posts" on public.diary_hidden_posts for insert to authenticated with check (user_id = (select auth.uid()));
create policy "Unhide posts" on public.diary_hidden_posts for delete to authenticated using (user_id = (select auth.uid()));
create policy "Posts you follow" on public.diary_post_watch for select to authenticated using (user_id = (select auth.uid()));
create policy "Follow posts you can see" on public.diary_post_watch for insert to authenticated with check (
    user_id = (select auth.uid()) and (
        (kind = 'entry' and exists (select 1 from public.diary_shared_entries e where e.id = item_id)) or
        (kind = 'post' and exists (select 1 from public.diary_community_posts p where p.id = item_id))));
create policy "Stop following posts" on public.diary_post_watch for delete to authenticated using (user_id = (select auth.uid()));
revoke all on public.diary_hidden_posts, public.diary_post_watch from anon, authenticated;
grant select, insert (kind, item_id), delete on public.diary_hidden_posts, public.diary_post_watch to authenticated;

alter table public.diary_notifications drop constraint diary_notifications_type_check;
alter table public.diary_notifications add constraint diary_notifications_type_check check (type in (
    'friend_request', 'friend_accepted', 'entry_like', 'entry_comment', 'post_like', 'post_comment', 'community_post',
    'community_join', 'call_started', 'missed_call', 'entry_repost', 'reel_like', 'reel_comment', 'library_like',
    'live_started', 'new_follower', 'book_request', 'book_request_update', 'book_message', 'entry_reaction',
    'story_reaction', 'mention', 'reply', 'new_login', 'post_activity'));

-- Someone commented on a post you follow
create or replace function private.diary_on_watched_comment()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
    k text := case when new.entry_id is not null then 'entry' when new.post_id is not null then 'post' end;
    item uuid := coalesce(new.entry_id, new.post_id);
    owner uuid;
    cm public.diary_communities;
begin
    if k is null then return new; end if;
    if k = 'entry' then
        select author into owner from public.diary_shared_entries where id = item;
    else
        select p.author into owner from public.diary_community_posts p where p.id = item;
        select c.* into cm from public.diary_communities c join public.diary_community_posts p on p.community_id = c.id where p.id = item;
    end if;
    insert into public.diary_notifications (user_id, actor, type, data)
    select w.user_id, new.author, 'post_activity',
        jsonb_build_object('kind', k, 'entry_id', new.entry_id, 'post_id', new.post_id, 'community_id', cm.id,
            'community_name', cm.name, 'emoji', cm.emoji, 'snippet', private.diary_snippet(new.body))
    from public.diary_post_watch w
    where w.kind = k and w.item_id = item and w.user_id <> new.author and w.user_id is distinct from owner
      and not private.diary_blocked(w.user_id, new.author);
    return new;
end;
$$;
create trigger diary_notify_watchers after insert on public.diary_comments
    for each row execute function private.diary_on_watched_comment();

-- ---------- A full profile ----------
create or replace function public.diary_profile_full(p_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
    me uuid := auth.uid();
    p public.diary_profiles;
    d public.diary_profile_details;
    friends boolean;
    see_details boolean;
    see_stats boolean;
    photo text;
begin
    if me is null then return null; end if;
    select * into p from public.diary_profiles where id = p_id;
    if not found then return null; end if;
    select * into d from public.diary_profile_details where user_id = p_id;
    friends := p_id = me or private.diary_are_friends(p_id, me);
    see_details := private.diary_can_see(p_id, me, 'profile');
    see_stats := private.diary_can_see(p_id, me, 'stats');
    select coalesce(pr.photo_visibility, 'everyone') into photo from public.diary_presence pr where pr.user_id = p_id;
    return jsonb_build_object(
        'id', p.id, 'username', p.username, 'display_name', p.display_name,
        'avatar_path', case when coalesce(photo, 'everyone') = 'everyone' or friends then p.avatar_path end,
        'created_at', case when see_details then p.created_at end,
        'bio', case when see_details then coalesce(d.bio, '') end,
        'location', case when see_details then coalesce(d.location, '') end,
        'interests', case when see_details then to_jsonb(coalesce(d.interests, '{}')) end,
        'limited', not see_details,
        'stats_hidden', not see_stats,
        'blocked', private.diary_blocked(p_id, me),
        'friends', friends and p_id <> me,
        'i_follow', exists (select 1 from public.diary_follows where follower = me and followee = p_id),
        'follows_you', exists (select 1 from public.diary_follows where follower = p_id and followee = me),
        'mutual_friends', (select count(*) from public.diary_friendships a join public.diary_friendships b
                on (case when a.requester = me then a.addressee else a.requester end) = (case when b.requester = p_id then b.addressee else b.requester end)
            where a.status = 'accepted' and b.status = 'accepted' and me in (a.requester, a.addressee) and p_id in (b.requester, b.addressee)),
        'shared_groups', (select count(*) from public.diary_community_members a join public.diary_community_members b using (community_id)
            where a.user_id = me and b.user_id = p_id),
        'stats', case when see_stats then jsonb_build_object(
            'posts', (select count(*) from public.diary_shared_entries where author = p_id),
            'reposts', (select count(*) from public.diary_reposts r join public.diary_shared_entries e on e.id = r.entry_id where r.user_id = p_id and e.author <> p_id),
            'reactions', (select count(*) from public.diary_entry_likes l join public.diary_shared_entries e on e.id = l.entry_id where e.author = p_id)
                       + (select count(*) from public.diary_community_likes l join public.diary_community_posts cp on cp.id = l.post_id where cp.author = p_id),
            'followers', (select count(*) from public.diary_follows where followee = p_id),
            'following', (select count(*) from public.diary_follows where follower = p_id),
            'friends', (select count(*) from public.diary_friendships where status = 'accepted' and p_id in (requester, addressee))
        ) end
    );
end;
$$;

-- Followers / following of anyone, as far as their privacy allows
create or replace function public.diary_follow_list(p_user uuid, p_which text, p_limit int default 200)
returns table (id uuid, username text, display_name text, avatar_path text, i_follow boolean, friend boolean)
language sql stable security definer set search_path = '' as $$
    select p.id, p.username, p.display_name,
        case when coalesce(pr.photo_visibility, 'everyone') = 'everyone' or private.diary_are_friends(p.id, auth.uid()) or p.id = auth.uid() then p.avatar_path end,
        exists (select 1 from public.diary_follows x where x.follower = auth.uid() and x.followee = p.id),
        private.diary_are_friends(p.id, auth.uid())
    from public.diary_follows f
    join public.diary_profiles p on p.id = case when p_which = 'followers' then f.follower else f.followee end
    left join public.diary_presence pr on pr.user_id = p.id
    where auth.uid() is not null
      and p_which in ('followers', 'following')
      and (case when p_which = 'followers' then f.followee else f.follower end) = p_user
      and private.diary_can_see(p_user, auth.uid(), 'stats')
      and not private.diary_blocked(p.id, auth.uid())
    order by f.created_at desc
    limit least(greatest(coalesce(p_limit, 200), 1), 500);
$$;

-- Everyone who reacted to a post you can see (runs as you, so visibility rules apply)
create or replace function public.diary_reactors(p_kind text, p_id uuid)
returns table (id uuid, username text, display_name text, avatar_path text, emoji text, created_at timestamptz)
language sql stable security invoker set search_path = '' as $$
    select p.id, p.username, p.display_name, p.avatar_path, l.emoji, l.created_at
    from public.diary_entry_likes l join public.diary_profiles p on p.id = l.user_id
    where p_kind = 'entry' and l.entry_id = p_id
    union all
    select p.id, p.username, p.display_name, p.avatar_path, l.emoji, l.created_at
    from public.diary_community_likes l join public.diary_profiles p on p.id = l.user_id
    where p_kind = 'post' and l.post_id = p_id
    order by 6 desc
    limit 500;
$$;

-- Your own activity: what you did lately, and totals
create or replace function public.diary_my_activity(p_limit int default 40)
returns jsonb language sql stable security definer set search_path = '' as $$
    with me as (select auth.uid() as uid),
    items as (
        (select 'post' as kind, e.shared_at as at, e.id::text as ref, coalesce(nullif(e.title, ''), left(e.body, 80)) as text, null::text as who
         from public.diary_shared_entries e where e.author = (select uid from me) order by e.shared_at desc limit 20)
        union all
        (select 'comment', c.created_at, coalesce(c.entry_id, c.post_id)::text, left(c.body, 80), null
         from public.diary_comments c where c.author = (select uid from me) order by c.created_at desc limit 20)
        union all
        (select 'reaction', l.created_at, l.entry_id::text, l.emoji, (select display_name from public.diary_profiles where id = e.author)
         from public.diary_entry_likes l join public.diary_shared_entries e on e.id = l.entry_id
         where l.user_id = (select uid from me) order by l.created_at desc limit 20)
        union all
        (select 'follower', f.created_at, f.follower::text, null, p.display_name
         from public.diary_follows f join public.diary_profiles p on p.id = f.follower
         where f.followee = (select uid from me) order by f.created_at desc limit 20)
    )
    select jsonb_build_object(
        'totals', jsonb_build_object(
            'posts', (select count(*) from public.diary_shared_entries where author = (select uid from me)),
            'comments', (select count(*) from public.diary_comments where author = (select uid from me)),
            'reactions_given', (select count(*) from public.diary_entry_likes where user_id = (select uid from me))
                             + (select count(*) from public.diary_community_likes where user_id = (select uid from me)),
            'followers_30d', (select count(*) from public.diary_follows where followee = (select uid from me) and created_at > now() - interval '30 days')),
        'items', coalesce((select jsonb_agg(to_jsonb(i) order by i.at desc) from (select * from items order by at desc limit least(coalesce(p_limit, 40), 100)) i), '[]'::jsonb))
    where (select uid from me) is not null;
$$;

-- ---------- People search: name, @username, bio, interests, groups, and email (only if they allow it) ----------
drop function if exists public.diary_search_people(text);
create or replace function public.diary_search_people(q text)
returns table (id uuid, username text, display_name text, avatar_path text, relation text, following boolean, follows_you boolean, matched text)
language sql stable security definer set search_path = '' as $$
    with me as (select auth.uid() as uid),
    term as (select lower(btrim(regexp_replace(coalesce(q, ''), '^@', ''))) as t),
    pat as (select '%' || replace(replace(replace(t, '\', '\\'), '%', '\%'), '_', '\_') || '%' as pt, t from term),
    by_email as (
        select u.id from auth.users u join public.diary_presence pr on pr.user_id = u.id and pr.email_search
        where (select t from term) like '%@%.%' and lower(u.email) = (select t from term)),
    hits as (
        select p.id,
            case
                when p.id in (select id from by_email) then 'Email match'
                when lower(p.username) like (select pt from pat) or lower(p.display_name) like (select pt from pat) then null
                when private.diary_can_see(p.id, (select uid from me), 'profile') and exists (
                    select 1 from public.diary_profile_details d where d.user_id = p.id
                    and exists (select 1 from unnest(d.interests) i where i like (select pt from pat)))
                    then 'Interested in ' || (select string_agg(i, ', ') from public.diary_profile_details d, unnest(d.interests) i where d.user_id = p.id and i like (select pt from pat))
                when private.diary_can_see(p.id, (select uid from me), 'profile') and exists (
                    select 1 from public.diary_profile_details d where d.user_id = p.id and (lower(d.bio) like (select pt from pat) or lower(d.location) like (select pt from pat)))
                    then (select case when lower(d.location) like (select pt from pat) then 'Lives in ' || d.location else left(d.bio, 60) end from public.diary_profile_details d where d.user_id = p.id)
                else (select 'Member of ' || c.name from public.diary_community_members m join public.diary_communities c on c.id = m.community_id
                      where m.user_id = p.id and lower(c.name) like (select pt from pat)
                        and (c.visibility = 'public' or private.diary_is_member(c.id, (select uid from me))) limit 1)
            end as matched,
            (lower(p.username) = (select t from term) or lower(p.display_name) = (select t from term)) as exact,
            (lower(p.username) like (select t from term) || '%' or lower(p.display_name) like (select t from term) || '%') as prefix
        from public.diary_profiles p
        where (select uid from me) is not null and char_length((select t from term)) >= 2 and p.id <> (select uid from me)
          and not exists (select 1 from public.diary_blocks b where b.blocker = p.id and b.blocked = (select uid from me))
          and (
            lower(p.username) like (select pt from pat) or lower(p.display_name) like (select pt from pat)
            or p.id in (select id from by_email)
            or (private.diary_can_see(p.id, (select uid from me), 'profile') and exists (
                select 1 from public.diary_profile_details d where d.user_id = p.id and (
                    lower(d.bio) like (select pt from pat) or lower(d.location) like (select pt from pat)
                    or exists (select 1 from unnest(d.interests) i where i like (select pt from pat)))))
            or exists (select 1 from public.diary_community_members m join public.diary_communities c on c.id = m.community_id
                where m.user_id = p.id and lower(c.name) like (select pt from pat)
                  and (c.visibility = 'public' or private.diary_is_member(c.id, (select uid from me)))))
    )
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
        exists (select 1 from public.diary_follows fo where fo.followee = (select uid from me) and fo.follower = p.id),
        h.matched
    from hits h join public.diary_profiles p on p.id = h.id
    left join public.diary_presence pr on pr.user_id = p.id
    order by h.exact desc, h.prefix desc, (h.matched is null) desc, p.display_name
    limit 30;
$$;

-- ---------- People you may know ----------
create or replace function public.diary_people_you_may_know(p_limit int default 12)
returns table (id uuid, username text, display_name text, avatar_path text, reason text, score int)
language sql stable security definer set search_path = '' as $$
    with me as (select auth.uid() as uid),
    my_friends as (
        select case when f.requester = (select uid from me) then f.addressee else f.requester end as id
        from public.diary_friendships f where f.status = 'accepted' and (select uid from me) in (f.requester, f.addressee)),
    known as (
        select case when f.requester = (select uid from me) then f.addressee else f.requester end as id
        from public.diary_friendships f where (select uid from me) in (f.requester, f.addressee)
        union select followee from public.diary_follows where follower = (select uid from me)
        union select blocked from public.diary_blocks where blocker = (select uid from me)
        union select blocker from public.diary_blocks where blocked = (select uid from me)
        union select (select uid from me)),
    my_interests as (select unnest(interests) as i from public.diary_profile_details where user_id = (select uid from me)),
    signals as (
        -- friends of friends
        select case when f.requester = mf.id then f.addressee else f.requester end as id, 3 as w, 'friend' as why
        from public.diary_friendships f join my_friends mf on mf.id in (f.requester, f.addressee) where f.status = 'accepted'
        -- people your friends and follows follow
        union all
        select fo.followee, 2, 'follow' from public.diary_follows fo
        where fo.follower in (select id from my_friends union select followee from public.diary_follows where follower = (select uid from me))
        -- people in your groups
        union all
        select b.user_id, 2, 'group' from public.diary_community_members a join public.diary_community_members b using (community_id)
        where a.user_id = (select uid from me)
        -- shared interests
        union all
        select d.user_id, 2, 'interest' from public.diary_profile_details d, my_interests mi where mi.i = any (d.interests)
        -- they follow you
        union all
        select follower, 4, 'fan' from public.diary_follows where followee = (select uid from me)
    ),
    scored as (
        select s.id, sum(s.w)::int as score,
            count(*) filter (where why = 'friend') as mutual,
            bool_or(why = 'fan') as fan,
            bool_or(why = 'group') as grp,
            bool_or(why = 'interest') as interest
        from signals s where s.id not in (select id from known) group by s.id)
    select p.id, p.username, p.display_name,
        case when coalesce(pr.photo_visibility, 'everyone') = 'everyone' then p.avatar_path end,
        case when sc.fan then 'Follows you'
             when sc.mutual > 0 then sc.mutual || ' mutual friend' || case when sc.mutual = 1 then '' else 's' end
             when sc.grp then 'In a group with you'
             when sc.interest then 'Shares your interests'
             else 'Popular in your circle' end,
        sc.score + (p.avatar_path is not null)::int
    from scored sc join public.diary_profiles p on p.id = sc.id
    left join public.diary_presence pr on pr.user_id = p.id
    where (select uid from me) is not null
    order by 6 desc, p.created_at desc
    limit least(greatest(coalesce(p_limit, 12), 1), 30);
$$;

revoke all on function public.diary_profile_full(uuid), public.diary_follow_list(uuid, text, int), public.diary_reactors(text, uuid),
    public.diary_my_activity(int), public.diary_search_people(text), public.diary_people_you_may_know(int) from public, anon;
grant execute on function public.diary_profile_full(uuid), public.diary_follow_list(uuid, text, int), public.diary_reactors(text, uuid),
    public.diary_my_activity(int), public.diary_search_people(text), public.diary_people_you_may_know(int) to authenticated;
