-- Instant sign-up limits per network: 25 new accounts per hour, and 100 per day.
-- Replaces diary_signup_gate (dropped once the diary-signup function uses this).

create or replace function public.diary_signup_check(p_ip text)
returns text
language plpgsql
security definer
set search_path to ''
as $$
begin
    delete from private.diary_signup_attempts where created_at < now() - interval '2 days';
    if (select count(*) from private.diary_signup_attempts where ip = p_ip and created_at > now() - interval '1 hour') >= 25 then
        return 'hour';
    end if;
    if (select count(*) from private.diary_signup_attempts where ip = p_ip and created_at > now() - interval '1 day') >= 100 then
        return 'day';
    end if;
    return 'ok';
end;
$$;
revoke all on function public.diary_signup_check(text) from public, anon, authenticated;
grant execute on function public.diary_signup_check(text) to service_role;

drop function if exists public.diary_signup_gate(text, text);
