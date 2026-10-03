-- Videos in chats (one-to-one and groups).
-- The storage buckets are where this is enforced: they accept MP4, MOV and WebM video, up to 100 MB a file.
-- Who may upload and read stays exactly as it is — the existing storage policies on these buckets (your own folder
-- to upload; only the people in the conversation, or the group's members, to read) apply to videos too.
-- A still frame of each video is uploaded beside it as a JPEG (already an allowed type).
-- After this is applied, switch on chatVideo in config.js.

update storage.buckets
set allowed_mime_types = (
        select array_agg(distinct t) from unnest(coalesce(allowed_mime_types, '{}') || array['video/mp4', 'video/quicktime', 'video/webm']) as t
    ),
    file_size_limit = greatest(coalesce(file_size_limit, 0), 104857600)
where id in ('diary-chat', 'diary-community');
