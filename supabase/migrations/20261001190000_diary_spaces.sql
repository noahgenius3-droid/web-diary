-- Spaces: live audio rooms (like Clubhouse). Anyone can host rooms — as many as they like — and open them live.
-- A room has a stage (the host, co-hosts and speakers) and an audience of listeners who can raise a hand.
-- Audio flows directly between browsers; this schema is the source of truth for who is allowed to speak.

create table if not exists public.diary_spaces (
    id uuid primary key default gen_random_uuid(),
    host uuid not null references public.diary_profiles(id) on delete cascade,
    title text not null check (length(btrim(title)) between 1 and 80),
    about text check (about is null or length(about) <= 300),
    topic text check (topic is null or length(topic) <= 30),
    visibility text not null default 'public' check (visibility in ('public', 'circle')),
    theme text not null default 'violet' check (theme in ('violet', 'sunset', 'ocean', 'forest', 'night')),
    scheduled_for timestamptz,
    live_since timestamptz,
    host_seen_at timestamptz,
    last_notified_at timestamptz,
    created_at timestamptz not null default now()
);
create index if not exists diary_spaces_host on public.diary_spaces (host);
create index if not exists diary_spaces_live on public.diary_spaces (live_since) where live_since is not null;

create table if not exists public.diary_space_roles (
    space_id uuid not null references public.diary_spaces(id) on delete cascade,
    user_id uuid not null references public.diary_profiles(id) on delete cascade,
    role text not null check (role in ('cohost', 'speaker')),
    primary key (space_id, user_id)
);

create table if not exists public.diary_space_bans (
    space_id uuid not null references public.diary_spaces(id) on delete cascade,
    user_id uuid not null references public.diary_profiles(id) on delete cascade,
    primary key (space_id, user_id)
);

-- Who's in the room right now (a heartbeat), so Explore can show how many are listening
create table if not exists public.diary_space_presence (
    space_id uuid not null references public.diary_spaces(id) on delete cascade,
    user_id uuid not null references public.diary_profiles(id) on delete cascade,
    seen_at timestamptz not null default now(),
    primary key (space_id, user_id)
);

alter table public.diary_spaces enable row level security;
alter table public.diary_space_roles enable row level security;
alter table public.diary_space_bans enable row level security;
alter table public.diary_space_presence enable row level security;
-- Everything goes through the functions below
revoke all on public.diary_spaces, public.diary_space_roles, public.diary_space_bans, public.diary_space_presence from anon, authenticated;

-- Can this person see (and so join) this room?
create or replace function private.diary_space_visible(p_space uuid, p_user uuid)
returns boolean
language sql
stable
security definer
set search_path to ''
as $$
    select exists (
        select 1 from public.diary_spaces sp
        where sp.id = p_space
          and not private.diary_blocked(sp.host, p_user)
          and not exists (select 1 from public.diary_space_bans b where b.space_id = sp.id and b.user_id = p_user)
          and (sp.host = p_user or sp.visibility = 'public'
               or private.diary_are_friends(sp.host, p_user) or private.diary_is_follower(p_user, sp.host))
    );
$$;

-- A room counts as live while its host or a co-host has been in it in the last 3 minutes
create or replace function private.diary_space_is_live(sp public.diary_spaces)
returns boolean
language sql
stable
set search_path to ''
as $$
    select sp.live_since is not null and sp.host_seen_at > now() - interval '3 minutes';
$$;

create or replace function private.diary_space_card(sp public.diary_spaces, p_me uuid)
returns jsonb
language sql
stable
security definer
set search_path to ''
as $$
    select jsonb_build_object(
        'id', sp.id, 'host', sp.host, 'title', sp.title, 'about', sp.about, 'topic', sp.topic,
        'visibility', sp.visibility, 'theme', sp.theme, 'scheduled_for', sp.scheduled_for,
        'live', private.diary_space_is_live(sp), 'live_since', sp.live_since, 'created_at', sp.created_at,
        'mine', sp.host = p_me,
        'host_profile', (select jsonb_build_object('id', p.id, 'username', p.username, 'display_name', p.display_name, 'avatar_path', p.avatar_path)
                         from public.diary_profiles p where p.id = sp.host),
        'listening', (select count(*) from public.diary_space_presence pr where pr.space_id = sp.id and pr.seen_at > now() - interval '60 seconds'),
        'stage', coalesce((
            select jsonb_agg(jsonb_build_object('id', p.id, 'display_name', p.display_name, 'avatar_path', p.avatar_path) order by r.role, p.display_name)
            from public.diary_space_roles r join public.diary_profiles p on p.id = r.user_id
            where r.space_id = sp.id
        ), '[]'::jsonb)
    );
$$;

