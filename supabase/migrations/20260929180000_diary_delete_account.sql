-- Settings → Delete account. Removes the signed-in user; their profile, posts, messages, reels, stories,
-- library items, likes and memberships go with it through ON DELETE CASCADE.
create function public.diary_delete_account()
returns void
language plpgsql security definer
set search_path = ''
as $$
declare
    me uuid := auth.uid();
begin
    if me is null then
        raise exception 'Not signed in';
    end if;
    delete from auth.users where id = me;
end;
$$;

revoke execute on function public.diary_delete_account() from public, anon;
grant execute on function public.diary_delete_account() to authenticated;
