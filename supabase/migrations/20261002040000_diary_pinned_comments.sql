-- A post's author can pin one comment to the top of its conversation.
alter table public.diary_shared_entries
    add column if not exists pinned_comment uuid references public.diary_comments(id) on delete set null;

grant update (pinned_comment) on public.diary_shared_entries to authenticated;

-- Only a comment that belongs to this post can be pinned on it
create or replace function private.diary_check_pinned_comment() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
    if new.pinned_comment is not null and new.pinned_comment is distinct from old.pinned_comment
       and not exists (select 1 from public.diary_comments c where c.id = new.pinned_comment and c.entry_id = new.id) then
        raise exception 'That comment isn''t on this post';
    end if;
    return new;
end;
$$;

drop trigger if exists diary_pinned_comment_check on public.diary_shared_entries;
create trigger diary_pinned_comment_check before update of pinned_comment on public.diary_shared_entries
    for each row execute function private.diary_check_pinned_comment();
