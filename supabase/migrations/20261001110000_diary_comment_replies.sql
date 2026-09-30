-- Instagram-style comments: replies threaded under the comment they answer, and hearts on comments.
-- A reply always hangs off the top-level comment (replying to a reply joins the same thread), like Instagram.

alter table public.diary_comments add column if not exists reply_to uuid references public.diary_comments (id) on delete cascade;
create index if not exists diary_comments_reply_to on public.diary_comments (reply_to);
grant insert (reply_to) on public.diary_comments to authenticated;

-- A reply must be on the same post as its comment, and joins the top-level thread
create or replace function private.diary_comment_reply_check()
returns trigger
language plpgsql
security definer
set search_path to ''
as $$
declare
    par public.diary_comments;
begin
    if new.reply_to is null then return new; end if;
    select * into par from public.diary_comments where id = new.reply_to;
    if not found then raise exception 'That comment isn’t there any more'; end if;
    if par.reply_to is not null then
        new.reply_to := par.reply_to;
        select * into par from public.diary_comments where id = new.reply_to;
    end if;
    if par.entry_id is distinct from new.entry_id or par.post_id is distinct from new.post_id or par.reel_id is distinct from new.reel_id then
        raise exception 'You can only reply on the same post';
    end if;
    return new;
end;
$$;
drop trigger if exists diary_comment_reply_check on public.diary_comments;
create trigger diary_comment_reply_check before insert on public.diary_comments
    for each row execute function private.diary_comment_reply_check();

-- "Ada replied to your comment" (the post's owner already hears about every comment, so they're skipped)
alter table public.diary_notifications drop constraint diary_notifications_type_check;
alter table public.diary_notifications add constraint diary_notifications_type_check check (type in (
    'friend_request', 'friend_accepted', 'entry_like', 'entry_comment', 'post_like', 'post_comment', 'community_post', 'community_join',
    'call_started', 'missed_call', 'entry_repost', 'reel_like', 'reel_comment', 'library_like', 'live_started', 'new_follower',
    'book_request', 'book_request_update', 'book_message', 'entry_reaction', 'story_reaction', 'mention', 'reply', 'new_login',
    'post_activity', 'scheduled_published', 'scheduled_failed', 'trivia_rank', 'badge_earned', 'announcement', 'verification_update',
    'game_invite', 'game_turn', 'game_over', 'comment_reply'));

create or replace function private.diary_notify_comment_reply()
returns trigger
language plpgsql
security definer
set search_path to ''
as $$
declare
    parent_author uuid;
    owner uuid;
    community uuid;
begin
    if new.reply_to is null then return new; end if;
    select author into parent_author from public.diary_comments where id = new.reply_to;
    if parent_author is null or parent_author = new.author then return new; end if;
    if new.entry_id is not null then select author into owner from public.diary_shared_entries where id = new.entry_id;
    elsif new.post_id is not null then select author, community_id into owner, community from public.diary_community_posts where id = new.post_id;
    elsif new.reel_id is not null then select author into owner from public.diary_reels where id = new.reel_id;
    end if;
    if owner = parent_author then return new; end if;
    perform private.diary_notify(parent_author, new.author, 'comment_reply', jsonb_build_object(
        'entry_id', new.entry_id, 'post_id', new.post_id, 'reel_id', new.reel_id, 'community_id', community,
        'comment_id', new.id, 'snippet', left(coalesce(nullif(new.body, ''), 'Voice reply'), 120)));
    return new;
exception when others then
    return new; -- a notification must never stop a comment
end;
$$;
drop trigger if exists diary_notify_comment_reply on public.diary_comments;
create trigger diary_notify_comment_reply after insert on public.diary_comments
    for each row execute function private.diary_notify_comment_reply();

create or replace function private.diary_notif_category(t text)
returns text
language sql
immutable
set search_path to ''
as $$
    select case
        when t in ('entry_like', 'post_like', 'reel_like', 'library_like', 'entry_reaction', 'story_reaction', 'entry_repost') then 'reactions'
        when t in ('entry_comment', 'post_comment', 'reel_comment', 'post_activity', 'comment_reply') then 'comments'
        when t in ('mention', 'reply') then 'mentions'
        when t in ('new_follower', 'friend_request', 'friend_accepted') then 'people'
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
                        'scheduled_published', 'scheduled_failed', 'post_activity', 'game_invite', 'game_turn', 'game_over', 'comment_reply') then
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

-- Hearts on comments
create table if not exists public.diary_comment_likes (
    comment_id uuid not null references public.diary_comments (id) on delete cascade,
    user_id uuid not null default auth.uid() references public.diary_profiles (id) on delete cascade,
    created_at timestamptz not null default now(),
    primary key (comment_id, user_id)
);
alter table public.diary_comment_likes enable row level security;
-- You see hearts on comments you can see (diary_comments' own visibility rules apply inside the check)
create policy "See likes on comments you can see" on public.diary_comment_likes for select to authenticated
    using (exists (select 1 from public.diary_comments c where c.id = comment_id));
create policy "Like comments you can see" on public.diary_comment_likes for insert to authenticated
    with check (user_id = (select auth.uid()) and exists (select 1 from public.diary_comments c where c.id = comment_id));
create policy "Members only (insert)" on public.diary_comment_likes as restrictive for insert to authenticated
    with check (coalesce((select auth.jwt() ->> 'is_anonymous')::boolean, false) = false);
create policy "Unlike your own" on public.diary_comment_likes for delete to authenticated using (user_id = (select auth.uid()));
grant select, delete on public.diary_comment_likes to authenticated;
grant insert (comment_id) on public.diary_comment_likes to authenticated;

-- Update: a reply starting with @someone notifies that person (the one being answered), like Instagram
create or replace function private.diary_notify_comment_reply()
returns trigger
language plpgsql
security definer
set search_path to ''
as $$
declare
    parent_author uuid;
    tagged uuid;
    owner uuid;
    community uuid;
    target uuid;
    handle text;
begin
    if new.reply_to is null then return new; end if;
    select author into parent_author from public.diary_comments where id = new.reply_to;
    handle := lower(substring(coalesce(new.body, '') from '^@([a-z0-9_]{3,20})'));
    if handle is not null then
        select p.id into tagged from public.diary_profiles p where p.username = handle
            and exists (select 1 from public.diary_comments c where c.author = p.id and (c.id = new.reply_to or c.reply_to = new.reply_to));
    end if;
    target := coalesce(tagged, parent_author);
    if target is null or target = new.author then return new; end if;
    if new.entry_id is not null then select author into owner from public.diary_shared_entries where id = new.entry_id;
    elsif new.post_id is not null then select author, community_id into owner, community from public.diary_community_posts where id = new.post_id;
    elsif new.reel_id is not null then select author into owner from public.diary_reels where id = new.reel_id;
    end if;
    if owner = target then return new; end if;
    perform private.diary_notify(target, new.author, 'comment_reply', jsonb_build_object(
        'entry_id', new.entry_id, 'post_id', new.post_id, 'reel_id', new.reel_id, 'community_id', community,
        'comment_id', new.id, 'snippet', left(coalesce(nullif(new.body, ''), 'Voice reply'), 120)));
    return new;
exception when others then
    return new;
end;
$$;
