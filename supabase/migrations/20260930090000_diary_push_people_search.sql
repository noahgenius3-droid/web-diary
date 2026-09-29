-- Phone/desktop push notifications (even when Cordial is closed) and global people search.
-- The VAPID key pair and the trigger secret live in private.diary_push_config; they are inserted once
-- outside this file so they never end up in git.

create extension if not exists pg_net with schema extensions;

-- ============================================================================
-- Push subscriptions: one row per browser/device that turned alerts on
-- ============================================================================
create table if not exists public.diary_push_subscriptions (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null default auth.uid() references public.diary_profiles (id) on delete cascade,
    endpoint text not null unique check (endpoint ~ '^https://' and char_length(endpoint) <= 1000),
    p256dh text not null check (char_length(p256dh) <= 200),
    auth text not null check (char_length(auth) <= 100),
    user_agent text check (char_length(user_agent) <= 300),
    created_at timestamptz not null default now()
);
create index if not exists diary_push_subscriptions_user_idx on public.diary_push_subscriptions (user_id);
alter table public.diary_push_subscriptions enable row level security;
create policy "See your own devices" on public.diary_push_subscriptions
    for select to authenticated using (user_id = (select auth.uid()));
create policy "Add your own device" on public.diary_push_subscriptions
    for insert to authenticated with check (user_id = (select auth.uid()));
create policy "Update your own device" on public.diary_push_subscriptions
    for update to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy "Remove your own device" on public.diary_push_subscriptions
    for delete to authenticated using (user_id = (select auth.uid()));
revoke all on public.diary_push_subscriptions from anon, authenticated;
grant select, delete on public.diary_push_subscriptions to authenticated;
grant insert (endpoint, p256dh, auth, user_agent) on public.diary_push_subscriptions to authenticated;
grant update (p256dh, auth, user_agent) on public.diary_push_subscriptions to authenticated;

-- A browser's subscription can move between accounts on a shared device: claim it for whoever is signed in now
create or replace function public.diary_save_push_subscription(p_endpoint text, p_p256dh text, p_auth text, p_user_agent text default null)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
    if auth.uid() is null then
        raise exception 'Sign in first';
    end if;
    insert into public.diary_push_subscriptions (user_id, endpoint, p256dh, auth, user_agent)
    values (auth.uid(), p_endpoint, p_p256dh, p_auth, left(p_user_agent, 300))
    on conflict (endpoint) do update set user_id = auth.uid(), p256dh = excluded.p256dh, auth = excluded.auth, user_agent = excluded.user_agent;
end;
$$;
revoke all on function public.diary_save_push_subscription(text, text, text, text) from public, anon;
grant execute on function public.diary_save_push_subscription(text, text, text, text) to authenticated;

-- ============================================================================
-- Server-side config (keys + the secret the trigger uses to call the push function)
-- ============================================================================
create table if not exists private.diary_push_config (
    id boolean primary key default true check (id),
    vapid_public text not null,
    vapid_private text not null,
    trigger_secret text not null,
    function_url text not null
);
revoke all on private.diary_push_config from public, anon, authenticated;

-- Only the push function (service role) can read the keys
create or replace function public.diary_push_config_get()
returns table (vapid_public text, vapid_private text, trigger_secret text)
language sql
security definer
set search_path = ''
as $$
    select vapid_public, vapid_private, trigger_secret from private.diary_push_config where id;
$$;
revoke all on function public.diary_push_config_get() from public, anon, authenticated;
grant execute on function public.diary_push_config_get() to service_role;

-- ============================================================================
-- New notifications of these types are pushed to the person's devices
-- ============================================================================
create or replace function private.diary_push_notification()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
    cfg private.diary_push_config;
begin
    if new.type not in ('friend_request', 'friend_accepted', 'new_follower') then
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
    -- a push problem must never stop the notification itself
    return new;
end;
$$;
drop trigger if exists diary_notifications_push on public.diary_notifications;
create trigger diary_notifications_push after insert on public.diary_notifications
    for each row execute function private.diary_push_notification();

-- ============================================================================
-- Global people search: anyone on Cordial by name or @username, with how you're connected
-- ============================================================================
create or replace function public.diary_search_people(q text)
returns table (id uuid, username text, display_name text, avatar_path text, relation text, following boolean, follows_you boolean)
language sql
stable
security invoker
set search_path = ''
as $$
    with me as (select auth.uid() as uid),
    term as (select lower(btrim(regexp_replace(coalesce(q, ''), '^@', ''))) as t)
    select p.id, p.username, p.display_name, p.avatar_path,
        coalesce((
            select case
                when f.status = 'accepted' then 'friend'
                when f.requester = (select uid from me) then 'requested'
                else 'incoming'
            end
            from public.diary_friendships f
            where (f.requester = p.id and f.addressee = (select uid from me))
               or (f.addressee = p.id and f.requester = (select uid from me))
            limit 1
        ), 'none') as relation,
        exists (select 1 from public.diary_follows fo where fo.follower = (select uid from me) and fo.followee = p.id) as following,
        exists (select 1 from public.diary_follows fo where fo.followee = (select uid from me) and fo.follower = p.id) as follows_you
    from public.diary_profiles p, term
    where (select uid from me) is not null
      and char_length(replace(term.t, '%', '')) >= 2
      and p.id <> (select uid from me)
      and (lower(p.username) like '%' || replace(replace(term.t, '%', ''), '_', '\_') || '%'
           or lower(p.display_name) like '%' || replace(term.t, '%', '') || '%')
    order by
        (lower(p.username) = term.t or lower(p.display_name) = term.t) desc,
        (lower(p.username) like term.t || '%' or lower(p.display_name) like term.t || '%') desc,
        p.display_name
    limit 25;
$$;
revoke all on function public.diary_search_people(text) from public, anon;
grant execute on function public.diary_search_people(text) to authenticated;
