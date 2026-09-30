-- Instant sign-up limit per network: 35 new accounts per hour, no daily cap
create or replace function public.diary_signup_check(p_ip text)
returns text
language plpgsql
security definer
set search_path to ''
as $$
begin
    delete from private.diary_signup_attempts where created_at < now() - interval '1 day';
    if (select count(*) from private.diary_signup_attempts where ip = p_ip and created_at > now() - interval '1 hour') >= 35 then
        return 'hour';
    end if;
    return 'ok';
end;
$$;
