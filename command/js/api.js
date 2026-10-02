// The Command Center's data layer. Every privileged call goes through Supabase RPCs that check permissions on the
// server; this file only shapes requests and results.
//
// Two modes:
//   full    — the Command Center database update is installed (diary_cc_* functions)
//   legacy  — only Cordial's original admin functions exist; we use those where they cover the job and report
//             NeedsUpgrade for the rest, so the UI can say exactly what's missing.
const cfg = window.DIARY_CONFIG || {};
export const client = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseKey);

export class NeedsUpgrade extends Error { constructor(what) { super(`${what} needs the Command Center database update`); this.needsUpgrade = true; } }
export const caps = { full: false };

const missing = e => e && (e.code === 'PGRST202' || /Could not find the function|does not exist/i.test(e.message || ''));
async function rpc(name, args = {}) {
    const { data, error } = await client.rpc(name, args);
    if (error) throw error;
    return data;
}
const need = what => { if (!caps.full) throw new NeedsUpgrade(what); };

// ---------- Session / who am I ----------
export async function session() { const { data } = await client.auth.getSession(); return data.session; }
export async function signIn(email, password) { const { error } = await client.auth.signInWithPassword({ email, password }); if (error) throw error; }
export async function signOut() { await client.auth.signOut(); }
export async function me() {
    const { data, error } = await client.rpc('diary_cc_me');
    if (!error) { caps.full = true; return data; }
    if (!missing(error)) throw error;
    caps.full = false;
    const admin = await rpc('diary_am_admin');
    if (!admin) return null;
    const uid = (await session()).user.id;
    const { data: p } = await client.from('diary_profiles').select('id, username, display_name, avatar_path').eq('id', uid).maybeSingle();
    // The original admin functions only check "is an admin", so a legacy admin can do what they cover
    return { ...(p || { id: uid }), role: 'super_admin', perms: ['users.read', 'users.suspend', 'users.reactivate', 'reports.manage', 'audit.view', 'analytics.view', 'rewards.send'] };
}

// ---------- Overview & analytics ----------
export async function overview() {
    if (caps.full) return rpc('diary_cc_overview');
    const s = await rpc('diary_admin_stats');
    const week = new Date(Date.now() - 7 * 864e5).toISOString();
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const [{ count: newToday }, { count: newWeek }] = await Promise.all([
        client.from('diary_profiles').select('id', { count: 'exact', head: true }).gte('created_at', today.toISOString()),
        client.from('diary_profiles').select('id', { count: 'exact', head: true }).gte('created_at', week)
    ]);
    return {
        legacy: true,
        users: { total: s.users, active_24h: s.active_today, new_today: newToday, new_week: newWeek, suspended: s.suspended, blocked: null, deactivated: null },
        engagement: { messages: s.messages_today },
        moderation: { open_reports: s.open_reports },
        support: null, rewards: null, alerts_unread: 0
    };
}
export async function series(days = 30) {
    if (caps.full) return rpc('diary_cc_series', { p_days: days });
    // Legacy: sign-ups only (the one daily series we can build from readable data)
    const from = new Date(Date.now() - (days - 1) * 864e5); from.setHours(0, 0, 0, 0);
    const { data } = await client.from('diary_profiles').select('created_at').gte('created_at', from.toISOString()).limit(5000);
    const out = [];
    for (let i = 0; i < days; i++) {
        const d = new Date(from.getTime() + i * 864e5);
        const key = d.toISOString().slice(0, 10);
        out.push({ day: key, signups: (data || []).filter(r => r.created_at.slice(0, 10) === key).length, legacy: true });
    }
    return out;
}

