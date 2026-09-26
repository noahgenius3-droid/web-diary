-- Authors can swap their reel's video file (e.g. an iPhone HEVC .mov converted to MP4 so every device can play it)
create policy "Authors replace their reel's video" on public.diary_reels
    for update to authenticated
    using (author = (select auth.uid()))
    with check (
        author = (select auth.uid())
        and private.diary_chat_path_part(video_path, 1) = (select auth.uid())
        and (poster_path is null or private.diary_chat_path_part(poster_path, 1) = (select auth.uid()))
    );

grant update (video_path, poster_path, duration) on public.diary_reels to authenticated;
