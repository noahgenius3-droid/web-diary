-- Wordplay: a Scrabble-style daily board joins the Playnote games.
-- "moves" carries the board score (the words' points), capped so a tampered client can't run away with the leaderboard.
alter table public.diary_game_scores drop constraint diary_game_scores_game_check;
alter table public.diary_game_scores add constraint diary_game_scores_game_check
    check (game in ('five', 'wordsearch', 'sudoku', 'memory', 'maths', 'slide', 'wordplay'));
alter table public.diary_game_settings drop constraint diary_game_settings_game_check;
alter table public.diary_game_settings add constraint diary_game_settings_game_check
    check (game in ('five', 'wordsearch', 'sudoku', 'memory', 'maths', 'slide', 'wordplay'));

create or replace function public.diary_game_submit(p_game text, p_won boolean, p_moves integer, p_time_ms integer, p_day date default null)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $function$
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
    if p_game not in ('five', 'wordsearch', 'sudoku', 'memory', 'maths', 'slide', 'wordplay') then raise exception 'Unknown game'; end if;
    if not private.diary_game_enabled(p_game) then raise exception 'That game is paused right now'; end if;
    if d not in (today, today - 1) then raise exception 'That puzzle has expired'; end if;
    min_secs := case p_game when 'five' then 4 when 'wordsearch' then 15 when 'sudoku' then 45 when 'memory' then 8 when 'maths' then 0 when 'wordplay' then 20 else 10 end;
    if secs < min_secs and (v_won or p_game in ('wordsearch', 'maths')) then raise exception 'That was impossibly fast'; end if;
    pts := case p_game
        when 'five' then case when v_won and mv between 1 and 6 then 100 * (7 - mv) + greatest(0, 100 - secs::int) else 0 end
        when 'wordsearch' then least(mv, 10) * 40 + case when v_won then greatest(0, 300 - secs::int) else 0 end
        when 'sudoku' then case when v_won then greatest(150, 1200 - secs::int - least(mv, 20) * 30) else 0 end
        when 'memory' then case when v_won and mv >= 8 then greatest(60, 700 - (mv - 8) * 25 - secs::int * 2) else 0 end
        when 'maths' then least(mv, 45) * 20
        when 'wordplay' then least(mv, 450) * 3
        else case when v_won and mv >= 10 then greatest(80, 900 - mv * 2 - secs::int) else 0 end
    end;
    is_ranked := d = today and not exists (select 1 from public.diary_game_scores g where g.user_id = me and g.game = p_game and g.day = d and g.ranked);
    insert into public.diary_game_scores (user_id, game, day, ranked, won, moves, time_ms, score)
    values (me, p_game, d, is_ranked, v_won, mv, least(greatest(coalesce(p_time_ms, 0), 0), 86400000), pts);
    select max(g.score) into best from public.diary_game_scores g where g.user_id = me and g.game = p_game and g.day = d;
    return jsonb_build_object('score', pts, 'ranked', is_ranked, 'best_today', best, 'badges', public.diary_check_badges());
end;
$function$;
