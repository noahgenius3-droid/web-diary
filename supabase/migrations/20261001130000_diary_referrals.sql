-- Invites / referrals: everyone shares a link (…/?invite=<username>). When someone signs up through it,
-- they're connected as friends with the person who invited them, and the inviter hears about it.

create table if not exists public.diary_referrals (
    referred uuid primary key references public.diary_profiles (id) on delete cascade, -- each account counts once
    referrer uuid not null references public.diary_profiles (id) on delete cascade,
    created_at timestamptz not null default now(),
    check (referrer <> referred)
);
create index if not exists diary_referrals_referrer on public.diary_referrals (referrer, created_at desc);
alter table public.diary_referrals enable row level security;
create policy "See your referrals" on public.diary_referrals for select to authenticated
    using ((select auth.uid()) in (referrer, referred));
grant select on public.diary_referrals to authenticated;

alter table public.diary_notifications drop constraint diary_notifications_type_check;
alter table public.diary_notifications add constraint diary_notifications_type_check check (type in (
    'friend_request', 'friend_accepted', 'entry_like', 'entry_comment', 'post_like', 'post_comment', 'community_post', 'community_join',
    'call_started', 'missed_call', 'entry_repost', 'reel_like', 'reel_comment', 'library_like', 'live_started', 'new_follower',
    'book_request', 'book_request_update', 'book_message', 'entry_reaction', 'story_reaction', 'mention', 'reply', 'new_login',
    'post_activity', 'scheduled_published', 'scheduled_failed', 'trivia_rank', 'badge_earned', 'announcement', 'verification_update',
    'game_invite', 'game_turn', 'game_over', 'comment_reply', 'referral_joined'));

-- Who's inviting you (shown before you have an account, so open to visitors): just a name and photo
create or replace function public.diary_invite_preview(p_code text)
returns jsonb
language sql
stable
security definer
set search_path to ''
as $$
    select jsonb_build_object('display_name', p.display_name, 'username', p.username,
        'avatar_path', case when coalesce(pr.photo_visibility, 'everyone') = 'everyone' then p.avatar_path end)
    from public.diary_profiles p left join public.diary_presence pr on pr.user_id = p.id
    where p.username = lower(trim(leading '@' from coalesce(p_code, '')))
    limit 1;
$$;
revoke all on function public.diary_invite_preview(text) from public;
grant execute on function public.diary_invite_preview(text) to anon, authenticated;

-- A new account claims the invite it came through: once, only while the account is new, never yourself
create or replace function public.diary_claim_referral(p_code text)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $$
declare
    me uuid := auth.uid();
    inviter uuid;
    fr public.diary_friendships;
begin
    perform private.diary_require_member();
    if me is null then return null; end if;
    select id into inviter from public.diary_profiles where username = lower(trim(leading '@' from coalesce(p_code, '')));
    if inviter is null or inviter = me then return jsonb_build_object('ok', false); end if;
    if exists (select 1 from public.diary_referrals where referred = me) then return jsonb_build_object('ok', false, 'reason', 'already'); end if;
    if (select created_at from auth.users where id = me) < now() - interval '48 hours' then return jsonb_build_object('ok', false, 'reason', 'not_new'); end if;
    if private.diary_blocked(me, inviter) then return jsonb_build_object('ok', false); end if;
    insert into public.diary_referrals (referred, referrer) values (me, inviter);
    -- Friends straight away (turn a pending request into a friendship, or make one)
    select * into fr from public.diary_friendships where (requester = inviter and addressee = me) or (requester = me and addressee = inviter) limit 1;
    if found then
        if fr.status <> 'accepted' then update public.diary_friendships set status = 'accepted' where id = fr.id; end if;
    else
        insert into public.diary_friendships (requester, addressee, status) values (inviter, me, 'accepted');
    end if;
    perform private.diary_notify(inviter, me, 'referral_joined', jsonb_build_object('referred', me));
    return jsonb_build_object('ok', true, 'inviter', inviter);
end;
$$;
revoke all on function public.diary_claim_referral(text) from public, anon;
grant execute on function public.diary_claim_referral(text) to authenticated;

-- Your invites: how many joined and who
create or replace function public.diary_my_referrals()
returns jsonb
language sql
stable
security definer
set search_path to ''
as $$
    select jsonb_build_object(
        'count', (select count(*) from public.diary_referrals where referrer = auth.uid()),
        'people', coalesce((select jsonb_agg(jsonb_build_object('id', p.id, 'username', p.username, 'display_name', p.display_name,
                'avatar_path', p.avatar_path, 'joined', r.created_at) order by r.created_at desc)
            from (select * from public.diary_referrals where referrer = auth.uid() order by created_at desc limit 30) r
            join public.diary_profiles p on p.id = r.referred), '[]'::jsonb));
$$;
revoke all on function public.diary_my_referrals() from public, anon;
grant execute on function public.diary_my_referrals() to authenticated;

create or replace function private.diary_notif_category(t text)
returns text
language sql
immutable
set search_path to ''
as $$
    select case
        when t in ('entry_like', 'post_like', 'reel_like', 'library_like', 'entry_reaction', 'story_reaction', 'entry_repost') then 'reactions'
        when t in ('entry_comment', 'post_comment', 'reel_comment', 'post_activity', 'comment_reply') then 'comments'
        when t in ('mention', 'reply') then 'mentions'
        when t in ('new_follower', 'friend_request', 'friend_accepted', 'referral_joined') then 'people'
        when t in ('community_post', 'community_join', 'call_started') then 'groups'
        when t in ('live_started') then 'live'
        when t in ('scheduled_published', 'scheduled_failed') then 'scheduled'
        when t in ('book_request', 'book_request_update', 'book_message') then 'market'
        when t in ('missed_call') then 'calls'
        when t in ('trivia_rank', 'badge_earned', 'game_invite', 'game_turn', 'game_over') then 'games'
        else 'account'
    end;
$$;
