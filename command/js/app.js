// Boot, access control and routing. The page only renders for Cordial admins (checked on the server through
// diary_cc_me / diary_am_admin); every action is checked again on the server, so hiding a button is never the
// only protection.
import * as api from './api.js';
import { esc, ic, avatar, toast, $, friendly, timeTag } from './ui.js';
import { setPerms, can } from './model.js';
import { openPalette } from './palette.js';
import { alertLink } from './views/system.js';

const root = document.getElementById('app');
const VIEWS = {
    overview: () => import('./views/overview.js'),
    users: () => import('./views/users.js'),
    user: () => import('./views/user.js'),
    moderation: () => import('./views/moderation.js'),
    support: () => import('./views/support.js'),
    rewards: () => import('./views/rewards.js'),
    analytics: () => import('./views/analytics.js'),
    system: () => import('./views/system.js')
};

const app = {
    me: null,
    counts: {},
    go(hash) { if (location.hash === hash) this.reload(); else location.hash = hash; },
    replace(hash) { history.replaceState(null, '', hash); highlight(); }, // no hashchange fires, so the page isn't redrawn
    reload() { route(); },
    refreshCounts: () => refreshCounts()
};

// ---------- Boot ----------
async function boot() {
    let s = await api.session();
    if (!s) return gate();
    try {
        app.me = await api.me();
    } catch (err) {
        root.innerHTML = `<div class="gate"><div class="gate-card"><div class="brand"><span class="brand-mark">C</span>Cordial</div><h1>Couldn’t open the Command Center</h1><p>${esc(friendly(err))}</p><button class="btn primary" onclick="location.reload()">Try again</button></div></div>`;
        return;
    }
    if (!app.me) return denied(s);
    setPerms(app.me.perms);
    shell();
    route();
    refreshCounts();
    setInterval(refreshCounts, 60000);
    // Lose admin access (or sign out elsewhere) → leave straight away
    api.client.auth.onAuthStateChange((evt, sess) => { if (!sess) location.reload(); });
    document.addEventListener('visibilitychange', async () => {
        if (document.visibilityState !== 'visible') return;
        const again = await api.me().catch(() => null);
        if (!again) location.reload();
    });
}

function gate(message = '') {
    root.removeAttribute('aria-busy');
    root.innerHTML = `
        <main class="gate"><div class="gate-card">
            <div class="brand"><span class="brand-mark">C</span><span>Cordial<small>Command Center</small></span></div>
            <h1>Sign in</h1><p>Use your Cordial admin account. Access is checked on the server.</p>
            <form data-signin>
                <label class="field"><span>Email</span><input class="input" type="email" name="email" autocomplete="username" required></label>
                <label class="field"><span>Password</span><input class="input" type="password" name="password" autocomplete="current-password" required></label>
                <p class="form-err" role="alert" ${message ? '' : 'hidden'}>${esc(message)}</p>
                <button class="btn primary" type="submit">Sign in</button>
                <button class="btn" type="button" data-google>Continue with Google</button>
            </form>
            <p class="gate-note">Already signed in to Cordial in this browser? You’ll be let in automatically. This area is private: every action is logged.</p>
        </div></main>`;
    const form = root.querySelector('[data-signin]');
    form.addEventListener('submit', async e => {
        e.preventDefault();
        const err = form.querySelector('.form-err');
        const btn = form.querySelector('[type="submit"]');
        btn.disabled = true;
        try { await api.signIn(form.elements.email.value.trim(), form.elements.password.value); location.reload(); }
        catch (error) { err.hidden = false; err.textContent = friendly(error); btn.disabled = false; }
    });
    root.querySelector('[data-google]').addEventListener('click', () => api.client.auth.signInWithOAuth({ provider: 'google', options: { redirectTo: `${location.origin}/command/` } }));
}

