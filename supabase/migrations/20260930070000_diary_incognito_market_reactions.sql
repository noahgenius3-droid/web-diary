-- Incognito chats, the book marketplace, and emoji reactions on feed posts and stories.

-- ============================================================================
-- 1. Incognito chat
-- Either friend can switch a conversation to incognito. Messages sent while it's on vanish:
--   'seen' → five minutes after they're read (and the app hides them as soon as you leave the chat),
--   '1h' / '24h' → that long after they're sent. Unread 'seen' messages are gone after 24 hours.
-- Expired rows are invisible straight away (RLS) and purged on the next write; their files go to a
-- per-owner trash list the sender's app empties, and are unreadable meanwhile (storage policy).
-- ============================================================================

alter table public.diary_messages
    add column if not exists vanish text check (vanish in ('seen', '1h', '24h')),
    add column if not exists expires_at timestamptz;
create index if not exists diary_messages_expires_idx on public.diary_messages (expires_at) where expires_at is not null;

create table if not exists public.diary_incognito (
    user_a uuid not null references public.diary_profiles (id) on delete cascade,
    user_b uuid not null references public.diary_profiles (id) on delete cascade,
    mode text not null default 'off' check (mode in ('off', 'seen', '1h', '24h')),
    set_by uuid references public.diary_profiles (id) on delete set null,
    updated_at timestamptz not null default now(),
    primary key (user_a, user_b),
    check (user_a < user_b)
);
alter table public.diary_incognito enable row level security;
create policy "See incognito settings for your own chats" on public.diary_incognito
    for select to authenticated using ((select auth.uid()) in (user_a, user_b));
revoke all on public.diary_incognito from anon, authenticated;
grant select on public.diary_incognito to authenticated;

create table if not exists public.diary_incognito_trash (
    id bigint generated always as identity primary key,
    owner uuid not null references public.diary_profiles (id) on delete cascade,
    path text not null,
    created_at timestamptz not null default now()
);
create index if not exists diary_incognito_trash_owner_idx on public.diary_incognito_trash (owner);
alter table public.diary_incognito_trash enable row level security;
create policy "See your own vanished files" on public.diary_incognito_trash
    for select to authenticated using (owner = (select auth.uid()));
create policy "Clear your own vanished files" on public.diary_incognito_trash
    for delete to authenticated using (owner = (select auth.uid()));
revoke all on public.diary_incognito_trash from anon, authenticated;
grant select, delete on public.diary_incognito_trash to authenticated;

create or replace function private.diary_purge_expired()
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
    insert into public.diary_incognito_trash (owner, path)
    select m.sender, a->>'path'
    from public.diary_messages m, jsonb_array_elements(m.attachments) a
    where m.expires_at <= now() and jsonb_typeof(a) = 'object' and a ? 'path';
    delete from public.diary_messages where expires_at <= now();
end;
$$;

create or replace function public.diary_purge_expired_messages()
returns void
language sql
security definer
set search_path = ''
as $$
    select private.diary_purge_expired();
$$;
revoke all on function public.diary_purge_expired_messages() from public, anon;
grant execute on function public.diary_purge_expired_messages() to authenticated;

create or replace function public.diary_set_incognito(friend uuid, p_mode text)
returns public.diary_incognito
language plpgsql
security definer
set search_path = ''
as $$
declare
    me uuid := auth.uid();
    rec public.diary_incognito;
begin
    if me is null or friend is null or friend = me then
        raise exception 'Choose a friend';
    end if;
    if p_mode not in ('off', 'seen', '1h', '24h') then
        raise exception 'Unknown incognito setting';
    end if;
    if not private.diary_are_friends(me, friend) then
        raise exception 'Incognito chats are for friends';
    end if;
    insert into public.diary_incognito (user_a, user_b, mode, set_by, updated_at)
    values (least(me, friend), greatest(me, friend), p_mode, me, now())
    on conflict (user_a, user_b) do update set mode = excluded.mode, set_by = excluded.set_by, updated_at = now()
    returning * into rec;
    perform private.diary_purge_expired();
    return rec;
