-- View-once notes ("note snaps"), like Snapchat: a note sent to a friend's Inbox arrives sealed. They open it
-- once; when they close it the text is wiped — unless either of you saves it in the chat, where it then
-- stays for both of you (and either can unsave it). The chat message only carries the note's state;
-- the text lives here and is handed out only through the functions below.
-- Streaks are now mutual: a day counts when you BOTH send each other a note.

create table if not exists public.diary_note_snaps (
    id uuid primary key default gen_random_uuid(),
    message_id bigint references public.diary_messages(id) on delete cascade,
    sender uuid not null references public.diary_profiles(id) on delete cascade,
    recipient uuid not null references public.diary_profiles(id) on delete cascade,
    title text check (title is null or length(title) <= 120),
    body text check (body is null or length(body) <= 3000),
    color text,
    opened_at timestamptz,
    saved boolean not null default false,
    saved_by uuid,
    created_at timestamptz not null default now()
);
create index if not exists diary_note_snaps_message on public.diary_note_snaps (message_id);
alter table public.diary_note_snaps enable row level security;
revoke all on public.diary_note_snaps from anon, authenticated; -- only through the functions

-- Write the note's current state into its chat message (both people get it live)
create or replace function private.diary_note_snap_sync(p_snap uuid)
returns void
language plpgsql
security definer
set search_path to ''
as $$
declare
    n public.diary_note_snaps;
    att jsonb;
begin
    select * into n from public.diary_note_snaps where id = p_snap;
    if not found or n.message_id is null then return; end if;
    att := jsonb_build_object('kind', 'note', 'once', true, 'snap', n.id, 'color', n.color,
                              'opened_at', n.opened_at, 'saved', n.saved, 'saved_by', n.saved_by);
    if n.saved then
        att := att || jsonb_build_object('title', n.title, 'text', n.body);
    end if;
    update public.diary_messages set attachments = jsonb_build_array(att) where id = n.message_id;
end;
$$;

-- Send a note to a friend: one sealed message per friend
create or replace function public.diary_note_snap_send(p_recipient uuid, p_title text, p_text text, p_color text, p_message text default '')
returns bigint
language plpgsql
security definer
set search_path to ''
as $$
declare
    me uuid := auth.uid();
    v_snap uuid;
    v_msg bigint;
    v_body text := left(btrim(coalesce(p_message, '')), 300);
begin
    perform private.diary_require_member();
    if me is null then raise exception 'Not signed in'; end if;
    if p_recipient = me then raise exception 'Pick a friend'; end if;
    if not private.diary_are_friends(me, p_recipient) then raise exception 'You can only send notes to friends'; end if;
    if private.diary_blocked(me, p_recipient) then raise exception 'You can’t message this person'; end if;
    if length(btrim(coalesce(p_title, '') || coalesce(p_text, ''))) = 0 then raise exception 'The note is empty'; end if;
    insert into public.diary_note_snaps (sender, recipient, title, body, color)
    values (me, p_recipient, nullif(left(btrim(coalesce(p_title, '')), 120), ''), left(coalesce(p_text, ''), 3000),
            case when p_color ~ '^[a-z]{3,10}$' then p_color else 'purple' end)
    returning id into v_snap;
    insert into public.diary_messages (sender, recipient, body, attachments)
    values (me, p_recipient,
            case when v_body = '' then '' else '<p>' || replace(replace(replace(v_body, '&', '&amp;'), '<', '&lt;'), '>', '&gt;') || '</p>' end,
            jsonb_build_array(jsonb_build_object('kind', 'note', 'once', true, 'snap', v_snap, 'color', p_color, 'saved', false)))
    returning id into v_msg;
    update public.diary_note_snaps set message_id = v_msg where id = v_snap;
    return v_msg;
end;
$$;

