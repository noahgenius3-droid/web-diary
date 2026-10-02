-- Cordial Command Center: the founder's operations backend.
--   • Roles and permissions for app admins (super_admin, moderator, support, analyst)
--   • One account-status model: active / suspended / blocked (with scopes) / deactivated
--   • Reward transactions (XP, coins, badges, special recognition) with review for large amounts
--   • A support helpline (tickets + threaded messages, internal notes) and appeals
--   • Report severity, assignment and a fuller status flow
--   • Admin alerts, and an audit log that records reason and before/after state
-- Every privileged function checks a permission on the server, is rate limited, and writes to the audit log.

-- ============================================================================
-- Roles and permissions
-- ============================================================================
alter table public.diary_app_admins add column if not exists role text not null default 'super_admin'
    check (role in ('super_admin', 'moderator', 'support', 'analyst'));

create or replace function private.cc_perms(p_role text) returns text[] language sql immutable set search_path = '' as $$
    select case p_role
        when 'super_admin' then array['users.read', 'users.suspend', 'users.block', 'users.deactivate', 'users.reactivate', 'rewards.send',
                                      'rewards.review', 'reports.manage', 'support.manage', 'audit.view', 'analytics.view', 'admins.manage']
        when 'moderator' then array['users.read', 'users.suspend', 'users.block', 'users.reactivate', 'reports.manage', 'audit.view', 'analytics.view']
        when 'support' then array['users.read', 'support.manage', 'rewards.send']
        when 'analyst' then array['users.read', 'analytics.view', 'audit.view']
        else array[]::text[]
    end;
$$;
create or replace function private.cc_has_perm(uid uuid, perm text) returns boolean language sql stable security definer set search_path = '' as $$
    select exists (select 1 from public.diary_app_admins a where a.user_id = uid and perm = any (private.cc_perms(a.role)));
