// The user command view: who they are, what state their account is in and why, what's happened, and what you can
// do — with every action explained before it runs. Answers: who, what's happening, why, what came before, who did it.
import * as api from '../api.js';
import { esc, num, ic, loadingRows, failed, empty, ago, date, dateTime, until, avatar, tick, timeTag, shortId, needsUpgrade, toast } from '../ui.js';
import { STATUS, statusBadge, scopeLabel, can, actionLabel, sevBadge, stBadge, REPORT_REASON, REPORT_STATUS, REWARD, TICKET_STATUS, prioBadge } from '../model.js';
import * as act from '../actions.js';

const TL_ICON = { joined: ['star', 'good'], post: ['post', ''], reel: ['reel', ''], story: ['reel', ''], comment: ['chat', ''], messages: ['send', ''],
    badge: ['star', 'good'], reward: ['gift', 'good'], reported: ['flag', 'bad'], report_filed: ['flag', ''], ticket: ['life', ''], admin: ['shield', 'admin'] };

export async function view(el, params, app) {
    const id = params.id;
    let u = null;
    let tab = params.sub || 'activity';
    el.innerHTML = loadingRows(8);
    const load = async () => {
        try { u = await api.user(id); paint(); } catch (err) { el.innerHTML = failed(err); }
    };
    const paint = () => {
        const st = u.status || 'active';
        const r = u.restriction || null;
        const counts = u.counts || {};
        el.innerHTML = `
            <nav class="crumbs" aria-label="Breadcrumb"><a href="#/users">Users</a>${ic('chevR')}<span>${esc(u.display_name)}</span></nav>
            <section class="panel" aria-labelledby="u-name">
                <div class="uhead">
                    ${avatar(u, 'xl')}
                    <div>
                        <h1 id="u-name">${esc(u.display_name)}${tick(u.verified)} ${statusBadge(st)} ${u.is_admin || u.admin_role ? `<span class="role">${esc((u.admin_role || 'admin').replace('_', ' '))}</span>` : ''}</h1>
                        <div class="meta">
                            <span>@${esc(u.username)}</span>
                            <span>ID <button class="btn sm ghost mono" data-copy="${esc(u.id)}" title="Copy user ID">${esc(shortId(u.id))}${ic('copy')}</button></span>
                            <span>Joined ${esc(date(u.created_at))}</span>
                            <span>Last active ${u.last_seen_at ? esc(ago(u.last_seen_at)) : '—'}</span>
                            ${u.email ? `<span>${esc(u.email)}</span>` : ''}
                        </div>
                    </div>
                    <div class="uactions" role="group" aria-label="Account actions">
                        ${can('rewards.send') ? `<button class="btn" data-do="reward">${ic('gift')}Send reward</button>` : ''}
                        ${can('support.manage') ? `<button class="btn" data-do="message">${ic('mail')}Message</button>` : ''}
                        ${st !== 'active' && can('users.reactivate') ? `<button class="btn primary" data-do="reactivate">${ic('undo')}${st === 'deactivated' ? 'Reactivate' : 'Restore'}</button>` : ''}
                        ${st !== 'suspended' && st !== 'deactivated' && can('users.suspend') ? `<button class="btn" data-do="suspend">${ic('pause')}Suspend</button>` : ''}
                        ${st !== 'deactivated' && can('users.block') ? `<button class="btn" data-do="block">${ic('ban')}Block</button>` : ''}
                        ${st !== 'deactivated' && can('users.deactivate') ? `<button class="btn danger-ghost" data-do="deactivate">${ic('power')}Deactivate</button>` : ''}
                    </div>
                </div>
                ${st !== 'active' ? `
                <div class="restrict ${st}" role="status">
                    ${ic(st === 'suspended' ? 'pause' : st === 'blocked' ? 'ban' : 'power')}
                    <div><strong>${esc(STATUS[st].label)}${r && r.scope && r.scope.length ? ` from ${esc(r.scope.map(scopeLabel).join(', ').toLowerCase())}` : ''}
                        ${st !== 'deactivated' ? ` · ${esc(r && r.ends_at ? `ends ${dateTime(r.ends_at)} (${until(r.ends_at)})` : u.ends_at ? `ends ${dateTime(u.ends_at)}` : 'until lifted')}` : ''}</strong>
                        <p>Reason: ${esc((r && r.reason) || u.status_reason || 'not recorded')}${r && r.by_name ? ` · by ${esc(r.by_name)}` : ''}${r && r.restricted_at ? ` · ${esc(dateTime(r.restricted_at))}` : ''}</p>
                        ${r && r.user_message ? `<p>They were told: “${esc(r.user_message)}”</p>` : ''}
                        ${r && r.admin_note ? `<p>Internal note: ${esc(r.admin_note)}</p>` : ''}
                        ${u.open_appeal ? `<p><b>They’ve appealed:</b> “${esc(u.open_appeal.body)}” — <a href="#/moderation/appeals">review appeal</a></p>` : ''}
                    </div>
                    ${can('users.reactivate') ? `<button class="btn sm" data-do="reactivate">${ic('undo')}${st === 'deactivated' ? 'Reactivate' : 'Lift'}</button>` : ''}
                </div>` : ''}
                <div class="mini-stats">
                    <div><small>XP${u.level ? ` · level ${u.level}` : ''}</small><b>${num(u.xp)}</b></div>
                    <div><small>Coins</small><b>${num(u.coins)}</b></div>
                    <div><small>Trivia streak</small><b>${u.streak == null ? '—' : `${num(u.streak)} ${u.streak === 1 ? 'day' : 'days'}`}</b></div>
                    <div><small>Reports against them</small><b style="${(counts.reports_received || u.reports) ? 'color:var(--bad)' : ''}">${num(counts.reports_received ?? u.reports)}</b></div>
                </div>
                <div class="tabs" role="tablist" aria-label="About this user">${[['activity', 'Activity'], ['account', 'Account'], ['history', 'Moderation history'], ['reports', 'Reports'], ['rewards', 'Rewards'], ['support', 'Support']]
                    .map(([k, l]) => `<button role="tab" aria-selected="${tab === k}" data-tab="${k}">${l}</button>`).join('')}</div>
                <div class="panel-b" data-pane></div>
            </section>`;
        pane();
    };

    const pane = async () => {
        const box = el.querySelector('[data-pane]');
        box.innerHTML = loadingRows(5);
        try {
            if (tab === 'activity') return timeline(box);
            if (tab === 'account') return account(box);
            if (tab === 'history') return history(box);
            if (tab === 'reports') {
                if (!can('reports.manage')) { box.innerHTML = empty('Reports are for moderators'); return; }
                const res = await api.reports({ status: 'all', user: id, limit: 50 });
                box.innerHTML = res.rows.length ? `<ul class="rows">${res.rows.map(x => `
                    <li><span class="grow"><strong>${esc(REPORT_REASON[x.reason] || x.reason)}</strong> · ${x.target_user === id ? 'against them' : 'filed by them'}
                        <div class="muted" style="font-size:.8rem">${esc((x.details || x.snapshot || '').slice(0, 160))}</div></span>
                        ${sevBadge(x.severity)} ${stBadge(x.status, REPORT_STATUS)} ${timeTag(x.created_at)}</li>`).join('')}</ul>` : empty('No reports', 'They haven’t been reported or reported anyone.');
                return;
            }
            if (tab === 'rewards') {
                if (!api.caps.full) { box.innerHTML = needsUpgrade('Reward history'); return; }
                const res = await api.rewards({ user: id, limit: 50 });
                box.innerHTML = res.rows.length ? `<ul class="rows">${res.rows.map(w => `
                    <li><span class="grow"><strong>${w.kind === 'badge' ? 'Badge' : w.kind === 'special' ? 'Special recognition' : `${num(w.amount)} ${REWARD[w.kind].unit}`}</strong> — ${esc(w.reason)}
                        <div class="muted" style="font-size:.8rem">by ${esc(w.admin_name || 'admin')} · <span class="mono">RW-${esc(shortId(w.id))}</span></div></span>
                        ${stBadge(w.status)} ${timeTag(w.created_at)}</li>`).join('')}</ul>` : empty('No rewards yet', can('rewards.send') ? 'Send one with the button above.' : '');
                return;
            }
            if (tab === 'support') {
                if (!api.caps.full) { box.innerHTML = needsUpgrade('The helpline'); return; }
                if (!can('support.manage')) { box.innerHTML = empty('Support is handled by the support team'); return; }
                const res = await api.tickets({ view: 'all', user: id, limit: 50 });
                box.innerHTML = res.rows.length ? `<ul class="rows">${res.rows.map(t => `
                    <li><a class="grow" href="#/support/t/${esc(t.id)}" style="color:inherit"><strong>#${t.ref} ${esc(t.subject)}</strong><div class="muted" style="font-size:.8rem">${esc(t.category)} · ${num(t.message_count)} messages</div></a>
                        ${prioBadge(t.priority)} ${stBadge(t.status, TICKET_STATUS)} ${timeTag(t.updated_at)}</li>`).join('')}</ul>` : empty('No support requests', 'They haven’t contacted support.');
            }
        } catch (err) { box.innerHTML = err.needsUpgrade ? needsUpgrade(err.message.replace(/ needs.*/, '')) : failed(err, 'pane'); }
    };

    const timeline = async (box, before = null, append = false) => {
        const ev = await api.timeline(id, before);
        let html = '', lastDay = '';
        for (const e of ev) {
            const day = new Date(e.at).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
            if (day !== lastDay) { html += `<li class="tl-day" style="display:block">${esc(day)}</li>`; lastDay = day; }
            const [icon, tone] = TL_ICON[e.kind] || ['activity', ''];
            const title = e.kind === 'admin' ? actionLabel(e.title) : e.title;
            html += `<li><span class="tl-ic ${tone}">${ic(icon)}</span><div><strong>${esc(title)}</strong>${e.detail ? `<p>${esc(e.detail)}</p>` : ''}</div>${timeTag(e.at)}</li>`;
        }
        const more = ev.length >= 60 ? `<button class="btn sm" data-more="${esc(ev[ev.length - 1].at)}">Load older</button>` : '';
        if (append) { box.querySelector('[data-more]')?.remove(); box.querySelector('.tl').insertAdjacentHTML('beforeend', html); if (more) box.insertAdjacentHTML('beforeend', more); }
        else box.innerHTML = ev.length ? `<p class="muted" style="margin:0 0 6px;font-size:.8rem">Messages are counted per day — their content is never shown here.</p><ol class="tl">${html}</ol>${more}` : empty('No activity yet');
    };
    const account = box => {
        const c = u.counts || {};
        box.innerHTML = `<div class="grid g-2">
            <dl class="kv">
                <dt>Name</dt><dd>${esc(u.display_name)}</dd><dt>Username</dt><dd>@${esc(u.username)}</dd>
                <dt>User ID</dt><dd class="mono">${esc(u.id)}</dd><dt>Email</dt><dd>${esc(u.email || '—')}</dd><dt>Phone</dt><dd>${esc(u.phone || '—')}</dd>
                <dt>Verified</dt><dd>${esc(u.verified || 'No')}</dd><dt>Joined</dt><dd>${esc(dateTime(u.created_at))}</dd>
                <dt>Last sign-in</dt><dd>${esc(dateTime(u.last_sign_in_at))}</dd><dt>Last seen</dt><dd>${esc(dateTime(u.last_seen_at))}</dd>
                <dt>Status</dt><dd>${statusBadge(u.status || 'active')} <span class="muted">${esc(STATUS[u.status || 'active'].about)}</span></dd>
            </dl>
            <dl class="kv">
                <dt>Posts</dt><dd>${num(c.posts)}</dd><dt>Reels</dt><dd>${num(c.reels)}</dd><dt>Stories</dt><dd>${num(c.stories)}</dd>
                <dt>Comments</dt><dd>${num(c.comments)}</dd><dt>Messages sent</dt><dd>${num(c.messages)}</dd><dt>Friends</dt><dd>${num(c.friends)}</dd>
                <dt>Followers</dt><dd>${num(c.followers)}</dd><dt>Badges</dt><dd>${num(c.badges)}</dd>
                <dt>Reports</dt><dd>${num(c.reports_received)} against · ${num(c.reports_filed)} filed</dd><dt>Support</dt><dd>${num(c.tickets)} requests</dd>
                <dt>Rewards</dt><dd>${u.rewards_total ? `${num(u.rewards_total.count)} · ${num(u.rewards_total.xp)} XP · ${num(u.rewards_total.coins)} coins` : '—'}</dd>
            </dl></div>
            <p style="margin:16px 0 0"><a class="btn sm" href="/#/profile/${esc(u.id)}" target="_blank" rel="noopener">${ic('ext')}Open their Cordial profile</a></p>`;
    };
    const history = box => {
        const h = u.history || [];
        box.innerHTML = h.length ? `<ol class="tl">${h.map(x => `
            <li><span class="tl-ic admin">${ic('shield')}</span>
                <div><strong>${esc(actionLabel(x.action))}</strong> <span class="muted">by ${esc(x.actor_name || 'an admin')}</span>
                    ${x.prev || x.next ? `<p class="diff">${x.prev && x.prev.status ? statusBadge(x.prev.status) : ''}${x.prev && x.next ? '<span class="arrow">→</span>' : ''}${x.next && x.next.status ? statusBadge(x.next.status) : ''}
                        ${x.next && x.next.scope && x.next.scope.length ? `<span class="muted">${esc(x.next.scope.map(scopeLabel).join(', '))}</span>` : ''}
                        ${x.next && x.next.ends_at ? `<span class="muted">until ${esc(dateTime(x.next.ends_at))}</span>` : ''}</p>` : ''}
                    ${x.reason ? `<p>Reason: ${esc(x.reason)}</p>` : ''}</div>${timeTag(x.created_at)}</li>`).join('')}</ol>`
            : empty('No admin actions yet', 'Nothing has been done to this account by an admin.');
    };

    el.addEventListener('click', async e => {
        const t = e.target.closest('[data-tab]');
        if (t) { tab = t.dataset.tab; el.querySelectorAll('[data-tab]').forEach(b => b.setAttribute('aria-selected', String(b === t))); app.replace(`#/user/${id}/${tab}`); pane(); return; }
        const d = e.target.closest('[data-do]');
        if (d) {
            const fn = { suspend: act.suspend, block: act.block, deactivate: act.deactivate, reactivate: act.reactivate, reward: act.reward, message: act.message }[d.dataset.do];
            if (fn && await fn(u)) { await load(); app.refreshCounts(); }
            return;
        }
        const c = e.target.closest('[data-copy]');
        if (c) { navigator.clipboard.writeText(c.dataset.copy).then(() => toast('User ID copied')); return; }
        const m = e.target.closest('[data-more]');
        if (m) { timeline(el.querySelector('[data-pane]'), m.dataset.more, true); return; }
        const r = e.target.closest('[data-act="retry"], [data-act="pane"]');
        if (r) { r.dataset.act === 'pane' ? pane() : load(); }
    });
    load();
}
