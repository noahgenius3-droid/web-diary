-- Wordplay dictionary: the public-domain ENABLE word list (words of 2 to 9 letters, the board is 9 wide).
-- Loaded once from https://raw.githubusercontent.com/dolph/dictionary/master/enable1.txt with pg_net:
--   select net.http_get('https://raw.githubusercontent.com/dolph/dictionary/master/enable1.txt', timeout_milliseconds => 30000);
--   insert into public.diary_words (word)
--   select distinct w from net._http_response r, regexp_split_to_table(r.content, E'\\s+') w
--   where r.id = <id> and w ~ '^[a-z]{2,9}$' on conflict do nothing;
create table if not exists public.diary_words (word text primary key);
alter table public.diary_words enable row level security; -- no policies: only the function below reads it

-- Which of these words aren't in the dictionary (upper or lower case in, lower case out)
create or replace function public.diary_words_check(p_words text[])
returns text[]
language sql
stable
security definer
set search_path to ''
as $$
    select coalesce(array_agg(distinct lower(w)), '{}')
    from unnest(p_words[1:20]) w
    where not exists (select 1 from public.diary_words d where d.word = lower(w));
$$;
revoke all on function public.diary_words_check(text[]) from public, anon;
grant execute on function public.diary_words_check(text[]) to authenticated;

-- A few everyday words ENABLE leaves out
insert into public.diary_words (word) values ('ok'), ('qi'), ('za'), ('ew'), ('emoji'), ('emojis'), ('email'), ('emails'), ('online'), ('app'), ('apps'), ('blog'), ('blogs'), ('selfie'), ('selfies'), ('wifi')
on conflict do nothing;
