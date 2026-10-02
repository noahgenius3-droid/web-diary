-- Push everywhere: calls, direct messages and new posts reach people even when Cordial is closed.
--
-- One delivery path for every alert: the database decides *whether* someone should be alerted (preferences,
-- blocks, mutes, deleted accounts, devices), then hands the event to the diary-push function, which builds the
-- message, deduplicates it (diary_push_log), sends it to each device and cleans up dead subscriptions.
--   • Activity (likes, comments, follows, posts, live, missed calls…) → diary_notifications → push
--   • Direct messages → a trigger on diary_messages → push (they are not activity items)
--   • Incoming calls → diary_call_invites (one row per ring) → high-priority push with Answer / Decline

-- ============================================================================
-- Devices: one row per browser/device with alerts on
-- ============================================================================
alter table public.diary_push_subscriptions add column if not exists device_id text check (char_length(device_id) <= 80);
alter table public.diary_push_subscriptions add column if not exists platform text check (char_length(platform) <= 40);
alter table public.diary_push_subscriptions add column if not exists browser text check (char_length(browser) <= 40);
alter table public.diary_push_subscriptions add column if not exists app_version text check (char_length(app_version) <= 40);
alter table public.diary_push_subscriptions add column if not exists permission text not null default 'granted' check (permission in ('granted', 'denied', 'default'));
alter table public.diary_push_subscriptions add column if not exists last_active timestamptz not null default now();
alter table public.diary_push_subscriptions add column if not exists updated_at timestamptz not null default now();
alter table public.diary_push_subscriptions add column if not exists failures int not null default 0;
alter table public.diary_push_subscriptions add column if not exists last_error text check (char_length(last_error) <= 300);

drop function if exists public.diary_save_push_subscription(text, text, text, text);
create or replace function public.diary_save_push_subscription(p_endpoint text, p_p256dh text, p_auth text, p_user_agent text default null,
    p_device_id text default null, p_platform text default null, p_browser text default null, p_app_version text default null,
    p_permission text default 'granted')
returns void language plpgsql security definer set search_path = '' as $$
begin
    if auth.uid() is null then raise exception 'Sign in first'; end if;
    -- A shared device moves between accounts: whoever is signed in now owns the subscription
    insert into public.diary_push_subscriptions (user_id, endpoint, p256dh, auth, user_agent, device_id, platform, browser, app_version, permission, last_active, updated_at, failures, last_error)
    values (auth.uid(), p_endpoint, p_p256dh, p_auth, left(p_user_agent, 300), left(p_device_id, 80), left(p_platform, 40), left(p_browser, 40), left(p_app_version, 40),
            coalesce(p_permission, 'granted'), now(), now(), 0, null)
    on conflict (endpoint) do update set user_id = auth.uid(), p256dh = excluded.p256dh, auth = excluded.auth, user_agent = excluded.user_agent,
        device_id = excluded.device_id, platform = excluded.platform, browser = excluded.browser, app_version = excluded.app_version,
        permission = excluded.permission, last_active = now(), updated_at = now(), failures = 0, last_error = null;
    -- The same device re-subscribed with a new endpoint: drop its old one so it isn't alerted twice
    if p_device_id is not null then
        delete from public.diary_push_subscriptions where user_id = auth.uid() and device_id = p_device_id and endpoint <> p_endpoint;
    end if;
end;
$$;
revoke all on function public.diary_save_push_subscription(text, text, text, text, text, text, text, text, text) from public, anon;
grant execute on function public.diary_save_push_subscription(text, text, text, text, text, text, text, text, text) to authenticated;

-- ============================================================================
-- Preferences: message previews (the categories live in diary_notification_prefs.muted)
-- ============================================================================
alter table public.diary_notification_prefs add column if not exists show_previews boolean not null default true;
grant insert (show_previews), update (show_previews) on public.diary_notification_prefs to authenticated;

