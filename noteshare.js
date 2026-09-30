// Send a note straight to a friend's Inbox — privately, without posting it — and keep a note streak going.
// A note travels as a chat message with a { kind: 'note', title, text, color } attachment. Sending one a day
// (either of you) keeps the streak alive; the server counts it (diary_note_streaks).
document.addEventListener('DOMContentLoaded', () => {
    const app = window.diaryApp;
    const social = window.diarySocial;
    if (!app || !social || !social.internals) return;
    const I = social.internals;
    const { client, state: s, esc, avatar } = I;
    if (!client) return;
    const ic = id => `<svg class="i"><use href="#${id}"/></svg>`;
    const MAX_TEXT = 1500;
    const COLOURS = ['yellow', 'pink', 'blue', 'green', 'purple', 'orange', 'coral', 'teal', 'sky', 'lime', 'gray'];
    const tz = (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch (e) { return 'UTC'; } })();
    const first = name => String(name || 'your friend').split(' ')[0];

    let streaks = new Map();
    async function loadStreaks() {
        const { data, error } = await client.rpc('diary_note_streaks', { p_tz: tz });
        if (!error) streaks = new Map((data || []).map(r => [r.friend, r]));
        return streaks;
    }

    function streakBadge(id) {
        const st = streaks.get(id);
        if (!st || !st.streak) return '';
        const due = !st.sent_today;
        return `<span class="ns-streak${due ? ' due' : ''}" title="${st.streak}-day note streak${due ? ' — send one today to keep it' : ''}">🔥 ${st.streak}${due ? ' <small>send today</small>' : ''}</span>`;
    }

    // ---------- The note card in a chat ----------
    function cardHTML(a) {
        const colour = COLOURS.includes(a.color) ? a.color : 'purple';
        const text = String(a.text || '');
        const short = text.length > 220;
        return `
            <div class="msg-note c-${colour}">
                <span class="msg-note-tag">📝 Shared a note</span>
                ${a.title ? `<strong class="msg-note-title">${esc(a.title)}</strong>` : ''}
                ${short
                    ? `<p class="msg-note-text">${esc(text.slice(0, 220))}…</p><details class="msg-note-more"><summary>Read the whole note</summary><p class="msg-note-text">${esc(text)}</p></details>`
                    : `<p class="msg-note-text">${esc(text)}</p>`}
                <button type="button" class="msg-note-save" data-action="note-save-shared" data-title="${esc(a.title || '')}" data-text="${esc(text)}" data-color="${esc(colour)}">${ic('i-plus')}Save to my notes</button>
            </div>`;
    }

    app.actions['note-save-shared'] = async el => {
        const title = el.dataset.title || '';
        const text = el.dataset.text || '';
        if (!text && !title) return;
        await app.createEntry({ title: title || 'A note from a friend', text, color: el.dataset.color || null });
        el.disabled = true;
        el.innerHTML = `${ic('i-check')}Saved to your notes`;
        app.showToast('Saved to your notes 📝');
    };

    // ---------- Picking friends and sending ----------
    const dlg = document.createElement('dialog');
    dlg.className = 'ask ns';
    dlg.setAttribute('aria-labelledby', 'ns-h');
    document.body.append(dlg);
    let N = null; // { note, picked:Set, query }

    function friendsList() {
        const q = (N.query || '').toLowerCase();
        return (s.friends || [])
            .filter(f => !q || `${f.display_name} ${f.username}`.toLowerCase().includes(q))
            .sort((a, b) => ((streaks.get(b.id) || {}).streak || 0) - ((streaks.get(a.id) || {}).streak || 0) || String(a.display_name).localeCompare(String(b.display_name)));
    }

    function paintList() {
        const box = dlg.querySelector('.ns-list');
        if (!box) return;
        const list = friendsList();
        box.innerHTML = list.length ? list.map(f => `
            <label class="ns-friend">
                <input type="checkbox" value="${esc(f.id)}"${N.picked.has(f.id) ? ' checked' : ''}>
                ${avatar(f, 'sm')}
                <span class="ns-who"><strong>${esc(f.display_name || f.username)}</strong><small>@${esc(f.username || '')}</small></span>
                ${streakBadge(f.id)}
            </label>`).join('') : '<p class="muted ns-empty">No friends match.</p>';
        const btn = dlg.querySelector('[data-ns="send"]');
        btn.disabled = !N.picked.size;
        btn.textContent = N.picked.size > 1 ? `Send to ${N.picked.size} friends` : N.picked.size ? `Send to ${first((s.friends.find(f => N.picked.has(f.id)) || {}).display_name)}` : 'Pick a friend';
    }

    async function send(note) {
        if (!(social.isSignedIn && social.isSignedIn())) return I.openAuth && I.openAuth('Sign in to send notes to your friends.', 'signin');
        if (social.isGuest && social.isGuest()) return I.openUpgrade && I.openUpgrade();
        const text = String(note.text || '').trim();
        if (!text && !String(note.title || '').trim()) return app.showToast('Write something in the note first');
        if (!(s.friends || []).length) {
            if (I.loadFriends) await I.loadFriends();
            if (!(s.friends || []).length) return app.showToast('Add a friend first — then you can send them notes');
        }
        N = { note: { title: String(note.title || '').trim().slice(0, 120), text, color: note.color }, picked: new Set(), query: '' };
        dlg.innerHTML = `
            <form method="dialog" class="ns-form" novalidate>
                <header class="ns-head">
                    <h3 id="ns-h">Send to a friend’s Inbox</h3>
                    <button type="button" class="icon-btn" data-ns="close" aria-label="Close">${ic('i-close')}</button>
                </header>
                <div class="ns-preview">${cardHTML({ ...N.note, text: text.slice(0, 220) + (text.length > 220 ? '…' : '') }).replace(/<button[\s\S]*?<\/button>/, '')}</div>
                <p class="ns-rule">🔥 Send each other a note every day to build a <strong>note streak</strong>. Only the friends you pick see it.</p>
                ${(s.friends || []).length > 6 ? '<label class="search ns-search"><svg class="i"><use href="#i-search"/></svg><input type="search" data-ns="q" placeholder="Search friends" aria-label="Search friends" autocomplete="off"></label>' : ''}
                <div class="ns-list" role="group" aria-label="Friends"></div>
                <label class="field ns-msg"><span>Add a message <small>(optional)</small></span><input data-ns="msg" maxlength="300" placeholder="Thought of you when I wrote this…" autocomplete="off"></label>
                <div class="ask-actions">
                    <button type="button" class="ghost-btn" data-ns="close">Cancel</button>
                    <button type="button" class="primary-btn" data-ns="send" disabled>Pick a friend</button>
                </div>
            </form>`;
        paintList();
        if (!dlg.open) dlg.showModal();
        await loadStreaks();
        if (dlg.open) paintList();
    }

    async function sendNow(btn) {
        const ids = [...N.picked];
        if (!ids.length) return;
        btn.disabled = true;
        btn.textContent = 'Sending…';
        const msg = String(dlg.querySelector('[data-ns="msg"]').value || '').trim();
        const att = { kind: 'note', title: N.note.title, text: N.note.text.slice(0, MAX_TEXT), color: N.note.color || 'purple' };
        const results = await Promise.all(ids.map(id => client.from('diary_messages').insert({
            recipient: id, body: msg ? `<p>${esc(msg)}</p>` : '', attachments: [att], client_id: I.randomId()
        })));
        const failed = results.filter(r => r.error).length;
        if (failed === ids.length) {
            btn.disabled = false;
            paintList();
            return app.showToast('Couldn’t send your note — check your connection');
        }
        dlg.close();
        await loadStreaks();
        if (ids.length === 1) {
            const f = s.friends.find(x => x.id === ids[0]) || {};
            const st = streaks.get(ids[0]);
            app.showToast(st && st.streak >= 2 ? `🔥 ${st.streak}-day note streak with ${first(f.display_name)}!` : `Note sent to ${first(f.display_name)} 📝`);
        } else {
            app.showToast(`Note sent to ${ids.length - failed} friends 📝${failed ? ` (${failed} didn’t go through)` : ''}`);
        }
    }

    dlg.addEventListener('click', e => {
        const el = e.target.closest('[data-ns]');
        if (!el) return;
        if (el.dataset.ns === 'close') dlg.close();
        else if (el.dataset.ns === 'send') sendNow(el);
    });
    dlg.addEventListener('change', e => {
        if (e.target.type !== 'checkbox' || !N) return;
        if (e.target.checked) N.picked.add(e.target.value); else N.picked.delete(e.target.value);
        paintList();
    });
    dlg.addEventListener('input', e => {
        if (e.target.dataset.ns !== 'q' || !N) return;
        N.query = e.target.value.trim();
        paintList();
    });

    window.diaryNoteShare = { send, cardHTML, streaks: () => streaks, loadStreaks };
});
