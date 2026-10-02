-- Helpline: members message Cordial for help (Settings → Help & support). The Cordial Assistant — an AI that
-- writes in the founder's voice and is always labelled as AI — answers first, and hands the conversation to a
-- person whenever it can't help, the member asks for one, or it's about safety, account changes, rewards or
-- recovery. Admins read and answer in Moderation → Helpline. Self-contained: needs only the existing admin list.

-- ---------- Tables ----------
create table if not exists public.diary_support_tickets (
    id uuid primary key default gen_random_uuid(),
    ref bigint generated always as identity,
    user_id uuid not null references public.diary_profiles (id) on delete cascade,
    category text not null check (category in ('account', 'recovery', 'rewards', 'safety', 'bug', 'complaint', 'other')),
    subject text not null check (char_length(subject) between 3 and 140),
    priority text not null default 'normal' check (priority in ('low', 'normal', 'high', 'urgent')),
    status text not null default 'open' check (status in ('open', 'pending', 'escalated', 'resolved')),
    ai_active boolean not null default true,              -- false once a person takes over
    handoff_reason text check (char_length(handoff_reason) <= 300),
    assigned_to uuid references public.diary_profiles (id) on delete set null,
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
    ai boolean not null default false,                    -- written by the Cordial Assistant
    internal boolean not null default false,              -- staff-only note
    body text not null check (char_length(body) between 1 and 4000),
    created_at timestamptz not null default now()
);
create index if not exists diary_support_messages_ticket_idx on public.diary_support_messages (ticket_id, created_at);
create table if not exists public.diary_helpline_settings (
    id boolean primary key default true check (id),
    ai_enabled boolean not null default true,
    voice_name text not null default 'Noah' check (char_length(voice_name) <= 60),
    voice_notes text not null default '' check (char_length(voice_notes) <= 4000),
    max_ai_replies int not null default 12 check (max_ai_replies between 1 and 50),
    updated_at timestamptz not null default now()
);
insert into public.diary_helpline_settings (id) values (true) on conflict do nothing;

alter table public.diary_support_tickets enable row level security;
alter table public.diary_support_messages enable row level security;
alter table public.diary_helpline_settings enable row level security;
revoke all on public.diary_support_tickets, public.diary_support_messages, public.diary_helpline_settings from anon, authenticated;
create policy "Your requests, and admins" on public.diary_support_tickets for select to authenticated
    using (user_id = (select auth.uid()) or private.diary_is_app_admin((select auth.uid())));
create policy "Your request messages (not staff notes), and admins" on public.diary_support_messages for select to authenticated
    using (private.diary_is_app_admin((select auth.uid()))
        or (not internal and exists (select 1 from public.diary_support_tickets t where t.id = ticket_id and t.user_id = (select auth.uid()))));
grant select on public.diary_support_tickets, public.diary_support_messages to authenticated;

-- ---------- Notifications: replies to members, hand-offs to admins (with push) ----------
alter table public.diary_notifications drop constraint if exists diary_notifications_type_check;
alter table public.diary_notifications add constraint diary_notifications_type_check check (type = any (array[
    'friend_request', 'friend_accepted', 'entry_like', 'entry_comment', 'post_like', 'post_comment', 'community_post', 'community_join', 'call_started',
    'missed_call', 'entry_repost', 'reel_like', 'reel_comment', 'library_like', 'live_started', 'new_follower', 'book_request', 'book_request_update',
    'book_message', 'entry_reaction', 'story_reaction', 'mention', 'reply', 'new_login', 'post_activity', 'scheduled_published', 'scheduled_failed',
    'trivia_rank', 'badge_earned', 'announcement', 'verification_update', 'game_invite', 'game_turn', 'game_over', 'comment_reply', 'referral_joined',
    'tagged', 'space_live', 'new_post', 'support_reply', 'helpline_handoff']));

create or replace function private.diary_push_notification() returns trigger language plpgsql security definer set search_path = '' as $$
declare
    cfg private.diary_push_config;
    target text;
