-- Diary social features: profiles, friends, shared entries (feed), likes, direct messages, AI quota.
-- Lives beside the portfolio tables, so every object is prefixed with diary_.

-- ---------- Profiles ----------
create table public.diary_profiles (
    id uuid primary key references auth.users (id) on delete cascade,
    username text not null unique check (username ~ '^[a-z0-9_]{3,20}$'),
    display_name text not null check (char_length(display_name) between 1 and 40),
    created_at timestamptz not null default now()
);

alter table public.diary_profiles enable row level security;
revoke all on public.diary_profiles from anon;

create policy "Signed-in users can read diary profiles" on public.diary_profiles
    for select to authenticated using (true);
create policy "Users create their own diary profile" on public.diary_profiles
    for insert to authenticated with check (id = (select auth.uid()));
create policy "Users update their own diary profile" on public.diary_profiles
    for update to authenticated
    using (id = (select auth.uid())) with check (id = (select auth.uid()));

-- ---------- Friendships ----------
-- Writes go through the RPCs below so nobody can forge an accepted friendship.
create table public.diary_friendships (
    id uuid primary key default gen_random_uuid(),
    requester uuid not null references public.diary_profiles (id) on delete cascade,
    addressee uuid not null references public.diary_profiles (id) on delete cascade,
    status text not null default 'pending' check (status in ('pending', 'accepted')),
    created_at timestamptz not null default now(),
    check (requester <> addressee)
);

create unique index diary_friendships_pair
    on public.diary_friendships (least(requester, addressee), greatest(requester, addressee));
create index diary_friendships_addressee on public.diary_friendships (addressee);

alter table public.diary_friendships enable row level security;
revoke all on public.diary_friendships from anon;

create policy "Users see their own friendships" on public.diary_friendships
    for select to authenticated using ((select auth.uid()) in (requester, addressee));
create policy "Either side can remove a friendship" on public.diary_friendships
    for delete to authenticated using ((select auth.uid()) in (requester, addressee));

create function private.diary_are_friends(a uuid, b uuid)
returns boolean
language sql stable security definer
set search_path = ''
as $$
    select exists (
        select 1 from public.diary_friendships f
        where f.status = 'accepted'
          and ((f.requester = a and f.addressee = b) or (f.requester = b and f.addressee = a))
    );
$$;

revoke execute on function private.diary_are_friends(uuid, uuid) from public, anon;
grant execute on function private.diary_are_friends(uuid, uuid) to authenticated;

create function public.diary_send_friend_request(target_username text)
returns public.diary_friendships
language plpgsql security definer
set search_path = ''
as $$
declare
    me uuid := auth.uid();
    target uuid;
    existing public.diary_friendships;
    result public.diary_friendships;
begin
    if me is null then
        raise exception 'Not signed in';
    end if;

    select id into target from public.diary_profiles where username = lower(trim(target_username));
    if target is null then
        raise exception 'No one has the username "%"', target_username;
    end if;
    if target = me then
        raise exception 'You can''t add yourself';
    end if;

    select * into existing from public.diary_friendships
    where least(requester, addressee) = least(me, target)
      and greatest(requester, addressee) = greatest(me, target);

    if found then
        -- They already asked us: adding them back accepts.
        if existing.status = 'pending' and existing.addressee = me then
            update public.diary_friendships set status = 'accepted'
            where id = existing.id returning * into result;
            return result;
        end if;
        return existing;
    end if;

    insert into public.diary_friendships (requester, addressee)
    values (me, target) returning * into result;
    return result;
end;
$$;

create function public.diary_respond_friend_request(request_id uuid, accept boolean)
returns void
language plpgsql security definer
set search_path = ''
as $$
begin
    if accept then
        update public.diary_friendships set status = 'accepted'
        where id = request_id and addressee = auth.uid() and status = 'pending';
    else
        delete from public.diary_friendships
        where id = request_id and addressee = auth.uid() and status = 'pending';
    end if;
end;
$$;

revoke execute on function public.diary_send_friend_request(text) from public, anon;
revoke execute on function public.diary_respond_friend_request(uuid, boolean) from public, anon;
grant execute on function public.diary_send_friend_request(text) to authenticated;
grant execute on function public.diary_respond_friend_request(uuid, boolean) to authenticated;

