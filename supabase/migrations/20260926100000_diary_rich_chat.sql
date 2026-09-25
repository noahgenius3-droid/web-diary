-- Rich chat: formatted message bodies (sanitised HTML), attachments in private storage,
-- and formatted text for shared entries.

-- ---------- Messages ----------
alter table public.diary_messages
    add column attachments jsonb not null default '[]'::jsonb
        check (jsonb_typeof(attachments) = 'array' and jsonb_array_length(attachments) <= 10);

-- Body is now HTML (sanitised on display) and may be empty when the message is only attachments.
alter table public.diary_messages drop constraint diary_messages_body_check;
alter table public.diary_messages
    add constraint diary_messages_body_check check (char_length(body) <= 20000),
    add constraint diary_messages_not_empty check (body <> '' or jsonb_array_length(attachments) > 0);

grant insert (attachments) on public.diary_messages to authenticated;

-- ---------- Shared entries ----------
alter table public.diary_shared_entries
    add column html text not null default '' check (char_length(html) <= 60000);

-- ---------- Chat attachment storage ----------
-- Objects live at <sender id>/<recipient id>/<random>.<ext>
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
    'diary-chat', 'diary-chat', false, 20971520,
    array[
        'image/png', 'image/jpeg', 'image/gif', 'image/webp',
        'audio/webm', 'audio/ogg', 'audio/mp4', 'audio/mpeg', 'audio/wav',
        'application/pdf', 'text/plain', 'text/csv',
        'application/msword',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'application/vnd.ms-excel',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'application/vnd.ms-powerpoint',
        'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        'application/zip'
    ]
);

create function private.diary_chat_path_part(name text, part int)
returns uuid
language plpgsql immutable
set search_path = ''
as $$
begin
    return (storage.foldername(name))[part]::uuid;
exception when others then
    return null;
end;
$$;

revoke execute on function private.diary_chat_path_part(text, int) from public, anon;
grant execute on function private.diary_chat_path_part(text, int) to authenticated;

create policy "Diary: upload chat files to friends" on storage.objects
    for insert to authenticated
    with check (
        bucket_id = 'diary-chat'
        and private.diary_chat_path_part(name, 1) = (select auth.uid())
        and private.diary_are_friends((select auth.uid()), private.diary_chat_path_part(name, 2))
    );

create policy "Diary: read chat files in your conversations" on storage.objects
    for select to authenticated
    using (
        bucket_id = 'diary-chat'
        and (select auth.uid()) in (private.diary_chat_path_part(name, 1), private.diary_chat_path_part(name, 2))
    );

create policy "Diary: delete your own chat files" on storage.objects
    for delete to authenticated
    using (bucket_id = 'diary-chat' and private.diary_chat_path_part(name, 1) = (select auth.uid()));
