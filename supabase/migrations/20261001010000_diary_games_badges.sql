-- Phase D: games (scores computed here from what you did, with sanity limits), XP and levels, badges, and
-- leaderboards for games, contributors, helpful people, activity and most-liked posts.

-- ---------- Game results ----------
create table if not exists public.diary_game_scores (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null default auth.uid() references public.diary_profiles (id) on delete cascade,
    game text not null check (game in ('five', 'wordsearch', 'sudoku', 'memory', 'maths', 'slide')),
    day date not null,
    ranked boolean not null default false,
    won boolean not null default false,
    moves int not null default 0,
    time_ms int not null default 0,
    score int not null default 0,
    created_at timestamptz not null default now()
);
create unique index if not exists diary_game_scores_daily on public.diary_game_scores (user_id, game, day) where ranked;
create index if not exists diary_game_scores_board on public.diary_game_scores (created_at) where ranked;
alter table public.diary_game_scores enable row level security;
create policy "Your game results" on public.diary_game_scores for select to authenticated using (user_id = (select auth.uid()));
revoke all on public.diary_game_scores from anon, authenticated;
grant select on public.diary_game_scores to authenticated;

-- The server turns what you did into points, so a tampered phone can't post a silly score.
-- moves: five = guesses used (1–6); wordsearch = words found; sudoku = mistakes; memory = turns; maths = right answers; slide = moves
create or replace function public.diary_game_submit(p_game text, p_won boolean, p_moves int, p_time_ms int, p_day date default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
    me uuid := auth.uid();
    today date := private.diary_utc_day();
    d date := coalesce(p_day, today);
    secs numeric := greatest(coalesce(p_time_ms, 0), 0) / 1000.0;
    mv int := greatest(coalesce(p_moves, 0), 0);
    v_won boolean := coalesce(p_won, false);
    min_secs numeric;
    pts int;
    is_ranked boolean;
    best int;
begin
    if me is null then raise exception 'Sign in to play'; end if;
    if p_game not in ('five', 'wordsearch', 'sudoku', 'memory', 'maths', 'slide') then raise exception 'Unknown game'; end if;
    if d not in (today, today - 1) then raise exception 'That puzzle has expired'; end if;
    min_secs := case p_game when 'five' then 4 when 'wordsearch' then 15 when 'sudoku' then 45 when 'memory' then 8 when 'maths' then 0 else 10 end;
    if secs < min_secs and (v_won or p_game in ('wordsearch', 'maths')) then raise exception 'That was impossibly fast'; end if;
    pts := case p_game
        when 'five' then case when v_won and mv between 1 and 6 then 100 * (7 - mv) + greatest(0, 100 - secs::int) else 0 end
        when 'wordsearch' then least(mv, 10) * 40 + case when v_won then greatest(0, 300 - secs::int) else 0 end
        when 'sudoku' then case when v_won then greatest(150, 1200 - secs::int - least(mv, 20) * 30) else 0 end
        when 'memory' then case when v_won and mv >= 8 then greatest(60, 700 - (mv - 8) * 25 - secs::int * 2) else 0 end
        when 'maths' then least(mv, 45) * 20
        else case when v_won and mv >= 10 then greatest(80, 900 - mv * 2 - secs::int) else 0 end
    end;
    is_ranked := d = today and not exists (select 1 from public.diary_game_scores g where g.user_id = me and g.game = p_game and g.day = d and g.ranked);
    insert into public.diary_game_scores (user_id, game, day, ranked, won, moves, time_ms, score)
    values (me, p_game, d, is_ranked, v_won, mv, least(greatest(coalesce(p_time_ms, 0), 0), 86400000), pts);
    select max(g.score) into best from public.diary_game_scores g where g.user_id = me and g.game = p_game and g.day = d;
    return jsonb_build_object('score', pts, 'ranked', is_ranked, 'best_today', best, 'badges', public.diary_check_badges());
end;
$$;

-- What you've played today (so the page can show "Played · 640 pts")
create or replace function public.diary_games_today()
returns jsonb language sql stable security definer set search_path = '' as $$
    select coalesce(jsonb_object_agg(game, jsonb_build_object('score', score, 'won', won, 'moves', moves, 'time_ms', time_ms)), '{}'::jsonb)
    from public.diary_game_scores where user_id = auth.uid() and day = private.diary_utc_day() and ranked;
$$;

-- ---------- XP and levels ----------
-- XP: trivia and game points, plus a little for taking part (10 per post, 2 per comment)
create or replace function private.diary_xp(p_user uuid) returns bigint language sql stable security definer set search_path = '' as $$
    select coalesce((select sum(score) from public.diary_trivia_rounds where user_id = p_user and kind <> 'practice' and finished_at is not null), 0)
         + coalesce((select sum(score) from public.diary_game_scores where user_id = p_user and ranked), 0)
         + 10 * (select count(*) from public.diary_shared_entries where author = p_user)
         + 2 * (select count(*) from public.diary_comments where author = p_user);
$$;
-- Level n needs 150·(n−1)² XP: 150, 600, 1,350, 2,400 …
create or replace function private.diary_level(p_xp bigint) returns int language sql immutable set search_path = '' as $$
    select floor(sqrt(greatest(p_xp, 0) / 150.0))::int + 1;
$$;

-- ---------- Badges ----------
create table if not exists public.diary_badges (
    id text primary key,
    name text not null,
    description text not null,
    icon text not null,
    tier text not null default 'bronze' check (tier in ('bronze', 'silver', 'gold')),
    sort int not null default 0
);
create table if not exists public.diary_user_badges (
    user_id uuid not null references public.diary_profiles (id) on delete cascade,
    badge text not null references public.diary_badges (id) on delete cascade,
    earned_at timestamptz not null default now(),
    primary key (user_id, badge)
);
alter table public.diary_badges enable row level security;
alter table public.diary_user_badges enable row level security;
create policy "Anyone signed in can see the badge list" on public.diary_badges for select to authenticated using (true);
create policy "Your badges" on public.diary_user_badges for select to authenticated using (user_id = (select auth.uid()));
revoke all on public.diary_badges, public.diary_user_badges from anon, authenticated;
grant select on public.diary_badges, public.diary_user_badges to authenticated;

insert into public.diary_badges (id, name, description, icon, tier, sort) values
    ('first_post', 'First Post', 'Shared your first post', 'i-edit', 'bronze', 10),
    ('first_comment', 'First Comment', 'Left your first comment', 'i-chat', 'bronze', 20),
    ('posts_100', '100 Posts', 'Shared 100 posts', 'i-notes', 'gold', 30),
    ('likes_1000', '1,000 Likes', 'Your posts received 1,000 reactions', 'i-thumb', 'gold', 40),
    ('streak_7', 'On a Roll', 'Played the daily trivia 7 days in a row', 'i-flame', 'silver', 50),
    ('perfect_day', 'Perfect Day', 'Got every daily trivia question right', 'i-check', 'silver', 60),
    ('trivia_master', 'Trivia Master', 'Scored 80% or more in 10 daily trivia rounds', 'i-g-question', 'gold', 70),
    ('knowledge_champion', 'Knowledge Champion', 'Answered 500 trivia questions correctly', 'i-g-cap', 'gold', 80),
    ('puzzle_master', 'Puzzle Master', 'Solved 25 daily puzzles', 'i-g-puzzle', 'gold', 90),
    ('community_builder', 'Community Builder', 'Started a group that grew to 10 members', 'i-users', 'silver', 100),
    ('top_contributor', 'Top Contributor', 'Finished in the top 3 contributors of a week', 'i-sparkle', 'gold', 110),
    ('weekly_champion', 'Weekly Champion', 'Won a weekly trivia challenge', 'i-trophy', 'gold', 120)
on conflict (id) do update set name = excluded.name, description = excluded.description, icon = excluded.icon, tier = excluded.tier, sort = excluded.sort;

-- Award whatever someone now qualifies for; returns the new ones. Also tells them with a notification.
create or replace function private.diary_award_badges(p_user uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
    earned text[] := '{}';
    b text;
    got jsonb := '[]'::jsonb;
begin
    if p_user is null then return got; end if;
    if exists (select 1 from public.diary_shared_entries where author = p_user) then earned := array_append(earned, 'first_post'); end if;
    if exists (select 1 from public.diary_comments where author = p_user) then earned := array_append(earned, 'first_comment'); end if;
    if (select count(*) from public.diary_shared_entries where author = p_user) >= 100 then earned := array_append(earned, 'posts_100'); end if;
    if (select count(*) from public.diary_entry_likes l join public.diary_shared_entries e on e.id = l.entry_id where e.author = p_user)
     + (select count(*) from public.diary_community_likes l join public.diary_community_posts p on p.id = l.post_id where p.author = p_user) >= 1000 then
        earned := array_append(earned, 'likes_1000'); end if;
    if coalesce((public.diary_trivia_stats_for(p_user) ->> 'streak')::int, 0) >= 7 then earned := array_append(earned, 'streak_7'); end if;
    if exists (select 1 from public.diary_trivia_rounds where user_id = p_user and kind = 'daily' and finished_at is not null and correct = cardinality(questions)) then
        earned := array_append(earned, 'perfect_day'); end if;
    if (select count(*) from public.diary_trivia_rounds where user_id = p_user and kind = 'daily' and finished_at is not null and correct * 5 >= cardinality(questions) * 4) >= 10 then
        earned := array_append(earned, 'trivia_master'); end if;
    if (select coalesce(sum(correct), 0) from public.diary_trivia_rounds where user_id = p_user) >= 500 then earned := array_append(earned, 'knowledge_champion'); end if;
    if (select count(*) from public.diary_game_scores where user_id = p_user and ranked and won) >= 25 then earned := array_append(earned, 'puzzle_master'); end if;
    if exists (select 1 from public.diary_communities c where c.owner = p_user
               and (select count(*) from public.diary_community_members m where m.community_id = c.id) >= 10) then
        earned := array_append(earned, 'community_builder'); end if;
    foreach b in array earned loop
        insert into public.diary_user_badges (user_id, badge) values (p_user, b) on conflict do nothing;
        if found then
            got := got || jsonb_build_array((select to_jsonb(x) from public.diary_badges x where x.id = b));
            insert into public.diary_notifications (user_id, actor, type, data)
            select p_user, p_user, 'badge_earned', jsonb_build_object('badge', x.id, 'name', x.name, 'description', x.description, 'tier', x.tier)
            from public.diary_badges x where x.id = b;
        end if;
    end loop;
    return got;
end;
$$;

-- The trivia streak etc. for any user (the public diary_trivia_stats honours privacy; awarding must not)
create or replace function public.diary_trivia_stats_for(p_user uuid) returns jsonb language sql stable security definer set search_path = '' as $$
    with days as (select distinct (finished_at at time zone 'utc')::date as d from public.diary_trivia_rounds
                  where user_id = p_user and kind = 'daily' and finished_at is not null),
    runs as (select d, d + (row_number() over (order by d desc))::int as g from days)
    select jsonb_build_object('streak', case when (select max(d) from days) >= private.diary_utc_day() - 1
        then (select count(*) from runs where g = (select g from runs order by d desc limit 1)) else 0 end);
$$;
revoke all on function public.diary_trivia_stats_for(uuid) from public, anon, authenticated;

create or replace function public.diary_check_badges() returns jsonb language sql security definer set search_path = '' as $$
    select private.diary_award_badges(auth.uid());
$$;

-- Someone's badges, level and XP (numbers follow their privacy settings)
create or replace function public.diary_badges_of(p_user uuid default null)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
    who uuid := coalesce(p_user, auth.uid());
    xp bigint;
begin
    if auth.uid() is null or not private.diary_can_see(who, auth.uid(), 'stats') then return null; end if;
    xp := private.diary_xp(who);
    return jsonb_build_object(
        'xp', xp, 'level', private.diary_level(xp),
        'level_floor', 150 * power(private.diary_level(xp) - 1, 2), 'level_next', 150 * power(private.diary_level(xp), 2),
        'badges', coalesce((select jsonb_agg(jsonb_build_object('id', b.id, 'name', b.name, 'description', b.description, 'icon', b.icon,
                    'tier', b.tier, 'earned_at', ub.earned_at) order by b.sort)
                  from public.diary_badges b left join public.diary_user_badges ub on ub.badge = b.id and ub.user_id = who), '[]'::jsonb));
end;
$$;

-- ---------- Leaderboards ----------
-- p_board: games | contributors | helpful | active | xp. Same periods and scopes as trivia.
create or replace function public.diary_board(p_board text, p_period text default 'week', p_scope text default 'everyone', p_limit int default 50)
returns table (rank bigint, user_id uuid, username text, display_name text, avatar_path text, score bigint, detail text, is_me boolean)
language sql stable security definer set search_path = '' as $$
    with me as (select auth.uid() as uid),
    since as (select case p_period
        when 'today' then date_trunc('day', now() at time zone 'utc') at time zone 'utc'
        when 'week' then date_trunc('week', now() at time zone 'utc') at time zone 'utc'
        when 'month' then date_trunc('month', now() at time zone 'utc') at time zone 'utc'
        else '-infinity'::timestamptz end as t),
    posts as (select author as u, count(*) as n from public.diary_shared_entries where shared_at >= (select t from since) group by author),
    comments as (select author as u, count(*) as n from public.diary_comments where created_at >= (select t from since) group by author),
    helpful as (select c.author as u, count(*) as n from public.diary_comments c
                left join public.diary_shared_entries e on e.id = c.entry_id
                left join public.diary_community_posts p on p.id = c.post_id
                where c.created_at >= (select t from since) and c.author <> coalesce(e.author, p.author, c.author)
                group by c.author),
    given as (select user_id as u, count(*) as n from public.diary_entry_likes where created_at >= (select t from since) group by user_id),
    games as (select user_id as u, sum(score) as s, count(*) as n from public.diary_game_scores where ranked and created_at >= (select t from since) group by user_id),
    trivia as (select user_id as u, sum(score) as s, count(*) as n from public.diary_trivia_rounds where kind <> 'practice' and finished_at >= (select t from since) group by user_id),
    scores as (
        select u, s::bigint as score, n || ' ' || case when n = 1 then 'puzzle' else 'puzzles' end as detail from games where p_board = 'games'
        union all
        select coalesce(p.u, c.u), (coalesce(p.n, 0) * 5 + coalesce(c.n, 0) * 2)::bigint,
            coalesce(p.n, 0) || ' posts · ' || coalesce(c.n, 0) || ' comments'
        from posts p full join comments c on c.u = p.u where p_board = 'contributors'
        union all
        select u, n::bigint, n || ' ' || case when n = 1 then 'reply' else 'replies' end || ' to others' from helpful where p_board = 'helpful'
        union all
        select x.u, sum(x.n)::bigint, sum(x.n) || ' things done' from (
            select u, n from posts union all select u, n from comments union all select u, n from given
            union all select u, n from games union all select u, n from trivia) x where p_board = 'active' group by x.u
        union all
        select p.id, private.diary_xp(p.id), 'Level ' || private.diary_level(private.diary_xp(p.id)) from public.diary_profiles p
        where p_board = 'xp' and (exists (select 1 from trivia where u = p.id) or exists (select 1 from games where u = p.id)
                                  or exists (select 1 from posts where u = p.id) or p_period = 'all')),
    visible as (
        select s.* from scores s
        where s.score > 0 and (s.u = (select uid from me) or (not private.diary_blocked(s.u, (select uid from me))
                and private.diary_can_see(s.u, (select uid from me), 'stats')))
          and (p_scope <> 'friends' or s.u = (select uid from me) or private.diary_are_friends(s.u, (select uid from me)))),
    ranked as (select v.*, rank() over (order by v.score desc) as rk from visible v)
    select x.rk, p.id, p.username, p.display_name,
        case when coalesce(pr.photo_visibility, 'everyone') = 'everyone' or p.id = (select uid from me) or private.diary_are_friends(p.id, (select uid from me)) then p.avatar_path end,
        x.score, x.detail, p.id = (select uid from me)
    from ranked x join public.diary_profiles p on p.id = x.u
    left join public.diary_presence pr on pr.user_id = p.id
    where (select uid from me) is not null and (x.rk <= least(greatest(coalesce(p_limit, 50), 1), 100) or x.u = (select uid from me))
    order by x.rk, p.display_name;
$$;

-- Most-liked posts you can see (runs as you, so friends-only posts stay private)
create or replace function public.diary_top_posts(p_period text default 'week', p_limit int default 20)
returns table (id uuid, author uuid, username text, display_name text, avatar_path text, title text, body text, reactions bigint, shared_at timestamptz)
language sql stable security invoker set search_path = '' as $$
    select e.id, e.author, p.username, p.display_name, p.avatar_path, e.title, left(e.body, 200),
        (select count(*) from public.diary_entry_likes l where l.entry_id = e.id), e.shared_at
    from public.diary_shared_entries e join public.diary_profiles p on p.id = e.author
    where e.shared_at >= case p_period
        when 'today' then date_trunc('day', now() at time zone 'utc') at time zone 'utc'
        when 'week' then date_trunc('week', now() at time zone 'utc') at time zone 'utc'
        when 'month' then date_trunc('month', now() at time zone 'utc') at time zone 'utc'
        else '-infinity'::timestamptz end
    order by 8 desc, e.shared_at desc
    limit least(greatest(coalesce(p_limit, 20), 1), 50);
$$;

-- ---------- Notifications for badges; weekly awards ----------
alter table public.diary_notifications drop constraint diary_notifications_type_check;
alter table public.diary_notifications add constraint diary_notifications_type_check check (type in (
    'friend_request', 'friend_accepted', 'entry_like', 'entry_comment', 'post_like', 'post_comment', 'community_post',
    'community_join', 'call_started', 'missed_call', 'entry_repost', 'reel_like', 'reel_comment', 'library_like',
    'live_started', 'new_follower', 'book_request', 'book_request_update', 'book_message', 'entry_reaction',
    'story_reaction', 'mention', 'reply', 'new_login', 'post_activity', 'scheduled_published', 'scheduled_failed', 'trivia_rank',
    'badge_earned'));

create or replace function private.diary_notif_category(t text)
returns text language sql immutable set search_path = '' as $$
    select case
        when t in ('entry_like', 'post_like', 'reel_like', 'library_like', 'entry_reaction', 'story_reaction', 'entry_repost') then 'reactions'
        when t in ('entry_comment', 'post_comment', 'reel_comment', 'post_activity') then 'comments'
        when t in ('mention', 'reply') then 'mentions'
        when t in ('new_follower', 'friend_request', 'friend_accepted') then 'people'
        when t in ('community_post', 'community_join', 'call_started') then 'groups'
        when t in ('live_started') then 'live'
        when t in ('scheduled_published', 'scheduled_failed') then 'scheduled'
        when t in ('book_request', 'book_request_update', 'book_message') then 'market'
        when t in ('missed_call') then 'calls'
        when t in ('trivia_rank', 'badge_earned') then 'games'
        else 'account'
    end;
$$;

-- Mondays: last week's trivia winner and top 3 contributors get their badges; nightly: everyone active yesterday
create or replace function private.diary_weekly_awards() returns int language plpgsql security definer set search_path = '' as $$
declare
    per text := to_char((now() at time zone 'utc') - interval '7 days', 'IYYY-"W"IW');
    wk_start timestamptz := date_trunc('week', (now() at time zone 'utc') - interval '7 days') at time zone 'utc';
    wk_end timestamptz := date_trunc('week', now() at time zone 'utc') at time zone 'utc';
    n int := 0;
    r record;
begin
    for r in select user_id from (select user_id, rank() over (order by score desc, total_ms asc) as rk
             from public.diary_trivia_rounds where kind = 'weekly' and period = per and finished_at is not null) t where rk = 1 loop
        insert into public.diary_user_badges (user_id, badge) values (r.user_id, 'weekly_champion') on conflict do nothing;
        if found then
            n := n + 1;
            insert into public.diary_notifications (user_id, actor, type, data) values (r.user_id, r.user_id, 'badge_earned',
                jsonb_build_object('badge', 'weekly_champion', 'name', 'Weekly Champion', 'description', 'Won a weekly trivia challenge', 'tier', 'gold'));
        end if;
    end loop;
    for r in select u from (
        select coalesce(p.u, c.u) as u, rank() over (order by coalesce(p.n, 0) * 5 + coalesce(c.n, 0) * 2 desc) as rk
        from (select author as u, count(*) as n from public.diary_shared_entries where shared_at >= wk_start and shared_at < wk_end group by author) p
        full join (select author as u, count(*) as n from public.diary_comments where created_at >= wk_start and created_at < wk_end group by author) c on c.u = p.u) t
        where rk <= 3 loop
        insert into public.diary_user_badges (user_id, badge) values (r.u, 'top_contributor') on conflict do nothing;
        if found then
            n := n + 1;
            insert into public.diary_notifications (user_id, actor, type, data) values (r.u, r.u, 'badge_earned',
                jsonb_build_object('badge', 'top_contributor', 'name', 'Top Contributor', 'description', 'Finished in the top 3 contributors of a week', 'tier', 'gold'));
        end if;
    end loop;
    return n;
end;
$$;

create or replace function private.diary_nightly_badges() returns int language plpgsql security definer set search_path = '' as $$
declare
    r record;
    n int := 0;
begin
    for r in select distinct u from (
        select author as u from public.diary_shared_entries where shared_at > now() - interval '1 day'
        union select author from public.diary_comments where created_at > now() - interval '1 day'
        union select e.author from public.diary_entry_likes l join public.diary_shared_entries e on e.id = l.entry_id where l.created_at > now() - interval '1 day'
        union select owner from public.diary_communities c where exists (select 1 from public.diary_community_members m where m.community_id = c.id and m.joined_at > now() - interval '1 day')
    ) t loop
        perform private.diary_award_badges(r.u);
        n := n + 1;
    end loop;
    return n;
end;
$$;

select cron.unschedule(jobid) from cron.job where jobname in ('diary-weekly-awards', 'diary-nightly-badges');
select cron.schedule('diary-weekly-awards', '30 0 * * 1', $$select private.diary_weekly_awards()$$);
select cron.schedule('diary-nightly-badges', '40 0 * * *', $$select private.diary_nightly_badges()$$);

revoke all on function public.diary_game_submit(text, boolean, int, int, date), public.diary_games_today(), public.diary_check_badges(),
    public.diary_badges_of(uuid), public.diary_board(text, text, text, int), public.diary_top_posts(text, int) from public, anon;
grant execute on function public.diary_game_submit(text, boolean, int, int, date), public.diary_games_today(), public.diary_check_badges(),
    public.diary_badges_of(uuid), public.diary_board(text, text, text, int), public.diary_top_posts(text, int) to authenticated;
revoke all on function private.diary_award_badges(uuid), private.diary_xp(uuid), private.diary_weekly_awards(), private.diary_nightly_badges() from public, anon, authenticated;
