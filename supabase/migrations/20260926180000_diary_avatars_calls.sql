-- Profile pictures, and authorization for voice-call signalling over Realtime private channels.

-- ---------- Profile pictures ----------
alter table public.diary_profiles
    add column avatar_path text check (avatar_path is null or char_length(avatar_path) <= 200);

grant update (avatar_path) on public.diary_profiles to authenticated;

-- Avatars are shown to every signed-in user (like names), so the bucket is public-read.
-- Objects live at <user id>/<random>.jpg and only the owner can write them.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('diary-avatars', 'diary-avatars', true, 2097152, array['image/jpeg', 'image/png', 'image/webp']);

create policy "Diary: upload your own avatar" on storage.objects
    for insert to authenticated
    with check (bucket_id = 'diary-avatars' and private.diary_chat_path_part(name, 1) = (select auth.uid()));
create policy "Diary: delete your own avatar" on storage.objects
    for delete to authenticated
    using (bucket_id = 'diary-avatars' and private.diary_chat_path_part(name, 1) = (select auth.uid()));

-- Suggestions now carry the avatar too
drop function public.diary_friend_suggestions();
create function public.diary_friend_suggestions()
returns table (id uuid, username text, display_name text, avatar_path text, mutual integer)
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
    select p.id, p.username, p.display_name, p.avatar_path, coalesce(fof.mutual, 0)
    from public.diary_profiles p
    cross join me
    left join fof on fof.candidate = p.id
    where p.id <> me.uid and p.id not in (select other from connected)
    order by coalesce(fof.mutual, 0) desc, p.created_at desc
    limit 5;
$$;

revoke execute on function public.diary_friend_suggestions() from public, anon;
grant execute on function public.diary_friend_suggestions() to authenticated;

-- ---------- Call signalling (Realtime private channels) ----------
-- Topics:
--   diary_call:c:<community id>        group call — community members only
--   diary_call:d:<user id>:<user id>   one-to-one call — only those two people
--   diary_ring:<user id>               incoming-call ring — only that user listens;
--                                      friends or fellow community members may ring
create function private.diary_can_reach(target uuid, caller uuid)
returns boolean
language sql stable security definer
set search_path = ''
as $$
    select private.diary_are_friends(target, caller)
        or exists (
            select 1 from public.diary_community_members a
            join public.diary_community_members b on b.community_id = a.community_id
            where a.user_id = target and b.user_id = caller
        );
$$;

create function private.diary_topic_allowed(topic text, sending boolean)
returns boolean
language plpgsql stable security definer
set search_path = ''
as $$
declare
    parts text[] := string_to_array(topic, ':');
    me uuid := auth.uid();
begin
    if me is null or parts is null then
        return false;
    end if;
    if parts[1] = 'diary_call' and parts[2] = 'c' and array_length(parts, 1) = 3 then
        return private.diary_is_member(parts[3]::uuid, me);
    end if;
    if parts[1] = 'diary_call' and parts[2] = 'd' and array_length(parts, 1) = 4 then
        return me::text in (parts[3], parts[4]);
    end if;
    if parts[1] = 'diary_ring' and array_length(parts, 1) = 2 then
        if sending then
            return private.diary_can_reach(parts[2]::uuid, me);
        end if;
        return parts[2] = me::text;
    end if;
    return false;
exception when others then
    return false; -- malformed ids
end;
$$;

revoke execute on function private.diary_can_reach(uuid, uuid) from public, anon;
revoke execute on function private.diary_topic_allowed(text, boolean) from public, anon;
grant execute on function private.diary_can_reach(uuid, uuid) to authenticated;
grant execute on function private.diary_topic_allowed(text, boolean) to authenticated;

create policy "Diary calls: receive on allowed topics" on realtime.messages
    for select to authenticated
    using (private.diary_topic_allowed((select realtime.topic()), false));

create policy "Diary calls: send on allowed topics" on realtime.messages
    for insert to authenticated
    with check (private.diary_topic_allowed((select realtime.topic()), true));
