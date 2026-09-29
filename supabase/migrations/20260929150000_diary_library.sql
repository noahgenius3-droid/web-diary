-- The Library: stories, books, poems and essays people publish for others to read.
-- Public items are readable by every signed-in user; friends-only items by the author's friends.

create table public.diary_library (
    id uuid primary key default gen_random_uuid(),
    author uuid not null default auth.uid() references public.diary_profiles (id) on delete cascade,
    kind text not null default 'story' check (kind in ('story', 'book', 'poem', 'essay')),
    title text not null check (char_length(title) between 1 and 160),
    description text not null default '' check (char_length(description) <= 600),
    genre text not null default '' check (char_length(genre) <= 40),
    content text not null default '' check (char_length(content) <= 300000),
    words integer not null default 0 check (words >= 0),
    file_path text check (file_path is null or char_length(file_path) between 3 and 300),
    file_type text check (file_type is null or file_type in ('application/pdf', 'application/epub+zip')),
    file_size bigint check (file_size is null or file_size between 1 and 52428800),
    cover_path text check (cover_path is null or char_length(cover_path) between 3 and 300),
    visibility text not null default 'public' check (visibility in ('public', 'friends')),
    reads integer not null default 0,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    check (content <> '' or file_path is not null)
);

create index diary_library_new on public.diary_library (created_at desc);
create index diary_library_author on public.diary_library (author, created_at desc);

alter table public.diary_library enable row level security;

create policy "Public items, your own, and friends' friends-only items" on public.diary_library
    for select to authenticated
    using (
        visibility = 'public'
        or author = (select auth.uid())
        or private.diary_are_friends(author, (select auth.uid()))
    );
create policy "Publish your own work" on public.diary_library
    for insert to authenticated
    with check (
        author = (select auth.uid())
        and (file_path is null or private.diary_chat_path_part(file_path, 1) = (select auth.uid()))
        and (cover_path is null or private.diary_chat_path_part(cover_path, 1) = (select auth.uid()))
    );
create policy "Edit your own work" on public.diary_library
    for update to authenticated
    using (author = (select auth.uid()))
    with check (
        author = (select auth.uid())
        and (cover_path is null or private.diary_chat_path_part(cover_path, 1) = (select auth.uid()))
    );
create policy "Delete your own work" on public.diary_library
    for delete to authenticated using (author = (select auth.uid()));

grant select, delete on public.diary_library to authenticated;
grant insert (kind, title, description, genre, content, words, file_path, file_type, file_size, cover_path, visibility)
    on public.diary_library to authenticated;
grant update (kind, title, description, genre, content, words, cover_path, visibility, updated_at)
    on public.diary_library to authenticated;

-- Hearts
create table public.diary_library_likes (
    item_id uuid not null references public.diary_library (id) on delete cascade,
    user_id uuid not null default auth.uid() references public.diary_profiles (id) on delete cascade,
    created_at timestamptz not null default now(),
    primary key (item_id, user_id)
);

alter table public.diary_library_likes enable row level security;

create policy "Hearts on items you can see" on public.diary_library_likes
    for select to authenticated
    using (exists (select 1 from public.diary_library l where l.id = item_id));
create policy "Heart items you can see" on public.diary_library_likes
    for insert to authenticated
    with check (user_id = (select auth.uid()) and exists (select 1 from public.diary_library l where l.id = item_id));
create policy "Take back your heart" on public.diary_library_likes
    for delete to authenticated using (user_id = (select auth.uid()));

grant select, delete on public.diary_library_likes to authenticated;
grant insert (item_id) on public.diary_library_likes to authenticated;

-- Read counts: each reader counts once; only the total is public
create table private.diary_library_reads (
    item_id uuid not null references public.diary_library (id) on delete cascade,
    user_id uuid not null references public.diary_profiles (id) on delete cascade,
    primary key (item_id, user_id)
);

create function public.diary_library_read(p_item uuid)
returns integer
language plpgsql security definer
set search_path = ''
as $$
declare
    me uuid := auth.uid();
    visible boolean;
    total integer;
begin
    select exists (
        select 1 from public.diary_library l
        where l.id = p_item and (l.visibility = 'public' or l.author = me or private.diary_are_friends(l.author, me))
    ) into visible;
    if me is null or not visible then
        raise exception 'Not found';
    end if;
    insert into private.diary_library_reads (item_id, user_id) values (p_item, me) on conflict do nothing;
    if found then
        update public.diary_library set reads = reads + 1 where id = p_item returning reads into total;
    else
        select reads into total from public.diary_library where id = p_item;
    end if;
    return total;
end;
$$;

revoke execute on function public.diary_library_read(uuid) from public, anon;
grant execute on function public.diary_library_read(uuid) to authenticated;

-- Save books to your shelf with the existing saved-items list
alter table public.diary_saved_items drop constraint diary_saved_items_kind_check;
alter table public.diary_saved_items add constraint diary_saved_items_kind_check check (kind in ('entry', 'reel', 'book'));

-- Files and covers live at <author>/<random>.<ext>
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('diary-library', 'diary-library', false, 52428800,
    array['application/pdf', 'application/epub+zip', 'image/jpeg', 'image/png', 'image/webp']);

create policy "Diary: upload your own library files" on storage.objects
    for insert to authenticated
    with check (bucket_id = 'diary-library' and private.diary_chat_path_part(name, 1) = (select auth.uid()));
create policy "Diary: read library files you can see" on storage.objects
    for select to authenticated
    using (
        bucket_id = 'diary-library'
        and (
            private.diary_chat_path_part(name, 1) = (select auth.uid())
            or exists (select 1 from public.diary_library l where l.file_path = name or l.cover_path = name)
        )
    );
create policy "Diary: delete your own library files" on storage.objects
    for delete to authenticated
    using (bucket_id = 'diary-library' and private.diary_chat_path_part(name, 1) = (select auth.uid()));

-- Someone hearted your writing
alter table public.diary_notifications drop constraint diary_notifications_type_check;
alter table public.diary_notifications add constraint diary_notifications_type_check check (type in (
    'friend_request', 'friend_accepted', 'entry_like', 'entry_comment',
    'post_like', 'post_comment', 'community_post', 'community_join', 'call_started', 'missed_call',
    'entry_repost', 'reel_like', 'reel_comment', 'library_like'));

create function private.diary_on_library_like()
returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
    l public.diary_library;
begin
    select * into l from public.diary_library where id = new.item_id;
    perform private.diary_notify(l.author, new.user_id, 'library_like',
        jsonb_build_object('item_id', l.id, 'snippet', private.diary_snippet(l.title, 60)));
    return new;
end;
$$;

revoke execute on function private.diary_on_library_like() from public, anon, authenticated;

create trigger diary_notify_library_like
    after insert on public.diary_library_likes
    for each row execute function private.diary_on_library_like();
