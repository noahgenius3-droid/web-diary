-- Stories (24-hour photos/videos), reels (short videos), reposts and saved items.
-- Everything is friends-only, like the rest of the feed.

-- ---------- Stories ----------
create table public.diary_stories (
    id uuid primary key default gen_random_uuid(),
    author uuid not null default auth.uid() references public.diary_profiles (id) on delete cascade,
    media_path text not null check (char_length(media_path) between 3 and 300),
    media_type text not null check (media_type in ('image', 'video')),
    caption text not null default '' check (char_length(caption) <= 300),
    duration real check (duration is null or (duration > 0 and duration <= 60)),
    created_at timestamptz not null default now(),
    expires_at timestamptz not null default now() + interval '24 hours'
);

create index diary_stories_author on public.diary_stories (author, created_at desc);

alter table public.diary_stories enable row level security;

create policy "Friends see live stories" on public.diary_stories
    for select to authenticated
    using (expires_at > now() and (author = (select auth.uid()) or private.diary_are_friends(author, (select auth.uid()))));
create policy "Post your own stories" on public.diary_stories
    for insert to authenticated
    with check (author = (select auth.uid()) and private.diary_chat_path_part(media_path, 1) = (select auth.uid()));
create policy "Delete your own stories" on public.diary_stories
    for delete to authenticated using (author = (select auth.uid()));

grant select, delete on public.diary_stories to authenticated;
grant insert (media_path, media_type, caption, duration) on public.diary_stories to authenticated;

-- ---------- Reels ----------
create table public.diary_reels (
    id uuid primary key default gen_random_uuid(),
    author uuid not null default auth.uid() references public.diary_profiles (id) on delete cascade,
    video_path text not null check (char_length(video_path) between 3 and 300),
    poster_path text check (poster_path is null or char_length(poster_path) between 3 and 300),
    caption text not null default '' check (char_length(caption) <= 2200),
    duration real check (duration is null or (duration > 0 and duration <= 180)),
    created_at timestamptz not null default now()
);

create index diary_reels_created on public.diary_reels (created_at desc);

alter table public.diary_reels enable row level security;

create policy "Friends see reels" on public.diary_reels
    for select to authenticated
    using (author = (select auth.uid()) or private.diary_are_friends(author, (select auth.uid())));
create policy "Post your own reels" on public.diary_reels
    for insert to authenticated
    with check (
        author = (select auth.uid())
        and private.diary_chat_path_part(video_path, 1) = (select auth.uid())
        and (poster_path is null or private.diary_chat_path_part(poster_path, 1) = (select auth.uid()))
    );
create policy "Delete your own reels" on public.diary_reels
    for delete to authenticated using (author = (select auth.uid()));

grant select, delete on public.diary_reels to authenticated;
grant insert (video_path, poster_path, caption, duration) on public.diary_reels to authenticated;

create table public.diary_reel_likes (
    reel_id uuid not null references public.diary_reels (id) on delete cascade,
    user_id uuid not null default auth.uid() references public.diary_profiles (id) on delete cascade,
    created_at timestamptz not null default now(),
    primary key (reel_id, user_id)
);

alter table public.diary_reel_likes enable row level security;

create policy "Likes on visible reels are visible" on public.diary_reel_likes
    for select to authenticated
    using (exists (select 1 from public.diary_reels r where r.id = reel_id));
create policy "Like reels you can see" on public.diary_reel_likes
    for insert to authenticated
    with check (user_id = (select auth.uid()) and exists (select 1 from public.diary_reels r where r.id = reel_id));
create policy "Remove your own reel likes" on public.diary_reel_likes
    for delete to authenticated using (user_id = (select auth.uid()));

grant select, delete on public.diary_reel_likes to authenticated;
grant insert (reel_id) on public.diary_reel_likes to authenticated;

