-- Who watched your story. Viewers record their own view; only the story's author can see the list.
create table public.diary_story_views (
    story_id uuid not null references public.diary_stories (id) on delete cascade,
    viewer uuid not null default auth.uid() references public.diary_profiles (id) on delete cascade,
    viewed_at timestamptz not null default now(),
    primary key (story_id, viewer)
);

create index diary_story_views_story on public.diary_story_views (story_id, viewed_at desc);

alter table public.diary_story_views enable row level security;

-- The subqueries run under the stories' own policies (friends, not expired)
create policy "Authors see who viewed; viewers see their own" on public.diary_story_views
    for select to authenticated
    using (
        viewer = (select auth.uid())
        or exists (select 1 from public.diary_stories st where st.id = story_id and st.author = (select auth.uid()))
    );
create policy "Record your own view of a friend's story" on public.diary_story_views
    for insert to authenticated
    with check (
        viewer = (select auth.uid())
        and exists (select 1 from public.diary_stories st where st.id = story_id and st.author <> (select auth.uid()))
    );

grant select on public.diary_story_views to authenticated;
grant insert (story_id) on public.diary_story_views to authenticated;
