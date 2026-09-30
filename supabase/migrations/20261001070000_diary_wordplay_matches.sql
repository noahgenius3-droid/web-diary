-- Wordplay with friends: turn-based matches for 2 to 4 players.
-- The server is the referee: it deals the tiles, checks every move against the rules and the dictionary, and scores it.
-- Racks are private (each player reads only their own) and the bag lives in the private schema, so nobody can peek.

create table public.diary_wp_matches (
    id uuid primary key default gen_random_uuid(),
    created_by uuid not null references public.diary_profiles (id) on delete cascade,
    players uuid[] not null,                 -- turn order
    out_players uuid[] not null default '{}', -- resigned
    status text not null default 'active' check (status in ('active', 'finished')),
    board text not null check (length(board) = 81), -- 9 x 9, row by row, '.' = empty
    turn int not null default 0,              -- index into players (0-based)
    moves int not null default 0,
    scores jsonb not null default '{}',
    bag_count int not null default 0,
    passes int not null default 0,            -- scoreless turns in a row (passes and swaps)
    last_move jsonb,
    winner uuid,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    finished_at timestamptz
);
create index diary_wp_matches_players on public.diary_wp_matches using gin (players);
alter table public.diary_wp_matches enable row level security;
create policy "Players see their matches" on public.diary_wp_matches for select to authenticated using ((select auth.uid()) = any (players));
grant select on public.diary_wp_matches to authenticated;

create table public.diary_wp_racks (
    match_id uuid not null references public.diary_wp_matches (id) on delete cascade,
    user_id uuid not null references public.diary_profiles (id) on delete cascade,
    rack text not null default '',
    primary key (match_id, user_id)
);
alter table public.diary_wp_racks enable row level security;
create policy "Players see their own rack" on public.diary_wp_racks for select to authenticated using (user_id = (select auth.uid()));
grant select on public.diary_wp_racks to authenticated;

create table private.diary_wp_bags (
    match_id uuid primary key references public.diary_wp_matches (id) on delete cascade,
    bag text not null default ''
);

alter publication supabase_realtime add table public.diary_wp_matches;

-- Notifications: invites, your turn, match over (all in the "games" category)
alter table public.diary_notifications drop constraint diary_notifications_type_check;
alter table public.diary_notifications add constraint diary_notifications_type_check check (type in (
    'friend_request', 'friend_accepted', 'entry_like', 'entry_comment', 'post_like', 'post_comment', 'community_post', 'community_join',
    'call_started', 'missed_call', 'entry_repost', 'reel_like', 'reel_comment', 'library_like', 'live_started', 'new_follower',
    'book_request', 'book_request_update', 'book_message', 'entry_reaction', 'story_reaction', 'mention', 'reply', 'new_login',
    'post_activity', 'scheduled_published', 'scheduled_failed', 'trivia_rank', 'badge_earned', 'announcement', 'verification_update',
    'game_invite', 'game_turn', 'game_over'));

create or replace function private.diary_notif_category(t text)
returns text
language sql
immutable
set search_path to ''
as $$
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
                        'scheduled_published', 'scheduled_failed', 'post_activity', 'game_invite', 'game_turn', 'game_over') then
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

-- ---------- Rules ----------
create or replace function private.diary_wp_val(ch text)
returns int
language sql
immutable
set search_path to ''
as $$
    select case
        when ch in ('A', 'E', 'I', 'L', 'N', 'O', 'R', 'S', 'T', 'U') then 1
        when ch in ('D', 'G') then 2
        when ch in ('B', 'C', 'M', 'P') then 3
        when ch in ('F', 'H', 'V', 'W', 'Y') then 4
        when ch = 'K' then 5
        when ch in ('J', 'X') then 8
        when ch in ('Q', 'Z') then 10
        else 0 end;
$$;

create or replace function private.diary_wp_rack_value(rk text)
returns int
language sql
immutable
set search_path to ''
as $$ select coalesce(sum(private.diary_wp_val(ch)), 0)::int from regexp_split_to_table(coalesce(rk, ''), '') ch where ch <> ''; $$;

-- Same layout as games.js (WP_BONUS)
create or replace function private.diary_wp_bonus(r int, c int)
returns text
language sql
immutable
set search_path to ''
as $$
    select case
        when (r, c) in ((0, 0), (0, 8), (8, 0), (8, 8)) then 'tw'
        when (r, c) in ((1, 1), (2, 2), (6, 6), (7, 7), (1, 7), (2, 6), (6, 2), (7, 1)) then 'dw'
        when (r, c) in ((1, 4), (4, 1), (4, 7), (7, 4)) then 'tl'
        when (r, c) in ((0, 2), (0, 6), (2, 0), (6, 0), (8, 2), (8, 6), (2, 8), (6, 8), (3, 3), (3, 5), (5, 3), (5, 5)) then 'dl'
        else '' end;
