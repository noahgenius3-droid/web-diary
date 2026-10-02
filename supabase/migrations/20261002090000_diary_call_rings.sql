-- One row per ring of a one-to-one call: the single source of truth for whether it is still ringing.
-- Only the alert server (diary-notify, service role) changes it, and only out of 'ringing', so a call can be
-- answered once, declined once, and can never turn into "missed" after it connected (or the other way round).
create table if not exists public.diary_call_rings (
    id uuid primary key default gen_random_uuid(),
    caller uuid not null references auth.users (id) on delete cascade,
    callee uuid not null references auth.users (id) on delete cascade,
    topic text not null,
    video boolean not null default false,
    status text not null default 'ringing'
        check (status in ('ringing', 'accepted', 'declined', 'cancelled', 'missed', 'failed')),
    created_at timestamptz not null default now(),
    expires_at timestamptz not null default now() + interval '45 seconds',
    ended_at timestamptz
);

create index if not exists diary_call_rings_callee_idx on public.diary_call_rings (callee, created_at desc);
create index if not exists diary_call_rings_caller_idx on public.diary_call_rings (caller, created_at desc);

alter table public.diary_call_rings enable row level security;

-- The two people on the call can see it; nobody writes to it directly
drop policy if exists "diary_call_rings: participants read" on public.diary_call_rings;
create policy "diary_call_rings: participants read" on public.diary_call_rings
    for select to authenticated
    using ((select auth.uid()) in (caller, callee));

revoke insert, update, delete on public.diary_call_rings from anon, authenticated;
grant select on public.diary_call_rings to authenticated;
