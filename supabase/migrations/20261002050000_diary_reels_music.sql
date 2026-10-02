-- Which sound a reel uses (the music itself is mixed into the video), so reels can appear on a Sound page
alter table public.diary_reels add column if not exists music jsonb
    check (music is null or (jsonb_typeof(music) = 'object' and length(music::text) <= 2000));
grant insert (music) on public.diary_reels to authenticated;
create index if not exists diary_reels_music_id on public.diary_reels ((music->>'audioId'));
create index if not exists diary_shared_entries_music_id on public.diary_shared_entries ((audio->'music'->>'audioId'));
