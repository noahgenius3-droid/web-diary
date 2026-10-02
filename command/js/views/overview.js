// Founder overview: the platform at a glance. Compact numbers, each one a link to the list behind it; two charts
// that help decide things (sign-ups vs. activity, reports vs. restrictions); and the queue of what needs you now.
import * as api from '../api.js';
import { esc, num, ic, bars, loadingRows, failed, needsUpgrade, timeTag, who } from '../ui.js';
import { sevBadge, REPORT_REASON, prioBadge, can } from '../model.js';

const stat = (label, value, { href = '', tone = '', sub = '' } = {}) =>
    `<${href ? `a href="${href}"` : 'div'} class="stat${tone ? ` ${tone}` : ''}"><small>${esc(label)}</small><b>${value === null || value === undefined ? '<span class="muted">—</span>' : num(value)}</b>${sub ? `<span class="delta">${sub}</span>` : ''}</${href ? 'a' : 'div'}>`;

export async function view(el) {
    el.innerHTML = `
        <header class="ph"><div><h1>Overview</h1><p>${esc(new Date().toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' }))} · live snapshot of Cordial</p></div>
            <div class="ph-actions"><button class="btn" data-act="refresh">${ic('refresh')}Refresh</button></div></header>
        <div data-o>${loadingRows(6)}</div>`;
    const box = el.querySelector('[data-o]');
    const paint = async () => {
        try {
            const [o, s] = await Promise.all([api.overview(), can('analytics.view') ? api.series(14).catch(() => null) : null]);
            const u = o.users || {}, e = o.engagement || {}, m = o.moderation || {}, sp = o.support, rw = o.rewards;
            box.innerHTML = `
                ${o.legacy ? '<div class="banner" role="note"><svg class="i" viewBox="0 0 24 24"><path d="M12 9v4M12 17h.01M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/></svg><span>Running on Cordial’s original admin tools. Blocking, deactivation, XP and coin rewards, the helpline, appeals and alerts switch on after the Command Center database update (<code>20261002070000_diary_command_center.sql</code>).</span></div>' : ''}
                <div class="sec-title" style="margin-top:0"><h2>Platform</h2></div>
                <div class="stats">
                    ${stat('Total users', u.total, { href: '#/users' })}
                    ${stat('Active (24h)', u.active_24h, { sub: u.active_7d != null ? `${num(u.active_7d)} this week` : '' })}
                    ${stat('New today', u.new_today, { href: '#/users' })}
                    ${stat('New this week', u.new_week, { href: '#/users' })}
                    ${stat('Suspended', u.suspended, { href: '#/users/suspended', tone: u.suspended ? 'warn' : '' })}
                    ${stat('Blocked', u.blocked, { href: '#/users/blocked' })}
                    ${stat('Deactivated', u.deactivated, { href: '#/users/deactivated' })}
                    ${stat('Pending reports', m.open_reports, { href: '#/moderation/reports', tone: m.open_reports ? 'bad' : '' })}
                    ${stat('Open support', sp ? sp.open : null, { href: '#/support/open', tone: sp && sp.urgent ? 'bad' : '' })}
                </div>
                <div class="grid g-2" style="margin-top:16px">
                    <section class="panel"><header class="panel-h"><h2>Sign-ups${s && !s[0]?.legacy ? ' and active members' : ''}</h2><span class="muted">last 14 days</span>
                        ${s && !s[0]?.legacy ? '<span class="legend ph-actions"><span><i></i>Sign-ups</span><span><i class="alt"></i>Active</span></span>' : ''}</header>
                        <div class="panel-b">${s ? bars(s, 'signups', { alt: s[0]?.legacy ? null : 'active', label: 'Sign-ups per day' }) : `<p class="muted">${can('analytics.view') ? 'This chart couldn’t load — refresh to try again.' : 'Charts need the analytics permission.'}</p>`}</div></section>
                    <section class="panel"><header class="panel-h"><h2>Reports and restrictions</h2><span class="muted">last 14 days</span>
                        ${s && !s[0]?.legacy ? '<span class="legend ph-actions"><span><i></i>Reports</span><span><i class="alt"></i>Restrictions</span></span>' : ''}</header>
                        <div class="panel-b">${s && !s[0]?.legacy ? bars(s, 'reports', { alt: 'restrictions', label: 'Reports and restrictions per day' }) : needsUpgrade('This chart')}</div></section>
                </div>
                <div class="sec-title"><h2>Today</h2></div>
                <div class="stats">
                    ${stat('Posts', e.posts)}${stat('Reels', e.reels)}${stat('Stories', e.stories)}${stat('Comments', e.comments)}
                    ${stat('Messages', e.messages)}${stat('Daily trivia streaks', e.streaks)}
                </div>
                <div class="sec-title"><h2>Moderation & rewards</h2></div>
                <div class="stats">
                    ${stat('High-priority reports', m.high_reports, { href: '#/moderation/reports', tone: m.high_reports ? 'bad' : '' })}
                    ${stat('Open appeals', m.open_appeals, { href: '#/moderation/appeals' })}
                    ${stat('Suspensions (7d)', m.suspensions_week)}${stat('Blocks (7d)', m.blocks_week)}${stat('Deactivations (7d)', m.deactivations_week)}
                    ${stat('Rewards today', rw ? rw.today : null, { href: '#/rewards/transactions' })}
                    ${stat('Rewards this week', rw ? rw.week : null)}
                    ${stat('XP given', rw ? rw.xp_total : null)}${stat('Coins given', rw ? rw.coins_total : null)}
                    ${stat('Rewards awaiting review', rw ? rw.pending : null, { href: '#/rewards/pending', tone: rw && rw.pending ? 'warn' : '' })}
                </div>
                <div class="grid g-2" style="margin-top:16px" data-queues>
                    <section class="panel"><header class="panel-h"><h2>Needs attention: reports</h2><a class="ph-actions" href="#/moderation/reports">All reports</a></header><div data-q="reports">${loadingRows(3)}</div></section>
                    <section class="panel"><header class="panel-h"><h2>Needs attention: support</h2><a class="ph-actions" href="#/support/priority">Helpline</a></header><div data-q="tickets">${loadingRows(3)}</div></section>
                </div>`;
            queues(box);
        } catch (err) { box.innerHTML = failed(err); }
    };
    el.addEventListener('click', e => { const a = e.target.closest('[data-act]'); if (a && ['refresh', 'retry'].includes(a.dataset.act)) paint(); });
    paint();
}