// ---------- Users ----------
function legacyRow(u) {
    return {
        id: u.id, username: u.username, display_name: u.display_name, avatar_path: u.avatar_path, verified: u.verified, created_at: u.created_at,
        status: u.suspended ? 'suspended' : 'active', ends_at: u.suspended_until, xp: u.xp, posts: u.posts, reports: u.reports,
        email: null, last_seen_at: null, coins: null, streak: null, board_hidden: u.board_hidden
    };
}
export async function users({ status = 'all', q = '', sort = 'joined', desc = true, limit = 50, offset = 0 } = {}) {
    if (caps.full) return rpc('diary_cc_users', { p_status: status, p_q: q || null, p_sort: sort, p_desc: desc, p_limit: limit, p_offset: offset });
    let rows = (await rpc('diary_admin_users', { p_search: q || null, p_limit: 200 })).map(legacyRow);
    const counts = rows.reduce((c, r) => ((c[r.status] = (c[r.status] || 0) + 1), c), {});
    if (status && status !== 'all') rows = rows.filter(r => r.status === status);
    const key = sort === 'name' ? 'display_name' : 'created_at';
    rows.sort((a, b) => String(a[key] || '').localeCompare(String(b[key] || '')) * (desc ? -1 : 1));
    return { total: rows.length, rows: rows.slice(offset, offset + limit), counts, legacy: true };
}
export async function user(id) {
    if (caps.full) return rpc('diary_cc_user', { p_user: id });
    const { data: p } = await client.from('diary_profiles').select('id, username, display_name, avatar_path, verified, created_at').eq('id', id).maybeSingle();
    if (!p) throw new Error('No such user');
    const [list, full, history, reportsIn] = await Promise.all([
        rpc('diary_admin_users', { p_search: p.username, p_limit: 20 }),
        client.rpc('diary_profile_full', { p_id: id }).then(r => r.data || {}),
        client.from('diary_audit_log').select('id, action, details, created_at, actor').eq('target_user', id).order('created_at', { ascending: false }).limit(30).then(r => r.data || []),
        client.from('diary_reports').select('id', { count: 'exact', head: true }).eq('target_user', id)
    ]);
    const row = (list || []).find(r => r.id === id);
    const names = await namesOf(history.map(h => h.actor));
    const stats = full.stats || {};
    return {
        ...p, ...(row ? legacyRow(row) : { status: 'active' }), legacy: true,
        restriction: row && row.suspended ? { status: 'suspended', ends_at: row.suspended_until, reason: null } : null,
        counts: { posts: stats.posts, followers: stats.followers, friends: stats.friends, reports_received: reportsIn.count },
        history: history.map(h => ({ ...h, reason: h.details && (h.details.reason || h.details.note), actor_name: names[h.actor] }))
    };
}
export async function timeline(id, before = null) {
    if (caps.full) return rpc('diary_cc_timeline', { p_user: id, p_before: before, p_limit: 60 });
    if (before) return [];
    const [p, posts, audit, reps] = await Promise.all([
        client.from('diary_profiles').select('created_at').eq('id', id).maybeSingle().then(r => r.data),
        client.from('diary_shared_entries').select('id, title, body, shared_at').eq('author', id).order('shared_at', { ascending: false }).limit(30).then(r => r.data || []),
        client.from('diary_audit_log').select('action, details, created_at').eq('target_user', id).order('created_at', { ascending: false }).limit(30).then(r => r.data || []),
        client.from('diary_reports').select('id, reason, details, created_at').eq('target_user', id).order('created_at', { ascending: false }).limit(30).then(r => r.data || [])
    ]);
    const ev = [
        ...(p ? [{ kind: 'joined', at: p.created_at, title: 'Joined Cordial' }] : []),
        ...posts.map(e => ({ kind: 'post', at: e.shared_at, title: 'Shared a post', detail: (e.title || e.body || '').slice(0, 140) })),
        ...audit.map(a => ({ kind: 'admin', at: a.created_at, title: a.action, detail: a.details && (a.details.reason || a.details.note) })),
        ...reps.map(r => ({ kind: 'reported', at: r.created_at, title: 'Was reported', detail: r.reason + (r.details ? `: ${r.details}` : ''), ref: `report:${r.id}` }))
    ];
    return ev.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
}
async function namesOf(ids) {
    const uniq = [...new Set(ids.filter(Boolean))];
    if (!uniq.length) return {};
    const { data } = await client.from('diary_profiles').select('id, display_name').in('id', uniq);
    return Object.fromEntries((data || []).map(p => [p.id, p.display_name]));
}
export async function profilesOf(ids) {
    const uniq = [...new Set(ids.filter(Boolean))];
    if (!uniq.length) return {};
    const { data } = await client.from('diary_profiles').select('id, username, display_name, avatar_path, verified').in('id', uniq);
    return Object.fromEntries((data || []).map(p => [p.id, p]));
}

