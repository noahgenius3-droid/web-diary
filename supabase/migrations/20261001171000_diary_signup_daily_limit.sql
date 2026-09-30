-- Instant sign-up limit: up to 100 new accounts per network per day (was 8 per hour).
-- Only accounts actually created count — typos and taken usernames don't use up the allowance.

create or replace function public.diary_signup_gate(p_ip text, p_email text)
returns boolean
language plpgsql
security definer
set search_path to ''
as $$
begin
    delete from private.diary_signup_attempts where created_at < now() - interval '2 days';
    return (select count(*) from private.diary_signup_attempts
            where ip = p_ip and created_at > now() - interval '1 day') < 100;
end;
$$;
revoke all on function public.diary_signup_gate(text, text) from public, anon, authenticated;
grant execute on function public.diary_signup_gate(text, text) to service_role;

create or replace function public.diary_signup_record(p_ip text, p_email text)
returns void
language sql
security definer
set search_path to ''
as $$
    insert into private.diary_signup_attempts (ip, email) values (p_ip, lower(p_email));
$$;
revoke all on function public.diary_signup_record(text, text) from public, anon, authenticated;
grant execute on function public.diary_signup_record(text, text) to service_role;

-- Earlier rows counted every try, not just accounts made; start the new count fresh
delete from private.diary_signup_attempts;
