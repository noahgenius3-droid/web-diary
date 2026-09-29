-- Followers: a one-way "follow" that doesn't need approval (unlike friendship). Followers can watch your
-- live videos and get a notification when you go live, alongside your friends.

create table public.diary_follows (
    follower uuid not null default auth.uid() references public.diary_profiles (id) on delete cascade,
    followee uuid not null references public.diary_profiles (id) on delete cascade,
    created_at timestamptz not null default now(),
    primary key (follower, followee),
    constraint diary_follows_not_self check (follower <> followee)
);
create index diary_follows_followee on public.diary_follows (followee);

alter table public.diary_follows enable row level security;

-- You see who you follow and who follows you
create policy "See your follows and followers" on public.diary_follows
    for select to authenticated
    using (follower = (select auth.uid()) or followee = (select auth.uid()));
create policy "Follow people as yourself" on public.diary_follows
    for insert to authenticated
    with check (follower = (select auth.uid()));
-- Unfollow, or remove someone from your followers
create policy "Unfollow, or remove a follower" on public.diary_follows
    for delete to authenticated
    using (follower = (select auth.uid()) or followee = (select auth.uid()));

revoke all on public.diary_follows from anon, authenticated;
grant select, delete on public.diary_follows to authenticated;
grant insert (followee) on public.diary_follows to authenticated;

create function private.diary_is_follower(a uuid, b uuid)
returns boolean
language sql
stable security definer
set search_path = ''
as $$
    select exists (select 1 from public.diary_follows f where f.follower = a and f.followee = b);
$$;

-- Notifications: new followers, and "live now" goes to followers as well as friends
alter table public.diary_notifications drop constraint diary_notifications_type_check;
alter table public.diary_notifications add constraint diary_notifications_type_check check (type = any (array[
    'friend_request', 'friend_accepted', 'entry_like', 'entry_comment', 'post_like', 'post_comment',
    'community_post', 'community_join', 'call_started', 'missed_call', 'entry_repost', 'reel_like',
    'reel_comment', 'library_like', 'live_started', 'new_follower'
]));

create function private.diary_on_follow()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
    perform private.diary_notify(new.followee, new.follower, 'new_follower', '{}'::jsonb);
    return new;
end;
$$;

create trigger diary_notify_follow after insert on public.diary_follows
    for each row execute function private.diary_on_follow();

create or replace function private.diary_on_live_start()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
    person uuid;
begin
    for person in
        select case when f.requester = new.host then f.addressee else f.requester end
        from public.diary_friendships f
        where f.status = 'accepted' and new.host in (f.requester, f.addressee)
        union
        select fo.follower from public.diary_follows fo where fo.followee = new.host
    loop
        perform private.diary_notify(person, new.host, 'live_started',
            jsonb_build_object('stream_id', new.id, 'snippet', left(new.title, 60)));
    end loop;
    return new;
end;
$$;

-- Followers can find and watch the stream too
drop policy "Friends see your live streams" on public.diary_live_streams;
create policy "Friends and followers see your live streams" on public.diary_live_streams
    for select to authenticated
    using (
        host = (select auth.uid())
        or private.diary_are_friends(host, (select auth.uid()))
        or private.diary_is_follower((select auth.uid()), host)
    );

create or replace function private.diary_topic_allowed(topic text, sending boolean)
returns boolean
language plpgsql
stable security definer
set search_path = ''
as $function$
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
    if parts[1] = 'diary_dm' and array_length(parts, 1) = 3 then
        return me::text in (parts[2], parts[3])
            and private.diary_are_friends(parts[2]::uuid, parts[3]::uuid);
    end if;
    if parts[1] = 'diary_comm' and array_length(parts, 1) = 2 then
        return private.diary_is_member(parts[2]::uuid, me);
    end if;
    if parts[1] = 'diary_live' and array_length(parts, 1) = 2 then
        return exists (
            select 1 from public.diary_live_streams s
            where s.id = parts[2]::uuid and s.ended_at is null
              and (s.host = me or private.diary_are_friends(s.host, me) or private.diary_is_follower(me, s.host))
        );
    end if;
    return false;
exception when others then
    return false;
end;
$function$;