// ---------- Account status (the one way states change) ----------
/** @param {{user:string,status:string,reason:string,scope?:string[],hours?:number|null,until?:string|null,userMessage?:string,note?:string}} a */
export async function setStatus(a) {
    if (caps.full) {
        return rpc('diary_cc_set_status', { p_user: a.user, p_status: a.status, p_reason: a.reason, p_scope: a.scope || [], p_hours: a.hours ?? null,
            p_until: a.until || null, p_user_message: a.userMessage || null, p_note: a.note || null });
    }
    if (a.status === 'suspended') {
        const days = a.until ? Math.max(1, Math.ceil((Date.parse(a.until) - Date.now()) / 864e5)) : a.hours > 0 ? Math.max(1, Math.ceil(a.hours / 24)) : 0;
        return rpc('diary_admin_suspend', { p_user: a.user, p_days: days, p_reason: a.reason });
    }
    if (a.status === 'active') return rpc('diary_lift_suspension', { p_user: a.user });
    throw new NeedsUpgrade(a.status === 'blocked' ? 'Blocking' : 'Deactivation');
}
export async function bulkStatus(ids, a) {
    if (caps.full) return rpc('diary_cc_bulk_status', { p_users: ids, p_status: a.status, p_reason: a.reason, p_scope: a.scope || [], p_hours: a.hours ?? null, p_user_message: a.userMessage || null });
    let done = 0; const failed = [];
    for (const id of ids) { try { await setStatus({ ...a, user: id }); done++; } catch (e) { failed.push({ user: id, error: e.message }); } }
    return { done, failed };
}
// Stop (or allow) sign-in for a deactivated account. Optional server function; reports whether it ran.
export async function signInBan(userId, ban) {
    try {
        const { data, error } = await client.functions.invoke('diary-admin-auth', { body: { user: userId, action: ban ? 'ban' : 'unban' } });
        if (error) throw error;
        return { ok: true, data };
    } catch (e) { return { ok: false, error: e }; }
}

// ---------- Rewards ----------
export async function badges() { const { data } = await client.from('diary_badges').select('id, name, description, tier').order('sort'); return data || []; }
export async function sendReward(a) {
    if (caps.full) {
        return rpc('diary_cc_send_reward', { p_user: a.user, p_kind: a.kind, p_amount: a.amount || 0, p_reason: a.reason, p_message: a.message || null,
            p_badge: a.badge || null, p_confirm_large: !!a.confirmLarge });
    }
    if (a.kind === 'badge') return rpc('diary_admin_badge', { p_user: a.user, p_badge: a.badge, p_award: true });
    throw new NeedsUpgrade(`${a.kind === 'xp' ? 'XP' : a.kind === 'coins' ? 'Coin' : 'Special'} rewards`);
}
export async function rewards(f = {}) {
    need('Reward history');
    return rpc('diary_cc_rewards', { p_q: f.q || null, p_kind: f.kind || null, p_status: f.status || null, p_from: f.from || null, p_to: f.to || null,
        p_user: f.user || null, p_limit: f.limit || 50, p_offset: f.offset || 0 });
}
export const reviewReward = (id, approve, note) => (need('Reward review'), rpc('diary_cc_review_reward', { p_id: id, p_approve: approve, p_note: note || null }));
export const reverseReward = (id, reason) => (need('Reversing rewards'), rpc('diary_cc_reverse_reward', { p_id: id, p_reason: reason }));

// ---------- Reports & appeals ----------
export async function reports({ status = 'active', severity = null, q = '', user = null, limit = 50, offset = 0 } = {}) {
    if (caps.full) return rpc('diary_cc_reports', { p_status: status, p_severity: severity, p_q: q || null, p_user: user, p_limit: limit, p_offset: offset });
    let query = client.from('diary_reports').select('*', { count: 'exact' }).order('created_at', { ascending: false }).range(offset, offset + limit - 1);
    if (status === 'active') query = query.eq('status', 'open');
    else if (status && status !== 'all') query = query.eq('status', status);
    if (user) query = query.or(`target_user.eq.${user},reporter.eq.${user}`);
    const { data, error, count } = await query;
    if (error) throw error;
    const people = await profilesOf((data || []).flatMap(r => [r.target_user, r.reporter, r.handled_by]));
    const sev = r => (['self_harm', 'violence'].includes(r) ? 'critical' : ['sexual', 'hate', 'harassment', 'scam'].includes(r) ? 'high' : r === 'spam' ? 'low' : 'medium');
    let rows = (data || []).map(r => ({
        ...r, severity: sev(r.reason),
        target_name: people[r.target_user] && people[r.target_user].display_name, target_username: people[r.target_user] && people[r.target_user].username,
        target_avatar: people[r.target_user] && people[r.target_user].avatar_path,
        reporter_name: people[r.reporter] && people[r.reporter].display_name, reporter_username: people[r.reporter] && people[r.reporter].username,
        handled_name: people[r.handled_by] && people[r.handled_by].display_name
    }));
    if (severity) rows = rows.filter(r => r.severity === severity);
    if (q) rows = rows.filter(r => `${r.target_name} ${r.target_username} ${r.details} ${r.snapshot}`.toLowerCase().includes(q.toLowerCase()));
    return { total: count ?? rows.length, rows, legacy: true };
}
// Act on a report: remove the content / warn / dismiss (works in both modes)
export const resolveReport = (id, action, note) => rpc('diary_resolve_report', { p_id: id, p_action: action, p_note: note || null });
export const updateReport = (id, f) => (need('Report triage'), rpc('diary_cc_update_report', { p_id: id, p_status: f.status || null, p_severity: f.severity || null,
    p_assign: f.assign || null, p_unassign: !!f.unassign, p_note: f.note || null }));
