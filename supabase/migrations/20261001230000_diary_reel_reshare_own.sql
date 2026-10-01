-- You can reshare your own reels too (to bring them back up for your friends), as well as other people's
drop policy if exists "Reshare reels you can see" on public.diary_reel_reshares;
create policy "Reshare reels you can see" on public.diary_reel_reshares
    for insert to authenticated
    with check (
        user_id = (select auth.uid())
        and coalesce(((select auth.jwt()) ->> 'is_anonymous')::boolean, false) = false
        and exists (select 1 from public.diary_reels r where r.id = reel_id)
    );
