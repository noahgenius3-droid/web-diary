// Community group chat: a real-time conversation for each community, with voice calls, photos, live location,
// replies, pinned messages and moderation (announcement-only mode, slow mode, mutes, removing messages).
// Roles: owner > admin > moderator > member — the database enforces who may do what (see the migration).
document.addEventListener('DOMContentLoaded', () => {
    const app = window.diaryApp;
    const social = window.diarySocial;
    const C = window.diaryCommunities;
    if (!app || !social || !social.internals || !C) return;
    const I = social.internals;
    const { client, state: s, esc, avatar, timeAgo, hydrateStorage, uploadImage, randomId } = I;
    const $ = id => document.getElementById(id);
    const content = $('content');
    const BUCKET = 'diary-community';
    const ROLE = { owner: 'Owner', admin: 'Admin', moderator: 'Mod' };

    const g = {
        cid: null,
        messages: [],
        loading: false,
        error: false,
        channel: null,
        reply: null,          // message being replied to
        mutes: new Map(),     // user id -> until (ms)
        typing: new Map(),    // user id -> { name, until }
        typingBound: null,    // the presence channel we listen to for typing
        lastTypingSent: 0,
        sending: false,
        unseen: 0
    };

    window.diaryGroupChat = { html, refreshMutes };

    const me = () => s.profile.id;
    const cm = () => C.current();
    const myRole = () => (cm() ? C.role(cm().id) : null);
    const isStaff = () => ['owner', 'admin', 'moderator'].includes(myRole());
    const member = uid => C.members().find(m => m.user_id === uid);
    const personOf = uid => {
        if (uid === me()) return { id: uid, ...s.profile };
        const m = member(uid);
        return m && m.profile ? { id: uid, ...m.profile } : { id: uid, display_name: 'Former member', username: '' };
    };

    // ---------- Data ----------
    function ensure(community) {
        if (g.cid === community.id) return;
        teardown();
        Object.assign(g, { cid: community.id, messages: [], loading: true, error: false, reply: null, unseen: 0 });
        load();
        subscribe();
        refreshMutes();
        if (!C.members().length) C.loadMembers();
    }

    async function load() {
        const cid = g.cid;
        const { data, error } = await client.from('diary_community_messages')
            .select('id, community_id, author, body, attachments, reply_to, created_at, deleted_at, deleted_by')
            .eq('community_id', cid)
            .order('id', { ascending: false })
            .limit(150);
        if (g.cid !== cid) return;
        g.loading = false;
        g.error = !!error;
        g.messages = (data || []).reverse();
        paint({ stick: true });
    }

    async function refreshMutes() {
        const cid = g.cid;
        if (!cid) return;
        const { data } = await client.from('diary_community_mutes').select('user_id, until').eq('community_id', cid);
        if (g.cid !== cid) return;
        g.mutes = new Map((data || []).map(r => [r.user_id, Date.parse(r.until)]).filter(([, t]) => t > Date.now()));
        paintStatus();
    }

    function subscribe() {
        const cid = g.cid;
        g.channel = client.channel(`diary-gc-${cid}-${Math.random().toString(36).slice(2, 7)}`)
            .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'diary_community_messages', filter: `community_id=eq.${cid}` }, ({ new: m }) => {
                if (g.cid !== cid || g.messages.some(x => x.id === m.id)) return;
                g.messages.push(m);
                g.typing.delete(m.author);
                paint({ incoming: m.author !== me() });
            })
            .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'diary_community_messages', filter: `community_id=eq.${cid}` }, ({ new: m }) => {
                const i = g.messages.findIndex(x => x.id === m.id);
                if (i > -1) { g.messages[i] = { ...g.messages[i], ...m }; paint(); }
            })
            .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'diary_communities', filter: `id=eq.${cid}` }, ({ new: row }) => {
                const c = cm();
                if (!c || c.id !== cid) return;
                Object.assign(c, { pinned_message: row.pinned_message, chat_mode: row.chat_mode, slow_mode: row.slow_mode });
                paintPinned();
                paintStatus();
            })
            .on('postgres_changes', { event: '*', schema: 'public', table: 'diary_community_mutes', filter: `community_id=eq.${cid}` }, () => refreshMutes())
            .subscribe();
    }

    function teardown() {
        if (g.channel) client.removeChannel(g.channel);
        g.channel = null;
        g.cid = null;
        g.typing.clear();
    }

    // Leave the chat tab → stop listening
    const previousAfter = app.hooks.afterRender;
    app.hooks.afterRender = view => {
        if (previousAfter) previousAfter(view);
        const box = content.querySelector('.gc');
        if (!box) {
            if (g.cid) teardown();
            return;
        }
        bindTyping();
        paint({ stick: true });
        const input = $('gc-input');
        if (input && g.draft) input.value = g.draft;
    };

    // Typing goes over the community's presence channel (community.js opens it while the page is open)
    function bindTyping() {
        const ch = C.presenceChannel();
        if (!ch || g.typingBound === ch) return;
        g.typingBound = ch;
        try {
            ch.on('broadcast', { event: 'typing' }, ({ payload }) => {
                if (!payload || payload.id === me()) return;
                g.typing.set(payload.id, { name: payload.name, until: Date.now() + 4000 });
                paintTyping();
                setTimeout(paintTyping, 4200);
            });
        } catch (e) { /* older client: typing just won't show */ }
    }

    function sendTyping() {
        const ch = C.presenceChannel();
        if (!ch || Date.now() - g.lastTypingSent < 2500) return;
        g.lastTypingSent = Date.now();
        ch.send({ type: 'broadcast', event: 'typing', payload: { id: me(), name: s.profile.display_name.split(' ')[0] } });
    }

    // ---------- Screen ----------
    function html(community) {
        ensure(community);
        const members = C.members().length || (community.members && community.members[0] && community.members[0].count) || 0;
        const admin = ['owner', 'admin'].includes(myRole());
        return `
            <section class="gc" data-cid="${esc(community.id)}">
                <header class="gc-head">
                    <span class="gc-emoji" aria-hidden="true">${esc(community.emoji || '💬')}</span>
                    <div class="gc-title">
                        <strong>${esc(community.name)} chat</strong>
                        <small>${members} ${members === 1 ? 'member' : 'members'} · <span id="gc-online"></span></small>
                    </div>
                    ${window.diaryCalls ? '<button type="button" class="gc-call" data-action="gc-call" aria-label="Start or join the group voice call"><svg class="i"><use href="#i-phone"/></svg><span>Call</span></button>' : ''}
                    ${window.ChatWallpaper ? '<button type="button" class="icon-btn" data-action="gc-wallpaper" aria-label="Chat wallpaper" title="Wallpaper"><svg class="i"><use href="#i-palette"/></svg></button>' : ''}
                    ${admin ? '<button type="button" class="icon-btn" data-action="cm-chat-settings" aria-label="Chat settings" aria-haspopup="menu"><svg class="i"><use href="#i-settings"/></svg></button>' : ''}
                </header>
                <div class="gc-pinned" id="gc-pinned" hidden></div>
                <div class="gc-thread" id="gc-thread" role="log" aria-live="polite" aria-label="Messages"></div>
                <button type="button" class="gc-jump" id="gc-jump" data-action="gc-jump" hidden><svg class="i"><use href="#i-down"/></svg><span>New messages</span></button>
                <p class="gc-typing" id="gc-typing" aria-live="polite"></p>
                <p class="gc-status" id="gc-status" hidden></p>
                <form class="gc-compose" data-form="gc-send" id="gc-compose">
                    <div class="gc-reply" id="gc-reply" hidden></div>
                    <div class="gc-row">
                        <button type="button" class="gc-tool" data-action="gc-photo" aria-label="Send a photo"><svg class="i"><use href="#i-image"/></svg></button>
                        ${window.LiveLocation && window.LiveLocation.supported ? '<button type="button" class="gc-tool" data-action="gc-location" aria-label="Share your live location"><svg class="i"><use href="#i-pin"/></svg></button>' : ''}
                        <textarea id="gc-input" rows="1" maxlength="4000" placeholder="Message ${esc(community.name)}…" aria-label="Message" enterkeyhint="send"></textarea>
                        <button type="submit" class="gc-send" aria-label="Send"><svg class="i"><use href="#i-send"/></svg></button>
                    </div>
                </form>
            </section>`;
    }

    function dayLabel(d) {
        const today = new Date();
        const y = new Date(); y.setDate(today.getDate() - 1);
        if (d.toDateString() === today.toDateString()) return 'Today';
        if (d.toDateString() === y.toDateString()) return 'Yesterday';
        return d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
    }

    function messageHTML(m, prev) {
        const mine = m.author === me();
        const p = personOf(m.author);
        const role = (member(m.author) || {}).role;
        const grouped = prev && prev.author === m.author && !prev.deleted_at && Date.parse(m.created_at) - Date.parse(prev.created_at) < 5 * 60000
            && new Date(prev.created_at).toDateString() === new Date(m.created_at).toDateString();
        const time = new Date(m.created_at).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
        const pinned = cm() && cm().pinned_message === m.id;
        if (m.deleted_at) {
            return `<div class="gc-msg removed${mine ? ' mine' : ''}" data-mid="${m.id}"><span class="gc-bubble"><svg class="i"><use href="#i-trash"/></svg>${m.deleted_by && m.deleted_by !== m.author ? 'Removed by a moderator' : 'Message deleted'}</span></div>`;
        }
        const reply = m.reply_to ? g.messages.find(x => x.id === m.reply_to) : null;
        const atts = Array.isArray(m.attachments) ? m.attachments : [];
        const photos = atts.filter(a => a.kind === 'image' && a.path);
        const locations = atts.filter(a => a.kind === 'location' && a.id);
        return `
            <div class="gc-msg${mine ? ' mine' : ''}${grouped ? ' grouped' : ''}${pinned ? ' is-pinned' : ''}" data-mid="${m.id}">
                ${!mine ? `<span class="gc-av">${grouped ? '' : avatar(p, 'sm')}</span>` : ''}
                <div class="gc-col">
                    ${!mine && !grouped ? `<span class="gc-name">${esc(p.display_name)}${ROLE[role] ? `<span class="gc-role role-${role}">${ROLE[role]}</span>` : ''}</span>` : ''}
                    <div class="gc-bubble">
                        ${reply ? `<button type="button" class="gc-quote" data-action="gc-goto" data-id="${reply.id}"><strong>${esc(personOf(reply.author).display_name)}</strong><span>${esc(reply.deleted_at ? 'Message deleted' : (reply.body || (reply.attachments || []).length ? (reply.body || '📎 Attachment') : '')).slice(0, 120)}</span></button>` : ''}
                        ${photos.length ? `<div class="gc-photos n${Math.min(photos.length, 4)}">${photos.slice(0, 4).map(ph => `<button type="button" class="gc-photo" data-action="gc-view-photo" data-path="${esc(ph.path)}"><img data-path="${esc(ph.path)}" data-bucket="${BUCKET}" alt=""></button>`).join('')}</div>` : ''}
                        ${locations.map(a => window.LiveLocation ? window.LiveLocation.cardHTML(a, { mine, person: p }) : '<p>📍 Live location</p>').join('')}
                        ${m.body ? `<p class="gc-text">${I.linkTags ? I.linkTags(esc(m.body)) : esc(m.body)}</p>` : ''}
                        <span class="gc-meta">${pinned ? '<svg class="i"><use href="#i-pin-note"/></svg>' : ''}${time}</span>
                    </div>
                </div>
                <button type="button" class="gc-more" data-action="gc-menu" data-id="${m.id}" aria-label="Message options"><svg class="i"><use href="#i-more"/></svg></button>
            </div>`;
    }

    function threadHTML() {
        if (g.loading) return '<div class="gc-empty"><span class="lv-spinner" aria-hidden="true"></span><p>Loading the conversation…</p></div>';
        if (g.error) return '<div class="gc-empty"><p>Couldn’t load the chat.</p><button type="button" class="chip" data-action="gc-retry">Try again</button></div>';
        if (!g.messages.length) {
            return `<div class="gc-empty"><span class="gc-empty-emoji" aria-hidden="true">${esc((cm() && cm().emoji) || '👋')}</span><strong>Say hello to the group</strong><p>Messages here are seen by every member. Start a voice call, share a photo or your live location.</p></div>`;
        }
        let out = '';
        let lastDay = '';
        g.messages.forEach((m, i) => {
            const day = new Date(m.created_at).toDateString();
            if (day !== lastDay) {
                out += `<div class="gc-day"><span>${dayLabel(new Date(m.created_at))}</span></div>`;
                lastDay = day;
            }
            out += messageHTML(m, i > 0 && new Date(g.messages[i - 1].created_at).toDateString() === day ? g.messages[i - 1] : null);
        });
        return out;
    }

    function paint({ stick = false, incoming = false } = {}) {
        const thread = $('gc-thread');
        if (!thread) return;
        const near = thread.scrollHeight - thread.scrollTop - thread.clientHeight < 120;
        thread.innerHTML = threadHTML();
        hydrateStorage(thread);
        if (window.LiveLocation) window.LiveLocation.hydrate(thread);
        if (window.ChatWallpaper && !thread.dataset.wp) { thread.dataset.wp = '1'; window.ChatWallpaper.apply(thread, 'gc:' + g.cid); }
        if (stick || near || !incoming) {
            thread.scrollTop = thread.scrollHeight;
            g.unseen = 0;
        } else {
            g.unseen++;
        }
        const jump = $('gc-jump');
        if (jump) {
            jump.hidden = !g.unseen;
            jump.querySelector('span').textContent = g.unseen === 1 ? '1 new message' : `${g.unseen} new messages`;
        }
        paintPinned();
        paintStatus();
        paintReply();
        paintTyping();
        const online = $('gc-online');
        if (online) {
            const here = (C.presenceChannel() && Object.keys(C.presenceChannel().presenceState() || {}).length) || 1;
            online.textContent = `${here} here now`;
        }
    }

    function paintPinned() {
        const box = $('gc-pinned');
        if (!box || !cm()) return;
        const id = cm().pinned_message;
        const m = id && g.messages.find(x => x.id === id);
        box.hidden = !m;
        if (!m) return;
        box.innerHTML = `
            <button type="button" class="gc-pin-open" data-action="gc-goto" data-id="${m.id}">
                <svg class="i"><use href="#i-pin-note"/></svg>
                <span><strong>Pinned by the moderators</strong><small>${esc(m.body || '📎 Attachment').slice(0, 140)}</small></span>
            </button>
            ${isStaff() ? `<button type="button" class="icon-btn" data-action="gc-unpin" aria-label="Unpin"><svg class="i"><use href="#i-close"/></svg></button>` : ''}`;
    }

    // Why you can't post right now (announcements only / muted / slow mode)
    function paintStatus() {
        const el = $('gc-status');
        const form = $('gc-compose');
        if (!el || !form || !cm()) return;
        const c = cm();
        let msg = '';
        let blocked = false;
        const mutedUntil = g.mutes.get(me());
        if (!isStaff()) {
            if (c.chat_mode === 'staff') { msg = 'Only admins and moderators can post here right now.'; blocked = true; }
            else if (mutedUntil && mutedUntil > Date.now()) { msg = `A moderator muted you until ${new Date(mutedUntil).toLocaleString(undefined, { hour: 'numeric', minute: '2-digit', weekday: 'short' })}.`; blocked = true; }
            else if (c.slow_mode) msg = `Slow mode is on: one message every ${c.slow_mode} seconds.`;
        } else if (c.chat_mode === 'staff') {
            msg = 'Announcements only — members can read but not reply.';
        }
        el.hidden = !msg;
        el.textContent = msg;
        form.classList.toggle('locked', blocked);
        form.querySelectorAll('textarea, button').forEach(b => { b.disabled = blocked; });
    }

    function paintReply() {
        const box = $('gc-reply');
        if (!box) return;
        box.hidden = !g.reply;
        if (!g.reply) return;
        box.innerHTML = `<span><strong>Replying to ${esc(personOf(g.reply.author).display_name)}</strong><small>${esc((g.reply.body || '📎 Attachment').slice(0, 100))}</small></span>
            <button type="button" class="icon-btn" data-action="gc-cancel-reply" aria-label="Cancel reply"><svg class="i"><use href="#i-close"/></svg></button>`;
    }

    function paintTyping() {
        const el = $('gc-typing');
        if (!el) return;
        const now = Date.now();
        const names = [...g.typing.entries()].filter(([, t]) => t.until > now).map(([, t]) => t.name);
        el.textContent = !names.length ? '' : names.length === 1 ? `${names[0]} is typing…` : names.length === 2 ? `${names[0]} and ${names[1]} are typing…` : 'Several people are typing…';
    }

    // ---------- Sending ----------
    async function send(body, attachments = []) {
        if (!g.cid || g.sending) return false;
        g.sending = true;
        const row = { community_id: g.cid, body: body.slice(0, 4000), attachments, reply_to: g.reply ? g.reply.id : null };
        const { data, error } = await client.from('diary_community_messages').insert(row)
            .select('id, community_id, author, body, attachments, reply_to, created_at, deleted_at, deleted_by').single();
        g.sending = false;
        if (error) {
            const c = cm();
            app.showToast(c && c.chat_mode === 'staff' && !isStaff() ? 'Only admins and moderators can post right now'
                : g.mutes.get(me()) > Date.now() ? 'You’re muted in this chat for now'
                : c && c.slow_mode ? `Slow mode: wait ${c.slow_mode}s between messages`
                : 'Couldn’t send that — check your connection');
            return false;
        }
        if (!g.messages.some(x => x.id === data.id)) g.messages.push(data);
        g.reply = null;
        paint({ stick: true });
        return true;
    }

    content.addEventListener('submit', async e => {
        const form = e.target.closest('form[data-form="gc-send"]');
        if (!form) return;
        e.preventDefault();
        const input = $('gc-input');
        const body = input.value.trim();
        if (!body) return;
        input.value = '';
        g.draft = '';
        autosize(input);
        if (!(await send(body))) {
            input.value = body;
            autosize(input);
        }
    });

    content.addEventListener('keydown', e => {
        if (e.target.id !== 'gc-input' || e.key !== 'Enter' || e.shiftKey || e.isComposing) return;
        e.preventDefault();
        e.target.form.requestSubmit();
    });

    content.addEventListener('input', e => {
        if (e.target.id !== 'gc-input') return;
        g.draft = e.target.value;
        autosize(e.target);
        if (e.target.value.trim()) sendTyping();
    });

    content.addEventListener('scroll', e => {
        if (e.target.id !== 'gc-thread') return;
        const t = e.target;
        if (t.scrollHeight - t.scrollTop - t.clientHeight < 60 && g.unseen) {
            g.unseen = 0;
            const jump = $('gc-jump');
            if (jump) jump.hidden = true;
        }
    }, true);

    function autosize(t) {
        t.style.height = 'auto';
        t.style.height = `${Math.min(t.scrollHeight, 140)}px`;
    }

    function flash(id) {
        const el = content.querySelector(`.gc-msg[data-mid="${id}"]`);
        if (!el) return app.showToast('That message is further back');
        el.scrollIntoView({ block: 'center', behavior: 'smooth' });
        el.classList.add('flash');
        setTimeout(() => el.classList.remove('flash'), 1600);
    }

    // ---------- Actions ----------
    Object.assign(app.actions, {
        'gc-call': () => C.joinCall(),
        'gc-wallpaper': () => {
            if (!window.ChatWallpaper || !g.cid) return;
            window.ChatWallpaper.open('gc:' + g.cid, { label: cm() ? cm().name : '', onDone: () => window.ChatWallpaper.apply(document.getElementById('gc-thread'), 'gc:' + g.cid) });
        },
        'gc-retry': () => { g.loading = true; g.error = false; paint(); load(); },
        'gc-jump': () => {
            const t = $('gc-thread');
            if (t) t.scrollTo({ top: t.scrollHeight, behavior: 'smooth' });
            g.unseen = 0;
            $('gc-jump').hidden = true;
        },
        'gc-goto': el => flash(Number(el.dataset.id)),
        'gc-cancel-reply': () => { g.reply = null; paintReply(); },
        'gc-unpin': async () => {
            const { error } = await client.rpc('diary_pin_community_message', { cid: g.cid, mid: null });
            if (error) return app.showToast('Couldn’t unpin that');
            cm().pinned_message = null;
            paint();
        },
        'gc-photo': async () => {
            const files = await Media.pickFiles('image/*', true);
            if (!files.length) return;
            app.showToast('Sending photo…');
            const paths = [];
            for (const original of files.slice(0, 4)) {
                let file = await Media.compressImage(original);
                if (window.PhotoEditor && files.length === 1 && file.type !== 'image/gif') {
                    const edited = await window.PhotoEditor.open(file, { title: 'Send photo', done: 'Send' });
                    if (!edited) return;
                    file = edited;
                }
                const path = await uploadImage(BUCKET, `${g.cid}/${me()}/${randomId()}`, file);
                if (path) paths.push({ kind: 'image', path });
            }
            if (!paths.length) return app.showToast('Couldn’t upload that photo');
            await send($('gc-input') ? $('gc-input').value.trim() : '', paths);
            if ($('gc-input')) $('gc-input').value = '';
        },
        'gc-location': async () => {
            if (!window.LiveLocation) return;
            const att = await window.LiveLocation.share({ communityId: g.cid });
            if (att) send('', [att]);
        },
        'gc-view-photo': el => {
            const entry = s.urls.get(`${BUCKET}:${el.dataset.path}`);
            if (!entry) return;
            if (window.ZoomViewer) window.ZoomViewer.open([entry.url], { origin: el.querySelector('img') });
            else Media.lightbox(entry.url);
        },
        'gc-menu': el => {
            const m = g.messages.find(x => x.id === Number(el.dataset.id));
            if (!m || m.deleted_at) return;
            const mine = m.author === me();
            const authorRole = (member(m.author) || {}).role || 'member';
            const rank = { owner: 3, admin: 2, moderator: 1, member: 0 };
            const canRemove = mine || (isStaff() && rank[myRole()] > rank[authorRole]);
            const pinned = cm().pinned_message === m.id;
            const items = [
                { label: 'Reply', icon: 'i-reply', onClick: () => { g.reply = m; paintReply(); $('gc-input') && $('gc-input').focus(); } }
            ];
            if (m.body) items.push({ label: 'Copy text', icon: 'i-file', onClick: () => navigator.clipboard.writeText(m.body).then(() => app.showToast('Copied'), () => {}) });
            if (m.body && window.Speak && window.Speak.supported) items.push({ label: 'Listen', icon: 'i-volume', onClick: () => window.Speak.read(m.body, { title: `${personOf(m.author).display_name} in ${cm().name}` }) });
            if (isStaff()) items.push({ label: pinned ? 'Unpin' : 'Pin for everyone', icon: 'i-pin-note', onClick: async () => {
                const { error } = await client.rpc('diary_pin_community_message', { cid: g.cid, mid: pinned ? null : m.id });
                if (error) return app.showToast('Couldn’t pin that');
                cm().pinned_message = pinned ? null : m.id;
                paint();
                app.showToast(pinned ? 'Unpinned' : 'Pinned to the top of the chat');
            } });
            if (isStaff() && !mine && authorRole === 'member') {
                items.push({ label: 'Mute them for 1 hour', icon: 'i-volume-off', onClick: async () => {
                    const { error } = await client.rpc('diary_mute_member', { cid: g.cid, target: m.author, minutes: 60 });
                    app.showToast(error ? 'Couldn’t mute them' : `${personOf(m.author).display_name.split(' ')[0]} is muted for an hour`);
                    refreshMutes();
                } });
            }
            if (canRemove) items.push({ label: mine ? 'Delete message' : 'Remove message', icon: 'i-trash', danger: true, onClick: async () => {
                const ok = await app.ask({ title: mine ? 'Delete this message?' : 'Remove this message?', text: mine ? 'It’s removed for everyone.' : 'It’s removed for everyone, and shows as removed by a moderator.', ok: mine ? 'Delete' : 'Remove', danger: true });
                if (!ok) return;
                const { error } = await client.rpc('diary_delete_community_message', { mid: m.id });
                if (error) return app.showToast('Couldn’t remove that message');
                Object.assign(m, { deleted_at: new Date().toISOString(), deleted_by: me(), body: '', attachments: [] });
                if (cm().pinned_message === m.id) cm().pinned_message = null;
                paint();
            } });
            app.openPopover(el, items);
        }
    });

    // Long-press a message on a phone opens its menu
    let press = null;
    content.addEventListener('pointerdown', e => {
        const msg = e.target.closest('.gc-msg');
        if (!msg || e.pointerType === 'mouse' || e.target.closest('button, a')) return;
        press = setTimeout(() => {
            const more = msg.querySelector('.gc-more');
            if (more) { if (navigator.vibrate) navigator.vibrate(10); more.click(); }
        }, 480);
    });
    ['pointerup', 'pointercancel', 'pointermove'].forEach(t => content.addEventListener(t, () => clearTimeout(press)));
});