-- Create a room, or edit one of yours
create or replace function public.diary_space_save(p_id uuid, p_title text, p_about text, p_topic text,
                                                   p_visibility text, p_theme text, p_scheduled_for timestamptz)
returns uuid
language plpgsql
security definer
set search_path to ''
as $$
declare
    me uuid := auth.uid();
    v_id uuid;
begin
    perform private.diary_require_member();
    if me is null then raise exception 'Not signed in'; end if;
    if length(btrim(coalesce(p_title, ''))) = 0 then raise exception 'Give your room a name'; end if;
    if p_id is null then
        if (select count(*) from public.diary_spaces where host = me) >= 20 then
            raise exception 'You can host up to 20 rooms — delete one to make another';
        end if;
        insert into public.diary_spaces (host, title, about, topic, visibility, theme, scheduled_for)
        values (me, left(btrim(p_title), 80), nullif(left(btrim(coalesce(p_about, '')), 300), ''), nullif(left(btrim(coalesce(p_topic, '')), 30), ''),
                coalesce(p_visibility, 'public'), coalesce(p_theme, 'violet'), p_scheduled_for)
        returning id into v_id;
        return v_id;
    end if;
    update public.diary_spaces set
        title = left(btrim(p_title), 80),
        about = nullif(left(btrim(coalesce(p_about, '')), 300), ''),
        topic = nullif(left(btrim(coalesce(p_topic, '')), 30), ''),
        visibility = coalesce(p_visibility, visibility),
        theme = coalesce(p_theme, theme),
        scheduled_for = p_scheduled_for
    where id = p_id and host = me
    returning id into v_id;
    if v_id is null then raise exception 'That room isn’t yours'; end if;
    return v_id;
end;
$$;

create or replace function public.diary_space_delete(p_id uuid)
returns void
language plpgsql
security definer
set search_path to ''
as $$
begin
    delete from public.diary_spaces where id = p_id and host = auth.uid();
    if not found then raise exception 'That room isn’t yours'; end if;
end;
$$;

-- The host opens the room: it goes live and friends/followers get a heads-up (at most once every 30 minutes)
create or replace function public.diary_space_open(p_id uuid)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $$
declare
    me uuid := auth.uid();
    sp public.diary_spaces;
    person uuid;
begin
    perform private.diary_require_member();
    select * into sp from public.diary_spaces where id = p_id;
    if not found or sp.host <> me then raise exception 'Only the host can open this room'; end if;
    if not private.diary_space_is_live(sp) then
        delete from public.diary_space_presence where space_id = sp.id;
        delete from public.diary_space_roles where space_id = sp.id and role = 'speaker';
        update public.diary_spaces set live_since = now(), host_seen_at = now() where id = sp.id returning * into sp;
    else
        update public.diary_spaces set host_seen_at = now() where id = sp.id returning * into sp;
    end if;
    if sp.last_notified_at is null or sp.last_notified_at < now() - interval '30 minutes' then
        update public.diary_spaces set last_notified_at = now() where id = sp.id;
        for person in
            select case when f.requester = me then f.addressee else f.requester end
            from public.diary_friendships f
            where f.status = 'accepted' and me in (f.requester, f.addressee)
            union
            select fo.follower from public.diary_follows fo where fo.followee = me
        loop
            perform private.diary_notify(person, me, 'space_live',
                jsonb_build_object('space_id', sp.id, 'snippet', left(sp.title, 60)));
        end loop;
    end if;
    return private.diary_space_card(sp, me);
end;
$$;

-- End the room for everyone (host or co-host)
create or replace function public.diary_space_end(p_id uuid)
returns void
language plpgsql
security definer
set search_path to ''
as $$
declare
    me uuid := auth.uid();
begin
    if not exists (select 1 from public.diary_spaces sp where sp.id = p_id and (sp.host = me
                   or exists (select 1 from public.diary_space_roles r where r.space_id = sp.id and r.user_id = me and r.role = 'cohost'))) then
        raise exception 'Only a host can end this room';
    end if;
    update public.diary_spaces set live_since = null, host_seen_at = null where id = p_id;
    delete from public.diary_space_presence where space_id = p_id;
    delete from public.diary_space_roles where space_id = p_id and role = 'speaker';
    delete from public.diary_notifications where type = 'space_live' and data->>'space_id' = p_id::text;
end;
$$;

-- The room as the person asking sees it, plus the stage line-up. Doubles as the in-room heartbeat (p_ping).
create or replace function public.diary_space_state(p_id uuid, p_ping boolean default false)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $$
declare
    me uuid := auth.uid();
    sp public.diary_spaces;
    v_role text;
