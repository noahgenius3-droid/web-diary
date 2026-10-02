// Helpline: an inbox of tickets, the conversation, and the person's context beside it (account state, recent
// activity, earlier requests) — reply, add an internal note, resolve, escalate, assign, or act on the account
// without leaving the ticket.
import * as api from '../api.js';
import { esc, num, ic, loadingRows, failed, empty, timeTag, dateTime, ago, avatar, toast, needsUpgrade, debounce, who } from '../ui.js';
import { TICKET_CAT, TICKET_STATUS, PRIORITY, prioBadge, stBadge, statusBadge, can, actionLabel } from '../model.js';
import * as act from '../actions.js';

const VIEWS = [['open', 'Open'], ['priority', 'Priority'], ['mine', 'Assigned to me'], ['resolved', 'Resolved'], ['all', 'All']];

export async function view(el, params, app) {
    el.innerHTML = `<header class="ph"><div><h1>Support</h1><p>Requests from Cordial members — account recovery, rewards, safety, bugs and complaints.</p></div></header><div data-body></div>`;
    const body = el.querySelector('[data-body]');
    if (!api.caps.full) { body.innerHTML = needsUpgrade('The helpline'); return; }
    if (!can('support.manage')) { body.innerHTML = empty('Support is handled by the support team', 'Ask a super admin for the support role.'); return; }
    const st = { view: VIEWS.some(v => v[0] === params.sub) ? params.sub : 'open', q: '', current: params.sub === 't' ? params.id : null, cat: '' };
    body.innerHTML = `
        <div class="filters">
            <div class="seg" role="radiogroup" aria-label="Which tickets">${VIEWS.map(([k, l]) => `<button role="radio" aria-checked="${st.view === k}" data-v="${k}">${l}</button>`).join('')}</div>
            <select class="input" data-cat aria-label="Category"><option value="">All categories</option>${Object.entries(TICKET_CAT).map(([k, l]) => `<option value="${k}">${l}</option>`).join('')}</select>
            <input class="input grow" type="search" data-q placeholder="Search subject, person or #number" aria-label="Search tickets">
        </div>
        <div class="inbox">
            <div class="inbox-list" data-list role="list" aria-label="Tickets">${loadingRows(6)}</div>
            <section class="thread" data-thread aria-label="Conversation">${empty('Choose a request', 'Pick a ticket on the left to read and reply.')}</section>
            <aside class="ctx" data-ctx aria-label="About this person"></aside>
        </div>`;
    const listEl = body.querySelector('[data-list]');
    const threadEl = body.querySelector('[data-thread]');
    const ctxEl = body.querySelector('[data-ctx]');
    let rows = [];

    const loadList = async () => {
        try {
            const res = await api.tickets({ view: st.cat || st.view, q: st.q, limit: 100 });
            rows = res.rows;
            listEl.innerHTML = rows.length ? rows.map(t => `
                <button class="tk" role="listitem" data-t="${esc(t.id)}" aria-current="${t.id === st.current}">
                    <span class="tk-top">${t.last_from_staff ? '' : '<span class="dot" title="Waiting for a reply"></span>'}<strong>${esc(t.subject)}</strong>${prioBadge(t.priority)}</span>
                    <p>${esc(t.last_message || '')}</p>
                    <span class="tk-meta">${avatar({ display_name: t.display_name, avatar_path: t.avatar_path }, 'sm')}${esc(t.display_name)} · #${t.ref} · ${esc(TICKET_CAT[t.category])} · ${esc(ago(t.updated_at))}</span>
                </button>`).join('') : empty(st.view === 'open' ? 'No open requests' : 'Nothing here', st.view === 'open' ? 'You’re all caught up.' : '');
            if (!st.current && rows[0] && matchMedia('(min-width: 761px)').matches) open(rows[0].id);
        } catch (err) { listEl.innerHTML = failed(err); }
    };
    const open = async id => {
        st.current = id;
        app.replace(`#/support/t/${id}`);
        listEl.querySelectorAll('[data-t]').forEach(b => b.setAttribute('aria-current', String(b.dataset.t === id)));
        threadEl.innerHTML = loadingRows(6);
        ctxEl.innerHTML = '';
        try {
            const d = await api.ticket(id);
            const t = d.ticket;
            const u = await api.user(t.user_id).catch(() => null);
            threadEl.innerHTML = `
                <header class="thread-h">
                    <h2>#${t.ref} ${esc(t.subject)}</h2>
                    ${prioBadge(t.priority)} ${stBadge(t.status, TICKET_STATUS)} <span class="muted">${esc(TICKET_CAT[t.category])} · opened ${esc(dateTime(t.created_at))}${t.assigned_name ? ` · assigned to ${esc(t.assigned_name)}` : ''}</span>
                    <span class="ph-actions">
                        <select class="input" data-prio aria-label="Priority" style="min-height:30px">${PRIORITY.map(p => `<option value="${p}"${p === t.priority ? ' selected' : ''}>${p[0].toUpperCase() + p.slice(1)} priority</option>`).join('')}</select>
                        ${t.assigned_to !== app.me.id ? '<button class="btn sm" data-tk="assign">Assign to me</button>' : ''}
                        ${t.status !== 'escalated' && t.status !== 'resolved' ? '<button class="btn sm" data-tk="escalate">Escalate</button>' : ''}
                        ${t.status === 'resolved' ? '<button class="btn sm" data-tk="reopen">Reopen</button>' : '<button class="btn sm primary" data-tk="resolve">' + ic('check') + 'Resolve</button>'}
                    </span>
                </header>
                <div class="msgs" data-msgs>${d.messages.map(m => `
                    <div class="msg${m.internal ? ' note' : m.from_staff ? ' staff' : ''}">
                        <header>${esc(m.internal ? `Internal note · ${m.author_name || 'admin'}` : m.from_staff ? `${m.author_name || 'Cordial'} (support)` : m.author_name || 'Member')} · ${esc(dateTime(m.created_at))}</header>
                        <p>${esc(m.body)}</p></div>`).join('')}</div>
                <form class="reply" data-reply>
                    <label class="sr" for="reply-body">Reply</label>
                    <textarea class="input" id="reply-body" name="body" rows="3" maxlength="4000" placeholder="Write a reply… (Ctrl+Enter to send)"></textarea>
                    <div class="reply-foot">
                        <label style="display:flex;gap:6px;align-items:center;font-size:.84rem"><input type="checkbox" name="internal"> Internal note (not sent)</label>
                        <span class="ph-actions"><button class="btn primary" type="submit">${ic('send')}Send</button></span>
                    </div>
                </form>`;
            const msgs = threadEl.querySelector('[data-msgs]');
            msgs.scrollTop = msgs.scrollHeight;
            ctxEl.innerHTML = u ? `
                <section><h3>Member</h3>${who(u)}<p style="margin:8px 0 0">${statusBadge(u.status)} <span class="muted">· joined ${esc(ago(u.created_at))}</span></p>
                    ${u.email ? `<p class="muted" style="margin:4px 0 0;font-size:.82rem">${esc(u.email)}</p>` : ''}</section>
                <section><h3>Numbers</h3><dl class="kv" style="grid-template-columns:110px 1fr"><dt>XP</dt><dd>${num(u.xp)}</dd><dt>Coins</dt><dd>${num(u.coins)}</dd>
                    <dt>Posts</dt><dd>${num(u.counts && u.counts.posts)}</dd><dt>Reports</dt><dd>${num(u.counts && u.counts.reports_received)}</dd><dt>Last active</dt><dd>${esc(ago(u.last_seen_at))}</dd></dl></section>
                <section><h3>Act on the account</h3><div class="chips">
                    ${can('rewards.send') ? `<button class="btn sm" data-ctx-do="reward">${ic('gift')}Reward</button>` : ''}
                    ${can('users.suspend') && u.status === 'active' ? `<button class="btn sm" data-ctx-do="suspend">${ic('pause')}Suspend</button>` : ''}
                    ${can('users.block') && u.status !== 'deactivated' ? `<button class="btn sm" data-ctx-do="block">${ic('ban')}Block</button>` : ''}
                    ${can('users.reactivate') && u.status !== 'active' ? `<button class="btn sm" data-ctx-do="reactivate">${ic('undo')}Restore</button>` : ''}
                    <a class="btn sm" href="#/user/${esc(u.id)}">Full profile</a></div></section>
                <section><h3>Earlier requests</h3>${d.previous.length ? `<ul class="rows" style="margin:0 -16px">${d.previous.map(p => `<li><button class="grow btn ghost sm" style="justify-content:flex-start" data-t="${esc(p.id)}">#${p.ref} ${esc(p.subject)}</button>${stBadge(p.status, TICKET_STATUS)}</li>`).join('')}</ul>` : '<p class="muted" style="margin:0">None</p>'}</section>
                <section><h3>Recent account history</h3>${(u.history || []).slice(0, 5).map(h => `<p style="margin:0 0 6px;font-size:.82rem"><b>${esc(actionLabel(h.action))}</b> · ${esc(ago(h.created_at))}</p>`).join('') || '<p class="muted" style="margin:0">No admin actions</p>'}</section>` : '';
            ctxEl.__user = u;
            ctxEl.__ticket = t;
        } catch (err) { threadEl.innerHTML = failed(err, ''); }
    };

    body.addEventListener('click', async e => {
        const v = e.target.closest('[data-v]');
        if (v) { st.view = v.dataset.v; st.cat = ''; body.querySelector('[data-cat]').value = ''; body.querySelectorAll('[data-v]').forEach(b => b.setAttribute('aria-checked', String(b === v))); loadList(); return; }
        const t = e.target.closest('[data-t]');
        if (t) { open(t.dataset.t); return; }
        const tk = e.target.closest('[data-tk]');
        if (tk) {
            const ticket = ctxEl.__ticket;
            const change = { assign: { assign: app.me.id }, escalate: { status: 'escalated', priority: 'urgent' }, resolve: { status: 'resolved' }, reopen: { status: 'open' } }[tk.dataset.tk];
            try { await api.ticketUpdate(ticket.id, change); toast({ assign: 'Assigned to you', escalate: 'Escalated', resolve: 'Resolved', reopen: 'Reopened' }[tk.dataset.tk]); open(ticket.id); loadList(); app.refreshCounts(); }
            catch (err) { toast(act.friendly(err), { error: true }); }
            return;
        }
        const c = e.target.closest('[data-ctx-do]');
        if (c && ctxEl.__user) {
            const fn = { reward: act.reward, suspend: act.suspend, block: act.block, reactivate: act.reactivate }[c.dataset.ctxDo];
            if (await fn(ctxEl.__user)) open(st.current);
        }
    });
    body.addEventListener('change', async e => {
        if (e.target.matches('[data-cat]')) { st.cat = e.target.value; loadList(); return; }
        if (e.target.matches('[data-prio]')) {
            try { await api.ticketUpdate(ctxEl.__ticket.id, { priority: e.target.value }); toast('Priority updated'); loadList(); } catch (err) { toast(act.friendly(err), { error: true }); }
        }
    });
    body.addEventListener('input', debounce(e => { if (e.target.matches('[data-q]')) { st.q = e.target.value.trim(); loadList(); } }, 300));
    body.addEventListener('keydown', e => { if (e.target.id === 'reply-body' && e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); e.target.form.requestSubmit(); } });
    body.addEventListener('submit', async e => {
        if (!e.target.matches('[data-reply]')) return;
        e.preventDefault();
        const f = e.target;
        const text = f.elements.body.value.trim();
        if (!text) return;
        const btn = f.querySelector('[type="submit"]');
        btn.disabled = true;
        try {
            await api.ticketReply(st.current, text, f.elements.internal.checked);
            toast(f.elements.internal.checked ? 'Note added' : 'Reply sent — they’ll get a notification');
            open(st.current); loadList();
        } catch (err) { toast(act.friendly(err), { error: true }); btn.disabled = false; }
    });
    await loadList();
    if (st.current) open(st.current);
}