$$;

-- The whole word running through (r0, c0) in direction (dr, dc), its score (bonuses count only under new tiles),
-- and whether it uses a tile that was already on the board
create or replace function private.diary_wp_word(b text, nc int[], r0 int, c0 int, dr int, dc int)
returns jsonb
language plpgsql
immutable
set search_path to ''
as $$
declare
    r int := r0; c int := c0; w text := ''; s int := 0; mul int := 1; v int; bn text; old boolean := false; ch text;
begin
    while r - dr >= 0 and c - dc >= 0 and substr(b, (r - dr) * 9 + (c - dc) + 1, 1) <> '.' loop
        r := r - dr; c := c - dc;
    end loop;
    while r <= 8 and c <= 8 and substr(b, r * 9 + c + 1, 1) <> '.' loop
        ch := substr(b, r * 9 + c + 1, 1);
        v := private.diary_wp_val(ch);
        if (r * 9 + c) = any (nc) then
            bn := private.diary_wp_bonus(r, c);
            if bn = 'dl' then v := v * 2; elsif bn = 'tl' then v := v * 3; elsif bn = 'dw' then mul := mul * 2; elsif bn = 'tw' then mul := mul * 3; end if;
        else
            old := true;
        end if;
        w := w || ch; s := s + v; r := r + dr; c := c + dc;
    end loop;
    return jsonb_build_object('word', w, 'points', s * mul, 'old', old);
end;
$$;

-- Next player still in the game after index t
create or replace function private.diary_wp_next(p_players uuid[], p_out uuid[], t int)
returns int
language plpgsql
immutable
set search_path to ''
as $$
declare n int := cardinality(p_players); i int := t;
begin
    for k in 1 .. n loop
        i := (i + 1) % n;
        if not (p_players[i + 1] = any (p_out)) then return i; end if;
    end loop;
    return t;
end;
$$;

-- End of the match: everyone loses what's left on their rack; whoever went out gains it all
create or replace function private.diary_wp_finish(p_match uuid, p_went_out uuid, p_actor uuid)
returns void
language plpgsql
security definer
set search_path to ''
as $$
declare
    m public.diary_wp_matches;
    sc jsonb;
    left_total int := 0;
    rv int;
    x record;
    best int := null;
    win uuid := null;
    ties int := 0;
    p uuid;
begin
    select * into m from public.diary_wp_matches where id = p_match for update;
    sc := m.scores;
    for x in select user_id, rack from public.diary_wp_racks where match_id = p_match and not (user_id = any (m.out_players)) loop
        rv := private.diary_wp_rack_value(x.rack);
        left_total := left_total + rv;
        sc := jsonb_set(sc, array[x.user_id::text], to_jsonb(coalesce((sc ->> x.user_id::text)::int, 0) - rv));
    end loop;
    if p_went_out is not null then
        sc := jsonb_set(sc, array[p_went_out::text], to_jsonb(coalesce((sc ->> p_went_out::text)::int, 0) + left_total));
    end if;
    foreach p in array m.players loop
        continue when p = any (m.out_players);
        if best is null or (sc ->> p::text)::int > best then best := (sc ->> p::text)::int; win := p; ties := 0;
        elsif (sc ->> p::text)::int = best then ties := ties + 1; end if;
    end loop;
    update public.diary_wp_matches set status = 'finished', scores = sc, winner = case when ties = 0 then win end,
        finished_at = now(), updated_at = now() where id = p_match;
    foreach p in array m.players loop
        perform private.diary_notify(p, p_actor, 'game_over', jsonb_build_object('match_id', p_match, 'won', ties = 0 and win = p,
            'score', coalesce((sc ->> p::text)::int, 0)));
    end loop;
end;
$$;

-- ---------- Starting a match ----------
create or replace function public.diary_wp_new(p_opponents uuid[], p_start text)
returns uuid
language plpgsql
security definer
set search_path to ''
as $$
declare
    me uuid := auth.uid();
    opp uuid[];
    o uuid;
    st text := upper(coalesce(p_start, ''));
    v_board text := repeat('.', 81);
    v_bag text := '';
    v_players uuid[];
    mid uuid;
    p uuid;
    sc jsonb := '{}';
