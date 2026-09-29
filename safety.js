// Safety: block / unblock people, report messages, posts, listings and accounts, and — for app admins — a
// moderation dashboard (reports queue, suspended accounts, audit log, activity). Group staff see reports
// from their own groups. Everything is enforced in the database; this is the interface to it.
document.addEventListener('DOMContentLoaded', () => {
    const app = window.diaryApp;
    const social = window.diarySocial;
    if (!app || !social || !social.internals) return;
    const I = social.internals;
    const { client, state: s, esc, avatar, timeAgo } = I;
    const $ = id => document.getElementById(id);
    const content = $('content');

    const S = { blocked: new Set(), admin: false, suspended: null, userId: null, dash: { tab: 'reports', reports: null, suspended: null, audit: null, stats: null } };
    const me = () => s.profile && s.profile.id;

    // ---------- Start / stop with the account ----------
    setInterval(async () => {
        const id = me();
        if (id && S.userId !== id) {
            S.userId = id;
            await Promise.all([loadBlocks(), checkAdmin(), checkSuspended()]);
        }
        if (!id && S.userId) Object.assign(S, { userId: null, blocked: new Set(), admin: false, suspended: null });
    }, 1000);

    async function loadBlocks() {
        const { data } = await client.from('diary_blocks').select('blocked');
        S.blocked = new Set((data || []).map(r => r.blocked));
    }
    async function checkAdmin() {
        const { data } = await client.rpc('diary_am_admin');
        S.admin = !!data;
        paintAdminNav();
    }
    async function checkSuspended() {
        const { data } = await client.from('diary_suspensions').select('until, reason').eq('user_id', me()).maybeSingle();
        S.suspended = data && (!data.until || Date.parse(data.until) > Date.now()) ? data : null;
        paintSuspended();
    }

    function paintAdminNav() {
        let btn = document.querySelector('.nav-item[data-view="admin"]');
        if (S.admin && !btn) {
            const settings = document.querySelector('.nav-item[data-view="settings"]');
            if (!settings) return;
            btn = document.createElement('button');
            btn.className = 'nav-item';
            btn.dataset.view = 'admin';
            btn.innerHTML = '<svg class="i"><use href="#i-shield"/></svg>Moderation';
            btn.addEventListener('click', () => app.setView('admin'));
            settings.before(btn);
        } else if (!S.admin && btn) btn.remove();
    }

    // A clear notice when your account is suspended (you can still read)
    function paintSuspended() {
        let bar = $('suspended-bar');
        if (!S.suspended) { if (bar) bar.remove(); return; }
        if (!bar) {
            bar = document.createElement('div');
            bar.id = 'suspended-bar';
            bar.className = 'suspended-bar';
            bar.setAttribute('role', 'status');
            const col = document.querySelector('.main-col');
            if (col) col.insertBefore(bar, $('content'));
        }
        const until = S.suspended.until ? `until ${new Date(S.suspended.until).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}` : 'until a moderator lifts it';
        bar.innerHTML = `<svg class="i"><use href="#i-shield"/></svg><span><strong>Your account is limited ${esc(until)}.</strong> You can read, but not post or message. Reason: ${esc(S.suspended.reason || 'a breach of the community rules')}.</span>`;
    }

    // ---------- Block ----------
    const isBlocked = id => S.blocked.has(id);

    async function block(person) {
        const name = person.display_name || 'this person';
        const ok = await app.ask({
            title: `Block ${name}?`,
            text: 'They won’t be able to message you, call you, send you friend requests or find you in search. They won’t be told. You can unblock them any time in Settings → Privacy.',
            ok: 'Block', danger: true
        });
        if (!ok) return false;
        const { error } = await client.from('diary_blocks').insert({ blocked: person.id });
        if (error && error.code !== '23505') { app.showToast('Couldn’t block them'); return false; }
        S.blocked.add(person.id);
        app.showToast(`${name} is blocked`);
        app.requestRender();
        return true;
    }

    async function unblock(person) {
        const { error } = await client.from('diary_blocks').delete().eq('blocked', person.id);
        if (error) { app.showToast('Couldn’t unblock them'); return false; }
        S.blocked.delete(person.id);
        app.showToast(`${person.display_name || 'They'} ${person.display_name ? 'is' : 'are'} unblocked`);
        app.requestRender();
        return true;
    }

    async function blockedList() {
        const ids = [...S.blocked];
        if (!ids.length) return [];
        const { data } = await client.from('diary_profiles').select('id, username, display_name, avatar_path').in('id', ids);
        return data || [];
    }

    // ---------- Report ----------
    const REASONS = [
        ['spam', 'Spam or unwanted ads'], ['harassment', 'Harassment or bullying'], ['hate', 'Hate speech'],
        ['violence', 'Violence or threats'], ['sexual', 'Sexual content'], ['self_harm', 'Self-harm or suicide'],
        ['scam', 'Scam or fraud'], ['impersonation', 'Pretending to be someone else'], ['other', 'Something else']
    ];
    let reportDlg = null;
    // kind: user | dm | gc | post | entry | comment | listing
    function report(kind, targetId, { who = '', offerBlock = null } = {}) {
        if (!reportDlg) {
            reportDlg = document.createElement('dialog');
            reportDlg.className = 'ct-sheet report-sheet';
            document.body.append(reportDlg);
            reportDlg.addEventListener('click', e => { if (e.target === reportDlg || e.target.closest('[data-ct-close]')) reportDlg.close(); });
        }
        const what = { user: 'account', dm: 'message', gc: 'message', post: 'post', entry: 'post', comment: 'comment', listing: 'listing' }[kind] || 'content';
        reportDlg.innerHTML = `
            <form class="ct-card" id="report-form">
                <header class="ct-head"><strong>Report this ${what}</strong><button type="button" class="icon-btn" data-ct-close aria-label="Close"><svg class="i"><use href="#i-close"/></svg></button></header>
                <p class="muted small">${who ? `About ${esc(who)}. ` : ''}Your report is private — ${kind === 'gc' || kind === 'post' ? 'the group’s moderators and ' : ''}Cordial’s moderators will see it, not the person you report.</p>
                <fieldset class="report-reasons"><legend class="sr-only">Why are you reporting it?</legend>
                    ${REASONS.map(([k, l], i) => `<label class="report-reason"><input type="radio" name="reason" value="${k}"${i === 0 ? ' required' : ''}><span>${l}</span></label>`).join('')}
                </fieldset>
                <label class="mk-field"><span>Anything else we should know? (optional)</span><textarea name="details" rows="2" maxlength="1000"></textarea></label>
                ${offerBlock ? '<label class="report-block"><input type="checkbox" name="block" checked> Also block them</label>' : ''}
                <p class="muted small">If someone is in immediate danger, contact your local emergency services.</p>
                <footer class="ct-foot"><button type="submit" class="primary-btn block">Send report</button></footer>
            </form>`;
        reportDlg.querySelector('#report-form').onsubmit = async e => {
            e.preventDefault();
            const f = e.currentTarget;
            const reason = f.reason.value;
            if (!reason) return;
            const btn = f.querySelector('[type="submit"]');
            btn.disabled = true;
            const { error } = await client.rpc('diary_report', { p_kind: kind, p_target: String(targetId), p_reason: reason, p_details: f.details.value.trim() || null });
            btn.disabled = false;
            if (error) return app.showToast(error.message || 'Couldn’t send the report');
            reportDlg.close();
            app.showToast('Thanks — your report was sent to the moderators');
            if (offerBlock && f.block && f.block.checked) block(offerBlock);
        };
        if (!reportDlg.open) reportDlg.showModal();
    }

    // ---------- Moderation dashboard (app admins) ----------
    const REASON_LABEL = Object.fromEntries(REASONS);
    const KIND_LABEL = { user: 'Account', dm: 'Direct message', gc: 'Group message', post: 'Group post', entry: 'Feed post', comment: 'Comment', listing: 'Marketplace listing' };

    async function loadDash() {
        const d = S.dash;
        const [stats, reports, suspended, audit] = await Promise.all([
            client.rpc('diary_admin_stats'),
            client.from('diary_reports').select('*').order('created_at', { ascending: false }).limit(200),
            client.from('diary_suspensions').select('*').order('created_at', { ascending: false }),
            client.from('diary_audit_log').select('*').order('created_at', { ascending: false }).limit(200)
        ]);
        d.stats = stats.data || {};
        d.reports = reports.data || [];
        d.suspended = suspended.data || [];
        d.audit = audit.data || [];
        const ids = [...new Set([...d.reports.flatMap(r => [r.reporter, r.target_user]), ...d.suspended.map(x => x.user_id), ...d.audit.flatMap(a => [a.actor, a.target_user])].filter(Boolean))];
        const { data: people } = ids.length ? await client.from('diary_profiles').select('id, username, display_name, avatar_path').in('id', ids) : { data: [] };
        d.people = new Map((people || []).map(p => [p.id, p]));
        app.requestRender('admin');
    }
    const personName = id => { const p = S.dash.people && S.dash.people.get(id); return p ? `${p.display_name} (@${p.username})` : 'Deleted account'; };

    app.views.admin = () => {
        app.setTitle('Moderation');
        if (!S.admin) return '<div class="empty"><strong>Moderation</strong><p class="muted">Only Cordial’s moderators can open this page.</p></div>';
        const d = S.dash;
        if (d.reports === null) { loadDash(); return '<div class="adm"><p class="muted">Loading the dashboard…</p></div>'; }
        const open = d.reports.filter(r => r.status === 'open');
        const tab = (k, l, n) => `<button type="button" class="tab" role="tab" aria-selected="${d.tab === k}" data-action="adm-tab" data-tab="${k}">${l}${n ? `<span class="badge">${n}</span>` : ''}</button>`;
        const st = d.stats || {};
        const card = (label, value) => `<div class="adm-stat"><strong>${Number(value || 0).toLocaleString()}</strong><span>${label}</span></div>`;
        let body = '';
        if (d.tab === 'reports' || d.tab === 'closed') {
            const list = d.tab === 'reports' ? open : d.reports.filter(r => r.status !== 'open');
            body = list.length ? list.map(r => `
                <article class="adm-report">
                    <header><span class="adm-kind">${esc(KIND_LABEL[r.kind] || r.kind)}</span><strong>${esc(REASON_LABEL[r.reason] || r.reason)}</strong><time>${esc(timeAgo(r.created_at))}</time></header>
                    <p class="adm-meta">Reported: <b>${esc(personName(r.target_user))}</b> · by ${esc(personName(r.reporter))}</p>
                    ${r.snapshot ? `<blockquote>${esc(r.kind === 'dm' ? Rich.toText(r.snapshot) : r.snapshot)}</blockquote>` : ''}
                    ${r.details ? `<p class="adm-details">“${esc(r.details)}”</p>` : ''}
                    ${r.status === 'open' ? `<div class="adm-actions">
                        <button type="button" class="chip" data-action="adm-act" data-id="${r.id}" data-act="dismiss">Dismiss</button>
                        <button type="button" class="chip" data-action="adm-act" data-id="${r.id}" data-act="warn">Mark reviewed</button>
                        ${r.kind !== 'user' ? `<button type="button" class="chip danger" data-action="adm-act" data-id="${r.id}" data-act="remove">Remove content</button>` : ''}
                        ${r.target_user ? `<button type="button" class="chip danger" data-action="adm-act" data-id="${r.id}" data-act="suspend_7d">Suspend 7 days</button>
                        <button type="button" class="chip danger" data-action="adm-act" data-id="${r.id}" data-act="suspend_30d">30 days</button>
                        <button type="button" class="chip danger" data-action="adm-act" data-id="${r.id}" data-act="suspend">Indefinitely</button>` : ''}
                    </div>` : `<p class="adm-meta">${esc(r.status === 'dismissed' ? 'Dismissed' : 'Actioned')} · ${esc(r.resolution || '')} · ${esc(timeAgo(r.handled_at))}</p>`}
                </article>`).join('') : `<p class="muted">${d.tab === 'reports' ? 'No open reports. 🎉' : 'Nothing handled yet.'}</p>`;
        } else if (d.tab === 'suspended') {
            const active = d.suspended.filter(x => !x.until || Date.parse(x.until) > Date.now());
            body = active.length ? active.map(x => `
                <div class="adm-row">${avatar(d.people.get(x.user_id) || { id: x.user_id, display_name: '?' }, 'sm')}
                    <span><strong>${esc(personName(x.user_id))}</strong><small>${esc(x.until ? `Until ${new Date(x.until).toLocaleString()}` : 'Indefinitely')} · ${esc(x.reason || '')}</small></span>
                    <button type="button" class="chip" data-action="adm-lift" data-id="${x.user_id}">Lift</button></div>`).join('') : '<p class="muted">No suspended accounts.</p>';
        } else if (d.tab === 'audit') {
            body = d.audit.length ? `<ol class="adm-audit">${d.audit.map(a => `<li><time>${esc(new Date(a.created_at).toLocaleString())}</time><span><b>${esc(personName(a.actor))}</b> ${esc(a.action.replace(/_/g, ' '))}${a.target_user ? ` → ${esc(personName(a.target_user))}` : ''}</span></li>`).join('')}</ol>` : '<p class="muted">No moderation actions yet.</p>';
        }
        return `
            <div class="adm">
                <header class="adm-head"><div><h2>Moderation</h2><p class="muted">Reports, suspended accounts and everything moderators have done.</p></div>
                    <button type="button" class="chip" data-action="adm-refresh"><svg class="i"><use href="#i-refresh"/></svg>Refresh</button></header>
                <div class="adm-stats">${card('Accounts', st.users)}${card('Active today', st.active_today)}${card('Messages today', st.messages_today)}${card('Open reports', st.open_reports)}${card('Suspended', st.suspended)}${card('Blocks', st.blocks)}${card('Communities', st.communities)}</div>
                <div class="tabs" role="tablist">${tab('reports', 'Open reports', open.length)}${tab('closed', 'Handled')}${tab('suspended', 'Suspended')}${tab('audit', 'Audit log')}</div>
                <div class="adm-body">${body}</div>
            </div>`;
    };
    app.onRefresh('admin', async () => { S.dash.reports = null; await loadDash(); });

    Object.assign(app.actions, {
        'adm-tab': el => { S.dash.tab = el.dataset.tab; app.render(); },
        'adm-refresh': () => { S.dash.reports = null; app.render(); },
        'adm-act': async el => {
            const act = el.dataset.act;
            const label = { dismiss: 'Dismiss this report?', warn: 'Mark as reviewed?', remove: 'Remove the reported content?', suspend_7d: 'Suspend this account for 7 days?', suspend_30d: 'Suspend this account for 30 days?', suspend: 'Suspend this account until you lift it?' }[act];
            const res = await app.ask({ title: label, text: 'Add a short note for the audit log (optional).', value: '', placeholder: 'Note', allowEmpty: true, ok: 'Confirm', danger: act !== 'dismiss' && act !== 'warn' });
            if (!res) return;
            const { error } = await client.rpc('diary_resolve_report', { p_id: el.dataset.id, p_action: act, p_note: (res.value || '').trim() || null });
            if (error) return app.showToast(error.message || 'Couldn’t do that');
            app.showToast('Done — logged in the audit log');
            S.dash.reports = null;
            app.render();
        },
        'adm-lift': async el => {
            const { error } = await client.rpc('diary_lift_suspension', { p_user: el.dataset.id });
            if (error) return app.showToast('Couldn’t lift it');
            app.showToast('Suspension lifted');
            S.dash.reports = null;
            app.render();
        }
    });

    // Phones: Moderation lives in the More menu for admins
    const previousMenu = app.hooks.menuItems;
    app.hooks.menuItems = () => [
        ...(previousMenu ? previousMenu() : []),
        ...(S.admin ? [{ label: 'Moderation', icon: 'i-shield', onClick: () => app.setView('admin') }] : [])
    ];

    window.diarySafety = { isBlocked, block, unblock, report, blockedList, isAdmin: () => S.admin, refreshBlocks: loadBlocks };
});