$$;
-- At most 90 privileged actions a minute per admin (a runaway script or a stolen session can't do much)
create or replace function private.cc_require(perm text) returns uuid language plpgsql stable security definer set search_path = '' as $$
begin
    if auth.uid() is null or not private.cc_has_perm(auth.uid(), perm) then
        raise exception 'You don''t have permission to do that (%)', perm using errcode = '42501';
    end if;
    return auth.uid();
end;
$$;
create or replace function private.cc_rate_limit(uid uuid) returns void language plpgsql stable security definer set search_path = '' as $$
begin
    if (select count(*) from public.diary_audit_log where actor = uid and created_at > now() - interval '1 minute') >= 90 then
        raise exception 'Too many actions in a minute — wait a moment and try again' using errcode = '54000';
    end if;
end;
$$;

-- The founder (@noahodus) is a super admin
insert into public.diary_app_admins (user_id, role)
select id, 'super_admin' from public.diary_profiles where username = 'noahodus'
on conflict (user_id) do update set role = 'super_admin';

-- Who am I in the Command Center?
create or replace function public.diary_cc_me() returns jsonb language sql stable security definer set search_path = '' as $$
    select case when a.user_id is null then null else jsonb_build_object(
        'id', p.id, 'username', p.username, 'display_name', p.display_name, 'avatar_path', p.avatar_path,
        'role', a.role, 'perms', to_jsonb(private.cc_perms(a.role))) end
    from public.diary_profiles p left join public.diary_app_admins a on a.user_id = p.id
    where p.id = auth.uid();
$$;
revoke all on function public.diary_cc_me() from public, anon;
grant execute on function public.diary_cc_me() to authenticated;
create or replace function public.diary_cc_has_perm(p_perm text) returns boolean language sql stable security definer set search_path = '' as $$
    select private.cc_has_perm(auth.uid(), p_perm);
$$;
revoke all on function public.diary_cc_has_perm(text) from public, anon;
grant execute on function public.diary_cc_has_perm(text) to authenticated;

-- ============================================================================
-- Audit log: reason and before / after state
-- ============================================================================
alter table public.diary_audit_log add column if not exists reason text check (char_length(reason) <= 500);
alter table public.diary_audit_log add column if not exists prev_state jsonb;
alter table public.diary_audit_log add column if not exists new_state jsonb;
alter table public.diary_audit_log add column if not exists target_kind text;
alter table public.diary_audit_log add column if not exists target_ref text;
create index if not exists diary_audit_log_target_idx on public.diary_audit_log (target_user, created_at desc);
create index if not exists diary_audit_log_actor_idx on public.diary_audit_log (actor, created_at desc);
create index if not exists diary_audit_log_action_idx on public.diary_audit_log (action, created_at desc);

create or replace function private.cc_audit(p_action text, p_target uuid, p_reason text, p_prev jsonb, p_new jsonb,
                                            p_meta jsonb default '{}'::jsonb, p_kind text default 'user', p_ref text default null)
returns void language sql security definer set search_path = '' as $$
    insert into public.diary_audit_log (actor, action, target_user, details, reason, prev_state, new_state, target_kind, target_ref)
    values (auth.uid(), p_action, p_target, coalesce(p_meta, '{}'::jsonb), left(p_reason, 500), p_prev, p_new, p_kind, p_ref);
$$;

-- ============================================================================
-- Admin alerts (the Command Center's own notifications)
-- ============================================================================
create table if not exists public.diary_cc_alerts (
    id bigint generated always as identity primary key,
    severity text not null check (severity in ('info', 'warning', 'high', 'critical')),
    kind text not null,
    title text not null check (char_length(title) <= 200),
    body text check (char_length(body) <= 500),
    ref text,                                   -- what it points at, e.g. report:<id>, ticket:<id>, user:<id>
    created_at timestamptz not null default now(),
    read_at timestamptz
);
create index if not exists diary_cc_alerts_time_idx on public.diary_cc_alerts (created_at desc);
alter table public.diary_cc_alerts enable row level security;
revoke all on public.diary_cc_alerts from anon, authenticated;
create policy "Admins read alerts" on public.diary_cc_alerts for select to authenticated using (private.diary_is_app_admin((select auth.uid())));
grant select on public.diary_cc_alerts to authenticated;

create or replace function private.cc_alert(p_severity text, p_kind text, p_title text, p_body text, p_ref text) returns void
language sql security definer set search_path = '' as $$
    insert into public.diary_cc_alerts (severity, kind, title, body, ref) values (p_severity, p_kind, left(p_title, 200), left(p_body, 500), p_ref);
$$;

-- ============================================================================
-- Account status
-- ============================================================================
create table if not exists public.diary_account_status (
    user_id uuid primary key references public.diary_profiles (id) on delete cascade,
    status text not null default 'active' check (status in ('active', 'suspended', 'blocked', 'deactivated')),
    scope text[] not null default '{}'::text[] check (scope <@ array['platform', 'messaging', 'comments', 'interactions', 'posting']::text[]),
    reason text check (char_length(reason) <= 500),
    user_message text check (char_length(user_message) <= 500),   -- what the person sees
    admin_note text check (char_length(admin_note) <= 1000),      -- internal only
    starts_at timestamptz,
    ends_at timestamptz,                                            -- null = until lifted
    restricted_by uuid references public.diary_profiles (id) on delete set null,
    restricted_at timestamptz,
    updated_at timestamptz not null default now()
);
create index if not exists diary_account_status_status_idx on public.diary_account_status (status);
alter table public.diary_account_status enable row level security;
revoke all on public.diary_account_status from anon, authenticated;
-- The person sees their own restriction (without the internal note — read through diary_my_account); admins see all
create policy "Admins read account status" on public.diary_account_status for select to authenticated
    using (private.cc_has_perm((select auth.uid()), 'users.read'));
grant select on public.diary_account_status to authenticated;

-- Existing suspensions become account statuses
insert into public.diary_account_status (user_id, status, reason, starts_at, ends_at, restricted_by, restricted_at)
select s.user_id, 'suspended', s.reason, s.created_at, s.until, s.by_admin, s.created_at from public.diary_suspensions s
where s.until is null or s.until > now()
on conflict (user_id) do nothing;

-- What is in force right now (a suspension or block whose end has passed counts as active)
create or replace function private.cc_effective(uid uuid) returns text language sql stable security definer set search_path = '' as $$
    select coalesce((select case when a.status in ('suspended', 'blocked') and a.ends_at is not null and a.ends_at <= now() then 'active' else a.status end
                     from public.diary_account_status a where a.user_id = uid), 'active');
$$;
-- Is this person kept from doing this kind of thing?
create or replace function private.cc_restricted(uid uuid, what text) returns boolean language sql stable security definer set search_path = '' as $$
    select exists (
        select 1 from public.diary_account_status a
        where a.user_id = uid and (a.ends_at is null or a.ends_at > now())
          and (a.status = 'deactivated' or (a.status = 'blocked' and ('platform' = any (a.scope) or what = any (a.scope))))
    );
$$;
-- The existing "can't post / message / comment" rules now also cover deactivated accounts and platform-wide blocks
create or replace function private.diary_is_suspended(uid uuid) returns boolean language sql stable security definer set search_path = '' as $$
    select exists (select 1 from public.diary_suspensions where user_id = uid and (until is null or until > now()))
        or private.cc_restricted(uid, 'posting');
$$;

-- Scoped blocks on the tables people write to directly
do $$
declare t text;
begin
    foreach t in array array['diary_messages', 'diary_community_messages'] loop
        execute format('drop policy if exists "Blocked from messaging" on public.%I', t);
        execute format('create policy "Blocked from messaging" on public.%I as restrictive for insert to authenticated with check (not private.cc_restricted((select auth.uid()), ''messaging''))', t);
    end loop;
    execute 'drop policy if exists "Blocked from commenting" on public.diary_comments';
    execute 'create policy "Blocked from commenting" on public.diary_comments as restrictive for insert to authenticated with check (not private.cc_restricted((select auth.uid()), ''comments''))';
    foreach t in array array['diary_entry_likes', 'diary_entry_reactions', 'diary_reel_likes', 'diary_comment_likes', 'diary_community_likes',
                             'diary_community_reactions', 'diary_community_message_reactions', 'diary_story_reactions', 'diary_follows',
                             'diary_reposts', 'diary_reel_reshares'] loop
        if to_regclass('public.' || t) is not null then
            execute format('drop policy if exists "Blocked from interacting" on public.%I', t);
            execute format('create policy "Blocked from interacting" on public.%I as restrictive for insert to authenticated with check (not private.cc_restricted((select auth.uid()), ''interactions''))', t);
        end if;
    end loop;
end;
$$;

-- The one place an account's status changes. Validates the change, keeps the suspension table (which the
-- app's existing rules read) in step, tells the person, and writes the audit log with before / after.
create or replace function private.cc_apply_status(p_user uuid, p_status text, p_scope text[], p_reason text, p_ends timestamptz,
                                                    p_user_message text, p_note text, p_action text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
    me uuid := auth.uid();
    prev public.diary_account_status;
    prev_json jsonb;
    next_json jsonb;
begin
    if p_user = me and p_status <> 'active' then raise exception 'You can''t restrict your own account'; end if;
    if not exists (select 1 from public.diary_profiles where id = p_user) then raise exception 'No such user'; end if;
    if p_status <> 'active' and coalesce(trim(p_reason), '') = '' then raise exception 'A reason is required'; end if;
    if p_status = 'blocked' and coalesce(array_length(p_scope, 1), 0) = 0 then raise exception 'Choose what the block covers'; end if;
    if p_status in ('suspended', 'blocked', 'deactivated') and exists (select 1 from public.diary_app_admins where user_id = p_user)
       and not private.cc_has_perm(me, 'admins.manage') then
        raise exception 'Only a super admin can restrict another admin';
    end if;
    select * into prev from public.diary_account_status where user_id = p_user;
    prev_json := jsonb_build_object('status', private.cc_effective(p_user), 'scope', coalesce(to_jsonb(prev.scope), '[]'::jsonb),
                                    'ends_at', prev.ends_at, 'reason', prev.reason);
    insert into public.diary_account_status as a (user_id, status, scope, reason, user_message, admin_note, starts_at, ends_at, restricted_by, restricted_at, updated_at)
    values (p_user, p_status, case when p_status = 'blocked' then p_scope else '{}' end, left(p_reason, 500), left(p_user_message, 500), left(p_note, 1000),
            now(), case when p_status in ('suspended', 'blocked') then p_ends end, me, now(), now())
    on conflict (user_id) do update set status = excluded.status, scope = excluded.scope, reason = excluded.reason, user_message = excluded.user_message,
        admin_note = excluded.admin_note, starts_at = excluded.starts_at, ends_at = excluded.ends_at, restricted_by = me, restricted_at = now(), updated_at = now();
    -- Keep the older suspension table in step (its rules stop posting, messaging and commenting)
    if p_status = 'suspended' then
        insert into public.diary_suspensions (user_id, until, reason, by_admin) values (p_user, p_ends, left(p_reason, 300), me)
        on conflict (user_id) do update set until = excluded.until, reason = excluded.reason, by_admin = me, created_at = now();
    else
        delete from public.diary_suspensions where user_id = p_user;
    end if;
    next_json := jsonb_build_object('status', p_status, 'scope', to_jsonb(case when p_status = 'blocked' then p_scope else '{}'::text[] end), 'ends_at', p_ends);
    perform private.cc_audit(p_action, p_user, p_reason, prev_json, next_json, jsonb_build_object('note', p_note, 'user_message', p_user_message));
    insert into public.diary_notifications (user_id, actor, type, data)
    values (p_user, null, 'account_notice', jsonb_build_object('status', p_status, 'ends_at', p_ends, 'message',
        coalesce(nullif(p_user_message, ''), case p_status
            when 'active' then 'Your account is fully restored. Welcome back.'
            when 'suspended' then 'Your account has been limited for a while. You can still read.'
            when 'blocked' then 'Some features are switched off on your account.'
            else 'Your account has been deactivated.' end))));
    return next_json;
end;
$$;

-- Suspend for a time (or until lifted), block with a scope, deactivate, or restore
create or replace function public.diary_cc_set_status(p_user uuid, p_status text, p_reason text, p_scope text[] default '{}',
    p_hours int default null, p_until timestamptz default null, p_user_message text default null, p_note text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
    me uuid;
    ends timestamptz := coalesce(p_until, case when p_hours > 0 then now() + make_interval(hours => p_hours) end);
begin
    me := private.cc_require(case p_status when 'suspended' then 'users.suspend' when 'blocked' then 'users.block'
                                           when 'deactivated' then 'users.deactivate' when 'active' then 'users.reactivate' else 'none' end);
    perform private.cc_rate_limit(me);
    if p_status not in ('active', 'suspended', 'blocked', 'deactivated') then raise exception 'Unknown status'; end if;
    if ends is not null and ends <= now() then raise exception 'The end time must be in the future'; end if;
    if p_status = 'suspended' and ends is null and coalesce(p_hours, 0) <> -1 then raise exception 'Choose how long the suspension lasts'; end if;
    return private.cc_apply_status(p_user, p_status, p_scope, p_reason, ends, p_user_message, p_note,
        case p_status when 'suspended' then 'USER_SUSPENDED' when 'blocked' then 'USER_BLOCKED'
                      when 'deactivated' then 'USER_DEACTIVATED' else 'USER_REACTIVATED' end);
end;
$$;
revoke all on function public.diary_cc_set_status(uuid, text, text, text[], int, timestamptz, text, text) from public, anon;
grant execute on function public.diary_cc_set_status(uuid, text, text, text[], int, timestamptz, text, text) to authenticated;

-- Several at once (at most 50); each one is checked and audited on its own
create or replace function public.diary_cc_bulk_status(p_users uuid[], p_status text, p_reason text, p_scope text[] default '{}',
    p_hours int default null, p_user_message text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare u uuid; ok int := 0; failed jsonb := '[]'::jsonb;
begin
    if coalesce(array_length(p_users, 1), 0) > 50 then raise exception 'At most 50 accounts at a time'; end if;
    foreach u in array coalesce(p_users, '{}') loop
        begin
            perform public.diary_cc_set_status(u, p_status, p_reason, p_scope, p_hours, null, p_user_message, 'Bulk action');
            ok := ok + 1;
        exception when others then
            failed := failed || jsonb_build_object('user', u, 'error', sqlerrm);
        end;
    end loop;
    return jsonb_build_object('done', ok, 'failed', failed);
end;
$$;
revoke all on function public.diary_cc_bulk_status(uuid[], text, text, text[], int, text) from public, anon;
grant execute on function public.diary_cc_bulk_status(uuid[], text, text, text[], int, text) to authenticated;

-- The in-app Moderation page's suspend / lift now go through the same model
create or replace function public.diary_admin_suspend(p_user uuid, p_days int, p_reason text) returns void language plpgsql security definer set search_path = '' as $$
begin
    perform public.diary_cc_set_status(p_user, 'suspended', coalesce(nullif(p_reason, ''), 'Breach of the community rules'), '{}',
        case when p_days > 0 then p_days * 24 else -1 end);
end;
$$;
create or replace function public.diary_lift_suspension(p_user uuid) returns void language plpgsql security definer set search_path = '' as $$
begin
    perform public.diary_cc_set_status(p_user, 'active', 'Suspension lifted');
end;
$$;

-- ============================================================================
-- Rewards
-- ============================================================================
create table if not exists public.diary_rewards (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null references public.diary_profiles (id) on delete cascade,
    kind text not null check (kind in ('xp', 'coins', 'badge', 'special')),
    amount integer not null default 0 check (amount between 0 and 1000000),
    badge text references public.diary_badges (id) on delete set null,
    reason text not null check (char_length(reason) between 3 and 300),
    message text check (char_length(message) <= 500),
    status text not null default 'delivered' check (status in ('delivered', 'pending_review', 'declined', 'reversed')),
    by_admin uuid references public.diary_profiles (id) on delete set null,
    reviewed_by uuid references public.diary_profiles (id) on delete set null,
    reviewed_at timestamptz,
    created_at timestamptz not null default now()
);
create index if not exists diary_rewards_user_idx on public.diary_rewards (user_id, created_at desc);
create index if not exists diary_rewards_time_idx on public.diary_rewards (created_at desc);
alter table public.diary_rewards enable row level security;
revoke all on public.diary_rewards from anon, authenticated;
create policy "Your rewards, and admins see all" on public.diary_rewards for select to authenticated
    using ((user_id = (select auth.uid()) and status = 'delivered') or private.cc_has_perm((select auth.uid()), 'users.read'));
grant select on public.diary_rewards to authenticated;

create or replace function private.cc_coins(uid uuid) returns bigint language sql stable security definer set search_path = '' as $$
    select coalesce(sum(case when status = 'delivered' then amount when status = 'reversed' then 0 else 0 end), 0)
    from public.diary_rewards where user_id = uid and kind = 'coins';
$$;
-- XP now includes XP rewards
create or replace function private.diary_xp(p_user uuid) returns bigint language sql stable security definer set search_path = '' as $$
    select coalesce((select sum(score) from public.diary_trivia_rounds where user_id = p_user and kind <> 'practice' and finished_at is not null), 0)
         + coalesce((select sum(score) from public.diary_game_scores where user_id = p_user and ranked), 0)
         + 10 * (select count(*) from public.diary_shared_entries where author = p_user)
         + 2 * (select count(*) from public.diary_comments where author = p_user)
         + coalesce((select sum(amount) from public.diary_rewards where user_id = p_user and kind = 'xp' and status = 'delivered'), 0);
$$;

-- Hand a delivered reward to the person: the badge itself, and a notification
create or replace function private.cc_deliver_reward(r public.diary_rewards) returns void language plpgsql security definer set search_path = '' as $$
begin
    if r.kind = 'badge' and r.badge is not null then
        insert into public.diary_user_badges (user_id, badge) values (r.user_id, r.badge) on conflict do nothing;
    end if;
    insert into public.diary_notifications (user_id, actor, type, data)
    values (r.user_id, null, 'reward_received', jsonb_build_object('reward_id', r.id, 'kind', r.kind, 'amount', r.amount, 'badge', r.badge,
        'badge_name', (select name from public.diary_badges where id = r.badge), 'message', r.message, 'reason', r.reason));
end;
$$;

-- Large rewards (over 5,000 XP or 1,000 coins) must be confirmed explicitly; from anyone but a super admin they wait for review
create or replace function public.diary_cc_send_reward(p_user uuid, p_kind text, p_amount int, p_reason text, p_message text default null,
                                                       p_badge text default null, p_confirm_large boolean default false)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
    me uuid := private.cc_require('rewards.send');
    big boolean := (p_kind = 'xp' and p_amount > 5000) or (p_kind = 'coins' and p_amount > 1000);
    r public.diary_rewards;
begin
    perform private.cc_rate_limit(me);
    if p_kind not in ('xp', 'coins', 'badge', 'special') then raise exception 'Unknown reward type'; end if;
    if p_kind in ('xp', 'coins') and coalesce(p_amount, 0) <= 0 then raise exception 'Enter an amount above zero'; end if;
    if p_kind = 'badge' and not exists (select 1 from public.diary_badges where id = p_badge) then raise exception 'Choose a badge'; end if;
    if coalesce(char_length(trim(p_reason)), 0) < 3 then raise exception 'Give a reason (at least 3 characters)'; end if;
    if p_user = me and not private.cc_has_perm(me, 'admins.manage') then raise exception 'You can''t reward yourself'; end if;
    if big and not p_confirm_large then raise exception 'LARGE_REWARD: confirm this large reward to send it' using errcode = 'P0001'; end if;
    insert into public.diary_rewards (user_id, kind, amount, badge, reason, message, status, by_admin)
    values (p_user, p_kind, case when p_kind in ('xp', 'coins') then p_amount else 0 end, case when p_kind = 'badge' then p_badge end,
            trim(p_reason), nullif(trim(coalesce(p_message, '')), ''),
            case when big and not private.cc_has_perm(me, 'rewards.review') then 'pending_review' else 'delivered' end, me)
    returning * into r;
    if r.status = 'delivered' then perform private.cc_deliver_reward(r);
    else perform private.cc_alert('warning', 'reward_review', 'A large reward is waiting for review',
        format('%s %s for %s', r.amount, r.kind, (select display_name from public.diary_profiles where id = p_user)), 'reward:' || r.id);
    end if;
    perform private.cc_audit('REWARD_SENT', p_user, p_reason, null,
        jsonb_build_object('reward', r.id, 'kind', r.kind, 'amount', r.amount, 'badge', r.badge, 'status', r.status),
        jsonb_build_object('message', p_message), 'reward', r.id::text);
    return to_jsonb(r);
end;
$$;
revoke all on function public.diary_cc_send_reward(uuid, text, int, text, text, text, boolean) from public, anon;
grant execute on function public.diary_cc_send_reward(uuid, text, int, text, text, text, boolean) to authenticated;

create or replace function public.diary_cc_review_reward(p_id uuid, p_approve boolean, p_note text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare me uuid := private.cc_require('rewards.review'); r public.diary_rewards;
begin
    perform private.cc_rate_limit(me);
    update public.diary_rewards set status = case when p_approve then 'delivered' else 'declined' end, reviewed_by = me, reviewed_at = now()
    where id = p_id and status = 'pending_review' returning * into r;
    if r.id is null then raise exception 'That reward isn''t waiting for review'; end if;
    if p_approve then perform private.cc_deliver_reward(r); end if;
    perform private.cc_audit(case when p_approve then 'REWARD_APPROVED' else 'REWARD_DECLINED' end, r.user_id, p_note,
        jsonb_build_object('status', 'pending_review'), jsonb_build_object('status', r.status), '{}'::jsonb, 'reward', r.id::text);
    return to_jsonb(r);
end;
$$;
revoke all on function public.diary_cc_review_reward(uuid, boolean, text) from public, anon;
grant execute on function public.diary_cc_review_reward(uuid, boolean, text) to authenticated;

create or replace function public.diary_cc_reverse_reward(p_id uuid, p_reason text) returns jsonb language plpgsql security definer set search_path = '' as $$
declare me uuid := private.cc_require('rewards.review'); r public.diary_rewards;
begin
    perform private.cc_rate_limit(me);
    if coalesce(char_length(trim(p_reason)), 0) < 3 then raise exception 'Give a reason'; end if;
    update public.diary_rewards set status = 'reversed', reviewed_by = me, reviewed_at = now() where id = p_id and status = 'delivered' returning * into r;
    if r.id is null then raise exception 'Only delivered rewards can be reversed'; end if;
    if r.kind = 'badge' and r.badge is not null then delete from public.diary_user_badges where user_id = r.user_id and badge = r.badge; end if;
    perform private.cc_audit('REWARD_REVERSED', r.user_id, p_reason, jsonb_build_object('status', 'delivered'), jsonb_build_object('status', 'reversed'), '{}'::jsonb, 'reward', r.id::text);
    return to_jsonb(r);
end;
$$;
revoke all on function public.diary_cc_reverse_reward(uuid, text) from public, anon;
grant execute on function public.diary_cc_reverse_reward(uuid, text) to authenticated;

create or replace function public.diary_cc_rewards(p_q text default null, p_kind text default null, p_status text default null,
    p_from timestamptz default null, p_to timestamptz default null, p_user uuid default null, p_limit int default 50, p_offset int default 0)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare res jsonb;
begin
    perform private.cc_require('users.read');
    with f as (
        select r.*, u.username, u.display_name, u.avatar_path, a.display_name as admin_name
        from public.diary_rewards r join public.diary_profiles u on u.id = r.user_id left join public.diary_profiles a on a.id = r.by_admin
        where (p_kind is null or r.kind = p_kind) and (p_status is null or r.status = p_status) and (p_user is null or r.user_id = p_user)
          and (p_from is null or r.created_at >= p_from) and (p_to is null or r.created_at < p_to)
          and (p_q is null or u.username ilike '%' || p_q || '%' or u.display_name ilike '%' || p_q || '%' or r.reason ilike '%' || p_q || '%'
               or r.id::text ilike p_q || '%')
    )
    select jsonb_build_object('total', (select count(*) from f),
        'rows', coalesce((select jsonb_agg(to_jsonb(x) order by x.created_at desc) from (select * from f order by created_at desc
            limit least(greatest(coalesce(p_limit, 50), 1), 200) offset greatest(coalesce(p_offset, 0), 0)) x), '[]'::jsonb))
    into res;
    return res;
end;
$$;
revoke all on function public.diary_cc_rewards(text, text, text, timestamptz, timestamptz, uuid, int, int) from public, anon;
grant execute on function public.diary_cc_rewards(text, text, text, timestamptz, timestamptz, uuid, int, int) to authenticated;

-- ============================================================================
-- Reports: severity, assignment, a fuller status flow
-- ============================================================================
alter table public.diary_reports add column if not exists severity text not null default 'medium' check (severity in ('low', 'medium', 'high', 'critical'));
alter table public.diary_reports add column if not exists assigned_to uuid references public.diary_profiles (id) on delete set null;
alter table public.diary_reports add column if not exists updated_at timestamptz not null default now();
alter table public.diary_reports drop constraint if exists diary_reports_status_check;
alter table public.diary_reports add constraint diary_reports_status_check
    check (status in ('open', 'investigating', 'actioned', 'dismissed', 'appealed', 'resolved'));
create or replace function private.cc_report_severity(p_reason text) returns text language sql immutable set search_path = '' as $$
    select case when p_reason in ('self_harm', 'violence') then 'critical'
                when p_reason in ('sexual', 'hate', 'harassment', 'scam') then 'high'
                when p_reason = 'spam' then 'low' else 'medium' end;
$$;
update public.diary_reports set severity = private.cc_report_severity(reason) where severity = 'medium';

create or replace function private.cc_on_report() returns trigger language plpgsql security definer set search_path = '' as $$
declare n int;
begin
    new.severity := private.cc_report_severity(new.reason);
    if new.severity in ('high', 'critical') then
        perform private.cc_alert(new.severity, 'report', format('%s report: %s', initcap(new.severity), replace(new.reason, '_', ' ')),
            coalesce(left(new.details, 200), left(new.snapshot, 200)), 'report:' || new.id);
    end if;
    if new.target_user is not null then
        select count(*) into n from public.diary_reports where target_user = new.target_user and created_at > now() - interval '24 hours';
        if n + 1 = 5 then
            perform private.cc_alert('high', 'suspicious', 'Many reports against one account',
                format('%s has been reported 5 times in 24 hours', (select display_name from public.diary_profiles where id = new.target_user)), 'user:' || new.target_user);
        end if;
    end if;
    return new;
end;
$$;
drop trigger if exists diary_cc_on_report on public.diary_reports;
create trigger diary_cc_on_report before insert on public.diary_reports for each row execute function private.cc_on_report();

create or replace function public.diary_cc_reports(p_status text default 'open', p_severity text default null, p_q text default null,
                                                   p_user uuid default null, p_limit int default 50, p_offset int default 0)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare res jsonb;
begin
    perform private.cc_require('reports.manage');
    with f as (
        select r.id, r.kind, r.target_id, r.reason, r.details, r.snapshot, r.status, r.severity, r.resolution, r.created_at, r.updated_at, r.handled_at,
               r.community_id, r.target_user, r.reporter, r.assigned_to,
               t.username as target_username, t.display_name as target_name, t.avatar_path as target_avatar,
               p.username as reporter_username, p.display_name as reporter_name,
               a.display_name as assigned_name, h.display_name as handled_name,
               private.cc_effective(r.target_user) as target_status
        from public.diary_reports r
        left join public.diary_profiles t on t.id = r.target_user left join public.diary_profiles p on p.id = r.reporter
        left join public.diary_profiles a on a.id = r.assigned_to left join public.diary_profiles h on h.id = r.handled_by
        where (p_status is null or p_status = 'all' or (p_status = 'active' and r.status in ('open', 'investigating', 'appealed')) or r.status = p_status)
          and (p_severity is null or r.severity = p_severity) and (p_user is null or r.target_user = p_user or r.reporter = p_user)
          and (p_q is null or t.username ilike '%' || p_q || '%' or t.display_name ilike '%' || p_q || '%' or r.details ilike '%' || p_q || '%'
               or r.snapshot ilike '%' || p_q || '%' or r.id::text ilike p_q || '%')
    )
    select jsonb_build_object('total', (select count(*) from f),
        'rows', coalesce((select jsonb_agg(to_jsonb(x)) from (select * from f
            order by case severity when 'critical' then 0 when 'high' then 1 when 'medium' then 2 else 3 end, created_at desc
            limit least(greatest(coalesce(p_limit, 50), 1), 200) offset greatest(coalesce(p_offset, 0), 0)) x), '[]'::jsonb))
    into res;
    return res;
end;
$$;
revoke all on function public.diary_cc_reports(text, text, text, uuid, int, int) from public, anon;
grant execute on function public.diary_cc_reports(text, text, text, uuid, int, int) to authenticated;

create or replace function public.diary_cc_update_report(p_id uuid, p_status text default null, p_severity text default null,
                                                         p_assign uuid default null, p_unassign boolean default false, p_note text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare me uuid := private.cc_require('reports.manage'); prev public.diary_reports; r public.diary_reports;
begin
    perform private.cc_rate_limit(me);
    select * into prev from public.diary_reports where id = p_id;
    if prev.id is null then raise exception 'No such report'; end if;
    if p_status in ('actioned', 'dismissed', 'resolved') and coalesce(trim(p_note), '') = '' then raise exception 'Add a resolution note'; end if;
    update public.diary_reports set
        status = coalesce(p_status, status), severity = coalesce(p_severity, severity),
        assigned_to = case when p_unassign then null else coalesce(p_assign, assigned_to) end,
        resolution = case when p_note is not null and p_note <> '' then left(p_note, 300) else resolution end,
        handled_by = case when p_status in ('actioned', 'dismissed', 'resolved') then me else handled_by end,
        handled_at = case when p_status in ('actioned', 'dismissed', 'resolved') then now() else handled_at end,
        updated_at = now()
    where id = p_id returning * into r;
    perform private.cc_audit(case when p_status in ('actioned', 'dismissed', 'resolved') then 'REPORT_RESOLVED' else 'REPORT_UPDATED' end,
        r.target_user, p_note, jsonb_build_object('status', prev.status, 'severity', prev.severity, 'assigned_to', prev.assigned_to),
        jsonb_build_object('status', r.status, 'severity', r.severity, 'assigned_to', r.assigned_to), '{}'::jsonb, 'report', r.id::text);
    return to_jsonb(r);
end;
$$;
revoke all on function public.diary_cc_update_report(uuid, text, text, uuid, boolean, text) from public, anon;
grant execute on function public.diary_cc_update_report(uuid, text, text, uuid, boolean, text) to authenticated;

-- ============================================================================
-- Support helpline
-- ============================================================================
create table if not exists public.diary_support_tickets (
    id uuid primary key default gen_random_uuid(),
    ref bigint generated always as identity,
    user_id uuid not null references public.diary_profiles (id) on delete cascade,
    category text not null check (category in ('account', 'recovery', 'rewards', 'safety', 'bug', 'complaint', 'other')),
    subject text not null check (char_length(subject) between 3 and 140),
    priority text not null default 'normal' check (priority in ('low', 'normal', 'high', 'urgent')),
    status text not null default 'open' check (status in ('open', 'pending', 'escalated', 'resolved')),
    assigned_to uuid references public.diary_profiles (id) on delete set null,
    opened_by_staff boolean not null default false,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    resolved_at timestamptz
);
create index if not exists diary_support_tickets_status_idx on public.diary_support_tickets (status, updated_at desc);
create index if not exists diary_support_tickets_user_idx on public.diary_support_tickets (user_id, created_at desc);
create table if not exists public.diary_support_messages (
    id bigint generated always as identity primary key,
    ticket_id uuid not null references public.diary_support_tickets (id) on delete cascade,
    author uuid references public.diary_profiles (id) on delete set null,
    from_staff boolean not null default false,
    internal boolean not null default false,
    body text not null check (char_length(body) between 1 and 4000),
    created_at timestamptz not null default now()
);
create index if not exists diary_support_messages_ticket_idx on public.diary_support_messages (ticket_id, created_at);
alter table public.diary_support_tickets enable row level security;
alter table public.diary_support_messages enable row level security;
revoke all on public.diary_support_tickets, public.diary_support_messages from anon, authenticated;
create policy "Your tickets, and support staff" on public.diary_support_tickets for select to authenticated
    using (user_id = (select auth.uid()) or private.cc_has_perm((select auth.uid()), 'support.manage'));
create policy "Your ticket messages (not internal notes), and support staff" on public.diary_support_messages for select to authenticated
    using (private.cc_has_perm((select auth.uid()), 'support.manage')
        or (not internal and exists (select 1 from public.diary_support_tickets t where t.id = ticket_id and t.user_id = (select auth.uid()))));
grant select on public.diary_support_tickets, public.diary_support_messages to authenticated;

-- From the app: open a ticket (at most 3 an hour, 5 unresolved at once)
create or replace function public.diary_support_open(p_category text, p_subject text, p_body text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare me uuid := auth.uid(); t public.diary_support_tickets;
begin
    if me is null then raise exception 'Sign in first'; end if;
    if (select count(*) from public.diary_support_tickets where user_id = me and created_at > now() - interval '1 hour') >= 3 then
        raise exception 'You''ve opened a few requests just now — we''ll get to them soon';
    end if;
    if (select count(*) from public.diary_support_tickets where user_id = me and status <> 'resolved') >= 5 then
        raise exception 'You have 5 open requests — reply on one of those instead';
    end if;
    if coalesce(char_length(trim(p_body)), 0) < 5 then raise exception 'Tell us a little more'; end if;
    insert into public.diary_support_tickets (user_id, category, subject, priority)
    values (me, p_category, left(trim(p_subject), 140), case when p_category in ('safety', 'recovery') then 'high' else 'normal' end)
    returning * into t;
    insert into public.diary_support_messages (ticket_id, author, body) values (t.id, me, left(trim(p_body), 4000));
    if t.priority in ('high', 'urgent') then
        perform private.cc_alert('high', 'ticket', format('New %s request: %s', t.category, t.subject),
            (select display_name from public.diary_profiles where id = me), 'ticket:' || t.id);
    end if;
    return to_jsonb(t);
end;
$$;
create or replace function public.diary_support_reply(p_ticket uuid, p_body text) returns void language plpgsql security definer set search_path = '' as $$
declare me uuid := auth.uid();
begin
    if not exists (select 1 from public.diary_support_tickets where id = p_ticket and user_id = me) then raise exception 'No such request'; end if;
    if (select count(*) from public.diary_support_messages where author = me and created_at > now() - interval '1 minute') >= 6 then
        raise exception 'Slow down a little';
    end if;
    insert into public.diary_support_messages (ticket_id, author, body) values (p_ticket, me, left(trim(p_body), 4000));
    update public.diary_support_tickets set status = case when status = 'resolved' then 'open' when status = 'pending' then 'open' else status end,
        resolved_at = null, updated_at = now() where id = p_ticket;
end;
$$;
create or replace function public.diary_support_mine() returns jsonb language sql stable security definer set search_path = '' as $$
    select coalesce(jsonb_agg(jsonb_build_object('id', t.id, 'ref', t.ref, 'category', t.category, 'subject', t.subject, 'status', t.status,
        'updated_at', t.updated_at, 'created_at', t.created_at,
        'messages', (select coalesce(jsonb_agg(jsonb_build_object('body', m.body, 'from_staff', m.from_staff, 'created_at', m.created_at) order by m.created_at), '[]'::jsonb)
                     from public.diary_support_messages m where m.ticket_id = t.id and not m.internal)) order by t.updated_at desc), '[]'::jsonb)
    from public.diary_support_tickets t where t.user_id = auth.uid();
$$;
-- An appeal against a restriction (one open at a time)
create table if not exists public.diary_appeals (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null references public.diary_profiles (id) on delete cascade,
    against text not null,
    body text not null check (char_length(body) between 10 and 2000),
    status text not null default 'open' check (status in ('open', 'upheld', 'overturned')),
    decided_by uuid references public.diary_profiles (id) on delete set null,
    decided_at timestamptz,
    note text check (char_length(note) <= 500),
    created_at timestamptz not null default now()
);
alter table public.diary_appeals enable row level security;
revoke all on public.diary_appeals from anon, authenticated;
create policy "Your appeals, and moderators" on public.diary_appeals for select to authenticated
    using (user_id = (select auth.uid()) or private.cc_has_perm((select auth.uid()), 'reports.manage'));
grant select on public.diary_appeals to authenticated;
-- What the signed-in person sees about their own account
create or replace function public.diary_my_account() returns jsonb language sql stable security definer set search_path = '' as $$
    select jsonb_build_object(
        'status', private.cc_effective(auth.uid()),
        'scope', coalesce((select to_jsonb(scope) from public.diary_account_status where user_id = auth.uid()), '[]'::jsonb),
        'reason', (select reason from public.diary_account_status where user_id = auth.uid() and private.cc_effective(auth.uid()) <> 'active'),
        'message', (select user_message from public.diary_account_status where user_id = auth.uid() and private.cc_effective(auth.uid()) <> 'active'),
        'ends_at', (select ends_at from public.diary_account_status where user_id = auth.uid() and private.cc_effective(auth.uid()) <> 'active'),
        'appeal', (select status from public.diary_appeals where user_id = auth.uid() order by created_at desc limit 1),
        'coins', private.cc_coins(auth.uid())
    );
$$;

create or replace function public.diary_appeal(p_body text) returns void language plpgsql security definer set search_path = '' as $$
declare me uuid := auth.uid(); st text := private.cc_effective(auth.uid());
begin
    if st = 'active' then raise exception 'Your account isn''t restricted'; end if;
    if exists (select 1 from public.diary_appeals where user_id = me and status = 'open') then raise exception 'Your appeal is already being reviewed'; end if;
    insert into public.diary_appeals (user_id, against, body) values (me, st, left(trim(p_body), 2000));
    perform private.cc_alert('warning', 'appeal', 'New appeal', format('%s appeals a %s', (select display_name from public.diary_profiles where id = me), st), 'user:' || me);
end;
$$;
revoke all on function public.diary_support_open(text, text, text), public.diary_support_reply(uuid, text), public.diary_support_mine(),
    public.diary_appeal(text), public.diary_my_account() from public, anon;
grant execute on function public.diary_support_open(text, text, text), public.diary_support_reply(uuid, text), public.diary_support_mine(),
    public.diary_appeal(text), public.diary_my_account() to authenticated;

create or replace function public.diary_cc_appeals(p_status text default 'open') returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
    perform private.cc_require('reports.manage');
    return coalesce((select jsonb_agg(jsonb_build_object('id', a.id, 'user_id', a.user_id, 'username', p.username, 'display_name', p.display_name,
        'avatar_path', p.avatar_path, 'against', a.against, 'body', a.body, 'status', a.status, 'note', a.note, 'created_at', a.created_at,
        'decided_at', a.decided_at, 'decided_name', d.display_name, 'current', private.cc_effective(a.user_id),
        'restriction', (select jsonb_build_object('reason', s.reason, 'ends_at', s.ends_at, 'restricted_at', s.restricted_at, 'by', b.display_name, 'scope', s.scope)
                        from public.diary_account_status s left join public.diary_profiles b on b.id = s.restricted_by where s.user_id = a.user_id)) order by a.created_at desc)
        from public.diary_appeals a join public.diary_profiles p on p.id = a.user_id left join public.diary_profiles d on d.id = a.decided_by
        where p_status = 'all' or a.status = p_status), '[]'::jsonb);
end;
$$;
create or replace function public.diary_cc_decide_appeal(p_id uuid, p_overturn boolean, p_note text) returns void language plpgsql security definer set search_path = '' as $$
declare me uuid := private.cc_require('reports.manage'); a public.diary_appeals;
begin
    perform private.cc_rate_limit(me);
    if coalesce(char_length(trim(p_note)), 0) < 3 then raise exception 'Add a note explaining the decision'; end if;
    update public.diary_appeals set status = case when p_overturn then 'overturned' else 'upheld' end, decided_by = me, decided_at = now(), note = left(p_note, 500)
    where id = p_id and status = 'open' returning * into a;
    if a.id is null then raise exception 'That appeal is already decided'; end if;
    if p_overturn then
        if not private.cc_has_perm(me, 'users.reactivate') then raise exception 'You can''t restore accounts'; end if;
        perform private.cc_apply_status(a.user_id, 'active', '{}', 'Appeal upheld: ' || p_note, null, 'Your appeal was successful — your account is restored.', null, 'USER_REACTIVATED');
    else
        insert into public.diary_notifications (user_id, actor, type, data)
        values (a.user_id, null, 'account_notice', jsonb_build_object('status', a.against, 'message', 'Your appeal was reviewed and the decision stands. ' || p_note));
    end if;
    perform private.cc_audit(case when p_overturn then 'APPEAL_OVERTURNED' else 'APPEAL_UPHELD' end, a.user_id, p_note, null, null, '{}'::jsonb, 'appeal', a.id::text);
end;
$$;
revoke all on function public.diary_cc_appeals(text), public.diary_cc_decide_appeal(uuid, boolean, text) from public, anon;
grant execute on function public.diary_cc_appeals(text), public.diary_cc_decide_appeal(uuid, boolean, text) to authenticated;

-- Staff side of the helpline
create or replace function public.diary_cc_tickets(p_view text default 'open', p_q text default null, p_user uuid default null,
                                                   p_limit int default 50, p_offset int default 0)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare res jsonb;
begin
    perform private.cc_require('support.manage');
    with f as (
        select t.*, u.username, u.display_name, u.avatar_path, a.display_name as assigned_name, private.cc_effective(t.user_id) as user_status,
               (select m.body from public.diary_support_messages m where m.ticket_id = t.id and not m.internal order by m.created_at desc limit 1) as last_message,
               (select m.from_staff from public.diary_support_messages m where m.ticket_id = t.id and not m.internal order by m.created_at desc limit 1) as last_from_staff,
               (select count(*) from public.diary_support_messages m where m.ticket_id = t.id) as message_count
        from public.diary_support_tickets t join public.diary_profiles u on u.id = t.user_id left join public.diary_profiles a on a.id = t.assigned_to
        where (p_user is null or t.user_id = p_user)
          and (p_view = 'all' or (p_view = 'open' and t.status <> 'resolved') or (p_view = 'priority' and t.status <> 'resolved' and t.priority in ('high', 'urgent'))
               or (p_view = 'resolved' and t.status = 'resolved') or (p_view = 'mine' and t.assigned_to = auth.uid() and t.status <> 'resolved')
               or (p_view = t.category and t.status <> 'resolved'))
          and (p_q is null or t.subject ilike '%' || p_q || '%' or u.username ilike '%' || p_q || '%' or u.display_name ilike '%' || p_q || '%'
               or t.ref::text = ltrim(p_q, '#'))
    )
    select jsonb_build_object('total', (select count(*) from f),
        'rows', coalesce((select jsonb_agg(to_jsonb(x)) from (select * from f
            order by case priority when 'urgent' then 0 when 'high' then 1 when 'normal' then 2 else 3 end, updated_at desc
            limit least(greatest(coalesce(p_limit, 50), 1), 200) offset greatest(coalesce(p_offset, 0), 0)) x), '[]'::jsonb))
    into res;
    return res;
end;
$$;
create or replace function public.diary_cc_ticket(p_id uuid) returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare t public.diary_support_tickets;
begin
    perform private.cc_require('support.manage');
    select * into t from public.diary_support_tickets where id = p_id;
    if t.id is null then raise exception 'No such ticket'; end if;
    return jsonb_build_object('ticket', to_jsonb(t) || jsonb_build_object('assigned_name', (select display_name from public.diary_profiles where id = t.assigned_to)),
        'messages', coalesce((select jsonb_agg(jsonb_build_object('id', m.id, 'body', m.body, 'from_staff', m.from_staff, 'internal', m.internal, 'created_at', m.created_at,
            'author', m.author, 'author_name', p.display_name, 'author_avatar', p.avatar_path) order by m.created_at)
            from public.diary_support_messages m left join public.diary_profiles p on p.id = m.author where m.ticket_id = p_id), '[]'::jsonb),
        'previous', coalesce((select jsonb_agg(jsonb_build_object('id', x.id, 'ref', x.ref, 'subject', x.subject, 'status', x.status, 'created_at', x.created_at) order by x.created_at desc)
            from public.diary_support_tickets x where x.user_id = t.user_id and x.id <> t.id), '[]'::jsonb));
end;
$$;
create or replace function public.diary_cc_ticket_reply(p_id uuid, p_body text, p_internal boolean default false) returns void
language plpgsql security definer set search_path = '' as $$
declare me uuid := private.cc_require('support.manage'); t public.diary_support_tickets;
begin
    perform private.cc_rate_limit(me);
    if coalesce(char_length(trim(p_body)), 0) = 0 then raise exception 'Write a reply'; end if;
    select * into t from public.diary_support_tickets where id = p_id;
    if t.id is null then raise exception 'No such ticket'; end if;
    insert into public.diary_support_messages (ticket_id, author, from_staff, internal, body) values (p_id, me, true, p_internal, left(trim(p_body), 4000));
    if not p_internal then
        update public.diary_support_tickets set status = case when status in ('open', 'escalated') then 'pending' else status end,
            assigned_to = coalesce(assigned_to, me), updated_at = now() where id = p_id;
        insert into public.diary_notifications (user_id, actor, type, data)
        values (t.user_id, null, 'support_reply', jsonb_build_object('ticket', t.id, 'ref', t.ref, 'subject', t.subject, 'snippet', left(trim(p_body), 180)));
    else
        update public.diary_support_tickets set updated_at = now() where id = p_id;
    end if;
    perform private.cc_audit(case when p_internal then 'SUPPORT_NOTE_ADDED' else 'SUPPORT_REPLIED' end, t.user_id, null, null, null, '{}'::jsonb, 'ticket', t.id::text);
end;
$$;
create or replace function public.diary_cc_ticket_update(p_id uuid, p_status text default null, p_priority text default null,
                                                         p_assign uuid default null, p_unassign boolean default false)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare me uuid := private.cc_require('support.manage'); prev public.diary_support_tickets; t public.diary_support_tickets;
begin
    perform private.cc_rate_limit(me);
    select * into prev from public.diary_support_tickets where id = p_id;
    if prev.id is null then raise exception 'No such ticket'; end if;
    if p_assign is not null and not exists (select 1 from public.diary_app_admins where user_id = p_assign) then raise exception 'Tickets can only be assigned to admins'; end if;
    update public.diary_support_tickets set status = coalesce(p_status, status), priority = coalesce(p_priority, priority),
        assigned_to = case when p_unassign then null else coalesce(p_assign, assigned_to) end,
        resolved_at = case when p_status = 'resolved' then now() when p_status is not null then null else resolved_at end, updated_at = now()
    where id = p_id returning * into t;
    if p_status = 'escalated' then perform private.cc_alert('high', 'ticket', format('Ticket #%s escalated', t.ref), t.subject, 'ticket:' || t.id); end if;
    perform private.cc_audit('SUPPORT_TICKET_UPDATED', t.user_id, null,
        jsonb_build_object('status', prev.status, 'priority', prev.priority, 'assigned_to', prev.assigned_to),
        jsonb_build_object('status', t.status, 'priority', t.priority, 'assigned_to', t.assigned_to), '{}'::jsonb, 'ticket', t.id::text);
    return to_jsonb(t);
end;
$$;
-- Write to someone first (opens a ticket from the staff side)
create or replace function public.diary_cc_message_user(p_user uuid, p_subject text, p_body text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare me uuid := private.cc_require('support.manage'); t public.diary_support_tickets;
begin
    perform private.cc_rate_limit(me);
    if coalesce(char_length(trim(p_body)), 0) = 0 then raise exception 'Write a message'; end if;
    insert into public.diary_support_tickets (user_id, category, subject, status, assigned_to, opened_by_staff)
    values (p_user, 'other', left(coalesce(nullif(trim(p_subject), ''), 'A message from Cordial'), 140), 'pending', me, true) returning * into t;
    insert into public.diary_support_messages (ticket_id, author, from_staff, body) values (t.id, me, true, left(trim(p_body), 4000));
    insert into public.diary_notifications (user_id, actor, type, data)
    values (p_user, null, 'support_reply', jsonb_build_object('ticket', t.id, 'ref', t.ref, 'subject', t.subject, 'snippet', left(trim(p_body), 180)));
    perform private.cc_audit('USER_MESSAGED', p_user, p_subject, null, null, '{}'::jsonb, 'ticket', t.id::text);
    return to_jsonb(t);
end;
$$;
revoke all on function public.diary_cc_tickets(text, text, uuid, int, int), public.diary_cc_ticket(uuid), public.diary_cc_ticket_reply(uuid, text, boolean),
    public.diary_cc_ticket_update(uuid, text, text, uuid, boolean), public.diary_cc_message_user(uuid, text, text) from public, anon;
grant execute on function public.diary_cc_tickets(text, text, uuid, int, int), public.diary_cc_ticket(uuid), public.diary_cc_ticket_reply(uuid, text, boolean),
    public.diary_cc_ticket_update(uuid, text, text, uuid, boolean), public.diary_cc_message_user(uuid, text, text) to authenticated;

-- ============================================================================
-- Users: list, search, the full picture of one person, and their timeline
-- ============================================================================
create or replace function private.cc_user_row(p_id uuid) returns jsonb language sql stable security definer set search_path = '' as $$
    select jsonb_build_object('id', p.id, 'username', p.username, 'display_name', p.display_name, 'avatar_path', p.avatar_path, 'verified', p.verified,
        'created_at', p.created_at, 'email', u.email, 'phone', u.phone, 'last_sign_in_at', u.last_sign_in_at,
        'last_seen_at', pr.last_seen_at, 'status', private.cc_effective(p.id), 'scope', coalesce(to_jsonb(s.scope), '[]'::jsonb),
        'status_reason', s.reason, 'ends_at', s.ends_at, 'xp', private.diary_xp(p.id), 'coins', private.cc_coins(p.id),
        'streak', coalesce((public.diary_trivia_stats_for(p.id)->>'streak')::int, 0),
        'posts', (select count(*) from public.diary_shared_entries e where e.author = p.id),
        'reports', (select count(*) from public.diary_reports r where r.target_user = p.id),
        'is_admin', exists (select 1 from public.diary_app_admins a where a.user_id = p.id))
    from public.diary_profiles p
    left join auth.users u on u.id = p.id
    left join public.diary_presence pr on pr.user_id = p.id
    left join public.diary_account_status s on s.user_id = p.id
    where p.id = p_id;
$$;

create or replace function public.diary_cc_users(p_status text default null, p_q text default null, p_sort text default 'joined', p_desc boolean default true,
                                                 p_limit int default 50, p_offset int default 0)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare res jsonb; q text := nullif(trim(coalesce(p_q, '')), '');
begin
    perform private.cc_require('users.read');
    with f as (
        select p.id, p.created_at, pr.last_seen_at, private.cc_effective(p.id) as st, p.display_name
        from public.diary_profiles p
        left join auth.users u on u.id = p.id
        left join public.diary_presence pr on pr.user_id = p.id
        where (q is null or p.username ilike '%' || q || '%' or p.display_name ilike '%' || q || '%' or u.email ilike '%' || q || '%'
               or u.phone ilike '%' || q || '%' or p.id::text ilike q || '%')
    ), g as (select * from f where p_status is null or p_status = 'all' or st = p_status)
    select jsonb_build_object('total', (select count(*) from g),
        'rows', coalesce((select jsonb_agg(private.cc_user_row(x.id) order by x.ord) from (
            select id, row_number() over (order by
                case when p_sort = 'name' and not p_desc then display_name end asc, case when p_sort = 'name' and p_desc then display_name end desc,
                case when p_sort = 'active' and not p_desc then last_seen_at end asc nulls first, case when p_sort = 'active' and p_desc then last_seen_at end desc nulls last,
                case when p_sort = 'joined' and not p_desc then created_at end asc, case when p_sort = 'joined' and p_desc then created_at end desc) as ord
            from g order by ord
            limit least(greatest(coalesce(p_limit, 50), 1), 200) offset greatest(coalesce(p_offset, 0), 0)) x), '[]'::jsonb),
        'counts', (select jsonb_object_agg(st, n) from (select st, count(*) n from f group by st) c))
    into res;
    return res;
end;
$$;
revoke all on function public.diary_cc_users(text, text, text, boolean, int, int) from public, anon;
grant execute on function public.diary_cc_users(text, text, text, boolean, int, int) to authenticated;

create or replace function public.diary_cc_user(p_user uuid) returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare base jsonb;
begin
    perform private.cc_require('users.read');
    base := private.cc_user_row(p_user);
    if base is null then raise exception 'No such user'; end if;
    return base || jsonb_build_object(
        'restriction', (select jsonb_build_object('status', s.status, 'scope', s.scope, 'reason', s.reason, 'user_message', s.user_message, 'admin_note', s.admin_note,
                        'starts_at', s.starts_at, 'ends_at', s.ends_at, 'restricted_at', s.restricted_at, 'restricted_by', s.restricted_by, 'by_name', b.display_name)
                        from public.diary_account_status s left join public.diary_profiles b on b.id = s.restricted_by where s.user_id = p_user),
        'level', private.diary_level(private.diary_xp(p_user)),
        'counts', jsonb_build_object(
            'posts', (select count(*) from public.diary_shared_entries where author = p_user),
            'reels', (select count(*) from public.diary_reels where author = p_user),
            'stories', (select count(*) from public.diary_stories where author = p_user),
            'comments', (select count(*) from public.diary_comments where author = p_user),
            'messages', (select count(*) from public.diary_messages where sender = p_user),
            'friends', (select count(*) from public.diary_friendships where (requester = p_user or addressee = p_user) and status = 'accepted'),
            'followers', (select count(*) from public.diary_follows where followee = p_user),
            'reports_received', (select count(*) from public.diary_reports where target_user = p_user),
            'reports_filed', (select count(*) from public.diary_reports where reporter = p_user),
            'tickets', (select count(*) from public.diary_support_tickets where user_id = p_user),
            'badges', (select count(*) from public.diary_user_badges where user_id = p_user)),
        'rewards_total', jsonb_build_object(
            'xp', coalesce((select sum(amount) from public.diary_rewards where user_id = p_user and kind = 'xp' and status = 'delivered'), 0),
            'coins', private.cc_coins(p_user),
            'count', (select count(*) from public.diary_rewards where user_id = p_user)),
        'admin_role', (select role from public.diary_app_admins where user_id = p_user),
        'open_appeal', (select to_jsonb(a) from public.diary_appeals a where a.user_id = p_user and a.status = 'open' limit 1),
        'history', coalesce((select jsonb_agg(jsonb_build_object('id', l.id, 'action', l.action, 'reason', l.reason, 'prev', l.prev_state, 'next', l.new_state,
            'details', l.details, 'actor_name', a.display_name, 'created_at', l.created_at) order by l.created_at desc)
            from (select * from public.diary_audit_log where target_user = p_user order by created_at desc limit 30) l
            left join public.diary_profiles a on a.id = l.actor), '[]'::jsonb));
end;
$$;
revoke all on function public.diary_cc_user(uuid) from public, anon;
grant execute on function public.diary_cc_user(uuid) to authenticated;

-- Everything that happened, newest first. Messages are counted per day — their content is never shown.
create or replace function public.diary_cc_timeline(p_user uuid, p_before timestamptz default null, p_limit int default 60)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare before timestamptz := coalesce(p_before, now() + interval '1 minute');
begin
    perform private.cc_require('users.read');
    return coalesce((select jsonb_agg(to_jsonb(e) order by e.at desc) from (
        select * from (
            select 'joined' as kind, p.created_at as at, 'Joined Cordial' as title, null::text as detail, null::text as ref from public.diary_profiles p where p.id = p_user
            union all select 'post', e.shared_at, 'Shared a post', left(coalesce(nullif(e.title, ''), e.body), 140), 'entry:' || e.id from public.diary_shared_entries e where e.author = p_user
            union all select 'reel', r.created_at, 'Published a reel', left(r.caption, 140), 'reel:' || r.id from public.diary_reels r where r.author = p_user
            union all select 'story', s.created_at, 'Posted a story', left(s.caption, 140), null from public.diary_stories s where s.author = p_user
            union all select 'comment', c.created_at, 'Commented', left(c.body, 140), null from public.diary_comments c where c.author = p_user
            union all select 'messages', max(m.created_at), format('Sent %s %s', count(*), case when count(*) = 1 then 'message' else 'messages' end), null, null
                from public.diary_messages m where m.sender = p_user group by (m.created_at at time zone 'utc')::date
            union all select 'badge', b.earned_at, 'Earned a badge', (select name from public.diary_badges where id = b.badge), null from public.diary_user_badges b where b.user_id = p_user
            union all select 'reward', w.created_at, 'Received a reward', format('%s %s — %s', case when w.kind in ('xp', 'coins') then w.amount::text else '' end, w.kind, w.reason), 'reward:' || w.id
                from public.diary_rewards w where w.user_id = p_user
            union all select 'reported', r.created_at, 'Was reported', replace(r.reason, '_', ' ') || coalesce(': ' || left(r.details, 100), ''), 'report:' || r.id from public.diary_reports r where r.target_user = p_user
            union all select 'report_filed', r.created_at, 'Reported someone', replace(r.reason, '_', ' '), 'report:' || r.id from public.diary_reports r where r.reporter = p_user
            union all select 'ticket', t.created_at, 'Contacted support', t.subject, 'ticket:' || t.id from public.diary_support_tickets t where t.user_id = p_user
            union all select 'admin', l.created_at, replace(initcap(replace(l.action, '_', ' ')), 'Usr', 'User'), l.reason, null from public.diary_audit_log l where l.target_user = p_user
        ) all_events where at < before
        order by at desc limit least(greatest(coalesce(p_limit, 60), 1), 200)
    ) e), '[]'::jsonb);
end;
$$;
revoke all on function public.diary_cc_timeline(uuid, timestamptz, int) from public, anon;
grant execute on function public.diary_cc_timeline(uuid, timestamptz, int) to authenticated;

-- ============================================================================
-- Overview, analytics, search, audit, alerts, admins
-- ============================================================================
create or replace function public.diary_cc_overview() returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare today timestamptz := date_trunc('day', now()); week timestamptz := now() - interval '7 days';
begin
    perform private.cc_require('users.read');
    return jsonb_build_object(
        'users', jsonb_build_object(
            'total', (select count(*) from public.diary_profiles),
            'active_24h', (select count(*) from public.diary_presence where last_seen_at > now() - interval '24 hours'),
            'active_7d', (select count(*) from public.diary_presence where last_seen_at > week),
            'new_today', (select count(*) from public.diary_profiles where created_at >= today),
            'new_week', (select count(*) from public.diary_profiles where created_at >= week),
            'suspended', (select count(*) from public.diary_profiles p where private.cc_effective(p.id) = 'suspended'),
            'blocked', (select count(*) from public.diary_profiles p where private.cc_effective(p.id) = 'blocked'),
            'deactivated', (select count(*) from public.diary_profiles p where private.cc_effective(p.id) = 'deactivated')),
        'engagement', jsonb_build_object(
            'posts', (select count(*) from public.diary_shared_entries where shared_at >= today),
            'reels', (select count(*) from public.diary_reels where created_at >= today),
            'stories', (select count(*) from public.diary_stories where created_at >= today),
            'comments', (select count(*) from public.diary_comments where created_at >= today),
            'messages', (select count(*) from public.diary_messages where created_at >= today) + (select count(*) from public.diary_community_messages where created_at >= today),
            'streaks', (select count(distinct user_id) from public.diary_trivia_rounds where kind = 'daily' and finished_at > now() - interval '36 hours')),
        'moderation', jsonb_build_object(
            'open_reports', (select count(*) from public.diary_reports where status in ('open', 'investigating', 'appealed')),
            'high_reports', (select count(*) from public.diary_reports where status in ('open', 'investigating') and severity in ('high', 'critical')),
            'open_appeals', (select count(*) from public.diary_appeals where status = 'open'),
            'suspensions_week', (select count(*) from public.diary_audit_log where action in ('USER_SUSPENDED', 'suspend') and created_at >= week),
            'blocks_week', (select count(*) from public.diary_audit_log where action = 'USER_BLOCKED' and created_at >= week),
            'deactivations_week', (select count(*) from public.diary_audit_log where action = 'USER_DEACTIVATED' and created_at >= week)),
        'support', jsonb_build_object(
            'open', (select count(*) from public.diary_support_tickets where status <> 'resolved'),
            'urgent', (select count(*) from public.diary_support_tickets where status <> 'resolved' and priority in ('high', 'urgent')),
            'waiting', (select count(*) from public.diary_support_tickets t where status in ('open', 'escalated')),
            'resolved_week', (select count(*) from public.diary_support_tickets where resolved_at >= week),
            'median_hours', (select round((percentile_cont(0.5) within group (order by extract(epoch from resolved_at - created_at) / 3600))::numeric, 1)
                             from public.diary_support_tickets where resolved_at >= now() - interval '30 days')),
        'rewards', jsonb_build_object(
            'today', (select count(*) from public.diary_rewards where created_at >= today and status = 'delivered'),
            'week', (select count(*) from public.diary_rewards where created_at >= week and status = 'delivered'),
            'xp_total', coalesce((select sum(amount) from public.diary_rewards where kind = 'xp' and status = 'delivered'), 0),
            'coins_total', coalesce((select sum(amount) from public.diary_rewards where kind = 'coins' and status = 'delivered'), 0),
            'pending', (select count(*) from public.diary_rewards where status = 'pending_review')),
        'alerts_unread', (select count(*) from public.diary_cc_alerts where read_at is null)
    );
end;
$$;
revoke all on function public.diary_cc_overview() from public, anon;
grant execute on function public.diary_cc_overview() to authenticated;

-- Daily series for charts. "Active" = people who posted, commented, messaged or played that day (Cordial keeps
-- no visit history, so this is activity, not visits).
create or replace function public.diary_cc_series(p_days int default 30) returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare n int := least(greatest(coalesce(p_days, 30), 7), 90);
begin
    perform private.cc_require('analytics.view');
    return (select jsonb_agg(jsonb_build_object('day', d,
        'signups', (select count(*) from public.diary_profiles where created_at >= d and created_at < d + 1),
        'active', (select count(distinct uid) from (
            select author as uid from public.diary_shared_entries where shared_at >= d and shared_at < d + 1
            union select author from public.diary_comments where created_at >= d and created_at < d + 1
            union select sender from public.diary_messages where created_at >= d and created_at < d + 1
            union select user_id from public.diary_trivia_rounds where finished_at >= d and finished_at < d + 1) a),
        'posts', (select count(*) from public.diary_shared_entries where shared_at >= d and shared_at < d + 1),
        'messages', (select count(*) from public.diary_messages where created_at >= d and created_at < d + 1),
        'reports', (select count(*) from public.diary_reports where created_at >= d and created_at < d + 1),
        'restrictions', (select count(*) from public.diary_audit_log where action in ('USER_SUSPENDED', 'USER_BLOCKED', 'USER_DEACTIVATED', 'suspend')
                         and created_at >= d and created_at < d + 1),
        'rewards', (select count(*) from public.diary_rewards where status = 'delivered' and created_at >= d and created_at < d + 1),
        'tickets', (select count(*) from public.diary_support_tickets where created_at >= d and created_at < d + 1),
        'resolved', (select count(*) from public.diary_support_tickets where resolved_at >= d and resolved_at < d + 1)) order by d)
        from generate_series((now() at time zone 'utc')::date - (n - 1), (now() at time zone 'utc')::date, interval '1 day') g(dd),
             lateral (select dd::date as d) x);
end;
$$;
revoke all on function public.diary_cc_series(int) from public, anon;
grant execute on function public.diary_cc_series(int) to authenticated;

create or replace function public.diary_cc_search(p_q text) returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare q text := nullif(trim(coalesce(p_q, '')), ''); me uuid := private.cc_require('users.read');
begin
    if q is null or char_length(q) < 2 then return '{}'::jsonb; end if;
    return jsonb_build_object(
        'users', coalesce((select jsonb_agg(private.cc_user_row(x.id)) from (
            select p.id from public.diary_profiles p left join auth.users u on u.id = p.id
            where p.username ilike '%' || q || '%' or p.display_name ilike '%' || q || '%' or u.email ilike '%' || q || '%' or u.phone ilike '%' || q || '%' or p.id::text ilike q || '%'
            order by (lower(p.username) = lower(ltrim(q, '@'))) desc, p.created_at desc limit 8) x), '[]'::jsonb),
        'reports', case when private.cc_has_perm(me, 'reports.manage') then coalesce((select jsonb_agg(jsonb_build_object('id', r.id, 'reason', r.reason, 'status', r.status,
            'severity', r.severity, 'target', t.display_name, 'created_at', r.created_at)) from (
            select * from public.diary_reports r where r.id::text ilike q || '%' or r.details ilike '%' || q || '%' or r.snapshot ilike '%' || q || '%'
            order by created_at desc limit 5) r left join public.diary_profiles t on t.id = r.target_user), '[]'::jsonb) else '[]'::jsonb end,
        'tickets', case when private.cc_has_perm(me, 'support.manage') then coalesce((select jsonb_agg(jsonb_build_object('id', t.id, 'ref', t.ref, 'subject', t.subject,
            'status', t.status, 'priority', t.priority, 'user', u.display_name, 'created_at', t.created_at)) from (
            select * from public.diary_support_tickets t where t.subject ilike '%' || q || '%' or t.ref::text = ltrim(q, '#') order by updated_at desc limit 5) t
            join public.diary_profiles u on u.id = t.user_id), '[]'::jsonb) else '[]'::jsonb end,
        'rewards', coalesce((select jsonb_agg(jsonb_build_object('id', w.id, 'kind', w.kind, 'amount', w.amount, 'reason', w.reason, 'user', u.display_name,
            'user_id', w.user_id, 'created_at', w.created_at)) from (
            select * from public.diary_rewards w where w.id::text ilike q || '%' or w.reason ilike '%' || q || '%' order by created_at desc limit 5) w
            join public.diary_profiles u on u.id = w.user_id), '[]'::jsonb),
        'audit', case when private.cc_has_perm(me, 'audit.view') then coalesce((select jsonb_agg(jsonb_build_object('id', l.id, 'action', l.action, 'reason', l.reason,
            'target', t.display_name, 'target_user', l.target_user, 'created_at', l.created_at)) from (
            select * from public.diary_audit_log l where l.action ilike '%' || q || '%' or l.reason ilike '%' || q || '%' order by created_at desc limit 5) l
            left join public.diary_profiles t on t.id = l.target_user), '[]'::jsonb) else '[]'::jsonb end,
        'content', coalesce((select jsonb_agg(jsonb_build_object('id', e.id, 'title', e.title, 'snippet', left(e.body, 140), 'author', u.display_name,
            'author_id', e.author, 'created_at', e.shared_at)) from (
            select * from public.diary_shared_entries e where e.title ilike '%' || q || '%' or e.body ilike '%' || q || '%' order by shared_at desc limit 5) e
            join public.diary_profiles u on u.id = e.author), '[]'::jsonb));
end;
$$;
revoke all on function public.diary_cc_search(text) from public, anon;
grant execute on function public.diary_cc_search(text) to authenticated;

create or replace function public.diary_cc_audit(p_q text default null, p_action text default null, p_actor uuid default null, p_target uuid default null,
    p_from timestamptz default null, p_to timestamptz default null, p_limit int default 50, p_offset int default 0)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare res jsonb;
begin
    perform private.cc_require('audit.view');
    with f as (
        select l.*, a.display_name as actor_name, a.avatar_path as actor_avatar, t.display_name as target_name, t.username as target_username
        from public.diary_audit_log l left join public.diary_profiles a on a.id = l.actor left join public.diary_profiles t on t.id = l.target_user
        where (p_action is null or l.action = p_action) and (p_actor is null or l.actor = p_actor) and (p_target is null or l.target_user = p_target)
          and (p_from is null or l.created_at >= p_from) and (p_to is null or l.created_at < p_to)
          and (p_q is null or l.action ilike '%' || p_q || '%' or l.reason ilike '%' || p_q || '%' or t.display_name ilike '%' || p_q || '%'
               or t.username ilike '%' || p_q || '%' or a.display_name ilike '%' || p_q || '%' or l.target_ref ilike p_q || '%')
    )
    select jsonb_build_object('total', (select count(*) from f),
        'actions', (select coalesce(jsonb_agg(distinct action), '[]'::jsonb) from public.diary_audit_log),
        'rows', coalesce((select jsonb_agg(to_jsonb(x) order by x.created_at desc) from (select * from f order by created_at desc
            limit least(greatest(coalesce(p_limit, 50), 1), 200) offset greatest(coalesce(p_offset, 0), 0)) x), '[]'::jsonb))
    into res;
    return res;
end;
$$;
revoke all on function public.diary_cc_audit(text, text, uuid, uuid, timestamptz, timestamptz, int, int) from public, anon;
grant execute on function public.diary_cc_audit(text, text, uuid, uuid, timestamptz, timestamptz, int, int) to authenticated;

create or replace function public.diary_cc_alerts(p_limit int default 50) returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
    perform private.cc_require('users.read');
    return coalesce((select jsonb_agg(to_jsonb(a) order by a.created_at desc) from (select * from public.diary_cc_alerts order by created_at desc
        limit least(greatest(coalesce(p_limit, 50), 1), 200)) a), '[]'::jsonb);
end;
$$;
create or replace function public.diary_cc_alerts_read(p_ids bigint[] default null) returns void language plpgsql security definer set search_path = '' as $$
begin
    perform private.cc_require('users.read');
    update public.diary_cc_alerts set read_at = now() where read_at is null and (p_ids is null or id = any (p_ids));
end;
$$;
revoke all on function public.diary_cc_alerts(int), public.diary_cc_alerts_read(bigint[]) from public, anon;
grant execute on function public.diary_cc_alerts(int), public.diary_cc_alerts_read(bigint[]) to authenticated;

create or replace function public.diary_cc_admins() returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
    perform private.cc_require('users.read');
    return coalesce((select jsonb_agg(jsonb_build_object('id', p.id, 'username', p.username, 'display_name', p.display_name, 'avatar_path', p.avatar_path,
        'role', a.role, 'added_at', a.added_at) order by a.added_at) from public.diary_app_admins a join public.diary_profiles p on p.id = a.user_id), '[]'::jsonb);
end;
$$;
create or replace function public.diary_cc_set_admin(p_user uuid, p_role text) returns void language plpgsql security definer set search_path = '' as $$
declare me uuid := private.cc_require('admins.manage'); prev text;
begin
    perform private.cc_rate_limit(me);
    select role into prev from public.diary_app_admins where user_id = p_user;
    if p_role is null then
        if p_user = me then raise exception 'You can''t remove yourself'; end if;
        delete from public.diary_app_admins where user_id = p_user;
    else
        if p_role not in ('super_admin', 'moderator', 'support', 'analyst') then raise exception 'Unknown role'; end if;
        if p_user = me and p_role <> 'super_admin' and (select count(*) from public.diary_app_admins where role = 'super_admin') <= 1 then
            raise exception 'You''re the only super admin — add another before changing your own role';
        end if;
        insert into public.diary_app_admins (user_id, role) values (p_user, p_role) on conflict (user_id) do update set role = excluded.role;
    end if;
    perform private.cc_audit('ADMIN_ROLE_CHANGED', p_user, null, jsonb_build_object('role', prev), jsonb_build_object('role', p_role));
end;
$$;
revoke all on function public.diary_cc_admins(), public.diary_cc_set_admin(uuid, text) from public, anon;
grant execute on function public.diary_cc_admins(), public.diary_cc_set_admin(uuid, text) to authenticated;

-- ============================================================================
-- Notifications to the person: rewards, support replies, account notices (with push)
-- ============================================================================
alter table public.diary_notifications drop constraint if exists diary_notifications_type_check;
alter table public.diary_notifications add constraint diary_notifications_type_check check (type = any (array[
    'friend_request', 'friend_accepted', 'entry_like', 'entry_comment', 'post_like', 'post_comment', 'community_post', 'community_join', 'call_started',
    'missed_call', 'entry_repost', 'reel_like', 'reel_comment', 'library_like', 'live_started', 'new_follower', 'book_request', 'book_request_update',
    'book_message', 'entry_reaction', 'story_reaction', 'mention', 'reply', 'new_login', 'post_activity', 'scheduled_published', 'scheduled_failed',
    'trivia_rank', 'badge_earned', 'announcement', 'verification_update', 'game_invite', 'game_turn', 'game_over', 'comment_reply', 'referral_joined',
    'tagged', 'space_live', 'new_post', 'reward_received', 'support_reply', 'account_notice']));

create or replace function private.diary_push_notification() returns trigger language plpgsql security definer set search_path = '' as $$
declare
    cfg private.diary_push_config;
    target text;
begin
    if new.type not in ('friend_request', 'friend_accepted', 'new_follower', 'live_started', 'mention', 'reply', 'new_login', 'call_started',
                        'scheduled_published', 'scheduled_failed', 'post_activity', 'game_invite', 'game_turn', 'game_over', 'comment_reply',
                        'referral_joined', 'tagged', 'announcement', 'space_live',
                        'entry_like', 'entry_reaction', 'post_like', 'reel_like', 'new_post',
                        'reward_received', 'support_reply', 'account_notice') then
        return new;
    end if;
    if not exists (select 1 from public.diary_push_subscriptions where user_id = new.user_id) then
        return new;
    end if;
    if new.type in ('entry_like', 'entry_reaction', 'post_like', 'reel_like') then
        target := coalesce(new.data->>'entry_id', new.data->>'entry', new.data->>'post_id', new.data->>'reel_id', '');
        if exists (
            select 1 from public.diary_notifications n
            where n.user_id = new.user_id and n.actor = new.actor and n.type = new.type and n.id <> new.id
              and coalesce(n.data->>'entry_id', n.data->>'entry', n.data->>'post_id', n.data->>'reel_id', '') = target
              and n.created_at > now() - interval '10 minutes'
        ) then
            return new;
        end if;
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
$$;
