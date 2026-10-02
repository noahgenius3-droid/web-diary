// Command palette (Ctrl/⌘ + K): jump anywhere, search everything (users, reports, tickets, rewards, audit, content),
// and act on someone in two keystrokes ("Suspend…" → pick the user). Recent searches are remembered on this device.
import * as api from './api.js';
import { esc, ic, avatar, ago, debounce, toast } from './ui.js';
import { can, statusBadge, REPORT_REASON, actionLabel } from './model.js';
import * as act from './actions.js';

const RECENT_KEY = 'cc-recent';
const recent = () => { try { return JSON.parse(localStorage.getItem(RECENT_KEY) || '[]'); } catch (e) { return []; } };
const remember = item => { try { localStorage.setItem(RECENT_KEY, JSON.stringify([item, ...recent().filter(r => r.href !== item.href)].slice(0, 6))); } catch (e) {} };

export function commands() {
    return [
        { label: 'Search users', hint: 'Find anyone by name, @username, email or ID', icon: 'search', mode: 'find' },
        { label: 'Overview', icon: 'home', href: '#/overview', kbd: 'G O' },
        { label: 'Open reports', icon: 'flag', href: '#/moderation/reports', perm: 'reports.manage', kbd: 'G R' },
        { label: 'Open support', icon: 'life', href: '#/support/open', perm: 'support.manage', kbd: 'G S' },
        { label: 'Open moderation', icon: 'shield', href: '#/moderation/reports', perm: 'reports.manage' },
        { label: 'Appeals', icon: 'undo', href: '#/moderation/appeals', perm: 'reports.manage' },
        { label: 'Suspend user…', icon: 'pause', mode: 'suspend', perm: 'users.suspend' },
        { label: 'Block user…', icon: 'ban', mode: 'block', perm: 'users.block' },
        { label: 'Deactivate user…', icon: 'power', mode: 'deactivate', perm: 'users.deactivate' },
        { label: 'Restore user…', icon: 'undo', mode: 'reactivate', perm: 'users.reactivate' },
        { label: 'Send reward…', icon: 'gift', mode: 'reward', perm: 'rewards.send' },
        { label: 'Message user…', icon: 'mail', mode: 'message', perm: 'support.manage' },
        { label: 'Send announcement', icon: 'megaphone', run: () => act.announcement() },
        { label: 'Reward transactions', icon: 'list', href: '#/rewards/transactions' },
        { label: 'View audit logs', icon: 'list', href: '#/system/audit', perm: 'audit.view', kbd: 'G A' },
        { label: 'View analytics', icon: 'chart', href: '#/analytics/users', perm: 'analytics.view' },
        { label: 'Notifications', icon: 'bell', href: '#/system/alerts' },
        { label: 'Suspended accounts', icon: 'pause', href: '#/users/suspended' },
        { label: 'Deactivated accounts', icon: 'power', href: '#/users/deactivated' }
    ].filter(c => !c.perm || can(c.perm));
}

