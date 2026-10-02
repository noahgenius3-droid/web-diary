// Help & support: members message Cordial for help (Settings → Help & support, or a notification from support).
// The Cordial Assistant — an AI that writes in the founder's voice — answers first and is always labelled as AI;
// replies from a person say so. When the assistant hands over, the member is told a person will pick it up.
document.addEventListener('DOMContentLoaded', () => {
    const app = window.diaryApp;
    const social = window.diarySocial;
    if (!app || !social || !social.internals) return;
    const I = social.internals;
    const { client, esc } = I;
    const cfg = window.DIARY_CONFIG || {};
    const ic = id => `<svg class="i" aria-hidden="true"><use href="#${id}"/></svg>`;
    const when = iso => new Date(iso).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
    const CATS = [['account', 'My account'], ['recovery', 'Getting back into my account'], ['rewards', 'Rewards or points'], ['safety', 'Safety — someone is bothering me'],
        ['bug', 'Something isn’t working'], ['complaint', 'A complaint'], ['other', 'Something else']];
    const STATUS = { open: 'Waiting for a reply', pending: 'Replied', escalated: 'With the Cordial team', resolved: 'Resolved' };

    const dlg = document.createElement('dialog');
    dlg.className = 'hs-sheet';
    dlg.setAttribute('aria-labelledby', 'sp-h');
    document.body.append(dlg);
    const S = { mine: null, view: 'home', ticket: null, off: false, typing: false };

    async function load() {
        const { data, error } = await client.rpc('diary_support_mine');
        if (error) { S.off = /Could not find|does not exist|PGRST202/i.test(`${error.message} ${error.code}`); S.mine = []; return; }
        S.off = false;
        S.mine = data || [];
    }
    // Ask the assistant to answer the member's latest message (it decides whether to, on the server)
    async function askAssistant(ticketId) {
        const t = S.mine.find(x => x.id === ticketId);
        if (!t || !t.ai_active) return;
        S.typing = true;
        if (S.view === 'ticket' && S.ticket === ticketId) paint();
        try {
            const { data: sess } = await client.auth.getSession();
            await fetch(`${cfg.supabaseUrl}/functions/v1/diary-helpline-ai`, {
                method: 'POST',
                headers: { Authorization: `Bearer ${sess.session.access_token}`, apikey: cfg.supabaseKey, 'Content-Type': 'application/json' },
                body: JSON.stringify({ ticket: ticketId })
            });
        } catch (e) { /* a person still sees the message */ }
        S.typing = false;
        await load();
        if (dlg.open) paint();
    }

    const label = m => (m.from_staff ? (m.ai ? 'Cordial Assistant · AI' : 'Cordial team') : 'You');

    function paint() {
        const head = (title, back = false) => `<header class="hs-head">${back ? `<button class="icon-btn" data-sp="home" aria-label="Back">${ic('i-back')}</button>` : ''}<h3 id="sp-h">${title}</h3><button class="icon-btn" data-sp="close" aria-label="Close">${ic('i-close')}</button></header>`;
        if (S.off) {
            dlg.innerHTML = `<div class="hs-card">${head('Help & support')}<div class="hs-body"><p>Help requests aren’t switched on yet. Please try again soon.</p></div></div>`;
            return;
        }
        if (S.view === 'new') {
            dlg.innerHTML = `<div class="hs-card">${head('Ask for help', true)}
                <form class="hs-body hs-form" data-sp-form="new">
                    <label><span>What’s it about?</span><select name="category" required>${CATS.map(([k, l]) => `<option value="${k}">${esc(l)}</option>`).join('')}</select></label>
                    <label><span>Subject</span><input name="subject" maxlength="140" required placeholder="A few words"></label>
                    <label><span>Tell us what happened</span><textarea name="body" rows="6" maxlength="4000" required placeholder="The more detail, the faster we can help"></textarea></label>
                    <p class="muted small">Cordial’s AI assistant usually answers first, in a few seconds — and hands you to a person whenever you need one. Only Cordial’s team can read this.</p>
                    <button class="primary-btn" type="submit">Send</button>
                </form></div>`;
            return;
        }
        if (S.view === 'ticket') {
            const t = S.mine.find(x => x.id === S.ticket);
            if (!t) { S.view = 'home'; return paint(); }
            const lastMsg = t.messages[t.messages.length - 1];
            // Handed to a person, and no person has answered since
            const handed = !t.ai_active && t.status !== 'resolved' && !(lastMsg && lastMsg.from_staff && !lastMsg.ai);
            dlg.innerHTML = `<div class="hs-card">${head(`#${t.ref} ${esc(t.subject)}`, true)}
                <div class="hs-body hs-thread" aria-live="polite">
                    ${t.messages.map(m => `<div class="hs-msg${m.from_staff ? ' staff' : ''}${m.ai ? ' ai' : ''}"><small>${m.ai ? `${ic('i-sparkle')}` : ''}${label(m)} · ${esc(when(m.created_at))}</small><p>${esc(m.body)}</p></div>`).join('')}
                    ${S.typing ? '<div class="hs-msg staff ai hs-typing"><small>Cordial Assistant · AI</small><p><span></span><span></span><span></span><span class="sr-only">is typing</span></p></div>' : ''}
                    ${handed && !S.typing ? `<p class="hs-note">${ic('i-user')}A person from Cordial will reply here — we’ll send you a notification.</p>` : ''}
                </div>
                <form class="hs-reply" data-sp-form="reply"><label class="sr-only" for="sp-r">Reply</label><textarea id="sp-r" name="body" rows="2" maxlength="4000" placeholder="${t.status === 'resolved' ? 'Reply to reopen this request…' : 'Write a message…'}" required></textarea>
                    <button class="primary-btn" type="submit" aria-label="Send">${ic('i-send')}</button></form></div>`;
            const th = dlg.querySelector('.hs-thread');
            th.scrollTop = th.scrollHeight;
            return;
        }
        dlg.innerHTML = `<div class="hs-card">${head('Help & support')}
            <div class="hs-body">
                <button class="primary-btn hs-new" data-sp="new">${ic('i-chat')}Message Cordial</button>
                <p class="muted small" style="margin:0">Our AI assistant answers straight away and brings in a person whenever you need one.</p>
                <h4 class="hs-sub">Your conversations</h4>
                ${S.mine.length ? `<ul class="hs-list">${S.mine.map(t => {
                    const lastMsg = t.messages[t.messages.length - 1];
                    const unread = lastMsg && lastMsg.from_staff;
                    return `<li><button data-sp="open" data-id="${esc(t.id)}">
                        <span><strong>${esc(t.subject)}</strong><small>#${t.ref} · ${esc(STATUS[t.status] || t.status)} · ${esc(when(t.updated_at))}</small></span>
                        ${unread && t.status !== 'resolved' ? '<span class="hs-new-dot" aria-label="New reply"></span>' : ''}${ic('i-forward')}</button></li>`;
                }).join('')}</ul>` : '<p class="muted">No conversations yet.</p>'}
            </div></div>`;
    }
    async function open(ticketId = null) {
        if (!I.state.profile || (I.isGuest && I.isGuest())) { if (social.requireSignIn) social.requireSignIn('Sign in to message Cordial.'); return; }
        S.view = ticketId ? 'ticket' : 'home';
        S.ticket = ticketId;
        dlg.innerHTML = '<div class="hs-card"><div class="hs-body"><p class="muted">Loading…</p></div></div>';
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
    dlg.addEventListener('keydown', e => { if (e.target.id === 'sp-r' && e.key === 'Enter' && !e.shiftKey && matchMedia('(pointer: fine)').matches) { e.preventDefault(); e.target.form.requestSubmit(); } });
    dlg.addEventListener('submit', async e => {
        e.preventDefault();
        const f = e.target;
        const btn = f.querySelector('[type="submit"]');
        btn.disabled = true;
        const kind = f.dataset.spForm;
        const res = kind === 'new'
            ? await client.rpc('diary_support_open', { p_category: f.elements.category.value, p_subject: f.elements.subject.value.trim(), p_body: f.elements.body.value.trim() })
            : await client.rpc('diary_support_reply', { p_ticket: S.ticket, p_body: f.elements.body.value.trim() });
        btn.disabled = false;
        if (res.error) return app.showToast(res.error.message || 'Couldn’t send that');
        if (kind === 'new') { S.view = 'ticket'; S.ticket = res.data && res.data.id; }
        await load();
        paint();
        askAssistant(S.ticket);
    });

    Object.assign(app.actions, { 'open-support': () => open() });
    window.diarySupport = { open };
});
