// Analytics: daily series for the decisions the founder makes — growth, activity, moderation load, rewards and
// support response. Each chart says exactly what it counts.
import * as api from '../api.js';
import { esc, num, bars, loadingRows, failed, needsUpgrade, empty } from '../ui.js';
import { can } from '../model.js';

const TABS = [['users', 'Users'], ['engagement', 'Engagement'], ['moderation', 'Moderation'], ['rewards', 'Rewards & support']];
const sum = (s, k) => s.reduce((a, d) => a + (Number(d[k]) || 0), 0);

export async function view(el, params) {
    const sub = TABS.some(t => t[0] === params.sub) ? params.sub : 'users';
    let days = Number(params.query.days) || 30;
    el.innerHTML = `
        <header class="ph"><div><h1>Analytics</h1><p>Daily numbers, newest on the right. Hover a bar for the exact value.</p></div>
            <div class="ph-actions"><div class="seg" role="radiogroup" aria-label="Range">${[14, 30, 90].map(d => `<button role="radio" aria-checked="${d === days}" data-days="${d}">${d} days</button>`).join('')}</div></div></header>
        <div class="tabs" role="tablist" style="padding:0;margin-bottom:14px">${TABS.map(([k, l]) => `<a role="tab" aria-selected="${k === sub}" href="#/analytics/${k}" class="btn ghost" style="border-radius:0;${k === sub ? 'box-shadow:inset 0 -2px 0 var(--accent);color:var(--text)' : 'color:var(--text-2)'}">${l}</a>`).join('')}</div>
        <div data-body>${loadingRows(6)}</div>`;
    const body = el.querySelector('[data-body]');
    if (!can('analytics.view')) { body.innerHTML = empty('Analytics need the analytics permission'); return; }
    const chart = (title, s, key, alt, note, legend) => `
        <section class="panel"><header class="panel-h"><h2>${esc(title)}</h2>${legend ? `<span class="legend ph-actions">${legend}</span>` : ''}</header>
            <div class="panel-b">${bars(s, key, { alt, label: title })}<p class="muted" style="margin:8px 0 0;font-size:.78rem">${note}</p></div></section>`;
    const load = async () => {
        body.innerHTML = loadingRows(6);
        try {
            const s = await api.series(days);
            const legacy = s[0] && s[0].legacy;
            if (legacy && sub !== 'users') { body.innerHTML = needsUpgrade('This analytics view'); return; }
            const totals = keys => `<div class="stats" style="margin-bottom:16px">${keys.map(([k, l]) => `<div class="stat"><small>${esc(l)} · ${days}d</small><b>${num(sum(s, k))}</b></div>`).join('')}</div>`;
            if (sub === 'users') {
                body.innerHTML = `${totals(legacy ? [['signups', 'Sign-ups']] : [['signups', 'Sign-ups'], ['active', 'Active member-days']])}
                    <div class="grid">${chart('New sign-ups', s, 'signups', null, 'Accounts created each day.')}
                    ${legacy ? needsUpgrade('Daily active members') : chart('Active members', s, 'active', null, 'People who posted, commented, messaged or played that day. Cordial keeps no visit history, so quiet readers aren’t counted.')}</div>`;
            } else if (sub === 'engagement') {
                body.innerHTML = `${totals([['posts', 'Posts'], ['messages', 'Direct messages']])}
                    <div class="grid g-2">${chart('Posts', s, 'posts', null, 'Feed posts shared each day.')}${chart('Direct messages', s, 'messages', null, 'Messages sent between people (content is never read here).')}</div>`;
            } else if (sub === 'moderation') {
                body.innerHTML = `${totals([['reports', 'Reports'], ['restrictions', 'Restrictions']])}
                    <div class="grid">${chart('Reports and restrictions', s, 'reports', 'restrictions', 'Reports filed vs. suspensions, blocks and deactivations applied. A gap that keeps growing means reports are piling up.',
                        '<span><i></i>Reports</span><span><i class="alt"></i>Restrictions</span>')}</div>`;
            } else {
                const o = await api.overview();
                body.innerHTML = `${totals([['rewards', 'Rewards'], ['tickets', 'Support requests'], ['resolved', 'Resolved']])}
                    <div class="stats" style="margin-bottom:16px"><div class="stat"><small>Median time to resolve (30d)</small><b>${o.support && o.support.median_hours != null ? `${num(o.support.median_hours)}h` : '—'}</b></div>
                        <div class="stat"><small>XP given (all time)</small><b>${num(o.rewards && o.rewards.xp_total)}</b></div><div class="stat"><small>Coins given (all time)</small><b>${num(o.rewards && o.rewards.coins_total)}</b></div></div>
                    <div class="grid g-2">${chart('Rewards delivered', s, 'rewards', null, 'Rewards delivered each day (pending and declined ones excluded).')}
                    ${chart('Support requests vs. resolved', s, 'tickets', 'resolved', 'New requests vs. requests resolved each day.', '<span><i></i>New</span><span><i class="alt"></i>Resolved</span>')}</div>`;
            }
        } catch (err) { body.innerHTML = err.needsUpgrade ? needsUpgrade('Analytics') : failed(err); }
    };
    el.addEventListener('click', e => {
        const d = e.target.closest('[data-days]');
        if (d) { days = Number(d.dataset.days); el.querySelectorAll('[data-days]').forEach(b => b.setAttribute('aria-checked', String(b === d))); load(); }
        if (e.target.closest('[data-act="retry"]')) load();
    });
    load();
}
