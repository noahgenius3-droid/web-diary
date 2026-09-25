// Accounts, friends, the chat inbox and the friends feed (Supabase).
// Diary entries stay in this browser; only entries marked "Share with friends" are uploaded.
document.addEventListener('DOMContentLoaded', () => {
    const app = window.diaryApp;
    const cfg = window.DIARY_CONFIG;
    const $ = id => document.getElementById(id);
    const esc = app.escapeHTML;
    const content = $('content');
    const USERNAME_RE = /^[a-z0-9_]{3,20}$/;
    const BUCKET = 'diary-chat';
    const MAX_UPLOAD = 20 * 1048576;
    // Must match the bucket's allowed types (see the diary_rich_chat migration)
    const ALLOWED_TYPES = [
        'image/png', 'image/jpeg', 'image/gif', 'image/webp',
        'audio/webm', 'audio/ogg', 'audio/mp4', 'audio/mpeg', 'audio/wav',
        'application/pdf', 'text/plain', 'text/csv', 'application/msword',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'application/vnd.ms-excel', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'application/vnd.ms-powerpoint', 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        'application/zip'
    ];
    const DOC_ACCEPT = '.pdf,.txt,.csv,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.zip';
    const EMOJI = ['😀', '😂', '🥰', '😊', '😎', '🤔', '😅', '😢', '😭', '😤', '😴', '🤗', '👍', '👏', '🙏', '💪',
        '🎉', '✨', '🔥', '❤️', '💙', '💚', '💛', '🌸', '🌞', '🌙', '☕', '📚', '✍️', '🎧', '🏃', '✅'];

    const available = !!(window.supabase && cfg);
    const client = available ? window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseKey) : null;

    const s = {
        session: null,
        profile: null,
        friends: [],       // accepted: { friendshipId, id, username, display_name, since }
        incoming: [],      // requests sent to me
        outgoing: [],      // requests I sent
        unread: {},        // friend id -> unread count
        last: {},          // friend id -> latest message
        feed: null,        // null = not loaded yet
        feedLoading: false,
        feedAuthor: null,
        threads: {},       // friend id -> messages, oldest first
        activeFriend: null,
        drafts: {},
        pending: {},       // friend id -> attachments waiting to send
        chatFocused: false,
        showFormat: false,
        showInfo: window.innerWidth > 1280,
        inboxTab: 'all',
        addOpen: false,
        sending: false,
        online: new Set(),
        muted: new Set(load('diaryMuted', [])),
        urls: new Map(),   // storage path -> { url, expires }
        remoteIds: new Set(), // local ids of my entries that exist in the feed
        channel: null,
        presence: null
    };

    const signedIn = () => !!(s.session && s.profile);

    window.diarySocial = {
        available,
        isSignedIn: signedIn,
        async accessToken() {
            if (!client) return null;
            const { data } = await client.auth.getSession();
            return data.session ? data.session.access_token : null;
        },
        requireSignIn(reason) {
            if (signedIn()) return true;
            openAuth(reason);
            return false;
        }
    };

    // ---------- Hooks into the diary ----------
    app.hooks.displayName = () => (s.profile ? s.profile.display_name : null);

    app.hooks.shareToggle = () => {
        if (signedIn()) return true;
        openAuth('Sign in to share entries with your friends.');
        return false;
    };

    app.hooks.rename = async () => {
        if (!signedIn()) return localRename();
        const r = await app.ask({ title: 'Your name', value: s.profile.display_name, placeholder: 'Your name', ok: 'Save' });
        if (!r) return;
        const { data, error } = await client.from('diary_profiles')
            .update({ display_name: r.value.slice(0, 40) }).eq('id', s.profile.id).select().single();
        if (error) return app.showToast('Could not update your name');
        s.profile = data;
        app.render();
    };

    // The original local-only rename, used when signed out
    async function localRename() {
        const hook = app.hooks.rename;
        app.hooks.rename = null;
        try { await app.renameUser(); } finally { app.hooks.rename = hook; }
    }

    app.hooks.profileClick = anchor => {
        if (!signedIn()) {
            app.openPopover(anchor, [
                { label: 'Sign in / create account', icon: 'i-user', onClick: () => openAuth() },
                { label: 'Change name', icon: 'i-pencil', onClick: () => app.renameUser() }
            ]);
            return;
        }
        app.openPopover(anchor, [
            { label: `@${s.profile.username}`, icon: 'i-user', onClick: () => app.setView('messages') },
            { label: 'Change name', icon: 'i-pencil', onClick: () => app.renameUser() },
            { label: 'Sign out', icon: 'i-logout', onClick: signOut }
        ]);
    };

    app.hooks.menuItems = () => signedIn()
        ? [{ label: 'Sign out', icon: 'i-logout', onClick: signOut }]
        : [{ label: 'Sign in', icon: 'i-user', onClick: () => openAuth() }];

    app.hooks.afterRender = view => {
        if (view === 'feed') hydrateStorage(content);
        if (view !== 'messages' || !signedIn()) return;
        const thread = $('chat-thread');
        if (thread) {
            thread.scrollTop = thread.scrollHeight;
            hydrateStorage(thread);
        }
        const info = content.querySelector('.chat-info');
        if (info) hydrateStorage(info);
        const input = $('chat-input');
        if (input && s.activeFriend) {
            Rich.attach($('chat-toolbar'), input, {
                onChange: saveDraft,
                onFiles: addPending,
                askLink: app.askLink
            });
            input.innerHTML = Rich.sanitize(s.drafts[s.activeFriend] || '');
            renderPending();
            if (s.chatFocused) {
                input.focus();
                Rich.placeCaretAtEnd(input);
            }
        }
    };

    // Keep shared entries in sync with the feed (private entries are never shared)
    app.on('note', note => {
        if (!signedIn()) return;
        if (note.shared && !note.private && !note.trashedAt) upsertShared(note);
        else if (s.remoteIds.has(note.id)) removeShared(note);
    });
    app.on('note-removed', note => {
        if (signedIn() && s.remoteIds.has(note.id)) removeShared(note);
    });

    // ---------- Auth ----------
    const authDialog = $('auth');
    let authMode = 'signin';

    function openAuth(reason = '') {
        setAuthMode('signin');
        $('auth-reason').textContent = reason;
        $('auth-reason').hidden = !reason;
        showAuthMessage('');
        if (!available) showAuthMessage('Couldn’t reach the sign-in service. Check your connection and reload the page.', true);
        if (!authDialog.open) authDialog.showModal();
        $('auth-email').focus();
    }

    function setAuthMode(mode) {
        authMode = mode;
        const signup = mode === 'signup';
        authDialog.querySelectorAll('.signup-only').forEach(el => { el.hidden = !signup; });
        authDialog.querySelectorAll('.auth-tabs .tab').forEach(t =>
            t.setAttribute('aria-selected', String(t.dataset.mode === mode)));
        $('auth-title').textContent = signup ? 'Create your account' : 'Welcome back';
        $('auth-submit').textContent = signup ? 'Create account' : 'Sign in';
        $('auth-password').autocomplete = signup ? 'new-password' : 'current-password';
        showAuthMessage('');
    }

    function showAuthMessage(text, isError = false) {
        const el = $('auth-message');
        el.textContent = text;
        el.hidden = !text;
        el.classList.toggle('error', isError);
    }

    authDialog.querySelectorAll('.auth-tabs .tab').forEach(t =>
        t.addEventListener('click', () => setAuthMode(t.dataset.mode)));
    $('auth-cancel').addEventListener('click', () => authDialog.close());
    $('auth-username').addEventListener('input', e => {
        e.target.value = e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, '');
    });

    $('auth-form').addEventListener('submit', async e => {
        e.preventDefault();
        if (!client) return;
        const email = $('auth-email').value.trim();
        const password = $('auth-password').value;
        const name = $('auth-name').value.trim();
        const username = $('auth-username').value.trim();

        if (!email || !password) return showAuthMessage('Enter your email and password.', true);
        if (authMode === 'signup') {
            if (!name) return showAuthMessage('Tell us your name.', true);
            if (!USERNAME_RE.test(username)) return showAuthMessage('Usernames are 3–20 lowercase letters, numbers or _.', true);
            if (password.length < 6) return showAuthMessage('Use at least 6 characters for your password.', true);
        }

        const submit = $('auth-submit');
        submit.disabled = true;
        try {
            if (authMode === 'signin') {
                const { error } = await client.auth.signInWithPassword({ email, password });
                if (error) throw error;
                authDialog.close();
            } else {
                const { data, error } = await client.auth.signUp({
                    email, password,
                    options: { data: { username, display_name: name } }
                });
                if (error) throw error;
                if (data.session) {
                    authDialog.close();
                } else {
                    setAuthMode('signin');
                    showAuthMessage('Almost there — check your inbox to confirm your email, then sign in here.');
                }
            }
        } catch (err) {
            showAuthMessage(err.message || 'Something went wrong. Please try again.', true);
        } finally {
            submit.disabled = false;
        }
    });

    async function signOut() {
        if (client) await client.auth.signOut();
        app.showToast('Signed out');
    }

    if (client) {
        // Supabase warns against awaiting its own calls inside this callback, so defer the work
        client.auth.onAuthStateChange((event, session) => {
            setTimeout(() => handleSession(session, event), 0);
        });
    }

    async function handleSession(session, event) {
        const previousUser = s.session ? s.session.user.id : null;
        s.session = session;

        if (!session) {
            resetSocial();
            app.render();
            return;
        }
        if (previousUser === session.user.id && s.profile) return; // token refresh

        s.profile = await ensureProfile(session.user);
        if (!s.profile) return app.render();

        s.drafts = load(`diaryChatDrafts:${s.profile.id}`, {});
        await Promise.all([loadFriends(), loadRecent(), loadRemoteIds()]);
        subscribe();
        syncAllShared();
        app.render();
        if (event === 'SIGNED_IN' && previousUser === null) app.showToast(`Signed in as @${s.profile.username}`);
    }

    function resetSocial() {
        if (s.channel) client.removeChannel(s.channel);
        if (s.presence) client.removeChannel(s.presence);
        Object.assign(s, {
            profile: null, friends: [], incoming: [], outgoing: [], unread: {}, last: {}, feed: null, feedAuthor: null,
            threads: {}, activeFriend: null, drafts: {}, pending: {}, online: new Set(), urls: new Map(),
            remoteIds: new Set(), channel: null, presence: null
        });
        updateBadge();
    }

    async function ensureProfile(user) {
        const { data: existing } = await client.from('diary_profiles').select('*').eq('id', user.id).maybeSingle();
        if (existing) return existing;

        const meta = user.user_metadata || {};
        let username = String(meta.username || '').toLowerCase();
        const displayName = String(meta.display_name || user.email.split('@')[0]).slice(0, 40);

        for (;;) {
            if (!USERNAME_RE.test(username)) {
                const r = await app.ask({
                    title: 'Choose a username',
                    text: 'Friends add you by username: 3–20 lowercase letters, numbers or _.',
                    value: username, placeholder: 'e.g. noah_writes', ok: 'Save'
                });
                if (!r) {
                    await client.auth.signOut();
                    return null;
                }
                username = r.value.toLowerCase();
                if (!USERNAME_RE.test(username)) continue;
            }
            const { data, error } = await client.from('diary_profiles')
                .insert({ id: user.id, username, display_name: displayName }).select().single();
            if (!error) return data;
            if (error.code === '23505') {
                app.showToast(`@${username} is taken — try another`);
                username = '';
                continue;
            }
            app.showToast('Could not create your profile');
            return null;
        }
    }

    // ---------- Realtime ----------
    function subscribe() {
        if (s.channel) client.removeChannel(s.channel);
        if (s.presence) client.removeChannel(s.presence);
        const me = s.profile.id;

        s.channel = client.channel(`diary-${me}`)
            .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'diary_messages', filter: `recipient=eq.${me}` },
                payload => onIncomingMessage(payload.new))
            .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'diary_messages', filter: `sender=eq.${me}` },
                payload => onMessageRead(payload.new))
            .on('postgres_changes', { event: '*', schema: 'public', table: 'diary_friendships' },
                async () => {
                    await loadFriends();
                    if (['messages', 'feed'].includes(app.state.view)) app.render();
                })
            .on('postgres_changes', { event: '*', schema: 'public', table: 'diary_shared_entries' },
                () => {
                    s.feed = null;
                    if (app.state.view === 'feed') loadFeed();
                })
            .subscribe();

        // Who's online right now (shown for friends only)
        s.presence = client.channel('diary-presence', { config: { presence: { key: me } } });
        s.presence
            .on('presence', { event: 'sync' }, () => {
                s.online = new Set(Object.keys(s.presence.presenceState()));
                paintPresence();
            })
            .subscribe(async status => {
                if (status === 'SUBSCRIBED') await s.presence.track({ at: Date.now() });
            });
    }

    function paintPresence() {
        content.querySelectorAll('[data-presence]').forEach(el =>
            el.classList.toggle('online', s.online.has(el.dataset.presence)));
        content.querySelectorAll('[data-status]').forEach(el => {
            el.textContent = s.online.has(el.dataset.status) ? 'Active now' : el.dataset.away;
        });
    }

    // ---------- Friends ----------
    async function loadFriends() {
        const { data, error } = await client.from('diary_friendships').select(`
            id, status, requester, addressee, created_at,
            requester_profile:diary_profiles!diary_friendships_requester_fkey(id, username, display_name),
            addressee_profile:diary_profiles!diary_friendships_addressee_fkey(id, username, display_name)
        `).order('created_at');
        if (error) return;

        const me = s.profile.id;
        s.friends = [];
        s.incoming = [];
        s.outgoing = [];
        data.forEach(f => {
            const other = f.requester === me ? f.addressee_profile : f.requester_profile;
            if (!other) return;
            const item = { friendshipId: f.id, since: f.created_at, ...other };
            if (f.status === 'accepted') s.friends.push(item);
            else if (f.addressee === me) s.incoming.push(item);
            else s.outgoing.push(item);
        });
        if (s.activeFriend && !s.friends.some(f => f.id === s.activeFriend)) s.activeFriend = null;
        updateBadge();
    }

    async function addFriend(username) {
        const { data, error } = await client.rpc('diary_send_friend_request', { target_username: username });
        if (error) return app.showToast(error.message);
        await loadFriends();
        const friend = s.friends.find(f => f.friendshipId === data.id);
        app.showToast(friend ? `You and ${friend.display_name} are now friends` : 'Friend request sent');
        s.addOpen = false;
        if (!friend) s.inboxTab = 'requests';
        app.render();
    }

    async function respond(friendshipId, accept) {
        const { error } = await client.rpc('diary_respond_friend_request', { request_id: friendshipId, accept });
        if (error) return app.showToast('Could not update the request');
        await loadFriends();
        s.feed = null;
        app.render();
    }

    async function removeFriendship(friendshipId, confirmText) {
        if (confirmText) {
            const ok = await app.ask({ title: confirmText.title, text: confirmText.text, ok: confirmText.ok, danger: true });
            if (!ok) return;
        }
        const { error } = await client.from('diary_friendships').delete().eq('id', friendshipId);
        if (error) return app.showToast('Could not update friends');
        await loadFriends();
        s.feed = null;
        app.render();
    }

    // ---------- Messages ----------
    async function loadRecent() {
        const { data, error } = await client.from('diary_messages')
            .select('id, sender, recipient, body, attachments, created_at, read_at')
            .order('created_at', { ascending: false })
            .limit(400);
        if (error) return;
        const me = s.profile.id;
        s.last = {};
        s.unread = {};
        data.forEach(m => {
            const other = m.sender === me ? m.recipient : m.sender;
            if (!s.last[other]) s.last[other] = m;
            if (m.recipient === me && !m.read_at) s.unread[m.sender] = (s.unread[m.sender] || 0) + 1;
        });
        updateBadge();
    }

    function updateBadge() {
        const total = Object.values(s.unread).reduce((a, b) => a + b, 0) + s.incoming.length;
        $('messages-count').textContent = total ? String(total) : '';
    }

    async function loadThread(friendId) {
        const me = s.profile.id;
        const { data, error } = await client.from('diary_messages')
            .select('*')
            .or(`and(sender.eq.${me},recipient.eq.${friendId}),and(sender.eq.${friendId},recipient.eq.${me})`)
            .order('created_at', { ascending: false })
            .limit(200);
        s.threads[friendId] = error ? [] : data.reverse();
        if (app.state.view === 'messages' && s.activeFriend === friendId) app.render();
    }

    async function markRead(friendId) {
        if (!s.unread[friendId]) return;
        s.unread[friendId] = 0;
        updateBadge();
        await client.rpc('diary_mark_read', { friend: friendId });
    }

    function openChat(friendId) {
        s.activeFriend = friendId;
        if (!s.threads[friendId]) loadThread(friendId);
        markRead(friendId);
        s.chatFocused = window.matchMedia('(hover: hover)').matches;
        app.render();
    }

    function saveDraft() {
        const input = $('chat-input');
        if (!input || !s.activeFriend) return;
        s.drafts[s.activeFriend] = Rich.toText(input.innerHTML) ? input.innerHTML : '';
        clearTimeout(saveDraft.timer);
        saveDraft.timer = setTimeout(() => {
            try { localStorage.setItem(`diaryChatDrafts:${s.profile.id}`, JSON.stringify(s.drafts)); } catch (e) {}
        }, 400);
    }

    // ---------- Pending attachments ----------
    function addPending(files, extra = {}) {
        const friendId = s.activeFriend;
        if (!friendId || !files.length) return;
        const list = s.pending[friendId] = s.pending[friendId] || [];
        for (const file of files) {
            const type = (file.type || '').split(';')[0];
            if (!ALLOWED_TYPES.includes(type)) {
                app.showToast(`${file.name || 'That file'} isn’t a supported type`);
                continue;
            }
            if (file.size > MAX_UPLOAD) {
                app.showToast(`${file.name || 'File'} is larger than 20 MB`);
                continue;
            }
            if (list.length >= 10) {
                app.showToast('Up to 10 attachments per message');
                break;
            }
            list.push({
                id: Math.random().toString(36).slice(2),
                file, type,
                name: file.name || 'attachment',
                size: file.size,
                kind: extra.kind || Media.kindOf(type),
                duration: extra.duration,
                preview: type.startsWith('image/') ? URL.createObjectURL(file) : null
            });
        }
        renderPending();
    }

    function renderPending() {
        const box = $('pending-atts');
        if (!box) return;
        const list = s.pending[s.activeFriend] || [];
        box.hidden = !list.length;
        box.innerHTML = list.map(p => `
            <div class="pending">
                ${p.preview ? `<img src="${p.preview}" alt="">` : `<svg class="i"><use href="#${p.kind === 'audio' ? 'i-mic' : 'i-file'}"/></svg>`}
                <span class="pending-name">${esc(p.name)}<small>${p.kind === 'audio' ? Media.formatDuration(p.duration) : Media.formatSize(p.size)}</small></span>
                <button type="button" class="att-remove" data-action="remove-pending" data-id="${p.id}" aria-label="Remove ${esc(p.name)}"><svg class="i"><use href="#i-close"/></svg></button>
            </div>`).join('');
    }

    async function sendMessage() {
        if (s.sending) return;
        const input = $('chat-input');
        const friendId = s.activeFriend;
        if (!input || !friendId) return;
        const html = Rich.sanitize(input.innerHTML);
        const text = Rich.toText(html);
        const pending = s.pending[friendId] || [];
        if (!text && !pending.length) return;

        s.sending = true;
        content.querySelector('.composer')?.classList.add('busy');
        input.innerHTML = '';
        s.drafts[friendId] = '';
        saveDraft();
        s.pending[friendId] = [];
        renderPending();

        const me = s.profile.id;
        const uploaded = [];
        try {
            for (const p of pending) {
                const ext = (p.name.match(/\.[a-z0-9]{1,5}$/i) || [''])[0].toLowerCase() || extFor(p.type);
                const path = `${me}/${friendId}/${randomId()}${ext}`;
                const { error } = await client.storage.from(BUCKET).upload(path, p.file, { contentType: p.type, upsert: false });
                if (error) throw new Error(`Couldn’t upload ${p.name}: ${error.message}`);
                uploaded.push({ path, name: p.name.slice(0, 120), type: p.type, size: p.size, kind: p.kind, ...(p.duration ? { duration: Math.round(p.duration) } : {}) });
            }
            const { data, error } = await client.from('diary_messages')
                .insert({ recipient: friendId, body: text ? html.slice(0, 20000) : '', attachments: uploaded })
                .select().single();
            if (error) throw error;
            pending.forEach(p => p.preview && URL.revokeObjectURL(p.preview));
            (s.threads[friendId] = s.threads[friendId] || []).push(data);
            s.last[friendId] = data;
            appendMessage(data);
            updateConvoRow(friendId);
        } catch (err) {
            app.showToast(err.message || 'Message not sent');
            if (uploaded.length) client.storage.from(BUCKET).remove(uploaded.map(u => u.path));
            const current = $('chat-input');
            if (current && s.activeFriend === friendId) current.innerHTML = html;
            s.drafts[friendId] = html;
            s.pending[friendId] = pending;
            renderPending();
        } finally {
            s.sending = false;
            content.querySelector('.composer')?.classList.remove('busy');
        }
    }

    function onIncomingMessage(m) {
        const thread = s.threads[m.sender];
        if (thread && !thread.some(x => x.id === m.id)) thread.push(m);
        s.last[m.sender] = m;

        const viewing = app.state.view === 'messages' && s.activeFriend === m.sender && document.visibilityState === 'visible';
        if (viewing) {
            appendMessage(m);
            updateConvoRow(m.sender);
            s.unread[m.sender] = 1;
            markRead(m.sender);
            return;
        }
        s.unread[m.sender] = (s.unread[m.sender] || 0) + 1;
        updateBadge();
        const friend = s.friends.find(f => f.id === m.sender);
        if (!s.muted.has(m.sender)) app.showToast(`New message from ${friend ? friend.display_name : 'a friend'}`);
        if (app.state.view === 'messages') updateConvoRow(m.sender);
    }

    function onMessageRead(m) {
        const thread = s.threads[m.recipient];
        const local = thread && thread.find(x => x.id === m.id);
        if (local) local.read_at = m.read_at;
        const tick = content.querySelector(`[data-msg="${m.id}"] .ticks`);
        if (tick && m.read_at) {
            tick.classList.add('read');
            tick.title = 'Read';
        }
    }

    function appendMessage(m) {
        const threadEl = $('chat-thread');
        const other = m.sender === s.profile.id ? m.recipient : m.sender;
        if (!threadEl || s.activeFriend !== other) return;
        const empty = threadEl.querySelector('.chat-empty');
        if (empty) empty.remove();
        const list = s.threads[other] || [];
        const prev = list[list.indexOf(m) - 1] || null;
        threadEl.insertAdjacentHTML('beforeend', messageHTML(m, prev));
        hydrateStorage(threadEl);
        threadEl.scrollTop = threadEl.scrollHeight;
    }

    // Refresh one conversation row without re-rendering the whole inbox (keeps the composer intact)
    function updateConvoRow(friendId) {
        const row = content.querySelector(`.convo[data-id="${CSS.escape(friendId)}"]`);
        const friend = s.friends.find(f => f.id === friendId);
        if (!row || !friend) return;
        row.outerHTML = convoRow(friend);
        const list = content.querySelector('.convo-list');
        const fresh = content.querySelector(`.convo[data-id="${CSS.escape(friendId)}"]`);
        if (list && fresh) list.prepend(fresh);
        paintPresence();
    }

    // ---------- Storage URLs ----------
    async function hydrateStorage(root) {
        const els = [...root.querySelectorAll('[data-path]:not([data-hydrated])')];
        if (!els.length || !client) return;
        const now = Date.now();
        const needed = [...new Set(els.map(el => el.dataset.path))]
            .filter(p => !s.urls.has(p) || s.urls.get(p).expires < now + 60000);
        if (needed.length) {
            const { data } = await client.storage.from(BUCKET).createSignedUrls(needed, 3600);
            (data || []).forEach(d => {
                if (d.signedUrl) s.urls.set(d.path, { url: d.signedUrl, expires: now + 3600 * 1000 });
            });
        }
        els.forEach(el => {
            const entry = s.urls.get(el.dataset.path);
            el.dataset.hydrated = '1';
            if (!entry) {
                el.classList.add('media-missing');
                return;
            }
            if (el.tagName === 'A') el.href = entry.url;
            else el.src = entry.url;
        });
    }

    // ---------- Feed ----------
    async function loadFeed() {
        if (s.feedLoading) return;
        s.feedLoading = true;
        const { data, error } = await client.from('diary_shared_entries').select(`
            id, author, title, body, html, color, mood, written_at, shared_at,
            author_profile:diary_profiles!diary_shared_entries_author_fkey(username, display_name),
            likes:diary_entry_likes(user_id)
        `).order('shared_at', { ascending: false }).limit(50);
        s.feedLoading = false;
        s.feed = error ? [] : data;
        if (app.state.view === 'feed') app.render();
    }

    async function toggleLike(entryId) {
        const post = (s.feed || []).find(p => p.id === entryId);
        if (!post) return;
        const me = s.profile.id;
        const liked = post.likes.some(l => l.user_id === me);
        post.likes = liked ? post.likes.filter(l => l.user_id !== me) : [...post.likes, { user_id: me }];
        app.render();

        const { error } = liked
            ? await client.from('diary_entry_likes').delete().eq('entry_id', entryId).eq('user_id', me)
            : await client.from('diary_entry_likes').insert({ entry_id: entryId, user_id: me });
        if (error) {
            app.showToast('Could not update like');
            post.likes = liked ? [...post.likes, { user_id: me }] : post.likes.filter(l => l.user_id !== me);
            app.render();
        }
    }

    // ---------- Sharing ----------
    async function loadRemoteIds() {
        const { data } = await client.from('diary_shared_entries').select('local_id').eq('author', s.profile.id);
        s.remoteIds = new Set((data || []).map(r => r.local_id));
    }

    function syncAllShared() {
        app.getNotes().filter(n => n.shared && !n.private && !n.trashedAt).forEach(upsertShared);
    }

    async function upsertShared(note) {
        let html = Rich.sanitize(note.html || '');
        if (html.length > 60000) html = Rich.textToHTML(note.text.slice(0, 20000));
        const { error } = await client.from('diary_shared_entries').upsert({
            author: s.profile.id,
            local_id: note.id,
            title: note.title.slice(0, 200),
            body: note.text.slice(0, 20000),
            html,
            color: note.color,
            mood: note.mood,
            written_at: new Date(note.createdAt).toISOString(),
            updated_at: new Date().toISOString()
        }, { onConflict: 'author,local_id' });
        if (error) return app.showToast('Could not share that entry');
        s.remoteIds.add(note.id);
        s.feed = null;
    }

    async function removeShared(note) {
        const { error } = await client.from('diary_shared_entries')
            .delete().eq('author', s.profile.id).eq('local_id', note.id);
        if (error) return app.showToast('Could not unshare that entry');
        s.remoteIds.delete(note.id);
        s.feed = null;
    }

    // ---------- Views ----------
    function gate(pitch) {
        if (!available) {
            return `<div class="empty"><p class="empty-title">Can’t connect right now</p>
                <p>Friends, messages and the feed need an internet connection. Reload the page to try again.</p></div>`;
        }
        if (!signedIn()) {
            return `<div class="empty">
                <p class="empty-title">Sign in to connect with friends</p>
                <p>${pitch}</p>
                <button class="primary-btn" style="margin-top:18px" data-action="sign-in">Sign in or create an account</button>
            </div>`;
        }
        return null;
    }

    app.views.feed = () => {
        app.setTitle('Feed');
        const blocked = gate('See entries your friends choose to share, and share your own.');
        if (blocked) return blocked;
        if (s.feed === null) {
            loadFeed();
            return '<p class="muted">Loading updates…</p>';
        }

        const me = s.profile.id;
        const filterFriend = s.feedAuthor && s.friends.find(f => f.id === s.feedAuthor);
        const list = s.feedAuthor ? s.feed.filter(p => p.author === s.feedAuthor) : s.feed;
        const posts = list.map(p => {
            const author = p.author_profile || { username: 'unknown', display_name: 'Someone' };
            const mine = p.author === me;
            const liked = p.likes.some(l => l.user_id === me);
            const long = p.body.length > 420 || p.body.split('\n').length > 7;
            const body = p.html ? Rich.sanitize(p.html) : esc(p.body);
            return `
                <article class="post">
                    <header class="post-head">
                        <span class="avatar sm">${esc(app.initials(author.display_name))}</span>
                        <div class="post-who">
                            <strong>${mine ? 'You' : esc(author.display_name)}</strong>
                            <span class="muted">@${esc(author.username)} · ${timeAgo(p.shared_at)}</span>
                        </div>
                    </header>
                    <div class="post-body tinted c-${esc(p.color)}">
                        <p class="post-date">${app.shortDate(new Date(p.written_at))}${p.mood ? ` · ${MOOD_EMOJI[p.mood] || ''}` : ''}</p>
                        ${p.title ? `<h3>${esc(p.title)}</h3>` : ''}
                        <div class="post-text rich-content${long ? ' clamped' : ''}">${body}</div>
                        ${long ? '<button class="read-more" data-action="expand-post">Read more</button>' : ''}
                    </div>
                    <footer class="post-foot">
                        <button class="like-btn" data-action="like" data-id="${esc(p.id)}" aria-pressed="${liked}" aria-label="${liked ? 'Unlike' : 'Like'}">
                            <svg class="i"><use href="#${liked ? 'i-heart-fill' : 'i-heart'}"/></svg>
                            <span>${p.likes.length || ''}</span>
                        </button>
                        ${mine ? '<span class="muted small">Shared by you</span>' : `<button class="chip" data-action="message-friend" data-id="${esc(p.author)}"><svg class="i"><use href="#i-chat"/></svg>Message</button>`}
                    </footer>
                </article>`;
        }).join('');

        return `
            <section class="section feed">
                <div class="section-head">
                    <div>
                        <h2>${filterFriend ? `${esc(filterFriend.display_name)}’s entries` : 'Friends’ updates'}</h2>
                        <p class="muted">Entries you and your friends chose to share.</p>
                    </div>
                    <div class="head-actions">
                        ${filterFriend ? '<button class="chip" data-action="feed-all"><svg class="i"><use href="#i-close"/></svg>Show everyone</button>' : ''}
                        <button class="chip" data-action="refresh-feed"><svg class="i"><use href="#i-refresh"/></svg>Refresh</button>
                        <button class="chip" data-action="find-friends"><svg class="i"><use href="#i-user"/></svg>Friends</button>
                    </div>
                </div>
                <div class="feed-list">
                    ${posts || `<div class="empty">
                        <p class="empty-title">No updates yet</p>
                        <p>Turn on <strong>Share with friends</strong> when writing an entry, or add friends to see theirs here.</p>
                    </div>`}
                </div>
            </section>`;
    };

    // ---------- Inbox (chat) ----------
    app.views.messages = () => {
        app.setTitle('Messages');
        const blocked = gate('Chat privately with friends and see what they’re writing.');
        if (blocked) return blocked;

        const friend = s.friends.find(f => f.id === s.activeFriend);
        const unreadCount = Object.values(s.unread).filter(Boolean).length;
        const tab = (key, label, count) => `
            <button class="inbox-tab" role="tab" aria-selected="${s.inboxTab === key}" data-action="inbox-tab" data-tab="${key}">
                ${label}${count ? `<span class="badge">${count}</span>` : ''}
            </button>`;

        let rows;
        if (s.inboxTab === 'requests') {
            rows = [
                ...s.incoming.map(f => `
                    <div class="convo static">${avatar(f, 'md')}
                        <span class="convo-main"><strong>${esc(f.display_name)}</strong><span class="convo-preview">@${esc(f.username)} wants to be friends</span>
                            <span class="row-actions">
                                <button class="chip accent" data-action="accept-request" data-id="${esc(f.friendshipId)}">Accept</button>
                                <button class="chip" data-action="decline-request" data-id="${esc(f.friendshipId)}">Decline</button>
                            </span>
                        </span>
                    </div>`),
                ...s.outgoing.map(f => `
                    <div class="convo static">${avatar(f, 'md')}
                        <span class="convo-main"><strong>${esc(f.display_name)}</strong><span class="convo-preview">Waiting for @${esc(f.username)}</span>
                            <span class="row-actions"><button class="chip" data-action="cancel-request" data-id="${esc(f.friendshipId)}">Cancel request</button></span>
                        </span>
                    </div>`)
            ].join('') || '<p class="inbox-empty">No pending requests.</p>';
        } else {
            const list = sortedFriends().filter(f => s.inboxTab !== 'unread' || s.unread[f.id]);
            rows = list.map(convoRow).join('') ||
                `<p class="inbox-empty">${s.inboxTab === 'unread' ? 'You’re all caught up.' : 'No friends yet. Tap + to add someone by username.'}</p>`;
        }

        return `
            <div class="inbox${friend ? ' has-active' : ''}${s.showInfo && friend ? ' show-info' : ''}">
                <aside class="inbox-list">
                    <div class="inbox-head">
                        <h2>Inbox</h2>
                        <button class="icon-btn solid" data-action="toggle-add" aria-label="Add a friend" title="Add a friend"><svg class="i"><use href="#i-plus"/></svg></button>
                    </div>
                    <form class="add-friend" data-form="add-friend"${s.addOpen ? '' : ' hidden'}>
                        <input id="add-friend-input" placeholder="Friend’s username" autocomplete="off" aria-label="Friend's username">
                        <button class="primary-btn">Add</button>
                    </form>
                    <label class="search inbox-search">
                        <svg class="i"><use href="#i-search"/></svg>
                        <input type="search" id="chat-search" placeholder="Search chats and people" aria-label="Search chats">
                    </label>
                    <div class="inbox-tabs" role="tablist">
                        ${tab('all', 'All', 0)}${tab('unread', 'Unread', unreadCount)}${tab('requests', 'Requests', s.incoming.length)}
                    </div>
                    <div class="convo-list">${rows}</div>
                    <p class="muted small inbox-foot">You’re <strong>@${esc(s.profile.username)}</strong> — share it so friends can add you.</p>
                </aside>
                <section class="chat-pane">
                    ${friend ? chatPane(friend) : `<div class="chat-placeholder"><svg class="i"><use href="#i-chat"/></svg>
                        <p>Pick a conversation to start chatting.</p></div>`}
                </section>
                ${friend ? infoPane(friend) : ''}
            </div>`;
    };

    function sortedFriends() {
        return [...s.friends].sort((a, b) => {
            const ta = s.last[a.id] ? Date.parse(s.last[a.id].created_at) : 0;
            const tb = s.last[b.id] ? Date.parse(s.last[b.id].created_at) : 0;
            return tb - ta || a.display_name.localeCompare(b.display_name);
        });
    }

    function avatar(f, size = 'sm') {
        return `<span class="avatar ${size}" data-presence="${esc(f.id)}">${esc(app.initials(f.display_name))}<span class="presence-dot" aria-hidden="true"></span></span>`;
    }

    function convoRow(f) {
        const m = s.last[f.id];
        const unread = s.unread[f.id];
        const preview = m ? `${m.sender === s.profile.id ? 'You: ' : ''}${previewOf(m)}` : 'Say hello 👋';
        return `
            <button class="convo${f.id === s.activeFriend ? ' active' : ''}${unread ? ' unread' : ''}" data-action="open-chat" data-id="${esc(f.id)}"
                data-search="${esc(`${f.display_name} ${f.username}`.toLowerCase())}">
                ${avatar(f, 'md')}
                <span class="convo-main">
                    <span class="convo-top"><strong>${esc(f.display_name)}</strong>${m ? `<time>${shortTime(m.created_at)}</time>` : ''}</span>
                    <span class="convo-bottom"><span class="convo-preview">${esc(preview)}</span>${unread ? `<span class="badge">${unread}</span>` : ''}</span>
                </span>
            </button>`;
    }

    function previewOf(m) {
        const text = Rich.toText(m.body || '').replace(/\s+/g, ' ').trim();
        if (text) return text.slice(0, 80);
        const a = (m.attachments || [])[0];
        if (!a) return '';
        if (a.kind === 'audio') return '🎤 Voice note';
        if (a.kind === 'image' || a.kind === 'drawing') return '📷 Photo';
        return `📎 ${a.name}`;
    }

    function chatPane(friend) {
        const thread = s.threads[friend.id];
        let body;
        if (!thread) body = '<p class="chat-empty">Loading…</p>';
        else if (!thread.length) body = `<p class="chat-empty">This is the start of your chat with ${esc(friend.display_name)}. Say hi 👋</p>`;
        else body = thread.map((m, i) => messageHTML(m, thread[i - 1] || null)).join('');

        return `
            <header class="chat-head">
                <button class="icon-btn back-chat" data-action="close-chat" aria-label="Back to inbox"><svg class="i"><use href="#i-back"/></svg></button>
                ${avatar(friend, 'sm')}
                <div class="friend-name">${esc(friend.display_name)}<small data-status="${esc(friend.id)}" data-away="@${esc(friend.username)}">${s.online.has(friend.id) ? 'Active now' : `@${esc(friend.username)}`}</small></div>
                <button class="icon-btn" data-action="toggle-info" aria-pressed="${s.showInfo}" aria-label="Contact details" title="Contact details"><svg class="i"><use href="#i-info"/></svg></button>
            </header>
            <div class="chat-thread" id="chat-thread">${body}</div>
            <form class="composer" data-form="send-message">
                <div class="pending-atts" id="pending-atts" hidden></div>
                <div class="rich-toolbar compact" id="chat-toolbar" role="toolbar" aria-label="Formatting"${s.showFormat ? '' : ' hidden'}></div>
                <div class="composer-row">
                    <div class="composer-box">
                        <div class="rich chat-input" id="chat-input" contenteditable="true" role="textbox" aria-multiline="true"
                            aria-label="Message ${esc(friend.display_name)}" data-placeholder="Type your message…"></div>
                        <div class="composer-tools">
                            <button type="button" class="tool-btn" data-action="chat-format" aria-pressed="${s.showFormat}" title="Formatting" aria-label="Formatting"><span class="aa">Aa</span></button>
                            <button type="button" class="tool-btn" data-action="chat-add" title="Add photo, document, voice note or drawing" aria-label="Add"><svg class="i"><use href="#i-plus"/></svg></button>
                            <button type="button" class="tool-btn" data-action="chat-emoji" title="Emoji" aria-label="Emoji"><svg class="i"><use href="#i-smile"/></svg></button>
                            <button type="button" class="tool-btn" data-action="chat-voice" title="Record a voice note" aria-label="Record a voice note"><svg class="i"><use href="#i-mic"/></svg></button>
                            <button type="button" class="tool-btn" data-action="chat-file" title="Attach a document" aria-label="Attach a document"><svg class="i"><use href="#i-paperclip"/></svg></button>
                        </div>
                        <div class="emoji-panel" id="emoji-panel" hidden>
                            ${EMOJI.map(e => `<button type="button" data-action="emoji" data-emoji="${e}" aria-label="${e}">${e}</button>`).join('')}
                        </div>
                    </div>
                    <button class="send-btn dark" aria-label="Send"><svg class="i"><use href="#i-send"/></svg></button>
                </div>
            </form>`;
    }

    function messageHTML(m, prev) {
        const mine = m.sender === s.profile.id;
        const friend = s.friends.find(f => f.id === (mine ? m.recipient : m.sender));
        const date = new Date(m.created_at);
        const newDay = !prev || new Date(prev.created_at).toDateString() !== date.toDateString();
        const sep = newDay ? `<div class="day-sep"><span>${app.dayLabel(app.dayKey(date))}</span></div>` : '';
        const body = m.body ? `<div class="msg-body rich-content">${Rich.sanitize(m.body)}</div>` : '';
        const atts = (m.attachments || []).map(attachmentHTML).join('');
        return `${sep}
            <div class="msg ${mine ? 'out' : 'in'}" data-msg="${esc(String(m.id))}">
                ${mine || !friend ? '' : avatar(friend, 'xs')}
                <div class="msg-card">
                    <div class="msg-head"><strong>${mine ? 'You' : esc(friend ? friend.display_name : 'Friend')}</strong><time>${shortTime(m.created_at)}</time></div>
                    ${body}
                    ${atts ? `<div class="msg-atts">${atts}</div>` : ''}
                    ${mine ? `<span class="ticks${m.read_at ? ' read' : ''}" title="${m.read_at ? 'Read' : 'Sent'}"><svg class="i"><use href="#i-checks"/></svg></span>` : ''}
                </div>
            </div>`;
    }

    function attachmentHTML(a) {
        if (!a || typeof a.path !== 'string') return '';
        const path = esc(a.path);
        const name = esc(a.name || 'attachment');
        if (a.kind === 'image' || a.kind === 'drawing') {
            return `<button type="button" class="msg-img" data-action="chat-view-image" data-img="${path}" aria-label="View ${name}"><img data-path="${path}" alt="${name}"></button>`;
        }
        if (a.kind === 'audio') {
            return `<div class="msg-audio"><svg class="i"><use href="#i-mic"/></svg><audio controls preload="none" data-path="${path}"></audio>${a.duration ? `<span>${Media.formatDuration(a.duration)}</span>` : ''}</div>`;
        }
        return `<a class="file-chip" data-path="${path}" target="_blank" rel="noopener" download="${name}">
            <svg class="i"><use href="#i-file"/></svg><span>${name}<small>${Media.formatSize(a.size)}</small></span></a>`;
    }

    function infoPane(friend) {
        const thread = s.threads[friend.id] || [];
        const atts = thread.flatMap(m => m.attachments || []);
        const media = atts.filter(a => a.kind === 'image' || a.kind === 'drawing').slice(-6).reverse();
        const files = atts.filter(a => a.kind === 'file').slice(-5).reverse();
        const voice = atts.filter(a => a.kind === 'audio').length;
        const muted = s.muted.has(friend.id);
        const row = (icon, tone, label, value) => `
            <div class="info-row"><span class="info-ic ${tone}"><svg class="i"><use href="#${icon}"/></svg></span>
            <span>${label}</span><b>${value}</b></div>`;

        return `
            <aside class="chat-info" aria-label="Contact details">
                <button class="icon-btn close-info" data-action="toggle-info" aria-label="Close details"><svg class="i"><use href="#i-close"/></svg></button>
                <div class="info-head">
                    ${avatar(friend, 'lg')}
                    <div><strong>${esc(friend.display_name)}</strong><small>@${esc(friend.username)}</small></div>
                </div>
                <div class="info-actions">
                    <button class="icon-btn outline" data-action="toggle-mute" aria-pressed="${muted}" title="${muted ? 'Unmute' : 'Mute'} notifications"><svg class="i"><use href="#i-bell"/></svg></button>
                    <button class="primary-btn dark" data-action="friend-entries" data-id="${esc(friend.id)}">View shared entries</button>
                </div>
                <div class="info-stats">
                    ${row('i-user', 'green', 'Status', `<span data-status="${esc(friend.id)}" data-away="Away">${s.online.has(friend.id) ? 'Active now' : 'Away'}</span>`)}
                    ${row('i-chat', 'blue', 'Messages', thread.length)}
                    ${row('i-heart', 'pink', 'Friends since', new Date(friend.since).toLocaleDateString(undefined, { month: 'short', year: 'numeric' }))}
                    ${row('i-mic', 'yellow', 'Voice notes', voice)}
                </div>
                <h4 class="info-label">Shared media</h4>
                ${media.length ? `<div class="info-media">${media.map(a => `<button type="button" class="msg-img" data-action="chat-view-image" data-img="${esc(a.path)}"><img data-path="${esc(a.path)}" alt="${esc(a.name || '')}"></button>`).join('')}</div>` : '<p class="muted small">Photos you share appear here.</p>'}
                <h4 class="info-label">Files</h4>
                ${files.length ? files.map(attachmentHTML).join('') : '<p class="muted small">No documents yet.</p>'}
                <h4 class="info-label">Settings</h4>
                <label class="info-row toggle">
                    <span class="info-ic purple"><svg class="i"><use href="#i-bell"/></svg></span><span>Notifications</span>
                    <span class="share-toggle"><input type="checkbox" data-action="toggle-mute"${muted ? '' : ' checked'}><span class="switch" aria-hidden="true"></span></span>
                </label>
                <button class="info-row danger" data-action="friend-remove" data-id="${esc(friend.id)}">
                    <span class="info-ic red"><svg class="i"><use href="#i-trash"/></svg></span><span>Remove friend</span>
                </button>
            </aside>`;
    }

    // ---------- View actions ----------
    Object.assign(app.actions, {
        'sign-in': () => openAuth(),
        'refresh-feed': () => { s.feed = null; app.render(); },
        'feed-all': () => { s.feedAuthor = null; app.render(); },
        'find-friends': () => app.setView('messages'),
        'like': el => toggleLike(el.dataset.id),
        'expand-post': el => {
            const text = el.previousElementSibling;
            const open = text.classList.toggle('clamped');
            el.textContent = open ? 'Read more' : 'Show less';
        },
        'message-friend': el => {
            app.setView('messages');
            if (s.friends.some(f => f.id === el.dataset.id)) openChat(el.dataset.id);
        },
        'friend-entries': el => {
            s.feedAuthor = el.dataset.id;
            s.feed = null;
            app.setView('feed');
        },
        'inbox-tab': el => { s.inboxTab = el.dataset.tab; app.render(); },
        'toggle-add': () => {
            s.addOpen = !s.addOpen;
            app.render();
            if (s.addOpen) $('add-friend-input').focus();
        },
        'open-chat': el => openChat(el.dataset.id),
        'close-chat': () => { s.activeFriend = null; app.render(); },
        'toggle-info': () => { s.showInfo = !s.showInfo; app.render(); },
        'toggle-mute': () => {
            const id = s.activeFriend;
            if (s.muted.has(id)) s.muted.delete(id);
            else s.muted.add(id);
            try { localStorage.setItem('diaryMuted', JSON.stringify([...s.muted])); } catch (e) {}
            app.showToast(s.muted.has(id) ? 'Notifications muted' : 'Notifications on');
            app.render();
        },
        'friend-remove': el => {
            const friend = s.friends.find(f => f.id === el.dataset.id);
            if (!friend) return;
            removeFriendship(friend.friendshipId, {
                title: `Remove ${friend.display_name}?`,
                text: 'You’ll stop seeing each other’s shared entries and won’t be able to message until you’re friends again.',
                ok: 'Remove'
            });
        },
        'accept-request': el => respond(el.dataset.id, true),
        'decline-request': el => respond(el.dataset.id, false),
        'cancel-request': el => removeFriendship(el.dataset.id),
        'chat-format': el => {
            s.showFormat = !s.showFormat;
            $('chat-toolbar').hidden = !s.showFormat;
            el.setAttribute('aria-pressed', String(s.showFormat));
            $('chat-input').focus();
        },
        'chat-emoji': () => {
            const panel = $('emoji-panel');
            panel.hidden = !panel.hidden;
        },
        'emoji': el => {
            Rich.insertText($('chat-input'), el.dataset.emoji);
            $('emoji-panel').hidden = true;
            saveDraft();
        },
        'chat-add': el => app.openPopover(el, [
            { label: 'Photo', icon: 'i-image', onClick: async () => addPending(await Media.pickFiles('image/png,image/jpeg,image/gif,image/webp')) },
            { label: 'Document', icon: 'i-file', onClick: async () => addPending(await Media.pickFiles(DOC_ACCEPT)) },
            { label: 'Voice note', icon: 'i-mic', onClick: recordChatVoice },
            { label: 'Drawing', icon: 'i-draw', onClick: drawForChat }
        ]),
        'chat-voice': () => recordChatVoice(),
        'chat-file': async () => addPending(await Media.pickFiles(`${DOC_ACCEPT},image/*`)),
        'remove-pending': el => {
            const list = s.pending[s.activeFriend] || [];
            const item = list.find(p => p.id === el.dataset.id);
            if (item && item.preview) URL.revokeObjectURL(item.preview);
            s.pending[s.activeFriend] = list.filter(p => p.id !== el.dataset.id);
            renderPending();
        },
        'chat-view-image': el => {
            const entry = s.urls.get(el.dataset.img);
            if (entry) Media.lightbox(entry.url);
        }
    });

    async function recordChatVoice() {
        const result = await Media.recordVoice();
        if (!result) return;
        if (result.error) return app.showToast(result.error);
        const ext = extFor(result.type);
        const file = new File([result.blob], `Voice note${ext}`, { type: result.type });
        addPending([file], { kind: 'audio', duration: result.duration });
    }

    async function drawForChat() {
        const result = await Media.drawPad();
        if (!result) return;
        addPending([new File([result.blob], 'Drawing.png', { type: 'image/png' })], { kind: 'drawing' });
    }

    content.addEventListener('submit', e => {
        const form = e.target.closest('form[data-form]');
        if (!form) return;
        e.preventDefault();
        if (form.dataset.form === 'add-friend') {
            const input = $('add-friend-input');
            const username = input.value.trim().replace(/^@/, '').toLowerCase();
            if (username) addFriend(username);
        } else if (form.dataset.form === 'send-message') {
            sendMessage();
        }
    });

    content.addEventListener('keydown', e => {
        if (e.target.id === 'chat-input' && e.key === 'Enter' && !e.shiftKey && !e.defaultPrevented) {
            e.preventDefault();
            sendMessage();
        }
    });

    content.addEventListener('input', e => {
        if (e.target.id === 'chat-input') saveDraft();
        if (e.target.id === 'chat-search') {
            // Filter rows in place so typing isn't interrupted by a re-render
            const q = e.target.value.trim().toLowerCase();
            content.querySelectorAll('.convo[data-search]').forEach(row => {
                row.hidden = !!q && !row.dataset.search.includes(q);
            });
        }
    });

    content.addEventListener('focusin', e => { if (e.target.id === 'chat-input') s.chatFocused = true; });
    content.addEventListener('focusout', e => {
        if (e.target.id === 'chat-input' && e.relatedTarget && !e.relatedTarget.closest('.composer')) s.chatFocused = false;
    });

    // Drop files anywhere on an open chat
    content.addEventListener('dragover', e => {
        if (e.target.closest('.chat-pane') && s.activeFriend && e.dataTransfer?.types.includes('Files')) e.preventDefault();
    });
    content.addEventListener('drop', e => {
        if (!e.target.closest('.chat-pane') || !s.activeFriend) return;
        const files = [...(e.dataTransfer?.files || [])];
        if (files.length) {
            e.preventDefault();
            addPending(files);
        }
    });

    // Catch up on anything missed while the tab was hidden
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState !== 'visible' || !signedIn()) return;
        if (app.state.view === 'messages' && s.activeFriend) {
            loadThread(s.activeFriend);
            markRead(s.activeFriend);
        } else {
            loadRecent();
        }
    });

    // ---------- Helpers ----------
    const MOOD_EMOJI = { happy: '😊', calm: '😌', thoughtful: '🤔', sad: '😔', stressed: '😤' };

    function load(key, fallback) {
        try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch (e) { return fallback; }
    }

    function randomId() {
        return (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    }

    function extFor(type) {
        return {
            'audio/webm': '.webm', 'audio/ogg': '.ogg', 'audio/mp4': '.m4a', 'audio/mpeg': '.mp3', 'audio/wav': '.wav',
            'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif', 'image/webp': '.webp', 'application/pdf': '.pdf'
        }[type] || '';
    }

    function shortTime(iso) {
        const d = new Date(iso);
        const today = new Date().toDateString() === d.toDateString();
        return today
            ? d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
            : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    }

    function timeAgo(iso) {
        const seconds = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
        if (seconds < 60) return 'just now';
        const units = [['year', 31536000], ['month', 2592000], ['week', 604800], ['day', 86400], ['hour', 3600], ['minute', 60]];
        const [unit, size] = units.find(([, size]) => seconds >= size);
        return new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' }).format(-Math.floor(seconds / size), unit);
    }
});
