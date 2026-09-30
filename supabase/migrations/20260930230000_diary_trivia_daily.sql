-- Phase C: trivia (daily, weekly, Bible, brain, question of the day, practice), leaderboards, and the daily
-- engagement items (word of the day, daily thought, daily poll). Scoring happens here, never on the phone:
-- questions go out without their answers, and the server times each answer.

-- ---------- Questions ----------
create table if not exists public.diary_trivia_questions (
    id uuid primary key default gen_random_uuid(),
    category text not null check (category in ('general', 'bible', 'history', 'science', 'current', 'sports', 'education', 'brain')),
    difficulty smallint not null default 2 check (difficulty between 1 and 3),
    question text not null check (char_length(question) between 5 and 400),
    choices text[] not null check (cardinality(choices) between 2 and 5),
    answer smallint not null,
    explanation text not null default '' check (char_length(explanation) <= 400),
    active boolean not null default true,
    created_by uuid references public.diary_profiles (id) on delete set null,
    created_at timestamptz not null default now(),
    check (answer >= 0 and answer < cardinality(choices))
);
create unique index if not exists diary_trivia_questions_text on public.diary_trivia_questions (lower(question));
alter table public.diary_trivia_questions enable row level security; -- no policies: only through the functions below
revoke all on public.diary_trivia_questions from anon, authenticated;

-- ---------- Rounds (one person playing one set) ----------
create table if not exists public.diary_trivia_rounds (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null references public.diary_profiles (id) on delete cascade,
    kind text not null check (kind in ('daily', 'weekly', 'bible', 'brain', 'qotd', 'practice')),
    category text,
    period text not null default '',
    questions uuid[] not null,
    answers smallint[] not null default '{}',
    correct int not null default 0,
    score int not null default 0,
    total_ms int not null default 0,
    started_at timestamptz not null default now(),
    last_at timestamptz not null default now(),
    finished_at timestamptz
);
create unique index if not exists diary_trivia_rounds_once on public.diary_trivia_rounds (user_id, kind, period) where kind <> 'practice';
create index if not exists diary_trivia_rounds_board on public.diary_trivia_rounds (finished_at) where kind <> 'practice';
create index if not exists diary_trivia_rounds_period on public.diary_trivia_rounds (kind, period);
alter table public.diary_trivia_rounds enable row level security;
create policy "Your trivia rounds" on public.diary_trivia_rounds for select to authenticated using (user_id = (select auth.uid()));
revoke all on public.diary_trivia_rounds from anon, authenticated;
grant select on public.diary_trivia_rounds to authenticated;

-- ---------- Word of the day, daily thought, daily poll ----------
create table if not exists public.diary_daily_items (
    kind text not null check (kind in ('word', 'thought', 'poll')),
    seq int not null,
    data jsonb not null,
    primary key (kind, seq)
);
alter table public.diary_daily_items enable row level security;
revoke all on public.diary_daily_items from anon, authenticated;

create table if not exists public.diary_daily_poll_votes (
    user_id uuid not null default auth.uid() references public.diary_profiles (id) on delete cascade,
    day date not null,
    choice smallint not null check (choice between 0 and 5),
    created_at timestamptz not null default now(),
    primary key (user_id, day)
);
alter table public.diary_daily_poll_votes enable row level security;
create policy "Your poll votes" on public.diary_daily_poll_votes for select to authenticated using (user_id = (select auth.uid()));
revoke all on public.diary_daily_poll_votes from anon, authenticated;
grant select on public.diary_daily_poll_votes to authenticated;

-- ---------- Helpers ----------
create or replace function private.diary_utc_day() returns date language sql stable set search_path = '' as $$
    select (now() at time zone 'utc')::date;
$$;

create or replace function private.diary_trivia_period(p_kind text) returns text language sql stable set search_path = '' as $$
    select case when p_kind = 'weekly' then to_char(now() at time zone 'utc', 'IYYY-"W"IW')
                when p_kind = 'practice' then ''
                else to_char(now() at time zone 'utc', 'YYYY-MM-DD') end;
$$;

