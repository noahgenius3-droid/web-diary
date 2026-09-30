-- Guest mode: people can try Cordial with just a name (Supabase anonymous sign-in).
-- Guests can read the feed, explore, play Playnote and keep their diary. Anything other people would see from them
-- (posts, comments, reactions, messages, friends, groups, stories, reels, live, the market, Wordplay matches) needs a
-- free account. Upgrading keeps the same user id, so nothing is lost.
-- Guests are recognised by the is_anonymous claim Supabase puts in their token.

create or replace function private.diary_is_guest()
returns boolean
language sql
stable
set search_path to ''
as $$ select coalesce((auth.jwt() ->> 'is_anonymous')::boolean, false); $$;

create or replace function private.diary_require_member()
returns void
language plpgsql
stable
set search_path to ''
as $$
begin
    if private.diary_is_guest() then
        raise exception 'Create a free account to do this' using errcode = 'P0001', hint = 'guest';
    end if;
end;
$$;

-- Tables: guests can't write where others would see it (restrictive, so it applies on top of every existing policy)
do $$
declare
    t text;
begin
    foreach t in array array[
        'diary_book_listings', 'diary_book_messages', 'diary_call_log', 'diary_call_recordings', 'diary_comments', 'diary_communities',
        'diary_community_likes', 'diary_community_message_reactions', 'diary_community_messages', 'diary_community_poll_votes',
        'diary_community_posts', 'diary_community_reactions', 'diary_entry_likes', 'diary_entry_reactions', 'diary_follows',
        'diary_library', 'diary_library_likes', 'diary_live_locations', 'diary_live_streams', 'diary_messages', 'diary_reel_likes',
        'diary_reels', 'diary_reposts', 'diary_scheduled', 'diary_shared_entries', 'diary_stories', 'diary_story_reactions',
        'diary_verification_requests'
    ] loop
        execute format('drop policy if exists "Members only (insert)" on public.%I', t);
        execute format('drop policy if exists "Members only (update)" on public.%I', t);
        execute format('create policy "Members only (insert)" on public.%I as restrictive for insert to authenticated with check (coalesce((select auth.jwt() ->> ''is_anonymous'')::boolean, false) = false)', t);
        execute format('create policy "Members only (update)" on public.%I as restrictive for update to authenticated using (coalesce((select auth.jwt() ->> ''is_anonymous'')::boolean, false) = false)', t);
    end loop;
end;
$$;

-- Functions that reach other people: add the member check as the first thing they do
do $$
declare
    f record;
    def text;
begin
    for f in select p.oid from pg_proc p join pg_namespace n on n.oid = p.pronamespace
             where n.nspname = 'public' and p.proname in ('diary_create_community', 'diary_join_community', 'diary_send_friend_request',
                 'diary_respond_friend_request', 'diary_notify_call', 'diary_react_message', 'diary_request_book', 'diary_wp_new',
                 'diary_publish_now', 'diary_edit_message')
    loop
        def := pg_get_functiondef(f.oid);
        continue when def like '%diary_require_member%';
        def := regexp_replace(def, '(\n\s*begin\s*\n)', E'\\1    perform private.diary_require_member();\n', 'i');
        execute def;
    end loop;
end;
$$;
