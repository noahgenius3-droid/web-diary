-- Phase E: admin controls (questions, games, leaderboards, badges, accounts, content, scheduled posts,
-- announcements) and profile verification. Every admin action is written to the audit log.

create or replace function private.diary_require_admin() returns uuid language plpgsql stable security definer set search_path = '' as $$
begin
    if not private.diary_is_app_admin(auth.uid()) then raise exception 'Only Cordial admins can do that'; end if;
    return auth.uid();
end;
$$;
create or replace function private.diary_audit(p_action text, p_target uuid, p_details jsonb default '{}'::jsonb)
returns void language sql security definer set search_path = '' as $$
    insert into public.diary_audit_log (actor, action, target_user, details) values (auth.uid(), p_action, p_target, coalesce(p_details, '{}'::jsonb));
$$;

-- ---------- Verification ----------
alter table public.diary_profiles add column if not exists verified text check (verified in ('person', 'organisation', 'minister', 'educator', 'administrator'));
create table if not exists public.diary_verification_requests (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null default auth.uid() references public.diary_profiles (id) on delete cascade,
    kind text not null check (kind in ('person', 'organisation', 'minister', 'educator', 'administrator')),
    note text not null default '' check (char_length(note) <= 600),
    link text not null default '' check (char_length(link) <= 300),
    status text not null default 'pending' check (status in ('pending', 'approved', 'declined')),
    response text,
    handled_by uuid references public.diary_profiles (id) on delete set null,
    handled_at timestamptz,
    created_at timestamptz not null default now()
);
create unique index if not exists diary_verification_one_pending on public.diary_verification_requests (user_id) where status = 'pending';
alter table public.diary_verification_requests enable row level security;
create policy "Your verification requests" on public.diary_verification_requests for select to authenticated
    using (user_id = (select auth.uid()) or private.diary_is_app_admin((select auth.uid())));
create policy "Ask to be verified" on public.diary_verification_requests for insert to authenticated
    with check (user_id = (select auth.uid()) and status = 'pending' and not private.diary_is_suspended((select auth.uid())));
revoke all on public.diary_verification_requests from anon, authenticated;
grant select, insert (kind, note, link) on public.diary_verification_requests to authenticated;

-- Who's verified (small list, cached by the app to draw the tick next to names)
create or replace function public.diary_verified_list() returns table (id uuid, verified text)
language sql stable security definer set search_path = '' as $$
    select p.id, p.verified from public.diary_profiles p where p.verified is not null and auth.uid() is not null;
$$;

create or replace function public.diary_admin_verify(p_request uuid, p_approve boolean, p_note text default null)
returns void language plpgsql security definer set search_path = '' as $$
declare
    me uuid := private.diary_require_admin();
    r public.diary_verification_requests;
begin
    select * into r from public.diary_verification_requests where id = p_request and status = 'pending' for update;
    if not found then raise exception 'That request has already been handled'; end if;
    update public.diary_verification_requests set status = case when p_approve then 'approved' else 'declined' end,
        response = left(p_note, 300), handled_by = me, handled_at = now() where id = r.id;
    if p_approve then update public.diary_profiles set verified = r.kind where id = r.user_id; end if;
    perform private.diary_audit(case when p_approve then 'verify_approve' else 'verify_decline' end, r.user_id, jsonb_build_object('kind', r.kind, 'note', p_note));
    insert into public.diary_notifications (user_id, actor, type, data)
    values (r.user_id, me, 'verification_update', jsonb_build_object('approved', p_approve, 'kind', r.kind, 'note', left(p_note, 200)));
end;
$$;

create or replace function public.diary_admin_set_verified(p_user uuid, p_kind text)
returns void language plpgsql security definer set search_path = '' as $$
begin
    perform private.diary_require_admin();
    if p_kind is not null and p_kind not in ('person', 'organisation', 'minister', 'educator', 'administrator') then raise exception 'Unknown kind'; end if;
    update public.diary_profiles set verified = p_kind where id = p_user;
    perform private.diary_audit(case when p_kind is null then 'verify_remove' else 'verify_set' end, p_user, jsonb_build_object('kind', p_kind));
end;
$$;