begin
    if me is null then raise exception 'Not signed in'; end if;
    select * into sp from public.diary_spaces where id = p_id;
    if not found then return jsonb_build_object('gone', true); end if;
    if exists (select 1 from public.diary_space_bans where space_id = p_id and user_id = me) then
        return jsonb_build_object('banned', true);
    end if;
    if not private.diary_space_visible(p_id, me) then return jsonb_build_object('gone', true); end if;
    v_role := case when sp.host = me then 'host' else (select role from public.diary_space_roles where space_id = p_id and user_id = me) end;
    if p_ping and private.diary_space_is_live(sp) then
        insert into public.diary_space_presence (space_id, user_id, seen_at) values (p_id, me, now())
        on conflict (space_id, user_id) do update set seen_at = now();
        if v_role in ('host', 'cohost') then
            update public.diary_spaces set host_seen_at = now() where id = p_id returning * into sp;
        end if;
    end if;
    return private.diary_space_card(sp, me) || jsonb_build_object(
        'role', coalesce(v_role, 'listener'),
        'roles', coalesce((select jsonb_object_agg(r.user_id, r.role) from public.diary_space_roles r where r.space_id = p_id), '{}'::jsonb)
    );
end;
$$;

-- Leaving: drop off the listener count straight away
create or replace function public.diary_space_leave(p_id uuid)
returns void
language sql
security definer
set search_path to ''
as $$
    delete from public.diary_space_presence where space_id = p_id and user_id = auth.uid();
$$;

-- Bring someone up to speak, make them a co-host, or move them back to the audience (p_role null).
-- Hosts and co-hosts manage speakers; only the host makes co-hosts. Anyone may step down themselves.
create or replace function public.diary_space_set_role(p_id uuid, p_user uuid, p_role text)
returns void
language plpgsql
security definer
set search_path to ''
as $$
declare
    me uuid := auth.uid();
    sp public.diary_spaces;
    my_role text;
    their_role text;
begin
    select * into sp from public.diary_spaces where id = p_id;
    if not found then raise exception 'That room has closed'; end if;
    if p_user = sp.host then raise exception 'The host is always on stage'; end if;
    my_role := case when sp.host = me then 'host' else (select role from public.diary_space_roles where space_id = p_id and user_id = me) end;
    their_role := (select role from public.diary_space_roles where space_id = p_id and user_id = p_user);
    if p_role is not null and p_role not in ('cohost', 'speaker') then raise exception 'Unknown role'; end if;
    if p_user = me and p_role is null then
        null; -- stepping down is always allowed
    elsif my_role = 'host' then
        null;
    elsif my_role = 'cohost' and coalesce(p_role, 'speaker') = 'speaker' and coalesce(their_role, 'speaker') = 'speaker' then
        null;
    else
        raise exception 'Only the host can do that';
    end if;
    if p_role is null then
        delete from public.diary_space_roles where space_id = p_id and user_id = p_user;
    else
        if not private.diary_space_visible(p_id, p_user) then raise exception 'They can’t join this room'; end if;
        insert into public.diary_space_roles (space_id, user_id, role) values (p_id, p_user, p_role)
        on conflict (space_id, user_id) do update set role = excluded.role;
    end if;
end;
$$;

-- Remove someone from the room; they can't come back into it
create or replace function public.diary_space_remove(p_id uuid, p_user uuid)
returns void
language plpgsql
security definer
set search_path to ''
as $$
declare
    me uuid := auth.uid();
    sp public.diary_spaces;
begin
    select * into sp from public.diary_spaces where id = p_id;
    if not found then raise exception 'That room has closed'; end if;
    if p_user = sp.host or p_user = me then raise exception 'You can’t remove yourself or the host'; end if;
    if not (sp.host = me or (exists (select 1 from public.diary_space_roles where space_id = p_id and user_id = me and role = 'cohost')
                            and not exists (select 1 from public.diary_space_roles where space_id = p_id and user_id = p_user and role = 'cohost'))) then
        raise exception 'Only a host can remove people';
    end if;
    delete from public.diary_space_roles where space_id = p_id and user_id = p_user;
    delete from public.diary_space_presence where space_id = p_id and user_id = p_user;
    insert into public.diary_space_bans (space_id, user_id) values (p_id, p_user) on conflict do nothing;
end;
$$;

-- Rooms for Explore and the Spaces page: live now, coming up, and your own
create or replace function public.diary_spaces_list()
returns jsonb
language plpgsql
stable
security definer
set search_path to ''
as $$
declare
    me uuid := auth.uid();
