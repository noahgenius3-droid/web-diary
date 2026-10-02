// Moderation Center: reports as cases (severity first), content review, appeals and moderation history.
// Each case shows what was reported, by whom, against whom, the account's current state, and the actions that fit.
import * as api from '../api.js';
import { esc, num, ic, loadingRows, failed, empty, timeTag, dateTime, shortId, avatar, modal, toast, needsUpgrade, debounce, who } from '../ui.js';
import { sevBadge, stBadge, REPORT_REASON, REPORT_STATUS, REPORT_KIND, SEVERITY, statusBadge, can, actionLabel, scopeLabel } from '../model.js';
import * as act from '../actions.js';

const TABS = [['reports', 'Reports'], ['review', 'Content review'], ['appeals', 'Appeals'], ['history', 'Moderation history']];
const CONTENT = new Set(['entry', 'post', 'comment', 'gc', 'dm', 'listing']);

export async function view(el, params, app) {
    const sub = TABS.some(t => t[0] === params.sub) ? params.sub : 'reports';
    el.innerHTML = `
        <header class="ph"><div><h1>Moderation</h1><p>Reports, content review, appeals and the record of what was done.</p></div></header>
        <div class="tabs" role="tablist" style="padding:0;margin-bottom:14px">${TABS.map(([k, l]) => `<a role="tab" aria-selected="${k === sub}" href="#/moderation/${k}" class="btn ghost" style="border-radius:0;${k === sub ? 'box-shadow:inset 0 -2px 0 var(--accent);color:var(--text)' : 'color:var(--text-2)'}">${l}</a>`).join('')}</div>
        <div data-body></div>`;
    const body = el.querySelector('[data-body]');
    if (!can('reports.manage')) { body.innerHTML = empty('Moderation is for moderators', 'Ask a super admin for the moderator role.'); return; }
    if (sub === 'appeals') return appeals(body, app);
    if (sub === 'history') return history(body);
    return reports(body, app, sub === 'review', params.query.id);
}

