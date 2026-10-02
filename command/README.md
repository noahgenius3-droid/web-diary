# Cordial Command Center

The founder's operations site lives at **`/command/`**, for example `web-diary-gamma.vercel.app/command/`. It's a separate, desktop-first app built on the same stack as Cordial: plain HTML, CSS and ES modules, with supabase-js. It shares Cordial's sign-in, so an admin who is signed in to Cordial is let straight in.

## Access and security
- **Who gets in.** The page only opens for accounts listed in `diary_app_admins`. @noahodus is the super admin.
- **Server-side checks.** Every action calls a Supabase function, which checks the admin's permission on the server, limits each admin to 90 actions a minute, and writes an entry to `diary_audit_log` (reason, before state, after state). Hiding a button in the UI is never the only protection.
- **Roles.**
  - `super_admin`: everything.
  - `moderator`: users, reports and audit.
  - `support`: the helpline and rewards.
  - `analyst`: read-only analytics and audit.
  - Roles are managed in **System → Admin settings**.
- **Sessions.** Sessions are Supabase bearer tokens rather than cookies, so cross-site request forgery doesn't apply. The page checks admin access again whenever it comes back into focus, and leaves if access is gone.
- **Not cached.** The service worker never caches or serves `/command`.

## Two modes
| | Before the database update | After `20261002070000_diary_command_center.sql` |
|---|---|---|
| Users | Search, suspend, lift | Plus email, phone and ID search; block with scopes; deactivate; bulk actions |
| Rewards | Badges | XP, coins, badges and special rewards, with review for large amounts |
| Moderation | Reports, remove, dismiss | Plus severity, investigating state, assignment and appeals |
| Support | — | Helpline inbox, replies, internal notes, escalation, messaging users |
| Insight | Sign-ups, audit log | Full overview, analytics, admin alerts |

To switch the full mode on, run the migration in the Supabase SQL editor. The site detects it automatically.

## Deactivation and sign-in
Deactivating an account stops everything inside Cordial straight away: posting, commenting, messaging and reacting. To also block sign-in on every device, deploy the `diary-admin-auth` edge function in `supabase/functions/diary-admin-auth`. It uses Supabase's Auth admin API, runs only after checking the admin's `users.deactivate` permission, and only for accounts that are already deactivated.

## Keyboard
| Keys | Action |
|---|---|
| `Ctrl/⌘ + K` | Command palette: search everything, or run an action on a user |
| `/` | Find a user |
| `G O` | Overview |
| `G U` | Users |
| `G R` | Reports |
| `G S` | Support |
| `G W` | Rewards |
| `G A` | Audit log |
| `G N` | Analytics |