-- ---------- Announcements ----------
create table if not exists public.diary_announcements (
    id uuid primary key default gen_random_uuid(),
    title text not null check (char_length(title) between 1 and 120),
    body text not null default '' check (char_length(body) <= 1000),
    link text not null default '' check (char_length(link) <= 300),
    created_by uuid references public.diary_profiles (id) on delete set null,
    created_at timestamptz not null default now(),
    expires_at timestamptz,
    active boolean not null default true
);
alter table public.diary_announcements enable row level security;
create policy "Current announcements" on public.diary_announcements for select to authenticated
    using ((active and (expires_at is null or expires_at > now())) or private.diary_is_app_admin((select auth.uid())));
revoke all on public.diary_announcements from anon, authenticated;
grant select on public.diary_announcements to authenticated;

create or replace function public.diary_admin_announce(p_title text, p_body text, p_link text default '', p_days int default 7, p_notify boolean default true)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
    me uuid := private.diary_require_admin();
    aid uuid;
begin
    insert into public.diary_announcements (title, body, link, created_by, expires_at)
    values (btrim(p_title), coalesce(btrim(p_body), ''), coalesce(btrim(p_link), ''), me, case when p_days > 0 then now() + make_interval(days => p_days) end)
    returning id into aid;
    if p_notify then
        insert into public.diary_notifications (user_id, actor, type, data)
        select p.id, me, 'announcement', jsonb_build_object('announcement', aid, 'title', left(btrim(p_title), 120), 'snippet', left(coalesce(p_body, ''), 160))
        from public.diary_profiles p where p.id <> me;
    end if;
    perform private.diary_audit('announce', null, jsonb_build_object('title', p_title, 'notify', p_notify));
    return aid;
end;
$$;
create or replace function public.diary_admin_end_announcement(p_id uuid) returns void language plpgsql security definer set search_path = '' as $$
begin
    perform private.diary_require_admin();
    update public.diary_announcements set active = false where id = p_id;
    perform private.diary_audit('announce_end', null, jsonb_build_object('id', p_id));
end;
$$;

-- ---------- Trivia questions ----------
create or replace function public.diary_admin_questions(p_category text default null, p_search text default null, p_limit int default 100)
returns setof public.diary_trivia_questions language plpgsql stable security definer set search_path = '' as $$
begin
    perform private.diary_require_admin();
    return query select * from public.diary_trivia_questions q
        where (p_category is null or q.category = p_category)
          and (p_search is null or q.question ilike '%' || p_search || '%')
        order by q.created_at desc limit least(greatest(coalesce(p_limit, 100), 1), 500);
end;
$$;
create or replace function public.diary_admin_save_question(p_id uuid, p_category text, p_difficulty int, p_question text, p_choices text[], p_answer int, p_explanation text, p_active boolean default true)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
    me uuid := private.diary_require_admin();
    qid uuid;
    clean text[];
begin
    select array_agg(btrim(c)) into clean from unnest(p_choices) c where btrim(c) <> '';
    if clean is null or cardinality(clean) < 2 then raise exception 'Give at least two answers'; end if;
    if p_answer < 0 or p_answer >= cardinality(clean) then raise exception 'Pick which answer is right'; end if;
    if p_id is null then
        insert into public.diary_trivia_questions (category, difficulty, question, choices, answer, explanation, active, created_by)
        values (p_category, greatest(1, least(3, p_difficulty)), btrim(p_question), clean, p_answer, coalesce(btrim(p_explanation), ''), coalesce(p_active, true), me)
        returning id into qid;
    else
        update public.diary_trivia_questions set category = p_category, difficulty = greatest(1, least(3, p_difficulty)), question = btrim(p_question),
            choices = clean, answer = p_answer, explanation = coalesce(btrim(p_explanation), ''), active = coalesce(p_active, true)
        where id = p_id returning id into qid;
        if qid is null then raise exception 'Question not found'; end if;
    end if;
    perform private.diary_audit(case when p_id is null then 'question_add' else 'question_edit' end, null, jsonb_build_object('id', qid, 'question', left(p_question, 120)));
    return qid;
end;
$$;

