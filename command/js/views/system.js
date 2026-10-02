// System: the audit log (who did what, to whom, why, and what changed), admin notifications, and admin roles.
import * as api from '../api.js';
import { esc, num, ic, loadingRows, failed, empty, timeTag, dateTime, avatar, toast, needsUpgrade, debounce, modal, who } from '../ui.js';
import { actionLabel, statusBadge, scopeLabel, can, ROLES } from '../model.js';
import * as act from '../actions.js';

const TABS = [['audit', 'Audit log'], ['alerts', 'Notifications'], ['admins', 'Admins & settings']];

export async function view(el, params, app) {
    const sub = TABS.some(t => t[0] === params.sub) ? params.sub : 'audit';
    el.innerHTML = `
        <header class="ph"><div><h1>System</h1><p>The record of every privileged action, alerts, and who can do what.</p></div></header>
        <div class="tabs" role="tablist" style="padding:0;margin-bottom:14px">${TABS.map(([k, l]) => `<a role="tab" aria-selected="${k === sub}" href="#/system/${k}" class="btn ghost" style="border-radius:0;${k === sub ? 'box-shadow:inset 0 -2px 0 var(--accent);color:var(--text)' : 'color:var(--text-2)'}">${l}</a>`).join('')}</div>
        <div data-body></div>`;
    const body = el.querySelector('[data-body]');
    if (sub === 'alerts') return alerts(body, app);
    if (sub === 'admins') return admins(body, app);
    return auditLog(body, params);
}

