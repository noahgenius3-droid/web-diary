-- Tag people with @username in posts, group posts and comments. Whoever is tagged gets a notification,
-- but only if they can actually see what they were tagged in (public post, the author's friend, or a group member),
-- and only once per post (editing a post only notifies newly added tags). At most 10 tags count per post.

-- @usernames in a piece of text (not emails)
create or replace function private.diary_mentions(t text)
returns text[]
language sql
immutable
set search_path to ''
as $$
    select coalesce(array(select distinct lower(m[1]) from regexp_matches(coalesce(t, ''), '(?:^|[^a-zA-Z0-9_@.])@([a-zA-Z0-9_]{3,20})', 'g') as m limit 10), '{}');
$$;

alter table public.diary_notifications drop constraint diary_notifications_type_check;
alter table public.diary_notifications add constraint diary_notifications_type_check check (type in (
    'friend_request', 'friend_accepted', 'entry_like', 'entry_comment', 'post_like', 'post_comment', 'community_post', 'community_join',
    'call_started', 'missed_call', 'entry_repost', 'reel_like', 'reel_comment', 'library_like', 'live_started', 'new_follower',
    'book_request', 'book_request_update', 'book_message', 'entry_reaction', 'story_reaction', 'mention', 'reply', 'new_login',
    'post_activity', 'scheduled_published', 'scheduled_failed', 'trivia_rank', 'badge_earned', 'announcement', 'verification_update',
    'game_invite', 'game_turn', 'game_over', 'comment_reply', 'referral_joined', 'tagged'));

-- Posts on the feed (and edits to them)
create or replace function private.diary_tag_entry()
returns trigger
language plpgsql
security definer
set search_path to ''
as $$
declare
    fresh text[] := private.diary_mentions(coalesce(new.title, '') || ' ' || coalesce(new.body, ''));
    before text[] := case when tg_op = 'UPDATE' then private.diary_mentions(coalesce(old.title, '') || ' ' || coalesce(old.body, '')) else '{}' end;
    u record;
begin
    if cardinality(fresh) = 0 then return new; end if;
    for u in select p.id from public.diary_profiles p where p.username = any (fresh) and not (p.username = any (before)) and p.id <> new.author loop
        continue when private.diary_blocked(new.author, u.id);
        continue when not (new.audience = 'public' or private.diary_are_friends(new.author, u.id));
        perform private.diary_notify(u.id, new.author, 'tagged', jsonb_build_object('kind', 'post', 'entry_id', new.id,
            'snippet', left(coalesce(nullif(new.body, ''), new.title, ''), 120)));
    end loop;
    return new;
exception when others then
    return new;
end;
$$;
drop trigger if exists diary_tag_entry on public.diary_shared_entries;
create trigger diary_tag_entry after insert or update of body, title on public.diary_shared_entries
    for each row execute function private.diary_tag_entry();

-- Group posts: only members of that group are told
create or replace function private.diary_tag_group_post()
returns trigger
language plpgsql
security definer
set search_path to ''
as $$
declare
    fresh text[] := private.diary_mentions(coalesce(new.title, '') || ' ' || coalesce(new.body, ''));
    before text[] := case when tg_op = 'UPDATE' then private.diary_mentions(coalesce(old.title, '') || ' ' || coalesce(old.body, '')) else '{}' end;
    u record;
begin
    if cardinality(fresh) = 0 then return new; end if;
    for u in select p.id from public.diary_profiles p where p.username = any (fresh) and not (p.username = any (before)) and p.id <> new.author loop
        continue when private.diary_blocked(new.author, u.id);
        continue when not exists (select 1 from public.diary_community_members m where m.community_id = new.community_id and m.user_id = u.id);
        perform private.diary_notify(u.id, new.author, 'tagged', jsonb_build_object('kind', 'group_post', 'post_id', new.id,
            'community_id', new.community_id, 'snippet', left(coalesce(nullif(new.body, ''), new.title, ''), 120)));
    end loop;
    return new;
exception when others then
    return new;
end;
$$;
drop trigger if exists diary_tag_group_post on public.diary_community_posts;
create trigger diary_tag_group_post after insert or update of body, title on public.diary_community_posts
    for each row execute function private.diary_tag_group_post();

-- Comments (a reply's leading @name is already covered by the "replied to your comment" notification)
create or replace function private.diary_tag_comment()
returns trigger
language plpgsql
security definer
set search_path to ''
as $$
declare
    body text := coalesce(new.body, '');
    fresh text[];
    lead text;
    u record;
    e public.diary_shared_entries;
    cp public.diary_community_posts;
    can boolean;
begin
    if new.reply_to is not null then lead := lower(substring(body from '^@([a-zA-Z0-9_]{3,20})')); end if;
    fresh := private.diary_mentions(body);
    if cardinality(fresh) = 0 then return new; end if;
    if new.entry_id is not null then select * into e from public.diary_shared_entries where id = new.entry_id; end if;
    if new.post_id is not null then select * into cp from public.diary_community_posts where id = new.post_id; end if;
    for u in select p.id, p.username from public.diary_profiles p where p.username = any (fresh) and p.id <> new.author loop
        continue when lead is not null and u.username = lead;
        continue when private.diary_blocked(new.author, u.id);
        can := case
            when new.entry_id is not null then e.author = u.id or e.audience = 'public' or private.diary_are_friends(e.author, u.id)
            when new.post_id is not null then exists (select 1 from public.diary_community_members m where m.community_id = cp.community_id and m.user_id = u.id)
            else private.diary_are_friends(new.author, u.id)
        end;
        continue when not coalesce(can, false);
        perform private.diary_notify(u.id, new.author, 'tagged', jsonb_build_object('kind', 'comment', 'entry_id', new.entry_id, 'post_id', new.post_id,
            'reel_id', new.reel_id, 'community_id', cp.community_id, 'comment_id', new.id, 'snippet', left(body, 120)));
    end loop;
    return new;
exception when others then
    return new;
end;
$$;
drop trigger if exists diary_tag_comment on public.diary_comments;
create trigger diary_tag_comment after insert on public.diary_comments
    for each row execute function private.diary_tag_comment();

-- In the "mentions" notification group, with a lock-screen alert
create or replace function private.diary_notif_category(t text)
returns text
language sql
immutable
set search_path to ''
as $$
    select case
        when t in ('entry_like', 'post_like', 'reel_like', 'library_like', 'entry_reaction', 'story_reaction', 'entry_repost') then 'reactions'
        when t in ('entry_comment', 'post_comment', 'reel_comment', 'post_activity', 'comment_reply') then 'comments'
        when t in ('mention', 'reply', 'tagged') then 'mentions'
        when t in ('new_follower', 'friend_request', 'friend_accepted', 'referral_joined') then 'people'
        when t in ('community_post', 'community_join', 'call_started') then 'groups'
        when t in ('live_started') then 'live'
        when t in ('scheduled_published', 'scheduled_failed') then 'scheduled'
        when t in ('book_request', 'book_request_update', 'book_message') then 'market'
        when t in ('missed_call') then 'calls'
        when t in ('trivia_rank', 'badge_earned', 'game_invite', 'game_turn', 'game_over') then 'games'
        else 'account'
    end;
$$;

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
                        'referral_joined', 'tagged') then
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