begin
    if new.type not in ('friend_request', 'friend_accepted', 'new_follower', 'live_started', 'mention', 'reply', 'new_login', 'call_started',
                        'scheduled_published', 'scheduled_failed', 'post_activity', 'game_invite', 'game_turn', 'game_over', 'comment_reply',
                        'referral_joined', 'tagged', 'announcement', 'space_live',
                        'entry_like', 'entry_reaction', 'post_like', 'reel_like', 'new_post', 'support_reply', 'helpline_handoff') then
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

-- Tell every admin (used for hand-offs and urgent requests)
create or replace function private.diary_helpline_alert(p_ticket public.diary_support_tickets, p_reason text) returns void
language sql security definer set search_path = '' as $$
    insert into public.diary_notifications (user_id, actor, type, data)
    select a.user_id, p_ticket.user_id, 'helpline_handoff', jsonb_build_object('ticket', p_ticket.id, 'ref', p_ticket.ref, 'subject', p_ticket.subject,
        'reason', left(p_reason, 200), 'priority', p_ticket.priority)
    from public.diary_app_admins a where a.user_id <> p_ticket.user_id;
$$;

-- ---------- Members ----------
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
    if t.priority in ('high', 'urgent') then perform private.diary_helpline_alert(t, 'New ' || t.category || ' request'); end if;
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
    if coalesce(char_length(trim(p_body)), 0) = 0 then raise exception 'Write a message'; end if;
    insert into public.diary_support_messages (ticket_id, author, body) values (p_ticket, me, left(trim(p_body), 4000));
    update public.diary_support_tickets set status = case when status in ('resolved', 'pending') then 'open' else status end,
        resolved_at = null, updated_at = now() where id = p_ticket;
end;
$$;
create or replace function public.diary_support_mine() returns jsonb language sql stable security definer set search_path = '' as $$
    select coalesce(jsonb_agg(jsonb_build_object('id', t.id, 'ref', t.ref, 'category', t.category, 'subject', t.subject, 'status', t.status,
        'updated_at', t.updated_at, 'created_at', t.created_at,
        'ai_active', t.ai_active and (select ai_enabled from public.diary_helpline_settings),
        'messages', (select coalesce(jsonb_agg(jsonb_build_object('body', m.body, 'from_staff', m.from_staff, 'ai', m.ai, 'created_at', m.created_at) order by m.created_at), '[]'::jsonb)
                     from public.diary_support_messages m where m.ticket_id = t.id and not m.internal)) order by t.updated_at desc), '[]'::jsonb)
    from public.diary_support_tickets t where t.user_id = auth.uid();
$$;
revoke all on function public.diary_support_open(text, text, text), public.diary_support_reply(uuid, text), public.diary_support_mine() from public, anon;
grant execute on function public.diary_support_open(text, text, text), public.diary_support_reply(uuid, text), public.diary_support_mine() to authenticated;

-- ---------- Admins (Moderation → Helpline) ----------
create or replace function public.diary_helpline_tickets(p_view text default 'open') returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
    perform private.diary_require_admin();
    return coalesce((select jsonb_agg(x order by (x->>'sort')::int, x->>'updated_at' desc) from (
        select to_jsonb(t) || jsonb_build_object('username', u.username, 'display_name', u.display_name, 'avatar_path', u.avatar_path,
            'sort', case when not t.ai_active and t.status <> 'resolved' then 0 when t.priority in ('urgent', 'high') then 1 else 2 end,
            'last', (select jsonb_build_object('body', left(m.body, 160), 'from_staff', m.from_staff, 'ai', m.ai) from public.diary_support_messages m
                     where m.ticket_id = t.id and not m.internal order by m.created_at desc limit 1)) as x
        from public.diary_support_tickets t join public.diary_profiles u on u.id = t.user_id
        where (p_view = 'all') or (p_view = 'open' and t.status <> 'resolved') or (p_view = 'human' and t.status <> 'resolved' and not t.ai_active)
           or (p_view = 'resolved' and t.status = 'resolved')
        limit 200) s), '[]'::jsonb);