begin
    if me is null then return jsonb_build_object('live', '[]'::jsonb, 'upcoming', '[]'::jsonb, 'mine', '[]'::jsonb); end if;
    return jsonb_build_object(
        'live', coalesce((
            select jsonb_agg(c order by (c->>'listening')::int desc, c->>'live_since' desc)
            from (select private.diary_space_card(sp, me) c from public.diary_spaces sp
                  where private.diary_space_is_live(sp) and private.diary_space_visible(sp.id, me) limit 60) x
        ), '[]'::jsonb),
        'upcoming', coalesce((
            select jsonb_agg(c order by c->>'scheduled_for')
            from (select private.diary_space_card(sp, me) c from public.diary_spaces sp
                  where not private.diary_space_is_live(sp) and sp.scheduled_for between now() - interval '1 hour' and now() + interval '14 days'
                    and private.diary_space_visible(sp.id, me) limit 40) x
        ), '[]'::jsonb),
        'mine', coalesce((
            select jsonb_agg(private.diary_space_card(sp, me) order by sp.created_at desc)
            from public.diary_spaces sp where sp.host = me
        ), '[]'::jsonb)
    );
end;
$$;

revoke all on function public.diary_space_save(uuid, text, text, text, text, text, timestamptz), public.diary_space_delete(uuid),
    public.diary_space_open(uuid), public.diary_space_end(uuid), public.diary_space_state(uuid, boolean), public.diary_space_leave(uuid),
    public.diary_space_set_role(uuid, uuid, text), public.diary_space_remove(uuid, uuid), public.diary_spaces_list() from public, anon;
grant execute on function public.diary_space_save(uuid, text, text, text, text, text, timestamptz), public.diary_space_delete(uuid),
    public.diary_space_open(uuid), public.diary_space_end(uuid), public.diary_space_state(uuid, boolean), public.diary_space_leave(uuid),
    public.diary_space_set_role(uuid, uuid, text), public.diary_space_remove(uuid, uuid), public.diary_spaces_list() to authenticated;

-- "X opened a room" notifications (and their push)
alter table public.diary_notifications drop constraint diary_notifications_type_check;
alter table public.diary_notifications add constraint diary_notifications_type_check check (type = any (array[
    'friend_request', 'friend_accepted', 'entry_like', 'entry_comment', 'post_like', 'post_comment', 'community_post', 'community_join',
    'call_started', 'missed_call', 'entry_repost', 'reel_like', 'reel_comment', 'library_like', 'live_started', 'new_follower',
    'book_request', 'book_request_update', 'book_message', 'entry_reaction', 'story_reaction', 'mention', 'reply', 'new_login',
    'post_activity', 'scheduled_published', 'scheduled_failed', 'trivia_rank', 'badge_earned', 'announcement', 'verification_update',
    'game_invite', 'game_turn', 'game_over', 'comment_reply', 'referral_joined', 'tagged', 'space_live'
]));

create or replace function private.diary_push_notification()
returns trigger
language plpgsql
security definer
set search_path to ''
as $function$
declare
    cfg private.diary_push_config;
begin
    if new.type not in ('friend_request', 'friend_accepted', 'new_follower', 'live_started', 'mention', 'reply', 'new_login', 'call_started',
                        'scheduled_published', 'scheduled_failed', 'post_activity', 'game_invite', 'game_turn', 'game_over', 'comment_reply',
                        'referral_joined', 'tagged', 'announcement', 'space_live') then
        return new;
    end if;
    if not exists (select 1 from public.diary_push_subscriptions where user_id = new.user_id) then
        return new;
    end if;
    select * into cfg from private.diary_push_config where id;
    if not found then
        return new;
    end if;
    perform net.http_post(
        url := cfg.function_url,
        body := jsonb_build_object('notification_id', new.id),
        headers := jsonb_build_object('Content-Type', 'application/json', 'x-push-secret', cfg.trigger_secret),
        timeout_milliseconds := 8000
    );
    return new;
exception when others then
    return new;
end;
$function$;

-- The room's realtime channel (diary_space:<id>): open to everyone who can see the room while it's live
create or replace function private.diary_topic_allowed(topic text, sending boolean)
returns boolean
language plpgsql
stable security definer
set search_path to ''
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
        return me::text in (parts[3], parts[4]) and not private.diary_blocked(parts[3]::uuid, parts[4]::uuid);
    end if;
    if parts[1] = 'diary_ring' and array_length(parts, 1) = 2 then
        if sending then
            return private.diary_can_reach(parts[2]::uuid, me)
                and not private.diary_blocked(parts[2]::uuid, me)
                and coalesce((select allow_calls from public.diary_presence where user_id = parts[2]::uuid), 'friends') <> 'nobody';
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
    if parts[1] = 'diary_space' and array_length(parts, 1) = 2 then
        return exists (select 1 from public.diary_spaces sp where sp.id = parts[2]::uuid and sp.live_since is not null)
            and private.diary_space_visible(parts[2]::uuid, me);
    end if;
    return false;
exception when others then
    return false;
end;
$function$;