-- What the phone may see of a round: questions without answers, plus the answers to what's already been answered
create or replace function private.diary_trivia_view(p_round uuid) returns jsonb language sql stable security definer set search_path = '' as $$
    select jsonb_build_object(
        'id', r.id, 'kind', r.kind, 'category', r.category, 'period', r.period,
        'total', cardinality(r.questions), 'index', coalesce(cardinality(r.answers), 0),
        'finished', r.finished_at is not null, 'correct', r.correct, 'score', r.score, 'total_ms', r.total_ms,
        'questions', (select jsonb_agg(jsonb_build_object('id', q.id, 'question', q.question, 'choices', to_jsonb(q.choices),
                            'category', q.category, 'difficulty', q.difficulty) order by o.n)
                      from unnest(r.questions) with ordinality o(qid, n) join public.diary_trivia_questions q on q.id = o.qid),
        'answered', coalesce((select jsonb_agg(jsonb_build_object('choice', r.answers[o.n], 'answer', q.answer,
                            'correct', r.answers[o.n] = q.answer, 'explanation', q.explanation) order by o.n)
                      from unnest(r.questions) with ordinality o(qid, n) join public.diary_trivia_questions q on q.id = o.qid
                      where o.n <= coalesce(cardinality(r.answers), 0)), '[]'::jsonb))
    from public.diary_trivia_rounds r where r.id = p_round;
$$;

