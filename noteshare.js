// Notes to a friend's Inbox, view-once like Snapchat — and note streaks you both share.
//  • Sending: diary_note_snap_send makes a sealed chat message (the text stays on the server).
//  • Opening: the recipient taps it once and reads it full screen; closing it wipes the text for good —
//    unless either of you taps "Save in chat", which keeps it in the conversation for both of you.
//  • Streaks: a day counts when you BOTH send each other a note (diary_note_streaks). Both of you see it,
//    in the inbox and the chat header; ⏳ means today still needs notes from one or both of you.
document.addEventListener('DOMContentLoaded', () => {
    const app = window.diaryApp;
    const social = window.diarySocial;
    if (!app || !social || !social.internals) return;
    const I = social.internals;
    const { client, state: s, esc, avatar } = I;
    if (!client) return;
    const ic = id => `<svg class="i"><use href="#${id}"/></svg>`;
    const COLOURS = ['yellow', 'pink', 'blue', 'green', 'purple', 'orange', 'coral', 'teal', 'sky', 'lime', 'gray'];
    const colourOf = c => (COLOURS.includes(c) ? c : 'purple');
    const tz = (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch (e) { return 'UTC'; } })();
    const first = name => String(name || 'your friend').split(' ')[0];
    const friendOf = id => (s.friends || []).find(f => f.id === id) || null;
    const me = () => (s.profile && s.profile.id) || null;

    // ---------- Streaks ----------
    let streaks = new Map();
    let loading = null;
    async function loadStreaks() {
        if (!me()) return streaks;
        if (loading) return loading;
        loading = (async () => {
            const { data, error } = await client.rpc('diary_note_streaks', { p_tz: tz });
            if (!error) streaks = new Map((data || []).map(r => [r.friend, r]));
            loading = null;
            return streaks;
        })();
        return loading;
    }
    async function refreshStreaks() {
        const before = JSON.stringify([...streaks.entries()]);
        await loadStreaks();
        if (JSON.stringify([...streaks.entries()]) !== before && app.state.view === 'messages') app.render();
    }
    setTimeout(refreshStreaks, 2500);
    setInterval(() => { if (!document.hidden) refreshStreaks(); }, 3 * 60000);
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') refreshStreaks(); });

    // 🔥 5 (and ⏳ when today still needs notes) — shown to both people
    function chip(id, where) {
        const st = streaks.get(id);
        if (!st || !st.streak) {
            // No streak yet, but they sent you a note today: nudge to send one back
            if (where === 'head' && st && st.they_sent_today && !st.sent_today) {
                return `<button type="button" class="ns-chip start ${where}" data-action="note-streak" data-id="${esc(id)}" title="Send a note back to start a streak">🔥 Start a streak</button>`;
            }
            return '';
        }
        const label = `${st.streak}-day note streak${st.at_risk ? ' — send a note today to keep it' : ''}`;
        const inner = `🔥 ${st.streak}${st.at_risk ? ' <span aria-hidden="true">⏳</span>' : ''}`;
        return where === 'head'
            ? `<button type="button" class="ns-chip ${where}${st.at_risk ? ' risk' : ''}" data-action="note-streak" data-id="${esc(id)}" aria-label="${esc(label)}" title="${esc(label)}">${inner}</button>`
            : `<span class="ns-chip ${where}${st.at_risk ? ' risk' : ''}" role="img" aria-label="${esc(label)}" title="${esc(label)}">${inner}</span>`;
    }

    // ---------- Cards in the chat ----------
    function cardHTML(a, ctx = {}) {
        const colour = colourOf(a.color);
        const mine = !!ctx.mine;
        // Older notes (sent before view-once) and saved notes show their text
        if (!a.once || a.saved) {
            const text = String(a.text || '');
            return `
                <div class="nsc open c-${colour}">
                    <button type="button" class="nsc-hit" ${a.once ? `data-action="note-snap-open" data-snap="${esc(a.snap)}"` : 'tabindex="-1"'} aria-label="Read the note"></button>
                    <span class="nsc-tag">${a.saved ? `${ic('i-bookmark-fill')}Saved in chat` : '📝 Shared a note'}</span>
                    ${a.title ? `<strong class="nsc-title">${esc(a.title)}</strong>` : ''}
                    <p class="nsc-text">${esc(text.length > 220 ? `${text.slice(0, 220)}…` : text)}</p>
                    <div class="nsc-actions">
                        ${a.once ? `<button type="button" class="nsc-btn" data-action="note-snap-save" data-snap="${esc(a.snap)}" data-save="0">Unsave</button>` : ''}
                        <button type="button" class="nsc-btn" data-action="note-save-shared" data-title="${esc(a.title || '')}" data-text="${esc(text)}" data-color="${esc(colour)}">${ic('i-plus')}My notes</button>
                    </div>
                </div>`;
        }
        if (mine) {
            const opened = !!a.opened_at;
            return `
                <div class="nsc sent${opened ? ' was-opened' : ''}">
                    <span class="nsc-glyph c-${colour}" aria-hidden="true">${ic('i-note-sealed')}</span>
                    <span class="nsc-line"><strong>You sent a note</strong><small>${opened ? `${ic('i-check')}Opened` : 'Delivered · view once'}</small></span>
                </div>`;
        }
        if (a.opened_at) {
            return `
                <div class="nsc gone">
                    <span class="nsc-glyph hollow" aria-hidden="true">${ic('i-note-sealed')}</span>
                    <span class="nsc-line"><strong>Note opened</strong><small>It was view once</small></span>
                </div>`;
        }
        return `
            <button type="button" class="nsc sealed c-${colour}" data-action="note-snap-open" data-snap="${esc(a.snap)}" aria-label="Open the note — view once">
                <span class="nsc-glyph" aria-hidden="true">${ic('i-note-sealed')}</span>
                <span class="nsc-line"><strong>New note</strong><small>Tap to open · view once</small></span>
                <span class="nsc-dot" aria-hidden="true"></span>
            </button>`;
    }

    // ---------- The viewer (full screen, like opening a snap) ----------
    const viewer = document.createElement('dialog');
    viewer.className = 'nsv';
    viewer.setAttribute('aria-labelledby', 'nsv-title');
    document.body.append(viewer);
    let V = null; // { snap, note, sender, saved }

    async function openSnap(snap) {
        if (!snap) return;
        const { data, error } = await client.rpc('diary_note_snap_open', { p_snap: snap });
        if (error) return app.showToast(/view-once|opened/i.test(error.message) ? 'This note was view once and has already been opened' : error.message || 'Couldn’t open that note');
        const from = data.sender === me() ? null : friendOf(data.sender);
        V = { snap, note: data, from, saved: !!data.saved };
        paintViewer();
        viewer.showModal();
        viewer.querySelector('.nsv-close').focus({ preventScroll: true });
    }

    function paintViewer() {
        const n = V.note;
        const colour = colourOf(n.color);
        viewer.className = `nsv c-${colour}`;
        viewer.innerHTML = `
            <div class="nsv-card">
                <header class="nsv-head">
                    ${V.from ? avatar(V.from, 'sm') : avatar({ id: me(), ...s.profile }, 'sm')}
                    <span class="nsv-who"><strong>${V.from ? esc(V.from.display_name) : 'You'}</strong><small>${V.saved ? 'Saved in chat' : 'View once'}</small></span>
                    <button type="button" class="nsv-close" data-nsv="close" aria-label="Close">${ic('i-close')}</button>
                </header>
                <div class="nsv-body">
                    ${n.title ? `<h2 id="nsv-title">${esc(n.title)}</h2>` : '<h2 id="nsv-title" class="sr-only">A note</h2>'}
                    <p>${esc(n.text || '').replace(/\n/g, '<br>')}</p>
                </div>
                <footer class="nsv-foot">
                    <button type="button" class="nsv-save${V.saved ? ' on' : ''}" data-nsv="save" aria-pressed="${V.saved}">${ic(V.saved ? 'i-bookmark-fill' : 'i-bookmark')}<span>${V.saved ? 'Saved in chat' : 'Save in chat'}</span></button>
                    <button type="button" class="nsv-mine" data-nsv="mine">${ic('i-plus')}<span>My notes</span></button>
                    <p class="nsv-hint">${V.saved ? 'Saved — you both can read it in the chat. Tap again to unsave.' : 'View once: this note disappears when you close it, unless one of you saves it in the chat.'}</p>
                </footer>
            </div>`;
    }

    async function closeViewer() {
        if (!V) return;
        const v = V;
        V = null;
        if (viewer.open) viewer.close();
        if (!v.saved && v.from) await client.rpc('diary_note_snap_close', { p_snap: v.snap });
        refreshStreaks();
    }

    async function setSaved(snap, save) {
        const { error } = await client.rpc('diary_note_snap_save', { p_snap: snap, p_save: save });
        if (error) { app.showToast(error.message || 'Couldn’t update that note'); return false; }
        return true;
    }

    viewer.addEventListener('click', async e => {
        const el = e.target.closest('[data-nsv]');
        if (!el || !V) { if (e.target === viewer) closeViewer(); return; }
        const what = el.dataset.nsv;
        if (what === 'close') closeViewer();
        else if (what === 'save') {
            el.disabled = true;
            if (await setSaved(V.snap, !V.saved)) {
                V.saved = !V.saved;
                app.showToast(V.saved ? 'Saved in chat — you both can see it 🔖' : 'Unsaved — it disappears when you close it');
                paintViewer();
            }
            el.disabled = false;
        } else if (what === 'mine') {
            await app.createEntry({ title: V.note.title || 'A note from a friend', text: V.note.text || '', color: colourOf(V.note.color) });
            el.disabled = true;
            el.innerHTML = `${ic('i-check')}<span>In your notes</span>`;
            app.showToast('Saved to your notes 📝');
        }
    });
    viewer.addEventListener('cancel', e => { e.preventDefault(); closeViewer(); });

    Object.assign(app.actions, {
        'note-snap-open': el => openSnap(el.dataset.snap),
        'note-snap-save': async el => {
            if (el.dataset.save === '0') {
                const ok = await app.ask({ title: 'Unsave this note?', text: 'It disappears from the chat for both of you.', ok: 'Unsave', danger: true });
                if (!ok) return;
            }
            if (await setSaved(el.dataset.snap, el.dataset.save === '1')) app.showToast(el.dataset.save === '1' ? 'Saved in chat 🔖' : 'Note unsaved');
        },
        'note-save-shared': async el => {
            const title = el.dataset.title || '';
            const text = el.dataset.text || '';
            if (!text && !title) return;
            await app.createEntry({ title: title || 'A note from a friend', text, color: el.dataset.color || null });
            el.disabled = true;
            el.innerHTML = `${ic('i-check')}In your notes`;
            app.showToast('Saved to your notes 📝');
        },
        // Tapping the streak in a chat: how it works, and a quick way to send today's note
        'note-streak': el => {
            const id = el.dataset.id;
            const f = friendOf(id);
            const st = streaks.get(id) || {};
            const name = first(f && f.display_name);
            const status = !st.streak ? `Send each other a note today to start a streak with ${name}.`
                : st.at_risk ? `${st.sent_today ? `Waiting for ${name}’s note today` : st.they_sent_today ? `${name} sent one — your turn` : 'You both need to send a note today'} to keep your ${st.streak}-day streak.`
                : `You’ve both sent a note today — your ${st.streak}-day streak is safe. 🔥`;
            app.openPopover(el, [
                { heading: st.streak ? `🔥 ${st.streak}-day note streak` : 'Note streaks' },
                { heading: status },
                { label: `Send ${name} a note`, icon: 'i-note', onClick: () => pickAndSend(el, id) }
            ]);
        }
    });

    // ---------- Sending ----------
    // From a chat: pick one of your notes and send it straight to this friend
    function pickAndSend(anchor, friendId) {
        const notes = (app.getNotes() || []).filter(n => !n.trashedAt && !n.private && n.origin !== 'post' && (String(n.text || '').trim() || String(n.title || '').trim()))
            .sort((a, b) => (b.updatedAt || b.createdAt || 0) - (a.updatedAt || a.createdAt || 0)).slice(0, 10);
        if (!notes.length) return app.showToast('Write a note first — then send it to keep your streak going');
        setTimeout(() => app.openPopover(anchor, [
            { heading: 'Send which note?' },
            ...notes.map(n => ({
                label: (n.title || String(n.text || '').slice(0, 40) || 'Untitled').slice(0, 48),
                icon: 'i-book',
                onClick: () => sendTo([friendId], { title: n.title, text: String(n.text || ''), color: n.color })
            }))
        ]), 0);
    }

    async function sendTo(ids, note, message = '') {
        const results = await Promise.all(ids.map(id => client.rpc('diary_note_snap_send', {
            p_recipient: id, p_title: String(note.title || '').slice(0, 120), p_text: String(note.text || '').slice(0, 3000),
            p_color: colourOf(note.color), p_message: message
        })));
        const failed = results.filter(r => r.error).length;
        if (failed === ids.length) { app.showToast((results[0].error && results[0].error.message) || 'Couldn’t send your note'); return false; }
        await loadStreaks();
        if (I.loadThread && s.activeFriend && ids.includes(s.activeFriend)) I.loadThread(s.activeFriend);
        if (app.state.view === 'messages') app.render();
        if (ids.length === 1) {
            const st = streaks.get(ids[0]) || {};
            const name = first((friendOf(ids[0]) || {}).display_name);
            app.showToast(st.streak && !st.at_risk ? `🔥 ${st.streak}-day streak with ${name} — safe for today!` : st.streak ? `Sent 📝 Now ${name} needs to send one back to keep your 🔥 ${st.streak}` : `Note sent to ${name} — view once 📝`);
        } else {
            app.showToast(`Note sent to ${ids.length - failed} friends 📝${failed ? ` (${failed} didn’t go through)` : ''}`);
        }
        return true;
    }

    // From a note's share sheet: pick friends
    const dlg = document.createElement('dialog');
    dlg.className = 'ask ns';
    dlg.setAttribute('aria-labelledby', 'ns-h');
    document.body.append(dlg);
    let N = null;

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
        box.innerHTML = list.length ? list.map(f => {
            const st = streaks.get(f.id) || {};
            return `
            <label class="ns-friend">
                <input type="checkbox" value="${esc(f.id)}"${N.picked.has(f.id) ? ' checked' : ''}>
                ${avatar(f, 'sm')}
                <span class="ns-who"><strong>${esc(f.display_name || f.username)}</strong><small>${st.streak ? (st.at_risk ? (st.sent_today ? 'Waiting for their note today' : 'Send today to keep it') : 'Safe for today') : `@${esc(f.username || '')}`}</small></span>
                ${chip(f.id, 'row')}
            </label>`;
        }).join('') : '<p class="muted ns-empty">No friends match.</p>';
        const btn = dlg.querySelector('[data-ns="send"]');
        btn.disabled = !N.picked.size;
        btn.textContent = N.picked.size > 1 ? `Send to ${N.picked.size} friends` : N.picked.size ? `Send to ${first((friendOf([...N.picked][0]) || {}).display_name)}` : 'Pick a friend';
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
        N = { note: { title: String(note.title || '').trim().slice(0, 120), text, color: colourOf(note.color) }, picked: new Set(), query: '' };
        dlg.innerHTML = `
            <form method="dialog" class="ns-form" novalidate>
                <header class="ns-head">
                    <h3 id="ns-h">Send to a friend’s Inbox</h3>
                    <button type="button" class="icon-btn" data-ns="close" aria-label="Close">${ic('i-close')}</button>
                </header>
                <div class="nsc sealed preview c-${N.note.color}" aria-hidden="true">
                    <span class="nsc-glyph">${ic('i-note-sealed')}</span>
                    <span class="nsc-line"><strong>${esc(N.note.title || 'Your note')}</strong><small>Arrives sealed · view once</small></span>
                </div>
                <ul class="ns-rules">
                    <li>👀 <span>They open it once — then it’s gone, unless one of you <strong>saves it in the chat</strong>.</span></li>
                    <li>🔥 <span>Send each other a note every day to grow your <strong>note streak</strong>. You both see it.</span></li>
                </ul>
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

    dlg.addEventListener('click', async e => {
        const el = e.target.closest('[data-ns]');
        if (!el) return;
        if (el.dataset.ns === 'close') dlg.close();
        else if (el.dataset.ns === 'send' && N && N.picked.size) {
            el.disabled = true;
            el.textContent = 'Sending…';
            const msg = String(dlg.querySelector('[data-ns="msg"]').value || '').trim();
            if (await sendTo([...N.picked], N.note, msg)) dlg.close();
            else paintList();
        }
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

    window.diaryNoteShare = { send, sendTo, cardHTML, chip, streaks: () => streaks, loadStreaks, open: openSnap };
});