async function reports(body, app, contentOnly, focusId) {
    const st = { status: 'active', severity: '', q: '', offset: 0 };
    body.innerHTML = `
        <div class="filters">
            <div class="seg" role="radiogroup" aria-label="Status">${[['active', 'Needs action'], ['investigating', 'Investigating'], ['actioned', 'Action taken'], ['dismissed', 'Dismissed'], ['all', 'All']]
                .map(([k, l]) => `<button role="radio" aria-checked="${st.status === k}" data-status="${k}">${l}</button>`).join('')}</div>
            <select class="input" data-sev aria-label="Severity"><option value="">Any severity</option>${SEVERITY.map(s => `<option value="${s}">${s[0].toUpperCase() + s.slice(1)}</option>`).join('')}</select>
            <input class="input grow" type="search" data-q placeholder="Search reported person, words in the content, or case ID" aria-label="Search reports">
        </div>
        <section class="panel" data-list>${loadingRows(6)}</section>`;
    const list = body.querySelector('[data-list]');
    const load = async () => {
        list.innerHTML = loadingRows(6);
        try {
            const res = await api.reports({ status: st.status, severity: st.severity || null, q: st.q, limit: 50, offset: st.offset });
            let rows = res.rows;
            if (contentOnly) rows = rows.filter(r => CONTENT.has(r.kind));
            if (focusId) rows = rows.sort((a, b) => (b.id === focusId) - (a.id === focusId));
            list.innerHTML = rows.length ? rows.map(caseHTML).join('') + (res.total > 50 ? `<div class="pager" style="padding:10px 16px"><span>${num(st.offset + 1)}–${num(st.offset + res.rows.length)} of ${num(res.total)}</span><span class="ph-actions"><button class="btn sm" data-page="-1"${st.offset ? '' : ' disabled'}>Previous</button><button class="btn sm" data-page="1"${st.offset + 50 < res.total ? '' : ' disabled'}>Next</button></span></div>` : '')
                : empty(st.status === 'active' ? 'Nothing needs action' : 'No reports here', st.status === 'active' ? 'New reports show up here, most severe first.' : '');
            if (focusId) list.querySelector(`[data-case="${CSS.escape(focusId)}"]`)?.scrollIntoView({ block: 'center' });
        } catch (err) { list.innerHTML = failed(err); }
    };
    const caseHTML = r => {
        const open = ['open', 'investigating', 'appealed'].includes(r.status);
        const target = r.target_user ? { id: r.target_user, display_name: r.target_name || 'Unknown', username: r.target_username, avatar_path: r.target_avatar } : null;
        return `
        <article class="case" data-case="${esc(r.id)}" ${r.id === focusId ? 'style="background:var(--accent-soft)"' : ''}>
            <div>
                <div class="case-h">${sevBadge(r.severity)} ${stBadge(r.status, REPORT_STATUS)} <strong>${esc(REPORT_REASON[r.reason] || r.reason)}</strong>
                    <span class="muted">· ${esc(REPORT_KIND[r.kind] || r.kind)}</span> <span class="mono">#${esc(shortId(r.id))}</span></div>
                ${r.snapshot || r.details ? `<blockquote>${esc(r.snapshot || '')}${r.snapshot && r.details ? '\n\n' : ''}${r.details ? `Reporter’s note: ${esc(r.details)}` : ''}</blockquote>` : ''}
                <div class="meta">
                    <span>Reported: ${target ? `<a href="#/user/${esc(target.id)}">${esc(target.display_name)}</a> ${r.target_status ? statusBadge(r.target_status) : ''}` : 'content only'}</span>
                    <span>By: ${r.reporter ? `<a href="#/user/${esc(r.reporter)}">${esc(r.reporter_name || 'someone')}</a>` : '—'}</span>
                    <span>${timeTag(r.created_at)}</span>
                    ${r.assigned_name ? `<span>Assigned: ${esc(r.assigned_name)}</span>` : ''}
                    ${r.handled_name ? `<span>Handled by ${esc(r.handled_name)} · ${esc(dateTime(r.handled_at))}</span>` : ''}
                    ${r.resolution ? `<span>Resolution: ${esc(r.resolution)}</span>` : ''}
                </div>
            </div>
            <div class="case-act">${open ? `
                ${api.caps.full && r.status === 'open' ? `<button class="btn sm" data-r="investigate">${ic('search')}Investigate</button>` : ''}
                ${CONTENT.has(r.kind) && r.target_id ? `<button class="btn sm" data-r="remove">${ic('x')}Remove content</button>` : ''}
                ${target && can('users.suspend') ? `<button class="btn sm" data-r="suspend">${ic('pause')}Suspend user</button>` : ''}
                ${target && can('users.block') && api.caps.full ? `<button class="btn sm" data-r="block">${ic('ban')}Block user</button>` : ''}
                <button class="btn sm" data-r="warn">${ic('check')}Action taken</button>
                <button class="btn sm ghost" data-r="dismiss">Dismiss</button>
                ${api.caps.full ? `<select class="input" data-r-sev aria-label="Change severity" style="min-height:28px;font-size:.8rem">${SEVERITY.map(s => `<option${s === r.severity ? ' selected' : ''}>${s}</option>`).join('')}</select>` : ''}`
                : target ? `<a class="btn sm" href="#/user/${esc(target.id)}">Open user</a>` : ''}
            </div>
        </article>`;
    };
    const note = (title, label, confirm, tone = 'primary') => new Promise(resolve => {
        let val = null;
        modal({ title, icon: 'flag', confirm, confirmTone: tone, body: `<label class="field"><span>${label}</span><textarea class="input" name="note" rows="3" maxlength="300" required></textarea></label>`,
            onSubmit(f) { const v = f.elements.note.value.trim(); if (v.length < 3) throw new Error('Add a short note (it goes in the audit log)'); val = v; } })
            .then(done => resolve(done ? val : null));
    });
    body.addEventListener('click', async e => {
        const s = e.target.closest('[data-status]');
        if (s) { st.status = s.dataset.status; st.offset = 0; body.querySelectorAll('[data-status]').forEach(b => b.setAttribute('aria-checked', String(b === s))); load(); return; }
        const p = e.target.closest('[data-page]');
        if (p) { st.offset = Math.max(0, st.offset + Number(p.dataset.page) * 50); load(); return; }
        if (e.target.closest('[data-act="retry"]')) { load(); return; }
        const b = e.target.closest('[data-r]');
        if (!b) return;
        const id = b.closest('[data-case]').dataset.case;
        const res = await api.reports({ status: 'all', limit: 200 }).catch(() => ({ rows: [] }));
        const r = res.rows.find(x => x.id === id);
        if (!r) return;
        const target = r.target_user ? { id: r.target_user, display_name: r.target_name, username: r.target_username } : null;
        try {
            if (b.dataset.r === 'investigate') { await api.updateReport(id, { status: 'investigating', assign: app.me.id }); toast('Marked as investigating — assigned to you'); }
            else if (b.dataset.r === 'remove') {
                const n = await note('Remove the reported content', 'Why it’s being removed', 'Remove content', 'danger');
                if (!n) return;
                await api.resolveReport(id, 'remove', n); toast('Content removed and the report closed');
            } else if (b.dataset.r === 'suspend' || b.dataset.r === 'block') {
                const u = await api.user(target.id);
                const ok = await (b.dataset.r === 'suspend' ? act.suspend(u) : act.block(u));
                if (!ok) return;
                await api.resolveReport(id, 'warn', b.dataset.r === 'suspend' ? 'Account suspended' : 'Account blocked');
            } else if (b.dataset.r === 'warn') {
                const n = await note('Close as action taken', 'What was done', 'Close report');
                if (!n) return;
                await api.resolveReport(id, 'warn', n); toast('Report closed — action taken');
            } else if (b.dataset.r === 'dismiss') {
                const n = await note('Dismiss this report', 'Why it doesn’t break the rules', 'Dismiss', 'primary');
                if (!n) return;
                await api.resolveReport(id, 'dismiss', n); toast('Report dismissed');
            }
            load(); app.refreshCounts();
        } catch (err) { toast(act.friendly(err), { error: true }); }
    });
    body.addEventListener('change', async e => {
        if (e.target.matches('[data-sev]')) { st.severity = e.target.value; st.offset = 0; load(); return; }
        if (e.target.matches('[data-r-sev]')) {
            const id = e.target.closest('[data-case]').dataset.case;
            try { await api.updateReport(id, { severity: e.target.value }); toast('Severity updated'); load(); } catch (err) { toast(act.friendly(err), { error: true }); }
        }
    });
    body.addEventListener('input', debounce(e => { if (e.target.matches('[data-q]')) { st.q = e.target.value.trim(); st.offset = 0; load(); } }, 300));
    load();
}

