-- Group posts update live when someone reacts (reactions now live on the like row)
alter publication supabase_realtime add table public.diary_community_likes;
