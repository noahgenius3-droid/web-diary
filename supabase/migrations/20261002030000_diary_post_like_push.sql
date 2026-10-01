-- Push alerts when someone reacts to your post, and when a friend (or someone you follow) posts on the Feed.

-- 1. A new kind of notification: a friend's new Feed post
alter table public.diary_notifications drop constraint if exists diary_notifications_type_check;
alter table public.diary_notifications add constraint diary_notifications_type_check check (type = any (array[
    'friend_request', 'friend_accepted', 'entry_like', 'entry_comment', 'post_like', 'post_comment', 'community_post', 'community_join',
    'call_started', 'missed_call', 'entry_repost', 'reel_like', 'reel_comment', 'library_like', 'live_started', 'new_follower',
    'book_request', 'book_request_update', 'book_message', 'entry_reaction', 'story_reaction', 'mention', 'reply', 'new_login',
    'post_activity', 'scheduled_published', 'scheduled_failed', 'trivia_rank', 'badge_earned', 'announcement', 'verification_update',
    'game_invite', 'game_turn', 'game_over', 'comment_reply', 'referral_joined', 'tagged', 'space_live', 'new_post'
]));

-- Its own switch in Settings → Notifications
create or replace function private.diary_notif_category(t text) returns text
language sql immutable set search_path = '' as $$
    select case
        when t in ('entry_like', 'post_like', 'reel_like', 'library_like', 'entry_reaction', 'story_reaction', 'entry_repost') then 'reactions'
        when t in ('entry_comment', 'post_comment', 'reel_comment', 'post_activity', 'comment_reply') then 'comments'
        when t in ('mention', 'reply', 'tagged') then 'mentions'
        when t in ('new_follower', 'friend_request', 'friend_accepted', 'referral_joined') then 'people'
        when t in ('community_post', 'community_join', 'call_started') then 'groups'
        when t in ('live_started') then 'live'
        when t in ('new_post') then 'posts'
        when t in ('scheduled_published', 'scheduled_failed') then 'scheduled'
        when t in ('book_request', 'book_request_update', 'book_message') then 'market'
        when t in ('missed_call') then 'calls'
        when t in ('trivia_rank', 'badge_earned', 'game_invite', 'game_turn', 'game_over') then 'games'
        else 'account'
    end;
$$;

-- 2. A new Feed post tells the author's friends — and, when it's public, their followers.
-- At most one alert per author every 30 minutes, so a burst of posts doesn't flood anyone.
create or replace function private.diary_on_new_post() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
    person uuid;
begin
    for person in
        select case when f.requester = new.author then f.addressee else f.requester end
        from public.diary_friendships f
        where f.status = 'accepted' and new.author in (f.requester, f.addressee)
        union
        select fo.follower from public.diary_follows fo
        where fo.followee = new.author and new.audience = 'public'
    loop
        if not exists (
            select 1 from public.diary_notifications n
            where n.user_id = person and n.actor = new.author and n.type = 'new_post'
              and n.created_at > now() - interval '30 minutes'
        ) then
            perform private.diary_notify(person, new.author, 'new_post',
                jsonb_build_object('entry_id', new.id, 'photos', case when jsonb_typeof(new.photos) = 'array' then jsonb_array_length(new.photos) else 0 end,
                    'snippet', private.diary_snippet(coalesce(nullif(new.title, ''), new.body), 80)));
        end if;
    end loop;
    return new;
exception when others then
    return new; -- a notification problem must never stop the post
end;
$$;

drop trigger if exists diary_notify_new_post on public.diary_shared_entries;
create trigger diary_notify_new_post after insert on public.diary_shared_entries
    for each row execute function private.diary_on_new_post();

-- 3. Push alerts now include reactions and new posts. Someone toggling a reaction on and off doesn't buzz
-- your phone again: one alert per person, per post, per 10 minutes.
create or replace function private.diary_push_notification() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
    cfg private.diary_push_config;
    target text;
begin
    if new.type not in ('friend_request', 'friend_accepted', 'new_follower', 'live_started', 'mention', 'reply', 'new_login', 'call_started',
                        'scheduled_published', 'scheduled_failed', 'post_activity', 'game_invite', 'game_turn', 'game_over', 'comment_reply',
                        'referral_joined', 'tagged', 'announcement', 'space_live',
                        'entry_like', 'entry_reaction', 'post_like', 'reel_like', 'new_post') then
        return new;
    end if;
    if not exists (select 1 from public.diary_push_subscriptions where user_id = new.user_id) then
        return new;
    end if;
    if new.type in ('entry_like', 'entry_reaction', 'post_like', 'reel_like') then
        target := coalesce(new.data->>'entry_id', new.data->>'entry', new.data->>'post_id', new.data->>'reel_id', '');
        if exists (
            select 1 from public.diary_notifications n
            where n.user_id = new.user_id and n.actor = new.actor and n.type = new.type and n.id <> new.id
              and coalesce(n.data->>'entry_id', n.data->>'entry', n.data->>'post_id', n.data->>'reel_id', '') = target
              and n.created_at > now() - interval '10 minutes'
        ) then
            return new;
        end if;
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
$$;