-- Open it (the recipient, once — or either of you when it's saved). Returns the note.
create or replace function public.diary_note_snap_open(p_snap uuid)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $$
declare
    me uuid := auth.uid();
    n public.diary_note_snaps;
begin
    select * into n from public.diary_note_snaps where id = p_snap;
    if not found or me not in (n.sender, n.recipient) then raise exception 'That note isn’t available'; end if;
    if not n.saved then
        if me <> n.recipient then raise exception 'Only your friend can open it — unless one of you saves it'; end if;
        if n.opened_at is not null and n.body is null and n.title is null then
            raise exception 'This note was view-once and has been opened';
        end if;
        if n.opened_at is null then
            update public.diary_note_snaps set opened_at = now() where id = p_snap returning * into n;
            perform private.diary_note_snap_sync(p_snap);
        end if;
    end if;
    return jsonb_build_object('title', n.title, 'text', n.body, 'color', n.color, 'saved', n.saved, 'sender', n.sender, 'opened_at', n.opened_at);
end;
$$;

-- Close it: unless it's been saved, the text is gone for good
create or replace function public.diary_note_snap_close(p_snap uuid)
returns void
language plpgsql
security definer
set search_path to ''
as $$
begin
    update public.diary_note_snaps set title = null, body = null
    where id = p_snap and recipient = auth.uid() and opened_at is not null and not saved;
end;
$$;

-- Save it in the chat (either of you, while the note still exists) — or unsave it
create or replace function public.diary_note_snap_save(p_snap uuid, p_save boolean)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $$
declare
    me uuid := auth.uid();
    n public.diary_note_snaps;
begin
    select * into n from public.diary_note_snaps where id = p_snap;
    if not found or me not in (n.sender, n.recipient) then raise exception 'That note isn’t available'; end if;
    if p_save then
        if n.title is null and n.body is null then raise exception 'Too late — this note has already disappeared'; end if;
        update public.diary_note_snaps set saved = true, saved_by = me where id = p_snap;
    else
        -- Unsaving an opened note lets it disappear, as if it had just been viewed
        update public.diary_note_snaps set saved = false, saved_by = null,
            title = case when opened_at is not null then null else title end,
            body = case when opened_at is not null then null else body end
        where id = p_snap;
    end if;
    perform private.diary_note_snap_sync(p_snap);
    return jsonb_build_object('saved', p_save);
end;
$$;

-- Safety net: anything opened more than 15 minutes ago and not saved is wiped (e.g. the app was closed mid-view)
create or replace function private.diary_note_snaps_sweep()
returns void
language sql
security definer
set search_path to ''
as $$
    update public.diary_note_snaps set title = null, body = null
    where not saved and opened_at < now() - interval '15 minutes' and (title is not null or body is not null);
$$;
select cron.schedule('diary-note-snaps-sweep', '*/10 * * * *', $job$ select private.diary_note_snaps_sweep(); $job$)
where not exists (select 1 from cron.job where jobname = 'diary-note-snaps-sweep');

revoke all on function public.diary_note_snap_send(uuid, text, text, text, text), public.diary_note_snap_open(uuid),
    public.diary_note_snap_close(uuid), public.diary_note_snap_save(uuid, boolean) from public, anon;
grant execute on function public.diary_note_snap_send(uuid, text, text, text, text), public.diary_note_snap_open(uuid),
    public.diary_note_snap_close(uuid), public.diary_note_snap_save(uuid, boolean) to authenticated;

-- Streaks, now mutual (like Snapchat): a day counts only when you both sent each other a note.
-- Both people see the same streak. at_risk: the streak is alive but today isn't complete yet.
drop function if exists public.diary_note_streaks(text);
create or replace function public.diary_note_streaks(p_tz text default 'UTC')
returns table (friend uuid, streak int, sent_today boolean, they_sent_today boolean, at_risk boolean)
language plpgsql
stable
security definer
set search_path to ''
as $$
declare
    me uuid := auth.uid();
    tz text := 'UTC';
    today date;
begin
    if me is null then return; end if;
    if p_tz is not null and exists (select 1 from pg_catalog.pg_timezone_names where name = p_tz) then tz := p_tz; end if;
    today := (now() at time zone tz)::date;
    return query
    with sends as (
        select case when m.sender = me then m.recipient else m.sender end as who,
               (m.created_at at time zone tz)::date as d,
               bool_or(m.sender = me) as mine,
               bool_or(m.sender <> me) as theirs
        from public.diary_messages m
        where me in (m.sender, m.recipient)
          and m.deleted_at is null
          and m.attachments @> '[{"kind":"note"}]'::jsonb
          and m.created_at > now() - interval '400 days'
        group by 1, 2
    ),
    both_days as (select who, d from sends where mine and theirs),
    ranked as (select who, d, d - (row_number() over (partition by who order by d))::int as grp from both_days),
    runs as (select who, max(d) as last_d, count(*)::int as len from ranked group by who, grp),
    alive as (select who, len from runs where last_d >= today - 1),
    friends as (select who from sends where d >= today - 1 union select who from alive)
    select f.who,
           coalesce(a.len, 0),
           coalesce((select x.mine from sends x where x.who = f.who and x.d = today), false),
           coalesce((select x.theirs from sends x where x.who = f.who and x.d = today), false),
           coalesce(a.len, 0) > 0 and not exists (select 1 from both_days b where b.who = f.who and b.d = today)
    from (select distinct who from friends) f
    left join alive a on a.who = f.who;
end;
$$;
revoke all on function public.diary_note_streaks(text) from public, anon;
grant execute on function public.diary_note_streaks(text) to authenticated;
