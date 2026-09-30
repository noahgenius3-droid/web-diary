-- Reshare a reel: it shows up for your friends too (with "reshared by you"), even if they aren't
-- friends with whoever made it. Blocks always win. You can only reshare reels you can see, never your own.
create table if not exists public.diary_reel_reshares (
    reel_id uuid not null references public.diary_reels(id) on delete cascade,
    user_id uuid not null references public.diary_profiles(id) on delete cascade default auth.uid(),
    created_at timestamptz not null default now(),
    primary key (reel_id, user_id)
);
create index if not exists diary_reel_reshares_user on public.diary_reel_reshares (user_id);
alter table public.diary_reel_reshares enable row level security;

-- Who has reshared a reel you can see (you, or your friends)
create or replace function private.diary_reel_reshared_for(p_reel uuid, p_user uuid)
returns boolean
language sql
stable
security definer
set search_path to ''
as $$
    select exists (
        select 1 from public.diary_reel_reshares x
        where x.reel_id = p_reel and (x.user_id = p_user or private.diary_are_friends(x.user_id, p_user))
    );
$$;

drop policy if exists "Friends see reels" on public.diary_reels;
create policy "Friends see reels" on public.diary_reels
    for select to authenticated
    using (
        author = (select auth.uid())
        or private.diary_are_friends(author, (select auth.uid()))
        or (private.diary_reel_reshared_for(id, (select auth.uid())) and not private.diary_blocked(author, (select auth.uid())))
    );

create policy "See reshares of reels you can see" on public.diary_reel_reshares
    for select to authenticated
    using (exists (select 1 from public.diary_reels r where r.id = reel_id));
create policy "Reshare reels you can see" on public.diary_reel_reshares
    for insert to authenticated
    with check (
        user_id = (select auth.uid())
        and coalesce(((select auth.jwt()) ->> 'is_anonymous')::boolean, false) = false
        and exists (select 1 from public.diary_reels r where r.id = reel_id and r.author <> (select auth.uid()))
    );
create policy "Undo your reshare" on public.diary_reel_reshares
    for delete to authenticated
    using (user_id = (select auth.uid()));
grant select, insert, delete on public.diary_reel_reshares to authenticated;
