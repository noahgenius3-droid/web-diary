-- Feed redesign: photos on shared entries (private bucket readable by friends) and friend suggestions.

alter table public.diary_shared_entries
    add column photos jsonb not null default '[]'::jsonb
        check (jsonb_typeof(photos) = 'array' and jsonb_array_length(photos) <= 10);

-- Objects live at <author id>/<entry local id>/<attachment id>.<ext>
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('diary-feed', 'diary-feed', false, 10485760, array['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

create policy "Diary: upload your own feed photos" on storage.objects
    for insert to authenticated
    with check (bucket_id = 'diary-feed' and private.diary_chat_path_part(name, 1) = (select auth.uid()));

create policy "Diary: friends can see feed photos" on storage.objects
    for select to authenticated
    using (
        bucket_id = 'diary-feed'
        and (
            private.diary_chat_path_part(name, 1) = (select auth.uid())
            or private.diary_are_friends(private.diary_chat_path_part(name, 1), (select auth.uid()))
        )
    );

create policy "Diary: delete your own feed photos" on storage.objects
    for delete to authenticated
    using (bucket_id = 'diary-feed' and private.diary_chat_path_part(name, 1) = (select auth.uid()));

-- Friends of friends first, then newer members, never people you're already connected with.
create function public.diary_friend_suggestions()
returns table (id uuid, username text, display_name text, mutual integer)
language sql stable security definer
set search_path = ''
as $$
    with me as (select auth.uid() as uid),
    connected as (
        select case when f.requester = me.uid then f.addressee else f.requester end as other
        from public.diary_friendships f, me
        where me.uid in (f.requester, f.addressee)
    ),
    my_friends as (
        select case when f.requester = me.uid then f.addressee else f.requester end as friend
        from public.diary_friendships f, me
        where f.status = 'accepted' and me.uid in (f.requester, f.addressee)
    ),
    fof as (
        select case when f.requester = mf.friend then f.addressee else f.requester end as candidate, count(*)::int as mutual
        from public.diary_friendships f
        join my_friends mf on mf.friend in (f.requester, f.addressee)
        where f.status = 'accepted'
        group by 1
    )
    select p.id, p.username, p.display_name, coalesce(fof.mutual, 0)
    from public.diary_profiles p
    cross join me
    left join fof on fof.candidate = p.id
    where p.id <> me.uid and p.id not in (select other from connected)
    order by coalesce(fof.mutual, 0) desc, p.created_at desc
    limit 5;
$$;

revoke execute on function public.diary_friend_suggestions() from public, anon;
grant execute on function public.diary_friend_suggestions() to authenticated;
