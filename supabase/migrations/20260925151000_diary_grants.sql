-- This project doesn't auto-grant table privileges to API roles, so grant exactly what the policies need.
-- Column lists keep users from setting fields the database should own (sender, read_at, username changes).
grant select on public.diary_profiles to authenticated;
grant insert (id, username, display_name) on public.diary_profiles to authenticated;
grant update (display_name) on public.diary_profiles to authenticated;

grant select, delete on public.diary_friendships to authenticated;

grant select, insert, update, delete on public.diary_shared_entries to authenticated;

grant select, delete on public.diary_entry_likes to authenticated;
grant insert (entry_id, user_id) on public.diary_entry_likes to authenticated;

grant select on public.diary_messages to authenticated;
grant insert (recipient, body) on public.diary_messages to authenticated;