-- Categories for every alert type (messages and calls are categories too)
create or replace function private.diary_notif_category(t text) returns text language sql immutable set search_path = '' as $$
    select case
        when t in ('entry_like', 'post_like', 'reel_like', 'library_like', 'entry_reaction', 'story_reaction', 'entry_repost') then 'reactions'
        when t in ('entry_comment', 'post_comment', 'reel_comment', 'post_activity', 'comment_reply') then 'comments'
        when t in ('mention', 'reply', 'tagged') then 'mentions'
        when t in ('new_follower', 'friend_request', 'friend_accepted', 'referral_joined') then 'people'
        when t in ('community_post', 'community_join', 'call_started') then 'groups'
        when t in ('live_started', 'space_live') then 'live'
        when t in ('new_post') then 'posts'
        when t in ('scheduled_published', 'scheduled_failed') then 'scheduled'
        when t in ('book_request', 'book_request_update', 'book_message') then 'market'
        when t in ('missed_call', 'call') then 'calls'
        when t in ('message') then 'messages'
        when t in ('trivia_rank', 'badge_earned', 'game_invite', 'game_turn', 'game_over') then 'games'
        else 'account'
    end;
$$;

-- Should this person get a device alert from this actor in this category? (blocks, deleted accounts,
-- muted categories, and whether they have any device to send to)
create or replace function private.diary_push_allowed(p_user uuid, p_actor uuid, p_category text) returns boolean
language sql stable security definer set search_path = '' as $$
    select p_user is not null
       and (p_actor is null or p_actor <> p_user)
       and (p_actor is null or not private.diary_blocked(p_user, p_actor))
       and (p_actor is null or exists (select 1 from public.diary_profiles where id = p_actor))
       and not exists (select 1 from public.diary_notification_prefs np where np.user_id = p_user and p_category <> 'account' and p_category = any (np.muted))
       and exists (select 1 from public.diary_push_subscriptions s where s.user_id = p_user and s.permission = 'granted');
$$;

-- Blocked people can't create notifications for each other at all (in-app or on devices)
create or replace function private.diary_notif_filter() returns trigger language plpgsql security definer set search_path = '' as $$
begin
    if new.actor is not null and new.actor <> new.user_id and private.diary_blocked(new.user_id, new.actor) then
        return null;
    end if;
    if private.diary_notif_category(new.type) <> 'account' and exists (
        select 1 from public.diary_notification_prefs p
        where p.user_id = new.user_id and private.diary_notif_category(new.type) = any (p.muted)) then
        return null;
    end if;
    return new;
end;
$$;

-- ============================================================================
-- Delivery log: one row per event, so retries and duplicate triggers never alert twice
-- ============================================================================
create table if not exists public.diary_push_log (
    dedup_key text primary key,
    user_id uuid,
    kind text not null,
    created_at timestamptz not null default now(),
    sent int not null default 0,
    failed int not null default 0,
    error text check (char_length(error) <= 300)
);
create index if not exists diary_push_log_time_idx on public.diary_push_log (created_at);
alter table public.diary_push_log enable row level security;
revoke all on public.diary_push_log from anon, authenticated;   -- written by the push function (service role) only

-- Hand an event to the push function (the one place that calls it)
create or replace function private.diary_push_dispatch(p_body jsonb) returns void language plpgsql security definer set search_path = '' as $$
declare cfg private.diary_push_config;
begin
    select * into cfg from private.diary_push_config where id;
    if not found then return; end if;
    perform net.http_post(
        url := cfg.function_url, body := p_body,
        headers := jsonb_build_object('Content-Type', 'application/json', 'x-push-secret', cfg.trigger_secret),
        timeout_milliseconds := 8000);
    -- Keep the log short
    if random() < 0.02 then delete from public.diary_push_log where created_at < now() - interval '7 days'; end if;
exception when others then
    null; -- a failed alert never blocks the action that caused it
end;
$$;

