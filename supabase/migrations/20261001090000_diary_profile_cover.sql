-- Profile cover photos. Stored like avatars (diary-avatars bucket, in your own folder) and shown to whoever
-- can see your profile photo (same "photo visibility" privacy setting).
alter table public.diary_profiles add column if not exists cover_path text;
alter table public.diary_profiles drop constraint if exists diary_profiles_cover_own_folder;
alter table public.diary_profiles add constraint diary_profiles_cover_own_folder
    check (cover_path is null or (cover_path like id::text || '/%' and length(cover_path) < 200));
grant select (cover_path), update (cover_path) on public.diary_profiles to authenticated;

-- diary_profile_full also returns the cover (same visibility as the profile photo)
do $$
declare
    def text := pg_get_functiondef('public.diary_profile_full'::regproc);
begin
    if def like '%cover_path%' then return; end if;
    def := replace(def,
        $a$'avatar_path', case when coalesce(photo, 'everyone') = 'everyone' or friends then p.avatar_path end,$a$,
        $b$'avatar_path', case when coalesce(photo, 'everyone') = 'everyone' or friends then p.avatar_path end,
        'cover_path', case when coalesce(photo, 'everyone') = 'everyone' or friends then p.cover_path end,$b$);
    if def not like '%cover_path%' then raise exception 'diary_profile_full: anchor not found'; end if;
    execute def;
end;
$$;