-- ---------- Games: pause one ----------
create table if not exists public.diary_game_settings (
    game text primary key check (game in ('five', 'wordsearch', 'sudoku', 'memory', 'maths', 'slide')),
    enabled boolean not null default true,
    updated_at timestamptz not null default now()
);
alter table public.diary_game_settings enable row level security;
create policy "Anyone signed in can see which games are on" on public.diary_game_settings for select to authenticated using (true);
revoke all on public.diary_game_settings from anon, authenticated;
grant select on public.diary_game_settings to authenticated;
create or replace function public.diary_admin_set_game(p_game text, p_enabled boolean) returns void language plpgsql security definer set search_path = '' as $$
begin
    perform private.diary_require_admin();
    insert into public.diary_game_settings (game, enabled, updated_at) values (p_game, p_enabled, now())
    on conflict (game) do update set enabled = excluded.enabled, updated_at = now();
    perform private.diary_audit(case when p_enabled then 'game_on' else 'game_off' end, null, jsonb_build_object('game', p_game));
end;
$$;

-- ---------- Leaderboards: hide someone, void a score ----------
create table if not exists public.diary_board_bans (
    user_id uuid primary key references public.diary_profiles (id) on delete cascade,
    reason text not null default '',
    by_admin uuid references public.diary_profiles (id) on delete set null,
    created_at timestamptz not null default now()
);
alter table public.diary_board_bans enable row level security;
revoke all on public.diary_board_bans from anon, authenticated;
create or replace function private.diary_on_boards(p_user uuid) returns boolean language sql stable security definer set search_path = '' as $$
    select not exists (select 1 from public.diary_board_bans where user_id = p_user);
$$;
create or replace function public.diary_admin_board_ban(p_user uuid, p_ban boolean, p_reason text default '') returns void language plpgsql security definer set search_path = '' as $$
declare me uuid := private.diary_require_admin();
begin
    if p_ban then
        insert into public.diary_board_bans (user_id, reason, by_admin) values (p_user, left(coalesce(p_reason, ''), 300), me)
        on conflict (user_id) do update set reason = excluded.reason, by_admin = me, created_at = now();
    else
        delete from public.diary_board_bans where user_id = p_user;
    end if;
    perform private.diary_audit(case when p_ban then 'board_hide' else 'board_show' end, p_user, jsonb_build_object('reason', p_reason));
end;
$$;
create or replace function public.diary_admin_void_scores(p_user uuid, p_since timestamptz default null) returns int language plpgsql security definer set search_path = '' as $$
declare
    n int;
    m int;
begin
    perform private.diary_require_admin();
    delete from public.diary_game_scores where user_id = p_user and (p_since is null or created_at >= p_since);
    get diagnostics n = row_count;
    delete from public.diary_trivia_rounds where user_id = p_user and (p_since is null or started_at >= p_since);
    get diagnostics m = row_count;
    perform private.diary_audit('scores_void', p_user, jsonb_build_object('since', p_since, 'games', n, 'rounds', m));
    return n + m;
end;
$$;

-- ---------- Badges by hand ----------
create or replace function public.diary_admin_badge(p_user uuid, p_badge text, p_award boolean) returns void language plpgsql security definer set search_path = '' as $$
declare me uuid := private.diary_require_admin();
begin
    if p_award then
        insert into public.diary_user_badges (user_id, badge) values (p_user, p_badge) on conflict do nothing;
        if found then
            insert into public.diary_notifications (user_id, actor, type, data)
            select p_user, me, 'badge_earned', jsonb_build_object('badge', b.id, 'name', b.name, 'description', b.description, 'tier', b.tier)
            from public.diary_badges b where b.id = p_badge;
        end if;
    else
        delete from public.diary_user_badges where user_id = p_user and badge = p_badge;
    end if;
    perform private.diary_audit(case when p_award then 'badge_award' else 'badge_revoke' end, p_user, jsonb_build_object('badge', p_badge));
end;
$$;

-- ---------- Accounts ----------
create or replace function public.diary_admin_users(p_search text default null, p_limit int default 50)
returns table (id uuid, username text, display_name text, avatar_path text, verified text, created_at timestamptz,
               suspended_until timestamptz, suspended boolean, board_hidden boolean, posts bigint, reports bigint, xp bigint)
