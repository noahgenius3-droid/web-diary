-- A live that was never ended properly (phone died, app closed) shouldn't stop its host going live again:
-- before a new stream starts, the host's own streams with no heartbeat for 2 minutes are marked ended.
create or replace function private.diary_live_end_stale()
returns trigger
language plpgsql
security definer
set search_path to ''
as $$
begin
    update public.diary_live_streams
    set ended_at = coalesce(last_seen, now())
    where host = new.host and ended_at is null and last_seen < now() - interval '2 minutes';
    return new;
end;
$$;

drop trigger if exists diary_live_end_stale on public.diary_live_streams;
create trigger diary_live_end_stale before insert on public.diary_live_streams
    for each row execute function private.diary_live_end_stale();