function denied(s) {
    root.removeAttribute('aria-busy');
    root.innerHTML = `<main class="gate"><div class="gate-card"><div class="brand"><span class="brand-mark">C</span><span>Cordial<small>Command Center</small></span></div>
        <h1>No access</h1><p>${esc(s.user.email || 'This account')} isn’t a Cordial admin. If you should have access, ask the founder to add you.</p>
        <div style="display:flex;gap:8px"><a class="btn" href="/">Back to Cordial</a><button class="btn" data-out>Use another account</button></div></div></main>`;
    root.querySelector('[data-out]').addEventListener('click', async () => { await api.signOut(); location.reload(); });
}

// ---------- Shell ----------
const NAV = [
    { group: null, items: [{ name: 'overview', label: 'Overview', icon: 'home', href: '#/overview' }] },
    { group: 'Users', perm: 'users.read', items: [{ name: 'users', label: 'Users', icon: 'users', href: '#/users', subs: [['', 'All users'], ['active', 'Active'], ['suspended', 'Suspended'], ['blocked', 'Blocked'], ['deactivated', 'Deactivated']] }] },
    { group: 'Moderation', perm: 'reports.manage', items: [{ name: 'moderation', label: 'Moderation', icon: 'shield', href: '#/moderation/reports', count: 'reports', subs: [['reports', 'Reports'], ['review', 'Content review'], ['appeals', 'Appeals'], ['history', 'Moderation history']] }] },
    { group: 'Support', perm: 'support.manage', items: [{ name: 'support', label: 'Support', icon: 'life', href: '#/support/open', count: 'support', subs: [['open', 'Open tickets'], ['priority', 'Priority'], ['resolved', 'Resolved'], ['all', 'User helpline']] }] },
    { group: 'Rewards', items: [{ name: 'rewards', label: 'Rewards', icon: 'gift', href: '#/rewards/transactions', count: 'rewards', subs: [['send', 'Send reward'], ['transactions', 'Transactions'], ['pending', 'Awaiting review']] }] },
    { group: 'Analytics', perm: 'analytics.view', items: [{ name: 'analytics', label: 'Analytics', icon: 'chart', href: '#/analytics/users', subs: [['users', 'Users'], ['engagement', 'Engagement'], ['moderation', 'Moderation'], ['rewards', 'Rewards']] }] },
    { group: 'System', items: [{ name: 'system', label: 'System', icon: 'settings', href: '#/system/audit', count: 'alerts', subs: [['audit', 'Audit logs'], ['alerts', 'Notifications'], ['admins', 'Admin settings']] }] }
];
function shell() {
    root.removeAttribute('aria-busy');
    const isMac = /Mac|iPhone|iPad/.test(navigator.platform);
    root.innerHTML = `
        <div class="shell">
            <aside class="side" aria-label="Command Center">
                <div class="brand"><span class="brand-mark">C</span><span>Cordial<small>Command Center</small></span></div>
                <nav aria-label="Sections" data-nav></nav>
                <div class="side-foot">
                    <div class="me">${avatar(app.me)}<span><strong>${esc(app.me.display_name || 'Admin')}</strong><small><span class="role">${esc(String(app.me.role).replace('_', ' '))}</span></small></span></div>
                    <div style="display:flex;gap:6px">
                        <button class="btn sm" data-theme title="Switch light / dark">${ic('moon')}Theme</button>
                        <a class="btn sm" href="/" title="Open Cordial">${ic('ext')}Cordial</a>
                        <button class="btn sm ghost" data-signout title="Sign out">${ic('out')}<span class="sr">Sign out</span></button>
                    </div>
                </div>
            </aside>
            <div class="main">
                <header class="top">
                    <button class="btn icon menu-btn" data-menu aria-label="Open navigation">${ic('menu')}</button>
                    <button class="top-search" data-palette aria-label="Search and commands (${isMac ? '⌘' : 'Ctrl'}+K)">${ic('search')}<span>Search users, reports, tickets, rewards…</span><kbd>${isMac ? '⌘' : 'Ctrl'} K</kbd></button>
                    <div class="top-actions">
                        ${can('rewards.send') ? `<button class="btn sm" data-quick="reward">${ic('gift')}<span class="hide-sm">Reward</span></button>` : ''}
                        <div class="rel"><button class="btn icon" data-bell aria-label="Notifications" aria-haspopup="true" aria-expanded="false">${ic('bell')}</button><span data-bell-n></span><div data-bell-pop hidden></div></div>
                    </div>
                </header>
                <main id="main" tabindex="-1"><div class="content" data-view></div></main>
            </div>
        </div>`;
    paintNav();
    root.addEventListener('click', onShellClick);
    document.addEventListener('keydown', onKey);
}
function paintNav() {
    const nav = $('[data-nav]', root);
    nav.innerHTML = NAV.filter(g => !g.perm || can(g.perm)).map(g => `
        ${g.group ? `<div class="nav-g">${esc(g.group)}</div>` : ''}
        ${g.items.map(it => `<a class="nav-a" href="${it.href}" data-name="${it.name}">${ic(it.icon)}${esc(it.label)}${it.count ? `<span class="count${app.counts[it.count + 'Hot'] ? ' hot' : ''}"${app.counts[it.count] ? '' : ' hidden'}>${app.counts[it.count] || ''}</span>` : ''}</a>
            ${it.subs ? `<div class="nav-sub" data-sub="${it.name}">${it.subs.map(([k, l]) => `<a class="nav-a" href="#/${it.name}${k ? `/${k}` : ''}" data-subname="${it.name}/${k}">${esc(l)}</a>`).join('')}</div>` : ''}`).join('')}`).join('');
    highlight();
}
function highlight() {
    const r = parse();
    root.querySelectorAll('.nav-a[data-name]').forEach(a => a.setAttribute('aria-current', a.dataset.name === (r.name === 'user' ? 'users' : r.name) ? 'page' : 'false'));
    root.querySelectorAll('.nav-a[data-subname]').forEach(a => {
        const [n, k] = a.dataset.subname.split('/');
        a.setAttribute('aria-current', n === r.name && (k === (r.sub || '') || (n === 'support' && r.sub === 't' && k === 'open')) ? 'page' : 'false');
    });
    root.querySelectorAll('.nav-sub').forEach(s => { s.hidden = s.dataset.sub !== (r.name === 'user' ? 'users' : r.name); });
}

