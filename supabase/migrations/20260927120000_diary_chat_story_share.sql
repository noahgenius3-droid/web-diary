-- Livelier chat (replies, reactions, unsend, typing indicator) and sharing feed photos / reels to your story.

-- ---------- Chat ----------
alter table public.diary_messages
    add column reply_to bigint references public.diary_messages (id) on delete set null,
    add column reactions jsonb not null default '{}'::jsonb
        check (jsonb_typeof(reactions) = 'object' and length(reactions::text) <= 2000),
    add column deleted_at timestamptz;

-- An unsent message keeps its place in the thread but loses its content
alter table public.diary_messages drop constraint diary_messages_not_empty;
alter table public.diary_messages add constraint diary_messages_not_empty
    check (body <> '' or jsonb_array_length(attachments) > 0 or deleted_at is not null);

grant insert (reply_to) on public.diary_messages to authenticated;

-- Replies may only quote a message from the same conversation
create function private.diary_check_reply()
returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
    if new.reply_to is not null and not exists (
        select 1 from public.diary_messages m
        where m.id = new.reply_to
          and ((m.sender = new.sender and m.recipient = new.recipient)
            or (m.sender = new.recipient and m.recipient = new.sender))
    ) then
        new.reply_to := null;
    end if;
    return new;
end;
$$;

revoke execute on function private.diary_check_reply() from public, anon, authenticated;

create trigger diary_messages_check_reply
    before insert on public.diary_messages
    for each row execute function private.diary_check_reply();

-- One reaction per person per message; the same emoji again removes it
create function public.diary_react_message(p_id bigint, p_emoji text)
returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
    me uuid := auth.uid();
    m public.diary_messages;
    result jsonb := '{}'::jsonb;
    had boolean;
    k text;
    v jsonb;
begin
    if p_emoji not in ('❤️', '😂', '😮', '😢', '🙏', '👍', '🔥', '🎉') then
        raise exception 'Unsupported reaction';
    end if;
    select * into m from public.diary_messages where id = p_id for update;
    if m.id is null or me not in (m.sender, m.recipient) or m.deleted_at is not null then
        raise exception 'Message not found';
    end if;
    had := coalesce(m.reactions -> p_emoji, '[]'::jsonb) ? me::text;
    for k, v in select * from jsonb_each(m.reactions) loop
        v := coalesce((select jsonb_agg(x) from jsonb_array_elements_text(v) x where x <> me::text), '[]'::jsonb);
        if jsonb_array_length(v) > 0 then
            result := result || jsonb_build_object(k, v);
        end if;
    end loop;
    if not had then
        result := result || jsonb_build_object(p_emoji, coalesce(result -> p_emoji, '[]'::jsonb) || to_jsonb(me::text));
    end if;
    update public.diary_messages set reactions = result where id = p_id;
    return result;
end;
$$;

-- Unsend: only your own messages. Returns the attachments so the app can delete the files.
create function public.diary_unsend_message(p_id bigint)
returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
    old_atts jsonb;
begin
    select attachments into old_atts from public.diary_messages
    where id = p_id and sender = auth.uid() and deleted_at is null
    for update;
    if not found then
        raise exception 'Message not found';
    end if;
    update public.diary_messages
    set deleted_at = now(), body = '', attachments = '[]'::jsonb, reactions = '{}'::jsonb
    where id = p_id;
    return old_atts;
end;
$$;

revoke execute on function public.diary_react_message(bigint, text) from public, anon;
revoke execute on function public.diary_unsend_message(bigint) from public, anon;
grant execute on function public.diary_react_message(bigint, text) to authenticated;
grant execute on function public.diary_unsend_message(bigint) to authenticated;

-- Typing indicator: diary_dm:<user id>:<user id> — only those two friends
create or replace function private.diary_topic_allowed(topic text, sending boolean)
returns boolean
language plpgsql stable security definer
set search_path = ''
as $$
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
    return false;
exception when others then
    return false; -- malformed ids
end;
$$;

-- ---------- Stories that reuse a feed photo or a reel ----------
-- The media stays where it is; the story just points at it for 24 hours. Friends can already see both.
alter table public.diary_stories
    add column bucket text not null default 'diary-stories'
        check (bucket in ('diary-stories', 'diary-feed', 'diary-reels'));

drop policy "Post your own stories" on public.diary_stories;
create policy "Post your own stories" on public.diary_stories
    for insert to authenticated
    with check (author = (select auth.uid()) and private.diary_chat_path_part(media_path, 1) = (select auth.uid()));

grant insert (bucket) on public.diary_stories to authenticated;

-- A shared reel may be longer than a story; the story plays its first minute
alter table public.diary_stories drop constraint diary_stories_duration_check;
alter table public.diary_stories add constraint diary_stories_duration_check
    check (duration is null or (duration > 0 and duration <= 180));

-- Story files are only readable through stories that live in the stories bucket
drop policy "Diary: see stories you can see" on storage.objects;
create policy "Diary: see stories you can see" on storage.objects
    for select to authenticated
    using (
        bucket_id = 'diary-stories'
        and (
            private.diary_chat_path_part(name, 1) = (select auth.uid())
            or exists (select 1 from public.diary_stories st where st.media_path = name and st.bucket = 'diary-stories')
        )
    );