begin
    if me is null then raise exception 'Sign in to play'; end if;
    select array_agg(distinct x) into opp from unnest(p_opponents) x where x is not null and x <> me;
    if opp is null or cardinality(opp) not between 1 and 3 then raise exception 'Pick one, two or three friends to play with'; end if;
    foreach o in array opp loop
        if not private.diary_are_friends(me, o) or private.diary_blocked(me, o) then raise exception 'You can only play with your friends'; end if;
    end loop;
    if (select count(*) from public.diary_wp_matches where me = any (players) and status = 'active') >= 20 then
        raise exception 'You have 20 matches going — finish some first';
    end if;
    if st !~ '^[A-Z]{5}$' or not exists (select 1 from public.diary_words where word = lower(st)) then raise exception 'Bad starting word'; end if;
    v_board := overlay(v_board placing st from 4 * 9 + 2 + 1 for 5);
    -- A standard bag without blanks (98 tiles), minus the starting word, shuffled
    select string_agg(repeat(l, n), '') into v_bag from (values ('A', 9), ('B', 2), ('C', 2), ('D', 4), ('E', 12), ('F', 2), ('G', 3), ('H', 2), ('I', 9),
        ('J', 1), ('K', 1), ('L', 4), ('M', 2), ('N', 6), ('O', 8), ('P', 2), ('Q', 1), ('R', 6), ('S', 4), ('T', 6), ('U', 4), ('V', 2), ('W', 2),
        ('X', 1), ('Y', 2), ('Z', 1)) d(l, n);
    for i in 1 .. 5 loop v_bag := overlay(v_bag placing '' from position(substr(st, i, 1) in v_bag) for 1); end loop;
    select string_agg(ch, '' order by random()) into v_bag from regexp_split_to_table(v_bag, '') ch;
    v_players := array[me] || opp;
    foreach p in array v_players loop sc := sc || jsonb_build_object(p::text, 0); end loop;
    insert into public.diary_wp_matches (created_by, players, board, scores, bag_count)
    values (me, v_players, v_board, sc, length(v_bag) - 7 * cardinality(v_players)) returning id into mid;
    foreach p in array v_players loop
        insert into public.diary_wp_racks (match_id, user_id, rack) values (mid, p, left(v_bag, 7));
        v_bag := substr(v_bag, 8);
    end loop;
    insert into private.diary_wp_bags (match_id, bag) values (mid, v_bag);
    foreach o in array opp loop
        perform private.diary_notify(o, me, 'game_invite', jsonb_build_object('match_id', mid, 'players', cardinality(v_players)));
    end loop;
    return mid;
end;
$$;

-- ---------- Playing a word ----------
create or replace function public.diary_wp_play(p_match uuid, p_tiles jsonb)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $$
declare
    me uuid := auth.uid();
    m public.diary_wp_matches;
    rk text;
    bg text;
    t jsonb;
    r int; c int; ch text;
    newb text;
    cells int[] := '{}';
    n int;
    across boolean;
    lo int; hi int;
    wj jsonb;
    words jsonb := '[]';
    bad text;
    total int;
    draw int;
    k int;
    nxt int;
