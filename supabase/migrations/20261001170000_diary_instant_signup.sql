-- Instant sign-up through Cordial's own server (the diary-signup Edge Function) — no confirmation email.
-- This table only rate-limits it: a few new accounts per network per hour. Nobody but the server can touch it.

create table if not exists private.diary_signup_attempts (
    id bigint generated always as identity primary key,
    ip text not null,
    email text,
    created_at timestamptz not null default now()
);
create index if not exists diary_signup_attempts_ip_time on private.diary_signup_attempts (ip, created_at desc);

-- Called by the Edge Function (service role): logs the attempt and says whether it's allowed
create or replace function public.diary_signup_gate(p_ip text, p_email text)
returns boolean
language plpgsql
security definer
set search_path to ''
as $$
declare
    recent int;
begin
    delete from private.diary_signup_attempts where created_at < now() - interval '1 day';
    select count(*) into recent from private.diary_signup_attempts
    where ip = p_ip and created_at > now() - interval '1 hour';
    if recent >= 8 then return false; end if;
    insert into private.diary_signup_attempts (ip, email) values (p_ip, lower(p_email));
    return true;
end;
$$;
revoke all on function public.diary_signup_gate(text, text) from public, anon, authenticated;
grant execute on function public.diary_signup_gate(text, text) to service_role;

-- Is this username free? (checked before the account is made, so nobody ends up half signed up)
create or replace function public.diary_username_free(p_username text)
returns boolean
language sql
stable
security definer
set search_path to ''
as $$
    select not exists (select 1 from public.diary_profiles where username = lower(p_username));
$$;
revoke all on function public.diary_username_free(text) from public, anon, authenticated;
grant execute on function public.diary_username_free(text) to service_role;
