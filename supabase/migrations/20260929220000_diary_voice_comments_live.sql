-- Voice comments (hold-to-record audio on posts, community posts and reels) and live streams to friends.

-- ---------- Voice comments ----------
alter table public.diary_comments
    add column audio_path text,
    add column audio_duration integer;

-- A comment is text, a voice clip, or both
alter table public.diary_comments drop constraint diary_comments_body_check;
alter table public.diary_comments add constraint diary_comments_body_check check (
    char_length(body) <= 2000
    and (char_length(trim(body)) >= 1 or audio_path is not null)
);
-- Clips live in the author's own folder, and are at most five minutes long
alter table public.diary_comments add constraint diary_comments_audio_check check (
    audio_path is null
    or (split_part(audio_path, '/', 1) = author::text and char_length(audio_path) <= 200
        and audio_duration between 1 and 300)
);

grant select (audio_path, audio_duration) on public.diary_comments to authenticated;
grant insert (audio_path, audio_duration) on public.diary_comments to authenticated;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('diary-comment-audio', 'diary-comment-audio', false, 5242880,
        array['audio/webm', 'audio/ogg', 'audio/mp4', 'audio/mpeg', 'audio/wav', 'audio/aac']);

create policy "Diary: upload your own comment audio" on storage.objects
    for insert to authenticated
    with check (bucket_id = 'diary-comment-audio' and private.diary_chat_path_part(name, 1) = (select auth.uid()));

-- Anyone who can see the comment can hear it (the comments table's own row security decides that)
create policy "Diary: hear comment audio you can see" on storage.objects
    for select to authenticated
    using (bucket_id = 'diary-comment-audio' and (
        private.diary_chat_path_part(name, 1) = (select auth.uid())
        or exists (select 1 from public.diary_comments c where c.audio_path = objects.name)
    ));

create policy "Diary: delete your own comment audio" on storage.objects
    for delete to authenticated
    using (bucket_id = 'diary-comment-audio' and private.diary_chat_path_part(name, 1) = (select auth.uid()));

-- ---------- Live streams ----------
create table public.diary_live_streams (
    id uuid primary key default gen_random_uuid(),
    host uuid not null default auth.uid() references public.diary_profiles (id) on delete cascade,
    title text not null default '' check (char_length(title) <= 120),
    started_at timestamptz not null default now(),
    last_seen timestamptz not null default now(),  -- the host's heartbeat; a stream that stops beating is over
    ended_at timestamptz
);
create unique index diary_live_one_per_host on public.diary_live_streams (host) where ended_at is null;
create index diary_live_recent on public.diary_live_streams (started_at desc);

alter table public.diary_live_streams enable row level security;

create policy "Friends see your live streams" on public.diary_live_streams
    for select to authenticated
    using (host = (select auth.uid()) or private.diary_are_friends(host, (select auth.uid())));
create policy "Go live as yourself" on public.diary_live_streams
    for insert to authenticated
    with check (host = (select auth.uid()));
create policy "Keep your stream alive or end it" on public.diary_live_streams
    for update to authenticated
    using (host = (select auth.uid()))
    with check (host = (select auth.uid()));

revoke all on public.diary_live_streams from anon, authenticated;
grant select on public.diary_live_streams to authenticated;
grant insert (title) on public.diary_live_streams to authenticated;
grant update (last_seen, ended_at) on public.diary_live_streams to authenticated;

alter publication supabase_realtime add table public.diary_live_streams;

-- Tell friends when someone goes live
alter table public.diary_notifications drop constraint diary_notifications_type_check;
alter table public.diary_notifications add constraint diary_notifications_type_check check (type = any (array[
    'friend_request', 'friend_accepted', 'entry_like', 'entry_comment', 'post_like', 'post_comment',
    'community_post', 'community_join', 'call_started', 'missed_call', 'entry_repost', 'reel_like',
    'reel_comment', 'library_like', 'live_started'
]));

create function private.diary_on_live_start()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
    friend uuid;
begin
    for friend in
        select case when f.requester = new.host then f.addressee else f.requester end
        from public.diary_friendships f
        where f.status = 'accepted' and new.host in (f.requester, f.addressee)
    loop
        perform private.diary_notify(friend, new.host, 'live_started',
            jsonb_build_object('stream_id', new.id, 'snippet', left(new.title, 60)));
    end loop;
    return new;
end;
$$;

create trigger diary_notify_live after insert on public.diary_live_streams
    for each row execute function private.diary_on_live_start();

-- Realtime topic for a stream (signalling, live chat, hearts): the host and their friends
create or replace function private.diary_topic_allowed(topic text, sending boolean)
returns boolean
language plpgsql
stable security definer
set search_path = ''
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
        return me::text in (parts[3], parts[4]);
    end if;
    if parts[1] = 'diary_ring' and array_length(parts, 1) = 2 then
        if sending then
            return private.diary_can_reach(parts[2]::uuid, me);
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
              and (s.host = me or private.diary_are_friends(s.host, me))
        );
    end if;
    return false;
exception when others then
    return false;
end;
$function$;