end;
$$;
create or replace function public.diary_helpline_thread(p_id uuid) returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
    perform private.diary_require_admin();
    return (select jsonb_build_object('ticket', to_jsonb(t) || jsonb_build_object('username', u.username, 'display_name', u.display_name, 'avatar_path', u.avatar_path),
        'messages', coalesce((select jsonb_agg(jsonb_build_object('id', m.id, 'body', m.body, 'from_staff', m.from_staff, 'ai', m.ai, 'internal', m.internal,
            'created_at', m.created_at, 'author_name', p.display_name) order by m.created_at)
            from public.diary_support_messages m left join public.diary_profiles p on p.id = m.author where m.ticket_id = t.id), '[]'::jsonb))
        from public.diary_support_tickets t join public.diary_profiles u on u.id = t.user_id where t.id = p_id);
end;
$$;
-- A person replying takes the conversation over from the assistant
create or replace function public.diary_helpline_reply(p_id uuid, p_body text, p_internal boolean default false) returns void
language plpgsql security definer set search_path = '' as $$
declare me uuid := private.diary_require_admin(); t public.diary_support_tickets;
begin
    if coalesce(char_length(trim(p_body)), 0) = 0 then raise exception 'Write a reply'; end if;
    select * into t from public.diary_support_tickets where id = p_id;
    if t.id is null then raise exception 'No such request'; end if;
    insert into public.diary_support_messages (ticket_id, author, from_staff, internal, body) values (p_id, me, true, p_internal, left(trim(p_body), 4000));
    if not p_internal then
        update public.diary_support_tickets set status = 'pending', ai_active = false, assigned_to = coalesce(assigned_to, me), updated_at = now() where id = p_id;
        insert into public.diary_notifications (user_id, actor, type, data)
        values (t.user_id, me, 'support_reply', jsonb_build_object('ticket', t.id, 'ref', t.ref, 'subject', t.subject, 'snippet', left(trim(p_body), 180)));
    end if;
    perform private.diary_audit(case when p_internal then 'helpline_note' else 'helpline_reply' end, t.user_id, jsonb_build_object('ticket', t.id));
end;
$$;
create or replace function public.diary_helpline_update(p_id uuid, p_status text default null, p_ai boolean default null) returns void
language plpgsql security definer set search_path = '' as $$
declare me uuid := private.diary_require_admin(); t public.diary_support_tickets;
begin
    update public.diary_support_tickets set status = coalesce(p_status, status), ai_active = coalesce(p_ai, ai_active),
        handoff_reason = case when p_ai then null else handoff_reason end,
        resolved_at = case when p_status = 'resolved' then now() when p_status is not null then null else resolved_at end, updated_at = now()
    where id = p_id returning * into t;
    if t.id is null then raise exception 'No such request'; end if;
    perform private.diary_audit('helpline_update', t.user_id, jsonb_build_object('ticket', t.id, 'status', p_status, 'ai', p_ai));
end;
$$;
create or replace function public.diary_helpline_settings() returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
    perform private.diary_require_admin();
    return (select to_jsonb(s) from public.diary_helpline_settings s);
end;
$$;
create or replace function public.diary_helpline_save_settings(p_enabled boolean, p_voice_name text, p_voice_notes text, p_max int) returns void
language plpgsql security definer set search_path = '' as $$
begin
    perform private.diary_require_admin();
    update public.diary_helpline_settings set ai_enabled = p_enabled, voice_name = left(trim(coalesce(p_voice_name, 'Noah')), 60),
        voice_notes = left(coalesce(p_voice_notes, ''), 4000), max_ai_replies = least(greatest(coalesce(p_max, 12), 1), 50), updated_at = now();
    perform private.diary_audit('helpline_settings', null, jsonb_build_object('ai_enabled', p_enabled));
end;
$$;
revoke all on function public.diary_helpline_tickets(text), public.diary_helpline_thread(uuid), public.diary_helpline_reply(uuid, text, boolean),
    public.diary_helpline_update(uuid, text, boolean), public.diary_helpline_settings(), public.diary_helpline_save_settings(boolean, text, text, int) from public, anon;
grant execute on function public.diary_helpline_tickets(text), public.diary_helpline_thread(uuid), public.diary_helpline_reply(uuid, text, boolean),
    public.diary_helpline_update(uuid, text, boolean), public.diary_helpline_settings(), public.diary_helpline_save_settings(boolean, text, text, int) to authenticated;