language plpgsql stable security definer set search_path = '' as $$
begin
    perform private.diary_require_admin();
    return query select p.id, p.username, p.display_name, p.avatar_path, p.verified, p.created_at,
        s.until, s.user_id is not null and (s.until is null or s.until > now()),
        exists (select 1 from public.diary_board_bans b where b.user_id = p.id),
        (select count(*) from public.diary_shared_entries e where e.author = p.id),
        (select count(*) from public.diary_reports r where r.target_user = p.id),
        private.diary_xp(p.id)
    from public.diary_profiles p left join public.diary_suspensions s on s.user_id = p.id
    where p_search is null or p.username ilike '%' || p_search || '%' or p.display_name ilike '%' || p_search || '%'
    order by p.created_at desc limit least(greatest(coalesce(p_limit, 50), 1), 200);
end;
$$;
create or replace function public.diary_admin_suspend(p_user uuid, p_days int, p_reason text) returns void language plpgsql security definer set search_path = '' as $$
declare me uuid := private.diary_require_admin();
begin
    if p_user = me then raise exception 'You can’t suspend yourself'; end if;
    insert into public.diary_suspensions (user_id, until, reason, by_admin)
    values (p_user, case when p_days > 0 then now() + make_interval(days => p_days) end, left(coalesce(p_reason, ''), 300), me)
    on conflict (user_id) do update set until = excluded.until, reason = excluded.reason, by_admin = me, created_at = now();
    perform private.diary_audit('suspend', p_user, jsonb_build_object('days', p_days, 'reason', p_reason));
end;
$$;

-- ---------- Content ----------
create or replace function public.diary_admin_remove(p_kind text, p_id text, p_reason text default '') returns void language plpgsql security definer set search_path = '' as $$
declare
    owner uuid;
begin
    perform private.diary_require_admin();
    if p_kind = 'entry' then delete from public.diary_shared_entries where id = p_id::uuid returning author into owner;
    elsif p_kind = 'post' then delete from public.diary_community_posts where id = p_id::uuid returning author into owner;
    elsif p_kind = 'comment' then delete from public.diary_comments where id = p_id::uuid returning author into owner;
    else raise exception 'Unknown content'; end if;
    perform private.diary_audit('content_remove', owner, jsonb_build_object('kind', p_kind, 'id', p_id, 'reason', p_reason));
end;
$$;

-- ---------- Scheduled posts ----------
create or replace function public.diary_admin_scheduled(p_limit int default 100)
returns table (id uuid, author uuid, username text, display_name text, target text, title text, body text, publish_at timestamptz, status text)
language plpgsql stable security definer set search_path = '' as $$
begin
    perform private.diary_require_admin();
    return query select x.id, x.author, p.username, p.display_name, x.target, x.title, left(x.body, 300), x.publish_at, x.status
        from public.diary_scheduled x join public.diary_profiles p on p.id = x.author
        where x.status in ('scheduled', 'failed') order by x.publish_at nulls last limit least(greatest(coalesce(p_limit, 100), 1), 500);
end;
$$;
create or replace function public.diary_admin_cancel_scheduled(p_id uuid, p_reason text default '') returns void language plpgsql security definer set search_path = '' as $$
declare a uuid;
begin
    perform private.diary_require_admin();
    update public.diary_scheduled set status = 'cancelled', error = left('Cancelled by a moderator. ' || coalesce(p_reason, ''), 300) where id = p_id returning author into a;
    perform private.diary_audit('scheduled_cancel', a, jsonb_build_object('id', p_id, 'reason', p_reason));
end;
$$;

-- ---------- Notifications ----------
alter table public.diary_notifications drop constraint diary_notifications_type_check;
alter table public.diary_notifications add constraint diary_notifications_type_check check (type in (
    'friend_request', 'friend_accepted', 'entry_like', 'entry_comment', 'post_like', 'post_comment', 'community_post',
    'community_join', 'call_started', 'missed_call', 'entry_repost', 'reel_like', 'reel_comment', 'library_like',
    'live_started', 'new_follower', 'book_request', 'book_request_update', 'book_message', 'entry_reaction',
    'story_reaction', 'mention', 'reply', 'new_login', 'post_activity', 'scheduled_published', 'scheduled_failed', 'trivia_rank',
    'badge_earned', 'announcement', 'verification_update'));

