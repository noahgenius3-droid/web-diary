// Rewards: send one, the transaction ledger (search, type, status and date filters), and large rewards waiting
// for review. Every transaction has an ID, the admin who sent it, the reason and its status.
import * as api from '../api.js';
import { esc, num, ic, loadingRows, failed, empty, timeTag, dateTime, shortId, avatar, toast, needsUpgrade, debounce, modal } from '../ui.js';
import { REWARD, stBadge, can } from '../model.js';
import * as act from '../actions.js';

const TABS = [['send', 'Send reward'], ['transactions', 'Transactions'], ['pending', 'Awaiting review']];

export async function view(el, params, app) {
    const sub = TABS.some(t => t[0] === params.sub) ? params.sub : 'transactions';
    el.innerHTML = `
        <header class="ph"><div><h1>Rewards</h1><p>XP, coins, badges and recognition — every one recorded.</p></div>
            <div class="ph-actions">${can('rewards.send') ? `<button class="btn primary" data-act="send">${ic('gift')}Send reward</button>` : ''}</div></header>
        <div class="tabs" role="tablist" style="padding:0;margin-bottom:14px">${TABS.map(([k, l]) => `<a role="tab" aria-selected="${k === sub}" href="#/rewards/${k}" class="btn ghost" style="border-radius:0;${k === sub ? 'box-shadow:inset 0 -2px 0 var(--accent);color:var(--text)' : 'color:var(--text-2)'}">${l}</a>`).join('')}</div>
        <div data-body></div>`;
    const body = el.querySelector('[data-body]');
    el.querySelector('[data-act="send"]')?.addEventListener('click', async () => { if (await act.reward()) view(el, params, app); });
    if (sub === 'send') {
        body.innerHTML = `<section class="panel"><div class="panel-b" style="display:grid;gap:12px;max-width:640px">
            <p style="margin:0">Choose who, what and why. Large rewards (over ${num(REWARD.xp.large)} XP or ${num(REWARD.coins.large)} coins) need typed confirmation${can('rewards.review') ? '' : ' and a super admin’s approval'}.</p>
            <ul style="margin:0;padding-left:18px;color:var(--text-2)">${Object.values(REWARD).map(r => `<li><b>${esc(r.label)}</b> — ${esc(r.about)}</li>`).join('')}</ul>
            <div><button class="btn primary" data-go>${ic('gift')}Choose a recipient</button></div>
            ${!api.caps.full ? '<p class="muted" style="margin:0">Right now only badges can be sent — XP, coins and special rewards switch on with the Command Center database update.</p>' : ''}</div></section>`;
        body.querySelector('[data-go]').addEventListener('click', () => act.reward());
        return;
    }
    if (!api.caps.full) { body.innerHTML = needsUpgrade(sub === 'pending' ? 'Reward review' : 'The reward ledger'); return; }
    const st = { q: '', kind: '', status: sub === 'pending' ? 'pending_review' : '', from: '', to: '', offset: 0 };
    body.innerHTML = `
        ${sub === 'transactions' ? `<div class="filters">
            <input class="input grow" type="search" data-f="q" placeholder="Search person, reason or transaction ID" aria-label="Search rewards">
            <select class="input" data-f="kind" aria-label="Type"><option value="">All types</option>${Object.entries(REWARD).map(([k, r]) => `<option value="${k}">${esc(r.label)}</option>`).join('')}</select>
            <select class="input" data-f="status" aria-label="Status"><option value="">Any status</option><option value="delivered">Delivered</option><option value="pending_review">Awaiting review</option><option value="declined">Declined</option><option value="reversed">Reversed</option></select>
            <label class="muted" style="font-size:.8rem">From <input class="input" type="date" data-f="from" style="min-width:0"></label>
            <label class="muted" style="font-size:.8rem">To <input class="input" type="date" data-f="to" style="min-width:0"></label>
        </div>` : ''}
        <div data-table>${loadingRows(6)}</div>`;
    const table = body.querySelector('[data-table]');
    const load = async () => {
        table.innerHTML = loadingRows(6);
        try {
            const res = await api.rewards({ q: st.q, kind: st.kind || null, status: st.status || null, from: st.from ? new Date(st.from).toISOString() : null,
                to: st.to ? new Date(new Date(st.to).getTime() + 864e5).toISOString() : null, limit: 50, offset: st.offset });
            if (!res.rows.length) { table.innerHTML = empty(sub === 'pending' ? 'Nothing awaiting review' : 'No rewards match', sub === 'pending' ? 'Large rewards from non–super admins wait here.' : ''); return; }
            table.innerHTML = `<div class="table-wrap"><table class="t"><thead><tr><th>Transaction</th><th>User</th><th>Reward</th><th>Reason</th><th class="hide-sm">Sent by</th><th>Status</th><th>Date</th><th><span class="sr">Actions</span></th></tr></thead>
                <tbody>${res.rows.map(w => `<tr>
                    <td class="mono">RW-${esc(shortId(w.id))}</td>
                    <td><a class="who" href="#/user/${esc(w.user_id)}" style="color:inherit;text-decoration:none">${avatar(w, 'sm')}<span><strong>${esc(w.display_name)}</strong><small>@${esc(w.username)}</small></span></a></td>
                    <td><b>${w.kind === 'badge' ? `Badge: ${esc(w.badge)}` : w.kind === 'special' ? 'Special recognition' : `${num(w.amount)} ${esc(REWARD[w.kind].unit)}`}</b></td>
                    <td class="clip" title="${esc(w.reason)}${w.message ? ` — “${esc(w.message)}”` : ''}">${esc(w.reason)}</td>
                    <td class="hide-sm">${esc(w.admin_name || '—')}</td><td>${stBadge(w.status)}</td><td>${timeTag(w.created_at)}</td>
                    <td class="n">${w.status === 'pending_review' && can('rewards.review') ? `<button class="btn sm primary" data-rw="approve" data-id="${esc(w.id)}">Approve</button> <button class="btn sm" data-rw="decline" data-id="${esc(w.id)}">Decline</button>`
                        : w.status === 'delivered' && can('rewards.review') ? `<button class="btn sm ghost" data-rw="reverse" data-id="${esc(w.id)}">Reverse</button>` : ''}</td></tr>`).join('')}</tbody></table></div>
                <div class="pager"><span>${num(st.offset + 1)}–${num(st.offset + res.rows.length)} of ${num(res.total)}</span>
                    <span class="ph-actions"><button class="btn sm" data-page="-1"${st.offset ? '' : ' disabled'}>Previous</button><button class="btn sm" data-page="1"${st.offset + 50 < res.total ? '' : ' disabled'}>Next</button></span></div>`;
        } catch (err) { table.innerHTML = failed(err); }
    };
    body.addEventListener('input', debounce(e => { const f = e.target.dataset.f; if (f === 'q') { st.q = e.target.value.trim(); st.offset = 0; load(); } }, 300));
    body.addEventListener('change', e => { const f = e.target.dataset.f; if (f && f !== 'q') { st[f] = e.target.value; st.offset = 0; load(); } });
    body.addEventListener('click', async e => {
        const p = e.target.closest('[data-page]');
        if (p) { st.offset = Math.max(0, st.offset + Number(p.dataset.page) * 50); load(); return; }
        if (e.target.closest('[data-act="retry"]')) { load(); return; }
        const b = e.target.closest('[data-rw]');
        if (!b) return;
        const what = b.dataset.rw;
        const done = await modal({
            title: what === 'approve' ? 'Approve this reward' : what === 'decline' ? 'Decline this reward' : 'Reverse this reward', icon: 'gift',
            tone: what === 'approve' ? '' : 'bad', confirmTone: what === 'approve' ? 'primary' : 'danger', confirm: what[0].toUpperCase() + what.slice(1),
            text: what === 'reverse' ? 'The XP or coins no longer count, and a badge is taken back.' : what === 'approve' ? 'It’s delivered straight away and they’re notified.' : 'It won’t be delivered.',
            body: '<label class="field"><span>Note</span><input class="input" name="note" maxlength="300"></label>',
            async onSubmit(f) {
                const note = f.elements.note.value.trim();
                if (what === 'reverse') { if (note.length < 3) throw new Error('Give a reason'); await api.reverseReward(b.dataset.id, note); }
                else await api.reviewReward(b.dataset.id, what === 'approve', note);
            }
        });
        if (done) { toast('Done'); load(); app.refreshCounts(); }
    });
    load();
}
