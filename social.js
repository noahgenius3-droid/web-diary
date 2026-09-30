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
        remoteAudio: new Map(),  // local id -> { id, path, name, duration } the post's audio
        feedSort: 'foryou',  // foryou | following | latest | popular
        feedFilter: 'all',   // all | mine | saved | tag:<name>
        feedAudience: load('diaryFeedAudience', 'friends'), // who new posts from the feed composer go to
        hidden: new Set(),      // "entry:<id>" | "post:<id>" you hid from your feed
        watching: new Set(),    // posts you get notified about when someone comments
        profilePosts: [],       // posts on the profile page you're looking at (profile.js)
        singlePost: null,       // a post opened from a link
        saved: new Set(),       // entry ids you've saved (synced to your account)
        savedReels: new Set(),
        savedExtra: [],         // saved entries that are older than the loaded feed
        seenStories: new Set(load('diarySeenStories', [])),
        suggestions: [],
        feedDraft: { text: '', photos: [] }, // the feed composer survives re-renders
        comments: new Map(),                  // "entry:<id>" | "post:<id>" -> { open, loading, items, ownerId }
        previews: new Map(),                  // "entry:<id>" -> the latest two comments, shown under each card
        rendered: new Map(),                  // "entry:<id>" | "post:<id>" -> the last data a card was drawn with (the post view reuses it)
        detail: null,                         // key of the post open in the post view
        following: new Set(),                 // ids of people you follow
        followerCount: 0,
        posting: false,
        rec: null,           // in-progress chat voice recording
        replyTo: {},         // friend id -> message id being replied to
        typing: null,        // { friendId, channel } for the open chat
        typingFrom: null,    // friend id currently typing to you
        feedStory: false,    // "Add to my story" in the feed composer
        incognito: {},       // friend id -> { mode: off | seen | 1h | 24h, set_by, updated_at }
        chatOpenedAt: {},    // friend id -> when you opened that chat (seen-and-vanish messages go when you leave)
        channel: null,
        presence: null
    };
    const FEED_BUCKET = 'diary-feed';
    const COMMENT_AUDIO = 'diary-comment-audio';
    const MAX_VOICE_COMMENT = 180; // seconds
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
                { label: 'Change name', icon: 'i-pencil', onClick: () => app.renameUser() },
                { label: 'Settings', icon: 'i-settings', onClick: () => app.setView('settings') }
            ]);
            return;
        }
        app.openPopover(anchor, [
            { label: `@${s.profile.username}`, icon: 'i-user', onClick: () => app.setView('messages') },
            { label: s.profile.avatar_path ? 'Change profile photo' : 'Add profile photo', icon: 'i-camera', onClick: changeAvatar },
            ...(s.profile.avatar_path ? [{ label: 'Remove photo', icon: 'i-trash', onClick: removeAvatar }] : []),
            { label: 'Change name', icon: 'i-pencil', onClick: () => app.renameUser() },
            { label: 'Settings', icon: 'i-settings', onClick: () => app.setView('settings') },
            { label: 'Sign out', icon: 'i-logout', onClick: signOut }
        ]);
    };

    // Top-bar avatar shows the profile photo when there is one
    app.hooks.avatarPhoto = () => (s.profile && s.profile.avatar_path ? avatarUrl(s.profile.avatar_path) : null);

    // ---------- Profile photo ----------
    async function changeAvatar() {
        const [file] = await Media.pickFiles('image/*', false);
        if (!file) return;
        let blob;
        try {
            blob = await Media.squareImage(file, 512);
        } catch (e) {
            return app.showToast('Couldn’t read that photo — try a JPEG or PNG');
        }
        const data = await Media.bytes(blob);
        if (!data) return app.showToast('Couldn’t read that photo');
        app.showToast('Updating your photo…');
        const path = `${s.profile.id}/${randomId()}.jpg`;
        const up = await client.storage.from('diary-avatars').upload(path, data.buf, { contentType: 'image/jpeg', upsert: false });
        if (up.error) return app.showToast('Couldn’t upload your photo');
        const old = s.profile.avatar_path;
        const { data: profile, error } = await client.from('diary_profiles')
            .update({ avatar_path: path }).eq('id', s.profile.id).select().single();
        if (error) {
            client.storage.from('diary-avatars').remove([path]);
            return app.showToast('Couldn’t save your photo');
        }
        s.profile = profile;
        if (old) client.storage.from('diary-avatars').remove([old]);
        app.render();
        app.showToast('Profile photo updated');
    }

    async function removeAvatar() {
        const old = s.profile.avatar_path;
        const { data: profile, error } = await client.from('diary_profiles')
            .update({ avatar_path: null }).eq('id', s.profile.id).select().single();
        if (error) return app.showToast('Couldn’t remove your photo');
        s.profile = profile;
        if (old) client.storage.from('diary-avatars').remove([old]);
        app.render();
        app.showToast('Photo removed');
    }

    // Profile photo and Sign out are in Settings; the menu only offers Sign in when you're signed out
    app.hooks.menuItems = () => signedIn() ? [] : [{ label: 'Sign in', icon: 'i-user', onClick: () => openAuth() }];

    // Friend avatars on the Notes page header
    app.hooks.friendAvatars = () => {
        if (!signedIn() || !s.friends.length) return '';
        const shown = s.friends.slice(0, 4);
        const extra = s.friends.length - shown.length;
        return `<span class="avatar-stack" title="${s.friends.length} friends">${shown.map(f => avatar(f, 'sm')).join('')}${extra > 0 ? `<span class="avatar sm more">+${extra}</span>` : ''}</span>`;
    };

    // ---------- Global people search ----------
    // Anyone on Cordial by name or @username (the top search bar and Explore both use this). Results come
    // from the server and are painted in place, so typing is never interrupted.
    const people = { cache: new Map(), timer: null, pending: null };

    function peopleResults(q) {
        q = String(q || '').trim().replace(/^@/, '').toLowerCase();
        if (!signedIn() || q.length < 2) return '';
        const hit = people.cache.get(q);
        if (!hit) {
            clearTimeout(people.timer);
            people.timer = setTimeout(() => fetchPeople(q), 220);
        }
        return `<section class="people-results" data-people-q="${esc(q)}" aria-live="polite">${peopleHTML(q, hit)}</section>`;
    }

    async function fetchPeople(q) {
        if (people.cache.has(q) || people.pending === q) return;
        people.pending = q;
        const { data, error } = await client.rpc('diary_search_people', { q });
        people.pending = null;
        people.cache.set(q, error ? { error: true, list: [] } : { list: data || [] });
        if (people.cache.size > 40) people.cache.delete(people.cache.keys().next().value);
        paintPeople(q);
    }

    function paintPeople(q) {
        document.querySelectorAll(`.people-results[data-people-q="${CSS.escape(q)}"]`).forEach(box => {
            box.innerHTML = peopleHTML(q, people.cache.get(q));
            hydrateStorage(box);
        });
    }

    function peopleHTML(q, hit) {
        const head = '<h3 class="people-head"><svg class="i"><use href="#i-users"/></svg>People on Cordial</h3>';
        if (!hit) {
            // While the server looks, show friends that already match
            const local = [...s.friends, ...(s.suggestions || [])].filter(p => `${p.display_name} ${p.username}`.toLowerCase().includes(q)).slice(0, 5);
            return `${head}${local.length ? `<div class="people-list">${local.map(p => personHTML({ ...p, relation: s.friends.includes(p) ? 'friend' : 'none' })).join('')}</div>` : ''}<p class="people-note muted small">Searching everyone…</p>`;
        }
        if (hit.error) return `${head}<p class="people-note muted small">Couldn’t search people right now.</p>`;
        if (!hit.list.length) return `${head}<p class="people-note muted small">No one matches “${esc(q)}” — try a name, @username, interest, group, or someone’s exact email.</p>`;
        return `${head}<div class="people-list">${hit.list.map(personHTML).join('')}</div>`;
    }

    function personHTML(p) {
        const first = esc((p.display_name || '').split(' ')[0] || 'them');
        const incoming = p.relation === 'incoming' ? s.incoming.find(f => f.id === p.id) : null;
        const label = { friend: 'Friend', requested: 'Request sent', incoming: 'Wants to be friends' }[p.relation] || (p.follows_you ? 'Follows you' : '');
        let actions;
        if (p.relation === 'friend') {
            actions = `<button type="button" class="chip accent" data-action="message-friend" data-id="${esc(p.id)}">Message</button>`;
        } else if (incoming) {
            actions = `<button type="button" class="chip accent" data-action="people-accept" data-id="${esc(incoming.friendshipId)}" data-person="${esc(p.id)}">Accept</button>`;
        } else if (p.relation === 'requested') {
            actions = '<button type="button" class="chip" disabled>Requested</button>';
        } else {
            actions = `<button type="button" class="chip accent" data-action="people-add" data-username="${esc(p.username)}" data-person="${esc(p.id)}" aria-label="Add ${first} as a friend">Add friend</button>`;
        }
        const follow = p.relation === 'friend' ? '' : followButton(p);
        return `
            <div class="person-row" data-person-row="${esc(p.id)}">
                <button type="button" class="person-open" data-profile="${esc(p.id)}" aria-label="View ${esc(p.display_name)}’s profile">${avatar(p, 'md')}</button>
                <span class="person-text" data-profile="${esc(p.id)}" role="button" tabindex="0"><strong>${esc(p.display_name)}${tick(p.id)}</strong><small>@${esc(p.username)}${label ? ` · ${label}` : ''}</small>${p.matched ? `<small class="person-why">${esc(p.matched)}</small>` : ''}</span>
                <span class="person-actions">${actions}${follow}</span>
            </div>`;
    }

    // After adding / accepting, every cached result for that person shows the new state
    function setRelation(personId, relation) {
        people.cache.forEach((hit, q) => {
            const p = (hit.list || []).find(x => x.id === personId);
            if (p) { p.relation = relation; paintPeople(q); }
        });
    }

    app.hooks.searchPeople = q => peopleResults(q);

    app.hooks.screenKey = view => (view === 'messages' && s.activeFriend) || '';

    app.hooks.afterRender = (view, how = {}) => {
        // An open conversation takes the whole phone screen (see .chat-open in style.css)
        document.body.classList.toggle('chat-open', view === 'messages' && signedIn() && !!s.activeFriend);
        if (view === 'messages' && window.LiveLocation) window.LiveLocation.hydrate(content);
        if (view === 'messages' && s.activeFriend && window.ChatWallpaper) window.ChatWallpaper.apply(document.getElementById('chat-thread'), 'dm:' + s.activeFriend);
        if (view === 'home') paintPresence();
        if (view === 'feed') {
            hydrateStorage(content);
            const text = $('feed-text');
            if (text) {
                text.value = s.feedDraft.text;
                renderFeedPhotos();
            }
        }
        ensureTyping();
        if (view !== 'messages' || !signedIn()) return;
        const thread = $('chat-thread');
        if (thread) {
            if (!how.repaint) {
                const sep = $('unread-sep');
                if (sep) sep.scrollIntoView({ block: 'start' });
                else thread.scrollTop = thread.scrollHeight;
            }
            if (s.pendingJump && s.pendingJump.friendId === s.activeFriend && s.threads[s.activeFriend]) {
                const j = s.pendingJump;
                s.pendingJump = null;
                setTimeout(() => jumpToMessage(j.friendId, j.id), 50);
            }
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
            if (!how.repaint || !input.innerHTML) input.innerHTML = Rich.sanitize(s.drafts[s.activeFriend] || '');
            renderPending();
            renderReplyBar();
            if (s.typingFrom === s.activeFriend) showTyping(s.activeFriend);
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
    const freshFiles = new Map(); // attachment id -> File picked in the feed composer, until uploaded
    let shareChain = Promise.resolve();
    const queue = job => { shareChain = shareChain.then(job).catch(() => {}); };

    // Post a short text straight to the feed (trivia results, a word of the day…). It's also saved to your diary.
    // New badges after something you did; the notification also arrives, this just says it straight away
    function checkBadges() {
        client.rpc('diary_check_badges').then(({ data }) => {
            if (data && data.length) setTimeout(() => app.showToast(`New badge: ${data.map(b => b.name).join(', ')} 🏅`), 1600);
        });
    }

    async function quickPost(text, audience = 'friends') {
        if (!signedIn() || !String(text || '').trim()) return false;
        const note = await app.createEntry({ text: String(text).slice(0, 5000), shared: true, audience });
        clearTimeout(shareTimers.get(note.id));
        const result = await new Promise(resolve => queue(async () => {
            try { resolve(await upsertShared(note)); } catch (e) { resolve({ ok: false }); }
        }));
        s.feed = null;
        if (result && result.ok) checkBadges();
        return !!(result && result.ok);
    }

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
        $('auth-forgot').hidden = signup;
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

    // Forgot password: Supabase emails a link that brings them back here signed in (PASSWORD_RECOVERY)
    $('auth-forgot').addEventListener('click', async () => {
        if (!client) return;
        const email = $('auth-email').value.trim();
        if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
            $('auth-email').focus();
            return showAuthMessage('Type your email above, then tap “Forgot password?” again.', true);
        }
        const btn = $('auth-forgot');
        btn.disabled = true;
        const { error } = await client.auth.resetPasswordForEmail(email, { redirectTo: location.origin + location.pathname });
        btn.disabled = false;
        if (error) {
            return showAuthMessage(/rate|seconds/i.test(error.message)
                ? 'Please wait a minute before asking for another link.'
                : 'Couldn’t send the reset email — check the address and try again.', true);
        }
        showAuthMessage(`If ${email} has an account, a reset link is on its way. Open it on this device to choose a new password.`);
    });

    async function chooseNewPassword() {
        for (;;) {
            const r = await app.ask({ title: 'Choose a new password', text: 'You’re signed in from your reset link. Pick a new password (at least 8 characters).', value: '', placeholder: 'New password', ok: 'Save password', inputType: 'password' });
            if (!r) return app.showToast('Password not changed — you can change it any time in Settings');
            if (r.value.length < 8) { app.showToast('Use at least 8 characters'); continue; }
            const { error } = await client.auth.updateUser({ password: r.value });
            if (error) {
                app.showToast(/different|same/i.test(error.message) ? 'Pick a password you haven’t used before' : 'Couldn’t save your password — try again');
                continue;
            }
            return app.showToast('Password updated — you’re signed in');
        }
    }
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
            if ($('auth-password2').value !== password) {
                $('auth-password2').focus();
                return showAuthMessage('The two passwords don’t match — tap the eye to check what you typed.', true);
            }
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
        // This device stops getting the account's lock-screen alerts
        if (window.diaryNotify && window.diaryNotify.unsubscribePush) await window.diaryNotify.unsubscribePush();
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
        if (previousUser === session.user.id && s.profile) {
            if (event === 'PASSWORD_RECOVERY') chooseNewPassword();
            return; // token refresh
        }

        // Two-step verification: an account with an authenticator app needs its code before anything loads
        if (client.auth.mfa && !(await passMfa())) return;
        s.profile = await ensureProfile(session.user);
        client.from('diary_presence').select('status, status_until').maybeSingle().then(({ data }) => {
            s.myStatus = data && (!data.status_until || Date.parse(data.status_until) > Date.now()) ? data.status : null;
        }, () => {});
        if (!s.profile) return app.render();

        s.drafts = load(`diaryChatDrafts:${s.profile.id}`, {});
        await Promise.all([loadFriends(), loadRecent(), loadRemoteIds(), loadSaved(), loadFollows(), loadIncognito()]);
        subscribe();
        emptyIncognitoTrash();
        loadPrefs().then(() => app.requestRender('messages'));
        registerDevice();
        setTimeout(flushOutbox, 1500);
        if (s.pendingRoute) { const r = s.pendingRoute; s.pendingRoute = null; setTimeout(() => routeTo(r), 300); }
        syncAllShared();
        app.render();
        if (event === 'PASSWORD_RECOVERY') chooseNewPassword();
        else if (event === 'SIGNED_IN' && previousUser === null) app.showToast(`Signed in as @${s.profile.username}`);
    }

    function resetSocial() {
        if (s.channel) client.removeChannel(s.channel);
        if (s.presence) client.removeChannel(s.presence);
        Object.assign(s, {
            profile: null, friends: [], incoming: [], outgoing: [], unread: {}, last: {}, feed: null, feedAuthor: null,
            threads: {}, activeFriend: null, drafts: {}, pending: {}, online: new Set(), urls: new Map(),
            remoteIds: new Set(), channel: null, presence: null, comments: new Map(),
            saved: new Set(), savedReels: new Set(), savedExtra: [],
            previews: new Map(), rendered: new Map(), following: new Set(), followerCount: 0,
            hidden: new Set(), watching: new Set(), profilePosts: [], singlePost: null,
            incognito: {}, chatOpenedAt: {}
        });
        closePost(true);
        if (window.diaryCommunities) window.diaryCommunities.reset();
        updateBadge();
    }

    let mfaAsking = false;
    async function passMfa() {
        try {
            const { data: aal } = await client.auth.mfa.getAuthenticatorAssuranceLevel();
            if (!aal || aal.nextLevel !== 'aal2' || aal.currentLevel === 'aal2') return true;
            if (mfaAsking) return false;
            mfaAsking = true;
            const { data: factors } = await client.auth.mfa.listFactors();
            const factor = factors && (factors.totp || []).find(f => f.status === 'verified');
            if (!factor) { mfaAsking = false; return true; }
            for (let tries = 0; tries < 3; tries++) {
                const res = await app.ask({ title: 'Two-step verification', text: tries ? 'That code didn’t match. Try the newest code from your authenticator app.' : 'Enter the 6-digit code from your authenticator app.', value: '', placeholder: '123456', ok: 'Verify' });
                if (!res) break;
                const { error } = await client.auth.mfa.challengeAndVerify({ factorId: factor.id, code: String(res.value || '').replace(/\s/g, '') });
                if (!error) { mfaAsking = false; return true; }
            }
            mfaAsking = false;
            app.showToast('Signed out — the verification code is needed to sign in');
            await client.auth.signOut();
            return false;
        } catch (e) {
            mfaAsking = false;
            return true;
        }
    }

    async function ensureProfile(user) {
        const { data: existing } = await client.from('diary_profiles').select('*').eq('id', user.id).maybeSingle();
        if (existing) return existing;

        const meta = user.user_metadata || {};
        let username = String(meta.username || '').toLowerCase();
        const displayName = String(meta.display_name || String(user.email || 'friend').split('@')[0]).slice(0, 40);

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
                payload => onMessageUpdate(payload.new))
            .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'diary_messages', filter: `recipient=eq.${me}` },
                payload => onMessageUpdate(payload.new))
            .on('postgres_changes', { event: '*', schema: 'public', table: 'diary_chat_prefs' },
                payload => onPrefChange(payload))
            .on('postgres_changes', { event: '*', schema: 'public', table: 'diary_incognito' },
                payload => onIncognitoChange(payload.new))
            .on('postgres_changes', { event: '*', schema: 'public', table: 'diary_friendships' },
                async () => {
                    await loadFriends();
                    app.requestRender(['messages', 'feed']);
                })
            .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'diary_comments' },
                payload => onCommentInsert(payload.new))
            .on('postgres_changes', { event: '*', schema: 'public', table: 'diary_community_posts' },
                payload => window.diaryCommunities && window.diaryCommunities.onRemoteChange(payload))
            .on('postgres_changes', { event: '*', schema: 'public', table: 'diary_shared_entries' },
                payload => {
                    const row = payload.new && payload.new.author ? payload.new : null;
                    if (app.state.view !== 'feed' || !s.feed) {
                        s.feed = null;
                        return;
                    }
                    if (payload.eventType === 'INSERT' && row && row.author !== s.profile.id) {
                        s.feedStale = true;
                        const pill = content.querySelector('.new-posts');
                        if (pill) pill.hidden = false;
                    }
                })
            .subscribe();

        // Who's online / last seen: a heartbeat, and a check that honours each person's privacy settings
        heartbeat();
        refreshPresence();
    }

    // ---------- Presence (online now, last seen) ----------
    // Every 30 seconds while Cordial is open you check in; people's status comes back only as far as their
    // privacy settings allow (Settings → Privacy). "Online" means checked in within the last ~75 seconds.
    s.lastSeen = new Map(); // user id -> ISO time, when they let you see it
    s.statuses = new Map(); // user id -> { status, text } (custom status)
    s.allowCalls = new Map(); // user id -> 'friends' | 'nobody'
    const STATUS = { available: '🟢 Available', busy: '⛔ Busy', meeting: '📅 In a meeting', dnd: '🔕 Do not disturb', away: '🌙 Away' };
    function statusOf(id) {
        const st = s.statuses.get(id);
        return st && STATUS[st.status] ? { label: STATUS[st.status], text: st.text, status: st.status } : null;
    }
    const presenceWatch = new Set(); // extra people to keep an eye on (an open profile, group members)
    function heartbeat() {
        if (!signedIn() || document.visibilityState !== 'visible') return;
        client.rpc('diary_heartbeat').then(() => {}, () => {});
    }
    async function refreshPresence(extra = []) {
        if (!signedIn()) return;
        extra.forEach(id => presenceWatch.add(id));
        const ids = [...new Set([...s.friends.map(f => f.id), ...presenceWatch])].filter(id => id && id !== s.profile.id).slice(0, 200);
        if (!ids.length) return;
        const { data, error } = await client.rpc('diary_get_presence', { ids });
        if (error) return;
        const online = new Set();
        (data || []).forEach(r => {
            if (r.online) online.add(r.id);
            if (r.last_seen) s.lastSeen.set(r.id, r.last_seen); else s.lastSeen.delete(r.id);
            s.receipts.set(r.id, r.receipts !== false);
            if (r.status) s.statuses.set(r.id, { status: r.status, text: r.status_text || '' }); else s.statuses.delete(r.id);
            s.allowCalls.set(r.id, r.allow_calls || 'friends');
        });
        s.online = online;
        paintPresence();
    }
    setInterval(() => { heartbeat(); if (document.visibilityState === 'visible') refreshPresence(); }, 30000);
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') { heartbeat(); refreshPresence(); } });

    // "Active now", "Last seen 5 min ago", or nothing when they keep it private
    function presenceText(id) {
        if (s.online.has(id)) return 'Active now';
        const seen = s.lastSeen.get(id);
        if (!seen) return '';
        const mins = Math.round((Date.now() - Date.parse(seen)) / 60000);
        if (mins < 1) return 'Last seen just now';
        if (mins < 60) return `Last seen ${mins} min ago`;
        const d = new Date(seen);
        const today = new Date();
        const yesterday = new Date(); yesterday.setDate(today.getDate() - 1);
        const time = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
        if (d.toDateString() === today.toDateString()) return `Last seen today at ${time}`;
        if (d.toDateString() === yesterday.toDateString()) return `Last seen yesterday at ${time}`;
        return `Last seen ${d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}`;
    }

    function paintPresence() {
        document.querySelectorAll('[data-presence]').forEach(el =>
            el.classList.toggle('online', s.online.has(el.dataset.presence)));
        document.querySelectorAll('[data-status]').forEach(el => {
            const st = el.hasAttribute('data-with-status') ? statusOf(el.dataset.status) : null;
            const line = presenceText(el.dataset.status);
            el.textContent = st ? [st.label + (st.text ? ` · ${st.text}` : ''), line].filter(Boolean).join(' · ') : (line || el.dataset.away);
            el.classList.toggle('is-online', s.online.has(el.dataset.status));
        });
    }

    // ---------- Friends ----------
    async function loadFriends() {
        const { data, error } = await client.from('diary_friendships').select(`
            id, status, requester, addressee, created_at,
            requester_profile:diary_profiles!diary_friendships_requester_fkey(id, username, display_name, avatar_path),
            addressee_profile:diary_profiles!diary_friendships_addressee_fkey(id, username, display_name, avatar_path)
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
            .select('id, sender, recipient, body, attachments, created_at, read_at, delivered_at, vanish, deleted_at, edited_at')
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
        queueDelivered(data.filter(m => m.recipient === me && !m.delivered_at).map(m => m.id));
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
        const sig = list => (list || []).map(m => `${m.id}:${m.read_at || ''}:${m.deleted_at || ''}:${JSON.stringify(m.reactions || {})}:${m.expires_at || ''}`).join('|');
        const before = sig(s.threads[friendId]);
        if (error && s.threads[friendId]) return; // keep what's on screen if the network hiccups
        s.threads[friendId] = error ? [] : data.reverse();
        mergeOutbox(friendId);
        queueDelivered(s.threads[friendId].filter(m => m.recipient === me && !m.delivered_at).map(m => m.id));
        pruneVanished(friendId);
        if (before === sig(s.threads[friendId])) return;
        if (app.state.view === 'messages' && s.activeFriend === friendId) app.requestRender('messages');
    }

    // Refresh: fetch the chat list, requests and the open conversation again, and reconnect live updates
    // (handy after the phone slept or the network dropped)
    async function refreshChat() {
        if (!signedIn() || s.chatRefreshing) return;
        s.chatRefreshing = true;
        document.querySelectorAll('[data-action="chat-refresh"]').forEach(b => b.classList.add('spinning'));
        try {
            await Promise.all([loadFriends(), loadRecent(), loadFollows(), loadIncognito(), loadPrefs()]);
            flushOutbox();
            if (s.activeFriend) {
                await loadThread(s.activeFriend);
                markRead(s.activeFriend);
            }
            subscribe();
            if (app.state.view === 'messages') app.render();
            app.showToast('Chats are up to date');
        } catch (e) {
            app.showToast('Couldn’t refresh — check your connection');
        } finally {
            s.chatRefreshing = false;
            document.querySelectorAll('[data-action="chat-refresh"]').forEach(b => b.classList.remove('spinning'));
        }
    }

    // Pull-to-refresh (and the menu's Refresh) on these pages fetches fresh data instead of reloading the app
    app.onRefresh('messages', refreshChat);
    const refreshFeed = async () => {
        if (!signedIn()) return location.reload();
        s.feedStale = false;
        s.feed = null;
        await loadFeed();
        if (window.diaryLive && window.diaryLive.refresh) window.diaryLive.refresh();
        app.showToast('Up to date');
    };
    app.onRefresh('feed', refreshFeed);
    app.onRefresh('explore', refreshFeed);

    // Share your live location in the open chat (location.js does the map, updates and stopping)
    async function shareLocationInChat() {
        const friendId = s.activeFriend;
        if (!friendId || !window.LiveLocation) return;
        const att = await window.LiveLocation.share({ peer: friendId });
        if (!att) return;
        const { data, error } = await client.from('diary_messages').insert({ recipient: friendId, body: '', attachments: [att] }).select().single();
        if (error) {
            window.LiveLocation.stop(att.id);
            return app.showToast('Couldn’t share your location — try again');
        }
        (s.threads[friendId] = s.threads[friendId] || []).push(data);
        s.last[friendId] = data;
        appendMessage(data);
        updateConvoRow(friendId);
    }

    async function markRead(friendId) {
        if (!s.unread[friendId]) return;
        s.unread[friendId] = 0;
        updateBadge();
        await client.rpc('diary_mark_read', { friend: friendId });
    }

    function openChat(friendId, opts = {}) {
        if (s.activeFriend && s.activeFriend !== friendId) pruneVanished(s.activeFriend, true);
        s.unreadMark = { friendId, count: s.unread[friendId] || 0 };
        if (prefOf('dm', friendId).marked_unread) setPref('dm', friendId, { marked_unread: false });
        s.activeFriend = friendId;
        s.editing = null;
        s.chatOpenedAt[friendId] = Date.now();
        pruneVanished(friendId);
        if (!s.threads[friendId]) loadThread(friendId);
        markRead(friendId);
        s.chatFocused = window.matchMedia('(hover: hover)').matches;
        app.render();
        // Each open chat is its own history entry, so Back returns to the list
        if (!opts.fromHistory && app.state.view === 'messages') app.pushRoute({ chat: friendId }, !!(history.state && history.state.chat));
    }

    // Back / Forward between the chat list and a chat
    app.onRoute(r => routeTo(r));
    function routeTo(r) {
        if (r.view !== 'messages') return;
        if (!s.profile) { s.pendingRoute = r; return; }
        if (r.chat && r.msg) s.pendingJump = { friendId: r.chat, id: r.msg };
        const want = r.chat || null;
        if (want && want === s.activeFriend && s.pendingJump) { const j = s.pendingJump; s.pendingJump = null; jumpToMessage(j.friendId, j.id); return; }
        if (want === s.activeFriend) return;
        if (want && s.friends.some(f => f.id === want)) {
            if (app.state.view === 'messages') openChat(want, { fromHistory: true });
            else s.activeFriend = want; // setView renders it
        } else if (!want) {
            if (s.activeFriend) pruneVanished(s.activeFriend, true);
            const done = () => {
                s.activeFriend = null;
                if (app.state.view === 'messages') app.render();
            };
            const pane = content.querySelector('.chat-pane');
            const animated = pane && app.state.view === 'messages' && document.body.classList.contains('chat-open')
                && !(document.documentElement.dataset.motion === 'reduce' || window.matchMedia('(prefers-reduced-motion: reduce)').matches);
            if (!animated) return done();
            pane.classList.add('leaving');
            setTimeout(done, 220);
        }
    }

    function saveDraft() {
        const input = $('chat-input');
        if (!input || !s.activeFriend) return;
        s.drafts[s.activeFriend] = Rich.toText(input.innerHTML) ? input.innerHTML : '';
        updateComposerButton();
        clearTimeout(saveDraft.timer);
        saveDraft.timer = setTimeout(() => {
            const kept = Object.fromEntries(Object.entries(s.drafts).filter(([id]) => !incognitoOf(id)));
            try { localStorage.setItem(`diaryChatDrafts:${s.profile.id}`, JSON.stringify(kept)); } catch (e) {}
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
        if (s.editing && s.editing.friendId === friendId) {
            if (!text) return app.showToast('A message can’t be empty — delete it instead');
            return saveEdit(html);
        }
        const pending = s.pending[friendId] || [];
        if (!text && !pending.length) return;

        input.innerHTML = '';
        s.drafts[friendId] = '';
        saveDraft();
        s.pending[friendId] = [];
        renderPending();
        const replyTo = s.replyTo[friendId] || null;
        delete s.replyTo[friendId];
        renderReplyBar();
        sendTyping(true);

        const ok = await deliver(friendId, text ? html : '', pending, replyTo);
        if (!ok) {
            const current = $('chat-input');
            if (current && s.activeFriend === friendId) current.innerHTML = html;
            s.drafts[friendId] = html;
            s.pending[friendId] = pending;
            if (replyTo) s.replyTo[friendId] = replyTo;
            renderPending();
            renderReplyBar();
        }
        updateComposerButton();
    }

    // Upload attachments, then insert the message. Returns false (after telling the user) on failure.
    async function deliver(friendId, html, items, replyTo = null) {
        if (!items.length && html) return deliverText(friendId, html, replyTo);
        s.sending = true;
        content.querySelector('.composer')?.classList.add('busy');
        const me = s.profile.id;
        const uploaded = [];
        try {
            for (const p of items) {
                const ext = (p.name.match(/\.[a-z0-9]{1,5}$/i) || [''])[0].toLowerCase() || extFor(p.type);
                const path = `${me}/${friendId}/${incognitoOf(friendId) ? 'incognito/' : ''}${randomId()}${ext}`;
                const { error } = await client.storage.from(BUCKET).upload(path, p.file, { contentType: p.type, upsert: false });
                if (error) throw new Error(`Couldn’t upload ${p.name}: ${error.message}`);
                uploaded.push({
                    path, name: p.name.slice(0, 120), type: p.type, size: p.size, kind: p.kind,
                    ...(p.duration ? { duration: Math.round(p.duration) } : {}),
                    ...(p.waveform ? { waveform: p.waveform.slice(0, 40) } : {})
                });
            }
            const { data, error } = await client.from('diary_messages')
                .insert({ recipient: friendId, body: html.slice(0, 20000), attachments: uploaded, client_id: randomId(), ...(replyTo ? { reply_to: replyTo } : {}) })
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
    function voiceHTML(a, bucket = null) {
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
                <audio preload="none" data-path="${esc(a.path)}"${bucket ? ` data-bucket="${bucket}"` : ''}></audio>
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
        if (s.typingFrom === m.sender) hideTyping();
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
        queueDelivered([m.id]);
        const friend = s.friends.find(f => f.id === m.sender);
        if (!isMuted('dm', m.sender) && s.myStatus !== 'dnd') {
            app.showToast(m.vanish ? 'New incognito message' : `New message from ${friend ? friend.display_name : 'a friend'}`);
            const sound = prefOf('dm', m.sender).sound || 'chime';
            if (sound !== 'none' && window.diaryChatTools) window.diaryChatTools.playSound(sound);
        }
        if (app.state.view === 'messages') updateConvoRow(m.sender);
    }

    // Read receipts, reactions and unsends arrive as updates to the row
    function onMessageUpdate(m) {
        const other = m.sender === s.profile.id ? m.recipient : m.sender;
        const thread = s.threads[other];
        const local = thread && thread.find(x => x.id === m.id);
        if (local) {
            const changed = local.deleted_at !== m.deleted_at || local.body !== m.body || local.edited_at !== m.edited_at || local.restored_at !== m.restored_at
                || JSON.stringify(local.reactions || {}) !== JSON.stringify(m.reactions || {});
            Object.assign(local, { read_at: m.read_at, delivered_at: m.delivered_at, reactions: m.reactions || {}, deleted_at: m.deleted_at, body: m.body, attachments: m.attachments, expires_at: m.expires_at, vanish: m.vanish, edited_at: m.edited_at, restored_at: m.restored_at });
            if (changed) repaintMessage(m.id);
            else {
                const tick = content.querySelector(`[data-msg="${m.id}"] .ticks`);
                if (tick) tick.outerHTML = ticksHTML(local);
            }
        }
        if (s.last[other] && s.last[other].id === m.id) {
            Object.assign(s.last[other], m);
            if (app.state.view === 'messages') updateConvoRow(other);
        }
    }

    function repaintMessage(id) {
        const el = content.querySelector(`[data-msg="${id}"]`);
        const other = s.activeFriend;
        const thread = s.threads[other] || [];
        const i = thread.findIndex(x => String(x.id) === String(id));
        if (!el || i < 0) return;
        el.outerHTML = messageHTML(thread[i], thread[i - 1] || null, true);
        hydrateStorage($('chat-thread'));
    }

    function appendMessage(m) {
        const threadEl = $('chat-thread');
        const other = m.sender === s.profile.id ? m.recipient : m.sender;
        if (!threadEl || s.activeFriend !== other) return;
        const empty = threadEl.querySelector('.chat-empty');
        if (empty) empty.remove();
        const list = s.threads[other] || [];
        const prev = list[list.indexOf(m) - 1] || null;
        const nearBottom = threadEl.scrollHeight - threadEl.scrollTop - threadEl.clientHeight < 160;
        const typing = threadEl.querySelector('.typing-row');
        if (typing) typing.insertAdjacentHTML('beforebegin', messageHTML(m, prev));
        else threadEl.insertAdjacentHTML('beforeend', messageHTML(m, prev));
        hydrateStorage(threadEl);
        if (window.LiveLocation) window.LiveLocation.hydrate(threadEl);
        const fresh = threadEl.querySelector(`[data-msg="${m.id}"]`);
        if (fresh) fresh.classList.add('pop-in');
        if (nearBottom || m.sender === s.profile.id) {
            threadEl.scrollTo({ top: threadEl.scrollHeight, behavior: 'smooth' });
        } else {
            showJump(true);
        }
    }

    function showJump(fresh) {
        const btn = $('chat-jump');
        if (!btn) return;
        btn.hidden = false;
        btn.classList.toggle('fresh', !!fresh);
        btn.querySelector('span').textContent = fresh ? 'New message' : '';
    }

    // ---------- Reactions, replies, unsend ----------
    const REACTIONS = ['❤️', '😂', '😮', '😢', '🙏', '👍', '🔥', '🎉'];

    function findMessage(id) {
        return (s.threads[s.activeFriend] || []).find(x => String(x.id) === String(id));
    }

    async function react(id, emoji) {
        const m = findMessage(id);
        if (!m || m.deleted_at) return;
        const me = s.profile.id;
        const before = JSON.parse(JSON.stringify(m.reactions || {}));
        const had = (before[emoji] || []).includes(me);
        const next = {};
        Object.entries(before).forEach(([k, users]) => {
            const rest = users.filter(u => u !== me);
            if (rest.length) next[k] = rest;
        });
        if (!had) next[emoji] = [...(next[emoji] || []), me];
        m.reactions = next;
        closeReactBar();
        repaintMessage(id);
        const el = content.querySelector(`[data-msg="${id}"] .react-chip[data-emoji="${emoji}"]`);
        if (el) el.classList.add('pop');
        const { data, error } = await client.rpc('diary_react_message', { p_id: Number(id), p_emoji: emoji });
        if (error) {
            m.reactions = before;
            app.showToast('Couldn’t add that reaction');
        } else {
            m.reactions = data || {};
        }
        repaintMessage(id);
    }

    function startReply(id) {
        const m = findMessage(id);
        if (!m || m.deleted_at) return;
        s.replyTo[s.activeFriend] = m.id;
        closeReactBar();
        renderReplyBar();
        const input = $('chat-input');
        if (input) {
            input.focus();
            Rich.placeCaretAtEnd(input);
        }
    }

    function renderReplyBar() {
        const bar = $('reply-bar');
        if (!bar) return;
        if (s.editing && s.editing.friendId === s.activeFriend) {
            const em = findMessage(s.editing.id);
            bar.hidden = false;
            bar.innerHTML = `
                <svg class="i"><use href="#i-edit"/></svg>
                <span class="reply-text"><strong>Editing message</strong><small>${esc(em ? previewOf(em) : '')}</small></span>
                <button type="button" class="icon-btn ghost" data-action="cancel-edit" aria-label="Cancel editing"><svg class="i"><use href="#i-close"/></svg></button>`;
            return;
        }
        const m = findMessage(s.replyTo[s.activeFriend]);
        bar.hidden = !m;
        if (!m) return;
        const friend = s.friends.find(f => f.id === s.activeFriend);
        bar.innerHTML = `
            <svg class="i"><use href="#i-reply"/></svg>
            <span class="reply-text"><strong>Replying to ${m.sender === s.profile.id ? 'yourself' : esc(friend ? friend.display_name : 'them')}</strong><small>${esc(previewOf(m))}</small></span>
            <button type="button" class="icon-btn ghost" data-action="cancel-reply" aria-label="Cancel reply"><svg class="i"><use href="#i-close"/></svg></button>`;
    }

    async function unsend(id) {
        const m = findMessage(id);
        if (!m || m.sender !== s.profile.id) return;
        const ok = await app.ask({ title: 'Unsend this message?', text: 'It will be removed for both of you.', ok: 'Unsend', danger: true });
        if (!ok) return;
        const { data, error } = await client.rpc('diary_unsend_message', { p_id: Number(id) });
        if (error) return app.showToast('Couldn’t unsend that message');
        const paths = (data || []).map(a => a && a.path).filter(Boolean);
        if (paths.length) client.storage.from(BUCKET).remove(paths);
        Object.assign(m, { deleted_at: new Date().toISOString(), body: '', attachments: [], reactions: {} });
        repaintMessage(id);
        updateConvoRow(s.activeFriend);
    }

    // ---------- Editing, deleting and restoring messages (shared by chats and group chats) ----------
    // Edit: your own messages, for 24 hours; they show "edited", and anyone in the chat can see earlier versions.
    // Delete for me: hidden only for you. Delete for everyone: your own messages (or, in groups, what staff remove).
    // Both can be restored from "Recently deleted" for 30 days.
    const EDIT_WINDOW = 24 * 3600 * 1000;
    const canEdit = m => m && !m.deleted_at && !m.vanish && Date.now() - Date.parse(m.created_at) < EDIT_WINDOW;

    function editedTag(kind, m) {
        if (m.restored_at && !m.deleted_at) return '<span class="msg-flag" title="Restored after being deleted">restored</span>';
        if (!m.edited_at) return '';
        return `<button type="button" class="msg-flag" data-action="msg-history" data-kind="${kind}" data-id="${esc(String(m.id))}" title="Edited ${esc(new Date(m.edited_at).toLocaleString())} — see earlier versions">edited</button>`;
    }

    async function showHistory(kind, id, current) {
        const { data, error } = await client.from('diary_message_edits').select('body, edited_at').eq('kind', kind).eq('message_id', Number(id)).order('edited_at');
        if (error) return app.showToast('Couldn’t load the edit history');
        const d = historySheet();
        const text = b => (kind === 'dm' ? Rich.toText(b || '') : String(b || ''));
        d.innerHTML = `
            <div class="hist-card">
                <header><strong>Edit history</strong><button type="button" class="icon-btn" data-close aria-label="Close"><svg class="i"><use href="#i-close"/></svg></button></header>
                <ol class="hist-list">
                    ${(data || []).map(v => `<li><small>${esc(new Date(v.edited_at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }))}</small><p>${esc(text(v.body))}</p></li>`).join('')}
                    ${current ? `<li class="now"><small>Now${current.edited_at ? ` · edited ${esc(new Date(current.edited_at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }))}` : ''}</small><p>${esc(text(current.body))}</p></li>` : ''}
                </ol>
            </div>`;
        if (!d.open) d.showModal();
    }

    let histDlg = null;
    function historySheet() {
        if (histDlg) return histDlg;
        histDlg = document.createElement('dialog');
        histDlg.className = 'hist-sheet';
        document.body.append(histDlg);
        histDlg.addEventListener('click', async e => {
            if (e.target === histDlg || e.target.closest('[data-close]')) return histDlg.close();
            const btn = e.target.closest('[data-restore]');
            if (!btn) return;
            btn.disabled = true;
            const [kind, id, how] = btn.dataset.restore.split(':');
            const { error } = how === 'me'
                ? await client.from('diary_message_hidden').delete().eq('kind', kind).eq('message_id', Number(id))
                : await client.rpc('diary_restore_message', { p_kind: kind, p_id: Number(id) });
            if (error) { btn.disabled = false; return app.showToast(error.message || 'Couldn’t restore that'); }
            btn.closest('li').remove();
            app.showToast('Message restored');
            if (histDlg.onRestored) histDlg.onRestored(kind, id);
            if (!histDlg.querySelector('.hist-list li')) histDlg.querySelector('.hist-list').innerHTML = '<li class="empty"><p>Nothing left to restore.</p></li>';
        });
        return histDlg;
    }

    // "Recently deleted" for one chat (kind 'dm', scope = friend id) or group (kind 'gc', scope = community id)
    async function openRecentlyDeleted(kind, scope, { title = 'Recently deleted', nameOf = () => '', onRestored } = {}) {
        const d = historySheet();
        d.onRestored = onRestored || null;
        d.innerHTML = `<div class="hist-card"><header><strong>${esc(title)}</strong><button type="button" class="icon-btn" data-close aria-label="Close"><svg class="i"><use href="#i-close"/></svg></button></header><p class="muted small">Loading…</p></div>`;
        if (!d.open) d.showModal();
        const { data, error } = await client.rpc('diary_recently_deleted', { p_kind: kind, p_scope: scope });
        const text = r => (kind === 'dm' ? Rich.toText(r.body || '') : String(r.body || '')).trim()
            || ((r.attachments || [])[0] ? ({ audio: '🎤 Voice note', image: '📷 Photo', location: '📍 Location' }[r.attachments[0].kind] || '📎 Attachment') : '');
        d.innerHTML = `
            <div class="hist-card">
                <header><strong>${esc(title)}</strong><button type="button" class="icon-btn" data-close aria-label="Close"><svg class="i"><use href="#i-close"/></svg></button></header>
                <p class="muted small hist-note">Messages you deleted in the last 30 days. Restore one to put it back where it was.</p>
                <ol class="hist-list">
                    ${error ? '<li class="empty"><p>Couldn’t load deleted messages.</p></li>'
                        : (data || []).length ? data.map(r => `
                            <li>
                                <small>${esc(r.author === s.profile.id ? 'You' : nameOf(r.author) || 'Them')} · deleted ${esc(r.how === 'me' ? 'for you' : 'for everyone')} ${esc(timeAgo(r.deleted_at))}</small>
                                <p>${esc(text(r) || 'Message')}</p>
                                <button type="button" class="chip" data-restore="${r.kind}:${r.message_id}:${r.how}"><svg class="i"><use href="#i-undo"/></svg>Restore</button>
                            </li>`).join('')
                        : '<li class="empty"><p>Nothing deleted in the last 30 days.</p></li>'}
                </ol>
            </div>`;
    }

    // Delete choices: for me (any message) / for everyone (your own, or staff in a group)
    async function chooseDelete(anchor, { mine, canEveryone, everyoneLabel = 'Delete for everyone' }) {
        // Open after the tap that asked for it has finished, or that same tap would close the menu again
        await new Promise(r => setTimeout(r, 0));
        if (!anchor || !anchor.isConnected) anchor = content.querySelector('.chat-thread, .gc-thread') || document.body;
        return new Promise(resolve => {
            const items = [{ label: 'Delete for me', icon: 'i-eye-off', onClick: () => resolve('me') }];
            if (canEveryone) items.push({ label: everyoneLabel, icon: 'i-trash', danger: true, onClick: () => resolve('everyone') });
            items.push({ label: 'Cancel', icon: 'i-close', onClick: () => resolve(null) });
            app.openPopover(anchor, items);
            // Closing the menu any other way counts as cancel
            setTimeout(() => {
                const pop = document.getElementById('popover');
                const watch = setInterval(() => { if (!pop || pop.hidden) { clearInterval(watch); resolve(null); } }, 250);
            }, 0);
        });
    }

    // ---------- Chats: edit & delete ----------
    function startEdit(id) {
        const m = findMessage(id);
        if (!m || m.sender !== s.profile.id || !canEdit(m)) return app.showToast('Messages can be edited for 24 hours');
        closeReactBar();
        const input = $('chat-input');
        if (!input) return;
        s.editing = { friendId: s.activeFriend, id: m.id, draft: input.innerHTML };
        delete s.replyTo[s.activeFriend];
        input.innerHTML = Rich.sanitize(m.body || '');
        renderReplyBar();
        input.focus();
        Rich.placeCaretAtEnd(input);
        updateComposerButton();
    }

    function cancelEdit() {
        const e = s.editing;
        s.editing = null;
        const input = $('chat-input');
        if (input && e) input.innerHTML = e.draft || '';
        renderReplyBar();
        updateComposerButton();
    }

    async function saveEdit(html) {
        const e = s.editing;
        const m = findMessage(e.id);
        s.editing = null;
        renderReplyBar();
        const input = $('chat-input');
        if (input) input.innerHTML = e.draft || '';
        if (!m || html === m.body) return;
        const before = { body: m.body, edited_at: m.edited_at };
        Object.assign(m, { body: html, edited_at: new Date().toISOString() });
        repaintMessage(m.id);
        const { data, error } = await client.rpc('diary_edit_message', { p_id: Number(m.id), p_body: html });
        if (error) {
            Object.assign(m, before);
            repaintMessage(m.id);
            return app.showToast(error.message || 'Couldn’t edit that message');
        }
        Object.assign(m, { body: data.body, edited_at: data.edited_at });
        repaintMessage(m.id);
        updateConvoRow(e.friendId);
    }

    async function deleteMessage(id, anchor) {
        const m = findMessage(id);
        if (!m) return;
        closeReactBar();
        const mine = m.sender === s.profile.id;
        const how = await chooseDelete(anchor, { mine, canEveryone: mine && !m.deleted_at });
        if (!how) return;
        const friendId = s.activeFriend;
        if (how === 'me') {
            const { error } = await client.from('diary_message_hidden').insert({ kind: 'dm', message_id: Number(m.id) });
            if (error) return app.showToast('Couldn’t delete that');
            s.threads[friendId] = (s.threads[friendId] || []).filter(x => x !== m);
            if (s.last[friendId] === m) s.last[friendId] = s.threads[friendId][s.threads[friendId].length - 1];
            content.querySelector(`[data-msg="${id}"]`)?.remove();
            updateConvoRow(friendId);
            app.showToast('Deleted for you', async () => {
                await client.from('diary_message_hidden').delete().eq('kind', 'dm').eq('message_id', Number(m.id));
                loadThread(friendId);
            });
        } else {
            const { error } = await client.rpc('diary_unsend_message', { p_id: Number(id) });
            if (error) return app.showToast('Couldn’t delete that message');
            Object.assign(m, { deleted_at: new Date().toISOString(), body: '', attachments: [], reactions: {} });
            repaintMessage(id);
            updateConvoRow(friendId);
            app.showToast('Deleted for everyone', async () => {
                const { error: e2 } = await client.rpc('diary_restore_message', { p_kind: 'dm', p_id: Number(id) });
                if (e2) return app.showToast('Couldn’t restore it');
                loadThread(friendId);
            });
        }
    }

    function jumpTo(id) {
        const el = content.querySelector(`[data-msg="${id}"]`);
        if (!el) return app.showToast('That message is further back in the chat');
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        el.classList.remove('flash');
        void el.offsetWidth;
        el.classList.add('flash');
    }

    // The floating bar: quick reactions + reply / copy / unsend
    function openReactBar(id) {
        closeReactBar();
        const m = findMessage(id);
        const el = content.querySelector(`[data-msg="${id}"]`);
        if (!m || !el) return;
        if (m.deleted_at) return deleteMessage(id, el.querySelector('.msg-card'));
        const mine = m.sender === s.profile.id;
        const bar = document.createElement('div');
        bar.className = 'react-bar';
        bar.setAttribute('role', 'menu');
        bar.innerHTML = `
            <div class="react-emojis">${REACTIONS.map(e => `<button type="button" data-action="react" data-id="${esc(String(id))}" data-emoji="${e}" aria-label="React ${e}">${e}</button>`).join('')}</div>
            <div class="react-actions">
                <button type="button" data-action="msg-reply" data-id="${esc(String(id))}"><svg class="i"><use href="#i-reply"/></svg>Reply</button>
                ${m.vanish ? '' : `<button type="button" data-action="msg-forward" data-id="${esc(String(id))}"><svg class="i"><use href="#i-forward"/></svg>Forward</button>`}
                ${m.vanish || String(id).startsWith('tmp-') ? '' : `<button type="button" data-action="msg-link" data-id="${esc(String(id))}"><svg class="i"><use href="#i-link"/></svg>Copy link</button>`}
                ${Rich.toText(m.body || '') && !m.vanish ? `<button type="button" data-action="msg-copy" data-id="${esc(String(id))}"><svg class="i"><use href="#i-notes"/></svg>Copy</button>` : ''}
                ${!mine && Rich.toText(m.body || '') ? `<button type="button" data-action="msg-translate" data-id="${esc(String(id))}"><svg class="i"><use href="#i-sparkle"/></svg>Translate</button>` : ''}
                ${!mine && !String(id).startsWith('tmp-') ? `<button type="button" data-action="msg-report" data-id="${esc(String(id))}"><svg class="i"><use href="#i-flag"/></svg>Report</button>` : ''}
                ${mine && canEdit(m) && Rich.toText(m.body || '') ? `<button type="button" data-action="msg-edit" data-id="${esc(String(id))}"><svg class="i"><use href="#i-edit"/></svg>Edit</button>` : ''}
                <button type="button" class="danger" data-action="msg-delete" data-id="${esc(String(id))}"><svg class="i"><use href="#i-trash"/></svg>Delete</button>
            </div>`;
        el.querySelector('.msg-card').append(bar);
        el.classList.add('menu-open');
        if (navigator.vibrate) navigator.vibrate(12);
    }

    function closeReactBar() {
        content.querySelectorAll('.react-bar').forEach(b => {
            b.closest('.msg')?.classList.remove('menu-open');
            b.remove();
        });
    }

    document.addEventListener('pointerdown', e => {
        if (!e.target.closest('.react-bar') && !e.target.closest('[data-action="msg-menu"]')) closeReactBar();
    });

    // Touch: long-press opens the bar, swipe right replies; anywhere: double-tap loves
    let press = null;
    content.addEventListener('pointerdown', e => {
        const card = e.target.closest('.msg:not(.unsent) .msg-card');
        if (!card || e.target.closest('button, a, .vn, .react-bar')) return;
        const msg = card.closest('.msg');
        press = { card, id: msg.dataset.msg, x: e.clientX, y: e.clientY, dx: 0, moved: false, pointer: e.pointerType };
        press.timer = setTimeout(() => {
            if (press && !press.moved) {
                openReactBar(press.id);
                press.opened = true;
            }
        }, 450);
    });
    content.addEventListener('pointermove', e => {
        if (!press) return;
        const dx = e.clientX - press.x;
        const dy = e.clientY - press.y;
        if (Math.abs(dx) > 8 || Math.abs(dy) > 8) {
            press.moved = true;
            clearTimeout(press.timer);
        }
        if (press.pointer === 'touch' && dx > 0 && Math.abs(dy) < 30) {
            press.dx = Math.min(dx, 90);
            press.card.style.transform = `translateX(${press.dx}px)`;
            press.card.classList.toggle('will-reply', press.dx > 60);
        }
    });
    const endPress = () => {
        if (!press) return;
        clearTimeout(press.timer);
        press.card.style.transform = '';
        press.card.classList.remove('will-reply');
        if (press.dx > 60) startReply(press.id);
        press = null;
    };
    content.addEventListener('pointerup', endPress);
    content.addEventListener('pointercancel', endPress);
    content.addEventListener('contextmenu', e => {
        if (e.target.closest('.msg-card') && e.pointerType !== 'mouse') e.preventDefault();
    });
    content.addEventListener('dblclick', e => {
        const card = e.target.closest('.msg:not(.unsent) .msg-card');
        if (!card || e.target.closest('button, a, .vn, .react-bar')) return;
        e.preventDefault();
        const id = card.closest('.msg').dataset.msg;
        const m = findMessage(id);
        if (m && !((m.reactions || {})['❤️'] || []).includes(s.profile.id)) react(id, '❤️');
    });

    // Scrolled up? Offer a way back down
    content.addEventListener('scroll', e => {
        if (e.target.id !== 'chat-thread') return;
        const t = e.target;
        const away = t.scrollHeight - t.scrollTop - t.clientHeight > 400;
        const btn = $('chat-jump');
        if (!btn) return;
        if (away) {
            if (btn.hidden) showJump(false);
        } else {
            btn.hidden = true;
        }
    }, true);

    // ---------- Incognito chats ----------
    // Either friend can switch a chat to incognito. New messages then vanish for both of you — after they're
    // seen (as soon as you leave the chat, and within five minutes of being read), or 1 or 24 hours after
    // sending. The server enforces the timer; the app also keeps them out of drafts, previews, toasts,
    // typing signals and Copy, and blurs the chat when you switch away.
    const VANISH_MODES = [
        ['seen', 'Vanish after seen'],
        ['1h', 'Vanish after 1 hour'],
        ['24h', 'Vanish after 24 hours'],
        ['7d', 'Vanish after 7 days'],
        ['30d', 'Vanish after 30 days']
    ];
    const VANISH_TEXT = { seen: 'vanish after they’re seen', '1h': 'vanish an hour after sending', '24h': 'vanish 24 hours after sending', '7d': 'vanish 7 days after sending', '30d': 'vanish 30 days after sending' };

    function incognitoOf(friendId) {
        const row = s.incognito[friendId];
        return row && row.mode && row.mode !== 'off' ? row : null;
    }

    async function loadIncognito() {
        const { data, error } = await client.from('diary_incognito').select('user_a, user_b, mode, set_by, updated_at');
        if (error) return;
        s.incognito = {};
        const me = s.profile.id;
        (data || []).forEach(row => { s.incognito[row.user_a === me ? row.user_b : row.user_a] = row; });
    }

    function onIncognitoChange(row) {
        if (!row || !row.user_a || !s.profile) return;
        const me = s.profile.id;
        const friendId = row.user_a === me ? row.user_b : row.user_a;
        const before = incognitoOf(friendId);
        s.incognito[friendId] = row;
        const after = incognitoOf(friendId);
        if ((before && before.mode) === (after && after.mode)) return;
        if (row.set_by && row.set_by !== me) {
            const friend = s.friends.find(f => f.id === friendId);
            const name = friend ? friend.display_name.split(' ')[0] : 'Your friend';
            app.showToast(after ? `${name} turned on incognito — new messages ${VANISH_TEXT[after.mode]}` : `${name} turned off incognito`);
        }
        if (app.state.view === 'messages') {
            if (s.activeFriend === friendId) app.render();
            else updateConvoRow(friendId);
        }
    }

    async function setIncognito(friendId, mode) {
        const { data, error } = await client.rpc('diary_set_incognito', { friend: friendId, p_mode: mode });
        if (error) return app.showToast(error.message || 'Couldn’t change incognito');
        onIncognitoChange(data);
        app.showToast(mode === 'off' ? 'Incognito off — new messages will stay' : `Incognito on — new messages ${VANISH_TEXT[mode]}`);
        if (app.state.view === 'messages') app.render();
    }

    function incognitoMenu(el) {
        const friendId = s.activeFriend;
        if (!friendId) return;
        const current = incognitoOf(friendId);
        app.openPopover(el, [
            ...VANISH_MODES.map(([mode, label]) => ({
                label: `${current && current.mode === mode ? '✓ ' : ''}${label}`,
                icon: 'i-timer',
                onClick: () => setIncognito(friendId, mode)
            })),
            ...(current ? [{ label: 'Turn off incognito', icon: 'i-close', onClick: () => setIncognito(friendId, 'off') }] : [])
        ]);
    }

    function incognitoBanner(friend, inc) {
        const who = inc.set_by === s.profile.id ? 'You' : esc(friend.display_name.split(' ')[0]);
        return `
            <div class="incognito-banner" role="status">
                <span class="incognito-ic" aria-hidden="true"><svg class="i"><use href="#i-incognito"/></svg></span>
                <span class="incognito-text"><strong>Incognito chat</strong><small>${who} turned it on · new messages ${VANISH_TEXT[inc.mode]}. No previews, saved drafts or read receipts.</small></span>
                <button type="button" class="chip" data-action="chat-incognito">Change</button>
            </div>`;
    }

    function vanishTitle(m) {
        if (m.vanish === 'seen') return m.read_at ? 'Seen — vanishes when the chat is closed' : 'Vanishes after it’s seen';
        const left = Date.parse(m.expires_at) - Date.now();
        if (!(left > 0)) return 'Vanishing';
        const mins = Math.ceil(left / 60000);
        return mins > 2880 ? `Vanishes in ${Math.round(mins / 1440)} days` : mins > 90 ? `Vanishes in ${Math.round(mins / 60)} h` : `Vanishes in ${mins} min`;
    }

    // Drop vanished messages from a thread. leaving = true also removes seen-and-vanish messages read during
    // this visit (so they're gone when you come back).
    function pruneVanished(friendId, leaving = false) {
        const thread = s.threads[friendId];
        if (!thread) return [];
        const now = Date.now();
        const openedAt = leaving ? now + 1 : (s.chatOpenedAt[friendId] || now);
        const gone = thread.filter(m => m.vanish && (
            (m.expires_at && Date.parse(m.expires_at) <= now) ||
            (m.vanish === 'seen' && m.read_at && Date.parse(m.read_at) < openedAt - 2000)
        ));
        if (!gone.length) return gone;
        s.threads[friendId] = thread.filter(m => !gone.includes(m));
        if (s.last[friendId] && gone.some(m => m.id === s.last[friendId].id)) {
            const rest = s.threads[friendId];
            if (rest.length) s.last[friendId] = rest[rest.length - 1];
            else delete s.last[friendId];
        }
        return gone;
    }

    // While a chat is open, timed-out messages fade away in place
    setInterval(() => {
        if (!signedIn() || app.state.view !== 'messages' || !s.activeFriend) return;
        const thread = s.threads[s.activeFriend] || [];
        const now = Date.now();
        const expired = thread.filter(m => m.vanish && m.expires_at && Date.parse(m.expires_at) <= now);
        if (!expired.length) return;
        s.threads[s.activeFriend] = thread.filter(m => !expired.includes(m));
        expired.forEach(m => {
            const el = content.querySelector(`[data-msg="${m.id}"]`);
            if (!el) return;
            el.classList.add('vanishing');
            setTimeout(() => el.remove(), 420);
        });
        if (s.last[s.activeFriend] && expired.some(m => m.id === s.last[s.activeFriend].id)) {
            const rest = s.threads[s.activeFriend];
            if (rest.length) s.last[s.activeFriend] = rest[rest.length - 1];
            else delete s.last[s.activeFriend];
            updateConvoRow(s.activeFriend);
        }
    }, 10000);

    // Files from vanished messages are already locked; the sender's app deletes them for good
    async function emptyIncognitoTrash() {
        try {
            await client.rpc('diary_purge_expired_messages');
            const { data } = await client.from('diary_incognito_trash').select('id, path').limit(100);
            if (!data || !data.length) return;
            await client.storage.from(BUCKET).remove(data.map(d => d.path));
            await client.from('diary_incognito_trash').delete().in('id', data.map(d => d.id));
        } catch (e) {}
    }

    // Blur an incognito chat whenever the app isn't in front (app switcher, another tab, another window)
    const shield = on => content.querySelector('.chat-pane.incognito')?.classList.toggle('shielded', on);
    window.addEventListener('blur', () => shield(true));
    window.addEventListener('focus', () => shield(false));
    document.addEventListener('visibilitychange', () => shield(document.visibilityState !== 'visible'));


    // ---------- Chat organisation: pin, archive, mark unread, mute & sound (synced across devices) ----------
    const FOREVER = '2999-01-01T00:00:00.000Z';
    s.prefs = new Map();     // "dm:<friend id>" | "gc:<community id>" -> settings row
    s.receipts = new Map();  // friend id -> false when read receipts are off (theirs or yours)
    const prefOf = (kind, peer) => s.prefs.get(`${kind}:${peer}`) || {};
    const isMuted = (kind, peer) => { const u = prefOf(kind, peer).muted_until; return !!u && Date.parse(u) > Date.now(); };

    async function loadPrefs() {
        const { data, error } = await client.from('diary_chat_prefs').select('*');
        if (error) return;
        s.prefs = new Map((data || []).map(r => [`${r.kind}:${r.peer}`, r]));
        // Chats muted on this device before settings synced: carry them over once
        if (s.muted && s.muted.size) {
            for (const id of s.muted) if (!isMuted('dm', id)) await setPref('dm', id, { muted_until: FOREVER });
            s.muted.clear();
            try { localStorage.removeItem('diaryMuted'); } catch (e) {}
        }
    }

    async function setPref(kind, peer, patch) {
        const key = `${kind}:${peer}`;
        const before = s.prefs.get(key);
        const row = { kind, peer, pinned_at: null, archived: false, marked_unread: false, muted_until: null, sound: null, ...(before || {}), ...patch, updated_at: new Date().toISOString() };
        s.prefs.set(key, row);
        if (app.state.view === 'messages') app.requestRender('messages');
        const { error } = await client.from('diary_chat_prefs').upsert({
            kind, peer, pinned_at: row.pinned_at, archived: !!row.archived, marked_unread: !!row.marked_unread,
            muted_until: row.muted_until, sound: row.sound, updated_at: row.updated_at
        }, { onConflict: 'user_id,kind,peer' });
        if (error) {
            if (before) s.prefs.set(key, before); else s.prefs.delete(key);
            app.requestRender('messages');
            app.showToast('Couldn’t save that — check your connection');
            return false;
        }
        return true;
    }

    function onPrefChange(payload) {
        const row = payload.new && payload.new.kind ? payload.new : null;
        if (!row) return;
        s.prefs.set(`${row.kind}:${row.peer}`, row);
        if (app.state.view === 'messages') app.requestRender('messages');
    }

    const MUTES = [['1 hour', 3600e3], ['8 hours', 8 * 3600e3], ['1 week', 7 * 86400e3], ['Always', 0]];
    function dmConv(friend) {
        return {
            kind: 'dm', friendId: friend.id,
            people: () => [{ id: s.profile.id, name: 'You' }, { id: friend.id, name: friend.display_name }],
            nameOf: id => (id === s.profile.id ? 'You' : friend.display_name),
            jump: (id, at) => jumpToMessage(friend.id, id, at)
        };
    }

    // A friend's contact card, to share in a chat
    function pickContact(anchor, done) {
        const others = s.friends.filter(f => f.id !== s.activeFriend);
        if (!others.length) return app.showToast('Add more friends to share their contact');
        setTimeout(() => app.openPopover(anchor, others.slice(0, 30).map(f => ({
            label: f.display_name, icon: 'i-contact',
            onClick: () => done({ kind: 'contact', id: f.id, name: f.display_name, username: f.username })
        }))), 0);
    }

    async function sendAttachmentOnly(friendId, attachments) {
        const { data, error } = await client.from('diary_messages').insert({ recipient: friendId, body: '', attachments, client_id: randomId() }).select().single();
        if (error) return app.showToast(/block/i.test(error.message || '') ? 'You can’t message this person' : 'Couldn’t send that');
        (s.threads[friendId] = s.threads[friendId] || []).push(data);
        s.last[friendId] = data;
        appendMessage(data);
        updateConvoRow(friendId);
    }

    function contactCardHTML(a) {
        const person = { id: a.id, display_name: a.name || 'Someone' };
        return `<div class="contact-card">${avatar(person, 'md')}<span class="contact-text"><strong>${esc(a.name || 'Someone')}</strong><small>${a.username ? `@${esc(a.username)}` : 'Cordial contact'}</small></span><button type="button" class="chip" data-action="contact-open" data-id="${esc(a.id)}">View</button></div>`;
    }

    function deviceId() {
        let id = null;
        try { id = localStorage.getItem('diaryDeviceId'); } catch (e) {}
        if (!id) {
            id = randomId().replace(/-/g, '').slice(0, 24);
            try { localStorage.setItem('diaryDeviceId', id); } catch (e) {}
        }
        return id;
    }
    function deviceLabel() {
        const ua = navigator.userAgent;
        const os = /iPhone|iPad/.test(ua) ? (/iPad/.test(ua) ? 'iPad' : 'iPhone') : /Android/.test(ua) ? 'Android' : /Mac OS X/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : 'a device';
        const br = /Edg\//.test(ua) ? 'Edge' : /OPR\//.test(ua) ? 'Opera' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'a browser';
        return `${br} on ${os}`;
    }
    function registerDevice() {
        client.rpc('diary_register_device', { p_device: deviceId(), p_label: deviceLabel() }).then(() => {}, () => {});
    }

    function convoMenu(anchor, friendId) {
        const p = prefOf('dm', friendId);
        const friend = s.friends.find(f => f.id === friendId);
        const muted = isMuted('dm', friendId);
        const unread = s.unread[friendId] || p.marked_unread;
        app.openPopover(anchor, [
            { label: p.pinned_at ? 'Unpin chat' : 'Pin chat', icon: 'i-pin-note', onClick: () => {
                const pinned = [...s.prefs.values()].filter(r => r.kind === 'dm' && r.pinned_at).length;
                if (!p.pinned_at && pinned >= 5) return app.showToast('You can pin up to 5 chats');
                setPref('dm', friendId, { pinned_at: p.pinned_at ? null : new Date().toISOString() });
            } },
            { label: unread ? 'Mark as read' : 'Mark as unread', icon: 'i-chat', onClick: () => {
                if (unread) { setPref('dm', friendId, { marked_unread: false }); markRead(friendId); }
                else setPref('dm', friendId, { marked_unread: true });
            } },
            { label: p.archived ? 'Unarchive' : 'Archive chat', icon: 'i-archive', onClick: () => {
                setPref('dm', friendId, { archived: !p.archived });
                app.showToast(p.archived ? 'Moved back to your chats' : `${friend ? friend.display_name.split(' ')[0] : 'Chat'} archived`, p.archived ? null : () => setPref('dm', friendId, { archived: false }));
            } },
            muted
                ? { label: 'Unmute', icon: 'i-bell', onClick: () => setPref('dm', friendId, { muted_until: null }) }
                : { label: 'Mute…', icon: 'i-bell-off', onClick: () => muteMenu(anchor, 'dm', friendId) },
            { label: 'Notification sound…', icon: 'i-volume', onClick: () => soundMenu(anchor, 'dm', friendId) }
        ]);
    }

    function muteMenu(anchor, kind, peer) {
        setTimeout(() => app.openPopover(anchor, MUTES.map(([label, ms]) => ({
            label: `For ${label === 'Always' ? 'ever (until you unmute)' : label}`,
            icon: 'i-bell-off',
            onClick: () => {
                setPref(kind, peer, { muted_until: ms ? new Date(Date.now() + ms).toISOString() : FOREVER });
                app.showToast(ms ? `Muted for ${label}` : 'Muted');
            }
        }))), 0);
    }

    function soundMenu(anchor, kind, peer) {
        const current = prefOf(kind, peer).sound || 'chime';
        const tools = window.diaryChatTools;
        const names = { chime: 'Chime (default)', pop: 'Pop', bell: 'Bell', soft: 'Soft', none: 'No sound' };
        setTimeout(() => app.openPopover(anchor, Object.entries(names).map(([k, label]) => ({
            label: `${current === k ? '✓ ' : ''}${label}`,
            icon: k === 'none' ? 'i-volume-off' : 'i-volume',
            onClick: () => {
                if (tools && k !== 'none') tools.playSound(k);
                setPref(kind, peer, { sound: k === 'chime' ? null : k });
            }
        }))), 0);
    }

    // ---------- Delivery: sending → sent → delivered → read, and an outbox for when you're offline ----------
    const outboxKey = () => `diaryOutbox:${s.profile.id}`;
    const readOutbox = () => load(outboxKey(), []);
    const writeOutbox = list => { try { localStorage.setItem(outboxKey(), JSON.stringify(list.slice(-100))); } catch (e) {} };

    function ticksHTML(m) {
        if (m.pending) return '<span class="ticks pending" title="Sending…"><svg class="i"><use href="#i-clock"/></svg></span>';
        if (m.failed) return `<button type="button" class="ticks failed" data-action="msg-retry" data-id="${esc(String(m.id))}" title="Not sent — tap to try again" aria-label="Not sent. Tap to try again"><svg class="i"><use href="#i-alert"/></svg></button>`;
        const receipts = s.receipts.get(m.recipient) !== false;
        if (m.read_at && receipts) return '<span class="ticks read" title="Read"><svg class="i"><use href="#i-checks"/></svg></span>';
        if (m.delivered_at || m.read_at) return '<span class="ticks delivered" title="Delivered"><svg class="i"><use href="#i-checks"/></svg></span>';
        return '<span class="ticks sent" title="Sent"><svg class="i"><use href="#i-check"/></svg></span>';
    }

    // Tell senders their messages reached this device (batched)
    const deliverQueue = new Set();
    let deliverTimer = null;
    function queueDelivered(ids) {
        ids.forEach(id => { if (typeof id === 'number') deliverQueue.add(id); });
        clearTimeout(deliverTimer);
        deliverTimer = setTimeout(() => {
            const batch = [...deliverQueue];
            deliverQueue.clear();
            if (batch.length && signedIn()) client.rpc('diary_mark_delivered', { ids: batch }).then(() => {}, () => {});
        }, 400);
    }

    // Text messages show straight away; if the network drops they wait in the outbox and go when it's back
    async function deliverText(friendId, html, replyTo) {
        const me = s.profile.id;
        const temp = { id: `tmp-${randomId()}`, client_id: randomId(), sender: me, recipient: friendId, body: html.slice(0, 20000), attachments: [], reply_to: replyTo, reactions: {}, created_at: new Date().toISOString(), pending: true };
        (s.threads[friendId] = s.threads[friendId] || []).push(temp);
        s.last[friendId] = temp;
        s.unreadMark = null;
        appendMessage(temp);
        updateConvoRow(friendId);
        const ok = await sendQueued(temp);
        if (!ok) {
            const list = readOutbox().filter(x => x.client_id !== temp.client_id);
            list.push({ id: temp.id, client_id: temp.client_id, recipient: friendId, body: temp.body, reply_to: replyTo, created_at: temp.created_at });
            writeOutbox(list);
            app.showToast(navigator.onLine ? 'Message not sent — tap the red mark to retry' : 'You’re offline — it’ll send when you’re back online');
        }
        return true;
    }

    async function sendQueued(temp) {
        temp.pending = true;
        temp.failed = false;
        repaintMessage(temp.id);
        let { data, error } = await client.from('diary_messages')
            .insert({ recipient: temp.recipient, body: temp.body, attachments: [], client_id: temp.client_id, ...(temp.reply_to ? { reply_to: temp.reply_to } : {}) })
            .select().single();
        if (error && error.code === '23505') {
            // It already went through on an earlier try: use that copy (never a duplicate)
            ({ data, error } = await client.from('diary_messages').select('*').eq('sender', s.profile.id).eq('client_id', temp.client_id).maybeSingle());
        }
        if (error && /block/i.test(error.message || '')) {
            s.threads[temp.recipient] = (s.threads[temp.recipient] || []).filter(m => m !== temp);
            content.querySelector(`[data-msg="${temp.id}"]`)?.remove();
            writeOutbox(readOutbox().filter(x => x.client_id !== temp.client_id));
            app.showToast('You can’t message this person');
            return true;
        }
        if (error && /row-level security/i.test(error.message || '')) {
            s.threads[temp.recipient] = (s.threads[temp.recipient] || []).filter(m => m !== temp);
            content.querySelector(`[data-msg="${temp.id}"]`)?.remove();
            writeOutbox(readOutbox().filter(x => x.client_id !== temp.client_id));
            app.showToast('Your account can’t send messages right now');
            return true;
        }
        if (error || !data) {
            temp.pending = false;
            temp.failed = true;
            repaintMessage(temp.id);
            updateConvoRow(temp.recipient);
            return false;
        }
        writeOutbox(readOutbox().filter(x => x.client_id !== temp.client_id));
        const list = s.threads[temp.recipient] || [];
        const i = list.findIndex(x => x.id === temp.id || x.client_id === temp.client_id);
        if (i > -1) list[i] = data;
        if (s.last[temp.recipient] && (s.last[temp.recipient].id === temp.id)) s.last[temp.recipient] = data;
        const el = content.querySelector(`[data-msg="${temp.id}"]`);
        if (el) {
            el.outerHTML = messageHTML(data, list[i - 1] || null, true);
            hydrateStorage($('chat-thread'));
        }
        updateConvoRow(temp.recipient);
        return true;
    }

    // Anything left in the outbox (from a reload or a network drop) is shown and sent again
    function mergeOutbox(friendId) {
        const list = s.threads[friendId];
        if (!list) return;
        readOutbox().filter(x => x.recipient === friendId && !list.some(m => m.client_id === x.client_id))
            .forEach(x => list.push({ ...x, sender: s.profile.id, attachments: [], reactions: {}, failed: !navigator.onLine, pending: navigator.onLine }));
    }
    let flushing = false;
    async function flushOutbox() {
        if (flushing || !signedIn() || !navigator.onLine) return;
        flushing = true;
        try {
            for (const x of readOutbox()) {
                const thread = s.threads[x.recipient];
                const temp = (thread && thread.find(m => m.client_id === x.client_id)) || { ...x, sender: s.profile.id, attachments: [], reactions: {} };
                await sendQueued(temp);
            }
        } finally {
            flushing = false;
        }
    }
    window.addEventListener('online', () => setTimeout(flushOutbox, 800));

    // ---------- Unread divider ----------
    // Opening a chat with unread messages starts at the first one, under an "unread" line
    function unreadDividerBefore(thread) {
        const mark = s.unreadMark;
        if (!mark || mark.friendId !== s.activeFriend || !mark.count) return null;
        let left = mark.count;
        for (let i = thread.length - 1; i >= 0; i--) {
            if (thread[i].sender !== s.profile.id) {
                left--;
                if (left === 0) return thread[i].id;
            }
        }
        return thread.length ? thread.find(m => m.sender !== s.profile.id)?.id : null;
    }

    // ---------- Message links ----------
    function messageLink(friendId, id) {
        return `${location.origin}${location.pathname}#/messages/chat/${encodeURIComponent(friendId)}/m/${encodeURIComponent(id)}`;
    }

    // Show a specific message: from a link, search or the media gallery — loading older messages if needed
    async function jumpToMessage(friendId, id, at) {
        if (s.activeFriend !== friendId) {
            if (app.state.view !== 'messages') app.setView('messages');
            openChat(friendId);
        }
        const find = () => (s.threads[friendId] || []).some(m => String(m.id) === String(id));
        for (let tries = 0; tries < 20 && !s.threads[friendId]; tries++) await new Promise(r => setTimeout(r, 150));
        if (!find()) {
            const me = s.profile.id;
            let q = client.from('diary_messages').select('*')
                .or(`and(sender.eq.${me},recipient.eq.${friendId}),and(sender.eq.${friendId},recipient.eq.${me})`);
            q = at ? q.gte('created_at', at) : q.gte('id', Number(id));
            const { data } = await q.order('created_at', { ascending: true }).limit(600);
            if (data && data.length) {
                const known = new Set(data.map(m => m.id));
                s.threads[friendId] = [...data, ...(s.threads[friendId] || []).filter(m => !known.has(m.id) && Date.parse(m.created_at) > Date.parse(data[data.length - 1].created_at))];
                app.render();
            }
        }
        setTimeout(() => {
            if (find()) jumpTo(id);
            else app.showToast('That message isn’t available any more');
        }, 120);
    }

    // ---------- Typing indicator (a private channel just for the two of you) ----------
    function ensureTyping() {
        const want = app.state.view === 'messages' && signedIn() && s.activeFriend ? s.activeFriend : null;
        if (s.typing && s.typing.friendId === want) return;
        if (s.typing) {
            client.removeChannel(s.typing.channel);
            s.typing = null;
        }
        hideTyping();
        if (!want) return;
        const topic = `diary_dm:${[s.profile.id, want].sort().join(':')}`;
        const channel = client.channel(topic, { config: { private: true, broadcast: { self: false } } })
            .on('broadcast', { event: 'typing' }, ({ payload }) => {
                if (!payload || payload.from !== want) return;
                if (payload.stop) hideTyping();
                else showTyping(want);
            })
            .subscribe();
        s.typing = { friendId: want, channel, sentAt: 0 };
    }

    function sendTyping(stop = false) {
        if (!s.typing || incognitoOf(s.typing.friendId)) return;
        const now = Date.now();
        if (!stop && now - s.typing.sentAt < 2000) return;
        s.typing.sentAt = stop ? 0 : now;
        s.typing.channel.send({ type: 'broadcast', event: 'typing', payload: { from: s.profile.id, stop } });
    }

    let typingTimer = null;
    function showTyping(friendId) {
        s.typingFrom = friendId;
        clearTimeout(typingTimer);
        typingTimer = setTimeout(hideTyping, 4000);
        const status = content.querySelector(`.chat-head [data-status="${CSS.escape(friendId)}"]`);
        if (status) {
            status.textContent = 'typing…';
            status.classList.add('typing');
        }
        const thread = $('chat-thread');
        if (thread && !thread.querySelector('.typing-row')) {
            const nearBottom = thread.scrollHeight - thread.scrollTop - thread.clientHeight < 160;
            const friend = s.friends.find(f => f.id === friendId);
            thread.insertAdjacentHTML('beforeend', `<div class="typing-row">${friend ? avatar(friend, 'xs') : ''}<span class="typing-bubble" aria-label="typing"><i></i><i></i><i></i></span></div>`);
            if (nearBottom) thread.scrollTop = thread.scrollHeight;
        }
    }

    function hideTyping() {
        clearTimeout(typingTimer);
        const friendId = s.typingFrom;
        s.typingFrom = null;
        content.querySelectorAll('.typing-row').forEach(x => x.remove());
        if (!friendId) return;
        const status = content.querySelector(`.chat-head [data-status="${CSS.escape(friendId)}"]`);
        if (status) {
            status.classList.remove('typing');
            status.textContent = s.online.has(friendId) ? 'Active now' : status.dataset.away;
        }
    }

    // Refresh one conversation row without re-rendering the whole inbox (keeps the composer intact)
    function updateConvoRow(friendId) {
        const row = content.querySelector(`.convo-wrap[data-wrap="${CSS.escape(friendId)}"]`);
        const friend = s.friends.find(f => f.id === friendId);
        if (!row || !friend) return;
        row.outerHTML = convoRow(friend);
        const list = content.querySelector('.convo-list');
        const fresh = content.querySelector(`.convo-wrap[data-wrap="${CSS.escape(friendId)}"]`);
        if (list && fresh) list.prepend(fresh);
        paintPresence();
    }

    // ---------- Storage URLs ----------
    // Signed URLs for private storage; elements may name their bucket with data-bucket (chat by default)
    // Signing requests in flight, by "bucket:path" — overlapping calls wait for the same one. A fresh URL
    // for a video that's already loading would restart it (and cancel play()), so each file is signed once.
    const signing = new Map();

    async function hydrateStorage(root) {
        const els = [...root.querySelectorAll('[data-path]:not([data-hydrated])')];
        if (!els.length || !client) return;
        const now = Date.now();
        const key = el => `${el.dataset.bucket || BUCKET}:${el.dataset.path}`;
        const byBucket = new Map();
        els.forEach(el => {
            const k = key(el);
            if (s.urls.has(k) && s.urls.get(k).expires > now + 60000) return;
            if (signing.has(k)) return;
            const bucket = el.dataset.bucket || BUCKET;
            if (!byBucket.has(bucket)) byBucket.set(bucket, new Set());
            byBucket.get(bucket).add(el.dataset.path);
        });
        [...byBucket.entries()].forEach(([bucket, paths]) => {
            const request = client.storage.from(bucket).createSignedUrls([...paths], 3600).then(({ data }) => {
                (data || []).forEach(d => {
                    if (d.signedUrl) s.urls.set(`${bucket}:${d.path}`, { url: d.signedUrl, expires: now + 3600 * 1000 });
                });
            }).catch(() => {}).finally(() => paths.forEach(p => signing.delete(`${bucket}:${p}`)));
            paths.forEach(p => signing.set(`${bucket}:${p}`, request));
        });
        await Promise.all(els.map(el => signing.get(key(el))).filter(Boolean));
        els.forEach(el => {
            if (el.dataset.hydrated) return; // another call got there first
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
    const FEED_SELECT = `
        id, author, local_id, title, body, html, color, mood, photos, audio, written_at, shared_at, allow_reposts, audience,
        author_profile:diary_profiles!diary_shared_entries_author_fkey(username, display_name, avatar_path),
        likes:diary_entry_likes(user_id, emoji),
        comments:diary_comments(count),
        reposts:diary_reposts(user_id, created_at, profile:diary_profiles!diary_reposts_user_id_fkey(username, display_name))`;

    async function loadFeed() {
        if (s.feedLoading) return;
        s.feedLoading = true;
        const [feedRes, suggestRes, repostRes, hiddenRes, watchRes] = await Promise.all([
            client.from('diary_shared_entries').select(FEED_SELECT).order('shared_at', { ascending: false }).limit(100),
            client.rpc('diary_people_you_may_know', { p_limit: 12 }),
            client.from('diary_reposts').select('entry_id').order('created_at', { ascending: false }).limit(60),
            client.from('diary_hidden_posts').select('kind, item_id'),
            client.from('diary_post_watch').select('kind, item_id')
        ]);
        s.hidden = new Set((hiddenRes.data || []).map(r => `${r.kind}:${r.item_id}`));
        s.watching = new Set((watchRes.data || []).map(r => `${r.kind}:${r.item_id}`));
        let feed = feedRes.error ? [] : feedRes.data;
        // Older posts that friends reposted recently
        const have = new Set(feed.map(p => p.id));
        const missing = [...new Set((repostRes.data || []).map(r => r.entry_id))].filter(id => !have.has(id));
        if (missing.length) {
            const { data } = await client.from('diary_shared_entries').select(FEED_SELECT).in('id', missing.slice(0, 40));
            feed = feed.concat(data || []);
        }
        feed.forEach(decorateRepost);
        feed.sort((a, b) => b.sortAt - a.sortAt);
        s.feedLoading = false;
        s.feed = feed;
        s.suggestions = suggestRes.error ? [] : suggestRes.data;
        await loadSavedExtra();
        app.requestRender(['feed', 'explore']);
        loadPreviews(feed);
    }

    // The latest two comments on each post, fetched in one go and painted under the cards
    async function loadPreviews(feed) {
        const ids = feed.filter(p => commentCount(p) > 0).map(p => p.id).slice(0, 60);
        if (!ids.length) return;
        const { data, error } = await client.from('diary_comments')
            .select('id, body, audio_path, audio_duration, created_at, author, entry_id, author_profile:diary_profiles!diary_comments_author_fkey(username, display_name, avatar_path)')
            .in('entry_id', ids)
            .order('created_at', { ascending: false })
            .limit(240);
        if (error || !data) return;
        const grouped = new Map();
        data.forEach(c => {
            const list = grouped.get(c.entry_id) || [];
            if (list.length < 2) list.unshift(c);
            grouped.set(c.entry_id, list);
        });
        grouped.forEach((list, id) => {
            s.previews.set(`entry:${id}`, list);
            repaintComments(`entry:${id}`);
        });
    }

    // The newest repost by someone other than the author puts the post back at the top of the feed
    function decorateRepost(p) {
        p.reposts = p.reposts || [];
        const latest = p.reposts
            .slice()
            .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))[0];
        p.latestRepost = latest || null;
        p.sortAt = Math.max(Date.parse(p.shared_at), latest ? Date.parse(latest.created_at) : 0);
    }

    async function fetchEntry(id) {
        if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
        const { data } = await client.from('diary_shared_entries').select(FEED_SELECT).eq('id', id).maybeSingle();
        if (!data) return null;
        decorateRepost(data);
        s.singlePost = data;
        return data;
    }

    // #/post/<id> (a feed post) or #/post/g-<id> (a group post): open it over the right page
    const resolving = new Set();
    app.views.post = () => {
        const id = app.state.postId || '';
        if (!resolving.has(id)) {
            resolving.add(id);
            setTimeout(async () => {
                resolving.delete(id);
                if (!signedIn()) return app.setView('feed', {}, { replace: true });
                if (id.startsWith('g-')) {
                    const pid = id.slice(2);
                    const { data } = await client.from('diary_community_posts').select('community_id').eq('id', pid).maybeSingle();
                    if (!data) { app.setView('communities', {}, { replace: true }); return app.showToast('That post isn’t available — you may need to join the group'); }
                    app.setView('community', { communityId: data.community_id }, { replace: true });
                    setTimeout(() => focusPost(`post:${pid}`, { open: true }), 900);
                } else {
                    app.setView('feed', {}, { replace: true });
                    window.diarySocial.internals.openEntry(id);
                }
            }, 0);
        }
        return '<div class="social"><section class="social-main"><div class="post-skel"><span class="sk-row"><i class="sk-av"></i><i class="sk-line w40"></i></span><i class="sk-line"></i><i class="sk-line w70"></i><i class="sk-media"></i></div></section></div>';
    };

    // ---------- Verified accounts ----------
    // A short list, fetched once per sign-in; the tick is drawn next to names everywhere
    const VERIFIED_LABEL = { person: 'Verified public figure', organisation: 'Verified organisation', minister: 'Verified minister', educator: 'Verified educator', administrator: 'Verified administrator' };
    s.verified = new Map();
    async function loadVerified() {
        const { data } = await client.rpc('diary_verified_list');
        s.verified = new Map((data || []).map(r => [r.id, r.verified]));
        if (s.verified.size) app.requestRender && app.requestRender();
    }
    function tick(id, kind) {
        const k = kind || (s.verified && s.verified.get(id));
        return k ? `<svg class="i vtick" role="img" aria-label="${VERIFIED_LABEL[k] || 'Verified'}"><title>${VERIFIED_LABEL[k] || 'Verified'}</title><use href="#i-verified"/></svg>` : '';
    }

    // ---------- Announcements from the Cordial team ----------
    const ann = { list: null, loading: false };
    async function loadAnnouncements() {
        if (ann.loading || !signedIn()) return;
        ann.loading = true;
        const { data } = await client.from('diary_announcements').select('id, title, body, link, created_at, expires_at, active').order('created_at', { ascending: false }).limit(5);
        ann.loading = false;
        ann.list = (data || []).filter(a => a.active && (!a.expires_at || Date.parse(a.expires_at) > Date.now()));
        if (ann.list.length) app.requestRender(['feed', 'home']);
    }
    function announcementHTML() {
        if (!signedIn()) return '';
        if (ann.list === null) { loadAnnouncements(); return ''; }
        const hidden = load('diaryHiddenAnnouncements', []);
        const a = ann.list.find(x => !hidden.includes(x.id));
        if (!a) return '';
        const href = a.link && (/^#\//.test(a.link) || /^https?:\/\//i.test(a.link)) ? a.link : '';
        return `
            <aside class="announce" role="status" aria-label="Announcement">
                <span class="announce-ic"><svg class="i"><use href="#i-sparkle"/></svg></span>
                <span class="announce-text"><strong>${esc(a.title)}</strong>${a.body ? `<small>${esc(a.body)}</small>` : ''}</span>
                ${href ? `<a class="chip accent" href="${esc(href)}"${href.startsWith('#') ? '' : ' target="_blank" rel="noopener noreferrer"'}>Open</a>` : ''}
                <button type="button" class="icon-btn ghost" data-action="announce-hide" data-id="${esc(a.id)}" aria-label="Dismiss announcement"><svg class="i"><use href="#i-close"/></svg></button>
            </aside>`;
    }
    window.diaryAnnounce = { html: announcementHTML, refresh: () => { ann.list = null; app.render(); } };

    // ---------- Following ----------
    // A one-way follow (no approval needed): followers get told when you go live and can watch, like friends.
    async function loadFollows() {
        const me = s.profile.id;
        loadVerified();
        const [mine, fans, hidden, watching] = await Promise.all([
            client.from('diary_follows').select('followee').eq('follower', me),
            client.from('diary_follows').select('follower', { count: 'exact', head: true }).eq('followee', me),
            client.from('diary_hidden_posts').select('kind, item_id'),
            client.from('diary_post_watch').select('kind, item_id')
        ]);
        // Posts you hid or follow (group pages need these before the feed ever loads)
        if (!hidden.error) s.hidden = new Set(hidden.data.map(r => `${r.kind}:${r.item_id}`));
        if (!watching.error) s.watching = new Set(watching.data.map(r => `${r.kind}:${r.item_id}`));
        s.following = new Set(mine.error ? [] : mine.data.map(r => r.followee));
        s.followerCount = fans.error ? 0 : fans.count || 0;
    }

    async function toggleFollow(id, name = 'them') {
        if (!signedIn() || id === s.profile.id) return;
        const on = s.following.has(id);
        if (on) s.following.delete(id);
        else s.following.add(id);
        paintFollowButtons(id);
        const { error } = on
            ? await client.from('diary_follows').delete().eq('follower', s.profile.id).eq('followee', id)
            : await client.from('diary_follows').insert({ followee: id });
        if (error) {
            if (on) s.following.add(id);
            else s.following.delete(id);
            paintFollowButtons(id);
            return app.showToast('Couldn’t update that — please try again');
        }
        app.showToast(on ? `Unfollowed ${name}` : `Following ${name} — you’ll hear when they go live`);
    }

    function followButton(p, cls = 'chip') {
        if (!p || !p.id || !s.profile || p.id === s.profile.id || s.friends.some(f => f.id === p.id)) return '';
        const on = s.following.has(p.id);
        return `<button type="button" class="${cls} follow-btn" data-action="follow" data-id="${esc(p.id)}" data-name="${esc((p.display_name || '').split(' ')[0] || 'them')}" aria-pressed="${on}">${on ? 'Following' : 'Follow'}</button>`;
    }

    function paintFollowButtons(id) {
        const on = s.following.has(id);
        document.querySelectorAll(`.follow-btn[data-id="${CSS.escape(id)}"]`).forEach(b => {
            b.setAttribute('aria-pressed', String(on));
            b.textContent = on ? 'Following' : 'Follow';
        });
    }

    // ---------- Saved posts and reels (a private list on your account) ----------
    async function loadSaved() {
        const { data, error } = await client.from('diary_saved_items').select('kind, item_id');
        if (error) return;
        s.saved = new Set(data.filter(r => r.kind === 'entry').map(r => r.item_id));
        s.savedReels = new Set(data.filter(r => r.kind === 'reel').map(r => r.item_id));
        // Bring over bookmarks saved on this device before saving was synced
        const local = load('diarySavedPosts', []).filter(id => /^[0-9a-f-]{36}$/i.test(id) && !s.saved.has(id));
        if (local.length) {
            const { error: moveError } = await client.from('diary_saved_items')
                .upsert(local.map(id => ({ kind: 'entry', item_id: id })), { onConflict: 'user_id,kind,item_id', ignoreDuplicates: true });
            if (!moveError) local.forEach(id => s.saved.add(id));
        }
        try { localStorage.removeItem('diarySavedPosts'); } catch (e) {}
    }

    async function loadSavedExtra() {
        const have = new Set((s.feed || []).map(p => p.id));
        const missing = [...s.saved].filter(id => !have.has(id));
        if (!missing.length) {
            s.savedExtra = [];
            return;
        }
        const { data } = await client.from('diary_shared_entries').select(FEED_SELECT).in('id', missing.slice(0, 60));
        s.savedExtra = (data || []).map(p => (decorateRepost(p), p)).sort((a, b) => b.sortAt - a.sortAt);
    }

    async function toggleSaved(kind, id) {
        const set = kind === 'reel' ? s.savedReels : s.saved;
        const was = set.has(id);
        if (was) set.delete(id);
        else set.add(id);
        app.showToast(was ? 'Removed from Saved' : 'Saved — find it under Saved');
        // Reels repaint their own button so the video keeps playing
        if (kind !== 'reel') app.render();
        const { error } = was
            ? await client.from('diary_saved_items').delete().eq('kind', kind).eq('item_id', id)
            : await client.from('diary_saved_items').insert({ kind, item_id: id });
        if (error) {
            if (was) set.add(id);
            else set.delete(id);
            app.showToast('Couldn’t update Saved');
            if (kind !== 'reel') app.render();
        }
    }

    // ---------- More post options (shared with community.js) ----------
    const postLink = (kind, id) => `${location.origin}${location.pathname}#/post/${kind === 'post' ? 'g-' : ''}${encodeURIComponent(id)}`;

    async function copyText(text, done = 'Copied') {
        try {
            await navigator.clipboard.writeText(text);
            app.showToast(done);
        } catch (err) {
            app.ask({ title: 'Copy this link', text, ok: 'Done', cancel: null }).catch(() => {});
        }
    }

    async function sharePost(kind, post) {
        const url = postLink(kind, post.id);
        const title = post.title || `${(post.author_profile && post.author_profile.display_name) || 'A'} post on Cordial`;
        if (navigator.share) {
            try { await navigator.share({ title, url }); return; } catch (e) { if (e && e.name === 'AbortError') return; }
        }
        copyText(url, 'Link copied — paste it anywhere to share');
    }

    async function toggleWatch(kind, id) {
        const key = `${kind}:${id}`;
        const on = s.watching.has(key);
        if (on) s.watching.delete(key); else s.watching.add(key);
        const { error } = on
            ? await client.from('diary_post_watch').delete().eq('kind', kind).eq('item_id', id)
            : await client.from('diary_post_watch').insert({ kind, item_id: id });
        if (error) {
            if (on) s.watching.add(key); else s.watching.delete(key);
            return app.showToast('Couldn’t change notifications for this post');
        }
        app.showToast(on ? 'Notifications off for this post' : 'You’ll be notified about new comments on this post');
    }

    async function hidePost(kind, id, hide = true) {
        const key = `${kind}:${id}`;
        if (hide) s.hidden.add(key); else s.hidden.delete(key);
        if (s.detail === key) closePost();
        app.render();
        const { error } = hide
            ? await client.from('diary_hidden_posts').insert({ kind, item_id: id })
            : await client.from('diary_hidden_posts').delete().eq('kind', kind).eq('item_id', id);
        if (error && hide) {
            s.hidden.delete(key);
            app.render();
            return app.showToast('Couldn’t hide that post');
        }
        if (hide) app.showToast('Post hidden — you won’t see it in your feed', () => hidePost(kind, id, false));
    }

    // The extra menu items every post gets: copy link, share, follow the post, hide it, follow its author
    function postExtras(kind, post) {
        const mine = post.author === s.profile.id;
        const first = ((post.author_profile && post.author_profile.display_name) || 'them').split(' ')[0];
        const items = [
            { label: 'Copy link', icon: 'i-link', onClick: () => copyText(postLink(kind, post.id), 'Link copied') },
            { label: 'Share…', icon: 'i-share', onClick: () => sharePost(kind, post) },
            s.watching.has(`${kind}:${post.id}`)
                ? { label: 'Turn off notifications', icon: 'i-bell-off', onClick: () => toggleWatch(kind, post.id) }
                : { label: 'Turn on notifications', icon: 'i-bell', onClick: () => toggleWatch(kind, post.id) }
        ];
        if (!mine) {
            if (!s.friends.some(f => f.id === post.author)) {
                items.push(s.following.has(post.author)
                    ? { label: `Unfollow ${first}`, icon: 'i-user', onClick: () => toggleFollow(post.author, first) }
                    : { label: `Follow ${first}`, icon: 'i-user-plus', onClick: () => toggleFollow(post.author, first) });
            }
            items.push({ label: 'Hide post', icon: 'i-eye-off', onClick: () => hidePost(kind, post.id) });
        }
        items.push({ label: `View ${mine ? 'your' : `${first}’s`} profile`, icon: 'i-user', onClick: () => { closePost(); window.diaryProfile && window.diaryProfile.open(post.author); } });
        if (!mine && window.diarySafety && window.diarySafety.isAdmin()) {
            items.push({ label: 'Remove (admin)', icon: 'i-trash', danger: true, onClick: async () => {
                const r = await app.ask({ title: 'Remove this post for everyone?', text: 'It’s deleted and logged in the audit log. Add a reason (optional).', value: '', allowEmpty: true, ok: 'Remove', danger: true });
                if (!r) return;
                const { error } = await client.rpc('diary_admin_remove', { p_kind: kind, p_id: post.id, p_reason: (r.value || '').trim() });
                if (error) return app.showToast(error.message || 'Couldn’t remove it');
                closePost();
                if (kind === 'entry') s.feed = (s.feed || []).filter(p => p.id !== post.id);
                app.showToast('Removed');
                app.render();
            } });
        }
        return items;
    }

    async function setAudience(post, audience) {
        const { error } = await client.from('diary_shared_entries').update({ audience }).eq('id', post.id);
        if (error) return app.showToast('Couldn’t change who can see this');
        post.audience = audience;
        const local = app.getNotes().find(n => n.id === post.local_id);
        if (local) app.updateNote(local.id, { audience });
        app.showToast(audience === 'public' ? 'Everyone on Cordial can see this post now' : 'Only your friends can see this post now');
        app.render();
    }

    // ---------- Reposts ----------
    async function toggleRepost(entryId) {
        const post = postsFor('entry').find(p => p.id === entryId);
        if (!post) return;
        const me = s.profile.id;
        const mine = post.reposts.some(r => r.user_id === me);
        post.reposts = mine
            ? post.reposts.filter(r => r.user_id !== me)
            : [...post.reposts, { user_id: me, created_at: new Date().toISOString(), profile: { username: s.profile.username, display_name: s.profile.display_name } }];
        decorateRepost(post);
        app.render();
        const { error } = mine
            ? await client.from('diary_reposts').delete().eq('entry_id', entryId).eq('user_id', me)
            : await client.from('diary_reposts').insert({ entry_id: entryId });
        if (error) {
            app.showToast('Couldn’t update the repost');
            s.feed = null;
            app.render();
            return;
        }
        app.showToast(mine ? 'Repost removed' : 'Reposted — your friends will see it in their feed');
    }

    // Your own post: share it again so it comes back to the top of your friends' feeds
    async function reshareOwn(entryId) {
        const post = postsFor('entry').find(p => p.id === entryId);
        if (!post) return;
        const me = s.profile.id;
        const now = new Date().toISOString();
        post.reposts = [...post.reposts.filter(r => r.user_id !== me), { user_id: me, created_at: now, profile: { username: s.profile.username, display_name: s.profile.display_name } }];
        decorateRepost(post);
        app.render();
        await client.from('diary_reposts').delete().eq('entry_id', entryId).eq('user_id', me);
        const { error } = await client.from('diary_reposts').insert({ entry_id: entryId });
        if (error) {
            app.showToast('Couldn’t reshare your post');
            s.feed = null;
            app.render();
            return;
        }
        app.showToast('Reshared — it’s back at the top of your friends’ feeds');
    }

    function openShareOwn(anchor, post) {
        const reshared = post.reposts.some(r => r.user_id === s.profile.id);
        app.openPopover(anchor, [
            { label: reshared ? 'Reshare again' : 'Reshare to the feed', icon: 'i-repost', onClick: () => reshareOwn(post.id) },
            ...(reshared ? [{ label: 'Undo reshare', icon: 'i-undo', onClick: () => toggleRepost(post.id) }] : []),
            { label: 'Add to your story', icon: 'i-plus', onClick: () => window.diaryStories && window.diaryStories.shareEntry(post.local_id, post.title || post.body, post) }
        ]);
    }

    async function setAllowReposts(post, allow) {
        const { error } = await client.from('diary_shared_entries').update({ allow_reposts: allow }).eq('id', post.id);
        if (error) return app.showToast('Couldn’t change that setting');
        post.allow_reposts = allow;
        if (!allow) {
            post.reposts = [];
            decorateRepost(post);
        }
        app.showToast(allow ? 'Friends can repost this' : 'Reposts are off — existing reposts were removed');
        app.render();
    }

    // ---------- Reactions (Like is 👍) ----------
    // One reaction per person per post, on feed and group posts alike. Tap Like to like or take it back; press
    // and hold (or rest the mouse on it) to choose another reaction — picking your current one removes it.
    // Stories and group-chat messages keep their own emoji row (STORY_REACTIONS).
    const POST_REACTS = [['👍', 'Like'], ['❤️', 'Love'], ['😂', 'Funny'], ['🙏', 'Amen'], ['👏', 'Celebrate'], ['😮', 'Wow']];
    const REACT_NAME = Object.fromEntries(POST_REACTS);
    const STORY_REACTIONS = ['❤️', '😂', '😮', '😢', '🔥', '👏', '🙏', '😍'];
    const REACTION_NAMES = { '❤️': 'Love', '😂': 'Haha', '😮': 'Wow', '😢': 'Sad', '🔥': 'Fire', '👏': 'Clap', '🙏': 'Thanks', '😍': 'Adore', '👍': 'Like' };
    const POST_REACTIONS = STORY_REACTIONS; // stories.js and groupchat.js use this row

    const communityPost = id => (window.diaryCommunities ? window.diaryCommunities.posts().find(p => p.id === id) : null);
    const findPost = (kind, id) => (kind === 'post' ? communityPost(id)
        : postsFor('entry').find(p => p.id === id) || (s.profilePosts || []).find(p => p.id === id) || (s.singlePost && s.singlePost.id === id ? s.singlePost : null));
    const myReaction = likes => ((likes || []).find(l => l.user_id === s.profile.id) || {}).emoji || null;

    // "👍❤️😂 You, Ada and 12 others" — the most-used reactions first; tap to see everyone
    function reactSummaryHTML(kind, id, likes) {
        if (!likes || !likes.length) return '';
        const me = s.profile.id;
        const counts = new Map();
        likes.forEach(l => counts.set(l.emoji || '👍', (counts.get(l.emoji || '👍') || 0) + 1));
        const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([e]) => e);
        const mine = likes.some(l => l.user_id === me);
        const known = likes.map(l => l.user_id !== me && s.friends.find(f => f.id === l.user_id)).find(Boolean);
        const others = likes.length - (mine ? 1 : 0) - (known ? 1 : 0);
        const names = [mine ? 'You' : '', known ? esc(known.display_name.split(' ')[0]) : ''].filter(Boolean);
        const text = names.length
            ? `${names.join(names.length === 2 && !others ? ' and ' : ', ')}${others > 0 ? ` and ${others} ${others === 1 ? 'other' : 'others'}` : ''}`
            : `${likes.length}`;
        return `<button type="button" class="react-sum" data-action="reactors" data-kind="${kind}" data-id="${esc(id)}" aria-label="${likes.length} ${likes.length === 1 ? 'reaction' : 'reactions'} — see who reacted"><span class="react-sum-emojis" aria-hidden="true">${top.map(e => `<i>${e}</i>`).join('')}</span><span class="react-sum-text">${text}</span></button>`;
    }

    function likeButtonHTML(kind, id, likes) {
        const mine = myReaction(likes);
        const name = mine ? REACT_NAME[mine] || 'Like' : 'Like';
        return `<button class="act like-btn${mine ? ' reacted' : ''}" data-action="like" data-kind="${kind}" data-id="${esc(id)}" aria-pressed="${!!mine}" aria-label="${mine ? `You reacted ${name} — tap to remove, hold for other reactions` : 'Like — hold for more reactions'}" title="Hold for more reactions">${mine ? `<span class="like-emoji" aria-hidden="true">${mine}</span>` : '<svg class="i"><use href="#i-thumb"/></svg>'}<span class="act-label">${name}</span></button>`;
    }

    // Set, change or remove your reaction on a feed post ('entry') or group post ('post')
    async function setReaction(kind, id, emoji) {
        const post = findPost(kind, id);
        if (!post || !signedIn()) return;
        if (kind === 'post' && window.diaryCommunities && !window.diaryCommunities.isMember(post.community_id)) return app.showToast('Join the community to react');
        const me = s.profile.id;
        const before = (post.likes || []).map(l => ({ ...l }));
        const had = myReaction(before);
        const next = emoji && emoji !== had ? emoji : null;
        post.likes = [...before.filter(l => l.user_id !== me), ...(next ? [{ user_id: me, emoji: next }] : [])];
        if (navigator.vibrate) navigator.vibrate(8);
        repaintReactions(kind, id, post.likes, !!next && !had);
        const table = kind === 'entry' ? 'diary_entry_likes' : 'diary_community_likes';
        const col = kind === 'entry' ? 'entry_id' : 'post_id';
        const { error } = !next
            ? await client.from(table).delete().eq(col, id).eq('user_id', me)
            : had
                ? await client.from(table).update({ emoji: next }).eq(col, id).eq('user_id', me)
                : await client.from(table).insert(kind === 'entry' ? { entry_id: id, user_id: me, emoji: next } : { post_id: id, emoji: next });
        if (error) {
            post.likes = before;
            repaintReactions(kind, id, before);
            app.showToast('Couldn’t update your reaction');
        }
    }

    // Repaint just the Like button and the summary line wherever the post shows (its card and the open post)
    function repaintReactions(kind, id, likes, pop = false) {
        const key = `${kind}:${id}`;
        const o = s.rendered.get(key);
        if (o) o.likes = likes;
        const roots = [...document.querySelectorAll(`[data-post="${CSS.escape(key)}"]`)];
        if (s.detail === key && $('pv-shell')) roots.push($('pv-shell'));
        roots.forEach(root => {
            const btn = root.querySelector(`.like-btn[data-id="${CSS.escape(id)}"]`);
            if (btn) {
                btn.outerHTML = likeButtonHTML(kind, id, likes);
                if (pop) root.querySelector(`.like-btn[data-id="${CSS.escape(id)}"]`)?.classList.add('pop');
            }
            root.querySelectorAll('[data-react-sum]').forEach(sum => { sum.innerHTML = reactSummaryHTML(kind, id, likes); });
        });
    }

    function openReactionPicker(btn, opts = {}) {
        const { kind, id } = btn.dataset;
        const post = findPost(kind, id);
        const mine = post ? myReaction(post.likes) : null;
        emojiPicker(btn, emoji => setReaction(kind, id, emoji), { set: POST_REACTS, chosen: new Set(mine ? [mine] : []), ...opts });
    }

    // Everyone who reacted, with a tab per reaction
    async function openReactors(kind, id) {
        const dlg = document.createElement('dialog');
        dlg.className = 'sheet-dialog reactors-sheet';
        dlg.setAttribute('aria-label', 'Reactions');
        dlg.innerHTML = '<div class="rx-card"><header class="rx-head"><h2>Reactions</h2><button type="button" class="icon-btn" data-rx="close" aria-label="Close"><svg class="i"><use href="#i-close"/></svg></button></header><div class="rx-body"><span class="lv-spinner" aria-hidden="true"></span></div></div>';
        document.body.append(dlg);
        dlg.showModal();
        const close = () => { if (dlg.open) dlg.close(); };
        dlg.addEventListener('close', () => dlg.remove());
        let filter = 'all';
        let list = [];
        const paint = () => {
            const counts = new Map();
            list.forEach(r => counts.set(r.emoji, (counts.get(r.emoji) || 0) + 1));
            const shown = filter === 'all' ? list : list.filter(r => r.emoji === filter);
            dlg.querySelector('.rx-body').innerHTML = `
                <div class="rx-tabs" role="tablist" aria-label="Filter by reaction">
                    <button type="button" role="tab" data-rx="tab" data-f="all" aria-selected="${filter === 'all'}">All ${list.length}</button>
                    ${POST_REACTS.filter(([e]) => counts.has(e)).map(([e, n]) => `<button type="button" role="tab" data-rx="tab" data-f="${e}" aria-selected="${filter === e}" aria-label="${n}: ${counts.get(e)}">${e} ${counts.get(e)}</button>`).join('')}
                </div>
                <div class="rx-list">${shown.map(r => `
                    <div class="rx-row">
                        <button type="button" class="rx-who" data-profile="${esc(r.id)}" aria-label="${esc(r.display_name)}’s profile">${avatar(r, 'md')}<span class="rx-emoji" aria-hidden="true">${r.emoji}</span></button>
                        <button type="button" class="rx-name" data-profile="${esc(r.id)}"><strong>${esc(r.id === s.profile.id ? 'You' : r.display_name)}</strong><small>@${esc(r.username)} · ${esc(REACT_NAME[r.emoji] || '')}</small></button>
                        ${r.id === s.profile.id ? '' : followButton(r)}
                    </div>`).join('') || '<p class="muted small">No reactions yet.</p>'}</div>`;
            hydrateStorage(dlg);
        };
        dlg.addEventListener('click', e => {
            if (e.target.closest('[data-profile]')) return close(); // the profile opens underneath
            if (e.target === dlg) return close();
            const b = e.target.closest('[data-rx]');
            if (!b) return;
            if (b.dataset.rx === 'close') close();
            if (b.dataset.rx === 'tab') { filter = b.dataset.f; paint(); }
        }, true);
        dlg.addEventListener('click', e => {
            const f = e.target.closest('.follow-btn');
            if (f) toggleFollow(f.dataset.id, f.dataset.name);
        });
        const { data, error } = await client.rpc('diary_reactors', { p_kind: kind, p_id: id });
        if (!dlg.isConnected) return;
        if (error) { dlg.querySelector('.rx-body').innerHTML = '<p class="muted small">Couldn’t load reactions right now.</p>'; return; }
        list = data || [];
        paint();
    }

    // A floating row of emojis that grows out of the button that opened it. onPick(emoji) runs on tap.
    // opts.set: [[emoji, name], …] (default: the story / chat row); opts.chosen: emojis already picked;
    // opts.onClose: runs when it goes away; opts.noFocus: leave focus where it is (mouse hover).
    function emojiPicker(anchor, onPick, opts = {}) {
        document.querySelectorAll('.emoji-pop').forEach(p => p.remove());
        const pop = document.createElement('div');
        pop.className = `emoji-pop${opts.set ? ' labelled' : ''}`;
        pop.setAttribute('role', 'menu');
        pop.setAttribute('aria-label', 'Reactions');
        const chosen = opts.chosen || new Set();
        const set = opts.set || STORY_REACTIONS.map(e => [e, REACTION_NAMES[e]]);
        pop.innerHTML = set.map(([e, name], i) =>
            `<button type="button" role="menuitem" data-emoji="${e}" style="--i:${i}" class="${chosen.has(e) ? 'on' : ''}" aria-label="${name}${chosen.has(e) ? ' (yours — tap to remove)' : ''}" title="${name}">${e}${opts.set ? `<small>${name}</small>` : ''}</button>`).join('');
        const host = anchor.closest('dialog[open]') || document.body;
        host.append(pop);
        const r = anchor.getBoundingClientRect();
        const w = pop.offsetWidth;
        const h = pop.offsetHeight;
        const left = Math.max(8, Math.min(window.innerWidth - w - 8, r.left + r.width / 2 - w / 2));
        const above = r.top - h - 10 > 8;
        pop.style.left = `${left}px`;
        pop.style.top = `${above ? r.top - h - 10 : r.bottom + 10}px`;
        pop.style.transformOrigin = `${r.left + r.width / 2 - left}px ${above ? '100%' : '0%'}`;
        pop.classList.add(above ? 'above' : 'below');
        const close = () => {
            if (pop.classList.contains('closing')) return;
            pop.classList.add('closing');
            setTimeout(() => pop.remove(), 140);
            document.removeEventListener('pointerdown', outside, true);
            document.removeEventListener('keydown', key, true);
            window.removeEventListener('scroll', close, true);
            if (opts.onClose) opts.onClose();
        };
        const outside = e => { if (!pop.contains(e.target) && e.target !== anchor) close(); };
        const key = e => { if (e.key === 'Escape') { e.stopPropagation(); e.preventDefault(); close(); anchor.focus(); } };
        pop.addEventListener('click', e => {
            const b = e.target.closest('button[data-emoji]');
            if (!b) return;
            e.stopPropagation();
            onPick(b.dataset.emoji, b);
            close();
        });
        setTimeout(() => {
            document.addEventListener('pointerdown', outside, true);
            window.addEventListener('scroll', close, true);
        }, 0);
        document.addEventListener('keydown', key, true);
        if (!opts.noFocus) pop.querySelector('button')?.focus({ preventScroll: true });
        return close;
    }

    // Press and hold Like (or rest a mouse on it) for the reaction row; the tap that follows doesn't also like
    {
        let timer = null;
        let fired = false;
        let hoverTimer = null;
        const likeBtn = t => (t && t.closest ? t.closest('.like-btn[data-kind]') : null);
        document.addEventListener('pointerdown', e => {
            const btn = likeBtn(e.target);
            if (!btn) return;
            fired = false;
            clearTimeout(timer);
            clearTimeout(hoverTimer);
            timer = setTimeout(() => { fired = true; openReactionPicker(btn); }, 420);
        });
        const cancel = () => clearTimeout(timer);
        document.addEventListener('pointerup', cancel);
        document.addEventListener('pointercancel', cancel);
        document.addEventListener('contextmenu', e => { if (likeBtn(e.target)) e.preventDefault(); });
        document.addEventListener('click', e => {
            if (fired && likeBtn(e.target)) {
                e.stopPropagation();
                e.preventDefault();
                fired = false;
            }
        }, true);
        if (window.matchMedia('(hover: hover) and (pointer: fine)').matches) {
            document.addEventListener('pointerover', e => {
                const btn = likeBtn(e.target);
                if (!btn || e.pointerType !== 'mouse') return;
                clearTimeout(hoverTimer);
                hoverTimer = setTimeout(() => {
                    if (btn.isConnected && btn.matches(':hover') && !document.querySelector('.emoji-pop')) openReactionPicker(btn, { noFocus: true });
                }, 650);
            });
            document.addEventListener('pointerout', e => { if (likeBtn(e.target)) clearTimeout(hoverTimer); });
        }
    }

    // A plain tap: like (👍), or take back whatever reaction you left
    function toggleLike(kind, id) {
        const post = findPost(kind, id);
        if (!post) return;
        return setReaction(kind, id, myReaction(post.likes) || '👍');
    }

    // ---------- Sharing ----------
    async function loadRemoteIds() {
        const { data } = await client.from('diary_shared_entries').select('local_id, photos, audio').eq('author', s.profile.id);
        s.remoteIds = new Set((data || []).map(r => r.local_id));
        s.remotePhotos = new Map((data || []).map(r => [r.local_id, r.photos || []]));
        s.remoteAudio = new Map((data || []).filter(r => r.audio).map(r => [r.local_id, r.audio]));
    }

    // On sign-in, only posts that changed since they were last uploaded are sent again (re-uploading every
    // shared post each launch pinged every friend's app with live updates for nothing)
    const sharedSig = n => `${n.updatedAt || n.createdAt || ''}|${(n.attachments || []).map(a => a.id).join(',')}`;
    const sharedMemoKey = () => `diarySharedSig:${s.profile.id}`;
    function syncAllShared() {
        const memo = load(sharedMemoKey(), {});
        app.getNotes()
            .filter(n => n.shared && !n.private && !n.trashedAt)
            .filter(n => !(s.remoteIds.has(n.id) && memo[n.id] === sharedSig(n)))
            .forEach(n => queue(() => upsertShared(n)));
    }

    // Upload new entry photos to the friends-only bucket and drop ones that were removed
    // Upload one picture as raw bytes (never FormData — iPhone WebKit sends those empty).
    // Big or unusual formats (e.g. HEIC) are converted to JPEG first. Returns the stored path or null.
    async function uploadImage(bucket, pathWithoutExt, source) {
        let blob = source;
        try {
            blob = await Media.compressImage(source instanceof File ? source : new File([source], 'photo', { type: source.type }));
        } catch (e) { /* upload the original */ }
        const data = await Media.bytes(blob);
        if (!data || !FEED_TYPES.includes(data.type)) return null;
        const path = `${pathWithoutExt}${extFor(data.type)}`;
        const { error } = await client.storage.from(bucket).upload(path, data.buf, { contentType: data.type, upsert: false });
        if (error && !/exist|duplicate/i.test(error.message)) {
            console.warn('Photo upload failed', path, error.message);
            return null;
        }
        return path;
    }

    async function syncPhotos(note) {
        const me = s.profile.id;
        // The chosen cover goes first so it leads the post
        const images = note.attachments
            .filter(a => a.kind === 'image' || a.kind === 'drawing')
            .sort((x, y) => (y.id === note.cover) - (x.id === note.cover))
            .slice(0, 10);
        const previous = s.remotePhotos.get(note.id) || [];
        const photos = [];
        for (const img of images) {
            const existing = previous.find(p => p.id === img.id);
            if (existing) {
                photos.push(existing);
                continue;
            }
            // Photos just picked in the feed composer are still in memory — skip the device-storage round trip
            const source = freshFiles.get(img.id) || await Media.get(img.id);
            if (!source) continue;
            const path = await uploadImage(FEED_BUCKET, `${me}/${note.id}/${img.id}`, source);
            if (path) photos.push({ id: img.id, path, name: String(img.name || '').slice(0, 120) });
        }
        images.forEach(img => freshFiles.delete(img.id));
        const stale = previous.filter(p => !photos.some(x => x.id === p.id)).map(p => p.path);
        if (stale.length) await client.storage.from(FEED_BUCKET).remove(stale);
        return photos;
    }

    // ---------- Audio on posts and stories ----------
    const POST_AUDIO = 'diary-post-audio';
    const AUDIO_ACCEPT = 'audio/*,.mp3,.m4a,.aac,.wav,.ogg,.webm,.flac';
    const MAX_POST_AUDIO = 20 * 1048576;

    function audioExt(type) {
        return { 'audio/mpeg': 'mp3', 'audio/mp4': 'm4a', 'audio/x-m4a': 'm4a', 'audio/aac': 'aac', 'audio/wav': 'wav', 'audio/ogg': 'ogg', 'audio/flac': 'flac' }[type] || 'webm';
    }

    // How long a picked audio file is (the browser reads just the header)
    function audioDuration(file) {
        return new Promise(resolve => {
            const a = document.createElement('audio');
            const url = URL.createObjectURL(file);
            const done = d => { URL.revokeObjectURL(url); resolve(Number.isFinite(d) && d > 0 ? d : 0); };
            a.preload = 'metadata';
            a.onloadedmetadata = () => done(a.duration);
            a.onerror = () => done(0);
            setTimeout(() => done(a.duration), 4000);
            a.src = url;
        });
    }

    // Record something or choose a song / audio file. Resolves { file, duration, name } or null.
    function pickAudio(anchor) {
        return new Promise(resolve => {
            let picked = false;
            app.openPopover(anchor, [
                { label: 'Record audio', icon: 'i-mic', onClick: async () => {
                    picked = true;
                    const rec = await Media.recordVoice();
                    if (!rec) return resolve(null);
                    if (rec.error) { app.showToast(rec.error); return resolve(null); }
                    const file = new File([rec.blob], `Recording.${audioExt(rec.type)}`, { type: rec.type });
                    resolve({ file, duration: Math.max(1, Math.round(rec.duration)), name: 'Recording' });
                } },
                { label: 'Choose a song or audio file', icon: 'i-music', onClick: async () => {
                    picked = true;
                    const [file] = await Media.pickFiles(AUDIO_ACCEPT, false);
                    if (!file) return resolve(null);
                    const type = (file.type || '').split(';')[0] || 'audio/mpeg';
                    if (!type.startsWith('audio/')) { app.showToast('Pick an audio file (MP3, M4A, WAV…)'); return resolve(null); }
                    if (file.size > MAX_POST_AUDIO) { app.showToast('That audio is over 20 MB — try a shorter clip'); return resolve(null); }
                    const duration = Math.round(await audioDuration(file));
                    if (duration > 600) { app.showToast('Audio can be up to 10 minutes'); return resolve(null); }
                    resolve({ file, duration: duration || 1, name: String(file.name || 'Audio').replace(/\.[a-z0-9]+$/i, '').slice(0, 80) });
                } }
            ]);
            // Closing the menu without choosing
            setTimeout(() => {
                const check = () => {
                    if (picked) return;
                    if (document.getElementById('popover').hidden) resolve(null);
                    else setTimeout(check, 300);
                };
                check();
            }, 300);
        });
    }

    async function uploadAudio(folder, file) {
        const type = (file.type || 'audio/webm').split(';')[0];
        const path = `${s.profile.id}/${folder}/${randomId()}.${audioExt(type)}`;
        const { error } = await client.storage.from(POST_AUDIO).upload(path, await file.arrayBuffer(), { contentType: type, upsert: false });
        return error ? null : path;
    }

    // The note's first audio attachment rides along with the post
    async function syncAudio(note) {
        const clip = (note.attachments || []).find(a => a.kind === 'audio');
        const previous = s.remoteAudio.get(note.id) || null;
        if (!clip) {
            if (previous) client.storage.from(POST_AUDIO).remove([previous.path]);
            return null;
        }
        if (previous && previous.id === clip.id) return previous;
        const source = freshFiles.get(clip.id) || await Media.get(clip.id);
        if (!source) return previous;
        const file = source instanceof File ? source : new File([source], clip.name || 'audio', { type: clip.type || source.type || 'audio/webm' });
        const path = await uploadAudio(note.id, file);
        freshFiles.delete(clip.id);
        if (!path) return previous;
        if (previous) client.storage.from(POST_AUDIO).remove([previous.path]);
        return { id: clip.id, path, name: String(clip.name || 'Audio').replace(/\.[a-z0-9]+$/i, '').slice(0, 80), duration: Math.round(clip.duration || 0) || null };
    }

    function audioCardHTML(audio) {
        if (!audio || !audio.path) return '';
        return `
            <div class="post-audio">
                <span class="pa-art" aria-hidden="true"><svg class="i"><use href="#i-music"/></svg></span>
                <div class="pa-main">
                    <strong class="pa-name">${esc(audio.name || 'Audio')}</strong>
                    ${voiceHTML({ path: audio.path, duration: audio.duration || 0 }, POST_AUDIO)}
                </div>
            </div>`;
    }

    async function upsertShared(note) {
        let html = Rich.sanitize(note.html || '');
        if (html.length > 60000) html = Rich.textToHTML(note.text.slice(0, 20000));
        const photos = await syncPhotos(note);
        s.remotePhotos.set(note.id, photos);
        const audio = await syncAudio(note);
        if (audio) s.remoteAudio.set(note.id, audio);
        else s.remoteAudio.delete(note.id);
        const { error } = await client.from('diary_shared_entries').upsert({
            audio,
            photos,
            author: s.profile.id,
            local_id: note.id,
            title: note.title.slice(0, 200),
            body: note.text.slice(0, 20000),
            html,
            color: note.color,
            mood: note.mood,
            audience: note.audience === 'public' ? 'public' : 'friends',
            written_at: new Date(note.createdAt).toISOString(),
            updated_at: new Date().toISOString()
        }, { onConflict: 'author,local_id' });
        if (error) {
            app.showToast('Could not share that entry');
            return { ok: false, photos: 0 };
        }
        s.remoteIds.add(note.id);
        s.feed = null;
        try {
            const memo = load(sharedMemoKey(), {});
            memo[note.id] = sharedSig(note);
            localStorage.setItem(sharedMemoKey(), JSON.stringify(memo));
        } catch (e) {}
        return { ok: true, photos: photos.length };
    }

    async function removeShared(note) {
        const { error } = await client.from('diary_shared_entries')
            .delete().eq('author', s.profile.id).eq('local_id', note.id);
        if (error) return app.showToast('Could not unshare that entry');
        const photos = (s.remotePhotos.get(note.id) || []).map(p => p.path);
        if (photos.length) await client.storage.from(FEED_BUCKET).remove(photos);
        s.remotePhotos.delete(note.id);
        const audio = s.remoteAudio.get(note.id);
        if (audio) client.storage.from(POST_AUDIO).remove([audio.path]);
        s.remoteAudio.delete(note.id);
        s.remoteIds.delete(note.id);
        s.feed = null;
    }

    // ---------- Views ----------
    function gate(pitch) {
        // No connection: say so plainly (rather than asking a signed-in person to sign in again)
        if (!navigator.onLine) {
            return `<div class="empty offline-empty">
                <svg class="i"><use href="#i-wifi-off"/></svg>
                <p class="empty-title">You’re offline</p>
                <p>This page needs an internet connection. Your notes, templates, calendar and highlights all still work — anything you write is saved on this phone.</p>
                <button class="primary-btn" style="margin-top:18px" data-action="go-notes">Go to my notes</button>
            </div>`;
        }
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
            return `<div class="social"><section class="social-main">${'<div class="post-skel"><span class="sk-row"><i class="sk-av"></i><i class="sk-line w40"></i></span><i class="sk-line"></i><i class="sk-line w70"></i><i class="sk-media"></i></div>'.repeat(3)}</section></div>`;
        }

        const me = s.profile.id;
        const mine = s.feed.filter(p => p.author === me);
        const likesReceived = mine.reduce((sum, p) => sum + p.likes.length, 0);

        let list = s.feed.filter(p => !s.hidden.has(`entry:${p.id}`));
        let filterLabel = '';
        if (s.feedAuthor) {
            list = list.filter(p => p.author === s.feedAuthor);
            const f = s.friends.find(x => x.id === s.feedAuthor);
            filterLabel = `${f ? f.display_name : 'Their'}’s posts`;
        } else if (s.feedFilter === 'mine') {
            list = mine;
            filterLabel = 'Your posts';
        } else if (s.feedFilter === 'saved') {
            list = [...list, ...s.savedExtra].filter(p => s.saved.has(p.id));
            filterLabel = 'Saved';
        } else if (s.feedFilter.startsWith('tag:')) {
            const tag = s.feedFilter.slice(4);
            list = list.filter(p => hashtags(p).includes(tag));
            filterLabel = `#${tag}`;
        }
        if (s.feedFilter === 'all' && !s.feedAuthor && s.feedSort === 'following') list = list.filter(inNetwork);

        const navItem = (filter, icon, label) => `
            <button class="social-nav-item${!s.feedAuthor && s.feedFilter === filter ? ' active' : ''}" data-action="feed-filter" data-filter="${filter}">
                <svg class="i"><use href="#${icon}"/></svg>${label}</button>`;

        const online = s.friends.filter(f => s.online.has(f.id));

        return `
            <div class="social">
                <aside class="social-left">
                    <div class="profile-card">
                        <button class="profile-photo" data-action="change-avatar" aria-label="Change profile photo">
                            ${avatar(s.profile, 'xl')}
                            <span class="photo-badge" aria-hidden="true"><svg class="i"><use href="#i-camera"/></svg></span>
                        </button>
                        <strong>${esc(s.profile.display_name)}</strong>
                        <small>@${esc(s.profile.username)}</small>
                        <div class="profile-stats">
                            <div><b>${mine.length}</b><span>Posts</span></div>
                            <div><b>${s.friends.length}</b><span>Friends</span></div>
                            <div><b>${likesReceived}</b><span>Reactions</span></div>
                        </div>
                        <button type="button" class="link-btn accent" data-profile="${esc(s.profile.id)}">View your profile</button>
                    </div>
                    <nav class="social-nav" aria-label="Feed">
                        ${navItem('all', 'i-home', 'Feed')}
                        ${navItem('mine', 'i-user', 'My posts')}
                        ${navItem('saved', 'i-bookmark', 'Saved')}
                        ${window.diarySchedule ? `<button class="social-nav-item" data-action="go-scheduled"><svg class="i"><use href="#i-clock"/></svg>Scheduled<span class="count-dot" data-sched-count${window.diarySchedule.count() ? '' : ' hidden'}>${window.diarySchedule.count() || ''}</span></button>` : ''}
                        <button class="social-nav-item" data-action="go-reels"><svg class="i"><use href="#i-reel"/></svg>Reels</button>
                        <button class="social-nav-item" data-action="go-library"><svg class="i"><use href="#i-book"/></svg>Library</button>
                        <button class="social-nav-item" data-action="find-friends"><svg class="i"><use href="#i-send"/></svg>Direct</button>
                        <button class="social-nav-item" data-action="go-insights"><svg class="i"><use href="#i-chart"/></svg>Stats</button>
                    </nav>
                    <div class="contacts">
                        <h4>Contacts</h4>
                        ${s.friends.slice(0, 6).map(f => `
                            <div class="contact-row">
                                <button type="button" class="row-av" data-profile="${esc(f.id)}" aria-label="${esc(f.display_name)}’s profile">${avatar(f, 'md')}</button>
                                <span class="contact-name" data-profile="${esc(f.id)}" role="button" tabindex="0"><strong>${esc(f.display_name)}</strong><small>@${esc(f.username)}</small></span>
                                <button class="icon-btn ghost" data-action="message-friend" data-id="${esc(f.id)}" aria-label="Message ${esc(f.display_name)}"><svg class="i"><use href="#i-chat"/></svg></button>
                            </div>`).join('') || '<p class="muted small">Add friends to see them here.</p>'}
                        ${s.friends.length ? '<button class="link-btn center" data-action="find-friends">View all</button>' : ''}
                    </div>
                </aside>

                <section class="social-main">
                    ${announcementHTML()}
                    ${window.diaryStories ? window.diaryStories.strip() : ''}
                    ${window.diaryLive ? window.diaryLive.strip() : ''}
                    <button class="new-posts" data-action="feed-refresh"${s.feedStale ? '' : ' hidden'}><svg class="i"><use href="#i-refresh"/></svg>New posts</button>
                    <div class="feed-bar">
                        <div class="feed-tabs" role="tablist" aria-label="Show">
                            ${[['foryou', 'For you'], ['following', 'Following'], ['latest', 'Latest'], ['popular', 'Popular'], ['saved', 'Saved']].map(([k, l]) => {
                                const on = k === 'saved' ? s.feedFilter === 'saved' : (s.feedFilter === 'all' && !s.feedAuthor && s.feedSort === k);
                                return `<button class="feed-tab" role="tab" aria-selected="${on}" data-action="feed-tab" data-tab="${k}">${l}</button>`;
                            }).join('')}
                        </div>
                        <button class="icon-btn feed-search-btn" data-action="feed-search-toggle" aria-label="Search posts" aria-expanded="${!!s.feedSearchOpen}"><svg class="i"><use href="#i-search"/></svg></button>
                        <button class="chip reels-chip" data-action="go-reels"><svg class="i"><use href="#i-reel"/></svg><span>Reels</span></button>
                    </div>
                    <label class="search feed-search"${s.feedSearchOpen ? '' : ' hidden'}>
                        <svg class="i"><use href="#i-search"/></svg>
                        <input type="search" id="feed-search" placeholder="Search posts, people and #tags" aria-label="Search posts" enterkeyhint="search">
                    </label>

                    <form class="post-composer${s.feedDraft.text || s.feedDraft.photos.length ? ' open' : ''}" data-form="feed-post">
                        <div class="pc-row">
                            ${avatar(s.profile, 'md')}
                            <textarea id="feed-text" rows="1" maxlength="5000" placeholder="What’s new, ${esc(s.profile.display_name.split(' ')[0])}?" aria-label="Write a post"></textarea>
                            <button type="button" class="pc-quick live" data-action="live-start" aria-label="Go live"><svg class="i"><use href="#i-live"/></svg></button>
                            <button type="button" class="pc-quick" data-action="feed-add-photos" aria-label="Add photos"><svg class="i"><use href="#i-image"/></svg></button>
                        </div>
                        <div class="pc-photos" id="feed-photos" hidden></div>
                        <div class="pc-audio" id="feed-audio" hidden></div>
                        <div class="pc-foot">
                            <button type="button" class="pc-tool" data-action="feed-add-photos"><svg class="i"><use href="#i-image"/></svg>Photo</button>
                            <button type="button" class="pc-tool camera" data-action="feed-camera"><svg class="i"><use href="#i-camera"/></svg>Camera</button>
                            <button type="button" class="pc-tool audio" data-action="feed-audio" aria-haspopup="menu"><svg class="i"><use href="#i-music"/></svg>Audio</button>
                            <button type="button" class="pc-tool video" data-action="feed-video"><svg class="i"><use href="#i-reel"/></svg>Video</button>
                            <button type="button" class="pc-tool live" data-action="live-start"><svg class="i"><use href="#i-live"/></svg>Live</button>
                            <button type="button" class="pc-tool story-toggle" data-action="feed-story-toggle" aria-pressed="${s.feedStory}" title="Also add this post to your story"><span class="pc-story-ring" aria-hidden="true"></span>Story</button>
                            <button type="button" class="pc-audience" data-action="feed-audience" aria-haspopup="menu" title="Who can see this post — it’s also saved to your diary">${s.feedAudience === 'public'
                                ? '<svg class="i"><use href="#i-globe"/></svg>Everyone'
                                : '<svg class="i"><use href="#i-lock"/></svg>Friends'}<svg class="i caret"><use href="#i-down"/></svg></button>
                            ${window.diarySchedule ? '<button type="button" class="pc-schedule" data-action="feed-schedule" aria-label="Schedule for later" title="Schedule for later"><svg class="i"><use href="#i-clock"/></svg></button>' : ''}
                            <button type="submit" class="pc-post" id="feed-post-btn">${s.posting ? 'Posting…' : 'Post'}</button>
                        </div>
                    </form>

                    ${window.diaryPlay && s.feedFilter === 'all' && !s.feedAuthor && s.feedSort === 'foryou' ? window.diaryPlay.feedCard() : ''}
                    ${filterLabel && s.feedFilter !== 'saved' ? `<button class="chip filter-chip" data-action="feed-all"><svg class="i"><use href="#i-close"/></svg>${esc(filterLabel)} · show everything</button>` : ''}
                    <div class="feed-list">
                        ${feedItems(list).join('') || `<div class="empty">
                            <p class="empty-title">${filterLabel ? 'Nothing here yet' : 'No posts yet'}</p>
                            <p>${s.feedFilter === 'saved' ? 'Tap the bookmark on any post to save it here — only you can see what you save.' : 'Turn on <strong>Share with friends</strong> in an entry, or add friends to see theirs here.'}</p>
                        </div>`}
                    </div>
                    ${list.length > 2 ? `
                        <div class="feed-end">
                            <span class="fe-check" aria-hidden="true"><svg class="i"><use href="#i-check"/></svg></span>
                            <strong>You’re all caught up</strong>
                            <small>${filterLabel ? 'That’s everything here.' : 'You’ve seen every post from your friends lately.'}</small>
                            <button type="button" class="link-btn accent" data-action="feed-top">Back to top</button>
                        </div>` : ''}
                </section>

                <aside class="social-right">
                    <section class="side-box">
                        <h4>Requests ${s.incoming.length ? `<span class="count-dot">${s.incoming.length}</span>` : ''}</h4>
                        ${s.incoming.map(f => `
                            <div class="request-row">
                                <button type="button" class="row-av" data-profile="${esc(f.id)}" aria-label="${esc(f.display_name)}’s profile">${avatar(f, 'md')}</button>
                                <div>
                                    <p><button type="button" class="name-link" data-profile="${esc(f.id)}">${esc(f.display_name)}</button> wants to add you to friends</p>
                                    <div class="request-actions">
                                        <button class="link-btn accent" data-action="accept-request" data-id="${esc(f.friendshipId)}">Accept</button>
                                        <button class="link-btn" data-action="decline-request" data-id="${esc(f.friendshipId)}">Decline</button>
                                    </div>
                                </div>
                            </div>`).join('') || '<p class="muted small">No new requests.</p>'}
                    </section>
                    ${trendingTags().length ? `
                        <section class="side-box">
                            <h4>Trending in your circle</h4>
                            <div class="trend-tags">${trendingTags().map(([t, n]) => `<button class="trend-tag" data-action="feed-tag" data-tag="${esc(t)}"><span>#${esc(t)}</span><small>${n} ${n === 1 ? 'post' : 'posts'}</small></button>`).join('')}</div>
                        </section>` : ''}
                    ${window.diaryLibrary && window.diaryLibrary.latest(3).length ? `
                        <section class="side-box">
                            <h4>From the Library</h4>
                            ${window.diaryLibrary.latest(3).map(x => `
                                <button class="lib-mini" data-action="lib-open" data-id="${esc(x.id)}">
                                    ${window.diaryLibrary.cover(x)}
                                    <span><strong>${esc(x.title)}</strong><small>${esc((x.author_profile && x.author_profile.display_name) || 'Someone')}</small></span>
                                </button>`).join('')}
                            <button class="link-btn center" data-action="go-library">Browse the Library</button>
                        </section>` : ''}
                    <section class="side-box">
                        <h4>People you may know</h4>
                        ${s.suggestions.slice(0, 5).map(p => `
                            <div class="suggest-row">
                                <button type="button" class="row-av" data-profile="${esc(p.id)}" aria-label="${esc(p.display_name)}’s profile">${avatar(p, 'md')}</button>
                                <span class="contact-name" data-profile="${esc(p.id)}" role="button" tabindex="0"><strong>${esc(p.display_name)}</strong><small>${esc(p.reason || `@${p.username}`)}</small></span>
                                ${followButton(p, 'chip small')}
                                <button class="icon-btn ghost accent" data-action="suggest-add" data-username="${esc(p.username)}" aria-label="Add ${esc(p.display_name)} as a friend"><svg class="i"><use href="#i-user-plus"/></svg></button>
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
        box.closest('.post-composer')?.classList.toggle('open', photos.length > 0 || !!s.feedDraft.text || !!s.feedDraft.audio);
        box.innerHTML = photos.map(p => `
            <figure class="pc-thumb">
                <img src="${p.preview}" alt="">
                ${window.PhotoEditor && p.file.type !== 'image/gif' ? `<button type="button" class="pc-edit" data-action="feed-edit-photo" data-id="${p.id}" aria-label="Edit photo with filters"><svg class="i"><use href="#i-wand"/></svg>Edit</button>` : ''}
                <button type="button" class="att-remove" data-action="feed-remove-photo" data-id="${p.id}" aria-label="Remove photo"><svg class="i"><use href="#i-close"/></svg></button>
            </figure>`).join('');
        renderFeedAudio();
    }

    function renderFeedAudio() {
        const box = $('feed-audio');
        if (!box) return;
        const a = s.feedDraft.audio;
        box.hidden = !a;
        box.closest('.post-composer')?.classList.toggle('open', !!a || s.feedDraft.photos.length > 0 || !!s.feedDraft.text);
        box.innerHTML = a ? `
            <span class="pa-art small" aria-hidden="true"><svg class="i"><use href="#i-music"/></svg></span>
            <span class="pc-audio-text"><strong>${esc(a.name)}</strong><small>${Media.formatDuration(a.duration)} · plays with your post</small></span>
            <button type="button" class="pc-audio-play" data-action="feed-audio-play" aria-label="Play preview"><svg class="i"><use href="#i-play"/></svg></button>
            <audio preload="metadata" src="${a.preview}" hidden></audio>
            <button type="button" class="att-remove" data-action="feed-remove-audio" aria-label="Remove audio"><svg class="i"><use href="#i-close"/></svg></button>` : '';
    }

    async function postToFeed() {
        if (s.posting) return;
        const text = s.feedDraft.text.trim();
        const photos = s.feedDraft.photos;
        const audio = s.feedDraft.audio;
        if (!text && !photos.length && !audio) {
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
            const files = photos.map(p => p.file);
            if (audio) {
                audio.file.duration = audio.duration;
                files.push(audio.file);
            }
            const note = await app.createEntry({ text, shared: true, audience: s.feedAudience }, files);
            note.attachments.forEach((att, i) => { if (files[i]) freshFiles.set(att.id, files[i]); });
            if (audio) URL.revokeObjectURL(audio.preview);
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
            if (result.ok && s.feedStory && window.diaryStories) window.diaryStories.shareEntry(note.id, text);
            s.feedDraft = { text: '', photos: [], audio: null };
            s.feed = null;
            if (!result.ok) return; // upsertShared already explained; the entry is still saved in the diary
            if (result.photos < photos.length) app.showToast(`Posted, but ${photos.length - result.photos} photo(s) couldn’t upload`);
            else app.showToast(`${photos.length ? 'Posted with photos 📸' : 'Posted'} — ${s.feedAudience === 'public' ? 'everyone can see it' : 'your friends can see it'}`);
            checkBadges();
        } catch (err) {
            app.showToast('Couldn’t post that — please try again');
        } finally {
            s.posting = false;
            if (app.state.view === 'feed') app.render();
        }
    }

    // Posts and reels in one timeline (reels come from stories.js)
    function feedItems(list) {
        const reels = window.diaryStories
            ? window.diaryStories.feedReels({
                author: s.feedAuthor,
                mine: s.feedFilter === 'mine',
                saved: s.feedFilter === 'saved',
                skip: s.feedFilter.startsWith('tag:')
            })
            : [];
        const items = [
            ...list.map(p => ({ at: p.sortAt || Date.parse(p.shared_at), post: p, html: () => postCard(p) })),
            ...reels.map(r => ({ at: Date.parse(r.created_at), post: { ...r, sortAt: Date.parse(r.created_at), reposts: [] }, html: () => window.diaryStories.feedCard(r) }))
        ];
        const ranked = s.feedFilter === 'all' && !s.feedAuthor;
        if (ranked && s.feedSort === 'popular') {
            items.forEach(i => { i.score = popularScore(i.post); });
            items.sort((a, b) => b.score - a.score || b.at - a.at);
        } else if (ranked && s.feedSort === 'foryou') {
            const aff = affinity();
            items.forEach(i => { i.score = forYouScore(i.post, aff); });
            items.sort((a, b) => b.score - a.score || b.at - a.at);
        } else {
            items.sort((a, b) => b.at - a.at);
        }
        const html = items.map(item => item.html());
        if (ranked && s.feedSort === 'foryou' && html.length > 2) html.splice(3, 0, pymkStripHTML());
        return html;
    }

    // ---------- Feed ranking ----------
    // Popular: reactions, comments and reposts, favouring the last two weeks.
    // For you: the same, weighted by how close you are to the author (friends, people you follow, people whose
    // posts you react to) and by the #tags you engage with, and fading with age.
    const engagement = p => (p.likes || []).length + commentCount(p) * 2 + (p.reposts || []).length * 3;
    const ageDays = p => (Date.now() - (p.sortAt || Date.parse(p.shared_at || p.created_at))) / 864e5;
    const popularScore = p => (engagement(p) + 0.01) * (ageDays(p) < 14 ? 1 : 0.2);

    function affinity() {
        const me = s.profile.id;
        const people = new Map();
        const tags = new Map();
        (s.feed || []).forEach(p => {
            if (p.author === me) return;
            const engaged = (p.likes || []).some(l => l.user_id === me) || (p.reposts || []).some(r => r.user_id === me) || s.saved.has(p.id);
            if (!engaged) return;
            people.set(p.author, (people.get(p.author) || 0) + 1);
            hashtags(p).forEach(t => tags.set(t, (tags.get(t) || 0) + 1));
        });
        return { people, tags, friends: new Set(s.friends.map(f => f.id)) };
    }

    function forYouScore(p, aff) {
        const me = s.profile.id;
        let close = 0;
        if (p.author === me) close = 0.4;
        else if (aff.friends.has(p.author)) close = 3;
        else if (s.following.has(p.author)) close = 2.5;
        close += Math.min(3, (aff.people.get(p.author) || 0) * 0.75);
        if (p.latestRepost && aff.friends.has(p.latestRepost.user_id)) close += 1;
        const topical = hashtags(p).reduce((n, t) => n + Math.min(2, aff.tags.get(t) || 0), 0);
        return (1 + close + topical * 0.5) * (1 + Math.log1p(engagement(p))) / Math.pow(ageDays(p) * 24 + 2, 1.1);
    }

    // People you follow, your friends, and you (reposts by them count too)
    function inNetwork(p) {
        const me = s.profile.id;
        const near = id => id === me || s.following.has(id) || s.friends.some(f => f.id === id);
        return near(p.author) || (p.latestRepost && near(p.latestRepost.user_id));
    }

    // "People you may know" as a row of cards, dropped into the For you feed (phones don't have the side column)
    function pymkStripHTML() {
        const list = (s.suggestions || []).slice(0, 10);
        if (!list.length) return '';
        return `
            <section class="pymk-strip" aria-label="People you may know">
                <header><h3>People you may know</h3><button type="button" class="link-btn accent" data-action="find-people">See more</button></header>
                <div class="pymk-row">${list.map(p => `
                    <div class="pymk-card">
                        <button type="button" class="pymk-open" data-profile="${esc(p.id)}" aria-label="${esc(p.display_name)}’s profile">${avatar(p, 'lg')}<strong>${esc(p.display_name)}</strong><small>${esc(p.reason || `@${p.username}`)}</small></button>
                        ${followButton(p, 'chip accent') || `<button type="button" class="chip accent" data-action="suggest-add" data-username="${esc(p.username)}">Add friend</button>`}
                    </div>`).join('')}</div>
            </section>`;
    }

    // The most-used #tags in the loaded feed
    function trendingTags() {
        const counts = new Map();
        (s.feed || []).forEach(p => hashtags(p).forEach(t => counts.set(t, (counts.get(t) || 0) + 1)));
        return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6);
    }

    function hashtags(p) {
        const text = `${p.title || ''} ${p.body || ''}`;
        return [...new Set([...text.matchAll(/#([\p{L}\p{N}_]{2,30})/gu)].map(m => m[1].toLowerCase()))];
    }

    function postCard(p) {
        const me = s.profile.id;
        return renderPost({
            kind: 'entry',
            id: p.id,
            author: p.author,
            profile: p.author_profile,
            createdAt: p.shared_at,
            title: p.title,
            body: p.body,
            html: p.html,
            mood: p.mood,
            photos: p.photos,
            audio: p.audio,
            bucket: FEED_BUCKET,
            likes: p.likes,
            audience: p.audience,
            commentCount: commentCount(p),
            saved: s.saved.has(p.id),
            reposts: p.reposts || [],
            repostedById: p.latestRepost ? p.latestRepost.user_id : null,
            repostedBy: p.latestRepost
                ? (p.latestRepost.user_id === me ? 'You' : (p.latestRepost.profile && p.latestRepost.profile.display_name) || 'A friend')
                : '',
            canRepost: p.author !== me && p.allow_reposts !== false && s.friends.some(f => f.id === p.author),
            canShareOwn: p.author === me,
            reshared: !!(p.latestRepost && p.latestRepost.user_id === p.author),
            canComment: true,
            tags: hashtags(p),
            mine: p.author === me
        });
    }

    function commentCount(p) {
        return Array.isArray(p.comments) && p.comments[0] ? p.comments[0].count : 0;
    }

    // Instagram / Facebook style post, shared by the feed and communities.
    // o.kind: 'entry' (feed) | 'post' (community). Photo posts show media first, text posts lead with the text.
    // Tapping the card opens the post view (full post + every comment); the pieces below are shared by both.
    function postPhotos(o) {
        return (o.photos || []).filter(ph => ph && typeof ph.path === 'string');
    }

    function postPerson(o) {
        const profile = o.profile || { username: 'unknown', display_name: 'Someone' };
        return { profile, person: { id: o.author, display_name: profile.display_name, avatar_path: profile.avatar_path }, name: o.mine ? 'You' : esc(profile.display_name) };
    }

    function fullDate(iso) {
        const d = new Date(iso);
        return isNaN(d) ? '' : d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
    }

    function postMediaHTML(o, photos) {
        const key = `${o.kind}:${o.id}`;
        return `
            <div class="post-media" data-like-kind="${o.kind}" data-like-id="${esc(o.id)}">
                <div class="carousel" data-count="${photos.length}">
                    ${photos.map((ph, i) => `
                        <button type="button" class="slide" data-action="post-photo" data-key="${esc(key)}" data-bucket="${o.bucket}" data-img="${esc(ph.path)}" aria-label="Photo ${i + 1} of ${photos.length}">
                            <img data-path="${esc(ph.path)}" data-bucket="${o.bucket}" alt="" loading="lazy">
                        </button>`).join('')}
                </div>
                ${photos.length > 1 ? `
                    <span class="slide-count">1/${photos.length}</span>
                    <div class="dots">${photos.map((_, i) => `<span${i === 0 ? ' class="on"' : ''}></span>`).join('')}</div>` : ''}
                <span class="burst" aria-hidden="true"><svg class="i"><use href="#i-heart-fill"/></svg></span>
            </div>`;
    }

    // ---------- Hashtags ----------
    // Every #tag in a post, comment or caption is a link to all posts with that tag
    const TAG_RE = /(^|[^\p{L}\p{N}_&#])#([\p{L}\p{N}_]{2,30})/gu;
    const tagButton = t => `<button type="button" class="hashtag" data-action="ex-tag" data-tag="${esc(t.toLowerCase())}">#${esc(t)}</button>`;

    function linkTags(html) {
        if (!html || !html.includes('#')) return html;
        const tpl = document.createElement('template');
        tpl.innerHTML = html;
        const walker = document.createTreeWalker(tpl.content, NodeFilter.SHOW_TEXT);
        const hits = [];
        while (walker.nextNode()) {
            const node = walker.currentNode;
            if (node.parentElement && node.parentElement.closest('a, button, code, pre')) continue;
            if (/#[\p{L}\p{N}_]{2,}/u.test(node.nodeValue)) hits.push(node);
        }
        hits.forEach(node => {
            const span = document.createElement('span');
            span.innerHTML = esc(node.nodeValue).replace(TAG_RE, (m, pre, tag) => `${pre}${tagButton(tag)}`);
            node.replaceWith(...span.childNodes);
        });
        return tpl.innerHTML;
    }

    // While typing "#wo…" in a composer, offer tags people already use
    const STARTER_TAGS = ['today', 'grateful', 'weekend', 'goals', 'mood', 'throwback', 'family', 'faith', 'work', 'food', 'music', 'travel'];
    function suggestTags(textarea) {
        const form = textarea.closest('form');
        if (!form) return;
        let box = form.querySelector('.tag-suggest');
        const before = textarea.value.slice(0, textarea.selectionStart || 0);
        const m = before.match(/(?:^|\s)#([\p{L}\p{N}_]{0,30})$/u);
        if (!m) { if (box) box.hidden = true; return; }
        const typed = m[1].toLowerCase();
        const pool = [...new Set([...trendingTags().map(([t]) => t), ...STARTER_TAGS])];
        const picks = pool.filter(t => t.startsWith(typed) && t !== typed).slice(0, 6);
        if (!box) {
            box = document.createElement('div');
            box.className = 'tag-suggest';
            box.setAttribute('role', 'listbox');
            box.setAttribute('aria-label', 'Hashtag suggestions');
            (textarea.closest('.pc-row') || textarea).after(box);
        }
        box.hidden = !picks.length;
        box.innerHTML = picks.map(t => `<button type="button" role="option" data-action="tag-insert" data-tag="${esc(t)}">#${esc(t)}</button>`).join('');
    }

    function insertTag(button) {
        const form = button.closest('form');
        const textarea = form && form.querySelector('textarea');
        if (!textarea) return;
        const pos = textarea.selectionStart || textarea.value.length;
        const before = textarea.value.slice(0, pos).replace(/#([\p{L}\p{N}_]{0,30})$/u, `#${button.dataset.tag} `);
        textarea.value = before + textarea.value.slice(pos);
        textarea.focus();
        textarea.setSelectionRange(before.length, before.length);
        textarea.dispatchEvent(new Event('input', { bubbles: true }));
        const box = form.querySelector('.tag-suggest');
        if (box) box.hidden = true;
    }

    function postCaptionHTML(o, photos, full) {
        const { name } = postPerson(o);
        const body = linkTags(o.html ? Rich.sanitize(o.html) : esc(o.body || ''));
        const long = !full && ((o.body || '').length > 280 || (o.body || '').split('\n').length > 5);
        return `
            <div class="post-caption${photos.length && !full ? '' : ' text-only'}">
                ${photos.length && !full ? `<strong class="cap-name">${name}</strong> ` : ''}
                ${o.title ? `<strong class="cap-title">${esc(o.title)}</strong>` : ''}
                <div class="post-text rich-content${long ? ' clamped toggleable' : ''}"${long ? ' data-action="toggle-text" title="Tap to expand or collapse"' : ''}>${body}</div>
                ${long ? '<button class="read-more" data-action="expand-post">more</button>' : ''}
            </div>
`; // #tags are already links inside the text, so no second row of them
    }

    function postActionsHTML(o) {
        const me = s.profile.id;
        const { profile } = postPerson(o);
        const key = `${o.kind}:${o.id}`;
        return `
            ${likeButtonHTML(o.kind, o.id, o.likes)}
            <button class="act" data-action="post-open" data-key="${esc(key)}" data-focus="input" aria-label="Comment"><svg class="i"><use href="#i-chat"/></svg><span class="act-count">${o.commentCount || ''}</span></button>
            ${o.canRepost ? (() => {
                const on = o.reposts.some(r => r.user_id === me);
                return `<button class="act repost-btn" data-action="repost" data-id="${esc(o.id)}" aria-pressed="${on}" aria-label="${on ? 'Undo repost' : 'Repost to your friends'}"><svg class="i"><use href="#i-repost"/></svg><span class="act-count">${o.reposts.length || ''}</span></button>`;
            })() : ''}
            ${o.canShareOwn ? `<button class="act repost-btn" data-action="share-own" data-id="${esc(o.id)}" aria-haspopup="menu" aria-pressed="${o.reposts.some(r => r.user_id === me)}" aria-label="Share: reshare or add to your story"><svg class="i"><use href="#i-repost"/></svg><span class="act-count">${o.reposts.length || ''}</span></button>` : ''}
            ${o.mine || !s.friends.some(f => f.id === o.author) ? '' : `<button class="act" data-action="message-friend" data-id="${esc(o.author)}" aria-label="Message ${esc(profile.display_name)}"><svg class="i"><use href="#i-send"/></svg></button>`}
            ${o.kind === 'entry' ? `
                <button class="act save-btn" data-action="save-post" data-id="${esc(o.id)}" aria-pressed="${o.saved}" aria-label="${o.saved ? 'Remove from Saved' : 'Save post'}">
                    <svg class="i"><use href="#${o.saved ? 'i-bookmark-fill' : 'i-bookmark'}"/></svg>
                </button>` : ''}`;
    }

    function renderPost(o) {
        const photos = postPhotos(o);
        const { profile, person, name } = postPerson(o);
        const key = `${o.kind}:${o.id}`;
        s.rendered.set(key, o);
        if (s.detail === key) scheduleDetailRepaint();

        return `
            <article class="post ig" data-post="${key}" data-search="${esc(`${profile.display_name} ${profile.username} ${o.title || ''} ${o.body || ''}`.toLowerCase())}">
                ${o.pinned ? '<p class="repost-line pinned-line"><svg class="i"><use href="#i-pin-note"/></svg>Pinned by the admins</p>' : ''}
                ${o.repostedBy ? `<p class="repost-line"><svg class="i"><use href="#i-repost"/></svg>${o.repostedById ? `<button type="button" class="name-link" data-profile="${esc(o.repostedById)}">${esc(o.repostedBy)}</button>` : esc(o.repostedBy)} ${o.reshared ? 'reshared this' : 'reposted'}</p>` : ''}
                <header class="post-head">
                    <button type="button" class="post-av" data-profile="${esc(o.author)}" aria-label="${esc(profile.display_name)}’s profile">${avatar(person, 'md')}</button>
                    <div class="post-who">
                        <strong><button type="button" class="name-link" data-profile="${esc(o.author)}">${name}</button>${tick(o.author)}${o.badge ? ` <span class="post-badge">${o.badge}</span>` : ''}</strong>
                        <span class="muted">@${esc(profile.username)} · ${o.audience === 'public' ? '<svg class="i aud" aria-label="Everyone can see this"><use href="#i-globe"/></svg> · ' : ''}<button type="button" class="post-time" data-action="post-open" data-key="${esc(key)}" title="${esc(fullDate(o.createdAt))} — open post">${timeAgo(o.createdAt)}</button>${o.mood ? ` · ${MOOD_EMOJI[o.mood] || ''}` : ''}</span>
                    </div>
                    <button class="more-btn" data-action="post-menu" data-kind="${o.kind}" data-id="${esc(o.id)}" aria-label="Post options"><svg class="i"><use href="#i-more"/></svg></button>
                </header>
                ${photos.length ? postMediaHTML(o, photos) : postCaptionHTML(o, photos, false)}
                ${audioCardHTML(o.audio)}
                ${o.bodyExtra || ''}
                <div class="post-actions">${postActionsHTML(o)}</div>
                <div class="react-sum-row" data-react-sum>${reactSummaryHTML(o.kind, o.id, o.likes)}</div>
                ${photos.length ? postCaptionHTML(o, photos, false) : ''}
                ${o.extraHTML || ''}
                ${commentsBlock(o.kind, o.id, o.commentCount, o.canComment)}
            </article>`;
    }

    // ---------- Comments ----------
    // Threads are cached per post as "entry:<id>" / "post:<id>"; blocks re-render in place so typing isn't lost elsewhere.
    // mode 'card': the latest two comments + a quick reply under a feed card. mode 'full': the whole thread in the post view.
    function commentsBlock(kind, id, count, canComment, mode = 'card') {
        const key = `${kind}:${id}`;
        const thread = s.comments.get(key);
        const me = s.profile.id;
        const loaded = thread && thread.open && !thread.loading;
        const total = loaded ? thread.items.length : count;
        const who = c => `<button type="button" class="name-link" data-profile="${esc(c.author)}">${c.author === me ? 'You' : esc((c.author_profile && c.author_profile.display_name) || 'Someone')}</button>${tick(c.author)}`;

        if (mode === 'full' || mode === 'sheet') {
            const list = !loaded
                ? '<div class="pv-c-skel" aria-label="Loading comments"><i></i><i></i><i></i></div>'
                : thread.items.map(c => {
                    const author = c.author_profile || { display_name: 'Someone' };
                    const canDelete = c.author === me || thread.ownerId === me;
                    return `
                        <div class="comment full" data-comment="${esc(c.id)}">
                            <button type="button" class="c-av" data-profile="${esc(c.author)}" aria-label="${esc(author.display_name)}’s profile">${avatar({ id: c.author, display_name: author.display_name, avatar_path: author.avatar_path }, 'sm')}</button>
                            <div class="c-main">
                                <div class="c-bubble${c.audio_path ? ' has-voice' : ''}"><strong>${who(c)}</strong> ${c.body ? linkTags(esc(c.body)) : ''}
                                    ${c.audio_path ? voiceHTML({ path: c.audio_path, duration: c.audio_duration }, COMMENT_AUDIO) : ''}</div>
                                <span class="comment-meta">
                                    <time datetime="${esc(c.created_at)}" title="${esc(fullDate(c.created_at))}">${timeAgo(c.created_at)}</time>
                                    ${mode === 'full' && canComment && c.author !== me && author.username ? ` · <button type="button" class="link-btn" data-pv="reply" data-name="${esc(author.username)}">Reply</button>` : ''}
                                    ${canDelete ? ` · <button type="button" class="link-btn" data-action="comment-delete" data-key="${key}" data-id="${esc(c.id)}">Delete</button>` : ''}
                                </span>
                            </div>
                        </div>`;
                }).join('') || `<div class="pv-c-empty"><svg class="i"><use href="#i-chat"/></svg><strong>No comments yet</strong><span>${canComment ? 'Start the conversation.' : 'Nobody has commented yet.'}</span></div>`;
            return `
                <section class="comments full" data-comments="${key}" data-mode="${mode}" aria-label="Comments">
                    ${mode === 'full' ? `<h3 class="pv-c-head">Comments${total ? ` <span>${total}</span>` : ''}</h3>` : ''}
                    <div class="comment-list">${list}</div>
                    ${mode === 'sheet' && canComment ? `
                        <form class="comment-form" data-form="comment" data-key="${key}">
                            <input name="body" maxlength="2000" placeholder="Add a comment…" autocomplete="off" enterkeyhint="send" aria-label="Add a comment">
                            ${micButton()}
                            <button class="link-btn accent">Post</button>
                        </form>` : ''}
                </section>`;
        }

        const recent = loaded ? thread.items.slice(-2) : (s.previews.get(key) || []);
        return `
            <div class="comments" data-comments="${key}" data-mode="card">
                ${total ? `<button type="button" class="link-btn muted-link" data-action="post-open" data-key="${key}">View ${total === 1 ? '1 comment' : `all ${total} comments`}</button>` : ''}
                ${recent.length ? `<div class="comment-preview">${recent.map(c => `
                    <p class="cp-line" data-action="post-open" data-key="${key}"><strong>${who(c)}</strong> ${linkTags(esc(c.body))}${c.audio_path ? `<span class="cp-voice"><svg class="i"><use href="#i-mic"/></svg>Voice comment · ${Media.formatDuration(c.audio_duration || 0)}</span>` : ''}</p>`).join('')}</div>` : ''}
                ${canComment ? `
                    <form class="comment-form" data-form="comment" data-key="${key}">
                        <input name="body" maxlength="2000" placeholder="Add a comment…" autocomplete="off" enterkeyhint="send" aria-label="Add a comment">
                        ${micButton()}
                        <button class="link-btn accent">Post</button>
                    </form>` : ''}
            </div>`;
    }

    function commentTarget(key) {
        const [kind, id] = key.split(':');
        return { column: { entry: 'entry_id', post: 'post_id', reel: 'reel_id' }[kind], id };
    }

    function postsFor(kind) {
        if (kind === 'entry') return [...(s.feed || []), ...s.savedExtra];
        if (kind === 'reel') return window.diaryStories ? window.diaryStories.reels() : [];
        return window.diaryCommunities ? window.diaryCommunities.posts() : [];
    }

    // Whose post it is, so the owner can also delete comments on it
    function postOwner(key) {
        const [kind, id] = key.split(':');
        const post = postsFor(kind).find(p => p.id === id);
        return post ? post.author : null;
    }

    async function openComments(key) {
        const thread = { open: true, loading: true, items: [], ownerId: postOwner(key) };
        s.comments.set(key, thread);
        repaintComments(key);
        const target = commentTarget(key);
        const { data } = await client.from('diary_comments')
            .select('id, body, audio_path, audio_duration, created_at, author, author_profile:diary_profiles!diary_comments_author_fkey(username, display_name, avatar_path)')
            .eq(target.column, target.id)
            .order('created_at')
            .limit(200);
        thread.items = data || [];
        thread.loading = false;
        repaintComments(key);
    }

    async function addComment(key, body, extra = {}) {
        if (!addComment.checked) { addComment.checked = true; setTimeout(checkBadges, 2500); }
        const target = commentTarget(key);
        const { data, error } = await client.from('diary_comments')
            .insert({ [target.column]: target.id, body: body.slice(0, 2000), ...extra })
            .select('id, body, audio_path, audio_duration, created_at, author, author_profile:diary_profiles!diary_comments_author_fkey(username, display_name, avatar_path)')
            .single();
        if (error) {
            app.showToast(key.startsWith('post:') ? 'Join the community to comment' : 'Couldn’t post your comment');
            return false;
        }
        const thread = s.comments.get(key);
        if (thread && thread.open && !thread.loading) {
            if (!thread.items.some(c => c.id === data.id)) thread.items.push(data);
        } else {
            s.previews.set(key, [...(s.previews.get(key) || []), data].slice(-2));
        }
        bumpCommentCount(key, 1);
        repaintComments(key);
        return true;
    }

    // ---------- Voice comments ----------
    // Tap the mic in any comment box to record; tap Send (or wait for the 3-minute limit) to post it, ✕ to throw it away
    let vc = null; // the recording in progress: { key, form, recorder, chunks, stream, started, timer }

    function micButton() {
        if (!navigator.mediaDevices || !window.MediaRecorder) return '';
        return '<button type="button" class="vc-mic" data-action="comment-mic" aria-label="Record a voice comment" title="Voice comment"><svg class="i"><use href="#i-mic"/></svg></button>';
    }

    async function startVoiceComment(form) {
        if (vc) return;
        let stream;
        try {
            stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
        } catch (e) {
            return app.showToast('Allow microphone access to record a voice comment');
        }
        const type = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/webm', 'audio/ogg'].find(t => MediaRecorder.isTypeSupported(t));
        const recorder = new MediaRecorder(stream, type ? { mimeType: type } : undefined);
        const chunks = [];
        recorder.ondataavailable = e => { if (e.data && e.data.size) chunks.push(e.data); };
        recorder.start(250);
        vc = { key: form.dataset.key, form, recorder, chunks, stream, started: Date.now() };
        form.classList.add('recording');
        form.insertAdjacentHTML('beforeend', `
            <div class="vc-bar" role="status" aria-live="polite">
                <button type="button" class="vc-cancel" data-action="vc-cancel" aria-label="Discard recording"><svg class="i"><use href="#i-trash"/></svg></button>
                <span class="vc-dot" aria-hidden="true"></span>
                <span class="vc-time">0:00</span>
                <span class="vc-wave" aria-hidden="true">${'<i></i>'.repeat(14)}</span>
                <button type="button" class="vc-send" data-action="vc-send" aria-label="Send voice comment"><svg class="i"><use href="#i-send"/></svg></button>
            </div>`);
        const tick = () => {
            if (!vc) return;
            const secs = Math.floor((Date.now() - vc.started) / 1000);
            const t = vc.form.querySelector('.vc-time');
            if (t) t.textContent = Media.formatDuration(secs);
            if (secs >= MAX_VOICE_COMMENT) finishVoiceComment(true);
        };
        vc.timer = setInterval(tick, 250);
        if (navigator.vibrate) navigator.vibrate(12);
    }

    async function finishVoiceComment(send) {
        if (!vc) return;
        const { key, form, recorder, chunks, stream, started, timer } = vc;
        vc = null;
        clearInterval(timer);
        form.classList.remove('recording');
        form.querySelector('.vc-bar')?.remove();
        await new Promise(resolve => {
            recorder.onstop = resolve;
            if (recorder.state !== 'inactive') recorder.stop();
            else resolve();
        });
        stream.getTracks().forEach(t => t.stop());
        if (!send) return app.showToast('Voice comment discarded');
        const duration = Math.min(MAX_VOICE_COMMENT, Math.max(1, Math.round((Date.now() - started) / 1000)));
        const type = (recorder.mimeType || 'audio/webm').split(';')[0];
        const blob = new Blob(chunks, { type });
        if (!blob.size) return app.showToast('Nothing was recorded');
        const ext = type.includes('mp4') ? 'm4a' : type.includes('ogg') ? 'ogg' : 'webm';
        const path = `${s.profile.id}/${randomId()}.${ext}`;
        form.classList.add('sending');
        const up = await client.storage.from(COMMENT_AUDIO).upload(path, blob, { contentType: type, upsert: false });
        if (up.error) {
            form.classList.remove('sending');
            return app.showToast('Couldn’t upload your voice comment');
        }
        const text = form.querySelector('input[name="body"]');
        const body = text ? text.value.trim() : '';
        const ok = await addComment(key, body, { audio_path: path, audio_duration: duration });
        form.classList.remove('sending');
        if (!ok) {
            client.storage.from(COMMENT_AUDIO).remove([path]);
            return;
        }
        if (text) text.value = '';
        if (form.closest('#post-view')) scrollDetailToEnd();
        app.showToast('Voice comment posted 🎙️');
    }

    // Leaving the page or closing the post mid-recording throws the clip away
    document.addEventListener('visibilitychange', () => { if (document.hidden && vc) finishVoiceComment(false); });

    async function deleteComment(key, id) {
        const found = (s.comments.get(key) || { items: [] }).items.find(c => c.id === id);
        const { error } = await client.from('diary_comments').delete().eq('id', id);
        if (error) return app.showToast('Couldn’t delete that comment');
        // Your own voice clip goes with it (other people's clips are theirs to keep or delete)
        if (found && found.audio_path && found.author === s.profile.id) client.storage.from(COMMENT_AUDIO).remove([found.audio_path]);
        const thread = s.comments.get(key);
        if (thread) thread.items = thread.items.filter(c => c.id !== id);
        bumpCommentCount(key, -1);
        repaintComments(key);
    }

    function bumpCommentCount(key, delta) {
        const [kind, id] = key.split(':');
        postsFor(kind).filter(p => p.id === id).forEach(post => {
            post.comments = [{ count: Math.max(0, commentCount(post) + delta) }];
        });
        if (kind === 'reel' && window.diaryStories) window.diaryStories.paintCounts(id);
    }

    // Repaints every copy of a thread: the card under the feed post and the post view, each in its own mode
    function repaintComments(key) {
        const [kind, id] = key.split(':');
        const post = postsFor(kind).find(p => p.id === id);
        const canComment = kind !== 'post' || (window.diaryCommunities && window.diaryCommunities.canInteract());
        document.querySelectorAll(`[data-comments="${CSS.escape(key)}"]`).forEach(el => {
            el.outerHTML = commentsBlock(kind, id, post ? commentCount(post) : 0, canComment, el.dataset.mode || 'card');
        });
        const countSel = `[data-post="${CSS.escape(key)}"] .post-actions [data-focus="input"] .act-count`;
        if (kind !== 'reel') document.querySelectorAll(s.detail === key ? `${countSel}, #post-view [data-pd="actions"] [data-focus="input"] .act-count` : countSel).forEach(n => {
            n.textContent = (post && commentCount(post)) || '';
        });
    }

    // Realtime: new comments from others land in open threads, and in the card previews
    function onCommentInsert(c) {
        const key = c.entry_id ? `entry:${c.entry_id}` : c.reel_id ? `reel:${c.reel_id}` : `post:${c.post_id}`;
        if (c.author === s.profile.id) return; // addComment already has it
        const friend = s.friends.find(f => f.id === c.author);
        const comment = { ...c, author_profile: friend ? { display_name: friend.display_name, username: friend.username, avatar_path: friend.avatar_path } : null };
        const thread = s.comments.get(key);
        if (thread && thread.open && !thread.loading) {
            if (thread.items.some(x => x.id === c.id)) return;
            thread.items.push(comment);
        } else if (c.entry_id) {
            s.previews.set(key, [...(s.previews.get(key) || []), comment].slice(-2));
        } else {
            return;
        }
        bumpCommentCount(key, 1);
        repaintComments(key);
    }

    // Carousel position → dots + counter
    content.addEventListener('scroll', e => {
        const track = e.target;
        if (!track.classList || !track.classList.contains('carousel')) return;
        const index = Math.round(track.scrollLeft / track.clientWidth);
        const media = track.parentElement;
        media.querySelectorAll('.dots span').forEach((d, i) => d.classList.toggle('on', i === index));
        const counter = media.querySelector('.slide-count');
        if (counter) counter.textContent = `${index + 1}/${track.children.length}`;
    }, true);

    // Zoom into a post's photos: every photo of that post, starting from the one you touched.
    // The viewer handles pinch / double-tap / wheel zoom, so the feed itself never zooms or jumps.
    function openZoom(slide, opts = {}) {
        const media = slide.closest('.post-media');
        const slides = media ? [...media.querySelectorAll('.slide')] : [slide];
        const urls = slides.map(sl => (s.urls.get(`${sl.dataset.bucket}:${sl.dataset.img}`) || {}).url).filter(Boolean);
        const index = Math.max(0, slides.indexOf(slide));
        if (!urls.length) return;
        const caption = media && media.closest('[data-post]') ? '' : '';
        Media.lightbox(urls[index] || urls[0], caption, { sources: urls, index, origin: slide.querySelector('img'), ...opts });
    }

    // Two fingers on a feed photo: open the zoom viewer instead of zooming the whole page
    document.addEventListener('touchstart', e => {
        if (e.touches.length !== 2) return;
        const slide = e.target.closest && e.target.closest('.post-media .slide');
        if (!slide || (window.ZoomViewer && window.ZoomViewer.isOpen())) return;
        e.preventDefault();
        clearTimeout(s.photoTap);
        openZoom(slide);
    }, { passive: false });

    // Double-tap / double-click a photo to like it
    content.addEventListener('dblclick', e => {
        const media = e.target.closest('.post-media');
        if (!media) return;
        e.preventDefault();
        clearTimeout(s.photoTap);
        const burst = media.querySelector('.burst');
        burst.classList.remove('pop');
        void burst.offsetWidth;
        burst.classList.add('pop');
        const btn = media.closest('.post').querySelector('.like-btn');
        if (btn && btn.getAttribute('aria-pressed') !== 'true') btn.click();
    });

    // Shared with community.js
    function toggleText(text) {
        if (!text) return;
        const collapsed = text.classList.toggle('clamped');
        const button = text.parentElement.querySelector('.read-more');
        if (button) button.textContent = collapsed ? 'more' : 'less';
        // Collapsing a long post can leave you far below it — bring its top back into view
        const post = text.closest('.post');
        if (collapsed && post && post.getBoundingClientRect().top < 70) {
            post.scrollIntoView({ block: 'start', behavior: 'smooth' });
        }
    }

    // Scroll to a post once it's on screen (views may still be loading) and flash it; { open: true } also opens the post view
    function focusPost(key, opts = {}) {
        let tries = 0;
        const tick = () => {
            const el = content.querySelector(`[data-post="${CSS.escape(key)}"]`);
            if (el) {
                el.scrollIntoView({ behavior: 'smooth', block: 'center' });
                el.classList.add('flash');
                setTimeout(() => el.classList.remove('flash'), 1800);
                if (opts.open) openPost(key);
            } else if (tries++ < 40) {
                setTimeout(tick, 200);
            }
        };
        tick();
    }

    // ---------- Post view ----------
    // A tapped post opens on its own: full text, photos, and the whole comment thread with a composer.
    // Phones get a full-screen page that slides in from the right (and back out the same way); wider screens a centred card.
    const postView = () => $('post-view');
    const QUICK_EMOJI = ['❤️', '🙌', '🔥', '👏', '😂', '😮', '😢'];
    let detailRepaintQueued = false;
    let detailReturn = null;
    let detailClosing = false;

    function postDetailHTML(o) {
        const key = `${o.kind}:${o.id}`;
        const photos = postPhotos(o);
        const { profile, person, name } = postPerson(o);
        const first = o.mine ? '' : esc(profile.display_name.split(' ')[0]);
        // Where "back" goes, named after the page underneath
        const backTo = { feed: 'Feed', explore: 'Explore', community: 'Community', communities: 'Groups', messages: 'Chats', settings: 'Settings' }[app.state.view] || 'Back';
        return `
            <header class="pv-top">
                <button type="button" class="pv-close pv-back" data-pv="close" aria-label="Back to ${backTo === 'Back' ? 'where you were' : backTo}" title="Back (Esc)">
                    <svg class="i"><use href="#i-back"/></svg><span>${backTo}</span>
                </button>
                <div class="pv-top-who" data-profile="${esc(o.author)}" role="button" tabindex="0" aria-label="${esc(profile.display_name)}’s profile">
                    ${avatar(person, 'sm')}
                    <span><strong>${name}${tick(o.author)}${o.badge ? ` <span class="post-badge">${o.badge}</span>` : ''}</strong><small>@${esc(profile.username)} · ${timeAgo(o.createdAt)}${o.mood ? ` · ${MOOD_EMOJI[o.mood] || ''}` : ''}</small></span>
                </div>
                <button class="more-btn" data-action="post-menu" data-kind="${o.kind}" data-id="${esc(o.id)}" aria-label="Post options"><svg class="i"><use href="#i-more"/></svg></button>
            </header>
            ${photos.length ? `<div class="pv-media">${postMediaHTML(o, photos)}</div>` : ''}
            <div class="pv-scroll">
                <article class="pv-post" data-post="${key}">
                    ${o.pinned ? '<p class="repost-line pinned-line"><svg class="i"><use href="#i-pin-note"/></svg>Pinned by the admins</p>' : ''}
                    ${o.repostedBy ? `<p class="repost-line"><svg class="i"><use href="#i-repost"/></svg>${esc(o.repostedBy)} ${o.reshared ? 'reshared this' : 'reposted'}</p>` : ''}
                    ${postCaptionHTML(o, photos, true)}
                    ${audioCardHTML(o.audio)}
                    <div data-pd="bodyextra">${o.bodyExtra || ''}</div>
                    <div data-pd="extra">${o.extraHTML || ''}</div>
                    <p class="pv-date">${esc(fullDate(o.createdAt))}</p>
                </article>
                ${commentsBlock(o.kind, o.id, o.commentCount, o.canComment, 'full')}
            </div>
            <footer class="pv-foot">
                <div class="post-actions" data-pd="actions">${postActionsHTML(o)}</div>
                <div class="pv-stats" data-pd="stats" data-react-sum>${reactSummaryHTML(o.kind, o.id, o.likes)}</div>
                ${o.canComment ? `
                    <div class="pv-emojis" role="group" aria-label="Add an emoji">
                        ${QUICK_EMOJI.map(e => `<button type="button" data-pv="emoji" data-emoji="${e}" aria-label="Add ${e}">${e}</button>`).join('')}
                    </div>
                    <form class="pv-compose" data-form="comment" data-key="${key}">
                        ${avatar(s.profile, 'sm')}
                        <input name="body" id="pv-input" maxlength="2000" placeholder="${first ? `Reply to ${first}…` : 'Add a comment…'}" autocomplete="off" enterkeyhint="send" aria-label="Add a comment">
                        ${micButton()}
                        <button class="pv-send" disabled>Post</button>
                    </form>` : `<p class="pv-locked">${o.kind === 'post' ? 'Join the community to comment.' : 'Comments are off for this post.'}</p>`}
            </footer>`;
    }

    // Posts in the order they appear on the page, for next / previous
    function visiblePostKeys() {
        return [...content.querySelectorAll('.post.ig[data-post]:not([hidden])')].map(el => el.dataset.post);
    }

    function paintDetailNav() {
        const pv = postView();
        const keys = visiblePostKeys();
        const i = keys.indexOf(s.detail);
        pv.querySelector('[data-pv="prev"]').disabled = i <= 0;
        pv.querySelector('[data-pv="next"]').disabled = i < 0 || i >= keys.length - 1;
    }

    function openPost(key, opts = {}) {
        const pv = postView();
        const o = s.rendered.get(key);
        if (!pv || !o) return;
        if (pv.open && s.detail === key) {
            if (opts.focus === 'input') $('pv-input')?.focus();
            return;
        }
        const shell = $('pv-shell');
        const photos = postPhotos(o);
        s.detail = key;
        shell.classList.toggle('has-media', photos.length > 0);
        shell.innerHTML = postDetailHTML(o);
        shell.scrollTop = 0;
        hydrateStorage(shell);
        const thread = s.comments.get(key);
        if (!thread || !thread.open) openComments(key);
        if (!pv.open) {
            detailReturn = document.activeElement;
            detailClosing = false;
            pv.classList.remove('closing');
            pv.showModal(); // the phone's back gesture closes it (see Navigation in script.js)
            document.documentElement.classList.add('pv-lock');
        }
        paintDetailNav();
        if (opts.focus === 'input') setTimeout(() => $('pv-input')?.focus(), 280);
        else pv.querySelector('.pv-close').focus({ preventScroll: true });
    }

    function closePost(fromHistory = false) {
        const pv = postView();
        if (!pv || !pv.open || detailClosing) return;
        detailClosing = true;
        if (vc && pv.contains(vc.form)) finishVoiceComment(false);
        const finish = () => {
            pv.close();
            pv.classList.remove('closing');
            $('pv-shell').innerHTML = '';
            document.documentElement.classList.remove('pv-lock');
            const key = s.detail;
            s.detail = null;
            detailClosing = false;
            // Land back on the post you were reading
            const card = key && content.querySelector(`[data-post="${CSS.escape(key)}"]`);
            const target = detailReturn && document.contains(detailReturn) && !pv.contains(detailReturn)
                ? detailReturn : card && card.querySelector('.post-time');
            if (target) target.focus({ preventScroll: true });
            detailReturn = null;
        };
        const reduced = document.documentElement.dataset.motion === 'reduce' || window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        if (reduced) return finish();
        pv.classList.add('closing');
        setTimeout(finish, 220);
    }

    function stepPost(dir) {
        const keys = visiblePostKeys();
        const next = keys[keys.indexOf(s.detail) + dir];
        if (!next) return;
        const card = content.querySelector(`[data-post="${CSS.escape(next)}"]`);
        if (card) card.scrollIntoView({ block: 'center' });
        openPost(next);
    }

    // Likes, saves, polls and reactions change while the post is open: patch those bits, keep scroll and typing
    function scheduleDetailRepaint() {
        if (detailRepaintQueued) return;
        detailRepaintQueued = true;
        queueMicrotask(() => {
            detailRepaintQueued = false;
            const pv = postView();
            const o = s.detail && s.rendered.get(s.detail);
            if (!pv || !pv.open || !o) return;
            const set = (k, html) => {
                const el = pv.querySelector(`[data-pd="${k}"]`);
                if (el && el.innerHTML !== html) el.innerHTML = html;
            };
            set('actions', postActionsHTML(o));
            set('stats', reactSummaryHTML(o.kind, o.id, o.likes));
            set('bodyextra', o.bodyExtra || '');
            set('extra', o.extraHTML || '');
        });
    }

    function scrollDetailToEnd() {
        const shell = $('pv-shell');
        const inner = shell.querySelector('.pv-scroll');
        const scroller = inner && getComputedStyle(inner).overflowY !== 'visible' ? inner : shell;
        scroller.scrollTo({ top: scroller.scrollHeight, behavior: 'smooth' });
    }

    (() => {
        const pv = postView();
        if (!pv) return;
        pv.addEventListener('click', e => {
            if (e.target === pv) return closePost();
            const own = e.target.closest('[data-pv]');
            if (own) {
                const input = $('pv-input');
                switch (own.dataset.pv) {
                    case 'close': closePost(); break;
                    case 'prev': stepPost(-1); break;
                    case 'next': stepPost(1); break;
                    case 'emoji':
                        if (!input) break;
                        input.value += own.dataset.emoji;
                        input.dispatchEvent(new Event('input', { bubbles: true }));
                        input.focus();
                        break;
                    case 'reply':
                        if (!input) break;
                        input.value = `@${own.dataset.name} `;
                        input.dispatchEvent(new Event('input', { bubbles: true }));
                        input.focus();
                        break;
                }
                return;
            }
            const el = e.target.closest('[data-action]');
            if (el && pv.contains(el) && app.actions[el.dataset.action]) {
                if (['ex-tag', 'feed-tag'].includes(el.dataset.action)) closePost(); // a #tag takes you to the feed
                app.actions[el.dataset.action](el, e);
            }
        });
        pv.addEventListener('submit', async e => {
            const form = e.target.closest('form[data-form="comment"]');
            if (!form) return;
            e.preventDefault();
            const input = form.querySelector('input');
            const body = input.value.trim();
            if (!body) return;
            input.value = '';
            form.querySelector('.pv-send').disabled = true;
            const ok = await addComment(form.dataset.key, body);
            if (!ok) {
                input.value = body;
                form.querySelector('.pv-send').disabled = false;
                return;
            }
            scrollDetailToEnd();
        });
        pv.addEventListener('input', e => {
            if (e.target.id === 'pv-input') e.target.form.querySelector('.pv-send').disabled = !e.target.value.trim();
        });
        pv.addEventListener('cancel', e => { e.preventDefault(); closePost(); });

        // Phones: swipe right from the left edge to go back, like any app page (the sheet follows your finger)
        let edge = null;
        pv.addEventListener('touchstart', e => {
            const t = e.touches[0];
            if (e.touches.length !== 1 || t.clientX > 28 || window.innerWidth >= 720) return;
            edge = { x: t.clientX, y: t.clientY, dx: 0, shell: $('pv-shell') };
        }, { passive: true });
        pv.addEventListener('touchmove', e => {
            if (!edge) return;
            const t = e.touches[0];
            const dx = t.clientX - edge.x;
            if (Math.abs(t.clientY - edge.y) > Math.abs(dx) && edge.dx === 0) { edge = null; return; } // a scroll, not a swipe
            edge.dx = Math.max(0, dx);
            edge.shell.style.transition = 'none';
            edge.shell.style.transform = `translateX(${edge.dx}px)`;
        }, { passive: true });
        const endEdge = () => {
            if (!edge) return;
            const { shell, dx } = edge;
            edge = null;
            shell.style.transition = 'transform 220ms cubic-bezier(0.22, 1, 0.36, 1)';
            if (dx > window.innerWidth * 0.3) {
                pv.classList.add('swiped'); // it's already sliding out — skip the usual closing animation
                shell.style.transform = 'translateX(100%)';
                setTimeout(() => {
                    shell.style.transition = '';
                    shell.style.transform = '';
                    pv.classList.remove('swiped');
                }, 400);
                closePost();
            } else {
                shell.style.transform = '';
                setTimeout(() => { shell.style.transition = ''; }, 240);
            }
        };
        pv.addEventListener('touchend', endEdge);
        pv.addEventListener('touchcancel', endEdge);
        pv.addEventListener('keydown', e => {
            if (e.target.closest('input, textarea, [contenteditable="true"]')) return;
            if (e.key === 'ArrowRight' || e.key === 'j') { e.preventDefault(); stepPost(1); }
            if (e.key === 'ArrowLeft' || e.key === 'k') { e.preventDefault(); stepPost(-1); }
        });
        pv.addEventListener('dblclick', e => {
            const media = e.target.closest('.post-media');
            if (!media) return;
            e.preventDefault();
            const burst = media.querySelector('.burst');
            burst.classList.remove('pop');
            void burst.offsetWidth;
            burst.classList.add('pop');
            const btn = pv.querySelector('.pv-foot .like-btn');
            if (btn && btn.getAttribute('aria-pressed') !== 'true') btn.click();
        });
        pv.addEventListener('scroll', e => {
            const track = e.target;
            if (!track.classList || !track.classList.contains('carousel')) return;
            const index = Math.round(track.scrollLeft / track.clientWidth);
            const media = track.parentElement;
            media.querySelectorAll('.dots span').forEach((d, i) => d.classList.toggle('on', i === index));
            const counter = media.querySelector('.slide-count');
            if (counter) counter.textContent = `${index + 1}/${track.children.length}`;
        }, true);
    })();

    // A tap anywhere on a card that isn't a control opens the post (long text still expands in place)
    content.addEventListener('click', e => {
        const card = e.target.closest('.post.ig[data-post]');
        if (!card || !content.contains(card)) return;
        if (e.target.closest('button, a, input, textarea, select, label, form, video, audio, [data-action], .comments, .cm-poll, .cm-reacts, .post-audio')) return;
        if (window.getSelection && String(window.getSelection()).length) return;
        openPost(card.dataset.post);
    });

    // Feed shortcuts on a keyboard: J / K move between posts, O or Enter opens, L likes
    document.addEventListener('keydown', e => {
        if (app.state.view !== 'feed' && app.state.view !== 'community') return;
        if (e.metaKey || e.ctrlKey || e.altKey || document.querySelector('dialog[open]')) return;
        if (e.target.closest('input, textarea, select, [contenteditable="true"]')) return;
        const keys = visiblePostKeys();
        if (!keys.length) return;
        const current = document.activeElement && document.activeElement.closest && document.activeElement.closest('.post.ig[data-post]');
        const i = current ? keys.indexOf(current.dataset.post) : -1;
        const go = n => {
            const card = content.querySelector(`[data-post="${CSS.escape(keys[n])}"]`);
            if (!card) return;
            card.scrollIntoView({ block: 'center', behavior: 'smooth' });
            card.querySelector('.post-time')?.focus({ preventScroll: true });
        };
        if (e.key === 'j') { e.preventDefault(); go(Math.min(keys.length - 1, i + 1)); }
        else if (e.key === 'k') { e.preventDefault(); go(Math.max(0, i - 1)); }
        else if ((e.key === 'o') && current) { e.preventDefault(); openPost(current.dataset.post); }
        else if (e.key === 'l' && current) { e.preventDefault(); current.querySelector('.like-btn')?.click(); }
    });

    window.diarySocial.internals = {
        client, state: s, esc, avatar, avatarUrl, timeAgo, gate, extFor, randomId, uploadImage, hydrateStorage,
        renderPost, commentCount, openComments, repaintComments, MOOD_EMOJI: () => MOOD_EMOJI,
        respond, loadFriends, openChat, focusPost, commentsBlock, addComment, deleteComment, toggleSaved, postsFor,
        changeAvatar, removeAvatar, signOut, openAuth, hashtags, commentCount, followButton, toggleFollow, loadFollows,
        pickAudio, uploadAudio, voiceHTML, POST_AUDIO, linkTags, emojiPicker, POST_REACTIONS, peopleResults,
        presenceText, refreshPresence, paintPresence, heartbeat,
        chooseDelete, openRecentlyDeleted, editedTag, showHistory, prefOf, setPref, isMuted, muteMenu, soundMenu, FOREVER,
        statusOf, contactCardHTML, pickContact, deviceId, deviceLabel, STATUS,
        loadFeed: () => { if (s.feed === null) loadFeed(); },
        FEED_SELECT, decorateRepost, loadPreviews, quickPost, tick, loadVerified, postCard, findPost, postExtras, hidePost, setReaction, openReactors,
        likeButtonHTML, reactSummaryHTML, openPost, closePost, copyText, postLink, save, load,
        isHidden: (kind, id) => s.hidden.has(`${kind}:${id}`),
        // Open a feed post in the post view from anywhere (Explore, notifications, links), even if its card isn't on screen
        openEntry(id, opts) {
            const p = findPost('entry', id);
            if (!p) {
                fetchEntry(id).then(found => { if (found) this.openEntry(id, opts); else app.showToast('That post isn’t available — it may have been removed or is only for friends'); });
                return true;
            }
            postCard(p); // records what the post view needs
            openPost(`entry:${id}`, opts);
            return true;
        },
        setInboxTab(tab) { s.inboxTab = tab; app.render(); }
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
        if (s.inboxTab === 'calls' && window.diaryCalls && window.diaryCalls.historyHTML) {
            rows = window.diaryCalls.historyHTML();
        } else if (s.inboxTab === 'requests') {
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
            const archived = f => !!prefOf('dm', f.id).archived;
            const list = sortedFriends().filter(f => s.inboxTab === 'archived' ? archived(f)
                : s.inboxTab === 'unread' ? (s.unread[f.id] || prefOf('dm', f.id).marked_unread)
                : !archived(f));
            rows = list.map(convoRow).join('') ||
                `<p class="inbox-empty">${s.inboxTab === 'unread' ? 'You’re all caught up.' : s.inboxTab === 'archived' ? 'No archived chats. Archive one from its menu (⋯) to tidy your inbox.' : 'No friends yet. Tap + to add someone by username.'}</p>`;
        }

        return `
            <div class="inbox${friend ? ' has-active' : ''}${s.showInfo && friend ? ' show-info' : ''}">
                <aside class="inbox-list">
                    <div class="inbox-head">
                        <div class="inbox-titles">
                            <h2>Messages</h2>
                            <p class="inbox-sub">${inboxSummary()}</p>
                        </div>
                        <button class="compose-btn refresh-btn" data-action="chat-refresh" aria-label="Refresh chats" title="Refresh chats"><svg class="i"><use href="#i-refresh"/></svg></button>
                        <button class="compose-btn" data-action="toggle-add" aria-pressed="${s.addOpen}" aria-label="Add a friend by username" title="Add a friend"><svg class="i"><use href="#i-user-plus"/></svg></button>
                    </div>
                    <form class="add-friend" data-form="add-friend"${s.addOpen ? '' : ' hidden'}>
                        <input id="add-friend-input" placeholder="Friend’s username" autocomplete="off" aria-label="Friend's username">
                        <button class="primary-btn">Add</button>
                    </form>
                    <label class="search inbox-search">
                        <svg class="i"><use href="#i-search"/></svg>
                        <input type="search" id="chat-search" placeholder="Search chats and people" aria-label="Search chats">
                    </label>
                    ${activeNow()}
                    <div class="inbox-tabs" role="tablist">
                        ${tab('all', 'All', 0)}${tab('unread', 'Unread', unreadCount)}${tab('requests', 'Requests', s.incoming.length)}${[...s.prefs.values()].some(r => r.kind === 'dm' && r.archived) ? tab('archived', 'Archived', 0) : ''}${window.diaryCalls && window.diaryCalls.historyHTML ? tab('calls', 'Calls', 0) : ''}
                    </div>
                    <div class="convo-list">${rows}</div>
                    <p class="muted small inbox-foot">You’re <strong>@${esc(s.profile.username)}</strong> — share it so friends can add you.</p>
                </aside>
                <section class="chat-pane${friend && incognitoOf(friend.id) ? ' incognito' : ''}">
                    ${friend ? chatPane(friend) : `<div class="chat-placeholder"><svg class="i"><use href="#i-chat"/></svg>
                        <p>Pick a conversation to start chatting.</p></div>`}
                </section>
                ${friend ? infoPane(friend) : ''}
            </div>`;
    };

    function inboxSummary() {
        const unread = Object.values(s.unread).filter(Boolean).length;
        const online = s.friends.filter(f => s.online.has(f.id)).length;
        return [
            unread ? `${unread} unread` : 'All caught up',
            online ? `${online} ${online === 1 ? 'friend' : 'friends'} online` : `${s.friends.length} ${s.friends.length === 1 ? 'friend' : 'friends'}`
        ].join(' · ');
    }

    // Friends who are online right now, one tap from a chat (Messenger-style)
    function activeNow() {
        const online = sortedFriends().filter(f => s.online.has(f.id)).slice(0, 12);
        if (!online.length) return '';
        return `
            <div class="active-now" aria-label="Active now">
                <p class="active-label">Active now</p>
                <div class="active-row">
                    ${online.map(f => `
                        <button class="active-friend" data-action="open-chat" data-id="${esc(f.id)}" aria-label="Chat with ${esc(f.display_name)}">
                            ${avatar(f, 'lg')}<span>${esc(f.display_name.split(' ')[0])}</span>
                        </button>`).join('')}
                </div>
            </div>`;
    }

    function sortedFriends() {
        return [...s.friends].sort((a, b) => {
            const pa = prefOf('dm', a.id).pinned_at, pb = prefOf('dm', b.id).pinned_at;
            if (!!pa !== !!pb) return pa ? -1 : 1;
            if (pa && pb) return Date.parse(pb) - Date.parse(pa);
            const ta = s.last[a.id] ? Date.parse(s.last[a.id].created_at) : 0;
            const tb = s.last[b.id] ? Date.parse(s.last[b.id].created_at) : 0;
            return tb - ta || a.display_name.localeCompare(b.display_name);
        });
    }

    // Profile photo when there is one, initials otherwise
    function avatar(f, size = 'sm') {
        const face = f.avatar_path
            ? `<img src="${esc(avatarUrl(f.avatar_path))}" alt="" loading="lazy">`
            : esc(app.initials(f.display_name || '?'));
        return `<span class="avatar ${size}${f.avatar_path ? ' has-photo' : ''}" data-presence="${esc(f.id || '')}"${f.avatar_path ? '' : ` style="background:${avatarColour(f.id || f.username || f.display_name)}"`}>${face}<span class="presence-dot" aria-hidden="true"></span></span>`;
    }

    // Each friend keeps the same colour everywhere (all pass 4.5:1 with white initials)
    function avatarColour(key) {
        const AVATAR_COLOURS = ['#4f46e5', '#6d28d9', '#be185d', '#0e7490', '#b45309', '#15803d', '#9d174d', '#1d4ed8'];
        let h = 0;
        for (const ch of String(key || '')) h = (h * 31 + ch.charCodeAt(0)) | 0;
        return AVATAR_COLOURS[Math.abs(h) % AVATAR_COLOURS.length];
    }

    function avatarUrl(path) {
        return `${cfg.supabaseUrl}/storage/v1/object/public/diary-avatars/${path.split('/').map(encodeURIComponent).join('/')}`;
    }

    function convoRow(f) {
        const m = s.last[f.id];
        const pref = prefOf('dm', f.id);
        const unread = s.unread[f.id] || (pref.marked_unread ? '•' : 0);
        const muted = isMuted('dm', f.id);
        const mine = m && m.sender === s.profile.id;
        const preview = m ? `${mine ? 'You: ' : ''}${previewOf(m)}` : 'Say hello 👋';
        // The row opens the chat; the phone beside it starts a voice call straight from the inbox
        return `
            <div class="convo-wrap" data-wrap="${esc(f.id)}" data-search="${esc(`${f.display_name} ${f.username}`.toLowerCase())}">
                <button class="convo${f.id === s.activeFriend ? ' active' : ''}${unread ? ' unread' : ''}" data-action="open-chat" data-id="${esc(f.id)}">
                    ${avatar(f, 'md')}
                    <span class="convo-main">
                        <span class="convo-top"><strong>${esc(f.display_name)}${pref.pinned_at ? '<svg class="i convo-flag" aria-label="Pinned"><use href="#i-pin-note"/></svg>' : ''}${muted ? '<svg class="i convo-flag" aria-label="Muted"><use href="#i-bell-off"/></svg>' : ''}${incognitoOf(f.id) ? '<svg class="i convo-incognito" aria-label="Incognito on"><use href="#i-incognito"/></svg>' : ''}</strong>${m ? `<time>${shortTime(m.created_at)}</time>` : ''}</span>
                        <span class="convo-bottom">${mine && !m.deleted_at && !m.vanish ? ticksHTML(m).replace('class="ticks', 'class="convo-ticks ticks') : ''}<span class="convo-preview">${esc(preview)}</span>${unread ? `<span class="badge${muted ? ' muted' : ''}">${unread}</span>` : ''}</span>
                    </span>
                </button>
                <button type="button" class="convo-more" data-action="convo-menu" data-id="${esc(f.id)}" aria-label="Chat options for ${esc(f.display_name)}" aria-haspopup="menu"><svg class="i"><use href="#i-more"/></svg></button>
                ${window.diaryCalls ? `<button type="button" class="convo-call" data-action="call-friend" data-id="${esc(f.id)}" aria-label="Voice call ${esc(f.display_name)}" title="Voice call"><svg class="i"><use href="#i-phone"/></svg></button>` : ''}
            </div>`;
    }

    function previewOf(m) {
        if (m.deleted_at) return '🚫 Message unsent';
        if (m.vanish) return 'Incognito message';
        const text = Rich.toText(m.body || '').replace(/\s+/g, ' ').trim();
        if (text) return text.slice(0, 80);
        const a = (m.attachments || [])[0];
        if (!a) return '';
        if (a.kind === 'audio') return '🎤 Voice note';
        if (a.kind === 'location') return '📍 Live location';
        if (a.kind === 'contact') return `👤 ${a.name || 'Contact'}`;
        if (a.kind === 'image' || a.kind === 'drawing') return '📷 Photo';
        return `📎 ${a.name}`;
    }

    function chatPane(friend) {
        const thread = s.threads[friend.id];
        const inc = incognitoOf(friend.id);
        let body;
        if (!thread) body = '<p class="chat-empty">Loading…</p>';
        else if (!thread.length) body = `<p class="chat-empty">This is the start of your chat with ${esc(friend.display_name)}. Say hi 👋</p>`;
        else {
            const firstUnread = unreadDividerBefore(thread);
            body = thread.map((m, i) => `${m.id === firstUnread ? `<div class="unread-sep" id="unread-sep"><span>${s.unreadMark.count} unread ${s.unreadMark.count === 1 ? 'message' : 'messages'}</span></div>` : ''}${messageHTML(m, thread[i - 1] || null)}`).join('');
        }

        return `
            <header class="chat-head">
                <button class="icon-btn back-chat" data-action="close-chat" aria-label="Back to inbox"><svg class="i"><use href="#i-back"/></svg></button>
                <button type="button" class="chat-who" data-profile="${esc(friend.id)}" aria-label="View ${esc(friend.display_name)}’s profile">${avatar(friend, 'sm')}</button>
                <div class="friend-name"><button type="button" class="chat-who-name" data-profile="${esc(friend.id)}">${esc(friend.display_name)}</button><small data-status="${esc(friend.id)}" data-with-status data-away="@${esc(friend.username)}">${esc([statusOf(friend.id) ? statusOf(friend.id).label : '', presenceText(friend.id)].filter(Boolean).join(' · ') || `@${friend.username}`)}</small></div>
                ${window.diaryCalls && s.allowCalls.get(friend.id) !== 'nobody' && !(window.diarySafety && window.diarySafety.isBlocked(friend.id)) ? `<button class="icon-btn accent" data-action="call-friend" data-id="${esc(friend.id)}" aria-label="Voice call ${esc(friend.display_name)}" title="Voice call"><svg class="i"><use href="#i-phone"/></svg></button><button class="icon-btn accent" data-action="call-friend" data-video="1" data-id="${esc(friend.id)}" aria-label="Video call ${esc(friend.display_name)}" title="Video call"><svg class="i"><use href="#i-video"/></svg></button>` : ''}
                <button class="icon-btn" data-action="chat-ai" aria-label="AI tools: summarise or suggest replies" title="AI tools" aria-haspopup="menu"><svg class="i"><use href="#i-sparkle"/></svg></button>
                <button class="icon-btn" data-action="chat-search" aria-label="Search this chat" title="Search"><svg class="i"><use href="#i-search"/></svg></button>
                <button class="icon-btn incognito-btn" data-action="chat-incognito" aria-pressed="${!!inc}" aria-label="Incognito chat${inc ? ' (on)' : ''}" title="Incognito chat"><svg class="i"><use href="#i-incognito"/></svg></button>
                <button class="icon-btn refresh-btn" data-action="chat-refresh" aria-label="Refresh this chat" title="Refresh"><svg class="i"><use href="#i-refresh"/></svg></button>
                <button class="icon-btn" data-action="chat-wallpaper" aria-label="Chat wallpaper" title="Wallpaper"><svg class="i"><use href="#i-palette"/></svg></button>
                <button class="icon-btn" data-action="toggle-info" aria-pressed="${s.showInfo}" aria-label="Contact details" title="Contact details"><svg class="i"><use href="#i-info"/></svg></button>
            </header>
            ${inc ? incognitoBanner(friend, inc) : ''}
            <div class="chat-thread" id="chat-thread">${body}</div>
            <button type="button" class="chat-jump" id="chat-jump" data-action="chat-jump" hidden aria-label="Jump to latest"><svg class="i"><use href="#i-down"/></svg><span></span></button>
            ${window.diarySafety && window.diarySafety.isBlocked(friend.id) ? `<div class="chat-blocked" role="status"><svg class="i"><use href="#i-block"/></svg><span>You blocked ${esc(friend.display_name)}. You can’t message or call each other.</span><button type="button" class="chip" data-action="chat-unblock">Unblock</button></div>` : ''}
            <form class="composer${s.rec ? ' recording' : ''}${window.diarySafety && window.diarySafety.isBlocked(friend.id) ? ' is-blocked' : ''}" data-form="send-message">
                <div class="reply-bar" id="reply-bar" hidden></div>
                <div class="quick-replies">${['👍', '❤️', '😂', 'On my way!', 'Talk later?', 'Thank you 🙏'].map(q => `<button type="button" class="quick-reply" data-action="quick-reply" data-text="${esc(q)}">${esc(q)}</button>`).join('')}</div>
                <div class="pending-atts" id="pending-atts" hidden></div>
                <div class="rich-toolbar compact" id="chat-toolbar" role="toolbar" aria-label="Formatting"${s.showFormat ? '' : ' hidden'}></div>
                <div class="composer-row">
                    <button type="button" class="composer-plus" data-action="chat-add" title="Photo, document, voice note, drawing or formatting" aria-label="Add photo, document, voice note or drawing"><svg class="i"><use href="#i-plus"/></svg></button>
                    <div class="composer-box">
                        <div class="rich chat-input" id="chat-input" contenteditable="true" role="textbox" aria-multiline="true"
                            aria-label="${inc ? 'Incognito message to' : 'Message'} ${esc(friend.display_name)}" data-placeholder="${inc ? 'Incognito message…' : `Message ${esc(friend.display_name.split(' ')[0])}…`}"></div>
                        <div class="composer-tools">
                            <button type="button" class="tool-btn" data-action="chat-emoji" title="Emoji" aria-label="Emoji"><svg class="i"><use href="#i-smile"/></svg></button>
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

    // noSep: repainting one message in place (its day separator is already on the page)
    function messageHTML(m, prev, noSep = false) {
        const me = s.profile.id;
        const mine = m.sender === me;
        const friend = s.friends.find(f => f.id === (mine ? m.recipient : m.sender));
        const date = new Date(m.created_at);
        const newDay = !prev || new Date(prev.created_at).toDateString() !== date.toDateString();
        const sep = newDay && !noSep ? `<div class="day-sep"><span>${app.dayLabel(app.dayKey(date))}</span></div>` : '';
        // Messages from the same person within a few minutes stack together
        const grouped = !newDay && prev && prev.sender === m.sender && date - new Date(prev.created_at) < 5 * 60000;
        const id = esc(String(m.id));

        if (m.deleted_at) {
            return `${sep}
                <div class="msg ${mine ? 'out' : 'in'} unsent${grouped ? ' grouped' : ''}" data-msg="${id}">
                    ${mine || !friend ? '' : avatar(friend, 'xs')}
                    <div class="msg-card"><div class="msg-body"><svg class="i"><use href="#i-close"/></svg>${mine ? 'You unsent a message' : 'This message was unsent'}</div></div>
                </div>`;
        }

        const quoted = m.reply_to ? (s.threads[mine ? m.recipient : m.sender] || []).find(x => x.id === m.reply_to) : null;
        const quote = m.reply_to ? `
            <button type="button" class="msg-quote" data-action="jump-msg" data-id="${esc(String(m.reply_to))}">
                <strong>${quoted ? (quoted.sender === me ? 'You' : esc(friend ? friend.display_name : 'Friend')) : 'Earlier message'}</strong>
                <span>${quoted ? esc(previewOf(quoted)) : 'Tap to find it'}</span>
            </button>` : '';
        const body = m.body ? `<div class="msg-body rich-content">${Rich.sanitize(m.body)}</div>` : '';
        const atts = (m.attachments || []).map(a => (a && a.kind === 'location'
            ? (window.LiveLocation ? window.LiveLocation.cardHTML(a, { mine, person: mine ? s.profile : friend }) : '<p>📍 Live location</p>')
            : attachmentHTML(a))).join('');
        const onlyEmoji = !atts && /^\p{Extended_Pictographic}(\u200d?\p{Extended_Pictographic}|\ufe0f|\s){0,6}$/u.test(Rich.toText(m.body || '').trim());
        const reactions = Object.entries(m.reactions || {}).filter(([, users]) => Array.isArray(users) && users.length);
        return `${sep}
            <div class="msg ${mine ? 'out' : 'in'}${grouped ? ' grouped' : ''}${onlyEmoji ? ' jumbo' : ''}${reactions.length ? ' has-reacts' : ''}${m.vanish ? ' vanish' : ''}" data-msg="${id}">
                ${mine || !friend ? '' : avatar(friend, 'xs')}
                <div class="msg-card" title="${date.toLocaleString(undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit' })}">
                    ${m.forwarded ? '<span class="msg-forwarded"><svg class="i"><use href="#i-forward"/></svg>Forwarded</span>' : ''}
                    ${quote}
                    ${body}
                    ${atts ? `<div class="msg-atts">${atts}</div>` : ''}
                    <span class="msg-meta">${editedTag('dm', m)}${m.vanish ? `<span class="vanish-mark" title="${esc(vanishTitle(m))}"><svg class="i"><use href="#i-timer"/></svg></span>` : ''}<time>${date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}</time>${mine && !m.vanish ? ticksHTML(m) : ''}</span>
                    ${reactions.length ? `<div class="msg-reacts">${reactions.map(([e, users]) => `<button type="button" class="react-chip${users.includes(me) ? ' mine' : ''}" data-action="react" data-id="${id}" data-emoji="${esc(e)}" data-who="${esc(users.map(u => (u === me ? 'You' : (friend && friend.id === u ? friend.display_name : 'Someone'))).join(', '))}" title="${esc(users.map(u => (u === me ? 'You' : (friend && friend.id === u ? friend.display_name : 'Someone'))).join(', '))}" aria-label="${esc(e)} ${users.length}">${esc(e)}${users.length > 1 ? `<span>${users.length}</span>` : ''}</button>`).join('')}</div>` : ''}
                </div>
                <div class="msg-tools">
                    <button type="button" data-action="msg-menu" data-id="${id}" aria-label="React or reply"><svg class="i"><use href="#i-smile"/></svg></button>
                    <button type="button" data-action="msg-reply" data-id="${id}" aria-label="Reply"><svg class="i"><use href="#i-reply"/></svg></button>
                </div>
            </div>`;
    }

    function attachmentHTML(a) {
        if (a && a.kind === 'contact') return contactCardHTML(a);
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
        const muted = isMuted('dm', friend.id);
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
                <div class="info-quick">
                    ${window.diaryCalls ? `<button class="info-q" data-action="call-friend" data-id="${esc(friend.id)}"><span class="info-q-ic"><svg class="i"><use href="#i-phone"/></svg></span>Call</button>` : ''}
                    <button class="info-q" data-action="toggle-mute" aria-pressed="${muted}"><span class="info-q-ic"><svg class="i"><use href="#i-bell"/></svg></span>${muted ? 'Unmute' : 'Mute'}</button>
                    <button class="info-q" data-action="friend-entries" data-id="${esc(friend.id)}"><span class="info-q-ic"><svg class="i"><use href="#i-feed"/></svg></span>Posts</button>
                </div>
                <div class="info-stats">
                    ${row('i-user', 'green', 'Status', `<span data-status="${esc(friend.id)}" data-away="Away">${s.online.has(friend.id) ? 'Active now' : 'Away'}</span>`)}
                    ${row('i-chat', 'blue', 'Messages', thread.length)}
                    ${row('i-heart', 'pink', 'Friends since', new Date(friend.since).toLocaleDateString(undefined, { month: 'short', year: 'numeric' }))}
                    ${row('i-mic', 'yellow', 'Voice notes', voice)}
                </div>
                <button class="info-row" data-action="chat-gallery">
                    <span class="info-ic green"><svg class="i"><use href="#i-image"/></svg></span><span>Media, voice, files &amp; links</span><b>See all</b>
                </button>
                <h4 class="info-label">Shared media</h4>
                ${media.length ? `<div class="info-media">${media.map(a => `<button type="button" class="msg-img" data-action="chat-view-image" data-img="${esc(a.path)}"><img data-path="${esc(a.path)}" alt="${esc(a.name || '')}"></button>`).join('')}</div>` : '<p class="muted small">Photos you share appear here.</p>'}
                <h4 class="info-label">Files</h4>
                ${files.length ? files.map(attachmentHTML).join('') : '<p class="muted small">No documents yet.</p>'}
                <h4 class="info-label">Settings</h4>
                <button class="info-row" data-action="chat-recent-deleted">
                    <span class="info-ic blue"><svg class="i"><use href="#i-history"/></svg></span><span>Recently deleted</span><b>30 days</b>
                </button>
                <label class="info-row toggle">
                    <span class="info-ic purple"><svg class="i"><use href="#i-bell"/></svg></span><span>Notifications</span>
                    <span class="share-toggle"><input type="checkbox" data-action="toggle-mute"${muted ? '' : ' checked'}><span class="switch" aria-hidden="true"></span></span>
                </label>
                ${window.diarySafety ? `<button class="info-row danger" data-action="${window.diarySafety.isBlocked(friend.id) ? 'chat-unblock' : 'chat-block'}">
                    <span class="info-ic red"><svg class="i"><use href="#i-block"/></svg></span><span>${window.diarySafety.isBlocked(friend.id) ? 'Unblock' : 'Block'} ${esc(friend.display_name.split(' ')[0])}</span>
                </button>
                <button class="info-row danger" data-action="chat-report">
                    <span class="info-ic red"><svg class="i"><use href="#i-flag"/></svg></span><span>Report ${esc(friend.display_name.split(' ')[0])}</span>
                </button>` : ''}
                <button class="info-row danger" data-action="friend-remove" data-id="${esc(friend.id)}">
                    <span class="info-ic red"><svg class="i"><use href="#i-trash"/></svg></span><span>Remove friend</span>
                </button>
            </aside>`;
    }

    // ---------- View actions ----------
    Object.assign(app.actions, {
        'sign-in': () => openAuth(),
        'change-avatar': () => changeAvatar(),
        'call-friend': el => {
            const friend = s.friends.find(f => f.id === el.dataset.id);
            if (friend && window.diaryCalls) window.diaryCalls.callUser(friend, { video: el.dataset.video === '1' });
        },
        'refresh-feed': () => { s.feed = null; app.render(); },
        'feed-all': () => { s.feedAuthor = null; s.feedFilter = 'all'; app.render(); },
        'feed-filter': el => { s.feedAuthor = null; s.feedFilter = el.dataset.filter; app.render(); },
        'feed-tag': el => {
            s.feedAuthor = null;
            s.feedFilter = `tag:${el.dataset.tag}`;
            app.render();
            window.scrollTo({ top: 0 });
            document.querySelector('.main-col').scrollTo({ top: 0 });
        },
        'go-insights': () => app.setView('insights'),
        'feed-add-photos': async () => addFeedPhotos(await Media.pickFiles('image/*')),
        'feed-camera': async () => addFeedPhotos(await Media.pickFiles('image/*', false, 'environment')),
        'feed-remove-photo': el => {
            const photo = s.feedDraft.photos.find(p => p.id === el.dataset.id);
            if (photo) URL.revokeObjectURL(photo.preview);
            s.feedDraft.photos = s.feedDraft.photos.filter(p => p.id !== el.dataset.id);
            renderFeedPhotos();
        },
        'save-post': el => toggleSaved('entry', el.dataset.id),
        'feed-audio': async el => {
            const picked = await pickAudio(el);
            if (!picked) return;
            if (s.feedDraft.audio) URL.revokeObjectURL(s.feedDraft.audio.preview);
            s.feedDraft.audio = { ...picked, preview: URL.createObjectURL(picked.file) };
            renderFeedAudio();
        },
        'feed-audio-play': el => {
            const audio = el.parentElement.querySelector('audio');
            if (!audio) return;
            const icon = name => { el.innerHTML = `<svg class="i"><use href="#${name}"/></svg>`; };
            audio.onended = audio.onpause = () => { icon('i-play'); el.setAttribute('aria-label', 'Play preview'); };
            audio.onplay = () => { icon('i-pause'); el.setAttribute('aria-label', 'Pause preview'); };
            if (audio.paused) audio.play().catch(() => app.showToast('Couldn’t play that audio'));
            else audio.pause();
        },
        'feed-remove-audio': () => {
            if (s.feedDraft.audio) URL.revokeObjectURL(s.feedDraft.audio.preview);
            s.feedDraft.audio = null;
            renderFeedAudio();
        },
        'feed-edit-photo': async el => {
            const photo = s.feedDraft.photos.find(p => p.id === el.dataset.id);
            if (!photo || !window.PhotoEditor) return;
            const edited = await window.PhotoEditor.open(photo.file, { title: 'Edit photo', done: 'Use photo' });
            if (!edited) return;
            URL.revokeObjectURL(photo.preview);
            photo.file = edited;
            photo.preview = URL.createObjectURL(edited);
            renderFeedPhotos();
        },
        'feed-story-toggle': el => {
            s.feedStory = !s.feedStory;
            el.setAttribute('aria-pressed', String(s.feedStory));
            if (s.feedStory) app.showToast('This post will also go on your story');
        },
        'feed-video': async el => {
            if (!window.diaryStories) return;
            const [file] = await Media.pickFiles('video/*', false);
            if (!file) return;
            app.openPopover(el, [
                { label: 'Post as a reel', icon: 'i-reel', onClick: () => window.diaryStories.addReel(file) },
                { label: 'Add to your story', icon: 'i-plus', onClick: () => window.diaryStories.addStory(file) },
                { label: 'Both — reel and story', icon: 'i-sparkle', onClick: () => window.diaryStories.addReel(file, { alsoStory: true }) }
            ]);
        },
        'repost': el => toggleRepost(el.dataset.id),
        'share-own': el => {
            const post = postsFor('entry').find(p => p.id === el.dataset.id);
            if (post) openShareOwn(el, post);
        },
        'feed-top': () => {
            document.querySelector('.main-col').scrollTo({ top: 0, behavior: 'smooth' });
            window.scrollTo({ top: 0, behavior: 'smooth' });
        },
        'go-reels': () => app.setView('reels'),
        'go-library': () => app.setView('library'),
        'feed-tab': el => {
            s.feedAuthor = null;
            if (el.dataset.tab === 'saved') s.feedFilter = 'saved';
            else {
                s.feedFilter = 'all';
                s.feedSort = el.dataset.tab;
            }
            app.render();
        },
        'feed-search-toggle': () => {
            s.feedSearchOpen = !s.feedSearchOpen;
            app.render();
            if (s.feedSearchOpen) $('feed-search')?.focus();
        },
        'feed-refresh': () => {
            s.feedStale = false;
            s.feed = null;
            app.render();
            document.querySelector('.main-col').scrollTo({ top: 0, behavior: 'smooth' });
            window.scrollTo({ top: 0, behavior: 'smooth' });
        },
        'post-menu': el => {
            if (el.dataset.kind === 'post' && window.diaryCommunities) return window.diaryCommunities.postMenu(el);
            const post = findPost('entry', el.dataset.id);
            if (!post) return;
            const mine = post.author === s.profile.id;
            const key = `entry:${post.id}`;
            const common = [
                ...(s.detail === key ? [] : [{ label: 'Open post', icon: 'i-chat', onClick: () => openPost(key) }]),
                ...(window.Speak && window.Speak.supported ? [{ label: 'Listen (read aloud)', icon: 'i-volume', onClick: () => {
                    const who = post.author === s.profile.id ? 'your post' : `${(post.author_profile && post.author_profile.display_name) || 'a friend'}’s post`;
                    window.Speak.read([post.title, post.body].filter(Boolean).join('. '), { title: post.title || who });
                } }] : []),
                { label: 'Copy text', icon: 'i-file', onClick: async () => {
                    try {
                        await navigator.clipboard.writeText([post.title, post.body].filter(Boolean).join('\n\n'));
                        app.showToast('Copied');
                    } catch (err) {
                        app.showToast('Couldn’t copy on this device');
                    }
                } }
            ];
            const report = !mine && window.diarySafety ? [{ label: 'Report post', icon: 'i-flag', onClick: () => window.diarySafety.report('entry', post.id, { who: (post.author_profile && post.author_profile.display_name) || '' }) }] : [];
            const items = mine
                ? [
                    { label: 'Open entry', icon: 'i-edit', onClick: () => {
                        closePost();
                        const local = app.getNotes().find(n => n.id === post.local_id);
                        if (local) app.openNote(local.id);
                        else app.showToast('That entry isn’t on this device');
                    } },
                    { label: 'Reshare to the feed', icon: 'i-repost', onClick: () => reshareOwn(post.id) },
                    { label: 'Add to your story', icon: 'i-plus', onClick: () => window.diaryStories && window.diaryStories.shareEntry(post.local_id, post.title || post.body, post) },
                    post.audience === 'public'
                        ? { label: 'Only friends can see this', icon: 'i-lock', onClick: () => setAudience(post, 'friends') }
                        : { label: 'Let everyone see this', icon: 'i-globe', onClick: () => setAudience(post, 'public') },
                    post.allow_reposts === false
                        ? { label: 'Allow reposts', icon: 'i-repost', onClick: () => setAllowReposts(post, true) }
                        : { label: 'Turn off reposts', icon: 'i-repost', onClick: () => setAllowReposts(post, false) },
                    { label: 'Stop sharing', icon: 'i-lock', danger: true, onClick: () => {
                        closePost();
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
                    { label: s.saved.has(post.id) ? 'Remove from Saved' : 'Save post', icon: 'i-bookmark', onClick: () => toggleSaved('entry', post.id) },
                    ...(post.reposts.some(r => r.user_id === s.profile.id)
                        ? [{ label: 'Undo repost', icon: 'i-repost', onClick: () => toggleRepost(post.id) }]
                        : []),
                    ...(s.friends.some(f => f.id === post.author) ? [{ label: 'Message', icon: 'i-chat', onClick: () => { app.setView('messages'); openChat(post.author); } }] : []),
                    { label: `More from ${post.author_profile ? post.author_profile.display_name : 'them'}`, icon: 'i-user', onClick: () => { closePost(); s.feedAuthor = post.author; app.render(); } }
                ];
            app.openPopover(el, [...common, ...postExtras('entry', post), ...items, ...report]);
        },
        'announce-hide': el => {
            const hidden = load('diaryHiddenAnnouncements', []);
            save('diaryHiddenAnnouncements', [...hidden, el.dataset.id].slice(-30));
            el.closest('.announce')?.remove();
        },
        'feed-audience': el => app.openPopover(el, [
            { label: 'Friends — only your friends', icon: 'i-lock', onClick: () => { s.feedAudience = 'friends'; save('diaryFeedAudience', 'friends'); app.render(); } },
            { label: 'Everyone — anyone on Cordial and your followers', icon: 'i-globe', onClick: () => { s.feedAudience = 'public'; save('diaryFeedAudience', 'public'); app.render(); } }
        ]),
        'find-people': () => { app.setView('explore'); setTimeout(() => document.getElementById('ex-search')?.focus(), 350); },
        'suggest-add': el => {
            s.suggestions = s.suggestions.filter(p => p.username !== el.dataset.username);
            addFriend(el.dataset.username);
        },
        'feed-photo': el => {
            const entry = s.urls.get(`${FEED_BUCKET}:${el.dataset.img}`);
            if (entry) Media.lightbox(entry.url);
        },
        'find-friends': () => app.setView('messages'),
        'like': el => toggleLike(el.dataset.kind, el.dataset.id),
        'reactors': el => openReactors(el.dataset.kind, el.dataset.id),
        'comments-open': el => openPost(el.dataset.key),
        'comments-focus': el => openPost(el.dataset.key, { focus: 'input' }),
        'post-open': el => openPost(el.dataset.key, { focus: el.dataset.focus }),
        'comment-mic': el => {
            const form = el.closest('form[data-form="comment"]');
            if (form) startVoiceComment(form);
        },
        'follow': el => toggleFollow(el.dataset.id, el.dataset.name),
        'go-notes': () => app.setView('home'),
        'tag-insert': el => insertTag(el),
        'chat-refresh': () => refreshChat(),
        'chat-wallpaper': () => {
            const friend = s.friends.find(f => f.id === s.activeFriend);
            if (!friend || !window.ChatWallpaper) return;
            window.ChatWallpaper.open('dm:' + friend.id, { label: friend.display_name, onDone: () => window.ChatWallpaper.apply(document.getElementById('chat-thread'), 'dm:' + friend.id) });
        },
        'vc-send': () => finishVoiceComment(true),
        'vc-cancel': () => finishVoiceComment(false),
        'comment-delete': el => deleteComment(el.dataset.key, el.dataset.id),
        // In the post view a photo opens full screen; on a card one tap opens the post (a double tap likes it instead)
        'post-photo': el => {
            if (el.closest('#post-view') || !el.dataset.key) {
                openZoom(el);
                return;
            }
            clearTimeout(s.photoTap);
            s.photoTap = setTimeout(() => openPost(el.dataset.key), 260);
        },
        'expand-post': el => toggleText(el.parentElement.querySelector('.post-text')),
        // Tap the text itself to expand or collapse a long post (links inside still work)
        'toggle-text': (el, e) => {
            if (e.target.closest('a')) return;
            if (window.getSelection && String(window.getSelection()).length) return; // selecting text, not tapping
            toggleText(el);
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
        'convo-menu': el => convoMenu(el, el.dataset.id),
        'chat-block': () => {
            const friend = s.friends.find(f => f.id === s.activeFriend);
            if (friend && window.diarySafety) window.diarySafety.block(friend);
        },
        'chat-unblock': () => {
            const friend = s.friends.find(f => f.id === s.activeFriend);
            if (friend && window.diarySafety) window.diarySafety.unblock(friend);
        },
        'chat-report': () => {
            const friend = s.friends.find(f => f.id === s.activeFriend);
            if (friend && window.diarySafety) window.diarySafety.report('user', friend.id, { who: friend.display_name, offerBlock: window.diarySafety.isBlocked(friend.id) ? null : friend });
        },
        'msg-report': el => {
            closeReactBar();
            const friend = s.friends.find(f => f.id === s.activeFriend);
            if (window.diarySafety) window.diarySafety.report('dm', el.dataset.id, { who: friend ? friend.display_name : '', offerBlock: friend && !window.diarySafety.isBlocked(friend.id) ? friend : null });
        },
        'msg-translate': el => {
            closeReactBar();
            const m = findMessage(el.dataset.id);
            if (m && window.diaryChatTools) window.diaryChatTools.aiTranslate(Rich.toText(m.body || ''));
        },
        'chat-ai': el => {
            const friend = s.friends.find(f => f.id === s.activeFriend);
            const tools = window.diaryChatTools;
            if (!friend || !tools) return;
            const thread = s.threads[friend.id] || [];
            const unread = (s.unreadMark && s.unreadMark.friendId === friend.id && s.unreadMark.count) || 0;
            app.openPopover(el, [
                { label: 'Summarise this chat', icon: 'i-list', onClick: () => tools.aiSummarise(dmConv(friend), thread) },
                ...(unread ? [{ label: `Summarise the ${unread} unread`, icon: 'i-list', onClick: () => tools.aiSummarise(dmConv(friend), thread.slice(-Math.max(unread, 1) - 4), { unreadOnly: true }) }] : []),
                { label: 'Suggest replies', icon: 'i-chat', onClick: () => tools.aiReplies(dmConv(friend), thread, text => {
                    const input = $('chat-input');
                    if (!input) return;
                    input.innerHTML = Rich.textToHTML(text);
                    saveDraft();
                    input.focus();
                    Rich.placeCaretAtEnd(input);
                }) }
            ]);
        },
        'contact-open': el => window.diaryProfile && window.diaryProfile.open(el.dataset.id),
        'msg-retry': el => {
            const m = findMessage(el.dataset.id);
            if (m) sendQueued(m);
        },
        'msg-forward': el => {
            const m = findMessage(el.dataset.id);
            closeReactBar();
            if (m && window.diaryChatTools) window.diaryChatTools.openForward({ kind: 'dm', body: m.body, attachments: m.attachments, bucket: BUCKET });
        },
        'msg-link': async el => {
            closeReactBar();
            try {
                await navigator.clipboard.writeText(messageLink(s.activeFriend, el.dataset.id));
                app.showToast('Link copied — it opens this message for people in this chat');
            } catch (e) {
                app.showToast('Couldn’t copy the link');
            }
        },
        'chat-search': () => {
            const friend = s.friends.find(f => f.id === s.activeFriend);
            if (!friend || !window.diaryChatTools) return;
            window.diaryChatTools.openSearch(dmConv(friend));
        },
        'chat-gallery': () => {
            const friend = s.friends.find(f => f.id === s.activeFriend);
            if (friend && window.diaryChatTools) window.diaryChatTools.openGallery(dmConv(friend));
        },
        'chat-incognito': el => incognitoMenu(el),
        'close-chat': () => {
            if (s.activeFriend) pruneVanished(s.activeFriend, true);
            // Going back through history keeps Back / Forward in step with what's on screen
            if (history.state && history.state.chat) return history.back();
            const pane = content.querySelector('.chat-pane');
            const animated = pane && document.body.classList.contains('chat-open')
                && !(document.documentElement.dataset.motion === 'reduce' || window.matchMedia('(prefers-reduced-motion: reduce)').matches);
            if (!animated) {
                s.activeFriend = null;
                app.render();
                return;
            }
            pane.classList.add('leaving');
            setTimeout(() => { s.activeFriend = null; app.render(); }, 220);
        },
        'react': el => react(el.dataset.id, el.dataset.emoji),
        'msg-menu': el => {
            const open = el.closest('.msg').classList.contains('menu-open');
            if (open) closeReactBar();
            else openReactBar(el.dataset.id);
        },
        'msg-reply': el => startReply(el.dataset.id),
        'msg-unsend': el => { closeReactBar(); unsend(el.dataset.id); },
        'msg-edit': el => startEdit(el.dataset.id),
        'msg-delete': el => deleteMessage(el.dataset.id, el.closest('.msg')?.querySelector('.msg-card') || el),
        'cancel-edit': () => cancelEdit(),
        'msg-history': el => {
            if (el.dataset.kind === 'dm') showHistory('dm', el.dataset.id, findMessage(el.dataset.id));
        },
        'chat-recent-deleted': () => {
            const friend = s.friends.find(f => f.id === s.activeFriend);
            openRecentlyDeleted('dm', s.activeFriend, {
                title: 'Recently deleted',
                nameOf: id => (friend && friend.id === id ? friend.display_name : ''),
                onRestored: () => loadThread(s.activeFriend)
            });
        },
        'msg-copy': async el => {
            closeReactBar();
            const m = findMessage(el.dataset.id);
            try {
                await navigator.clipboard.writeText(Rich.toText(m.body || ''));
                app.showToast('Copied');
            } catch (err) {
                app.showToast('Couldn’t copy on this device');
            }
        },
        'cancel-reply': () => { delete s.replyTo[s.activeFriend]; renderReplyBar(); },
        'jump-msg': el => jumpTo(el.dataset.id),
        'chat-jump': el => {
            const t = $('chat-thread');
            if (t) t.scrollTo({ top: t.scrollHeight, behavior: 'smooth' });
            el.hidden = true;
        },
        'quick-reply': el => {
            const input = $('chat-input');
            if (!input) return;
            input.innerHTML = esc(el.dataset.text);
            sendMessage();
        },
        'toggle-info': () => { s.showInfo = !s.showInfo; app.render(); },
        'toggle-mute': () => {
            const id = s.activeFriend;
            const on = isMuted('dm', id);
            setPref('dm', id, { muted_until: on ? null : FOREVER });
            app.showToast(on ? 'Notifications on' : 'Notifications muted');
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
        'people-add': async el => {
            el.disabled = true;
            el.textContent = 'Sending…';
            await addFriend(el.dataset.username);
            setRelation(el.dataset.person, s.friends.some(f => f.id === el.dataset.person) ? 'friend' : 'requested');
        },
        'people-accept': async el => {
            el.disabled = true;
            await respond(el.dataset.id, true);
            setRelation(el.dataset.person, 'friend');
        },
        'decline-request': el => respond(el.dataset.id, false),
        'cancel-request': el => removeFriendship(el.dataset.id),
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
            { label: 'Drawing', icon: 'i-draw', onClick: drawForChat },
            ...(window.LiveLocation && window.LiveLocation.supported ? [{ label: 'Live location', icon: 'i-pin', onClick: shareLocationInChat }] : []),
            { label: 'Contact card', icon: 'i-contact', onClick: () => pickContact(el, card => sendAttachmentOnly(s.activeFriend, [card])) },
            ...(window.diarySchedule ? [{ label: 'Schedule a message', icon: 'i-clock', onClick: () => window.diarySchedule.chatSchedule(s.activeFriend) }] : []),
            { label: 'Improve my wording ✨', icon: 'i-sparkle', onClick: () => {
                const input = $('chat-input');
                if (window.diaryChatTools && input) window.diaryChatTools.aiGrammar(Rich.toText(input.innerHTML), text => { input.innerHTML = Rich.textToHTML(text); saveDraft(); Rich.placeCaretAtEnd(input); });
            } },
            { label: s.showFormat ? 'Hide text formatting' : 'Text formatting', icon: 'i-edit', onClick: () => {
                s.showFormat = !s.showFormat;
                $('chat-toolbar').hidden = !s.showFormat;
                $('chat-input').focus();
            } }
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
        } else if (form.dataset.form === 'comment') {
            const input = form.querySelector('input');
            const body = input.value.trim();
            if (!body) return;
            input.value = '';
            addComment(form.dataset.key, body).then(ok => { if (!ok) input.value = body; });
        }
    });

    content.addEventListener('keydown', e => {
        if (e.target.id === 'chat-input' && e.key === 'Enter' && !e.shiftKey && !e.defaultPrevented) {
            e.preventDefault();
            sendMessage();
        }
    });

    content.addEventListener('input', e => {
        if (e.target.id === 'chat-input') {
            saveDraft();
            if (Rich.toText(e.target.innerHTML)) sendTyping();
            else sendTyping(true);
        }
        if (e.target.id === 'feed-text' || e.target.id === 'cm-text') suggestTags(e.target);
        if (e.target.id === 'feed-text') {
            s.feedDraft.text = e.target.value;
            e.target.closest('.post-composer')?.classList.toggle('open', !!e.target.value || s.feedDraft.photos.length > 0);
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
            content.querySelectorAll('.convo-wrap[data-search]').forEach(row => {
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

    function save(key, value) {
        try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* private mode: just this visit */ }
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
