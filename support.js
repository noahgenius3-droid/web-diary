// Help & support (members' side of the Command Center helpline): ask for help, read and answer replies, see why
// your account is limited and appeal it. Settings → Help & support, and notifications from Cordial Support, open it.
// Works once the Command Center database update is installed; until then it says so instead of failing.
document.addEventListener('DOMContentLoaded', () => {
    const app = window.diaryApp;
    const social = window.diarySocial;
    if (!app || !social || !social.internals) return;
    const I = social.internals;
    const { client, esc } = I;
    const ic = id => `<svg class="i" aria-hidden="true"><use href="#${id}"/></svg>`;
    const when = iso => new Date(iso).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
    const CATS = [['account', 'My account'], ['recovery', 'Getting back into my account'], ['rewards', 'Rewards or points'], ['safety', 'Safety — someone is bothering me'],
        ['bug', 'Something isn’t working'], ['complaint', 'A complaint'], ['other', 'Something else']];
    const STATUS = { open: 'Waiting for Cordial', pending: 'Cordial replied', escalated: 'Being looked at closely', resolved: 'Resolved' };

    const dlg = document.createElement('dialog');
    dlg.className = 'sp-sheet';
    dlg.setAttribute('aria-labelledby', 'sp-h');
    document.body.append(dlg);
    const S = { mine: null, account: null, view: 'home', ticket: null, off: false };

    async function load() {
        const [mine, acc] = await Promise.all([client.rpc('diary_support_mine'), client.rpc('diary_my_account')]);
        if (mine.error && /Could not find|does not exist|PGRST202/i.test(mine.error.message + mine.error.code)) { S.off = true; return; }
        S.mine = mine.data || [];
        S.account = acc.data || null;
    }
    function paint() {
        const head = (title, back = false) => `<header class="sp-head">${back ? `<button class="icon-btn" data-sp="home" aria-label="Back">${ic('i-back')}</button>` : ''}<h3 id="sp-h">${title}</h3><button class="icon-btn" data-sp="close" aria-label="Close">${ic('i-close')}</button></header>`;
        if (S.off) {
            dlg.innerHTML = `<div class="sp-card">${head('Help & support')}<div class="sp-body"><p>Help requests aren’t switched on yet. Please try again soon.</p></div></div>`;
            return;
        }
        if (S.view === 'new') {
            dlg.innerHTML = `<div class="sp-card">${head('Ask for help', true)}
                <form class="sp-body sp-form" data-sp-form="new">
                    <label><span>What’s it about?</span><select name="category" required>${CATS.map(([k, l]) => `<option value="${k}">${esc(l)}</option>`).join('')}</select></label>
                    <label><span>Subject</span><input name="subject" maxlength="140" required placeholder="A few words"></label>
                    <label><span>Tell us what happened</span><textarea name="body" rows="6" maxlength="4000" required placeholder="The more detail, the faster we can help"></textarea></label>
                    <p class="muted small">Only Cordial’s support team sees this. We’ll reply here and send you a notification.</p>
                    <button class="primary-btn" type="submit">Send to Cordial</button>
                </form></div>`;
            return;
        }
        if (S.view === 'appeal') {
            dlg.innerHTML = `<div class="sp-card">${head('Appeal', true)}
                <form class="sp-body sp-form" data-sp-form="appeal">
                    <p>Tell us why the decision should change. A person at Cordial reads every appeal.</p>
                    <label><span>Your appeal</span><textarea name="body" rows="7" minlength="10" maxlength="2000" required></textarea></label>
                    <button class="primary-btn" type="submit">Send appeal</button>
                </form></div>`;
            return;
        }
        if (S.view === 'ticket') {
            const t = S.mine.find(x => x.id === S.ticket);
            if (!t) { S.view = 'home'; return paint(); }
            dlg.innerHTML = `<div class="sp-card">${head(`#${t.ref} ${esc(t.subject)}`, true)}
                <div class="sp-body sp-thread">${t.messages.map(m => `<div class="sp-msg${m.from_staff ? ' staff' : ''}"><small>${m.from_staff ? 'Cordial Support' : 'You'} · ${esc(when(m.created_at))}</small><p>${esc(m.body)}</p></div>`).join('')}</div>
                <form class="sp-reply" data-sp-form="reply"><label class="sr-only" for="sp-r">Reply</label><textarea id="sp-r" name="body" rows="2" maxlength="4000" placeholder="${t.status === 'resolved' ? 'Reply to reopen this request…' : 'Write a reply…'}" required></textarea>
                    <button class="primary-btn" type="submit" aria-label="Send">${ic('i-send')}</button></form></div>`;
            const th = dlg.querySelector('.sp-thread');
            th.scrollTop = th.scrollHeight;
            return;
        }
        const a = S.account || {};
        const limited = a.status && a.status !== 'active';
        const scope = (a.scope || []).map(s => ({ platform: 'everything', messaging: 'messaging', comments: 'comments', interactions: 'likes and follows', posting: 'posting' }[s] || s)).join(', ');
        dlg.innerHTML = `<div class="sp-card">${head('Help & support')}
            <div class="sp-body">
                ${limited ? `<div class="sp-status ${esc(a.status)}" role="status">${ic('i-shield')}<div>
                    <strong>${a.status === 'suspended' ? 'Your account is limited' : a.status === 'blocked' ? `Some features are off: ${esc(scope)}` : 'Your account is deactivated'}${a.ends_at ? ` until ${esc(when(a.ends_at))}` : ''}</strong>
                    ${a.reason ? `<p>Reason: ${esc(a.reason)}</p>` : ''}${a.message ? `<p>${esc(a.message)}</p>` : ''}
                    ${a.appeal === 'open' ? '<p><b>Your appeal is being reviewed.</b></p>' : `<button class="st-btn" data-sp="appeal">Appeal this decision</button>`}</div></div>` : ''}
                <button class="primary-btn sp-new" data-sp="new">${ic('i-chat')}Ask Cordial for help</button>
                <h4 class="sp-sub">Your requests</h4>
                ${S.mine.length ? `<ul class="sp-list">${S.mine.map(t => `<li><button data-sp="open" data-id="${esc(t.id)}">
                    <span><strong>${esc(t.subject)}</strong><small>#${t.ref} · ${esc(STATUS[t.status] || t.status)} · ${esc(when(t.updated_at))}</small></span>
                    ${t.status === 'pending' ? '<span class="sp-new-dot" aria-label="New reply"></span>' : ''}${ic('i-forward')}</button></li>`).join('')}</ul>` : '<p class="muted">You haven’t asked for help yet.</p>'}
            </div></div>`;
    }
    async function open(ticketId = null) {
        if (!I.state.profile || (I.isGuest && I.isGuest())) { if (social.requireSignIn) social.requireSignIn('Sign in to contact Cordial support.'); return; }
        S.view = ticketId ? 'ticket' : 'home';
        S.ticket = ticketId;
        dlg.innerHTML = '<div class="sp-card"><div class="sp-body"><p class="muted">Loading…</p></div></div>';
        if (!dlg.open) dlg.showModal();
        await load();
        paint();
    }
    dlg.addEventListener('click', e => {
        if (e.target === dlg) return dlg.close();
        const b = e.target.closest('[data-sp]');
        if (!b) return;
        const what = b.dataset.sp;
        if (what === 'close') dlg.close();
        else if (what === 'open') { S.view = 'ticket'; S.ticket = b.dataset.id; paint(); }
        else { S.view = what; paint(); }
    });
    dlg.addEventListener('submit', async e => {
        e.preventDefault();
        const f = e.target;
        const btn = f.querySelector('[type="submit"]');
        btn.disabled = true;
        const kind = f.dataset.spForm;
        let res;
        if (kind === 'new') res = await client.rpc('diary_support_open', { p_category: f.elements.category.value, p_subject: f.elements.subject.value.trim(), p_body: f.elements.body.value.trim() });
        else if (kind === 'reply') res = await client.rpc('diary_support_reply', { p_ticket: S.ticket, p_body: f.elements.body.value.trim() });
        else res = await client.rpc('diary_appeal', { p_body: f.elements.body.value.trim() });
        btn.disabled = false;
        if (res.error) return app.showToast(res.error.message || 'Couldn’t send that');
        app.showToast(kind === 'new' ? 'Sent — we’ll reply here soon' : kind === 'reply' ? 'Reply sent' : 'Appeal sent — a person will review it');
        await load();
        if (kind === 'new') { S.view = 'ticket'; S.ticket = res.data && res.data.id; }
        else if (kind === 'appeal') S.view = 'home';
        paint();
    });

    Object.assign(app.actions, { 'open-support': () => open() });
    window.diarySupport = { open };
});
