// Moderation → Helpline (admins): conversations from Help & support. The Cordial Assistant (AI) answers first;
// anything it hands over comes to the top. Admins read the thread, take over or hand back, reply (or leave an
// internal note), resolve — and set the assistant's voice. All checks happen on the server (admins only).
document.addEventListener('DOMContentLoaded', () => {
    const app = window.diaryApp;
    const social = window.diarySocial;
    if (!app || !social || !social.internals) return;
    const I = social.internals;
    const { client, esc, avatar, timeAgo } = I;
    const ic = id => `<svg class="i" aria-hidden="true"><use href="#${id}"/></svg>`;
    const when = iso => new Date(iso).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
    const CAT = { account: 'Account', recovery: 'Account recovery', rewards: 'Rewards', safety: 'Safety', bug: 'Bug', complaint: 'Complaint', other: 'Other' };
    const VIEWS = [['human', 'Needs a person'], ['open', 'Open'], ['resolved', 'Resolved'], ['all', 'All']];
    const H = { view: 'human', list: null, current: null, thread: null, settings: null, off: false, loading: false };
    const paint = () => { if (app.state.view === 'admin') app.requestRender ? app.requestRender('admin') : app.render(); };

    async function loadList() {
        if (H.loading) return;
        H.loading = true;
        const { data, error } = await client.rpc('diary_helpline_tickets', { p_view: H.view });
        H.loading = false;
        if (error) { H.off = /Could not find|does not exist|PGRST202/i.test(`${error.message} ${error.code}`); H.list = []; return paint(); }
        H.list = data || [];
        if (H.current && (!H.thread || H.thread.ticket.id !== H.current)) openThread(H.current);
        else if (!H.current && H.list[0]) openThread(H.list[0].id);
        paint();
    }
    async function openThread(id) {
        H.current = id;
        const { data } = await client.rpc('diary_helpline_thread', { p_id: id });
        H.thread = data;
        paint();
    }
    async function loadSettings() {
        const { data } = await client.rpc('diary_helpline_settings');
        H.settings = data || null;
        paint();
    }

    function html() {
        if (H.list === null) { loadList(); if (!H.settings) loadSettings(); return '<p class="muted">Loading the helpline…</p>'; }
        if (H.off) return '<div class="empty small"><p class="empty-title">The helpline isn’t switched on yet</p><p>It needs the helpline database update (supabase/migrations/20261002070000_diary_helpline.sql).</p></div>';
        const s = H.settings || {};
        const t = H.thread && H.thread.ticket;
        return `
            <details class="hl-settings">
                <summary>${ic('i-sparkle')}Cordial Assistant (AI) · <b>${s.ai_enabled ? 'answering' : 'off'}</b></summary>
                <form data-hl-form="settings" class="hl-set-form">
                    <label class="hl-switch"><input type="checkbox" name="enabled"${s.ai_enabled ? ' checked' : ''}> Let the assistant answer new messages</label>
                    <label><span>Your first name (it writes on your behalf and says so)</span><input name="voice" maxlength="60" value="${esc(s.voice_name || 'Noah')}"></label>
                    <label><span>In your own words: how you talk to members, and anything it should know</span>
                        <textarea name="notes" rows="5" maxlength="4000" placeholder="e.g. I’m Noah, I built Cordial for my church community. Be warm and brief. We never sell data. Trivia resets at midnight UTC.">${esc(s.voice_notes || '')}</textarea></label>
                    <label><span>Hand over to a person after this many AI replies</span><input name="max" type="number" min="1" max="50" value="${s.max_ai_replies || 12}"></label>
                    <p class="muted small">It always labels itself as AI, never changes accounts or grants rewards, and hands safety, recovery, suspensions and payments straight to you.</p>
                    <button class="primary-btn" type="submit">Save</button>
                </form>
            </details>
            <div class="hl-views" role="radiogroup" aria-label="Which conversations">${VIEWS.map(([k, l]) => `<button type="button" role="radio" class="chip" aria-checked="${H.view === k}" data-hl="view" data-v="${k}">${l}</button>`).join('')}</div>
            <div class="hl">
                <div class="hl-list" role="list">${H.list.length ? H.list.map(x => `
                    <button type="button" role="listitem" class="hl-item${x.id === H.current ? ' on' : ''}" data-hl="open" data-id="${esc(x.id)}">
                        ${avatar({ id: x.user_id, display_name: x.display_name, avatar_path: x.avatar_path }, 'sm')}
                        <span><strong>${esc(x.subject)}</strong>
                            <small>${esc(x.display_name)} · #${x.ref} · ${esc(CAT[x.category] || x.category)} · ${esc(timeAgo(x.updated_at))}</small>
                            <small class="hl-last">${x.last ? `${x.last.from_staff ? (x.last.ai ? 'AI: ' : 'You: ') : ''}${esc(x.last.body)}` : ''}</small></span>
                        <span class="hl-tags">${!x.ai_active && x.status !== 'resolved' ? '<b class="hl-tag person">Needs you</b>' : x.status === 'resolved' ? '<b class="hl-tag">Resolved</b>' : '<b class="hl-tag ai">AI</b>'}
                            ${['high', 'urgent'].includes(x.priority) ? `<b class="hl-tag ${x.priority}">${esc(x.priority)}</b>` : ''}</span>
                    </button>`).join('') : `<p class="muted">${H.view === 'human' ? 'Nothing needs you right now. 🎉' : 'No conversations here.'}</p>`}</div>
                <section class="hl-thread" aria-label="Conversation">${t ? `
                    <header class="hl-th-head">
                        <div><h3>#${t.ref} ${esc(t.subject)}</h3><p class="muted small">${esc(t.display_name)} (@${esc(t.username)}) · ${esc(CAT[t.category] || t.category)} · ${esc(t.priority)} priority · ${esc(t.status)}</p></div>
                        <div class="hl-th-actions">
                            ${t.status === 'resolved' ? '' : t.ai_active ? `<button class="chip" data-hl="takeover">${ic('i-user')}Take over</button>` : `<button class="chip" data-hl="handback">${ic('i-sparkle')}Hand back to assistant</button>`}
                            ${t.status === 'resolved' ? '<button class="chip" data-hl="reopen">Reopen</button>' : '<button class="chip accent" data-hl="resolve">Resolve</button>'}
                            <button class="chip" data-profile="${esc(t.user_id)}">Profile</button>
                        </div>
                    </header>
                    ${!t.ai_active && t.handoff_reason ? `<p class="hl-handoff">${ic('i-alert')}<span><b>Handed to you:</b> ${esc(t.handoff_reason)}</span></p>` : ''}
                    <div class="hl-msgs">${H.thread.messages.map(m => `
                        <div class="hl-msg${m.internal ? ' note' : m.from_staff ? ' staff' : ''}${m.ai ? ' ai' : ''}">
                            <small>${m.internal ? `Internal note · ${esc(m.author_name || 'admin')}` : m.from_staff ? (m.ai ? 'Cordial Assistant · AI' : esc(m.author_name || 'Cordial team')) : esc(t.display_name)} · ${esc(when(m.created_at))}</small>
                            <p>${esc(m.body)}</p></div>`).join('')}</div>
                    <form class="hl-reply" data-hl-form="reply">
                        <textarea name="body" rows="3" maxlength="4000" placeholder="Reply as yourself… (the assistant steps back when you reply)" aria-label="Reply"></textarea>
                        <div class="hl-reply-foot"><label class="small"><input type="checkbox" name="internal"> Internal note (member won’t see it)</label>
                            <button class="primary-btn" type="submit">${ic('i-send')}Send</button></div>
                    </form>` : '<p class="muted">Choose a conversation.</p>'}</section>
            </div>`;
    }

    document.addEventListener('click', async e => {
        const b = e.target.closest('[data-hl]');
        if (!b || app.state.view !== 'admin') return;
        const what = b.dataset.hl;
        if (what === 'view') { H.view = b.dataset.v; H.current = null; H.thread = null; return loadList(); }
        if (what === 'open') return openThread(b.dataset.id);
        const change = { takeover: { p_ai: false }, handback: { p_ai: true }, resolve: { p_status: 'resolved' }, reopen: { p_status: 'open' } }[what];
        if (!change || !H.current) return;
        const { error } = await client.rpc('diary_helpline_update', { p_id: H.current, p_status: null, p_ai: null, ...change });
        if (error) return app.showToast(error.message || 'Couldn’t update it');
        app.showToast({ takeover: 'You’ve taken over — the assistant won’t reply here', handback: 'The assistant will answer their next message', resolve: 'Resolved', reopen: 'Reopened' }[what]);
        await openThread(H.current);
        loadList();
    });
    document.addEventListener('submit', async e => {
        const f = e.target.closest('[data-hl-form]');
        if (!f) return;
        e.preventDefault();
        const btn = f.querySelector('[type="submit"]');
        btn.disabled = true;
        let error;
        if (f.dataset.hlForm === 'reply') {
            if (!f.elements.body.value.trim()) { btn.disabled = false; return; }
            ({ error } = await client.rpc('diary_helpline_reply', { p_id: H.current, p_body: f.elements.body.value.trim(), p_internal: f.elements.internal.checked }));
            if (!error) { app.showToast(f.elements.internal.checked ? 'Note added' : 'Sent — they’ll get a notification'); await openThread(H.current); loadList(); }
        } else {
            ({ error } = await client.rpc('diary_helpline_save_settings', { p_enabled: f.elements.enabled.checked, p_voice_name: f.elements.voice.value.trim(),
                p_voice_notes: f.elements.notes.value.trim(), p_max: Number(f.elements.max.value) || 12 }));
            if (!error) { app.showToast('Assistant settings saved'); loadSettings(); }
        }
        btn.disabled = false;
        if (error) app.showToast(error.message || 'Couldn’t save that');
    });

    window.diaryHelpline = { html, refresh: () => { H.list = null; paint(); }, open: id => { H.view = 'all'; H.list = null; H.current = id; H.thread = null; if (window.diarySafety && window.diarySafety.showTab) window.diarySafety.showTab('helpline'); } };
});
