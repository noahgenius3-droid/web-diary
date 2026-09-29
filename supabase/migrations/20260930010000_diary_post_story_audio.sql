-- Audio on feed posts (a song or recording attached to the shared entry) and a soundtrack on photo stories.
alter table public.diary_shared_entries add column audio jsonb
    check (audio is null or (jsonb_typeof(audio) = 'object' and length(audio::text) <= 600
        and split_part(audio->>'path', '/', 1) = author::text));
grant insert (audio), update (audio) on public.diary_shared_entries to authenticated;

alter table public.diary_stories
    add column audio_path text,
    add column audio_duration real,
    add column audio_name text check (audio_name is null or char_length(audio_name) <= 120);
alter table public.diary_stories add constraint diary_stories_audio_check check (
    audio_path is null or (split_part(audio_path, '/', 1) = author::text and char_length(audio_path) <= 200
        and audio_duration > 0 and audio_duration <= 600)
);
grant insert (audio_path, audio_duration, audio_name) on public.diary_stories to authenticated;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('diary-post-audio', 'diary-post-audio', false, 20971520,
        array['audio/webm', 'audio/ogg', 'audio/mp4', 'audio/mpeg', 'audio/wav', 'audio/aac', 'audio/x-m4a', 'audio/flac']);

create policy "Diary: upload your own post audio" on storage.objects
    for insert to authenticated
    with check (bucket_id = 'diary-post-audio' and private.diary_chat_path_part(name, 1) = (select auth.uid()));

-- Whoever can see the post or story can hear its audio (those tables' own row security decides)
create policy "Diary: hear post and story audio you can see" on storage.objects
    for select to authenticated
    using (bucket_id = 'diary-post-audio' and (
        private.diary_chat_path_part(name, 1) = (select auth.uid())
        or exists (select 1 from public.diary_shared_entries e where e.audio->>'path' = objects.name)
        or exists (select 1 from public.diary_stories st where st.audio_path = objects.name)
    ));

create policy "Diary: delete your own post audio" on storage.objects
    for delete to authenticated
    using (bucket_id = 'diary-post-audio' and private.diary_chat_path_part(name, 1) = (select auth.uid()));
