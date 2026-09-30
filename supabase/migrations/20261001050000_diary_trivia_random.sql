-- Playnote trivia: random questions and shuffled answers.
-- Every round draws its own random questions, favouring ones the player hasn't seen in their last 30 rounds.
-- The question of the day stays shared, because everyone's answers to it are compared.
-- Answer choices are shown in a per-round shuffled order, since most seeded answers were "B".
-- Answers are still stored by their original position, so scores, stats and the admin view are unchanged.

-- The display order of a question's choices in a round: original positions (0-based), shuffled by round + question
create or replace function private.diary_trivia_perm(p_round uuid, p_kind text, p_question uuid, p_n int)
returns int[]
language sql
immutable
set search_path to ''
as $$
    select case when p_kind = 'qotd' then (select array_agg(i order by i) from generate_series(0, p_n - 1) i)
                else (select array_agg(i order by md5(p_round::text || p_question::text || i::text)) from generate_series(0, p_n - 1) i) end;
$$;

create or replace function public.diary_trivia_start(p_kind text, p_category text default null)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $function$
declare
    me uuid := auth.uid();
    per text;
    rid uuid;
    cats text[];
    n int;
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
    if p_kind = 'qotd' then
        -- One shared question a day for everybody
        select array_agg(id) into picked from (
            select q.id from public.diary_trivia_questions q
            where q.active and q.category = any (cats)
            order by md5(q.id::text || 'qotd:' || per) limit n) t;
    else
        -- Your own random draw, unseen questions first
        select array_agg(id) into picked from (
            select q.id from public.diary_trivia_questions q
            where q.active and q.category = any (cats)
            order by (q.id = any (coalesce((select array_agg(x) from (select unnest(r.questions) x from public.diary_trivia_rounds r
                where r.user_id = me order by r.started_at desc limit 30) s), '{}'))), random()
            limit n) t;
    end if;
    if picked is null or cardinality(picked) = 0 then raise exception 'No questions yet in that category'; end if;
    insert into public.diary_trivia_rounds (user_id, kind, category, period, questions)
    values (me, p_kind, case when p_kind = 'practice' then coalesce(p_category, 'random') end, per, picked)
    returning id into rid;
    return private.diary_trivia_view(rid);
end;
$function$;

create or replace function private.diary_trivia_view(p_round uuid)
returns jsonb
language sql
stable
security definer
set search_path to ''
as $function$
    select jsonb_build_object(
        'id', r.id, 'kind', r.kind, 'category', r.category, 'period', r.period,
        'total', cardinality(r.questions), 'index', coalesce(cardinality(r.answers), 0),
        'finished', r.finished_at is not null, 'correct', r.correct, 'score', r.score, 'total_ms', r.total_ms,
        'questions', (select jsonb_agg(jsonb_build_object('id', q.id, 'question', q.question,
                            'choices', (select jsonb_agg(q.choices[pi + 1] order by pn)
                                        from unnest(private.diary_trivia_perm(r.id, r.kind, q.id, cardinality(q.choices))) with ordinality p(pi, pn)),
                            'category', q.category, 'difficulty', q.difficulty) order by o.n)
                      from unnest(r.questions) with ordinality o(qid, n) join public.diary_trivia_questions q on q.id = o.qid),
        'answered', coalesce((select jsonb_agg(jsonb_build_object(
                            'choice', coalesce(array_position(private.diary_trivia_perm(r.id, r.kind, q.id, cardinality(q.choices)), r.answers[o.n]::int) - 1, -1),
                            'answer', array_position(private.diary_trivia_perm(r.id, r.kind, q.id, cardinality(q.choices)), q.answer::int) - 1,
                            'correct', r.answers[o.n] = q.answer, 'explanation', q.explanation) order by o.n)
                      from unnest(r.questions) with ordinality o(qid, n) join public.diary_trivia_questions q on q.id = o.qid
                      where o.n <= coalesce(cardinality(r.answers), 0)), '[]'::jsonb))
    from public.diary_trivia_rounds r where r.id = p_round;
$function$;

create or replace function public.diary_trivia_answer(p_round uuid, p_choice integer, p_ms integer default null)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $function$
declare
    r public.diary_trivia_rounds;
    q public.diary_trivia_questions;
    n int;
    perm int[];
    orig int;
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
    perm := private.diary_trivia_perm(r.id, r.kind, q.id, cardinality(q.choices));
    -- The player picked a position on screen; turn it back into the question's own position
    orig := case when p_choice between 0 and cardinality(perm) - 1 then perm[p_choice + 1] end;
    server_ms := greatest(0, (extract(epoch from (now() - r.last_at)) * 1000)::int);
    ms := least(greatest(coalesce(p_ms, server_ms), 0), server_ms);
    ok := orig is not null and orig = q.answer and server_ms <= 33000;
    pts := case when ok then 60 + 20 * q.difficulty + round(40 * greatest(0, 1 - ms / 30000.0))::int else 0 end;
    update public.diary_trivia_rounds set
        answers = answers || coalesce(orig, -1)::smallint,
        correct = correct + ok::int,
        score = score + pts,
        total_ms = total_ms + least(ms, 30000),
        last_at = now(),
        finished_at = case when n >= cardinality(questions) then now() end
    where id = r.id returning * into r;
    return jsonb_build_object('correct', ok, 'answer', array_position(perm, q.answer::int) - 1, 'explanation', q.explanation, 'points', pts,
        'score', r.score, 'correct_count', r.correct, 'index', n, 'finished', r.finished_at is not null);
end;
$function$;
