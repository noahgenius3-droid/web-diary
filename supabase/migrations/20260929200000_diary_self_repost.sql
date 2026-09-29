-- Authors can reshare their own post: it comes back to the top of their friends' feeds as "Noah reposted".
-- Friends still need the author's permission (allow_reposts) and a friendship, as before.
drop policy "Repost friends' posts that allow it" on public.diary_reposts;

create policy "Repost your own posts, or friends' posts that allow it" on public.diary_reposts
    for insert to authenticated
    with check (
        user_id = (select auth.uid())
        and exists (
            select 1 from public.diary_shared_entries e
            where e.id = diary_reposts.entry_id
              and (
                  e.author = (select auth.uid())
                  or (e.allow_reposts and private.diary_are_friends(e.author, (select auth.uid())))
              )
        )
    );