async function auditLog(body, params) {
    if (!can('audit.view')) { body.innerHTML = empty('The audit log needs the audit permission'); return; }
    const st = { q: params.query.q || '', action: '', actor: '', from: '', to: '', offset: 0, open: null };
    const admins = await api.admins().catch(() => []);
    body.innerHTML = `
        <div class="filters">
            <input class="input grow" type="search" data-f="q" placeholder="Search action, reason, person or reference" value="${esc(st.q)}" aria-label="Search the audit log">
            <select class="input" data-f="action" aria-label="Action"><option value="">All actions</option></select>
            <select class="input" data-f="actor" aria-label="Admin"><option value="">Any admin</option>${admins.map(a => `<option value="${esc(a.id)}">${esc(a.display_name)}</option>`).join('')}</select>
            <label class="muted" style="font-size:.8rem">From <input class="input" type="date" data-f="from" style="min-width:0"></label>
            <label class="muted" style="font-size:.8rem">To <input class="input" type="date" data-f="to" style="min-width:0"></label>
        </div>
        <div data-table>${loadingRows(8)}</div>`;
    const table = body.querySelector('[data-table]');
    const actionSel = body.querySelector('[data-f="action"]');
    const load = async () => {
        table.innerHTML = loadingRows(8);
        try {
            const res = await api.audit({ q: st.q, action: st.action || null, actor: st.actor || null, from: st.from ? new Date(st.from).toISOString() : null,
                to: st.to ? new Date(new Date(st.to).getTime() + 864e5).toISOString() : null, limit: 50, offset: st.offset });
            if (actionSel.options.length === 1) actionSel.insertAdjacentHTML('beforeend', (res.actions || []).sort().map(a => `<option value="${esc(a)}">${esc(actionLabel(a))} (${esc(a)})</option>`).join(''));
            if (!res.rows.length) { table.innerHTML = empty('No matching entries'); return; }
            table.innerHTML = `<div class="table-wrap"><table class="t"><thead><tr><th>When</th><th>Action</th><th>Admin</th><th>Target</th><th>Reason</th><th>Change</th><th></th></tr></thead>
                <tbody>${res.rows.map(l => `
                    <tr><td title="${esc(dateTime(l.created_at))}">${esc(dateTime(l.created_at))}</td>
                        <td><strong>${esc(actionLabel(l.action))}</strong><div class="muted mono" style="font-size:.72rem">${esc(l.action)}</div></td>
                        <td>${esc(l.actor_name || '—')}</td>
                        <td>${l.target_user ? `<a href="#/user/${esc(l.target_user)}">${esc(l.target_name || 'user')}</a>` : l.target_ref ? `<span class="mono">${esc(l.target_kind || '')} ${esc(String(l.target_ref).slice(0, 8))}</span>` : '<span class="muted">—</span>'}</td>
                        <td class="clip" title="${esc(l.reason || '')}">${esc(l.reason || '—')}</td>
                        <td>${l.prev_state || l.new_state ? `<span class="diff">${l.prev_state && l.prev_state.status ? statusBadge(l.prev_state.status) : ''}${l.prev_state && l.new_state ? '<span class="arrow">→</span>' : ''}${l.new_state && l.new_state.status && ['active', 'suspended', 'blocked', 'deactivated'].includes(l.new_state.status) ? statusBadge(l.new_state.status) : l.new_state && l.new_state.status ? esc(l.new_state.status) : ''}</span>` : '<span class="muted">—</span>'}</td>
                        <td class="n"><button class="btn sm ghost" data-detail="${esc(l.id)}" aria-label="Show details">${ic('chevD')}</button></td></tr>
                    <tr hidden data-detail-row="${esc(l.id)}"><td colspan="7" style="background:var(--panel-2)"><dl class="kv">
                        <dt>Entry</dt><dd class="mono">${esc(l.id)}</dd>
                        <dt>Before</dt><dd><code class="mono">${esc(JSON.stringify(l.prev_state || null))}</code></dd>
                        <dt>After</dt><dd><code class="mono">${esc(JSON.stringify(l.new_state || null))}</code></dd>
                        <dt>Metadata</dt><dd><code class="mono">${esc(JSON.stringify(l.details || {}))}</code></dd></dl></td></tr>`).join('')}</tbody></table></div>
                <div class="pager"><span>${num(st.offset + 1)}–${num(st.offset + res.rows.length)} of ${num(res.total)}</span>
                    <span class="ph-actions"><button class="btn sm" data-page="-1"${st.offset ? '' : ' disabled'}>Previous</button><button class="btn sm" data-page="1"${st.offset + 50 < res.total ? '' : ' disabled'}>Next</button></span></div>`;
        } catch (err) { table.innerHTML = failed(err); }
    };
    body.addEventListener('input', debounce(e => { if (e.target.dataset.f === 'q') { st.q = e.target.value.trim(); st.offset = 0; load(); } }, 300));
    body.addEventListener('change', e => { const f = e.target.dataset.f; if (f && f !== 'q') { st[f] = e.target.value; st.offset = 0; load(); } });
    body.addEventListener('click', e => {
        const p = e.target.closest('[data-page]');
        if (p) { st.offset = Math.max(0, st.offset + Number(p.dataset.page) * 50); load(); return; }
        const d = e.target.closest('[data-detail]');
        if (d) { const row = body.querySelector(`[data-detail-row="${CSS.escape(d.dataset.detail)}"]`); row.hidden = !row.hidden; d.setAttribute('aria-expanded', String(!row.hidden)); return; }
        if (e.target.closest('[data-act="retry"]')) load();
    });
    load();
}

const SEV_ICON = { critical: 'alert', high: 'alert', warning: 'bell', info: 'bell' };
export function alertLink(a) {
    const [kind, id] = String(a.ref || '').split(':');
    return kind === 'report' ? `#/moderation/reports?id=${id}` : kind === 'ticket' ? `#/support/t/${id}` : kind === 'user' ? `#/user/${id}` : kind === 'reward' ? '#/rewards/pending' : '';
}
async function alerts(body, app) {
    if (!api.caps.full) { body.innerHTML = needsUpgrade('Admin notifications'); return; }
    const load = async () => {
        body.innerHTML = `<div class="filters"><span class="muted">Critical and high alerts come from severe reports, many reports against one account, escalated or urgent tickets, appeals and large rewards.</span>
            <span class="ph-actions" style="margin-left:auto"><button class="btn sm" data-read-all>${ic('check')}Mark all read</button></span></div><section class="panel" data-list>${loadingRows(5)}</section>`;
        try {
            const rows = await api.alerts();
            body.querySelector('[data-list]').innerHTML = rows.length ? rows.map(a => `
                <div class="alert-i${a.read_at ? '' : ' unread'}"><span class="badge sev-${a.severity}">${esc(a.severity)}</span>
                    <strong>${alertLink(a) ? `<a href="${alertLink(a)}">${esc(a.title)}</a>` : esc(a.title)}</strong>
                    <p>${esc(a.body || '')} · ${timeTag(a.created_at)}</p></div>`).join('') : empty('No notifications', 'You’ll be told here about anything that needs you.');
        } catch (err) { body.querySelector('[data-list]').innerHTML = failed(err, ''); }
    };
    body.addEventListener('click', async e => {
        if (e.target.closest('[data-read-all]')) { await api.alertsRead(null); load(); app.refreshCounts(); }
    });
    load();
}