-- ---------- Comments on reels ----------
alter table public.diary_comments add column reel_id uuid references public.diary_reels (id) on delete cascade;
alter table public.diary_comments drop constraint diary_comments_check;
alter table public.diary_comments add constraint diary_comments_one_target check (num_nonnulls(entry_id, post_id, reel_id) = 1);
create index diary_comments_reel on public.diary_comments (reel_id, created_at);

drop policy "Comments on visible posts are visible" on public.diary_comments;
drop policy "Comment where you can see and take part" on public.diary_comments;
drop policy "Delete your comments, or ones on your posts" on public.diary_comments;

create policy "Comments on visible posts are visible" on public.diary_comments
    for select to authenticated
    using (
        (entry_id is not null and exists (select 1 from public.diary_shared_entries e where e.id = entry_id))
        or (post_id is not null and exists (select 1 from public.diary_community_posts p where p.id = post_id))
        or (reel_id is not null and exists (select 1 from public.diary_reels r where r.id = reel_id))
    );
create policy "Comment where you can see and take part" on public.diary_comments
    for insert to authenticated
    with check (
        author = (select auth.uid()) and (
            (entry_id is not null and exists (select 1 from public.diary_shared_entries e where e.id = entry_id))
            or (post_id is not null and exists (
                select 1 from public.diary_community_posts p
                where p.id = post_id and private.diary_is_member(p.community_id, (select auth.uid()))))
            or (reel_id is not null and exists (select 1 from public.diary_reels r where r.id = reel_id))
        )
    );
create policy "Delete your comments, or ones on your posts" on public.diary_comments
    for delete to authenticated
    using (
        author = (select auth.uid())
        or exists (select 1 from public.diary_shared_entries e where e.id = entry_id and e.author = (select auth.uid()))
        or exists (select 1 from public.diary_community_posts p where p.id = post_id
                   and (p.author = (select auth.uid()) or private.diary_is_moderator(p.community_id, (select auth.uid()))))
        or exists (select 1 from public.diary_reels r where r.id = reel_id and r.author = (select auth.uid()))
    );

grant insert (entry_id, post_id, reel_id, body) on public.diary_comments to authenticated;

-- ---------- Reposts ----------
-- A repost shows a friend's post to the reposter's own friends. Authors can switch reposts off per post,
-- which also removes existing ones.
alter table public.diary_shared_entries add column allow_reposts boolean not null default true;

create table public.diary_reposts (
    id uuid primary key default gen_random_uuid(),
    entry_id uuid not null references public.diary_shared_entries (id) on delete cascade,
    user_id uuid not null default auth.uid() references public.diary_profiles (id) on delete cascade,
    created_at timestamptz not null default now(),
    unique (entry_id, user_id)
);

create index diary_reposts_entry on public.diary_reposts (entry_id);
create index diary_reposts_user on public.diary_reposts (user_id, created_at desc);

alter table public.diary_reposts enable row level security;

