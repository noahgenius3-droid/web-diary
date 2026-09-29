-- Your notes, backed up to your account so they come back on a new device. Only you can read or change them.
create table public.diary_note_backups (
    user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
    note_id text not null check (char_length(note_id) between 1 and 80),
    data jsonb not null default '{}'::jsonb check (jsonb_typeof(data) = 'object' and pg_column_size(data) < 1000000),
    deleted boolean not null default false,
    updated_at timestamptz not null default now(),
    primary key (user_id, note_id)
);

alter table public.diary_note_backups enable row level security;

create policy "Your own note backups" on public.diary_note_backups
    for all to authenticated
    using (user_id = (select auth.uid()))
    with check (user_id = (select auth.uid()));

revoke all on public.diary_note_backups from anon, authenticated;
grant select, delete on public.diary_note_backups to authenticated;
grant insert (note_id, data, deleted, updated_at), update (data, deleted, updated_at) on public.diary_note_backups to authenticated;

-- Photos, voice notes, drawings and files attached to notes
insert into storage.buckets (id, name, public, file_size_limit)
values ('diary-note-media', 'diary-note-media', false, 52428800);

create policy "Diary: your own note media (read)" on storage.objects
    for select to authenticated
    using (bucket_id = 'diary-note-media' and private.diary_chat_path_part(name, 1) = (select auth.uid()));
create policy "Diary: your own note media (upload)" on storage.objects
    for insert to authenticated
    with check (bucket_id = 'diary-note-media' and private.diary_chat_path_part(name, 1) = (select auth.uid()));
create policy "Diary: your own note media (replace)" on storage.objects
    for update to authenticated
    using (bucket_id = 'diary-note-media' and private.diary_chat_path_part(name, 1) = (select auth.uid()));
create policy "Diary: your own note media (delete)" on storage.objects
    for delete to authenticated
    using (bucket_id = 'diary-note-media' and private.diary_chat_path_part(name, 1) = (select auth.uid()));

-- PostgREST upserts set every sent column on conflict, including the key column
grant update (note_id) on public.diary_note_backups to authenticated;