async function admins(body, app) {
    const load = async () => {
        body.innerHTML = `<div class="grid g-main-side"><section class="panel"><header class="panel-h"><h2>Admins</h2>
            ${can('admins.manage') && api.caps.full ? `<button class="btn sm ph-actions" data-add>${ic('user')}Add admin</button>` : ''}</header><div data-list>${loadingRows(3)}</div></section>
            <section class="panel"><header class="panel-h"><h2>Platform</h2></header><div class="panel-b" style="display:grid;gap:10px">
                <button class="btn" data-announce>${ic('megaphone')}Send announcement</button>
                <p class="muted" style="margin:0;font-size:.82rem">Roles: ${Object.values(ROLES).map(esc).join(' · ')}.</p>
                <p class="muted" style="margin:0;font-size:.82rem">Every action is checked on the server against the admin’s role and recorded in the audit log. At most 90 actions a minute per admin.</p>
                ${api.caps.full ? '' : needsUpgrade('Roles and permissions')}</div></section></div>`;
        const list = body.querySelector('[data-list]');
        try {
            const rows = await api.admins();
            list.innerHTML = `<ul class="rows">${rows.map(a => `<li>${who(a)}<span class="grow"></span><span class="role">${esc(String(a.role).replace('_', ' '))}</span>
                ${can('admins.manage') && api.caps.full && a.id !== app.me.id ? `<select class="input" data-role="${esc(a.id)}" aria-label="Role for ${esc(a.display_name)}" style="width:auto">${Object.keys(ROLES).map(r => `<option value="${r}"${r === a.role ? ' selected' : ''}>${esc(r.replace('_', ' '))}</option>`).join('')}<option value="">Remove admin</option></select>` : ''}</li>`).join('')}</ul>`;
        } catch (err) { list.innerHTML = failed(err, ''); }
    };
    body.addEventListener('click', async e => {
        if (e.target.closest('[data-announce]')) { act.announcement(); return; }
        if (e.target.closest('[data-add]')) {
            let found = null;
            const done = await modal({
                title: 'Add an admin', icon: 'shield', confirm: 'Add admin', text: 'Give someone access to the Command Center with a role that fits what they do.',
                body: `<label class="field"><span>Their @username</span><input class="input" name="u" placeholder="username" autocomplete="off"></label>
                       <label class="field"><span>Role</span><select class="input" name="role">${Object.entries(ROLES).filter(([r]) => r !== 'super_admin').map(([r, l]) => `<option value="${r}">${esc(l)}</option>`).join('')}<option value="super_admin">${esc(ROLES.super_admin)}</option></select></label>`,
                async onSubmit(f) {
                    const q = f.elements.u.value.trim().replace(/^@/, '');
                    const { data } = await api.client.from('diary_profiles').select('id, display_name').eq('username', q).maybeSingle();
                    if (!data) throw new Error('No one has that username');
                    found = data;
                    await api.setAdmin(data.id, f.elements.role.value);
                }
            });
            if (done) { toast(`${found.display_name} is now an admin`); load(); }
        }
    });
    body.addEventListener('change', async e => {
        const s = e.target.closest('[data-role]');
        if (!s) return;
        const role = s.value || null;
        const ok = await modal({ title: role ? 'Change role' : 'Remove admin', icon: 'shield', tone: role ? '' : 'bad', confirmTone: role ? 'primary' : 'danger',
            confirm: role ? 'Change role' : 'Remove admin', text: role ? `They’ll have the ${esc(role.replace('_', ' '))} permissions from now on.` : 'They lose access to the Command Center.',
            onSubmit: () => api.setAdmin(s.dataset.role, role) });
        if (ok) toast('Updated');
        load();
    });
    load();
}