async function onShellClick(e) {
    if (e.target.closest('[data-palette]')) return openPalette(app);
    if (e.target.closest('[data-menu]')) { root.querySelector('.shell').classList.toggle('nav-open'); return; }
    if (e.target.closest('.nav-a') && matchMedia('(max-width: 1024px)').matches) root.querySelector('.shell').classList.remove('nav-open');
    if (e.target.closest('[data-signout]')) { await api.signOut(); location.reload(); return; }
    if (e.target.closest('[data-theme]')) {
        const cur = document.documentElement.dataset.theme || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
        const next = cur === 'dark' ? 'light' : 'dark';
        document.documentElement.dataset.theme = next;
        try { localStorage.setItem('cc-theme', next); } catch (err) {}
        return;
    }
    if (e.target.closest('[data-quick="reward"]')) { (await import('./actions.js')).reward(); return; }
    const bell = e.target.closest('[data-bell]');
    const pop = root.querySelector('[data-bell-pop]');
    if (bell) {
        const open = pop.hidden;
        pop.hidden = !open;
        bell.setAttribute('aria-expanded', String(open));
        if (open) {
            pop.className = 'pop';
            pop.innerHTML = '<div class="skel-rows"><span class="skel"></span><span class="skel"></span></div>';
            if (!api.caps.full) { pop.innerHTML = '<div class="state"><strong>Notifications switch on with the database update</strong></div>'; return; }
            const rows = await api.alerts().catch(() => []);
            pop.innerHTML = `${rows.slice(0, 12).map(a => `<div class="alert-i${a.read_at ? '' : ' unread'}"><span class="badge sev-${a.severity}">${esc(a.severity)}</span>
                <strong>${alertLink(a) ? `<a href="${alertLink(a)}">${esc(a.title)}</a>` : esc(a.title)}</strong><p>${esc(a.body || '')} · ${timeTag(a.created_at)}</p></div>`).join('') || '<div class="state"><strong>All quiet</strong><p>No notifications.</p></div>'}
                <div style="display:flex;gap:8px;padding:10px 14px"><a class="btn sm" href="#/system/alerts">View all</a>${rows.some(a => !a.read_at) ? '<button class="btn sm" data-read>Mark all read</button>' : ''}</div>`;
        }
        return;
    }
    if (e.target.closest('[data-read]')) { await api.alertsRead(null); pop.hidden = true; refreshCounts(); return; }
    if (!e.target.closest('[data-bell-pop]') && pop && !pop.hidden) pop.hidden = true;
}