export const appeals = (status = 'open') => (need('Appeals'), rpc('diary_cc_appeals', { p_status: status }));
export const decideAppeal = (id, overturn, note) => (need('Appeals'), rpc('diary_cc_decide_appeal', { p_id: id, p_overturn: overturn, p_note: note }));

// ---------- Helpline ----------
export const tickets = (f = {}) => (need('The helpline'), rpc('diary_cc_tickets', { p_view: f.view || 'open', p_q: f.q || null, p_user: f.user || null, p_limit: f.limit || 50, p_offset: f.offset || 0 }));
export const ticket = id => (need('The helpline'), rpc('diary_cc_ticket', { p_id: id }));
export const ticketReply = (id, body, internal) => (need('The helpline'), rpc('diary_cc_ticket_reply', { p_id: id, p_body: body, p_internal: !!internal }));
export const ticketUpdate = (id, f) => (need('The helpline'), rpc('diary_cc_ticket_update', { p_id: id, p_status: f.status || null, p_priority: f.priority || null,
    p_assign: f.assign || null, p_unassign: !!f.unassign }));
export const messageUser = (user, subject, body) => (need('Messaging users'), rpc('diary_cc_message_user', { p_user: user, p_subject: subject, p_body: body }));

// ---------- Audit, alerts, search, admins, announcements ----------
export async function audit(f = {}) {
    if (caps.full) {
        return rpc('diary_cc_audit', { p_q: f.q || null, p_action: f.action || null, p_actor: f.actor || null, p_target: f.target || null,
            p_from: f.from || null, p_to: f.to || null, p_limit: f.limit || 50, p_offset: f.offset || 0 });
    }
    const limit = f.limit || 50, offset = f.offset || 0;
    let query = client.from('diary_audit_log').select('*', { count: 'exact' }).order('created_at', { ascending: false }).range(offset, offset + limit - 1);
    if (f.action) query = query.eq('action', f.action);
    if (f.actor) query = query.eq('actor', f.actor);
    if (f.target) query = query.eq('target_user', f.target);
    if (f.from) query = query.gte('created_at', f.from);
    if (f.to) query = query.lt('created_at', f.to);
    const { data, error, count } = await query;
    if (error) throw error;
    const people = await profilesOf((data || []).flatMap(l => [l.actor, l.target_user]));
    const rows = (data || []).map(l => ({ ...l, reason: l.details && (l.details.reason || l.details.note), actor_name: people[l.actor] && people[l.actor].display_name,
        actor_avatar: people[l.actor] && people[l.actor].avatar_path, target_name: people[l.target_user] && people[l.target_user].display_name,
        target_username: people[l.target_user] && people[l.target_user].username }));
    const { data: acts } = await client.from('diary_audit_log').select('action').limit(1000);
    return { total: count ?? rows.length, rows, actions: [...new Set((acts || []).map(a => a.action))], legacy: true };
}
export const alerts = () => (caps.full ? rpc('diary_cc_alerts', { p_limit: 50 }) : Promise.resolve([]));
export const alertsRead = ids => (caps.full ? rpc('diary_cc_alerts_read', { p_ids: ids || null }) : Promise.resolve());
export async function search(q) {
    if (caps.full) return rpc('diary_cc_search', { p_q: q });
    const users = (await rpc('diary_admin_users', { p_search: q, p_limit: 8 })).map(legacyRow);
    return { users, reports: [], tickets: [], rewards: [], audit: [], content: [] };
}
export async function admins() {
    if (caps.full) return rpc('diary_cc_admins');
    const { data } = await client.from('diary_app_admins').select('user_id, added_at');
    const people = await profilesOf((data || []).map(a => a.user_id));
    return (data || []).map(a => ({ ...(people[a.user_id] || { id: a.user_id }), role: 'super_admin', added_at: a.added_at }));
}
export const setAdmin = (user, role) => (need('Admin roles'), rpc('diary_cc_set_admin', { p_user: user, p_role: role }));
export const announce = (title, body, link, days, notify) => rpc('diary_admin_announce', { p_title: title, p_body: body, p_link: link || '', p_days: days, p_notify: notify });
