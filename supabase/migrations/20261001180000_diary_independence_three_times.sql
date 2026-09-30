-- Nigeria's Independence Day message goes out three times on 1 October 2026: 08:00, 12:00 and 18:00 Lagos time
-- (07:00, 11:00, 17:00 UTC). The feed banner is made once and stays for the day; each round re-sends the push,
-- replacing the earlier bell notification so nobody's bell fills up with copies.

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
    select id into aid from public.diary_announcements where title = t and created_at > now() - interval '2 days';
    if aid is null then
        insert into public.diary_announcements (title, body, link, created_by, expires_at)
        values (t, b, '', sender, now() + interval '1 day') -- stays up for 24 hours
        returning id into aid;
    elsif exists (select 1 from public.diary_notifications
                  where type = 'announcement' and data->>'announcement' = aid::text and created_at > now() - interval '2 hours') then
        return; -- this round already went out
    end if;
    delete from public.diary_notifications where type = 'announcement' and data->>'announcement' = aid::text;
    insert into public.diary_notifications (user_id, actor, type, data)
    select p.id, sender, 'announcement', jsonb_build_object('announcement', aid, 'title', t, 'snippet', b)
    from public.diary_profiles p;
end;
$$;

-- 08:00, 12:00 and 18:00 Lagos time; the job removes itself after the last round
select cron.unschedule('diary-independence-day-2026') where exists (select 1 from cron.job where jobname = 'diary-independence-day-2026');
select cron.schedule('diary-independence-day-2026', '0 7,11,17 1 10 *',
    $job$ select private.diary_send_independence_2026(); select cron.unschedule('diary-independence-day-2026') where extract(hour from now() at time zone 'utc') >= 17; $job$);