-- Activity notifications → push (now also comments and missed calls; blocks/prefs/devices checked first)
create or replace function private.diary_push_notification() returns trigger language plpgsql security definer set search_path = '' as $$
declare target text;
begin
    if new.type not in ('friend_request', 'friend_accepted', 'new_follower', 'live_started', 'mention', 'reply', 'new_login', 'call_started',
                        'scheduled_published', 'scheduled_failed', 'post_activity', 'game_invite', 'game_turn', 'game_over', 'comment_reply',
                        'referral_joined', 'tagged', 'announcement', 'space_live', 'support_reply', 'helpline_handoff',
                        'entry_like', 'entry_reaction', 'post_like', 'reel_like', 'new_post',
                        'entry_comment', 'post_comment', 'reel_comment', 'missed_call') then
        return new;
    end if;
    if not private.diary_push_allowed(new.user_id, new.actor, private.diary_notif_category(new.type)) then return new; end if;
    -- Likes: one alert per person per post per 10 minutes
    if new.type in ('entry_like', 'entry_reaction', 'post_like', 'reel_like') then
        target := coalesce(new.data->>'entry_id', new.data->>'entry', new.data->>'post_id', new.data->>'reel_id', '');
        if exists (select 1 from public.diary_notifications n
            where n.user_id = new.user_id and n.actor = new.actor and n.type = new.type and n.id <> new.id
              and coalesce(n.data->>'entry_id', n.data->>'entry', n.data->>'post_id', n.data->>'reel_id', '') = target
              and n.created_at > now() - interval '10 minutes') then
            return new;
        end if;
    end if;
    perform private.diary_push_dispatch(jsonb_build_object('notification_id', new.id));
    return new;
exception when others then
    return new;
end;
$$;

-- ============================================================================
-- Direct messages → push
-- ============================================================================
create or replace function private.diary_push_on_message() returns trigger language plpgsql security definer set search_path = '' as $$
begin
    if new.recipient is null or new.recipient = new.sender or new.deleted_at is not null then return new; end if;
    if not private.diary_push_allowed(new.recipient, new.sender, 'messages') then return new; end if;
    -- This chat is muted
    if exists (select 1 from public.diary_chat_prefs c where c.user_id = new.recipient and c.kind = 'dm' and c.peer = new.sender::text
               and c.muted_until is not null and c.muted_until > now()) then
        return new;
    end if;
    perform private.diary_push_dispatch(jsonb_build_object('event', 'message', 'id', new.id::text));
    return new;
exception when others then
    return new;
end;
$$;
drop trigger if exists diary_messages_push on public.diary_messages;
create trigger diary_messages_push after insert on public.diary_messages for each row execute function private.diary_push_on_message();

-- ============================================================================
-- Incoming calls: a ring the server knows about, so it can reach a closed app
-- ============================================================================
create table if not exists public.diary_call_invites (
    id uuid primary key default gen_random_uuid(),
    caller uuid not null references public.diary_profiles (id) on delete cascade,
    callee uuid not null references public.diary_profiles (id) on delete cascade,
    topic text not null check (char_length(topic) <= 120),
    video boolean not null default false,
    status text not null default 'ringing' check (status in ('ringing', 'answered', 'declined', 'missed', 'cancelled')),
    decline_token uuid not null default gen_random_uuid(),   -- lets the lock-screen "Decline" button work without signing in
    created_at timestamptz not null default now(),
    ended_at timestamptz
);
create index if not exists diary_call_invites_callee_idx on public.diary_call_invites (callee, created_at desc);
create index if not exists diary_call_invites_topic_idx on public.diary_call_invites (topic, created_at desc);
alter table public.diary_call_invites enable row level security;
revoke all on public.diary_call_invites from anon, authenticated;  -- only through the functions below

