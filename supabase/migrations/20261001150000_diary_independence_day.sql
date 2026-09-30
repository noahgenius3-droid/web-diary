-- Announcements now also reach phones as push notifications (not just the in-app bell and feed banner),
-- and Nigeria's Independence Day message goes out on 1 October 2026 at 08:00 Lagos time (07:00 UTC).

create or replace function private.diary_push_notification()
returns trigger
language plpgsql
security definer
set search_path to ''
as $function$
declare
    cfg private.diary_push_config;
begin
    if new.type not in ('friend_request', 'friend_accepted', 'new_follower', 'live_started', 'mention', 'reply', 'new_login', 'call_started',
                        'scheduled_published', 'scheduled_failed', 'post_activity', 'game_invite', 'game_turn', 'game_over', 'comment_reply',
                        'referral_joined', 'tagged', 'announcement') then
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
    return new;
end;
$function$;

-- The Independence Day message: a feed banner for the day, plus a notification (and push) to everyone
create or replace function private.diary_send_independence_2026()
returns void
language plpgsql
security definer
set search_path to ''
as $$
declare
    aid uuid;
    t text := 'Happy Independence Day, Nigeria 🇳🇬';
    b text := 'John from Cordial wishes our Nigerian users a happy Independence Day! And from all of us at Cordial: here’s to 66 years of resilience, and to every story still being written. 💚🤍💚';
    sender uuid := 'aa210296-69e8-45ff-9905-d5408caf6a74';
begin
    if exists (select 1 from public.diary_announcements where title = t and created_at > now() - interval '2 days') then return; end if; -- never twice
    insert into public.diary_announcements (title, body, link, created_by, expires_at)
    values (t, b, '', sender, now() + interval '1 day') returning id into aid;
    insert into public.diary_notifications (user_id, actor, type, data)
    select p.id, sender, 'announcement', jsonb_build_object('announcement', aid, 'title', t, 'snippet', b)
    from public.diary_profiles p;
end;
$$;

-- Once, tomorrow morning; the job removes itself after it runs
select cron.schedule('diary-independence-day-2026', '0 7 1 10 *',
    $job$ select private.diary_send_independence_2026(); select cron.unschedule('diary-independence-day-2026'); $job$);
