-- Edit profile → Save failed with "permission denied for table diary_profile_details": the app saves with an
-- upsert, whose update part also sets user_id, and people weren't allowed to update that column.
-- Allowing it is safe: the row-level rule only lets you update your own row, and it must still be yours after
-- (using / with check: user_id = auth.uid()), so nobody can move or take over anyone else's details.
grant update (user_id) on public.diary_profile_details to authenticated;