end;
$$;
revoke all on function public.diary_set_incognito(uuid, text) from public, anon;
grant execute on function public.diary_set_incognito(uuid, text) to authenticated;

-- New messages pick up the conversation's incognito setting (clients can't set these columns)
create or replace function private.diary_stamp_incognito()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
    m text;
begin
    select i.mode into m from public.diary_incognito i
    where i.user_a = least(new.sender, new.recipient) and i.user_b = greatest(new.sender, new.recipient);
    if m is null or m = 'off' then
        new.vanish := null;
        new.expires_at := null;
    else
        new.vanish := m;
        new.expires_at := now() + case m when '1h' then interval '1 hour' else interval '24 hours' end;
    end if;
    perform private.diary_purge_expired();
    return new;
end;
$$;
drop trigger if exists diary_messages_stamp_incognito on public.diary_messages;
create trigger diary_messages_stamp_incognito before insert on public.diary_messages
    for each row execute function private.diary_stamp_incognito();

-- Reading a 'seen' message starts its five-minute fuse
create or replace function public.diary_mark_read(friend uuid)
returns void
language sql
security definer
set search_path = ''
as $$
    update public.diary_messages
    set read_at = now(),
        expires_at = case when vanish = 'seen' then least(expires_at, now() + interval '5 minutes') else expires_at end
    where recipient = auth.uid() and sender = friend and read_at is null;
$$;

-- Expired messages disappear the moment they expire, even before the purge runs
drop policy if exists "Users read their own conversations" on public.diary_messages;
create policy "Users read their own conversations" on public.diary_messages
    for select to authenticated
    using (((select auth.uid()) = sender or (select auth.uid()) = recipient) and (expires_at is null or expires_at > now()));

-- Incognito files live under <sender>/<friend>/incognito/… and can only be opened while their message is live
drop policy if exists "Diary: read chat files in your conversations" on storage.objects;
create policy "Diary: read chat files in your conversations" on storage.objects
    for select to authenticated
    using (
        bucket_id = 'diary-chat'
        and ((select auth.uid()) = private.diary_chat_path_part(name, 1) or (select auth.uid()) = private.diary_chat_path_part(name, 2))
        and (
            coalesce((storage.foldername(name))[3], '') <> 'incognito'
            or exists (
                select 1 from public.diary_messages m
                where m.attachments @> jsonb_build_array(jsonb_build_object('path', name))
                  and m.expires_at > now()
            )
        )
    );

-- ============================================================================
-- 2. Book marketplace — sell, rent out or give away books
-- Listings are public or friends-only. A reader sends a request (with an optional offer); the seller
-- accepts or declines; each request has its own private conversation for arranging the handover.
-- Payment happens between the two people — Cordial doesn't take money.
-- ============================================================================

create table if not exists public.diary_book_listings (
    id uuid primary key default gen_random_uuid(),
    seller uuid not null default auth.uid() references public.diary_profiles (id) on delete cascade,
    kind text not null check (kind in ('sell', 'rent', 'gift')),
    title text not null check (char_length(btrim(title)) between 1 and 160),
    author_name text check (char_length(author_name) <= 120),
    description text check (char_length(description) <= 2000),
    genre text check (char_length(genre) <= 40),
    condition text not null default 'good' check (condition in ('new', 'like_new', 'good', 'fair', 'worn')),
    price numeric(12, 2) check (price is null or (price >= 0 and price <= 100000000)),
    currency text not null default 'NGN' check (currency ~ '^[A-Z]{3}$'),
    rent_period text check (rent_period in ('day', 'week', 'month')),
    deposit numeric(12, 2) check (deposit is null or (deposit >= 0 and deposit <= 100000000)),
    city text check (char_length(city) <= 60),
    country text check (country ~ '^[A-Z]{2}$'),
    pickup boolean not null default true,
    delivery boolean not null default false,
    photos jsonb not null default '[]'::jsonb check (jsonb_typeof(photos) = 'array' and jsonb_array_length(photos) <= 4),
    status text not null default 'available' check (status in ('available', 'reserved', 'rented', 'closed')),
    visibility text not null default 'public' check (visibility in ('public', 'friends')),
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    check ((kind = 'gift') = (price is null)),
    check ((kind = 'rent') = (rent_period is not null)),
    check (kind = 'rent' or deposit is null)
);
create index if not exists diary_book_listings_feed_idx on public.diary_book_listings (status, created_at desc);
create index if not exists diary_book_listings_seller_idx on public.diary_book_listings (seller);