let chord = null;
function onKey(e) {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); openPalette(app); return; }
    if (e.target.closest('input, textarea, select, [contenteditable]') || document.querySelector('dialog[open]')) return;
    if (e.key === '/') { e.preventDefault(); openPalette(app, 'find'); return; }
    // "G then a letter" jumps between sections
    if (chord && Date.now() - chord < 900) {
        const to = { o: '#/overview', u: '#/users', r: '#/moderation/reports', s: '#/support/open', w: '#/rewards/transactions', a: '#/system/audit', n: '#/analytics/users' }[e.key.toLowerCase()];
        chord = null;
        if (to) { e.preventDefault(); app.go(to); }
        return;
    }
    if (e.key.toLowerCase() === 'g') chord = Date.now();
}

async function refreshCounts() {
    try {
        const o = await api.overview();
        app.counts = {
            reports: (o.moderation && o.moderation.open_reports) || 0, reportsHot: !!(o.moderation && o.moderation.high_reports),
            support: (o.support && o.support.open) || 0, supportHot: !!(o.support && o.support.urgent),
            rewards: (o.rewards && o.rewards.pending) || 0, alerts: o.alerts_unread || 0, alertsHot: !!o.alerts_unread
        };
        const n = root.querySelector('[data-bell-n]');
        if (n) n.innerHTML = o.alerts_unread ? `<span class="bell-n">${o.alerts_unread > 99 ? '99+' : o.alerts_unread}</span>` : '';
        if (root.querySelector('[data-nav]')) paintNav();
    } catch (e) { /* counts are a convenience */ }
}

// ---------- Routing ----------
function parse() {
    const [path, qs] = (location.hash.replace(/^#\/?/, '') || 'overview').split('?');
    const parts = path.split('/').filter(Boolean);
    const query = Object.fromEntries(new URLSearchParams(qs || ''));
    const name = VIEWS[parts[0]] ? parts[0] : 'overview';
    if (name === 'user') return { name, id: parts[1], sub: parts[2] || '', query };
    if (name === 'support' && parts[1] === 't') return { name, sub: 't', id: parts[2], query };
    return { name, sub: parts[1] || '', id: parts[2] || null, query };
}
let routeSeq = 0;
async function route() {
    const r = parse();
    const seq = ++routeSeq;
    highlight();
    const holder = root.querySelector('[data-view]');
    if (!holder) return;
    // A fresh element per page, so the previous page's listeners go with it
    const el = document.createElement('div');
    holder.replaceWith(el);
    el.className = 'content';
    el.dataset.view = '';
    try {
        const mod = await VIEWS[r.name]();
        if (seq !== routeSeq) return;
        await mod.view(el, r, app);
        document.title = `${r.name[0].toUpperCase() + r.name.slice(1)} · Cordial Command Center`;
    } catch (err) {
        el.innerHTML = `<div class="state err" role="alert"><strong>This page couldn’t open</strong><p>${esc(friendly(err))}</p></div>`;
    }
    $('#main').focus({ preventScroll: true });
    window.scrollTo(0, 0);
}
window.addEventListener('hashchange', route);

boot().catch(err => { root.innerHTML = `<div class="boot">${esc(friendly(err))}</div>`; toast(friendly(err), { error: true }); });