-- ---------- Shared entries (the feed) ----------
create table public.diary_shared_entries (
    id uuid primary key default gen_random_uuid(),
    author uuid not null default auth.uid() references public.diary_profiles (id) on delete cascade,
    local_id text not null check (char_length(local_id) between 1 and 64),
    title text not null default '' check (char_length(title) <= 200),
    body text not null default '' check (char_length(body) <= 20000),
    color text not null default 'yellow' check (color in ('yellow', 'pink', 'blue', 'green', 'purple')),
    mood text check (mood in ('happy', 'calm', 'thoughtful', 'sad', 'stressed')),
    written_at timestamptz not null,
    shared_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    unique (author, local_id)
);

create index diary_shared_entries_author on public.diary_shared_entries (author, shared_at desc);

alter table public.diary_shared_entries enable row level security;
revoke all on public.diary_shared_entries from anon;

create policy "Authors and their friends can read shared entries" on public.diary_shared_entries
    for select to authenticated
    using (author = (select auth.uid()) or private.diary_are_friends(author, (select auth.uid())));
create policy "Authors share their own entries" on public.diary_shared_entries
    for insert to authenticated with check (author = (select auth.uid()));
create policy "Authors update their own shared entries" on public.diary_shared_entries
    for update to authenticated
    using (author = (select auth.uid())) with check (author = (select auth.uid()));
create policy "Authors unshare their own entries" on public.diary_shared_entries
    for delete to authenticated using (author = (select auth.uid()));

-- ---------- Likes ----------
create table public.diary_entry_likes (
    entry_id uuid not null references public.diary_shared_entries (id) on delete cascade,
    user_id uuid not null default auth.uid() references public.diary_profiles (id) on delete cascade,
    created_at timestamptz not null default now(),
    primary key (entry_id, user_id)
);

alter table public.diary_entry_likes enable row level security;
revoke all on public.diary_entry_likes from anon;

-- The subquery runs under the entries' RLS, so likes are only visible on entries you can see.
create policy "Likes are visible on entries you can see" on public.diary_entry_likes
    for select to authenticated
    using (exists (select 1 from public.diary_shared_entries e where e.id = entry_id));
create policy "Users like entries they can see" on public.diary_entry_likes
    for insert to authenticated
    with check (user_id = (select auth.uid())
        and exists (select 1 from public.diary_shared_entries e where e.id = entry_id));
create policy "Users remove their own likes" on public.diary_entry_likes
    for delete to authenticated using (user_id = (select auth.uid()));

-- ---------- Direct messages ----------
create table public.diary_messages (
    id bigint generated always as identity primary key,
    sender uuid not null default auth.uid() references public.diary_profiles (id) on delete cascade,
    recipient uuid not null references public.diary_profiles (id) on delete cascade,
    body text not null check (char_length(body) between 1 and 4000),
    created_at timestamptz not null default now(),
    read_at timestamptz
);

create index diary_messages_pair on public.diary_messages (sender, recipient, created_at);
create index diary_messages_unread on public.diary_messages (recipient, read_at);

alter table public.diary_messages enable row level security;
revoke all on public.diary_messages from anon;

create policy "Users read their own conversations" on public.diary_messages
    for select to authenticated using ((select auth.uid()) in (sender, recipient));
create policy "Users message their friends" on public.diary_messages
    for insert to authenticated
    with check (sender = (select auth.uid())
        and read_at is null
        and private.diary_are_friends(sender, recipient));

create function public.diary_mark_read(friend uuid)
returns void
language sql security definer
set search_path = ''
as $$
    update public.diary_messages set read_at = now()
    where recipient = auth.uid() and sender = friend and read_at is null;
$$;

revoke execute on function public.diary_mark_read(uuid) from public, anon;
grant execute on function public.diary_mark_read(uuid) to authenticated;

-- ---------- AI quota ----------
-- The Edge Function calls this with the user's own token; calling it directly only uses up your own quota.
create table private.diary_ai_usage (
    user_id uuid not null references auth.users (id) on delete cascade,
    day date not null default current_date,
    count integer not null default 0,
    primary key (user_id, day)
);

revoke all on private.diary_ai_usage from public, anon, authenticated;

create function public.diary_ai_take_quota()
returns boolean
language plpgsql security definer
set search_path = ''
as $$
declare
    used integer;
begin
    if auth.uid() is null then
        return false;
    end if;
    insert into private.diary_ai_usage (user_id, day, count)
    values (auth.uid(), current_date, 1)
    on conflict (user_id, day) do update set count = private.diary_ai_usage.count + 1
    returning count into used;
    return used <= 60;
end;
$$;

revoke execute on function public.diary_ai_take_quota() from public, anon;
grant execute on function public.diary_ai_take_quota() to authenticated;

-- ---------- Realtime ----------
alter publication supabase_realtime
    add table public.diary_messages, public.diary_friendships, public.diary_shared_entries;