-- Does the viewer reach this entry through a repost (their own, or a friend's)?
create function private.diary_reposted_to(entry uuid, uid uuid)
returns boolean
language sql stable security definer
set search_path = ''
as $$
    select exists (
        select 1 from public.diary_reposts r
        join public.diary_shared_entries e on e.id = r.entry_id
        where r.entry_id = entry and e.allow_reposts
          and (r.user_id = uid or private.diary_are_friends(r.user_id, uid))
    );
$$;

-- Same question for a feed photo, addressed by its storage path (<author>/<local id>/<file>)
create function private.diary_feed_photo_reposted_to(object_name text, uid uuid)
returns boolean
language sql stable security definer
set search_path = ''
as $$
    select exists (
        select 1 from public.diary_shared_entries e
        join public.diary_reposts r on r.entry_id = e.id
        where e.author = private.diary_chat_path_part(object_name, 1)
          and e.local_id = (storage.foldername(object_name))[2]
          and e.allow_reposts
          and (r.user_id = uid or private.diary_are_friends(r.user_id, uid))
    );
$$;

revoke execute on function private.diary_reposted_to(uuid, uuid) from public, anon;
revoke execute on function private.diary_feed_photo_reposted_to(text, uuid) from public, anon;
grant execute on function private.diary_reposted_to(uuid, uuid) to authenticated;
grant execute on function private.diary_feed_photo_reposted_to(text, uuid) to authenticated;

create policy "Reposts by you and your friends are visible" on public.diary_reposts
    for select to authenticated
    using (
        user_id = (select auth.uid())
        or private.diary_are_friends(user_id, (select auth.uid()))
        or exists (select 1 from public.diary_shared_entries e where e.id = entry_id and e.author = (select auth.uid()))
    );
create policy "Repost friends' posts that allow it" on public.diary_reposts
    for insert to authenticated
    with check (
        user_id = (select auth.uid())
        and exists (
            select 1 from public.diary_shared_entries e
            where e.id = entry_id and e.allow_reposts and e.author <> (select auth.uid())
              and private.diary_are_friends(e.author, (select auth.uid()))
        )
    );
create policy "Undo your repost, or remove reposts of your post" on public.diary_reposts
    for delete to authenticated
    using (
        user_id = (select auth.uid())
        or exists (select 1 from public.diary_shared_entries e where e.id = entry_id and e.author = (select auth.uid()))
    );

grant select, delete on public.diary_reposts to authenticated;
grant insert (entry_id) on public.diary_reposts to authenticated;

drop policy "Authors and their friends can read shared entries" on public.diary_shared_entries;
create policy "Authors, their friends and repost audiences can read shared entries" on public.diary_shared_entries
    for select to authenticated
    using (
        author = (select auth.uid())
        or private.diary_are_friends(author, (select auth.uid()))
        or private.diary_reposted_to(id, (select auth.uid()))
    );

drop policy "Diary: friends can see feed photos" on storage.objects;
create policy "Diary: friends can see feed photos" on storage.objects
    for select to authenticated
    using (
        bucket_id = 'diary-feed'
        and (
            private.diary_chat_path_part(name, 1) = (select auth.uid())
            or private.diary_are_friends(private.diary_chat_path_part(name, 1), (select auth.uid()))
            or private.diary_feed_photo_reposted_to(name, (select auth.uid()))
        )
    );

-- Switching reposts off removes the existing ones
create function private.diary_on_reposts_off()
returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
    if old.allow_reposts and not new.allow_reposts then
        delete from public.diary_reposts where entry_id = new.id;
    end if;
    return new;
end;
$$;

create trigger diary_reposts_off
    after update of allow_reposts on public.diary_shared_entries
    for each row execute function private.diary_on_reposts_off();

-- ---------- Saved items (a private bookmark list) ----------
create table public.diary_saved_items (
    user_id uuid not null default auth.uid() references public.diary_profiles (id) on delete cascade,
    kind text not null check (kind in ('entry', 'reel')),
    item_id uuid not null,
    created_at timestamptz not null default now(),
    primary key (user_id, kind, item_id)
);

alter table public.diary_saved_items enable row level security;

create policy "Your saved items" on public.diary_saved_items
    for select to authenticated using (user_id = (select auth.uid()));
create policy "Save items for yourself" on public.diary_saved_items
    for insert to authenticated with check (user_id = (select auth.uid()));
create policy "Unsave your items" on public.diary_saved_items
    for delete to authenticated using (user_id = (select auth.uid()));

grant select, delete on public.diary_saved_items to authenticated;
grant insert (kind, item_id) on public.diary_saved_items to authenticated;

-- ---------- Storage ----------
-- Stories live at <author>/<random>.<ext>; readable while a live story you can see points at them
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('diary-stories', 'diary-stories', false, 52428800,
    array['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'video/mp4', 'video/quicktime', 'video/webm']);

create policy "Diary: upload your own stories" on storage.objects
    for insert to authenticated
    with check (bucket_id = 'diary-stories' and private.diary_chat_path_part(name, 1) = (select auth.uid()));
create policy "Diary: see stories you can see" on storage.objects
    for select to authenticated
    using (
        bucket_id = 'diary-stories'
        and (
            private.diary_chat_path_part(name, 1) = (select auth.uid())
            or exists (select 1 from public.diary_stories st where st.media_path = name)
        )
    );
create policy "Diary: delete your own stories" on storage.objects
    for delete to authenticated
    using (bucket_id = 'diary-stories' and private.diary_chat_path_part(name, 1) = (select auth.uid()));

-- Reels live at <author>/<random>.<ext> (video, plus a JPEG poster frame)
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('diary-reels', 'diary-reels', false, 52428800,
    array['image/jpeg', 'video/mp4', 'video/quicktime', 'video/webm']);

create policy "Diary: upload your own reels" on storage.objects
    for insert to authenticated
    with check (bucket_id = 'diary-reels' and private.diary_chat_path_part(name, 1) = (select auth.uid()));
create policy "Diary: see reels you can see" on storage.objects
    for select to authenticated
    using (
        bucket_id = 'diary-reels'
        and (
            private.diary_chat_path_part(name, 1) = (select auth.uid())
            or exists (select 1 from public.diary_reels r where r.video_path = name or r.poster_path = name)
        )
    );
create policy "Diary: delete your own reels" on storage.objects
    for delete to authenticated
    using (bucket_id = 'diary-reels' and private.diary_chat_path_part(name, 1) = (select auth.uid()));

-- ---------- Notifications ----------
alter table public.diary_notifications drop constraint diary_notifications_type_check;
alter table public.diary_notifications add constraint diary_notifications_type_check check (type in (
    'friend_request', 'friend_accepted', 'entry_like', 'entry_comment',
    'post_like', 'post_comment', 'community_post', 'community_join', 'call_started', 'missed_call',
    'entry_repost', 'reel_like', 'reel_comment'));

create or replace function private.diary_on_comment()
returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
    e public.diary_shared_entries;
    p public.diary_community_posts;
    cm public.diary_communities;
    r public.diary_reels;
begin
    if new.entry_id is not null then
        select * into e from public.diary_shared_entries where id = new.entry_id;
        perform private.diary_notify(e.author, new.author, 'entry_comment',
            jsonb_build_object('entry_id', e.id, 'snippet', private.diary_snippet(new.body)));
    elsif new.reel_id is not null then
        select * into r from public.diary_reels where id = new.reel_id;
        perform private.diary_notify(r.author, new.author, 'reel_comment',
            jsonb_build_object('reel_id', r.id, 'snippet', private.diary_snippet(new.body)));
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

create function private.diary_on_repost()
returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
    e public.diary_shared_entries;
begin
    select * into e from public.diary_shared_entries where id = new.entry_id;
    perform private.diary_notify(e.author, new.user_id, 'entry_repost',
        jsonb_build_object('entry_id', e.id, 'snippet', private.diary_snippet(coalesce(nullif(e.title, ''), e.body), 60)));
    return new;
end;
$$;

create trigger diary_notify_repost
    after insert on public.diary_reposts
    for each row execute function private.diary_on_repost();

create function private.diary_on_reel_like()
returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
    r public.diary_reels;
begin
    select * into r from public.diary_reels where id = new.reel_id;
    perform private.diary_notify(r.author, new.user_id, 'reel_like',
        jsonb_build_object('reel_id', r.id, 'snippet', private.diary_snippet(r.caption, 60)));
    return new;
end;
$$;

create trigger diary_notify_reel_like
    after insert on public.diary_reel_likes
    for each row execute function private.diary_on_reel_like();

revoke execute on function private.diary_on_repost() from public, anon, authenticated;
revoke execute on function private.diary_on_reel_like() from public, anon, authenticated;
revoke execute on function private.diary_on_reposts_off() from public, anon, authenticated;

-- Live updates for the feed
alter publication supabase_realtime add table public.diary_stories, public.diary_reels;
