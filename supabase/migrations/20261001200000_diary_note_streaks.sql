-- Note streaks: sending a note to a friend's Inbox (a chat message carrying a {"kind":"note"} attachment)
-- keeps a streak going. A day counts when either of you sends the other a note; the streak stays alive
-- until a whole day passes without one. Days follow the caller's own time zone.
create or replace function public.diary_note_streaks(p_tz text default 'UTC')
returns table (friend uuid, streak int, sent_today boolean)
language plpgsql
stable
security definer
set search_path to ''
as $$
declare
    me uuid := auth.uid();
    tz text := 'UTC';
begin
    if me is null then return; end if;
    if p_tz is not null and exists (select 1 from pg_catalog.pg_timezone_names where name = p_tz) then tz := p_tz; end if;
    return query
    with days as (
        select case when m.sender = me then m.recipient else m.sender end as who,
               (m.created_at at time zone tz)::date as d,
               bool_or(m.sender = me) as mine
        from public.diary_messages m
        where me in (m.sender, m.recipient)
          and m.deleted_at is null
          and m.attachments @> '[{"kind":"note"}]'::jsonb
          and m.created_at > now() - interval '400 days'
        group by 1, 2
    ),
    ranked as (
        select who, d, d - (row_number() over (partition by who order by d))::int as grp from days
    ),
    runs as (
        select who, max(d) as last_d, count(*)::int as len from ranked group by who, grp
    )
    select r.who, r.len,
           exists (select 1 from days x where x.who = r.who and x.d = (now() at time zone tz)::date and x.mine)
    from runs r
    where r.last_d >= (now() at time zone tz)::date - 1;
end;
$$;
revoke all on function public.diary_note_streaks(text) from public, anon;
grant execute on function public.diary_note_streaks(text) to authenticated;
