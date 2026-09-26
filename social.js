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
        remotePhotos: new Map(), // local id -> [{ id, path, name }] uploaded for the feed
        feedSort: 'latest',
        feedFilter: 'all',   // all | mine | saved | tag:<name>
        saved: new Set(load('diarySavedPosts', [])),
        seenStories: new Set(load('diarySeenStories', [])),
        suggestions: [],
        feedDraft: { text: '', photos: [] }, // the feed composer survives re-renders
        posting: false,
        rec: null,           // in-progress chat voice recording
        channel: null,
        presence: null
    };
    const FEED_BUCKET = 'diary-feed';
    const FEED_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];

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

    // Friend avatars on the Notes page header
    app.hooks.friendAvatars = () => {
        if (!signedIn() || !s.friends.length) return '';
        const shown = s.friends.slice(0, 4);
        const extra = s.friends.length - shown.length;
        return `<span class="avatar-stack" title="${s.friends.length} friends">${shown.map(f => avatar(f, 'sm')).join('')}${extra > 0 ? `<span class="avatar sm more">+${extra}</span>` : ''}</span>`;
    };

    app.hooks.afterRender = view => {
        if (view === 'home') paintPresence();
        if (view === 'feed') {
            hydrateStorage(content);
            const text = $('feed-text');
            if (text) {
                text.value = s.feedDraft.text;
                renderFeedPhotos();
            }
        }
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
            if (s.rec) showRecBar();
            if (s.chatFocused) {
                input.focus();
                Rich.placeCaretAtEnd(input);
            }
        }
    };

    // Keep shared entries in sync with the feed (private entries are never shared).
    // Autosave fires often, so syncs are debounced per entry and run one at a time.
    const shareTimers = new Map();
    let shareChain = Promise.resolve();
    const queue = job => { shareChain = shareChain.then(job).catch(() => {}); };

    app.on('note', note => {
        if (!signedIn()) return;
        clearTimeout(shareTimers.get(note.id));
        shareTimers.set(note.id, setTimeout(() => queue(() => {
            const n = app.getNotes().find(x => x.id === note.id);
            if (!n || !signedIn()) return;
            if (n.shared && !n.private && !n.trashedAt) return upsertShared(n);
            if (s.remoteIds.has(n.id)) return removeShared(n);
        }), 1200));
    });
    app.on('note-removed', note => {
        clearTimeout(shareTimers.get(note.id));
        if (signedIn() && s.remoteIds.has(note.id)) queue(() => removeShared(note));
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
        $('messages-count-m').textContent = total ? String(total) : '';
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
        updateComposerButton();
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
        updateComposerButton();
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

        input.innerHTML = '';
        s.drafts[friendId] = '';
        saveDraft();
        s.pending[friendId] = [];
        renderPending();

        const ok = await deliver(friendId, text ? html : '', pending);
        if (!ok) {
            const current = $('chat-input');
            if (current && s.activeFriend === friendId) current.innerHTML = html;
            s.drafts[friendId] = html;
            s.pending[friendId] = pending;
            renderPending();
        }
        updateComposerButton();
    }

    // Upload attachments, then insert the message. Returns false (after telling the user) on failure.
    async function deliver(friendId, html, items) {
        s.sending = true;
        content.querySelector('.composer')?.classList.add('busy');
        const me = s.profile.id;
        const uploaded = [];
        try {
            for (const p of items) {
                const ext = (p.name.match(/\.[a-z0-9]{1,5}$/i) || [''])[0].toLowerCase() || extFor(p.type);
                const path = `${me}/${friendId}/${randomId()}${ext}`;
                const { error } = await client.storage.from(BUCKET).upload(path, p.file, { contentType: p.type, upsert: false });
                if (error) throw new Error(`Couldn’t upload ${p.name}: ${error.message}`);
                uploaded.push({
                    path, name: p.name.slice(0, 120), type: p.type, size: p.size, kind: p.kind,
                    ...(p.duration ? { duration: Math.round(p.duration) } : {}),
                    ...(p.waveform ? { waveform: p.waveform.slice(0, 40) } : {})
                });
            }
            const { data, error } = await client.from('diary_messages')
                .insert({ recipient: friendId, body: html.slice(0, 20000), attachments: uploaded })
                .select().single();
            if (error) throw error;
            items.forEach(p => p.preview && URL.revokeObjectURL(p.preview));
            (s.threads[friendId] = s.threads[friendId] || []).push(data);
            s.last[friendId] = data;
            appendMessage(data);
            updateConvoRow(friendId);
            return true;
        } catch (err) {
            app.showToast(err.message || 'Message not sent');
            if (uploaded.length) client.storage.from(BUCKET).remove(uploaded.map(u => u.path));
            return false;
        } finally {
            s.sending = false;
            content.querySelector('.composer')?.classList.remove('busy');
        }
    }

    // ---------- Voice notes (WhatsApp style) ----------
    // Hold the mic to record and release to send; slide left to cancel.
    // A quick tap (or "+ → Voice note") records hands-free until you tap send or the bin.
    async function startVoice(startX, locked = false) {
        if (s.rec || !s.activeFriend || s.sending) return;
        const rec = s.rec = { mode: locked ? 'locked' : 'hold', startX, down: Date.now(), friendId: s.activeFriend, controller: null, released: false, levels: [] };
        showRecBar();
        try {
            rec.controller = await Media.createRecorder((level, secs) => paintRec(rec, level, secs));
        } catch (err) {
            if (s.rec === rec) s.rec = null;
            hideRecBar();
            app.showToast(err.message);
            return;
        }
        if (s.rec !== rec) return rec.controller.cancel(); // cancelled while the permission prompt was up
        if (rec.released) lockVoice();                    // released during the prompt: switch to hands-free
    }

    function releaseVoice() {
        const rec = s.rec;
        rec.released = true;
        if (!rec.controller) return;
        if (Date.now() - rec.down < 400) lockVoice();
        else finishVoice(true);
    }

    function lockVoice() {
        if (!s.rec) return;
        s.rec.mode = 'locked';
        const hint = $('rec-hint');
        if (hint) hint.textContent = 'Recording — tap send when you’re done';
        updateComposerButton();
    }

    async function finishVoice(send) {
        const rec = s.rec;
        if (!rec || !rec.controller) return;
        s.rec = null;
        const result = await rec.controller.stop();
        hideRecBar();
        updateComposerButton();
        if (!send) return;
        if (result.duration < 1) {
            app.showToast('Hold the mic a little longer to record');
            return;
        }
        const file = new File([result.blob], `Voice note${extFor(result.type)}`, { type: result.type });
        await deliver(rec.friendId, '', [{
            file, type: result.type, name: 'Voice note', size: file.size, kind: 'audio',
            duration: result.duration, waveform: result.waveform
        }]);
    }

    function cancelVoice(message) {
        const rec = s.rec;
        if (!rec) return;
        s.rec = null;
        if (rec.controller) rec.controller.cancel();
        hideRecBar();
        updateComposerButton();
        if (message) app.showToast(message);
    }

    function showRecBar() {
        content.querySelector('.composer')?.classList.add('recording');
        const hint = $('rec-hint');
        if (hint && s.rec) hint.textContent = s.rec.mode === 'locked' ? 'Recording — tap send when you’re done' : '‹ Slide left to cancel';
        if (s.rec) paintRec(s.rec, null, (Date.now() - s.rec.down) / 1000);
        updateComposerButton();
    }

    function hideRecBar() {
        content.querySelector('.composer')?.classList.remove('recording');
    }

    function paintRec(rec, level, secs) {
        if (level !== null) {
            rec.levels.push(level);
            if (rec.levels.length > 48) rec.levels.shift();
        }
        const time = $('rec-time');
        const wave = $('rec-wave');
        if (time) time.textContent = Media.formatDuration(secs);
        if (wave) wave.innerHTML = rec.levels.map(v => `<span style="height:${Math.round(Math.max(0.12, v) * 100)}%"></span>`).join('');
        if (secs >= 300 && s.rec === rec) finishVoice(true); // 5 minute cap
    }

    content.addEventListener('pointerdown', e => {
        const btn = e.target.closest('#chat-action');
        if (!btn || btn.dataset.mode !== 'mic') return;
        e.preventDefault();
        startVoice(e.clientX);
    });
    document.addEventListener('pointerup', () => { if (s.rec && s.rec.mode === 'hold') releaseVoice(); });
    document.addEventListener('pointercancel', () => { if (s.rec && s.rec.mode === 'hold') lockVoice(); });
    document.addEventListener('pointermove', e => {
        if (s.rec && s.rec.mode === 'hold' && s.rec.startX - e.clientX > 90) cancelVoice('Voice note cancelled');
    });

    content.addEventListener('click', e => {
        const btn = e.target.closest('#chat-action');
        if (!btn) return;
        if (btn.dataset.mode === 'send') sendMessage();
        else if (btn.dataset.mode === 'rec-send') finishVoice(true);
    });

    // ---------- Voice note player ----------
    function voiceHTML(a) {
        const wave = (Array.isArray(a.waveform) && a.waveform.length ? a.waveform : pseudoWave(a.path))
            .slice(0, 60)
            .map(v => Math.max(0.1, Math.min(1, Number(v) || 0.1)));
        return `
            <div class="vn" data-duration="${Number(a.duration) || 0}">
                <button type="button" class="vn-play" data-action="vn-play" aria-label="Play voice note"><svg class="i"><use href="#i-play"/></svg></button>
                <div class="vn-main">
                    <div class="vn-wave" data-action="vn-seek" aria-hidden="true">${wave.map(v => `<span style="height:${Math.round(v * 100)}%"></span>`).join('')}</div>
                    <div class="vn-meta">
                        <span class="vn-time">${Media.formatDuration(a.duration)}</span>
                        <button type="button" class="vn-speed" data-action="vn-speed" aria-label="Playback speed">1×</button>
                    </div>
                </div>
                <span class="vn-mic" aria-hidden="true"><svg class="i"><use href="#i-mic"/></svg></span>
                <audio preload="none" data-path="${esc(a.path)}"></audio>
            </div>`;
    }

    // Stable fake waveform for voice notes sent before waveforms were recorded
    function pseudoWave(seed) {
        let h = 0;
        for (const c of String(seed)) h = (h * 31 + c.charCodeAt(0)) >>> 0;
        return Array.from({ length: 40 }, () => {
            h = (h * 1103515245 + 12345) >>> 0;
            return 0.2 + (h % 800) / 1000;
        });
    }

    function bindVoice(vn) {
        const audio = vn.querySelector('audio');
        if (vn.dataset.bound) return audio;
        vn.dataset.bound = '1';
        const bars = [...vn.querySelectorAll('.vn-wave span')];
        const time = vn.querySelector('.vn-time');
        const btn = vn.querySelector('.vn-play');
        const total = () => (Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : Number(vn.dataset.duration) || 1);
        const paint = () => {
            const played = Math.round(Math.min(1, audio.currentTime / total()) * bars.length);
            bars.forEach((b, i) => b.classList.toggle('played', i < played));
            time.textContent = Media.formatDuration(audio.currentTime > 0 ? audio.currentTime : total());
        };
        const icon = name => { btn.innerHTML = `<svg class="i"><use href="#${name}"/></svg>`; };
        audio.addEventListener('timeupdate', paint);
        audio.addEventListener('play', () => { vn.classList.add('playing'); icon('i-pause'); btn.setAttribute('aria-label', 'Pause voice note'); });
        audio.addEventListener('pause', () => { vn.classList.remove('playing'); icon('i-play'); btn.setAttribute('aria-label', 'Play voice note'); });
        audio.addEventListener('ended', () => { audio.currentTime = 0; paint(); });
        return audio;
    }

    async function toggleVoice(vn) {
        const audio = bindVoice(vn);
        if (!audio.paused) return audio.pause();
        if (!audio.src) await hydrateStorage(vn);
        if (!audio.src) return app.showToast('Couldn’t load that voice note');
        document.querySelectorAll('.vn audio').forEach(a => { if (a !== audio) a.pause(); });
        try {
            await audio.play();
        } catch (e) {
            app.showToast('Couldn’t play that voice note');
        }
    }

    async function seekVoice(vn, e) {
        const audio = bindVoice(vn);
        const rect = vn.querySelector('.vn-wave').getBoundingClientRect();
        const ratio = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
        if (!audio.src) await hydrateStorage(vn);
        const total = Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : Number(vn.dataset.duration) || 0;
        try { audio.currentTime = ratio * total; } catch (err) {}
        if (audio.paused) toggleVoice(vn);
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
    // Signed URLs for private storage; elements may name their bucket with data-bucket (chat by default)
    async function hydrateStorage(root) {
        const els = [...root.querySelectorAll('[data-path]:not([data-hydrated])')];
        if (!els.length || !client) return;
        const now = Date.now();
        const key = el => `${el.dataset.bucket || BUCKET}:${el.dataset.path}`;
        const byBucket = new Map();
        els.forEach(el => {
            const k = key(el);
            if (s.urls.has(k) && s.urls.get(k).expires > now + 60000) return;
            const bucket = el.dataset.bucket || BUCKET;
            if (!byBucket.has(bucket)) byBucket.set(bucket, new Set());
            byBucket.get(bucket).add(el.dataset.path);
        });
        await Promise.all([...byBucket.entries()].map(async ([bucket, paths]) => {
            const { data } = await client.storage.from(bucket).createSignedUrls([...paths], 3600);
            (data || []).forEach(d => {
                if (d.signedUrl) s.urls.set(`${bucket}:${d.path}`, { url: d.signedUrl, expires: now + 3600 * 1000 });
            });
        }));
        els.forEach(el => {
            const entry = s.urls.get(key(el));
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
        const [feedRes, suggestRes] = await Promise.all([
            client.from('diary_shared_entries').select(`
                id, author, local_id, title, body, html, color, mood, photos, written_at, shared_at,
                author_profile:diary_profiles!diary_shared_entries_author_fkey(username, display_name),
                likes:diary_entry_likes(user_id)
            `).order('shared_at', { ascending: false }).limit(60),
            client.rpc('diary_friend_suggestions')
        ]);
        s.feedLoading = false;
        s.feed = feedRes.error ? [] : feedRes.data;
        s.suggestions = suggestRes.error ? [] : suggestRes.data;
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
        const { data } = await client.from('diary_shared_entries').select('local_id, photos').eq('author', s.profile.id);
        s.remoteIds = new Set((data || []).map(r => r.local_id));
        s.remotePhotos = new Map((data || []).map(r => [r.local_id, r.photos || []]));
    }

    function syncAllShared() {
        app.getNotes().filter(n => n.shared && !n.private && !n.trashedAt).forEach(n => queue(() => upsertShared(n)));
    }

    // Upload new entry photos to the friends-only bucket and drop ones that were removed
    async function syncPhotos(note) {
        const me = s.profile.id;
        const images = note.attachments
            .filter(a => (a.kind === 'image' || a.kind === 'drawing') && FEED_TYPES.includes(a.type))
            .slice(0, 10);
        const previous = s.remotePhotos.get(note.id) || [];
        const photos = [];
        for (const img of images) {
            const existing = previous.find(p => p.id === img.id);
            if (existing) {
                photos.push(existing);
                continue;
            }
            const blob = await Media.get(img.id);
            if (!blob) continue;
            const path = `${me}/${note.id}/${img.id}${extFor(img.type)}`;
            const { error } = await client.storage.from(FEED_BUCKET).upload(path, blob, { contentType: img.type, upsert: false });
            if (error && !/exist/i.test(error.message)) continue;
            photos.push({ id: img.id, path, name: String(img.name || '').slice(0, 120) });
        }
        const stale = previous.filter(p => !photos.some(x => x.id === p.id)).map(p => p.path);
        if (stale.length) await client.storage.from(FEED_BUCKET).remove(stale);
        return photos;
    }

    async function upsertShared(note) {
        let html = Rich.sanitize(note.html || '');
        if (html.length > 60000) html = Rich.textToHTML(note.text.slice(0, 20000));
        const photos = await syncPhotos(note);
        s.remotePhotos.set(note.id, photos);
        const { error } = await client.from('diary_shared_entries').upsert({
            photos,
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
        if (error) {
            app.showToast('Could not share that entry');
            return { ok: false, photos: 0 };
        }
        s.remoteIds.add(note.id);
        s.feed = null;
        return { ok: true, photos: photos.length };
    }

    async function removeShared(note) {
        const { error } = await client.from('diary_shared_entries')
            .delete().eq('author', s.profile.id).eq('local_id', note.id);
        if (error) return app.showToast('Could not unshare that entry');
        const photos = (s.remotePhotos.get(note.id) || []).map(p => p.path);
        if (photos.length) await client.storage.from(FEED_BUCKET).remove(photos);
        s.remotePhotos.delete(note.id);
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
        const mine = s.feed.filter(p => p.author === me);
        const likesReceived = mine.reduce((sum, p) => sum + p.likes.length, 0);

        let list = s.feed;
        let filterLabel = '';
        if (s.feedAuthor) {
            list = list.filter(p => p.author === s.feedAuthor);
            const f = s.friends.find(x => x.id === s.feedAuthor);
            filterLabel = `${f ? f.display_name : 'Their'}’s posts`;
        } else if (s.feedFilter === 'mine') {
            list = mine;
            filterLabel = 'Your posts';
        } else if (s.feedFilter === 'saved') {
            list = list.filter(p => s.saved.has(p.id));
            filterLabel = 'Saved posts';
        } else if (s.feedFilter.startsWith('tag:')) {
            const tag = s.feedFilter.slice(4);
            list = list.filter(p => hashtags(p).includes(tag));
            filterLabel = `#${tag}`;
        }
        if (s.feedSort === 'popular') {
            list = [...list].sort((a, b) => b.likes.length - a.likes.length || Date.parse(b.shared_at) - Date.parse(a.shared_at));
        }

        const navItem = (filter, icon, label) => `
            <button class="social-nav-item${!s.feedAuthor && s.feedFilter === filter ? ' active' : ''}" data-action="feed-filter" data-filter="${filter}">
                <svg class="i"><use href="#${icon}"/></svg>${label}</button>`;

        const stories = storyGroups();
        const online = s.friends.filter(f => s.online.has(f.id));

        return `
            <div class="social">
                <aside class="social-left">
                    <div class="profile-card">
                        <span class="avatar xl">${esc(app.initials(s.profile.display_name))}<span class="verified" aria-hidden="true"><svg class="i"><use href="#i-check"/></svg></span></span>
                        <strong>${esc(s.profile.display_name)}</strong>
                        <small>@${esc(s.profile.username)}</small>
                        <div class="profile-stats">
                            <div><b>${mine.length}</b><span>Posts</span></div>
                            <div><b>${s.friends.length}</b><span>Friends</span></div>
                            <div><b>${likesReceived}</b><span>Likes</span></div>
                        </div>
                    </div>
                    <nav class="social-nav" aria-label="Feed">
                        ${navItem('all', 'i-home', 'Feed')}
                        ${navItem('mine', 'i-user', 'My posts')}
                        ${navItem('saved', 'i-bookmark', 'My favorites')}
                        <button class="social-nav-item" data-action="find-friends"><svg class="i"><use href="#i-send"/></svg>Direct</button>
                        <button class="social-nav-item" data-action="go-insights"><svg class="i"><use href="#i-chart"/></svg>Stats</button>
                    </nav>
                    <div class="contacts">
                        <h4>Contacts</h4>
                        ${s.friends.slice(0, 6).map(f => `
                            <div class="contact-row">
                                ${avatar(f, 'md')}
                                <span class="contact-name"><strong>${esc(f.display_name)}</strong><small>@${esc(f.username)}</small></span>
                                <button class="icon-btn ghost" data-action="message-friend" data-id="${esc(f.id)}" aria-label="Message ${esc(f.display_name)}"><svg class="i"><use href="#i-chat"/></svg></button>
                            </div>`).join('') || '<p class="muted small">Add friends to see them here.</p>'}
                        ${s.friends.length ? '<button class="link-btn center" data-action="find-friends">View all</button>' : ''}
                    </div>
                </aside>

                <section class="social-main">
                    <div class="social-top">
                        <label class="search feed-search">
                            <svg class="i"><use href="#i-search"/></svg>
                            <input type="search" id="feed-search" placeholder="Search posts…" aria-label="Search posts">
                        </label>
                        <button class="create-post" data-action="create-post"><svg class="i"><use href="#i-plus"/></svg><span>Create new post</span></button>
                    </div>

                    <form class="post-composer" data-form="feed-post">
                        <div class="pc-row">
                            <span class="avatar md">${esc(app.initials(s.profile.display_name))}</span>
                            <textarea id="feed-text" rows="2" maxlength="5000" placeholder="What’s on your mind, ${esc(s.profile.display_name.split(' ')[0])}?" aria-label="Write a post"></textarea>
                        </div>
                        <div class="pc-photos" id="feed-photos" hidden></div>
                        <div class="pc-foot">
                            <button type="button" class="pc-tool" data-action="feed-add-photos"><svg class="i"><use href="#i-image"/></svg>Photo</button>
                            <button type="button" class="pc-tool camera" data-action="feed-camera"><svg class="i"><use href="#i-camera"/></svg>Camera</button>
                            <span class="pc-note"><svg class="i"><use href="#i-lock"/></svg>Friends only · also saved to your diary</span>
                            <button type="submit" class="pc-post" id="feed-post-btn">${s.posting ? 'Posting…' : 'Post'}</button>
                        </div>
                    </form>

                    <div class="block-head">
                        <h2>Stories</h2>
                        ${stories.length ? '<button class="link-btn" data-action="story-open">Watch all</button>' : ''}
                    </div>
                    <div class="stories">
                        <button class="story" data-action="create-post">
                            <span class="story-ring add"><svg class="i"><use href="#i-plus"/></svg></span><span>Add story</span>
                        </button>
                        ${stories.map(g => `
                            <button class="story" data-action="story-open" data-id="${esc(g.author)}">
                                <span class="story-ring${g.posts.every(p => s.seenStories.has(p.id)) ? ' seen' : ''}">${avatar(g.person, 'lg')}</span>
                                <span>${g.author === me ? 'You' : esc(g.person.display_name.split(' ')[0])}</span>
                            </button>`).join('')}
                    </div>

                    <div class="block-head">
                        <h2>${filterLabel ? esc(filterLabel) : 'Feeds'}</h2>
                        <div class="feed-sort" role="group" aria-label="Sort posts">
                            <button data-action="feed-sort" data-sort="popular" aria-pressed="${s.feedSort === 'popular'}">Popular</button>
                            <button data-action="feed-sort" data-sort="latest" aria-pressed="${s.feedSort === 'latest'}">Latest</button>
                        </div>
                    </div>
                    ${filterLabel ? '<button class="chip filter-chip" data-action="feed-all"><svg class="i"><use href="#i-close"/></svg>Show everything</button>' : ''}
                    <div class="feed-list">
                        ${list.map(postCard).join('') || `<div class="empty">
                            <p class="empty-title">${filterLabel ? 'Nothing here yet' : 'No posts yet'}</p>
                            <p>${s.feedFilter === 'saved' ? 'Tap the bookmark on a post to save it here.' : 'Turn on <strong>Share with friends</strong> in an entry, or add friends to see theirs here.'}</p>
                        </div>`}
                    </div>
                </section>

                <aside class="social-right">
                    <section class="side-box">
                        <h4>Requests ${s.incoming.length ? `<span class="count-dot">${s.incoming.length}</span>` : ''}</h4>
                        ${s.incoming.map(f => `
                            <div class="request-row">
                                ${avatar(f, 'md')}
                                <div>
                                    <p><strong>${esc(f.display_name)}</strong> wants to add you to friends</p>
                                    <div class="request-actions">
                                        <button class="link-btn accent" data-action="accept-request" data-id="${esc(f.friendshipId)}">Accept</button>
                                        <button class="link-btn" data-action="decline-request" data-id="${esc(f.friendshipId)}">Decline</button>
                                    </div>
                                </div>
                            </div>`).join('') || '<p class="muted small">No new requests.</p>'}
                    </section>
                    <section class="side-box">
                        <h4>Suggestions for you</h4>
                        ${s.suggestions.map(p => `
                            <div class="suggest-row">
                                <span class="avatar md">${esc(app.initials(p.display_name))}</span>
                                <span class="contact-name"><strong>${esc(p.display_name)}</strong><small>${p.mutual ? `${p.mutual} mutual friend${p.mutual === 1 ? '' : 's'}` : `@${esc(p.username)}`}</small></span>
                                <button class="icon-btn ghost accent" data-action="suggest-add" data-username="${esc(p.username)}" aria-label="Add ${esc(p.display_name)}"><svg class="i"><use href="#i-user-plus"/></svg></button>
                            </div>`).join('') || '<p class="muted small">No suggestions right now.</p>'}
                    </section>
                    <section class="active-card">
                        <span class="avatar-stack">${(online.length ? online : s.friends).slice(0, 6).map(f => avatar(f, 'sm')).join('')}</span>
                        <p><b>${online.length}</b> ${online.length === 1 ? 'friend' : 'friends'} online</p>
                        <small>${online.length ? 'Active now in your circle' : 'Your friends will show here when they’re online'}</small>
                    </section>
                </aside>
            </div>`;
    };

    // ---------- Posting from the feed ----------
    const MAX_POST_PHOTOS = 10;

    async function addFeedPhotos(files) {
        for (const original of files) {
            if (s.feedDraft.photos.length >= MAX_POST_PHOTOS) {
                app.showToast(`Up to ${MAX_POST_PHOTOS} photos per post`);
                break;
            }
            const file = await Media.compressImage(original);
            if (!FEED_TYPES.includes(file.type)) {
                app.showToast(`${original.name || 'That photo'} isn’t a supported format`);
                continue;
            }
            if (file.size > 10 * 1048576) {
                app.showToast(`${original.name || 'That photo'} is too large`);
                continue;
            }
            s.feedDraft.photos.push({ id: Math.random().toString(36).slice(2), file, preview: URL.createObjectURL(file) });
        }
        renderFeedPhotos();
    }

    function renderFeedPhotos() {
        const box = $('feed-photos');
        if (!box) return;
        const photos = s.feedDraft.photos;
        box.hidden = !photos.length;
        box.innerHTML = photos.map(p => `
            <figure class="pc-thumb">
                <img src="${p.preview}" alt="">
                <button type="button" class="att-remove" data-action="feed-remove-photo" data-id="${p.id}" aria-label="Remove photo"><svg class="i"><use href="#i-close"/></svg></button>
            </figure>`).join('');
    }

    async function postToFeed() {
        if (s.posting) return;
        const text = s.feedDraft.text.trim();
        const photos = s.feedDraft.photos;
        if (!text && !photos.length) {
            app.showToast('Write something or add a photo first');
            $('feed-text')?.focus();
            return;
        }
        s.posting = true;
        const btn = $('feed-post-btn');
        if (btn) {
            btn.textContent = 'Posting…';
            btn.disabled = true;
        }
        try {
            const note = await app.createEntry({ text, shared: true }, photos.map(p => p.file));
            // Share right away instead of waiting for the autosave debounce
            clearTimeout(shareTimers.get(note.id));
            const result = await new Promise(resolve => queue(async () => {
                try {
                    resolve(await upsertShared(note));
                } catch (err) {
                    app.showToast('Couldn’t reach the server — your post is saved and will share next time');
                    resolve({ ok: false, photos: 0 });
                }
            }));
            photos.forEach(p => URL.revokeObjectURL(p.preview));
            s.feedDraft = { text: '', photos: [] };
            s.feed = null;
            if (!result.ok) return; // upsertShared already explained; the entry is still saved in the diary
            if (result.photos < photos.length) app.showToast(`Posted, but ${photos.length - result.photos} photo(s) couldn’t upload`);
            else app.showToast(photos.length ? 'Posted with photos 📸' : 'Posted to your friends');
        } catch (err) {
            app.showToast('Couldn’t post that — please try again');
        } finally {
            s.posting = false;
            if (app.state.view === 'feed') app.render();
        }
    }

    function hashtags(p) {
        const text = `${p.title || ''} ${p.body || ''}`;
        return [...new Set([...text.matchAll(/#([\p{L}\p{N}_]{2,30})/gu)].map(m => m[1].toLowerCase()))];
    }

    function postCard(p) {
        const me = s.profile.id;
        const author = p.author_profile || { username: 'unknown', display_name: 'Someone' };
        const person = { id: p.author, display_name: author.display_name };
        const liked = p.likes.some(l => l.user_id === me);
        const saved = s.saved.has(p.id);
        const long = p.body.length > 320 || p.body.split('\n').length > 5;
        const body = p.html ? Rich.sanitize(p.html) : esc(p.body);
        const tags = hashtags(p);
        const photos = (p.photos || []).filter(ph => ph && typeof ph.path === 'string');

        let grid = '';
        if (photos.length) {
            const shown = photos.slice(0, 5);
            const extra = photos.length - shown.length;
            grid = `<div class="post-photos n${Math.min(shown.length, 5)}">${shown.map((ph, i) => `
                <button class="post-photo" data-action="feed-photo" data-img="${esc(ph.path)}" aria-label="View photo">
                    <img data-path="${esc(ph.path)}" data-bucket="${FEED_BUCKET}" alt="" loading="lazy">
                    ${i === shown.length - 1 && extra > 0 ? `<span class="photo-more">+${extra}</span>` : ''}
                </button>`).join('')}</div>`;
        }

        return `
            <article class="post" data-search="${esc(`${author.display_name} ${author.username} ${p.title} ${p.body}`.toLowerCase())}">
                <header class="post-head">
                    ${avatar(person, 'md')}
                    <div class="post-who">
                        <strong>${p.author === me ? 'You' : esc(author.display_name)}</strong>
                        <span class="muted">@${esc(author.username)} · ${timeAgo(p.shared_at)}${p.mood ? ` · ${MOOD_EMOJI[p.mood] || ''}` : ''}</span>
                    </div>
                    <button class="more-btn" data-action="post-menu" data-id="${esc(p.id)}" aria-label="Post options"><svg class="i"><use href="#i-more"/></svg></button>
                </header>
                ${grid}
                ${p.title ? `<h3 class="post-title">${esc(p.title)}</h3>` : ''}
                <div class="post-text rich-content${long ? ' clamped' : ''}">${body}</div>
                ${long ? '<button class="read-more" data-action="expand-post">read more</button>' : ''}
                ${tags.length ? `<div class="post-tags">${tags.map(t => `<button class="tag-link" data-action="feed-tag" data-tag="${esc(t)}">#${esc(t)}</button>`).join('')}</div>` : ''}
                <footer class="post-foot">
                    <button class="like-btn" data-action="like" data-id="${esc(p.id)}" aria-pressed="${liked}" aria-label="${liked ? 'Unlike' : 'Like'}">
                        <svg class="i"><use href="#${liked ? 'i-heart-fill' : 'i-heart'}"/></svg><span>${p.likes.length || ''}</span>
                    </button>
                    ${p.author === me ? '' : `<button class="like-btn" data-action="message-friend" data-id="${esc(p.author)}" aria-label="Reply privately"><svg class="i"><use href="#i-chat"/></svg><span>Reply</span></button>`}
                    <button class="save-btn" data-action="save-post" data-id="${esc(p.id)}" aria-pressed="${saved}" aria-label="${saved ? 'Remove from favorites' : 'Save to favorites'}">
                        <svg class="i"><use href="#${saved ? 'i-bookmark-fill' : 'i-bookmark'}"/></svg>
                    </button>
                </footer>
            </article>`;
    }

    // One story group per person who shared in the last 24 hours (you first)
    function storyGroups() {
        const since = Date.now() - 86400000;
        const groups = new Map();
        [...s.feed].reverse().forEach(p => {
            if (Date.parse(p.shared_at) < since) return;
            if (!groups.has(p.author)) {
                const a = p.author_profile || { display_name: 'Someone', username: '' };
                groups.set(p.author, { author: p.author, person: { id: p.author, display_name: a.display_name, username: a.username }, posts: [] });
            }
            groups.get(p.author).posts.push(p);
        });
        const me = s.profile.id;
        return [...groups.values()].sort((a, b) => (b.author === me) - (a.author === me));
    }

    // ---------- Story viewer ----------
    const storyDialog = $('story');
    let story = null;

    function openStories(startAuthor) {
        const groups = storyGroups();
        if (!groups.length) return;
        let gi = startAuthor ? groups.findIndex(g => g.author === startAuthor) : groups.findIndex(g => g.posts.some(p => !s.seenStories.has(p.id)));
        if (gi < 0) gi = 0;
        story = { groups, gi, pi: 0, timer: null };
        storyDialog.showModal();
        showStory();
    }

    function showStory() {
        clearTimeout(story.timer);
        const group = story.groups[story.gi];
        const post = group.posts[story.pi];
        s.seenStories.add(post.id);
        try { localStorage.setItem('diarySeenStories', JSON.stringify([...s.seenStories].slice(-300))); } catch (e) {}

        $('story-bars').innerHTML = group.posts.map((p, i) =>
            `<span class="${i < story.pi ? 'done' : i === story.pi ? 'active' : ''}"><i></i></span>`).join('');
        $('story-avatar').textContent = app.initials(group.person.display_name);
        $('story-name').textContent = group.author === s.profile.id ? 'Your story' : group.person.display_name;
        $('story-time').textContent = timeAgo(post.shared_at);
        const photo = (post.photos || [])[0];
        $('story-card').className = `story-card tinted c-${post.color}`;
        $('story-card').innerHTML = `
            ${photo ? `<img class="story-photo" data-path="${esc(photo.path)}" data-bucket="${FEED_BUCKET}" alt="">` : ''}
            ${post.title ? `<h3>${esc(post.title)}</h3>` : ''}
            <div class="rich-content">${post.html ? Rich.sanitize(post.html) : esc(post.body)}</div>
            ${post.mood ? `<p class="story-mood">${MOOD_EMOJI[post.mood] || ''}</p>` : ''}`;
        hydrateStorage($('story-card'));
        story.timer = setTimeout(() => stepStory(1), 7000);
    }

    function stepStory(dir) {
        if (!story) return;
        const group = story.groups[story.gi];
        story.pi += dir;
        if (story.pi >= group.posts.length) {
            story.gi++;
            story.pi = 0;
        } else if (story.pi < 0) {
            story.gi = Math.max(0, story.gi - 1);
            story.pi = 0;
        }
        if (story.gi >= story.groups.length) return storyDialog.close();
        showStory();
    }

    $('story-next').addEventListener('click', () => stepStory(1));
    $('story-prev').addEventListener('click', () => stepStory(-1));
    $('story-close').addEventListener('click', () => storyDialog.close());
    storyDialog.addEventListener('close', () => {
        if (story) clearTimeout(story.timer);
        story = null;
        if (app.state.view === 'feed') app.render();
    });
    storyDialog.addEventListener('keydown', e => {
        if (e.key === 'ArrowRight') stepStory(1);
        if (e.key === 'ArrowLeft') stepStory(-1);
    });

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
            <form class="composer${s.rec ? ' recording' : ''}" data-form="send-message">
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
                            <button type="button" class="tool-btn" data-action="chat-file" title="Attach a document" aria-label="Attach a document"><svg class="i"><use href="#i-paperclip"/></svg></button>
                        </div>
                        <div class="emoji-panel" id="emoji-panel" hidden>
                            ${EMOJI.map(e => `<button type="button" data-action="emoji" data-emoji="${e}" aria-label="${e}">${e}</button>`).join('')}
                        </div>
                    </div>
                    <div class="rec-bar" id="rec-bar" aria-live="polite">
                        <button type="button" class="tool-btn rec-trash" data-action="vn-cancel" aria-label="Delete recording"><svg class="i"><use href="#i-trash"/></svg></button>
                        <span class="rec-dot" aria-hidden="true"></span>
                        <span class="rec-time" id="rec-time">0:00</span>
                        <span class="rec-wave" id="rec-wave" aria-hidden="true"></span>
                        <span class="rec-hint" id="rec-hint">‹ Slide left to cancel</span>
                    </div>
                    <button type="button" class="send-btn dark" id="chat-action" data-mode="mic" aria-label="Hold to record, tap for hands-free">
                        <svg class="i"><use href="#i-mic"/></svg>
                    </button>
                </div>
            </form>`;
    }

    // Mic when there's nothing to send (WhatsApp style), send arrow otherwise
    function updateComposerButton() {
        const btn = $('chat-action');
        const input = $('chat-input');
        if (!btn || !input) return;
        let mode = 'mic';
        if (s.rec) mode = s.rec.mode === 'locked' ? 'rec-send' : 'recording';
        else if (Rich.toText(input.innerHTML) || (s.pending[s.activeFriend] || []).length) mode = 'send';
        if (btn.dataset.mode === mode) return;
        btn.dataset.mode = mode;
        const icon = mode === 'mic' || mode === 'recording' ? 'i-mic' : 'i-send';
        btn.innerHTML = `<svg class="i"><use href="#${icon}"/></svg>`;
        btn.setAttribute('aria-label', mode === 'mic' ? 'Hold to record, tap for hands-free' : mode === 'recording' ? 'Release to send' : 'Send');
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
        if (a.kind === 'audio') return voiceHTML(a);
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
        'feed-all': () => { s.feedAuthor = null; s.feedFilter = 'all'; app.render(); },
        'feed-filter': el => { s.feedAuthor = null; s.feedFilter = el.dataset.filter; app.render(); },
        'feed-sort': el => { s.feedSort = el.dataset.sort; app.render(); },
        'feed-tag': el => { s.feedAuthor = null; s.feedFilter = `tag:${el.dataset.tag}`; app.render(); window.scrollTo({ top: 0 }); },
        'go-insights': () => app.setView('insights'),
        'create-post': () => {
            if (!window.diarySocial.requireSignIn('Sign in to share with friends.')) return;
            const text = $('feed-text');
            if (text) {
                text.scrollIntoView({ behavior: 'smooth', block: 'center' });
                text.focus();
            }
        },
        'feed-add-photos': async () => addFeedPhotos(await Media.pickFiles('image/*')),
        'feed-camera': async () => addFeedPhotos(await Media.pickFiles('image/*', false, 'environment')),
        'feed-remove-photo': el => {
            const photo = s.feedDraft.photos.find(p => p.id === el.dataset.id);
            if (photo) URL.revokeObjectURL(photo.preview);
            s.feedDraft.photos = s.feedDraft.photos.filter(p => p.id !== el.dataset.id);
            renderFeedPhotos();
        },
        'save-post': el => {
            const id = el.dataset.id;
            if (s.saved.has(id)) s.saved.delete(id);
            else s.saved.add(id);
            try { localStorage.setItem('diarySavedPosts', JSON.stringify([...s.saved])); } catch (e) {}
            app.showToast(s.saved.has(id) ? 'Saved to My favorites' : 'Removed from favorites');
            app.render();
        },
        'post-menu': el => {
            const post = (s.feed || []).find(p => p.id === el.dataset.id);
            if (!post) return;
            const mine = post.author === s.profile.id;
            const items = mine
                ? [
                    { label: 'Open entry', icon: 'i-edit', onClick: () => {
                        const local = app.getNotes().find(n => n.id === post.local_id);
                        if (local) app.openNote(local.id);
                        else app.showToast('That entry isn’t on this device');
                    } },
                    { label: 'Stop sharing', icon: 'i-lock', danger: true, onClick: () => {
                        const local = app.getNotes().find(n => n.id === post.local_id);
                        if (local) {
                            app.updateNote(local.id, { shared: false });
                            app.showToast('Entry is private again');
                        } else {
                            queue(async () => {
                                await client.from('diary_shared_entries').delete().eq('id', post.id);
                                s.feed = null;
                                app.render();
                            });
                        }
                    } }
                ]
                : [
                    { label: 'Message', icon: 'i-chat', onClick: () => { app.setView('messages'); openChat(post.author); } },
                    { label: `More from ${post.author_profile ? post.author_profile.display_name : 'them'}`, icon: 'i-user', onClick: () => { s.feedAuthor = post.author; app.render(); } }
                ];
            app.openPopover(el, items);
        },
        'story-open': el => openStories(el.dataset.id || null),
        'suggest-add': el => {
            s.suggestions = s.suggestions.filter(p => p.username !== el.dataset.username);
            addFriend(el.dataset.username);
        },
        'feed-photo': el => {
            const entry = s.urls.get(`${FEED_BUCKET}:${el.dataset.img}`);
            if (entry) Media.lightbox(entry.url);
        },
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
            { label: 'Voice note', icon: 'i-mic', onClick: () => startVoice(0, true) },
            { label: 'Drawing', icon: 'i-draw', onClick: drawForChat }
        ]),
        'vn-play': el => toggleVoice(el.closest('.vn')),
        'vn-seek': (el, e) => seekVoice(el.closest('.vn'), e),
        'vn-speed': el => {
            const audio = bindVoice(el.closest('.vn'));
            const next = { 1: 1.5, 1.5: 2, 2: 1 }[audio.playbackRate] || 1;
            audio.playbackRate = next;
            el.textContent = `${next}×`;
        },
        'vn-cancel': () => cancelVoice(),
        'chat-file': async () => addPending(await Media.pickFiles(`${DOC_ACCEPT},image/*`)),
        'remove-pending': el => {
            const list = s.pending[s.activeFriend] || [];
            const item = list.find(p => p.id === el.dataset.id);
            if (item && item.preview) URL.revokeObjectURL(item.preview);
            s.pending[s.activeFriend] = list.filter(p => p.id !== el.dataset.id);
            renderPending();
        },
        'chat-view-image': el => {
            const entry = s.urls.get(`${BUCKET}:${el.dataset.img}`);
            if (entry) Media.lightbox(entry.url);
        }
    });

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
        } else if (form.dataset.form === 'feed-post') {
            postToFeed();
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
        if (e.target.id === 'feed-text') {
            s.feedDraft.text = e.target.value;
            e.target.style.height = 'auto';
            e.target.style.height = Math.min(e.target.scrollHeight, 240) + 'px';
        }
        if (e.target.id === 'feed-search') {
            const q = e.target.value.trim().toLowerCase();
            content.querySelectorAll('.post[data-search]').forEach(post => {
                post.hidden = !!q && !post.dataset.search.includes(q);
            });
        }
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