-- Start (or resume) a round. Daily, weekly, Bible, brain and question-of-the-day sets are the same for everyone
-- and can be played once per day / week; practice is unlimited and doesn't count on leaderboards.
create or replace function public.diary_trivia_start(p_kind text, p_category text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
    me uuid := auth.uid();
    per text;
    rid uuid;
    cats text[];
    n int;
    seed text;
    picked uuid[];
begin
    if me is null then raise exception 'Sign in to play'; end if;
    if p_kind not in ('daily', 'weekly', 'bible', 'brain', 'qotd', 'practice') then raise exception 'Unknown game'; end if;
    per := private.diary_trivia_period(p_kind);
    if p_kind <> 'practice' then
        select id into rid from public.diary_trivia_rounds where user_id = me and kind = p_kind and period = per;
        if found then return private.diary_trivia_view(rid); end if;
    end if;
    cats := case p_kind
        when 'daily' then array['general', 'bible', 'history', 'science', 'current', 'sports', 'education']
        when 'weekly' then array['general', 'bible', 'history', 'science', 'current', 'sports', 'education', 'brain']
        when 'bible' then array['bible']
        when 'brain' then array['brain']
        when 'qotd' then array['general', 'history', 'science', 'sports', 'education', 'current']
        else case when p_category is null or p_category = 'random'
                  then array['general', 'bible', 'history', 'science', 'current', 'sports', 'education', 'brain']
                  else array[p_category] end
    end;
    n := case p_kind when 'daily' then 10 when 'weekly' then 20 when 'bible' then 5 when 'brain' then 1 when 'qotd' then 1 else 10 end;
    seed := p_kind || ':' || per;
    if p_kind = 'practice' then
        -- Prefer questions you haven't seen lately
        select array_agg(id) into picked from (
            select q.id from public.diary_trivia_questions q
            where q.active and q.category = any (cats)
            order by (q.id = any (coalesce((select array_agg(x) from (select unnest(r.questions) x from public.diary_trivia_rounds r
                where r.user_id = me order by r.started_at desc limit 30) s), '{}'))), random()
            limit n) t;
    else
        select array_agg(id) into picked from (
            select q.id from public.diary_trivia_questions q
            where q.active and q.category = any (cats)
            order by md5(q.id::text || seed) limit n) t;
    end if;
    if picked is null or cardinality(picked) = 0 then raise exception 'No questions yet in that category'; end if;
    insert into public.diary_trivia_rounds (user_id, kind, category, period, questions)
    values (me, p_kind, case when p_kind = 'practice' then coalesce(p_category, 'random') end, per, picked)
    returning id into rid;
    return private.diary_trivia_view(rid);
end;
$$;

-- The question is on screen now: its 30 seconds start
create or replace function public.diary_trivia_seen(p_round uuid) returns void language sql security definer set search_path = '' as $$
    update public.diary_trivia_rounds set last_at = now() where id = p_round and user_id = auth.uid() and finished_at is null;
$$;

-- Answer the next question (p_choice = -1 when time ran out)
create or replace function public.diary_trivia_answer(p_round uuid, p_choice int, p_ms int default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
    r public.diary_trivia_rounds;
    q public.diary_trivia_questions;
    n int;
    server_ms int;
    ms int;
    ok boolean;
    pts int;
begin
    select * into r from public.diary_trivia_rounds where id = p_round and user_id = auth.uid() for update;
    if not found then raise exception 'Round not found'; end if;
    if r.finished_at is not null then raise exception 'You’ve finished this one'; end if;
    n := coalesce(cardinality(r.answers), 0) + 1;
    select * into q from public.diary_trivia_questions where id = r.questions[n];
    server_ms := greatest(0, (extract(epoch from (now() - r.last_at)) * 1000)::int);
    ms := least(greatest(coalesce(p_ms, server_ms), 0), server_ms);
    ok := p_choice is not null and p_choice = q.answer and server_ms <= 33000; -- 30 seconds, plus a little for the network
    pts := case when ok then 60 + 20 * q.difficulty + round(40 * greatest(0, 1 - ms / 30000.0))::int else 0 end;
    update public.diary_trivia_rounds set
        answers = answers || (case when p_choice between 0 and 5 then p_choice else -1 end)::smallint,
        correct = correct + ok::int,
        score = score + pts,
        total_ms = total_ms + least(ms, 30000),
        last_at = now(),
        finished_at = case when n >= cardinality(questions) then now() end
    where id = r.id returning * into r;
    return jsonb_build_object('correct', ok, 'answer', q.answer, 'explanation', q.explanation, 'points', pts,
        'score', r.score, 'correct_count', r.correct, 'index', n, 'finished', r.finished_at is not null);
end;
$$;

-- ---------- Leaderboards ----------
-- p_period: today | week | month | all. p_scope: everyone | friends. Practice rounds don't count.
-- People who hide their numbers (Settings → Privacy) are left off, except to themselves.
create or replace function public.diary_trivia_leaderboard(p_period text default 'week', p_scope text default 'everyone', p_limit int default 50)
returns table (rank bigint, user_id uuid, username text, display_name text, avatar_path text, score bigint, rounds bigint, accuracy int, is_me boolean)
language sql stable security definer set search_path = '' as $$
    with me as (select auth.uid() as uid),
    since as (select case p_period
        when 'today' then date_trunc('day', now() at time zone 'utc') at time zone 'utc'
        when 'week' then date_trunc('week', now() at time zone 'utc') at time zone 'utc'
        when 'month' then date_trunc('month', now() at time zone 'utc') at time zone 'utc'
        else '-infinity'::timestamptz end as t),
    agg as (
        select r.user_id, sum(r.score)::bigint as score, count(*) as rounds, sum(r.correct) as c, sum(cardinality(r.questions)) as n
        from public.diary_trivia_rounds r
        where r.finished_at >= (select t from since) and r.kind <> 'practice'
        group by r.user_id),
    visible as (
        select a.* from agg a
        where (a.user_id = (select uid from me) or (not private.diary_blocked(a.user_id, (select uid from me))
                and private.diary_can_see(a.user_id, (select uid from me), 'stats')))
          and (p_scope <> 'friends' or a.user_id = (select uid from me) or private.diary_are_friends(a.user_id, (select uid from me)))),
    ranked as (select v.*, rank() over (order by v.score desc) as rk from visible v)
    select x.rk, p.id, p.username, p.display_name,
        case when coalesce(pr.photo_visibility, 'everyone') = 'everyone' or p.id = (select uid from me) or private.diary_are_friends(p.id, (select uid from me)) then p.avatar_path end,
        x.score, x.rounds, round(100.0 * x.c / nullif(x.n, 0))::int, p.id = (select uid from me)
    from ranked x join public.diary_profiles p on p.id = x.user_id
    left join public.diary_presence pr on pr.user_id = p.id
    where (select uid from me) is not null and (x.rk <= least(greatest(coalesce(p_limit, 50), 1), 100) or x.user_id = (select uid from me))
    order by x.rk, p.display_name;
$$;

-- ---------- Someone's trivia numbers (their profile, and your own Play page) ----------
create or replace function public.diary_trivia_stats(p_user uuid default null)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
    me uuid := auth.uid();
    who uuid := coalesce(p_user, auth.uid());
    today date := private.diary_utc_day();
    out jsonb;
begin
    if me is null or not private.diary_can_see(who, me, 'stats') then return null; end if;
    with answered as (
        select q.category, (x.choice = q.answer) as ok
        from public.diary_trivia_rounds r
        cross join lateral unnest(r.questions[1:coalesce(cardinality(r.answers), 0)], r.answers) as x(qid, choice)
        join public.diary_trivia_questions q on q.id = x.qid
        where r.user_id = who),
    cats as (select category, count(*) as n, count(*) filter (where ok) as c from answered group by category),
    days as (select distinct (finished_at at time zone 'utc')::date as d from public.diary_trivia_rounds
             where user_id = who and kind = 'daily' and finished_at is not null),
    runs as (select d, d + (row_number() over (order by d desc))::int as g from days),
    streak as (select case when (select max(d) from days) >= today - 1
                      then (select count(*) from runs where g = (select g from runs order by d desc limit 1)) else 0 end as n)
    select jsonb_build_object(
        'answered', (select count(*) from answered),
        'correct', (select count(*) filter (where ok) from answered),
        'accuracy', (select round(100.0 * count(*) filter (where ok) / nullif(count(*), 0))::int from answered),
        'score', (select coalesce(sum(score), 0) from public.diary_trivia_rounds where user_id = who and kind <> 'practice' and finished_at is not null),
        'rounds', (select count(*) from public.diary_trivia_rounds where user_id = who and finished_at is not null),
        'best_daily', (select max(score) from public.diary_trivia_rounds where user_id = who and kind = 'daily' and finished_at is not null),
        'streak', (select n from streak),
        'best_category', (select category from cats where n >= 5 order by c::numeric / n desc, n desc limit 1),
        'categories', coalesce((select jsonb_agg(jsonb_build_object('category', category, 'answered', n, 'correct', c) order by n desc) from cats), '[]'::jsonb),
        'today', case when who = me then (select jsonb_object_agg(kind, jsonb_build_object('done', finished_at is not null, 'score', score, 'correct', correct, 'total', cardinality(questions)))
                 from public.diary_trivia_rounds where user_id = me and kind <> 'practice'
                   and period = private.diary_trivia_period(kind)) end
    ) into out;
    return out;
end;
$$;

-- ---------- Today: word, thought, poll, question of the day's results ----------
create or replace function private.diary_daily_pick(p_kind text) returns jsonb language sql stable security definer set search_path = '' as $$
    select d.data || jsonb_build_object('seq', d.seq) from public.diary_daily_items d
    where d.kind = p_kind
      and d.seq = ((private.diary_utc_day() - date '2026-01-01') % greatest((select count(*) from public.diary_daily_items where kind = p_kind), 1)) + 1;
$$;

create or replace function public.diary_daily_today()
returns jsonb language sql stable security definer set search_path = '' as $$
    with poll as (select private.diary_daily_pick('poll') as p),
    mine as (select choice from public.diary_daily_poll_votes where user_id = auth.uid() and day = private.diary_utc_day()),
    counts as (select choice, count(*) as n from public.diary_daily_poll_votes where day = private.diary_utc_day() group by choice)
    select jsonb_build_object(
        'day', private.diary_utc_day(),
        'word', private.diary_daily_pick('word'),
        'thought', private.diary_daily_pick('thought'),
        'poll', (select p from poll) || jsonb_build_object(
            'mine', (select choice from mine),
            'counts', case when exists (select 1 from mine) then (select jsonb_object_agg(choice::text, n) from counts) end)
    ) where auth.uid() is not null;
$$;

create or replace function public.diary_daily_vote(p_choice int)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
    opts int := coalesce(jsonb_array_length(private.diary_daily_pick('poll') -> 'options'), 0);
begin
    if auth.uid() is null then raise exception 'Sign in to vote'; end if;
    if p_choice < 0 or p_choice >= opts then raise exception 'Pick one of the options'; end if;
    insert into public.diary_daily_poll_votes (user_id, day, choice) values (auth.uid(), private.diary_utc_day(), p_choice)
    on conflict (user_id, day) do update set choice = excluded.choice, created_at = now();
    return public.diary_daily_today() -> 'poll';
end;
$$;

-- How everyone answered today's question of the day (only once you've answered it yourself)
create or replace function public.diary_trivia_qotd_results()
returns jsonb language sql stable security definer set search_path = '' as $$
    select case when exists (select 1 from public.diary_trivia_rounds where user_id = auth.uid() and kind = 'qotd'
                             and period = private.diary_trivia_period('qotd') and finished_at is not null)
        then (select jsonb_build_object('total', count(*), 'counts', jsonb_object_agg(c, n)) from (
                select answers[1]::text as c, count(*) as n from public.diary_trivia_rounds
                where kind = 'qotd' and period = private.diary_trivia_period('qotd') and finished_at is not null group by answers[1]) t) end;
$$;

-- ---------- "You placed #3 of 20" ----------
alter table public.diary_notifications drop constraint diary_notifications_type_check;
alter table public.diary_notifications add constraint diary_notifications_type_check check (type in (
    'friend_request', 'friend_accepted', 'entry_like', 'entry_comment', 'post_like', 'post_comment', 'community_post',
    'community_join', 'call_started', 'missed_call', 'entry_repost', 'reel_like', 'reel_comment', 'library_like',
    'live_started', 'new_follower', 'book_request', 'book_request_update', 'book_message', 'entry_reaction',
    'story_reaction', 'mention', 'reply', 'new_login', 'post_activity', 'scheduled_published', 'scheduled_failed', 'trivia_rank'));

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
        when t in ('trivia_rank') then 'games'
        else 'account'
    end;
$$;

create or replace function private.diary_trivia_notify_ranks(p_kind text)
returns int language plpgsql security definer set search_path = '' as $$
declare
    per text := case when p_kind = 'weekly' then to_char((now() at time zone 'utc') - interval '7 days', 'IYYY-"W"IW')
                     else to_char((now() at time zone 'utc') - interval '1 day', 'YYYY-MM-DD') end;
    n int;
begin
    with r as (
        select user_id, score, correct, cardinality(questions) as total_q,
            rank() over (order by score desc, total_ms asc) as rk, count(*) over () as players
        from public.diary_trivia_rounds where kind = p_kind and period = per and finished_at is not null)
    insert into public.diary_notifications (user_id, actor, type, data)
    select user_id, user_id, 'trivia_rank', jsonb_build_object('kind', p_kind, 'period', per, 'rank', rk, 'players', players,
        'score', score, 'correct', correct, 'total', total_q)
    from r where players >= 2;
    get diagnostics n = row_count;
    return n;
end;
$$;

select cron.unschedule(jobid) from cron.job where jobname in ('diary-trivia-daily-ranks', 'diary-trivia-weekly-ranks');
select cron.schedule('diary-trivia-daily-ranks', '10 0 * * *', $$select private.diary_trivia_notify_ranks('daily')$$);
select cron.schedule('diary-trivia-weekly-ranks', '20 0 * * 1', $$select private.diary_trivia_notify_ranks('weekly')$$);

revoke all on function public.diary_trivia_start(text, text), public.diary_trivia_seen(uuid), public.diary_trivia_answer(uuid, int, int),
    public.diary_trivia_leaderboard(text, text, int), public.diary_trivia_stats(uuid), public.diary_daily_today(),
    public.diary_daily_vote(int), public.diary_trivia_qotd_results() from public, anon;
grant execute on function public.diary_trivia_start(text, text), public.diary_trivia_seen(uuid), public.diary_trivia_answer(uuid, int, int),
    public.diary_trivia_leaderboard(text, text, int), public.diary_trivia_stats(uuid), public.diary_daily_today(),
    public.diary_daily_vote(int), public.diary_trivia_qotd_results() to authenticated;
revoke all on function private.diary_trivia_view(uuid), private.diary_daily_pick(text), private.diary_trivia_notify_ranks(text) from public, anon, authenticated;
