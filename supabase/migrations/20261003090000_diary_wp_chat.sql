-- Wordplay: talk while you play. Comments and quick reactions inside a match, seen by that match's players only.
-- Saved (turns can be hours apart, so the other players see what you said when they next open the board) and
-- delivered live while they have it open (Realtime on this table follows the policies below).

create table public.diary_wp_chat (
    id uuid primary key default gen_random_uuid(),
    match_id uuid not null references public.diary_wp_matches (id) on delete cascade,
    user_id uuid not null default auth.uid() references public.diary_profiles (id) on delete cascade,
    kind text not null check (kind in ('comment', 'reaction')),
    body text check (body is null or length(btrim(body)) between 1 and 300),
    emoji text check (emoji is null or emoji in ('👏', '🔥', '😂', '😮', '😅', '🤝', '💯', '🎉')),
    created_at timestamptz not null default now(),
    check ((kind = 'comment' and body is not null and emoji is null) or (kind = 'reaction' and emoji is not null and body is null))
);
create index diary_wp_chat_match on public.diary_wp_chat (match_id, created_at);
alter table public.diary_wp_chat enable row level security;

-- Only the match's players read it
create policy "Players read their match chat" on public.diary_wp_chat for select to authenticated using (
    exists (select 1 from public.diary_wp_matches m where m.id = match_id and (select auth.uid()) = any (m.players))
);
-- Players still in the match write as themselves
create policy "Players talk in their matches" on public.diary_wp_chat for insert to authenticated with check (
    user_id = (select auth.uid())
    and exists (select 1 from public.diary_wp_matches m
                where m.id = match_id and (select auth.uid()) = any (m.players) and not ((select auth.uid()) = any (m.out_players)))
);
-- Your own messages can be taken back
create policy "Players delete their own chat" on public.diary_wp_chat for delete to authenticated using (user_id = (select auth.uid()));

-- The same house rules as everywhere else: no guests, no suspended accounts, nothing across a block
create policy "Members only (insert)" on public.diary_wp_chat as restrictive for insert to authenticated
    with check (coalesce((select auth.jwt() ->> 'is_anonymous')::boolean, false) = false);
create policy "Suspended accounts can't chat in games" on public.diary_wp_chat as restrictive for insert to authenticated
    with check (not private.diary_is_suspended((select auth.uid())));
create policy "No game chat across a block" on public.diary_wp_chat as restrictive for select to authenticated using (
    not private.diary_blocked(user_id, (select auth.uid()))
);

grant select, delete on public.diary_wp_chat to authenticated;
grant insert (match_id, kind, body, emoji) on public.diary_wp_chat to authenticated;

-- Easy does it: at most 20 comments/reactions a minute per player in a match
create or replace function private.diary_wp_chat_limit() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
    if (select count(*) from public.diary_wp_chat
        where match_id = new.match_id and user_id = new.user_id and created_at > now() - interval '1 minute') >= 20 then
        raise exception 'Slow down a little — try again in a moment';
    end if;
    return new;
end;
$$;
create trigger diary_wp_chat_limit before insert on public.diary_wp_chat for each row execute function private.diary_wp_chat_limit();

alter publication supabase_realtime add table public.diary_wp_chat;