-- ---------- Games refuse scores while paused ----------
create or replace function private.diary_game_enabled(p_game text) returns boolean language sql stable security definer set search_path = '' as $$
    select coalesce((select enabled from public.diary_game_settings where game = p_game), true);
$$;

-- ---------- Leaderboards leave out hidden accounts ----------
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
          and (p_scope <> 'friends' or a.user_id = (select uid from me) or private.diary_are_friends(a.user_id, (select uid from me))))
          and private.diary_on_boards(a.user_id)),
    ranked as (select v.*, rank() over (order by v.score desc) as rk from visible v)
    select x.rk, p.id, p.username, p.display_name,
        case when coalesce(pr.photo_visibility, 'everyone') = 'everyone' or p.id = (select uid from me) or private.diary_are_friends(p.id, (select uid from me)) then p.avatar_path end,
        x.score, x.rounds, round(100.0 * x.c / nullif(x.n, 0))::int, p.id = (select uid from me)
    from ranked x join public.diary_profiles p on p.id = x.user_id
    left join public.diary_presence pr on pr.user_id = p.id
    where (select uid from me) is not null and (x.rk <= least(greatest(coalesce(p_limit, 50), 1), 100) or x.user_id = (select uid from me))
    order by x.rk, p.display_name;
$$;

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
          and (p_scope <> 'friends' or s.u = (select uid from me) or private.diary_are_friends(s.u, (select uid from me))))
          and private.diary_on_boards(s.u)),
    ranked as (select v.*, rank() over (order by v.score desc) as rk from visible v)
    select x.rk, p.id, p.username, p.display_name,
        case when coalesce(pr.photo_visibility, 'everyone') = 'everyone' or p.id = (select uid from me) or private.diary_are_friends(p.id, (select uid from me)) then p.avatar_path end,
        x.score, x.detail, p.id = (select uid from me)
    from ranked x join public.diary_profiles p on p.id = x.u
    left join public.diary_presence pr on pr.user_id = p.id
    where (select uid from me) is not null and (x.rk <= least(greatest(coalesce(p_limit, 50), 1), 100) or x.u = (select uid from me))
    order by x.rk, p.display_name;
$$;

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
    if not private.diary_game_enabled(p_game) then raise exception 'That game is paused right now'; end if;
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

revoke all on function public.diary_verified_list(), public.diary_admin_verify(uuid, boolean, text), public.diary_admin_set_verified(uuid, text),
    public.diary_admin_announce(text, text, text, int, boolean), public.diary_admin_end_announcement(uuid),
    public.diary_admin_questions(text, text, int), public.diary_admin_save_question(uuid, text, int, text, text[], int, text, boolean),
    public.diary_admin_set_game(text, boolean), public.diary_admin_board_ban(uuid, boolean, text), public.diary_admin_void_scores(uuid, timestamptz),
    public.diary_admin_badge(uuid, text, boolean), public.diary_admin_users(text, int), public.diary_admin_suspend(uuid, int, text),
    public.diary_admin_remove(text, text, text), public.diary_admin_scheduled(int), public.diary_admin_cancel_scheduled(uuid, text) from public, anon;
grant execute on function public.diary_verified_list(), public.diary_admin_verify(uuid, boolean, text), public.diary_admin_set_verified(uuid, text),
    public.diary_admin_announce(text, text, text, int, boolean), public.diary_admin_end_announcement(uuid),
    public.diary_admin_questions(text, text, int), public.diary_admin_save_question(uuid, text, int, text, text[], int, text, boolean),
    public.diary_admin_set_game(text, boolean), public.diary_admin_board_ban(uuid, boolean, text), public.diary_admin_void_scores(uuid, timestamptz),
    public.diary_admin_badge(uuid, text, boolean), public.diary_admin_users(text, int), public.diary_admin_suspend(uuid, int, text),
    public.diary_admin_remove(text, text, text), public.diary_admin_scheduled(int), public.diary_admin_cancel_scheduled(uuid, text) to authenticated;
revoke all on function private.diary_require_admin(), private.diary_audit(text, uuid, jsonb), private.diary_on_boards(uuid), private.diary_game_enabled(text) from public, anon, authenticated;