begin
    select * into m from public.diary_wp_matches where id = p_match for update;
    if not found or not (me = any (m.players)) then raise exception 'Match not found'; end if;
    if m.status <> 'active' then raise exception 'This match is over'; end if;
    if m.players[m.turn + 1] <> me then raise exception 'It isn’t your turn'; end if;
    select rack into rk from public.diary_wp_racks where match_id = p_match and user_id = me;
    n := coalesce(jsonb_array_length(p_tiles), 0);
    if n < 1 or n > 7 then raise exception 'Place between one and seven letters'; end if;
    newb := m.board;
    for t in select * from jsonb_array_elements(p_tiles) loop
        r := (t ->> 'r')::int; c := (t ->> 'c')::int; ch := upper(coalesce(t ->> 'ch', ''));
        if r is null or c is null or r not between 0 and 8 or c not between 0 and 8 or ch !~ '^[A-Z]$' then raise exception 'That move isn’t valid'; end if;
        if substr(newb, r * 9 + c + 1, 1) <> '.' then raise exception 'That square is already taken'; end if;
        if position(ch in rk) = 0 then raise exception 'You don’t have that letter'; end if;
        rk := overlay(rk placing '' from position(ch in rk) for 1);
        newb := overlay(newb placing ch from r * 9 + c + 1 for 1);
        cells := cells || (r * 9 + c);
    end loop;
    -- One straight line
    if n > 1 then
        if (select count(distinct x / 9) from unnest(cells) x) = 1 then across := true;
        elsif (select count(distinct x % 9) from unnest(cells) x) = 1 then across := false;
        else raise exception 'Letters must go in one straight line'; end if;
    else
        r := cells[1] / 9; c := cells[1] % 9;
        across := (c > 0 and substr(newb, r * 9 + c, 1) <> '.') or (c < 8 and substr(newb, r * 9 + c + 2, 1) <> '.');
    end if;
    -- No gaps
    if across then
        r := cells[1] / 9;
        select min(x % 9), max(x % 9) into lo, hi from unnest(cells) x;
        for k in lo .. hi loop if substr(newb, r * 9 + k + 1, 1) = '.' then raise exception 'No gaps between your letters'; end if; end loop;
    else
        c := cells[1] % 9;
        select min(x / 9), max(x / 9) into lo, hi from unnest(cells) x;
        for k in lo .. hi loop if substr(newb, k * 9 + c + 1, 1) = '.' then raise exception 'No gaps between your letters'; end if; end loop;
    end if;
    -- Every word made
    wj := private.diary_wp_word(newb, cells, cells[1] / 9, cells[1] % 9, case when across then 0 else 1 end, case when across then 1 else 0 end);
    if length(wj ->> 'word') > 1 then words := words || jsonb_build_array(wj); end if;
    foreach k in array cells loop
        wj := private.diary_wp_word(newb, cells, k / 9, k % 9, case when across then 1 else 0 end, case when across then 0 else 1 end);
        if length(wj ->> 'word') > 1 then words := words || jsonb_build_array(wj); end if;
    end loop;
    if jsonb_array_length(words) = 0 then raise exception 'Make a word of two letters or more'; end if;
    if not exists (select 1 from jsonb_array_elements(words) x where (x ->> 'old')::boolean) then raise exception 'Join onto a word already on the board'; end if;
    select x ->> 'word' into bad from jsonb_array_elements(words) x
        where not exists (select 1 from public.diary_words d where d.word = lower(x ->> 'word')) limit 1;
    if bad is not null then raise exception '% isn’t in our dictionary', bad; end if;
    select sum((x ->> 'points')::int) into total from jsonb_array_elements(words) x;
    if n = 7 then total := total + 50; end if;
    -- Refill the rack
    select bag into bg from private.diary_wp_bags where match_id = p_match for update;
    draw := least(n, length(bg));
    rk := rk || left(bg, draw);
    bg := substr(bg, draw + 1);
    update private.diary_wp_bags set bag = bg where match_id = p_match;
    update public.diary_wp_racks set rack = rk where match_id = p_match and user_id = me;
    nxt := private.diary_wp_next(m.players, m.out_players, m.turn);
    update public.diary_wp_matches set
        board = newb,
        scores = jsonb_set(scores, array[me::text], to_jsonb(coalesce((scores ->> me::text)::int, 0) + total)),
        bag_count = length(bg),
        passes = 0,
        moves = moves + 1,
        turn = nxt,
        last_move = jsonb_build_object('user', me, 'kind', 'play', 'cells', to_jsonb(cells), 'points', total,
            'words', (select jsonb_agg(jsonb_build_object('word', x ->> 'word', 'points', (x ->> 'points')::int)) from jsonb_array_elements(words) x),
            'bingo', n = 7),
        updated_at = now()
    where id = p_match;
    if rk = '' and bg = '' then
        perform private.diary_wp_finish(p_match, me, me);
    else
        perform private.diary_notify(m.players[nxt + 1], me, 'game_turn', jsonb_build_object('match_id', p_match, 'points', total,
            'word', (select x ->> 'word' from jsonb_array_elements(words) x order by (x ->> 'points')::int desc limit 1)));
    end if;
    return jsonb_build_object('points', total, 'rack', rk);
end;
$$;

-- ---------- Passing, swapping, resigning ----------
create or replace function private.diary_wp_scoreless(p_match uuid, p_kind text, p_actor uuid)
returns void
language plpgsql
security definer
set search_path to ''
as $$
declare
    m public.diary_wp_matches;
    nxt int;
begin
    select * into m from public.diary_wp_matches where id = p_match for update;
    nxt := private.diary_wp_next(m.players, m.out_players, m.turn);
    update public.diary_wp_matches set passes = passes + 1, moves = moves + 1, turn = nxt, updated_at = now(),
        last_move = jsonb_build_object('user', p_actor, 'kind', p_kind, 'cells', '[]'::jsonb, 'points', 0)
    where id = p_match;
    -- Two scoreless rounds in a row from everyone still playing ends the match
    if m.passes + 1 >= 2 * (cardinality(m.players) - cardinality(m.out_players)) then
        perform private.diary_wp_finish(p_match, null, p_actor);
    else
        perform private.diary_notify(m.players[nxt + 1], p_actor, 'game_turn', jsonb_build_object('match_id', p_match, 'kind', p_kind));
    end if;
