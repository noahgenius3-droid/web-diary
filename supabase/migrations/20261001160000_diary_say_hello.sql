-- "Say hello" to someone who isn't your friend yet (e.g. a new member): a friend request carrying a short note.
-- They see the note on the request; if they accept, it becomes the first message in your chat.
-- Chats stay friends-only, so nobody can be messaged by strangers without saying yes first.

alter table public.diary_friendships add column if not exists note text check (note is null or length(note) <= 300);

-- The note shows on the request notification; accepting turns it into the first chat message
create or replace function private.diary_on_friendship()
returns trigger
language plpgsql
security definer
set search_path to ''
as $function$
begin
    if tg_op = 'INSERT' and new.status = 'pending' then
        perform private.diary_notify(new.addressee, new.requester, 'friend_request',
            jsonb_build_object('friendship_id', new.id) || case when new.note is not null then jsonb_build_object('note', new.note) else '{}'::jsonb end);
    elsif tg_op = 'UPDATE' and old.status = 'pending' and new.status = 'accepted' then
        perform private.diary_notify(new.requester, new.addressee, 'friend_accepted', '{}'::jsonb);
        delete from public.diary_notifications
        where user_id = new.addressee and type = 'friend_request' and data->>'friendship_id' = new.id::text;
        if new.note is not null and btrim(new.note) <> '' then
            insert into public.diary_messages (sender, recipient, body)
            values (new.requester, new.addressee, replace(replace(replace(new.note, '&', '&amp;'), '<', '&lt;'), '>', '&gt;'));
            update public.diary_friendships set note = null where id = new.id;
        end if;
    end if;
    return new;
end;
$function$;

create or replace function public.diary_say_hello(p_user uuid, p_note text)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $$
declare
    me uuid := auth.uid();
    v_note text := left(btrim(coalesce(p_note, '')), 300);
    existing public.diary_friendships;
begin
    perform private.diary_require_member();
    if me is null then raise exception 'Not signed in'; end if;
    if p_user is null or p_user = me then raise exception 'You can’t say hello to yourself'; end if;
    if not exists (select 1 from public.diary_profiles where id = p_user) then raise exception 'That account isn’t there any more'; end if;
    if private.diary_blocked(me, p_user) then raise exception 'You can’t message this person'; end if;
    if v_note = '' then v_note := 'Welcome to Cordial! 👋'; end if;
    select * into existing from public.diary_friendships
    where least(requester, addressee) = least(me, p_user) and greatest(requester, addressee) = greatest(me, p_user);
    if found and existing.status = 'accepted' then
        return jsonb_build_object('friends', true);
    elsif found and existing.addressee = me then
        -- They'd already asked you: you're friends now, and your hello is the first message
        update public.diary_friendships set status = 'accepted' where id = existing.id;
        insert into public.diary_messages (sender, recipient, body)
        values (me, p_user, replace(replace(replace(v_note, '&', '&amp;'), '<', '&lt;'), '>', '&gt;'));
        return jsonb_build_object('friends', true, 'sent', true);
    elsif found then
        -- Your request is still waiting: update the note on it
        update public.diary_friendships set note = v_note where id = existing.id;
        update public.diary_notifications set data = data || jsonb_build_object('note', v_note)
        where user_id = p_user and type = 'friend_request' and data->>'friendship_id' = existing.id::text;
        return jsonb_build_object('pending', true);
    end if;
    insert into public.diary_friendships (requester, addressee, note) values (me, p_user, v_note);
    return jsonb_build_object('pending', true, 'sent', true);
end;
$$;
revoke all on function public.diary_say_hello(uuid, text) from public, anon;
grant execute on function public.diary_say_hello(uuid, text) to authenticated;
