-- Live videos can be open to everyone: the host picks "Everyone" or "Friends & followers" when going live.
-- Public lives show up for every signed-in member (blocked people never), so anyone can find and join one;
-- many people can be live at the same time, and viewers move between them.
alter table public.diary_live_streams add column if not exists audience text not null default 'circle'
    check (audience in ('circle', 'public'));

drop policy if exists "Friends and followers see your live streams" on public.diary_live_streams;
create policy "Friends and followers see your live streams" on public.diary_live_streams
    for select to authenticated
    using (
        host = (select auth.uid())
        or private.diary_are_friends(host, (select auth.uid()))
        or private.diary_is_follower((select auth.uid()), host)
        or (audience = 'public' and not private.diary_blocked(host, (select auth.uid())))
    );

-- The live's realtime channel follows the same rule
create or replace function private.diary_topic_allowed(topic text, sending boolean)
returns boolean
language plpgsql
stable security definer
set search_path to ''
as $function$
declare
    parts text[] := string_to_array(topic, ':');
    me uuid := auth.uid();
begin
    if me is null or parts is null then
        return false;
    end if;
    if parts[1] = 'diary_call' and parts[2] = 'c' and array_length(parts, 1) = 3 then
        return private.diary_is_member(parts[3]::uuid, me);
    end if;
    if parts[1] = 'diary_call' and parts[2] = 'd' and array_length(parts, 1) = 4 then
        return me::text in (parts[3], parts[4]) and not private.diary_blocked(parts[3]::uuid, parts[4]::uuid);
    end if;
    if parts[1] = 'diary_ring' and array_length(parts, 1) = 2 then
        if sending then
            return private.diary_can_reach(parts[2]::uuid, me)
                and not private.diary_blocked(parts[2]::uuid, me)
                and coalesce((select allow_calls from public.diary_presence where user_id = parts[2]::uuid), 'friends') <> 'nobody';
        end if;
        return parts[2] = me::text;
    end if;
    if parts[1] = 'diary_dm' and array_length(parts, 1) = 3 then
        return me::text in (parts[2], parts[3])
            and private.diary_are_friends(parts[2]::uuid, parts[3]::uuid);
    end if;
    if parts[1] = 'diary_comm' and array_length(parts, 1) = 2 then
        return private.diary_is_member(parts[2]::uuid, me);
    end if;
    if parts[1] = 'diary_live' and array_length(parts, 1) = 2 then
        return exists (
            select 1 from public.diary_live_streams s
            where s.id = parts[2]::uuid and s.ended_at is null
              and (s.host = me or private.diary_are_friends(s.host, me) or private.diary_is_follower(me, s.host)
                   or (s.audience = 'public' and not private.diary_blocked(s.host, me)))
        );
    end if;
    if parts[1] = 'diary_space' and array_length(parts, 1) = 2 then
        return exists (select 1 from public.diary_spaces sp where sp.id = parts[2]::uuid and sp.live_since is not null)
            and private.diary_space_visible(parts[2]::uuid, me);
    end if;
    return false;
exception when others then
    return false;
end;
$function$;

-- Hosts set the audience when they go live (inserts are column-granted on this table)
grant insert (audience) on public.diary_live_streams to authenticated;