-- The caller starts ringing someone (alongside the realtime ring the open app already hears)
create or replace function public.diary_call_ring(p_callee uuid, p_topic text, p_video boolean default false) returns uuid
language plpgsql security definer set search_path = '' as $$
declare me uuid := auth.uid(); inv public.diary_call_invites;
begin
    if me is null then raise exception 'Sign in first'; end if;
    if p_callee is null or p_callee = me then return null; end if;
    -- The topic must be the private call between these two people
    if p_topic <> 'diary_call:d:' || least(me::text, p_callee::text) || ':' || greatest(me::text, p_callee::text) then raise exception 'Bad call'; end if;
    if private.diary_blocked(me, p_callee) then return null; end if;                                   -- silently: the caller just hears no answer
    if exists (select 1 from public.diary_presence where user_id = p_callee and allow_calls = 'nobody') then return null; end if;
    if (select count(*) from public.diary_call_invites where caller = me and created_at > now() - interval '1 minute') >= 10 then
        raise exception 'Too many calls — wait a moment';
    end if;
    -- Calling again replaces the earlier ring
    update public.diary_call_invites set status = 'cancelled', ended_at = now() where caller = me and callee = p_callee and status = 'ringing';
    insert into public.diary_call_invites (caller, callee, topic, video) values (me, p_callee, p_topic, coalesce(p_video, false)) returning * into inv;
    if private.diary_push_allowed(p_callee, me, 'calls') then
        perform private.diary_push_dispatch(jsonb_build_object('event', 'call', 'id', inv.id::text));
    end if;
    return inv.id;
end;
$$;

-- Either side ends the ring: answered / declined (callee), or missed (caller hung up or nobody answered)
create or replace function public.diary_call_ring_end(p_topic text, p_status text) returns void
language plpgsql security definer set search_path = '' as $$
declare me uuid := auth.uid(); inv public.diary_call_invites;
begin
    if me is null or p_status not in ('answered', 'declined', 'missed') then return; end if;
    select * into inv from public.diary_call_invites
    where topic = p_topic and status = 'ringing' and (caller = me or callee = me) order by created_at desc limit 1 for update;
    if inv.id is null then return; end if;
    if p_status in ('answered', 'declined') and me <> inv.callee then return; end if;
    if p_status = 'missed' and me <> inv.caller then return; end if;
    update public.diary_call_invites set status = p_status, ended_at = now() where id = inv.id;
    if p_status = 'missed' then
        -- Replaces the ringing alert on their devices with "Missed call" (same tag), and shows in their activity
        insert into public.diary_notifications (user_id, actor, type, data)
        values (inv.callee, inv.caller, 'missed_call', jsonb_build_object('invite', inv.id, 'video', inv.video));
    end if;
end;
$$;

-- Lock-screen "Decline": proven by the token sent only to the callee's devices (no sign-in needed)
create or replace function public.diary_call_decline(p_invite uuid, p_token uuid) returns boolean
language plpgsql security definer set search_path = '' as $$
declare inv public.diary_call_invites;
begin
    update public.diary_call_invites set status = 'declined', ended_at = now()
    where id = p_invite and decline_token = p_token and status = 'ringing' and created_at > now() - interval '2 minutes'
    returning * into inv;
    if inv.id is null then return false; end if;
    -- Tell the caller's app straight away (the same event the callee's app sends when it's open)
    perform realtime.send(jsonb_build_object('from', inv.callee), 'decline', 'diary_ring:' || inv.caller, true);
    return true;
end;
$$;

-- Opening Cordial from the call alert: is it still ringing, and who is it?
create or replace function public.diary_call_invite_get(p_invite uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
    select jsonb_build_object('id', i.id, 'topic', i.topic, 'video', i.video, 'from', i.caller,
        'status', case when i.status = 'ringing' and i.created_at < now() - interval '60 seconds' then 'missed' else i.status end,
        'name', p.display_name, 'avatar_path', p.avatar_path)
    from public.diary_call_invites i join public.diary_profiles p on p.id = i.caller
    where i.id = p_invite and i.callee = auth.uid();
$$;
revoke all on function public.diary_call_ring(uuid, text, boolean), public.diary_call_ring_end(text, text), public.diary_call_invite_get(uuid),
    public.diary_call_decline(uuid, uuid) from public;
grant execute on function public.diary_call_ring(uuid, text, boolean), public.diary_call_ring_end(text, text), public.diary_call_invite_get(uuid) to authenticated;
grant execute on function public.diary_call_decline(uuid, uuid) to anon, authenticated;