let dlg = null;
export function openPalette(app, startMode = null) {
    if (dlg && dlg.open) return;
    dlg = document.createElement('dialog');
    dlg.className = 'palette';
    dlg.setAttribute('aria-label', 'Command palette');
    dlg.innerHTML = `
        <div class="pal-in">${ic('search')}<input type="text" role="combobox" aria-expanded="true" aria-controls="pal-list" aria-autocomplete="list" placeholder="Type a command or search…" autocomplete="off" spellcheck="false"><kbd>Esc</kbd></div>
        <div class="pal-list" id="pal-list" role="listbox"></div>
        <div class="pal-foot"><span><kbd>↑</kbd> <kbd>↓</kbd> to move</span><span><kbd>Enter</kbd> to open</span><span><kbd>Esc</kbd> to close</span></div>`;
    document.body.append(dlg);
    const input = dlg.querySelector('input');
    const list = dlg.querySelector('.pal-list');
    let items = [], sel = 0, mode = startMode, q = '', results = null, seq = 0;

    const MODE_TEXT = { find: 'Find a user', suspend: 'Who should be suspended?', block: 'Who should be blocked?', deactivate: 'Whose account should be deactivated?',
        reactivate: 'Whose account should be restored?', reward: 'Who gets the reward?', message: 'Who do you want to message?' };
    const paint = () => {
        items = [];
        let html = '';
        const group = (title, arr) => { if (!arr.length) return; html += `<div class="pal-g">${esc(title)}</div>`; arr.forEach(it => { items.push(it); html += row(it, items.length - 1); }); };
        if (mode) input.placeholder = MODE_TEXT[mode];
        if (!q && !mode) {
            group('Recent', recent().map(r => ({ ...r, icon: r.icon || 'clock' })));
            group('Commands', commands());
        } else if (!q && mode) {
            group('Recent people', recent().filter(r => r.user).map(r => ({ ...r, icon: 'user' })));
        } else {
            if (!mode) group('Commands', commands().filter(c => c.label.toLowerCase().includes(q.toLowerCase())).slice(0, 5));
            if (results) {
                group('Users', (results.users || []).map(u => ({ label: u.display_name, sub: `@${u.username}${u.email ? ` · ${u.email}` : ''}`, user: u, href: `#/user/${u.id}`, badge: statusBadge(u.status) })));
                if (!mode) {
                    group('Reports', (results.reports || []).map(r => ({ label: `${REPORT_REASON[r.reason] || r.reason} — ${r.target || 'content'}`, sub: `${r.status} · ${ago(r.created_at)}`, icon: 'flag', href: `#/moderation/reports?id=${r.id}` })));
                    group('Support tickets', (results.tickets || []).map(t => ({ label: `#${t.ref} ${t.subject}`, sub: `${t.user} · ${t.status}`, icon: 'life', href: `#/support/t/${t.id}` })));
                    group('Rewards', (results.rewards || []).map(w => ({ label: `${w.kind} ${w.amount || ''} — ${w.user}`, sub: w.reason, icon: 'gift', href: `#/user/${w.user_id}/rewards` })));
                    group('Audit log', (results.audit || []).map(a => ({ label: `${actionLabel(a.action)}${a.target ? ` — ${a.target}` : ''}`, sub: a.reason || ago(a.created_at), icon: 'list', href: `#/system/audit?q=${encodeURIComponent(a.action)}` })));
                    group('Content', (results.content || []).map(c => ({ label: c.title || c.snippet || 'Post', sub: `by ${c.author}`, icon: 'post', href: `#/user/${c.author_id}/activity` })));
                }
            } else html += '<div class="pal-g">Searching…</div>';
        }
        if (!items.length && q && results) html += '<div class="state"><strong>Nothing found</strong><p>Try a name, @username, email, ticket #number or case ID.</p></div>';
        sel = Math.min(sel, Math.max(0, items.length - 1));
        list.innerHTML = html;
        mark();
    };
    const row = (it, i) => `<button class="pal-i" role="option" id="pal-${i}" data-i="${i}" aria-selected="false">
        ${it.user ? avatar(it.user, 'sm') : ic(it.icon || 'chevR')}<span class="grow"><span>${esc(it.label)}</span>${it.sub || it.hint ? `<small>${esc(it.sub || it.hint)}</small>` : ''}</span>${it.badge || ''}${it.kbd ? `<kbd>${esc(it.kbd)}</kbd>` : ''}</button>`;
    const mark = () => {
        list.querySelectorAll('.pal-i').forEach(b => b.setAttribute('aria-selected', String(Number(b.dataset.i) === sel)));
        const cur = list.querySelector(`#pal-${sel}`);
        if (cur) { cur.scrollIntoView({ block: 'nearest' }); input.setAttribute('aria-activedescendant', cur.id); }
    };
    const search = debounce(async () => {
        const my = ++seq;
        if (q.length < 2) { results = { users: [] }; paint(); return; }
        try { const r = await api.search(q); if (my === seq) { results = r; paint(); } } catch (e) { if (my === seq) { results = { users: [] }; paint(); } }
    }, 200);
    const run = async it => {
        if (!it) return;
        if (it.mode) { mode = it.mode; q = ''; input.value = ''; results = null; paint(); return; }
        if (it.run) { dlg.close(); it.run(); return; }
        if (it.user && mode && mode !== 'find') {
            dlg.close();
            remember({ label: it.user.display_name, sub: `@${it.user.username}`, href: `#/user/${it.user.id}`, user: it.user });
            try {
                const full = await api.user(it.user.id);
                const fn = { suspend: act.suspend, block: act.block, deactivate: act.deactivate, reactivate: act.reactivate, reward: act.reward, message: act.message }[mode];
                if (await fn(full)) { app.refreshCounts(); if (location.hash.startsWith(`#/user/${it.user.id}`)) app.reload(); }
            } catch (e) { toast(act.friendly(e), { error: true }); }
            return;
        }
        if (it.href) {
            if (q || it.user) remember({ label: it.label, sub: it.sub, href: it.href, icon: it.icon, user: it.user || null });
            dlg.close();
            app.go(it.href);
        }
    };
    input.addEventListener('input', () => { q = input.value.trim(); results = null; sel = 0; paint(); search(); });
    input.addEventListener('keydown', e => {
        if (e.key === 'ArrowDown') { e.preventDefault(); sel = Math.min(items.length - 1, sel + 1); mark(); }
        else if (e.key === 'ArrowUp') { e.preventDefault(); sel = Math.max(0, sel - 1); mark(); }
        else if (e.key === 'Enter') { e.preventDefault(); run(items[sel]); }
        else if (e.key === 'Backspace' && !input.value && mode) { mode = null; input.placeholder = 'Type a command or search…'; paint(); }
    });
    list.addEventListener('click', e => { const b = e.target.closest('[data-i]'); if (b) run(items[Number(b.dataset.i)]); });
    list.addEventListener('mousemove', e => { const b = e.target.closest('[data-i]'); if (b && Number(b.dataset.i) !== sel) { sel = Number(b.dataset.i); mark(); } });
    dlg.addEventListener('click', e => { if (e.target === dlg) dlg.close(); });
    dlg.addEventListener('close', () => dlg.remove());
    dlg.showModal();
    paint();
    input.focus();
}
