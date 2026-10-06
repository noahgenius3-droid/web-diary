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
    const GC_COLS = 'id, community_id, author, body, attachments, reply_to, created_at, deleted_at, deleted_by, edited_at, restored_at, forwarded, client_id';

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
        unseen: 0,
        editing: null,       // message being edited
        reacts: new Map(),   // message id -> { emoji: [user ids] }
        pendingJump: null,   // { cid, id } from a message link or a mention
        rec: null            // voice note being recorded
    };

    window.diaryGroupChat = {
        html, refreshMutes,
        // Open a community's chat at one message (from a mention or reply notification)
        jump(cid, id) {
            if (g.cid === cid && !g.loading) return jumpTo(Number(id));
            g.pendingJump = { cid, id: Number(id) };
            C.showChat(cid);
        }
    };

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
        Object.assign(g, { cid: community.id, messages: [], loading: true, error: false, reply: null, unseen: 0, reacts: new Map() });
        load();
        subscribe();
        refreshMutes();
        if (!C.members().length) C.loadMembers();
    }

    async function load() {
        const cid = g.cid;
        const { data, error } = await client.from('diary_community_messages')
            .select(GC_COLS)
            .eq('community_id', cid)
            .order('id', { ascending: false })
            .limit(150);
        if (g.cid !== cid) return;
        g.loading = false;
        g.error = !!error;
        g.messages = (data || []).reverse();
        paint({ stick: true });
        loadReactions(g.messages.map(m => m.id));
        if (g.pendingJump && g.pendingJump.cid === cid) {
            const j = g.pendingJump;
            g.pendingJump = null;
            jumpTo(j.id);
        }
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
            .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'diary_community_message_reactions' }, ({ new: r }) => {
                if (g.cid !== cid || !g.messages.some(m => m.id === r.message_id)) return;
                addReact(r);
                paint();
            })
            .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'diary_community_message_reactions' }, ({ old: r }) => {
                if (g.cid !== cid || !r || !r.message_id) return;
                dropReact(r);
                paint();
            })
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
    app.hooks.afterRender = (view, how = {}) => {
        if (previousAfter) previousAfter(view, how);
        const box = content.querySelector('.gc');
        if (!box) {
            if (g.cid) teardown();
            return;
        }
        bindTyping();
        paint({ stick: !how.repaint });
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
        try { ch.send({ type: 'broadcast', event: 'typing', payload: { id: me(), name: s.profile.display_name.split(' ')[0] } }); } catch (e) { /* a typing hint must never stop a message */ }
    }

    // ---------- Screen ----------
    function html(community) {
        ensure(community);
        const members = C.members().length || (community.members && community.members[0] && community.members[0].count) || 0;
        const admin = ['owner', 'admin'].includes(myRole());
        return `
            <section class="gc" data-cid="${esc(community.id)}">
                <header class="gc-head">
                    <button type="button" class="icon-btn gc-back" data-action="gc-back" aria-label="Back to the group" title="Back to the group"><svg class="i"><use href="#i-chevron-left"/></svg></button>
                    <span class="gc-emoji" aria-hidden="true">${esc(community.emoji || '💬')}</span>
                    <div class="gc-title" role="button" tabindex="0" data-action="gc-info" aria-label="Group info">
                        <strong>${esc(community.name)}</strong>
                        <small>${members} ${members === 1 ? 'member' : 'members'}<span class="gc-online-wrap"> · <span id="gc-online"></span></span></small>
                    </div>
                    ${window.diaryCalls ? '<button type="button" class="icon-btn gc-hbtn" data-action="gc-call-voice" aria-label="Voice call with the group" title="Voice call"><svg class="i"><use href="#i-phone"/></svg></button><button type="button" class="icon-btn gc-hbtn" data-action="gc-call-video" aria-label="Video call with the group" title="Video call"><svg class="i"><use href="#i-video"/></svg></button>' : ''}
                    <button type="button" class="icon-btn head-wide" data-action="gc-search" aria-label="Search this group chat" title="Search"><svg class="i"><use href="#i-search"/></svg></button>
                    <button type="button" class="icon-btn gc-more-btn" data-action="gc-head-more" data-admin="${admin ? 1 : ''}" aria-label="More options" title="More" aria-haspopup="menu"><svg class="i"><use href="#i-more"/></svg></button>
                </header>
                <div class="gc-pinned" id="gc-pinned" hidden></div>
                <div class="gc-thread" id="gc-thread" role="log" aria-live="polite" aria-label="Messages"></div>
                <button type="button" class="gc-jump" id="gc-jump" data-action="gc-jump" hidden><svg class="i"><use href="#i-down"/></svg><span>New messages</span></button>
                <p class="gc-typing" id="gc-typing" aria-live="polite"></p>
                <p class="gc-status" id="gc-status" hidden></p>
                <form class="gc-compose" data-form="gc-send" id="gc-compose">
                    <div class="gc-reply" id="gc-reply" hidden></div>
                    <div class="gc-row">
                        <button type="button" class="gc-tool gc-plus" data-action="gc-attach" aria-label="Add a photo, location or contact" aria-haspopup="menu"><svg class="i"><use href="#i-plus"/></svg></button>
                        <div class="gc-rec" id="gc-rec" hidden aria-live="polite">
                            <button type="button" class="gc-tool" data-action="gc-rec-cancel" aria-label="Delete recording"><svg class="i"><use href="#i-trash"/></svg></button>
                            <span class="rec-dot" aria-hidden="true"></span><span class="gc-rec-time" id="gc-rec-time">0:00</span>
                            <span class="gc-rec-wave" id="gc-rec-wave" aria-hidden="true"></span>
                        </div>
                        ${window.CordialStickers ? '<button type="button" class="gc-tool gc-stk" data-action="gc-sticker" data-sticker-toggle aria-label="Stickers" title="Stickers"><svg class="i"><use href="#i-sticker"/></svg></button>' : ''}
                        <textarea id="gc-input" rows="1" maxlength="4000" placeholder="Message ${esc(community.name)}…" aria-label="Message" enterkeyhint="send"></textarea>
                        <button type="button" class="gc-tool gc-mic" id="gc-mic" data-action="gc-mic" aria-label="Record a voice note"><svg class="i"><use href="#i-mic"/></svg></button>
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
            return `<div class="gc-msg removed${mine ? ' mine' : ''}" data-mid="${m.id}"><span class="gc-bubble"><svg class="i"><use href="#i-trash"/></svg>${m.deleted_by && m.deleted_by !== m.author ? 'Removed by a moderator' : 'Message deleted'}</span><button type="button" class="gc-more" data-action="gc-menu" data-id="${m.id}" aria-label="Message options"><svg class="i"><use href="#i-more"/></svg></button></div>`;
        }
        const reply = m.reply_to ? g.messages.find(x => x.id === m.reply_to) : null;
        const atts = Array.isArray(m.attachments) ? m.attachments : [];
        const photos = atts.filter(a => a.kind === 'image' && a.path);
        const locations = atts.filter(a => a.kind === 'location' && a.id);
        const voices = atts.filter(a => a.kind === 'audio' && a.path);
        const contacts = atts.filter(a => a.kind === 'contact' && a.id);
        const videos = atts.filter(a => a.kind === 'video' && a.path);
        const stickers = atts.filter(a => a.kind === 'sticker');
        const stickerOnly = !m.body && stickers.length === 1 && atts.length === 1;
        return `
            <div class="gc-msg${mine ? ' mine' : ''}${grouped ? ' grouped' : ''}${stickerOnly ? ' sticker-msg' : ''}${pinned ? ' is-pinned' : ''}${!mine && m.body && s.profile && new RegExp(`@(${s.profile.username}|everyone|all)\\b`, 'i').test(m.body) ? ' mentions-me' : ''}" data-mid="${m.id}">
                ${!mine ? `<span class="gc-av">${grouped ? '' : `<button type="button" class="gc-who" data-profile="${esc(m.author)}" aria-label="View ${esc(p.display_name)}’s profile">${avatar(p, 'sm')}</button>`}</span>` : ''}
                <div class="gc-col">
                    ${!mine && !grouped ? `<span class="gc-name"><button type="button" class="gc-who-name" data-profile="${esc(m.author)}">${esc(p.display_name)}</button>${ROLE[role] ? `<span class="gc-role role-${role}">${ROLE[role]}</span>` : ''}</span>` : ''}
                    <div class="gc-bubble">
                        ${m.forwarded ? '<span class="msg-forwarded"><svg class="i"><use href="#i-forward"/></svg>Forwarded</span>' : ''}
                        ${reply ? `<button type="button" class="gc-quote" data-action="gc-goto" data-id="${reply.id}"><strong>${esc(personOf(reply.author).display_name)}</strong><span>${esc(reply.deleted_at ? 'Message deleted' : (reply.body || (reply.attachments || []).length ? (reply.body || '📎 Attachment') : '')).slice(0, 120)}</span></button>` : ''}
                        ${videos.map(v => (I.videoHTML ? I.videoHTML(v) : '').replace(/data-src-path=/, `data-bucket="${BUCKET}" data-src-path=`).replace(/<img data-path=/, `<img data-bucket="${BUCKET}" data-path=`)).join('')}
                        ${photos.length ? `<div class="gc-photos n${Math.min(photos.length, 4)}">${photos.slice(0, 4).map(ph => `<button type="button" class="gc-photo" data-action="gc-view-photo" data-path="${esc(ph.path)}"><img data-path="${esc(ph.path)}" data-bucket="${BUCKET}" alt=""></button>`).join('')}</div>` : ''}
                        ${window.CordialStickers ? stickers.map(window.CordialStickers.html).join('') : ''}
                        ${voices.map(a => I.voiceHTML(a, BUCKET)).join('')}
                        ${I.contactCardHTML ? contacts.map(I.contactCardHTML).join('') : ''}
                        ${locations.map(a => window.LiveLocation ? window.LiveLocation.cardHTML(a, { mine, person: p }) : '<p>📍 Live location</p>').join('')}
                        ${m.body ? `<p class="gc-text">${withMentions(I.linkTags ? I.linkTags(esc(m.body)) : esc(m.body))}</p>` : ''}
                        <span class="gc-meta">${I.editedTag ? I.editedTag('gc', m) : ''}${pinned ? '<svg class="i"><use href="#i-pin-note"/></svg>' : ''}${time}</span>
                    </div>
                    ${reactsHTML(m)}
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
        const keepTop = thread.scrollTop;
        thread.innerHTML = threadHTML();
        hydrateStorage(thread);
        if (window.LiveLocation) window.LiveLocation.hydrate(thread);
        const box = thread.closest('.gc');
        if (window.ChatWallpaper && box && !box.dataset.wp) { box.dataset.wp = '1'; window.ChatWallpaper.apply(box, 'gc:' + g.cid); }
        if (stick || near) {
            thread.scrollTop = thread.scrollHeight;
            g.unseen = 0;
        } else {
            thread.scrollTop = keepTop; // reading older messages: stay put
            if (incoming) g.unseen++;
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
        if (g.editing) {
            box.hidden = false;
            box.innerHTML = `<span><strong>Editing message</strong><small>${esc((g.editing.body || '').slice(0, 100))}</small></span>
                <button type="button" class="icon-btn" data-action="gc-cancel-edit" aria-label="Cancel editing"><svg class="i"><use href="#i-close"/></svg></button>`;
            return;
        }
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
        const row = { community_id: g.cid, body: body.slice(0, 4000), attachments, reply_to: g.reply ? g.reply.id : null, client_id: randomId() };
        let data = null, error = null;
        try {
            ({ data, error } = await client.from('diary_community_messages').insert(row).select(GC_COLS).single());
        } catch (e) {
            error = e; // never leave the chat stuck in "sending"
        } finally {
            g.sending = false;
        }
        if (!error && !data) error = new Error('no row');
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
        if (g.rec) return finishRecording(true);
        const body = input.value.trim();
        if (g.editing) return saveEdit(body);
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
        paintMentions();
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

    // ---------- Reactions ----------
    // g.reacts: message id -> { emoji: [user ids] }
    async function loadReactions(ids) {
        if (!ids.length) return;
        const { data } = await client.from('diary_community_message_reactions').select('message_id, user_id, emoji').in('message_id', ids.slice(-300));
        (data || []).forEach(r => addReact(r, false));
        paint();
    }
    function addReact(r, on = true) {
        const byEmoji = g.reacts.get(r.message_id) || {};
        const list = byEmoji[r.emoji] || [];
        if (on === false && list.includes(r.user_id)) return;
        if (!list.includes(r.user_id)) list.push(r.user_id);
        byEmoji[r.emoji] = list;
        g.reacts.set(r.message_id, byEmoji);
    }
    function dropReact(r) {
        const byEmoji = g.reacts.get(r.message_id);
        if (!byEmoji || !byEmoji[r.emoji]) return;
        byEmoji[r.emoji] = byEmoji[r.emoji].filter(u => u !== r.user_id);
        if (!byEmoji[r.emoji].length) delete byEmoji[r.emoji];
    }
    async function toggleReact(mid, emoji) {
        const mine = ((g.reacts.get(mid) || {})[emoji] || []).includes(me());
        const r = { message_id: mid, user_id: me(), emoji };
        if (mine) dropReact(r); else addReact(r);
        paint();
        const { error } = mine
            ? await client.from('diary_community_message_reactions').delete().eq('message_id', mid).eq('user_id', me()).eq('emoji', emoji)
            : await client.from('diary_community_message_reactions').insert({ message_id: mid, emoji });
        if (error && error.code !== '23505') {
            if (mine) addReact(r); else dropReact(r);
            paint();
            app.showToast('Couldn’t react to that');
        }
    }
    function reactsHTML(m) {
        const byEmoji = g.reacts.get(m.id);
        const entries = byEmoji ? Object.entries(byEmoji).filter(([, ids]) => ids.length) : [];
        if (!entries.length) return '';
        return `<div class="gc-reacts">${entries.map(([e, ids]) => {
            const names = ids.map(id => (id === me() ? 'You' : personOf(id).display_name)).join(', ');
            return `<button type="button" class="react-chip${ids.includes(me()) ? ' mine' : ''}" data-action="gc-react" data-id="${m.id}" data-emoji="${esc(e)}" title="${esc(names)}" aria-label="${esc(e)} ${ids.length}: ${esc(names)}">${esc(e)}${ids.length > 1 ? `<span>${ids.length}</span>` : ''}</button>`;
        }).join('')}<button type="button" class="react-who" data-action="gc-react-who" data-id="${m.id}" aria-label="See who reacted"><svg class="i"><use href="#i-users"/></svg></button></div>`;
    }

    // ---------- @mentions ----------
    function withMentions(html) {
        return html.replace(/(^|[\s(])@([A-Za-z0-9_]{3,20})\b/g, (all, pre, name) => {
            const lower = name.toLowerCase();
            if (lower === 'everyone' || lower === 'all') return `${pre}<span class="mention everyone">@${name}</span>`;
            if (s.profile && lower === String(s.profile.username || '').toLowerCase()) return `${pre}<span class="mention me">@${esc(name)}</span>`;
            const m = C.members().find(x => x.profile && (x.profile.username || '').toLowerCase() === lower);
            if (!m) return all;
            return `${pre}<button type="button" class="mention${m.user_id === me() ? ' me' : ''}" data-profile="${esc(m.user_id)}">@${esc(name)}</button>`;
        });
    }

    function mentionQuery(input) {
        const before = input.value.slice(0, input.selectionStart || 0);
        const m = before.match(/(?:^|\s)@([A-Za-z0-9_]{0,20})$/);
        return m ? m[1].toLowerCase() : null;
    }
    function paintMentions() {
        const input = $('gc-input');
        let box = $('gc-mentions');
        const q = input ? mentionQuery(input) : null;
        if (q === null) { if (box) box.hidden = true; return; }
        const options = C.members()
            .filter(x => x.user_id !== me() && x.profile && (`${x.profile.username} ${x.profile.display_name}`.toLowerCase().includes(q)))
            .slice(0, 6)
            .map(x => ({ name: x.profile.username, label: x.profile.display_name, person: { id: x.user_id, ...x.profile } }));
        if (isStaff() && 'everyone'.startsWith(q)) options.unshift({ name: 'everyone', label: 'Everyone in the group' });
        if (!box) {
            box = document.createElement('div');
            box.id = 'gc-mentions';
            box.className = 'gc-mentions';
            box.setAttribute('role', 'listbox');
            $('gc-compose').prepend(box);
        }
        box.hidden = !options.length;
        box.innerHTML = options.map(o => `<button type="button" role="option" data-mention="${esc(o.name)}">${o.person ? avatar(o.person, 'xs') : '<span class="mention-all">@</span>'}<span><strong>${esc(o.label)}</strong><small>@${esc(o.name)}</small></span></button>`).join('');
    }
    content.addEventListener('click', e => {
        const b = e.target.closest('#gc-mentions [data-mention]');
        if (!b) return;
        const input = $('gc-input');
        const pos = input.selectionStart || input.value.length;
        const before = input.value.slice(0, pos).replace(/@([A-Za-z0-9_]{0,20})$/, `@${b.dataset.mention} `);
        input.value = before + input.value.slice(pos);
        input.focus();
        input.setSelectionRange(before.length, before.length);
        g.draft = input.value;
        paintMentions();
    });

    // ---------- Search, media, links, forwarding ----------
    function gcConv() {
        const c = cm();
        return {
            kind: 'gc', communityId: g.cid,
            people: () => [{ id: me(), name: 'You' }, ...C.members().filter(x => x.user_id !== me() && x.profile).map(x => ({ id: x.user_id, name: x.profile.display_name }))],
            nameOf: id => (id === me() ? 'You' : personOf(id).display_name),
            jump: (id, at) => jumpTo(id, at),
            title: c ? c.name : 'Group'
        };
    }

    // Show one message — loading older messages when it's further back
    async function jumpTo(id, at) {
        if (!g.messages.some(x => x.id === id)) {
            const cid = g.cid;
            let q = client.from('diary_community_messages').select(GC_COLS).eq('community_id', cid);
            q = at ? q.gte('created_at', at) : q.gte('id', id);
            const { data } = await q.order('id', { ascending: true }).limit(600);
            if (g.cid !== cid) return;
            if (data && data.length) {
                const known = new Set(data.map(m => m.id));
                g.messages = [...data, ...g.messages.filter(m => !known.has(m.id) && m.id > data[data.length - 1].id)];
                paint();
                loadReactions(data.map(m => m.id));
            }
        }
        setTimeout(() => flash(id), 60);
    }

    const messageLink = id => `${location.origin}${location.pathname}#/community/${encodeURIComponent(g.cid)}/m/${id}`;

    // Links to a group message open that community on its chat and show the message
    app.onRoute(r => {
        if (r.view !== 'community' || !r.msg || !r.communityId) return;
        g.pendingJump = { cid: r.communityId, id: Number(r.msg) };
        C.showChat(r.communityId);
    });

    // Watch the video before it goes out; add a caption; Send or Cancel
    function previewVideo(file) {
        return new Promise(resolve => {
            const url = URL.createObjectURL(file);
            const dlg = document.createElement('dialog');
            dlg.className = 'vid-confirm';
            dlg.setAttribute('aria-label', 'Send a video');
            dlg.innerHTML = `
                <form method="dialog" class="vid-card">
                    <video src="${url}" controls playsinline preload="metadata"></video>
                    <input class="vid-caption" maxlength="500" placeholder="Add a caption…" aria-label="Caption" autocomplete="off">
                    <p class="vid-meta">${esc(file.name || 'Video')} · ${Media.formatSize(file.size)}</p>
                    <div class="vid-acts"><button type="button" class="ghost-btn" value="cancel">Cancel</button><button type="submit" class="primary-btn" value="send">Send video</button></div>
                </form>`;
            const host = document.querySelector('dialog[open]') || document.body;
            host.append(dlg);
            let answer = null;
            dlg.querySelector('[value="cancel"]').addEventListener('click', () => dlg.close());
            dlg.querySelector('form').addEventListener('submit', e => { e.preventDefault(); answer = { caption: dlg.querySelector('.vid-caption').value.trim() }; dlg.close(); });
            dlg.addEventListener('close', () => { URL.revokeObjectURL(url); dlg.remove(); resolve(answer); });
            dlg.showModal();
        });
    }
    function progressPill(text) {
        const el = document.createElement('div');
        el.className = 'up-pill';
        el.setAttribute('role', 'status');
        el.innerHTML = '<i></i><span></span>';
        (document.querySelector('dialog[open]') || document.body).append(el);
        const set = (t, f) => { el.querySelector('span').textContent = t; el.querySelector('i').style.width = `${Math.round((f || 0) * 100)}%`; };
        set(text, 0);
        return {
            set,
            done: () => el.remove(),
            fail: (t, retry) => {
                el.classList.add('failed');
                el.innerHTML = `<span></span><button type="button">Retry</button><button type="button" aria-label="Dismiss">✕</button>`;
                el.querySelector('span').textContent = t;
                const [again, x] = el.querySelectorAll('button');
                again.addEventListener('click', () => { el.remove(); retry(); });
                x.addEventListener('click', () => el.remove());
            }
        };
    }

    // ---------- Group info page ----------
    // Everything about the group in one place: who's in it and their roles, what's pinned, shared media,
    // settings, and (for staff) reports from the group and banned members.
    let infoDlg = null;
    async function openInfo() {
        const c = cm();
        if (!c) return;
        if (!infoDlg) {
            infoDlg = document.createElement('dialog');
            infoDlg.className = 'ct-sheet gc-info-sheet';
            document.body.append(infoDlg);
            infoDlg.addEventListener('click', e => {
                if (e.target === infoDlg || e.target.closest('[data-ct-close]')) return infoDlg.close();
                const el = e.target.closest('[data-gi]');
                if (el) infoAction(el.dataset.gi, el);
            });
        }
        const members = C.members();
        if (!members.length) await C.loadMembers();
        if (I.refreshPresence) I.refreshPresence(C.members().map(m => m.user_id));
        paintInfo();
        if (!infoDlg.open) infoDlg.showModal();
        if (isStaff()) loadStaffExtras();
    }

    const staff = { reports: null, bans: null };
    async function loadStaffExtras() {
        const [reports, bans] = await Promise.all([
            client.from('diary_reports').select('*').eq('community_id', g.cid).eq('status', 'open').order('created_at', { ascending: false }).limit(50),
            client.from('diary_community_bans').select('user_id, reason, created_at, profile:diary_profiles!diary_community_bans_user_id_fkey(id, username, display_name, avatar_path)').eq('community_id', g.cid)
        ]);
        staff.reports = reports.data || [];
        staff.bans = bans.data || [];
        if (infoDlg && infoDlg.open) paintInfo();
    }

    function paintInfo() {
        const c = cm();
        if (!c || !infoDlg) return;
        const order = { owner: 0, admin: 1, moderator: 2, member: 3 };
        const members = [...C.members()].sort((a, b) => (order[a.role] ?? 4) - (order[b.role] ?? 4) || (a.profile?.display_name || '').localeCompare(b.profile?.display_name || ''));
        const admins = members.filter(m => m.role !== 'member');
        const pinned = c.pinned_message && g.messages.find(m => m.id === c.pinned_message);
        const row = m => {
            const p = m.profile ? { id: m.user_id, ...m.profile } : { id: m.user_id, display_name: 'Member' };
            const line = (I.presenceText && I.presenceText(m.user_id)) || '';
            return `<button type="button" class="gi-person" data-profile="${esc(m.user_id)}">${avatar(p, 'sm')}<span><strong>${esc(m.user_id === me() ? 'You' : p.display_name)}</strong><small>${esc(line || (p.username ? `@${p.username}` : ''))}</small></span>${ROLE[m.role] ? `<span class="gc-role role-${m.role}">${ROLE[m.role]}</span>` : ''}</button>`;
        };
        infoDlg.innerHTML = `
            <div class="ct-card gi">
                <header class="ct-head"><strong>Group info</strong><button type="button" class="icon-btn" data-ct-close aria-label="Close"><svg class="i"><use href="#i-close"/></svg></button></header>
                <div class="gi-top"><span class="gi-emoji">${esc(c.emoji || '💬')}</span><h3>${esc(c.name)}</h3>
                    ${c.description ? `<p class="gi-desc">${esc(c.description)}</p>` : ''}
                    <p class="muted small">${members.length} ${members.length === 1 ? 'member' : 'members'} · ${c.visibility === 'public' ? 'Public group' : 'Invite-only group'}${c.chat_mode === 'staff' ? ' · Announcements only' : ''}${c.slow_mode ? ` · Slow mode ${c.slow_mode}s` : ''}</p></div>
                <div class="gi-quick">
                    <button type="button" class="info-q" data-gi="search"><span class="info-q-ic"><svg class="i"><use href="#i-search"/></svg></span>Search</button>
                    <button type="button" class="info-q" data-gi="media"><span class="info-q-ic"><svg class="i"><use href="#i-image"/></svg></span>Media</button>
                    <button type="button" class="info-q" data-gi="deleted"><span class="info-q-ic"><svg class="i"><use href="#i-history"/></svg></span>Deleted</button>
                    ${['owner', 'admin'].includes(myRole()) ? '<button type="button" class="info-q" data-gi="settings"><span class="info-q-ic"><svg class="i"><use href="#i-settings"/></svg></span>Settings</button>' : ''}
                </div>
                ${pinned ? `<h4 class="info-label">Pinned</h4><button type="button" class="gi-pinned" data-gi="goto" data-id="${pinned.id}"><svg class="i"><use href="#i-pin-note"/></svg><span>${esc((pinned.body || '📎 Attachment').slice(0, 160))}</span></button>` : ''}
                ${admins.length ? `<h4 class="info-label">Admins &amp; moderators</h4><div class="gi-list">${admins.map(row).join('')}</div>` : ''}
                <h4 class="info-label">Members</h4>
                <div class="gi-list">${members.filter(m => m.role === 'member').map(row).join('') || '<p class="muted small">No other members yet.</p>'}</div>
                ${isStaff() ? `
                    <h4 class="info-label">Reports from this group</h4>
                    ${staff.reports === null ? '<p class="muted small">Loading…</p>' : staff.reports.length ? staff.reports.map(r => `
                        <div class="gi-report"><small>${esc(r.reason)} · ${esc(timeAgo(r.created_at))}</small>${r.snapshot ? `<p>${esc(r.snapshot.slice(0, 200))}</p>` : ''}${r.details ? `<p class="muted small">“${esc(r.details)}”</p>` : ''}
                            <span class="gi-report-actions"><button type="button" class="chip" data-gi="report" data-id="${r.id}" data-act="dismiss">Dismiss</button>${r.kind === 'gc' || r.kind === 'post' ? `<button type="button" class="chip danger" data-gi="report" data-id="${r.id}" data-act="remove">Remove it</button>` : ''}</span></div>`).join('') : '<p class="muted small">No open reports. 🎉</p>'}
                    <h4 class="info-label">Banned</h4>
                    ${staff.bans === null ? '<p class="muted small">Loading…</p>' : staff.bans.length ? `<div class="gi-list">${staff.bans.map(b => `<div class="gi-person">${avatar(b.profile ? { id: b.user_id, ...b.profile } : { id: b.user_id, display_name: '?' }, 'sm')}<span><strong>${esc(b.profile ? b.profile.display_name : 'Someone')}</strong><small>${esc(b.reason || 'No reason given')}</small></span><button type="button" class="chip" data-gi="unban" data-id="${esc(b.user_id)}">Lift ban</button></div>`).join('')}</div>` : '<p class="muted small">No one is banned.</p>'}` : ''}
            </div>`;
        hydrateStorage(infoDlg);
    }

    async function infoAction(what, el) {
        if (what === 'search') { infoDlg.close(); return app.actions['gc-search'](); }
        if (what === 'media') { infoDlg.close(); return app.actions['gc-gallery'](); }
        if (what === 'deleted') { infoDlg.close(); return app.actions['gc-recent-deleted'](); }
        if (what === 'settings') return app.actions['cm-chat-settings'] && app.actions['cm-chat-settings'](el);
        if (what === 'goto') { infoDlg.close(); return jumpTo(Number(el.dataset.id)); }
        if (what === 'unban') {
            const { error } = await client.rpc('diary_unban_member', { p_cid: g.cid, p_user: el.dataset.id });
            if (error) return app.showToast('Couldn’t lift the ban');
            app.showToast('Ban lifted — they can join again');
            return loadStaffExtras();
        }
        if (what === 'report') {
            const { error } = await client.rpc('diary_resolve_report', { p_id: el.dataset.id, p_action: el.dataset.act, p_note: null });
            if (error) return app.showToast(error.message || 'Couldn’t do that');
            app.showToast(el.dataset.act === 'dismiss' ? 'Report dismissed' : 'Removed');
            if (el.dataset.act === 'remove') load();
            return loadStaffExtras();
        }
    }

    // ---------- Editing & deleting ----------
    function startEdit(m) {
        const input = $('gc-input');
        if (!input) return;
        g.editing = { id: m.id, body: m.body, draft: input.value };
        g.reply = null;
        input.value = m.body;
        autosize(input);
        paintReply();
        input.focus();
    }

    function cancelEdit() {
        const input = $('gc-input');
        if (input && g.editing) { input.value = g.editing.draft || ''; autosize(input); }
        g.editing = null;
        paintReply();
    }

    async function saveEdit(body) {
        const e = g.editing;
        const m = g.messages.find(x => x.id === e.id);
        cancelEdit();
        if (!m || !body || body === m.body) return;
        const before = { body: m.body, edited_at: m.edited_at };
        Object.assign(m, { body, edited_at: new Date().toISOString() });
        paint();
        const { data, error } = await client.rpc('diary_edit_community_message', { p_id: m.id, p_body: body });
        if (error) {
            Object.assign(m, before);
            paint();
            return app.showToast(error.message || 'Couldn’t edit that message');
        }
        Object.assign(m, { body: data.body, edited_at: data.edited_at });
        paint();
    }

    async function deleteMessage(m, anchor, canEveryone) {
        const mine = m.author === me();
        const how = I.chooseDelete
            ? await I.chooseDelete(anchor, { mine, canEveryone: canEveryone && !m.deleted_at, everyoneLabel: mine ? 'Delete for everyone' : 'Remove for everyone' })
            : 'everyone';
        if (!how) return;
        if (how === 'me') {
            const { error } = await client.from('diary_message_hidden').insert({ kind: 'gc', message_id: m.id });
            if (error) return app.showToast('Couldn’t delete that');
            g.messages = g.messages.filter(x => x !== m);
            paint();
            app.showToast('Deleted for you', async () => {
                await client.from('diary_message_hidden').delete().eq('kind', 'gc').eq('message_id', m.id);
                load();
            });
            return;
        }
        const { error } = await client.rpc('diary_delete_community_message', { mid: m.id });
        if (error) return app.showToast('Couldn’t remove that message');
        Object.assign(m, { deleted_at: new Date().toISOString(), deleted_by: me(), body: '', attachments: [] });
        if (cm().pinned_message === m.id) cm().pinned_message = null;
        paint();
        app.showToast(mine ? 'Deleted for everyone' : 'Removed for everyone', async () => {
            const { error: e2 } = await client.rpc('diary_restore_message', { p_kind: 'gc', p_id: m.id });
            if (e2) return app.showToast('Couldn’t restore it');
            load();
        });
    }

    // ---------- Voice notes ----------
    // Tap the mic to record; tap send (or the mic again) to send it, or the bin to throw it away
    async function startRecording() {
        if (g.rec || !g.cid) return;
        const rec = g.rec = { controller: null, levels: [] };
        paintRec(0, 0);
        try {
            rec.controller = await Media.createRecorder((level, secs) => { if (g.rec === rec) paintRec(level, secs); });
        } catch (err) {
            g.rec = null;
            paintRec();
            return app.showToast(err.message || 'Allow microphone access to record');
        }
        if (g.rec !== rec) rec.controller.cancel();
    }

    function paintRec(level, secs) {
        const bar = $('gc-rec');
        const input = $('gc-input');
        const mic = $('gc-mic');
        if (!bar) return;
        const on = !!g.rec;
        bar.hidden = !on;
        if (input) input.hidden = on;
        if (mic) {
            mic.classList.toggle('recording', on);
            mic.setAttribute('aria-label', on ? 'Send voice note' : 'Record a voice note');
            mic.innerHTML = `<svg class="i"><use href="#${on ? 'i-send' : 'i-mic'}"/></svg>`;
        }
        if (!on) return;
        if (typeof secs === 'number') $('gc-rec-time').textContent = Media.formatDuration(secs);
        if (typeof level === 'number') {
            g.rec.levels.push(level);
            const wave = $('gc-rec-wave');
            if (wave) wave.innerHTML = g.rec.levels.slice(-40).map(v => `<span style="height:${Math.max(12, Math.round(v * 100))}%"></span>`).join('');
        }
    }

    async function finishRecording(sendIt) {
        const rec = g.rec;
        if (!rec) return;
        g.rec = null;
        paintRec();
        if (!rec.controller) return;
        if (!sendIt) return rec.controller.cancel();
        const result = await rec.controller.stop();
        if (result.duration < 1) return app.showToast('Record a little longer to send a voice note');
        const ext = I.extFor ? I.extFor(result.type) : '.webm';
        const path = `${g.cid}/${me()}/${randomId()}${ext}`;
        app.showToast('Sending voice note…');
        const { error } = await client.storage.from(BUCKET).upload(path, result.blob, { contentType: result.type, upsert: false });
        if (error) return app.showToast('Couldn’t upload the voice note');
        const ok = await send('', [{ kind: 'audio', path, name: 'Voice note', type: result.type, duration: Math.round(result.duration), waveform: (result.waveform || []).slice(0, 40) }]);
        if (!ok) client.storage.from(BUCKET).remove([path]);
    }

    // ---------- Actions ----------
    Object.assign(app.actions, {
        'gc-call': el => {
            // Already in this group's call: just open it; otherwise choose voice or video
            if (window.diaryCalls && cm() && window.diaryCalls.activeTopic() === window.diaryCalls.topicFor(cm())) return C.joinCall();
            app.openPopover(el, [
                { label: 'Voice call', icon: 'i-phone', onClick: () => C.joinCall({ video: false }) },
                { label: 'Video call', icon: 'i-video', onClick: () => C.joinCall({ video: true }) }
            ]);
        },
        'gc-wallpaper': () => {
            if (!window.ChatWallpaper || !g.cid) return;
            window.ChatWallpaper.open('gc:' + g.cid, { label: cm() ? cm().name : '', onDone: () => window.ChatWallpaper.apply(document.querySelector('.gc'), 'gc:' + g.cid) });
        },
        'gc-call-voice': () => { if (window.diaryCalls && cm() && window.diaryCalls.activeTopic() === window.diaryCalls.topicFor(cm())) return C.joinCall(); C.joinCall({ video: false }); },
        'gc-call-video': () => { if (window.diaryCalls && cm() && window.diaryCalls.activeTopic() === window.diaryCalls.topicFor(cm())) return C.joinCall(); C.joinCall({ video: true }); },
        'gc-back': () => app.actions['cm-tab'] && app.actions['cm-tab']({ dataset: { tab: 'posts' } }),
        'gc-attach': el => {
            const run = name => setTimeout(() => app.actions[name](el), 0);
            app.openPopover(el, [
                { label: 'Photo', icon: 'i-image', onClick: () => run('gc-photo') },
                ...(I.videoOn && I.videoOn() ? [{ label: 'Video', icon: 'i-video', onClick: () => run('gc-video') }] : []),
                window.LiveLocation && window.LiveLocation.supported ? { label: 'Live location', icon: 'i-pin', onClick: () => run('gc-location') } : null,
                { label: 'Contact', icon: 'i-contact', onClick: () => run('gc-contact') }
            ].filter(Boolean));
        },
        'gc-head-more': el => {
            const run = name => setTimeout(() => app.actions[name] && app.actions[name](el), 0);
            app.openPopover(el, [
                { label: 'Group info', icon: 'i-info', onClick: () => run('gc-info') },
                { label: 'Search in chat', icon: 'i-search', onClick: () => run('gc-search') },
                { label: 'Media, files & links', icon: 'i-image', onClick: () => run('gc-gallery') },
                window.ChatWallpaper ? { label: 'Wallpaper', icon: 'i-palette', onClick: () => run('gc-wallpaper') } : null,
                { label: 'Recently deleted', icon: 'i-history', onClick: () => run('gc-recent-deleted') },
                el.dataset.admin ? { label: 'Chat settings', icon: 'i-settings', onClick: () => run('cm-chat-settings') } : null
            ].filter(Boolean));
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
        'gc-cancel-edit': () => cancelEdit(),
        'gc-info': () => openInfo(),
        'gc-contact': el => I.pickContact && I.pickContact(el, card => send('', [card])),
        'gc-react': el => toggleReact(Number(el.dataset.id), el.dataset.emoji),
        'gc-react-who': el => {
            const byEmoji = g.reacts.get(Number(el.dataset.id)) || {};
            if (window.diaryChatTools) window.diaryChatTools.whoReacted(byEmoji, id => (id === me() ? 'You' : personOf(id).display_name), personOf);
        },
        'gc-search': () => window.diaryChatTools && window.diaryChatTools.openSearch(gcConv()),
        'gc-gallery': () => window.diaryChatTools && window.diaryChatTools.openGallery(gcConv()),
        'gc-mic': () => (g.rec ? finishRecording(true) : startRecording()),
        'gc-rec-cancel': () => finishRecording(false),
        'gc-recent-deleted': () => I.openRecentlyDeleted && I.openRecentlyDeleted('gc', g.cid, {
            title: 'Recently deleted',
            nameOf: id => personOf(id).display_name,
            onRestored: () => load()
        }),
        'msg-history': el => {
            if (el.dataset.kind !== 'gc') return;
            const m = g.messages.find(x => x.id === Number(el.dataset.id));
            if (I.showHistory) I.showHistory('gc', el.dataset.id, m);
        },
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
        'gc-video': async () => {
            const [file] = await Media.pickFiles('video/mp4,video/quicktime,video/webm,.mp4,.mov,.webm', false);
            if (!file) return;
            const type = (file.type || '').split(';')[0];
            if (!I.VIDEO_TYPES.includes(type)) return app.showToast('That video isn’t supported — use MP4, MOV or WebM');
            if (file.size > I.MAX_VIDEO) return app.showToast('That video is larger than 100 MB — try a shorter clip');
            const ok = await previewVideo(file);
            if (!ok) return;
            const info = await I.probeVideo(file);
            const base = `${g.cid}/${me()}/${randomId()}`;
            const ext = { 'video/mp4': '.mp4', 'video/quicktime': '.mov', 'video/webm': '.webm' }[type];
            const bar = progressPill('Uploading video… 0%');
            const { error } = await I.uploadWithProgress(BUCKET, base + ext, file, type, f => bar.set(`Uploading video… ${Math.round(f * 100)}%`, f));
            if (error) {
                bar.fail('Upload failed', () => run('gc-video'));
                return;
            }
            bar.set('Sending…', 1);
            let poster = null;
            if (info.poster) {
                const r = await client.storage.from(BUCKET).upload(base + '-poster.jpg', info.poster, { contentType: 'image/jpeg', upsert: false });
                if (!r.error) poster = base + '-poster.jpg';
            }
            const att = { kind: 'video', path: base + ext, type, size: file.size, ...(poster ? { poster } : {}),
                ...(info.duration ? { duration: Math.round(info.duration) } : {}), ...(info.width ? { width: info.width, height: info.height } : {}) };
            await send(ok.caption || '', [att]);
            bar.done();
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
        'gc-sticker': el => window.CordialStickers.toggle(el, att => send('', [att])),
        'gc-menu': el => {
            const m = g.messages.find(x => x.id === Number(el.dataset.id));
            if (!m) return;
            const mine = m.author === me();
            if (m.deleted_at) return deleteMessage(m, el, false);
            const authorRole = (member(m.author) || {}).role || 'member';
            const rank = { owner: 3, admin: 2, moderator: 1, member: 0 };
            const canRemove = mine || (isStaff() && rank[myRole()] > rank[authorRole]);
            const pinned = !!cm() && cm().pinned_message === m.id;
            const items = [
                { label: 'React', icon: 'i-smile', onClick: () => setTimeout(() => I.emojiPicker && I.emojiPicker(el, emoji => toggleReact(m.id, emoji), { chosen: new Set(Object.entries(g.reacts.get(m.id) || {}).filter(([, ids]) => ids.includes(me())).map(([e]) => e)) }), 0) },
                { label: 'Reply', icon: 'i-reply', onClick: () => { g.reply = m; paintReply(); $('gc-input') && $('gc-input').focus(); } },
                { label: 'Forward', icon: 'i-forward', onClick: () => window.diaryChatTools && window.diaryChatTools.openForward({ kind: 'gc', body: m.body, attachments: m.attachments, bucket: BUCKET }) },
                { label: 'Copy link', icon: 'i-link', onClick: () => navigator.clipboard.writeText(messageLink(m.id)).then(() => app.showToast('Link copied — it opens this message for group members'), () => app.showToast('Couldn’t copy the link')) }
            ];
            if (mine && m.body && Date.now() - Date.parse(m.created_at) < 24 * 3600 * 1000) items.push({ label: 'Edit', icon: 'i-edit', onClick: () => startEdit(m) });
            if (!mine && window.diarySafety) items.push({ label: 'Report', icon: 'i-flag', onClick: () => window.diarySafety.report('gc', m.id, { who: personOf(m.author).display_name }) });
            if (m.body) items.push({ label: 'Copy text', icon: 'i-file', onClick: () => navigator.clipboard.writeText(m.body).then(() => app.showToast('Copied'), () => {}) });
            if (m.body) items.push({ label: 'Save to notes', icon: 'i-bookmark', onClick: async () => {
                const who = mine ? 'Me' : (personOf(m.author).display_name || 'Someone');
                const when = new Date(m.created_at).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
                try { await app.createEntry({ title: `💬 ${who} · ${(cm() && cm().name) || 'Group'}`, text: `${m.body}\n\n— ${who}, ${when}`, shared: false }); app.showToast('Saved to your notes 🔖'); }
                catch (e) { app.showToast('Couldn’t save it — try again'); }
            } });
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
            items.push({ label: 'Delete…', icon: 'i-trash', danger: true, onClick: () => deleteMessage(m, el, canRemove) });
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
            if (more) {
                try { const sel = document.getSelection(); if (sel && !sel.isCollapsed) sel.removeAllRanges(); } catch (e) { /* nothing selected */ }
                msg.classList.add('held');
                setTimeout(() => msg.classList.remove('held'), 900);
                if (navigator.vibrate) navigator.vibrate(10);
                more.click();
            }
        }, 480);
    });
    ['pointerup', 'pointercancel', 'pointermove'].forEach(t => content.addEventListener(t, () => clearTimeout(press)));
    content.addEventListener('contextmenu', e => { if (e.target.closest('.gc-bubble') && e.pointerType !== 'mouse') e.preventDefault(); });
    // Swipe a message to the right to reply (same gesture as one-to-one chats)
    if (I.swipeToReply) I.swipeToReply(content, '#gc-thread .gc-msg:not(.removed) .gc-bubble', b => b.closest('.gc-msg').dataset.mid, id => {
        const m = g.messages.find(x => String(x.id) === String(id));
        if (!m || m.deleted_at || g.editing) return;
        g.reply = m;
        paintReply();
        const input = $('gc-input');
        if (input) input.focus();
    });
});
