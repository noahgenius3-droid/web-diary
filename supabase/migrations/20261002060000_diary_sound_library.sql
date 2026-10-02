-- The sound library behind "Add sound": a licensed catalogue managed on the server, sounds people save,
-- and how many posts / reels use each sound (for "N posts" and the Trending tab).

-- Licensed tracks (added by admins in the dashboard / SQL; the app only reads active rows).
-- Store links to the rights holder's or provider's stream — never upload copyrighted audio you don't hold rights to.
create table if not exists public.diary_sound_catalog (
    id text primary key,
    title text not null,
    artist text not null,
    cover_url text,
    preview_url text,
    audio_url text,
    duration integer not null default 30 check (duration between 1 and 3600),
    category text[] not null default '{}',
    trending boolean not null default false,
    popular boolean not null default false,
    is_new boolean not null default false,
    license_url text,
    license_name text,
    provider text,
    active boolean not null default true,
    created_at timestamptz not null default now()
);
alter table public.diary_sound_catalog enable row level security;
drop policy if exists "Signed-in people read the active catalogue" on public.diary_sound_catalog;
create policy "Signed-in people read the active catalogue" on public.diary_sound_catalog
    for select to authenticated using (active);
grant select on public.diary_sound_catalog to authenticated;

-- Sounds a person bookmarked in the library
create table if not exists public.diary_saved_sounds (
    user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
    audio_id text not null check (length(audio_id) between 1 and 200),
    music jsonb not null check (jsonb_typeof(music) = 'object' and length(music::text) <= 2000),
    created_at timestamptz not null default now(),
    primary key (user_id, audio_id)
);
alter table public.diary_saved_sounds enable row level security;
drop policy if exists "People see their saved sounds" on public.diary_saved_sounds;
create policy "People see their saved sounds" on public.diary_saved_sounds
    for select to authenticated using (user_id = (select auth.uid()));
drop policy if exists "People save sounds" on public.diary_saved_sounds;
create policy "People save sounds" on public.diary_saved_sounds
    for insert to authenticated with check (user_id = (select auth.uid()));
drop policy if exists "People unsave sounds" on public.diary_saved_sounds;
create policy "People unsave sounds" on public.diary_saved_sounds
    for delete to authenticated using (user_id = (select auth.uid()));
grant select, insert, delete on public.diary_saved_sounds to authenticated;

-- How many posts and reels use each sound (counts only — no post details leave the server)
create or replace function public.diary_sound_usage(p_ids text[])
returns table (audio_id text, uses integer)
language sql stable security definer set search_path = '' as $$
    with ids as (select distinct unnest(p_ids[1:100]) as id),
    hits as (
        select coalesce(e.audio->'music'->>'audioId', e.audio->'music'->>'id') as id
        from public.diary_shared_entries e
        where e.audio ? 'music'
          and coalesce(e.audio->'music'->>'audioId', e.audio->'music'->>'id') in (select id from ids)
        union all
        select r.music->>'audioId' from public.diary_reels r
        where r.music is not null and r.music->>'audioId' in (select id from ids)
    )
    select id, count(*)::integer from hits group by id;
$$;
revoke all on function public.diary_sound_usage(text[]) from public, anon;
grant execute on function public.diary_sound_usage(text[]) to authenticated;

-- The sounds used most in the last two weeks, with one copy of each sound's record
create or replace function public.diary_sound_trending(p_limit integer default 30)
returns table (audio_id text, uses integer, music jsonb)
language sql stable security definer set search_path = '' as $$
    with recent as (
        select coalesce(e.audio->'music'->>'audioId', e.audio->'music'->>'id') as id, e.audio->'music' as music
        from public.diary_shared_entries e
        where e.audio ? 'music' and e.shared_at > now() - interval '14 days'
        union all
        select r.music->>'audioId', r.music from public.diary_reels r
        where r.music is not null and r.created_at > now() - interval '14 days'
    )
    select id, count(*)::integer, (array_agg(music))[1]
    from recent where id is not null
    group by id order by count(*) desc
    limit least(greatest(coalesce(p_limit, 30), 1), 50);
$$;
revoke all on function public.diary_sound_trending(integer) from public, anon;
grant execute on function public.diary_sound_trending(integer) to authenticated;