async function queues(box) {
    const rep = box.querySelector('[data-q="reports"]');
    const tk = box.querySelector('[data-q="tickets"]');
    if (can('reports.manage')) {
        api.reports({ status: 'active', limit: 5 }).then(r => {
            rep.innerHTML = r.rows.length ? `<ul class="rows">${r.rows.map(x => `
                <li><a href="#/moderation/reports?id=${esc(x.id)}" class="grow" style="color:inherit;text-decoration:none">
                    <strong>${esc(REPORT_REASON[x.reason] || x.reason)}</strong> <span class="muted">against</span> ${esc(x.target_name || 'content')}
                    <div class="muted" style="font-size:.8rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(x.details || x.snapshot || '')}</div></a>
                    ${sevBadge(x.severity)}${timeTag(x.created_at)}</li>`).join('')}</ul>` : '<div class="state"><strong>No open reports</strong><p>Nothing is waiting for review.</p></div>';
        }).catch(err => { rep.innerHTML = failed(err, ''); });
    } else rep.innerHTML = '<div class="state"><p>You don’t review reports.</p></div>';
    if (!api.caps.full) { tk.innerHTML = `<div class="panel-b">${needsUpgrade('The helpline')}</div>`; return; }
    if (!can('support.manage')) { tk.innerHTML = '<div class="state"><p>You don’t handle support.</p></div>'; return; }
    api.tickets({ view: 'open', limit: 5 }).then(r => {
        tk.innerHTML = r.rows.length ? `<ul class="rows">${r.rows.map(t => `
            <li><a href="#/support/t/${esc(t.id)}" class="grow" style="color:inherit;text-decoration:none"><strong>#${t.ref} ${esc(t.subject)}</strong>
                <div class="muted" style="font-size:.8rem">${esc(t.display_name)} · ${esc(t.category)}</div></a>${prioBadge(t.priority)}${timeTag(t.updated_at)}</li>`).join('')}</ul>`
            : '<div class="state"><strong>Inbox zero</strong><p>No open support requests.</p></div>';
    }).catch(err => { tk.innerHTML = failed(err, ''); });
}
