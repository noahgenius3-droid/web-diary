-- See someone's friends from their profile. Same privacy rule as their followers / following lists
-- (Settings → Privacy → who can see my numbers and lists); blocked people never appear.
-- "friend" means they're also your friend (a mutual friend), listed first.
create or replace function public.diary_friends_list(p_user uuid, p_limit integer default 300)
returns table(id uuid, username text, display_name text, avatar_path text, i_follow boolean, friend boolean)
language sql
stable
security definer
set search_path to ''
as $$
    select p.id, p.username, p.display_name,
        case when coalesce(pr.photo_visibility, 'everyone') = 'everyone' or private.diary_are_friends(p.id, auth.uid()) or p.id = auth.uid() then p.avatar_path end,
        exists (select 1 from public.diary_follows x where x.follower = auth.uid() and x.followee = p.id),
        private.diary_are_friends(p.id, auth.uid())
    from public.diary_friendships f
    join public.diary_profiles p on p.id = case when f.requester = p_user then f.addressee else f.requester end
    left join public.diary_presence pr on pr.user_id = p.id
    where auth.uid() is not null
      and f.status = 'accepted'
      and p_user in (f.requester, f.addressee)
      and private.diary_can_see(p_user, auth.uid(), 'stats')
      and not private.diary_blocked(p.id, auth.uid())
    order by private.diary_are_friends(p.id, auth.uid()) desc, p.display_name
    limit least(greatest(coalesce(p_limit, 300), 1), 500);
$$;
revoke all on function public.diary_friends_list(uuid, integer) from public, anon;
grant execute on function public.diary_friends_list(uuid, integer) to authenticated;