async function appeals(body, app) {
    if (!api.caps.full) { body.innerHTML = needsUpgrade('Appeals'); return; }
    let status = 'open';
    const load = async () => {
        body.innerHTML = `<div class="filters"><div class="seg" role="radiogroup">${[['open', 'Open'], ['overturned', 'Overturned'], ['upheld', 'Upheld'], ['all', 'All']]
            .map(([k, l]) => `<button role="radio" aria-checked="${status === k}" data-ap-status="${k}">${l}</button>`).join('')}</div></div><section class="panel" data-list>${loadingRows(4)}</section>`;
        const list = body.querySelector('[data-list]');
        try {
            const rows = await api.appeals(status);
            list.innerHTML = rows.length ? rows.map(a => `
                <article class="case" data-appeal="${esc(a.id)}">
                    <div>
                        <div class="case-h">${stBadge(a.status)} ${who({ id: a.user_id, display_name: a.display_name, username: a.username, avatar_path: a.avatar_path })} <span class="muted">appeals a ${esc(a.against)}</span></div>
                        <blockquote>${esc(a.body)}</blockquote>
                        <div class="meta">
                            ${a.restriction ? `<span>Original: ${statusBadge(a.restriction.scope && a.restriction.scope.length ? 'blocked' : a.against)} ${esc(a.restriction.reason || '')}${a.restriction.by ? ` · by ${esc(a.restriction.by)}` : ''} · ${esc(dateTime(a.restriction.restricted_at))}</span>` : ''}
                            <span>Now: ${statusBadge(a.current)}</span><span>${timeTag(a.created_at)}</span>
                            ${a.decided_name ? `<span>Decided by ${esc(a.decided_name)}: ${esc(a.note || '')}</span>` : ''}
                        </div>
                    </div>
                    <div class="case-act">${a.status === 'open' ? `<button class="btn sm primary" data-ap="overturn">${ic('undo')}Overturn & restore</button><button class="btn sm" data-ap="uphold">Uphold</button>` : ''}
                        <a class="btn sm" href="#/user/${esc(a.user_id)}">Open user</a></div>
                </article>`).join('') : empty(status === 'open' ? 'No open appeals' : 'No appeals here');
        } catch (err) { list.innerHTML = failed(err); }
    };
    body.addEventListener('click', async e => {
        const s = e.target.closest('[data-ap-status]');
        if (s) { status = s.dataset.apStatus; load(); return; }
        const b = e.target.closest('[data-ap]');
        if (!b) return;
        const id = b.closest('[data-appeal]').dataset.appeal;
        const overturn = b.dataset.ap === 'overturn';
        const done = await modal({
            title: overturn ? 'Overturn the decision' : 'Uphold the decision', icon: overturn ? 'undo' : 'shield', confirm: overturn ? 'Overturn and restore' : 'Uphold',
            text: overturn ? 'Their account is restored straight away and they’re told.' : 'The restriction stays; they’re told it was reviewed.',
            body: '<label class="field"><span>Note to record (and send to them)</span><textarea class="input" name="note" rows="3" maxlength="500"></textarea></label>',
            async onSubmit(f) { await api.decideAppeal(id, overturn, f.elements.note.value.trim()); }
        });
        if (done) { toast(overturn ? 'Appeal overturned — account restored' : 'Appeal upheld'); load(); app.refreshCounts(); }
    });
    load();
}

