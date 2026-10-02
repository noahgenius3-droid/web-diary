// All users: a dense, sortable, server-paginated table with status tabs, search (name, @username, email, phone,
// user ID), column choice and bulk actions.
import * as api from '../api.js';
import { esc, num, ic, loadingRows, failed, empty, ago, date, avatar, tick, debounce, $$ } from '../ui.js';
import { STATUS, statusBadge, can } from '../model.js';
import * as act from '../actions.js';

const PAGE = 50;
const COLS = [['email', 'Email'], ['streak', 'Streak'], ['xp', 'XP'], ['coins', 'Coins'], ['posts', 'Posts'], ['reports', 'Reports'], ['joined', 'Joined'], ['active', 'Last active']];
let hidden = new Set(['coins']);
try { hidden = new Set(JSON.parse(localStorage.getItem('cc-hidden-cols') || '["coins"]')); } catch (e) { /* defaults */ }

export async function view(el, params, app) {
    const st = { status: params.sub || 'all', q: params.query.q || '', sort: 'joined', desc: true, offset: 0, sel: new Map(), rows: [] };
    el.innerHTML = `
        <header class="ph"><div><h1>Users</h1><p>Find anyone on Cordial and act on their account.</p></div>
            <div class="ph-actions">${can('rewards.send') ? `<button class="btn" data-act="reward">${ic('gift')}Send reward</button>` : ''}</div></header>
        <div class="tabs" role="tablist" aria-label="Account status" data-tabs style="margin-bottom:12px;padding:0"></div>
        <div class="filters">
            <label class="grow"><span class="sr">Search users</span><input class="input" type="search" data-q placeholder="Search name, @username, email, phone or user ID" value="${esc(st.q)}" style="width:100%"></label>
            <details class="cols"><summary class="btn">${ic('columns')}Columns</summary>
                <div class="pop" style="width:220px;padding:10px;display:grid;gap:6px">${COLS.map(([k, l]) => `<label style="display:flex;gap:8px"><input type="checkbox" data-col="${k}"${hidden.has(k) ? '' : ' checked'}>${l}</label>`).join('')}</div></details>
        </div>
        <div data-table>${loadingRows(8)}</div>
        <div data-bulk></div>`;
    const tabs = el.querySelector('[data-tabs]');
    const table = el.querySelector('[data-table]');

    const paintTabs = counts => {
        const total = counts ? Object.values(counts).reduce((a, b) => a + b, 0) : null;
        tabs.innerHTML = [['all', 'All users', total], ...Object.entries(STATUS).map(([k, s]) => [k, s.label, counts ? counts[k] || 0 : null])].map(([k, l, n]) =>
            `<button role="tab" aria-selected="${st.status === k}" data-tab="${k}">${esc(l)}${n !== null ? ` <span class="muted">${num(n)}</span>` : ''}</button>`).join('');
    };
    const th = (key, label, cls = '') => {
        const sortable = ['joined', 'name', 'active'].includes(key);
        if (!sortable) return `<th class="${cls}">${label}</th>`;
        const on = st.sort === key;
        return `<th class="${cls}"><button data-sort="${key}"${on ? ` aria-sort="${st.desc ? 'descending' : 'ascending'}"` : ''}>${label}${on ? (st.desc ? ' ↓' : ' ↑') : ''}</button></th>`;
    };
    const show = k => !hidden.has(k);
    const load = async () => {
        table.innerHTML = loadingRows(8);
        try {
            const res = await api.users({ status: st.status, q: st.q, sort: st.sort, desc: st.desc, limit: PAGE, offset: st.offset });
            st.rows = res.rows;
            paintTabs(res.counts);
            if (!res.rows.length) {
                table.innerHTML = empty(st.q ? 'No users match' : `No ${st.status === 'all' ? '' : STATUS[st.status].label.toLowerCase()} users`,
                    st.q ? 'Try part of their name, their @username, email or the start of their user ID.' : 'Nobody is in this state right now.');
                return paintBulk();
            }
            const bulkOK = can('users.suspend') || can('users.block');
            table.innerHTML = `
                <div class="table-wrap"><table class="t">
                    <thead><tr>${bulkOK ? `<th class="chk"><input type="checkbox" data-all aria-label="Select all on this page"></th>` : ''}${th('name', 'User')}<th>Status</th>
                        ${show('email') ? '<th class="hide-sm">Email</th>' : ''}${show('streak') ? '<th class="n">Streak</th>' : ''}${show('xp') ? '<th class="n">XP</th>' : ''}
                        ${show('coins') ? '<th class="n">Coins</th>' : ''}${show('posts') ? '<th class="n">Posts</th>' : ''}${show('reports') ? '<th class="n">Reports</th>' : ''}
                        ${show('active') ? th('active', 'Last active') : ''}${show('joined') ? th('joined', 'Joined') : ''}<th><span class="sr">Actions</span></th></tr></thead>
                    <tbody>${res.rows.map(u => `
                        <tr data-href="#/user/${esc(u.id)}" class="${st.sel.has(u.id) ? 'sel' : ''}">
                            ${bulkOK ? `<td class="chk"><input type="checkbox" data-sel="${esc(u.id)}"${st.sel.has(u.id) ? ' checked' : ''} aria-label="Select ${esc(u.display_name)}"></td>` : ''}
                            <td><a class="who" href="#/user/${esc(u.id)}" style="color:inherit;text-decoration:none">${avatar(u)}<span><strong>${esc(u.display_name)}${tick(u.verified)}</strong><small>@${esc(u.username)}</small></span></a></td>
                            <td>${statusBadge(u.status)}${u.ends_at && u.status !== 'active' ? `<div class="muted" style="font-size:.74rem">ends ${esc(date(u.ends_at))}</div>` : ''}</td>
                            ${show('email') ? `<td class="hide-sm clip">${u.email ? esc(u.email) : '<span class="muted">—</span>'}</td>` : ''}
                            ${show('streak') ? `<td class="n">${u.streak == null ? '<span class="muted">—</span>' : num(u.streak)}</td>` : ''}
                            ${show('xp') ? `<td class="n">${num(u.xp)}</td>` : ''}${show('coins') ? `<td class="n">${num(u.coins)}</td>` : ''}
                            ${show('posts') ? `<td class="n">${num(u.posts)}</td>` : ''}${show('reports') ? `<td class="n">${u.reports ? `<b style="color:var(--bad)">${num(u.reports)}</b>` : '0'}</td>` : ''}
                            ${show('active') ? `<td>${u.last_seen_at ? esc(ago(u.last_seen_at)) : '<span class="muted">—</span>'}</td>` : ''}
                            ${show('joined') ? `<td>${esc(date(u.created_at))}</td>` : ''}
                            <td class="n"><a class="btn sm" href="#/user/${esc(u.id)}">Open${ic('chevR')}</a></td>
                        </tr>`).join('')}</tbody></table></div>
                <div class="pager"><span>${num(st.offset + 1)}–${num(st.offset + res.rows.length)} of ${num(res.total)}</span>
                    <span class="ph-actions"><button class="btn sm" data-page="-1"${st.offset ? '' : ' disabled'}>${ic('chevL')}Previous</button>
                    <button class="btn sm" data-page="1"${st.offset + PAGE < res.total ? '' : ' disabled'}>Next${ic('chevR')}</button></span></div>`;
            paintBulk();
        } catch (err) { table.innerHTML = failed(err); }
    };
    const paintBulk = () => {
        const box = el.querySelector('[data-bulk]');
        const n = st.sel.size;
        box.innerHTML = n ? `<div class="bulk" role="region" aria-label="Bulk actions"><strong>${n} selected</strong>
            ${can('users.suspend') ? `<button class="btn sm" data-bulk-do="suspended">${ic('pause')}Suspend</button>` : ''}
            ${can('users.block') && api.caps.full ? `<button class="btn sm" data-bulk-do="blocked">${ic('ban')}Block</button>` : ''}
            ${can('users.reactivate') ? `<button class="btn sm" data-bulk-do="active">${ic('undo')}Restore</button>` : ''}
            <button class="btn sm" data-bulk-do="export">${ic('download')}Export CSV</button>
            <button class="btn sm ghost" data-bulk-do="clear" style="color:inherit">Clear</button></div>` : '';
    };

    el.addEventListener('input', debounce(e => { if (e.target.matches('[data-q]')) { st.q = e.target.value.trim(); st.offset = 0; load(); } }, 300));
    el.addEventListener('change', e => {
        const c = e.target.closest('[data-col]');
        if (c) { c.checked ? hidden.delete(c.dataset.col) : hidden.add(c.dataset.col); try { localStorage.setItem('cc-hidden-cols', JSON.stringify([...hidden])); } catch (err) { /* this session only */ } load(); return; }
        const s = e.target.closest('[data-sel]');
        if (s) { const u = st.rows.find(r => r.id === s.dataset.sel); s.checked ? st.sel.set(u.id, u) : st.sel.delete(u.id); s.closest('tr').classList.toggle('sel', s.checked); paintBulk(); return; }
        if (e.target.matches('[data-all]')) { st.rows.forEach(u => (e.target.checked ? st.sel.set(u.id, u) : st.sel.delete(u.id))); $$('[data-sel]', el).forEach(b => { b.checked = e.target.checked; b.closest('tr').classList.toggle('sel', b.checked); }); paintBulk(); }
    });
    el.addEventListener('click', async e => {
        const tab = e.target.closest('[data-tab]');
        if (tab) { st.status = tab.dataset.tab; st.offset = 0; app.replace(`#/users${st.status === 'all' ? '' : `/${st.status}`}`); load(); return; }
        const s = e.target.closest('[data-sort]');
        if (s) { if (st.sort === s.dataset.sort) st.desc = !st.desc; else { st.sort = s.dataset.sort; st.desc = true; } load(); return; }
        const p = e.target.closest('[data-page]');
        if (p) { st.offset = Math.max(0, st.offset + Number(p.dataset.page) * PAGE); load(); return; }
        if (e.target.closest('[data-act="reward"]')) { act.reward(); return; }
        if (e.target.closest('[data-act="retry"]')) { load(); return; }
        const b = e.target.closest('[data-bulk-do]');
        if (b) {
            const list = [...st.sel.values()];
            if (b.dataset.bulkDo === 'clear') { st.sel.clear(); load(); return; }
            if (b.dataset.bulkDo === 'export') return exportCsv(list);
            if (await act.bulk(list, b.dataset.bulkDo)) { st.sel.clear(); load(); }
            return;
        }
        // A click anywhere on a row opens the person (but not on its controls)
        const tr = e.target.closest('tr[data-href]');
        if (tr && !e.target.closest('a, button, input, label')) app.go(tr.dataset.href);
    });
    load();
}

function exportCsv(list) {
    const cols = ['id', 'username', 'display_name', 'email', 'status', 'xp', 'coins', 'streak', 'posts', 'reports', 'created_at', 'last_seen_at'];
    const cell = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const csv = [cols.join(','), ...list.map(u => cols.map(c => cell(u[c])).join(','))].join('\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    a.download = `cordial-users-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
