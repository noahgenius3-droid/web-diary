-- Livelier communities: polls, emoji reactions, pinned posts and "who's here now" presence.

-- ---------- Polls live on the post ----------
-- poll = { "question": "…", "options": ["A", "B", …] } with 2–4 options
alter table public.diary_community_posts
    add column poll jsonb check (
        poll is null or (
            jsonb_typeof(poll) = 'object'
            and jsonb_typeof(poll -> 'options') = 'array'
            and jsonb_array_length(poll -> 'options') between 2 and 4
            and char_length(coalesce(poll ->> 'question', '')) between 1 and 200
            and length(poll::text) <= 1500
        )
    ),
    add column pinned_at timestamptz;

alter table public.diary_community_posts drop constraint diary_community_posts_kind_check;
alter table public.diary_community_posts add constraint diary_community_posts_kind_check check (kind in ('update', 'note', 'poll'));
alter table public.diary_community_posts drop constraint diary_community_posts_check;
alter table public.diary_community_posts add constraint diary_community_posts_check
    check (body <> '' or title <> '' or jsonb_array_length(photos) > 0 or poll is not null);

grant insert (poll) on public.diary_community_posts to authenticated;

create table public.diary_community_poll_votes (
    post_id uuid not null references public.diary_community_posts (id) on delete cascade,
    user_id uuid not null default auth.uid() references public.diary_profiles (id) on delete cascade,
    option smallint not null check (option between 0 and 3),
    created_at timestamptz not null default now(),
    primary key (post_id, user_id)
);

alter table public.diary_community_poll_votes enable row level security;

-- Runs under the posts' own policy, so votes follow the community's visibility
create policy "Votes on visible polls are visible" on public.diary_community_poll_votes
    for select to authenticated
    using (exists (select 1 from public.diary_community_posts p where p.id = post_id));
create policy "Members vote once per poll" on public.diary_community_poll_votes
    for insert to authenticated
    with check (
        user_id = (select auth.uid()) and exists (
            select 1 from public.diary_community_posts p
            where p.id = post_id and p.poll is not null
              and option < jsonb_array_length(p.poll -> 'options')
              and private.diary_is_member(p.community_id, (select auth.uid())))
    );
create policy "Change your vote" on public.diary_community_poll_votes
    for update to authenticated
    using (user_id = (select auth.uid()))
    with check (
        user_id = (select auth.uid()) and exists (
            select 1 from public.diary_community_posts p
            where p.id = post_id and option < jsonb_array_length(p.poll -> 'options'))
    );
create policy "Take back your vote" on public.diary_community_poll_votes
    for delete to authenticated using (user_id = (select auth.uid()));

grant select, delete on public.diary_community_poll_votes to authenticated;
grant insert (post_id, option) on public.diary_community_poll_votes to authenticated;
grant update (option) on public.diary_community_poll_votes to authenticated;

-- ---------- Emoji reactions ----------
create table public.diary_community_reactions (
    post_id uuid not null references public.diary_community_posts (id) on delete cascade,
    user_id uuid not null default auth.uid() references public.diary_profiles (id) on delete cascade,
    emoji text not null check (emoji in ('❤️', '😂', '🔥', '👏', '😮', '🙏')),
    created_at timestamptz not null default now(),
    primary key (post_id, user_id, emoji)
);

alter table public.diary_community_reactions enable row level security;

create policy "Reactions on visible posts are visible" on public.diary_community_reactions
    for select to authenticated
    using (exists (select 1 from public.diary_community_posts p where p.id = post_id));
create policy "Members react to posts" on public.diary_community_reactions
    for insert to authenticated
    with check (user_id = (select auth.uid()) and exists (
        select 1 from public.diary_community_posts p
        where p.id = post_id and private.diary_is_member(p.community_id, (select auth.uid()))));
create policy "Remove your own reactions" on public.diary_community_reactions
    for delete to authenticated using (user_id = (select auth.uid()));

grant select, delete on public.diary_community_reactions to authenticated;
grant insert (post_id, emoji) on public.diary_community_reactions to authenticated;

-- ---------- Pinned posts (moderators only) ----------
create policy "Moderators pin posts" on public.diary_community_posts
    for update to authenticated
    using (private.diary_is_moderator(community_id, (select auth.uid())))
    with check (private.diary_is_moderator(community_id, (select auth.uid())));

grant update (pinned_at) on public.diary_community_posts to authenticated;

-- ---------- Live updates ----------
alter publication supabase_realtime add table public.diary_community_poll_votes, public.diary_community_reactions;

-- ---------- "Who's here now": diary_comm:<community id>, members only ----------
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
    if parts[1] = 'diary_comm' and array_length(parts, 1) = 2 then
        return private.diary_is_member(parts[2]::uuid, me);
    end if;
    return false;
exception when others then
    return false; -- malformed ids
end;
$$;