async function history(body) {
    body.innerHTML = `<section class="panel" data-list>${loadingRows(6)}</section>`;
    const list = body.querySelector('[data-list]');
    try {
        const res = await api.audit({ limit: 100 });
        const rows = res.rows.filter(l => /SUSPEND|BLOCK|DEACTIV|REACTIV|REPORT|APPEAL|suspen|report_|content_remove/i.test(l.action));
        list.innerHTML = rows.length ? `<ul class="rows">${rows.map(l => `
            <li><span class="tl-ic admin">${ic('shield')}</span><span class="grow"><strong>${esc(actionLabel(l.action))}</strong>
                ${l.target_user ? ` — <a href="#/user/${esc(l.target_user)}">${esc(l.target_name || 'user')}</a>` : ''} <span class="muted">by ${esc(l.actor_name || 'admin')}</span>
                ${l.reason ? `<div class="muted" style="font-size:.8rem">${esc(l.reason)}</div>` : ''}
                ${l.new_state && l.new_state.scope && l.new_state.scope.length ? `<div class="muted" style="font-size:.8rem">Scope: ${esc(l.new_state.scope.map(scopeLabel).join(', '))}</div>` : ''}</span>
                ${timeTag(l.created_at)}</li>`).join('')}</ul>` : empty('No moderation actions yet');
    } catch (err) { list.innerHTML = failed(err, ''); }
}
