-- Group calls: ring members properly.
--  * diary_notify_call takes whether it's a video call, and only holds back a repeat alert for
--    2 minutes (it was 10, so a second call soon after the first alerted nobody).
--  * call_started notifications now go out as push notifications too.

drop function if exists public.diary_notify_call(uuid);

create or replace function public.diary_notify_call(p_community uuid, p_video boolean default false)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
    cm public.diary_communities;
begin
    if not private.diary_is_member(p_community, auth.uid()) then
        return false;
    end if;
    if exists (
        select 1 from public.diary_notifications
        where type = 'call_started' and data->>'community_id' = p_community::text
          and created_at > now() - interval '2 minutes'
    ) then
        return false;
    end if;
    select * into cm from public.diary_communities where id = p_community;
    insert into public.diary_notifications (user_id, actor, type, data)
    select m.user_id, auth.uid(), 'call_started',
        jsonb_build_object('community_id', cm.id, 'community_name', cm.name, 'emoji', cm.emoji, 'video', coalesce(p_video, false))
    from public.diary_community_members m
    where m.community_id = p_community and m.user_id <> auth.uid();
    return true;
end;
$$;

revoke all on function public.diary_notify_call(uuid, boolean) from public, anon;
grant execute on function public.diary_notify_call(uuid, boolean) to authenticated;

create or replace function private.diary_push_notification()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
    cfg private.diary_push_config;
begin
    if new.type not in ('friend_request', 'friend_accepted', 'new_follower', 'live_started', 'mention', 'reply', 'new_login', 'call_started') then
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
$$;