create or replace function private.diary_check_listing()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
    -- Photos must be files the seller uploaded to their own folder
    if exists (
        select 1 from jsonb_array_elements(new.photos) p
        where jsonb_typeof(p) <> 'string' or split_part(p #>> '{}', '/', 1) <> new.seller::text or char_length(p #>> '{}') > 200
    ) then
        raise exception 'Invalid listing photos';
    end if;
    new.title := btrim(new.title);
    new.updated_at := now();
    return new;
end;
$$;
drop trigger if exists diary_book_listings_check on public.diary_book_listings;
create trigger diary_book_listings_check before insert or update on public.diary_book_listings
    for each row execute function private.diary_check_listing();

alter table public.diary_book_listings enable row level security;
create policy "Public listings, your own, and friends' listings" on public.diary_book_listings
    for select to authenticated
    using (visibility = 'public' or seller = (select auth.uid()) or private.diary_are_friends(seller, (select auth.uid())));
create policy "List your own books" on public.diary_book_listings
    for insert to authenticated with check (seller = (select auth.uid()));
create policy "Edit your own listings" on public.diary_book_listings
    for update to authenticated using (seller = (select auth.uid())) with check (seller = (select auth.uid()));
create policy "Remove your own listings" on public.diary_book_listings
    for delete to authenticated using (seller = (select auth.uid()));
revoke all on public.diary_book_listings from anon, authenticated;
grant select, delete on public.diary_book_listings to authenticated;
grant insert (kind, title, author_name, description, genre, condition, price, currency, rent_period, deposit, city, country, pickup, delivery, photos, status, visibility)
    on public.diary_book_listings to authenticated;
grant update (kind, title, author_name, description, genre, condition, price, currency, rent_period, deposit, city, country, pickup, delivery, photos, status, visibility)
    on public.diary_book_listings to authenticated;

create table if not exists public.diary_book_requests (
    id uuid primary key default gen_random_uuid(),
    listing_id uuid not null references public.diary_book_listings (id) on delete cascade,
    requester uuid not null references public.diary_profiles (id) on delete cascade,
    seller uuid not null references public.diary_profiles (id) on delete cascade,
    note text check (char_length(note) <= 500),
    offer numeric(12, 2) check (offer is null or (offer >= 0 and offer <= 100000000)),
    status text not null default 'pending' check (status in ('pending', 'accepted', 'declined', 'cancelled', 'completed')),
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);
create unique index if not exists diary_book_requests_open_idx on public.diary_book_requests (listing_id, requester)
    where status in ('pending', 'accepted');
create index if not exists diary_book_requests_seller_idx on public.diary_book_requests (seller, updated_at desc);
create index if not exists diary_book_requests_requester_idx on public.diary_book_requests (requester, updated_at desc);
alter table public.diary_book_requests enable row level security;
create policy "Buyers and sellers see their requests" on public.diary_book_requests
    for select to authenticated using ((select auth.uid()) in (requester, seller));
revoke all on public.diary_book_requests from anon, authenticated;
grant select on public.diary_book_requests to authenticated;

create table if not exists public.diary_book_messages (
    id bigint generated always as identity primary key,
    request_id uuid not null references public.diary_book_requests (id) on delete cascade,
    sender uuid not null default auth.uid() references public.diary_profiles (id) on delete cascade,
    body text not null check (char_length(btrim(body)) between 1 and 2000),
    created_at timestamptz not null default now()
);
create index if not exists diary_book_messages_request_idx on public.diary_book_messages (request_id, created_at);
alter table public.diary_book_messages enable row level security;
create policy "Both sides of a request read its messages" on public.diary_book_messages
    for select to authenticated
    using (exists (select 1 from public.diary_book_requests r where r.id = request_id and (select auth.uid()) in (r.requester, r.seller)));
create policy "Both sides of an open request can write" on public.diary_book_messages
    for insert to authenticated
    with check (
        sender = (select auth.uid())
        and exists (select 1 from public.diary_book_requests r
                    where r.id = request_id and (select auth.uid()) in (r.requester, r.seller) and r.status in ('pending', 'accepted'))
    );
revoke all on public.diary_book_messages from anon, authenticated;
grant select on public.diary_book_messages to authenticated;
grant insert (request_id, body) on public.diary_book_messages to authenticated;

create or replace function public.diary_request_book(p_listing uuid, p_note text default null, p_offer numeric default null)
returns public.diary_book_requests
language plpgsql
security definer
set search_path = ''
as $$
declare
    me uuid := auth.uid();
    l public.diary_book_listings;
    r public.diary_book_requests;
begin
    select * into l from public.diary_book_listings where id = p_listing;
    if not found or not (l.visibility = 'public' or l.seller = me or private.diary_are_friends(l.seller, me)) then
        raise exception 'This listing is no longer available';
    end if;
    if l.seller = me then
        raise exception 'This is your own listing';
    end if;
    if l.status <> 'available' then
        raise exception 'This book isn’t available right now';
    end if;
    if exists (select 1 from public.diary_book_requests where listing_id = p_listing and requester = me and status in ('pending', 'accepted')) then
        raise exception 'You’ve already asked for this book';
    end if;
    if (select count(*) from public.diary_book_requests where requester = me and created_at > now() - interval '1 hour') >= 20 then
        raise exception 'Too many requests — try again later';
    end if;
    insert into public.diary_book_requests (listing_id, requester, seller, note, offer)
    values (p_listing, me, l.seller, nullif(btrim(left(coalesce(p_note, ''), 500)), ''), case when l.kind = 'gift' then null else p_offer end)
    returning * into r;
    if r.note is not null then
        insert into public.diary_book_messages (request_id, sender, body) values (r.id, me, r.note);
    end if;
    perform private.diary_notify(l.seller, me, 'book_request',
        jsonb_build_object('listing', l.id, 'request', r.id, 'title', l.title, 'kind', l.kind));
    return r;
end;
$$;
revoke all on function public.diary_request_book(uuid, text, numeric) from public, anon;
grant execute on function public.diary_request_book(uuid, text, numeric) to authenticated;

-- accept / decline / complete (seller), cancel (buyer, or seller after accepting)
create or replace function public.diary_update_book_request(p_request uuid, p_action text)
returns public.diary_book_requests
language plpgsql
security definer
set search_path = ''
as $$
declare
    me uuid := auth.uid();
    r public.diary_book_requests;
    l public.diary_book_listings;
    next_status text;
    other uuid;
begin
    select * into r from public.diary_book_requests where id = p_request for update;
    if not found or me not in (r.requester, r.seller) then
        raise exception 'Request not found';
    end if;
    select * into l from public.diary_book_listings where id = r.listing_id for update;

    if p_action = 'accept' and me = r.seller and r.status = 'pending' then
        if l.status <> 'available' then
            raise exception 'Mark the book available first';
        end if;
        next_status := 'accepted';
        update public.diary_book_listings set status = 'reserved' where id = l.id;
    elsif p_action = 'decline' and me = r.seller and r.status = 'pending' then
        next_status := 'declined';
    elsif p_action = 'complete' and me = r.seller and r.status = 'accepted' then
        next_status := 'completed';
        update public.diary_book_listings set status = case when l.kind = 'rent' then 'rented' else 'closed' end where id = l.id;
    elsif p_action = 'cancel' and r.status in ('pending', 'accepted') then
        next_status := 'cancelled';
        if r.status = 'accepted' and l.status = 'reserved' then
            update public.diary_book_listings set status = 'available' where id = l.id;
        end if;
    else
        raise exception 'That can’t be done now';
    end if;

    update public.diary_book_requests set status = next_status, updated_at = now() where id = r.id returning * into r;
    other := case when me = r.seller then r.requester else r.seller end;
    perform private.diary_notify(other, me, 'book_request_update',
        jsonb_build_object('listing', l.id, 'request', r.id, 'title', l.title, 'kind', l.kind, 'status', next_status));
    return r;
end;
$$;
revoke all on function public.diary_update_book_request(uuid, text) from public, anon;
grant execute on function public.diary_update_book_request(uuid, text) to authenticated;

-- A new message in a book conversation touches the request (so lists sort by activity) and pings the other side
create or replace function private.diary_on_book_message()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
    r public.diary_book_requests;
    t text;
begin
    update public.diary_book_requests set updated_at = now() where id = new.request_id returning * into r;
    select title into t from public.diary_book_listings where id = r.listing_id;
    -- one unread ping per conversation is enough
    if not exists (
        select 1 from public.diary_notifications n
        where n.user_id = case when new.sender = r.seller then r.requester else r.seller end
          and n.type = 'book_message' and n.read_at is null and n.data->>'request' = r.id::text
    ) and not (r.note is not null and new.body = r.note and new.sender = r.requester and new.created_at - r.created_at < interval '5 seconds') then
        perform private.diary_notify(case when new.sender = r.seller then r.requester else r.seller end, new.sender, 'book_message',
            jsonb_build_object('listing', r.listing_id, 'request', r.id, 'title', t));
    end if;
    return new;
end;
$$;
drop trigger if exists diary_book_messages_after on public.diary_book_messages;
create trigger diary_book_messages_after after insert on public.diary_book_messages
    for each row execute function private.diary_on_book_message();

-- Listing photos: a public bucket (listings are meant to be seen); you write only inside your own folder
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('diary-market', 'diary-market', true, 5242880, array['image/jpeg', 'image/png', 'image/webp', 'image/gif'])
on conflict (id) do nothing;
create policy "Diary: upload your own listing photos" on storage.objects
    for insert to authenticated
    with check (bucket_id = 'diary-market' and private.diary_chat_path_part(name, 1) = (select auth.uid()));
create policy "Diary: delete your own listing photos" on storage.objects
    for delete to authenticated
    using (bucket_id = 'diary-market' and private.diary_chat_path_part(name, 1) = (select auth.uid()));

-- ============================================================================
-- 3. Emoji reactions on feed posts (shared entries) and stories
-- ============================================================================

create table if not exists public.diary_entry_reactions (
    entry_id uuid not null references public.diary_shared_entries (id) on delete cascade,
    user_id uuid not null default auth.uid() references public.diary_profiles (id) on delete cascade,
    emoji text not null check (emoji in ('❤️', '😂', '😮', '😢', '🔥', '👏', '🙏', '😍')),
    created_at timestamptz not null default now(),
    primary key (entry_id, user_id, emoji)
);
create index if not exists diary_entry_reactions_user_idx on public.diary_entry_reactions (user_id);
alter table public.diary_entry_reactions enable row level security;
create policy "Reactions are visible on entries you can see" on public.diary_entry_reactions
    for select to authenticated using (exists (select 1 from public.diary_shared_entries e where e.id = entry_id));
create policy "React to entries you can see" on public.diary_entry_reactions
    for insert to authenticated
    with check (user_id = (select auth.uid()) and exists (select 1 from public.diary_shared_entries e where e.id = entry_id));
create policy "Remove your own reactions" on public.diary_entry_reactions
    for delete to authenticated using (user_id = (select auth.uid()));
revoke all on public.diary_entry_reactions from anon, authenticated;
grant select, delete on public.diary_entry_reactions to authenticated;
grant insert (entry_id, emoji) on public.diary_entry_reactions to authenticated;

create table if not exists public.diary_story_reactions (
    story_id uuid not null references public.diary_stories (id) on delete cascade,
    user_id uuid not null default auth.uid() references public.diary_profiles (id) on delete cascade,
    emoji text not null check (emoji in ('❤️', '😂', '😮', '😢', '🔥', '👏', '🙏', '😍')),
    created_at timestamptz not null default now(),
    primary key (story_id, user_id, emoji)
);
create index if not exists diary_story_reactions_user_idx on public.diary_story_reactions (user_id);
alter table public.diary_story_reactions enable row level security;
-- Like views: the story's author sees everyone's reactions; you see your own
create policy "Authors see story reactions; you see yours" on public.diary_story_reactions
    for select to authenticated
    using (user_id = (select auth.uid()) or exists (select 1 from public.diary_stories st where st.id = story_id and st.author = (select auth.uid())));
create policy "React to friends' stories" on public.diary_story_reactions
    for insert to authenticated
    with check (user_id = (select auth.uid()) and exists (select 1 from public.diary_stories st where st.id = story_id and st.author <> (select auth.uid())));
create policy "Take back your story reactions" on public.diary_story_reactions
    for delete to authenticated using (user_id = (select auth.uid()));
revoke all on public.diary_story_reactions from anon, authenticated;
grant select, delete on public.diary_story_reactions to authenticated;
grant insert (story_id, emoji) on public.diary_story_reactions to authenticated;

create or replace function private.diary_on_reaction()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
    owner uuid;
begin
    if tg_table_name = 'diary_entry_reactions' then
        select author into owner from public.diary_shared_entries where id = new.entry_id;
        -- one ping per person per post, however many emojis they tap
        if not exists (select 1 from public.diary_notifications n where n.user_id = owner and n.actor = new.user_id
                       and n.type = 'entry_reaction' and n.data->>'entry' = new.entry_id::text and n.created_at > now() - interval '1 day') then
            perform private.diary_notify(owner, new.user_id, 'entry_reaction', jsonb_build_object('entry', new.entry_id, 'emoji', new.emoji));
        end if;
    else
        select author into owner from public.diary_stories where id = new.story_id;
        perform private.diary_notify(owner, new.user_id, 'story_reaction', jsonb_build_object('story', new.story_id, 'emoji', new.emoji));
    end if;
    return new;
end;
$$;
drop trigger if exists diary_entry_reactions_notify on public.diary_entry_reactions;
create trigger diary_entry_reactions_notify after insert on public.diary_entry_reactions
    for each row execute function private.diary_on_reaction();
drop trigger if exists diary_story_reactions_notify on public.diary_story_reactions;
create trigger diary_story_reactions_notify after insert on public.diary_story_reactions
    for each row execute function private.diary_on_reaction();

-- ============================================================================
-- Realtime
-- ============================================================================
alter publication supabase_realtime add table public.diary_incognito, public.diary_book_listings, public.diary_book_requests,
    public.diary_book_messages, public.diary_entry_reactions, public.diary_story_reactions;

-- New notification types
alter table public.diary_notifications drop constraint diary_notifications_type_check;
alter table public.diary_notifications add constraint diary_notifications_type_check check (type = any (array[
  'friend_request','friend_accepted','entry_like','entry_comment','post_like','post_comment','community_post','community_join',
  'call_started','missed_call','entry_repost','reel_like','reel_comment','library_like','live_started','new_follower',
  'book_request','book_request_update','book_message','entry_reaction','story_reaction']));