end;
$$;

create or replace function public.diary_wp_pass(p_match uuid)
returns void
language plpgsql
security definer
set search_path to ''
as $$
declare
    me uuid := auth.uid();
    m public.diary_wp_matches;
begin
    select * into m from public.diary_wp_matches where id = p_match for update;
    if not found or not (me = any (m.players)) then raise exception 'Match not found'; end if;
    if m.status <> 'active' then raise exception 'This match is over'; end if;
    if m.players[m.turn + 1] <> me then raise exception 'It isn’t your turn'; end if;
    perform private.diary_wp_scoreless(p_match, 'pass', me);
end;
$$;

create or replace function public.diary_wp_swap(p_match uuid, p_letters text)
returns text
language plpgsql
security definer
set search_path to ''
as $$
declare
    me uuid := auth.uid();
    m public.diary_wp_matches;
    rk text;
    bg text;
    give text := upper(coalesce(p_letters, ''));
    ch text;
begin
    select * into m from public.diary_wp_matches where id = p_match for update;
    if not found or not (me = any (m.players)) then raise exception 'Match not found'; end if;
    if m.status <> 'active' then raise exception 'This match is over'; end if;
    if m.players[m.turn + 1] <> me then raise exception 'It isn’t your turn'; end if;
    if give !~ '^[A-Z]{1,7}$' then raise exception 'Pick the letters to swap'; end if;
    select rack into rk from public.diary_wp_racks where match_id = p_match and user_id = me;
    select bag into bg from private.diary_wp_bags where match_id = p_match for update;
    if length(bg) < length(give) then raise exception 'Not enough letters left in the bag to swap'; end if;
    foreach ch in array regexp_split_to_array(give, '') loop
        if position(ch in rk) = 0 then raise exception 'You don’t have that letter'; end if;
        rk := overlay(rk placing '' from position(ch in rk) for 1);
    end loop;
    rk := rk || left(bg, length(give));
    bg := substr(bg, length(give) + 1) || give;
    select string_agg(x, '' order by random()) into bg from regexp_split_to_table(bg, '') x;
    update private.diary_wp_bags set bag = bg where match_id = p_match;
    update public.diary_wp_racks set rack = rk where match_id = p_match and user_id = me;
    perform private.diary_wp_scoreless(p_match, 'swap', me);
    return rk;
end;
$$;

create or replace function public.diary_wp_resign(p_match uuid)
returns void
language plpgsql
security definer
set search_path to ''
as $$
declare
    me uuid := auth.uid();
    m public.diary_wp_matches;
    outs uuid[];
    p uuid;
begin
    select * into m from public.diary_wp_matches where id = p_match for update;
    if not found or not (me = any (m.players)) then raise exception 'Match not found'; end if;
    if m.status <> 'active' then raise exception 'This match is over'; end if;
    if me = any (m.out_players) then return; end if;
    outs := m.out_players || me;
    update public.diary_wp_matches set out_players = outs, updated_at = now(),
        turn = case when players[turn + 1] = me then private.diary_wp_next(players, outs, turn) else turn end,
        last_move = jsonb_build_object('user', me, 'kind', 'resign', 'cells', '[]'::jsonb, 'points', 0)
    where id = p_match;
    if cardinality(m.players) - cardinality(outs) <= 1 then
        -- Last one standing wins, whatever the scores
        select x into p from unnest(m.players) x where not (x = any (outs));
        update public.diary_wp_matches set status = 'finished', winner = p, finished_at = now() where id = p_match;
        perform private.diary_notify(p, me, 'game_over', jsonb_build_object('match_id', p_match, 'won', true, 'resigned', true));
    elsif m.players[m.turn + 1] = me then
        perform private.diary_notify(m.players[private.diary_wp_next(m.players, outs, m.turn) + 1], me, 'game_turn', jsonb_build_object('match_id', p_match, 'kind', 'resign'));
    end if;
end;
$$;

revoke all on function public.diary_wp_new(uuid[], text), public.diary_wp_play(uuid, jsonb), public.diary_wp_pass(uuid),
    public.diary_wp_swap(uuid, text), public.diary_wp_resign(uuid) from public, anon;
grant execute on function public.diary_wp_new(uuid[], text), public.diary_wp_play(uuid, jsonb), public.diary_wp_pass(uuid),
    public.diary_wp_swap(uuid, text), public.diary_wp_resign(uuid) to authenticated;
