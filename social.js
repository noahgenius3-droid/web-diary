// Accounts, friends, direct messages and the friends feed (Supabase).
// Diary entries stay in this browser; only entries marked "Share with friends" are uploaded.
document.addEventListener('DOMContentLoaded', () => {
    const app = window.diaryApp;
    const cfg = window.DIARY_CONFIG;
    const $ = id => document.getElementById(id);
    const esc = app.escapeHTML;
    const content = $('content');
    const USERNAME_RE = /^[a-z0-9_]{3,20}$/;

    const available = !!(window.supabase && cfg);
    const client = available ? window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseKey) : null;

    const s = {
        session: null,
        profile: null,
        friends: [],       // accepted: { friendshipId, id, username, display_name }
        incoming: [],      // requests sent to me
        outgoing: [],      // requests I sent
        unread: {},        // friend id -> unread count
        feed: null,        // null = not loaded yet
        feedLoading: false,
        threads: {},       // friend id -> messages, oldest first
        activeFriend: null,
        drafts: {},
        chatFocused: false,
        remoteIds: new Set(), // local ids of my entries that exist in the feed
        channel: null
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
        if (view !== 'messages') return;
        const thread = $('chat-thread');
        if (thread) thread.scrollTop = thread.scrollHeight;
        const input = $('chat-input');
        if (input && s.activeFriend) {
            input.value = s.drafts[s.activeFriend] || '';
            autoGrow(input);
            if (s.chatFocused) input.focus();
        }
    };

    // Keep shared entries in sync with the feed
    app.on('note', note => {
        if (!signedIn()) return;
        if (note.shared && !note.trashedAt) upsertShared(note);
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

        await Promise.all([loadFriends(), loadUnread(), loadRemoteIds()]);
        subscribe();
        syncAllShared();
        app.render();
        if (event === 'SIGNED_IN' && previousUser === null) app.showToast(`Signed in as @${s.profile.username}`);
    }

    function resetSocial() {
        if (s.channel) client.removeChannel(s.channel);
        Object.assign(s, {
            profile: null, friends: [], incoming: [], outgoing: [], unread: {}, feed: null,
            threads: {}, activeFriend: null, drafts: {}, remoteIds: new Set(), channel: null
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
        const me = s.profile.id;
        s.channel = client.channel(`diary-${me}`)
            .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'diary_messages', filter: `recipient=eq.${me}` },
                payload => onIncomingMessage(payload.new))
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
    }

    // ---------- Friends ----------
    async function loadFriends() {
        const { data, error } = await client.from('diary_friendships').select(`
            id, status, requester, addressee,
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
            const item = { friendshipId: f.id, ...other };
            if (f.status === 'accepted') s.friends.push(item);
            else if (f.addressee === me) s.incoming.push(item);
            else s.outgoing.push(item);
        });
        s.friends.sort((a, b) => a.display_name.localeCompare(b.display_name));
        if (s.activeFriend && !s.friends.some(f => f.id === s.activeFriend)) s.activeFriend = null;
        updateBadge();
    }

    async function addFriend(username) {
        const { data, error } = await client.rpc('diary_send_friend_request', { target_username: username });
        if (error) return app.showToast(error.message);
        await loadFriends();
        const friend = s.friends.find(f => f.friendshipId === data.id);
        app.showToast(friend ? `You and ${friend.display_name} are now friends` : 'Friend request sent');
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
    async function loadUnread() {
        const { data, error } = await client.from('diary_messages')
            .select('sender').eq('recipient', s.profile.id).is('read_at', null);
        if (error) return;
        s.unread = {};
        data.forEach(m => { s.unread[m.sender] = (s.unread[m.sender] || 0) + 1; });
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
        app.render();
        const input = $('chat-input');
        if (input && window.matchMedia('(hover: hover)').matches) input.focus();
    }

    async function sendMessage() {
        const input = $('chat-input');
        const friendId = s.activeFriend;
        const body = input.value.trim();
        if (!body || !friendId) return;
        input.value = '';
        s.drafts[friendId] = '';
        autoGrow(input);

        const { data, error } = await client.from('diary_messages')
            .insert({ recipient: friendId, body: body.slice(0, 4000) }).select().single();
        if (error) {
            app.showToast('Message not sent');
            input.value = body;
            return;
        }
        (s.threads[friendId] = s.threads[friendId] || []).push(data);
        appendBubble(data);
    }

    function onIncomingMessage(m) {
        const thread = s.threads[m.sender];
        if (thread && !thread.some(x => x.id === m.id)) thread.push(m);

        const viewing = app.state.view === 'messages' && s.activeFriend === m.sender && document.visibilityState === 'visible';
        if (viewing) {
            appendBubble(m);
            s.unread[m.sender] = 1;
            markRead(m.sender);
            return;
        }
        s.unread[m.sender] = (s.unread[m.sender] || 0) + 1;
        updateBadge();
        const friend = s.friends.find(f => f.id === m.sender);
        app.showToast(`New message from ${friend ? friend.display_name : 'a friend'}`);
        if (app.state.view === 'messages') app.render();
    }

    function appendBubble(m) {
        const thread = $('chat-thread');
        if (!thread || s.activeFriend !== (m.sender === s.profile.id ? m.recipient : m.sender)) return;
        const empty = thread.querySelector('.chat-empty');
        if (empty) empty.remove();
        thread.insertAdjacentHTML('beforeend', bubble(m));
        thread.scrollTop = thread.scrollHeight;
    }

    // ---------- Feed ----------
    async function loadFeed() {
        if (s.feedLoading) return;
        s.feedLoading = true;
        const { data, error } = await client.from('diary_shared_entries').select(`
            id, author, title, body, color, mood, written_at, shared_at,
            author_profile:diary_profiles!diary_shared_entries_author_fkey(username, display_name),
            likes:diary_entry_likes(user_id)
        `).order('shared_at', { ascending: false }).limit(50);
        s.feedLoading = false;
        s.feed = error ? [] : data;
        s.feedError = error ? error.message : null;
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
        app.getNotes().filter(n => n.shared && !n.trashedAt).forEach(upsertShared);
    }

    async function upsertShared(note) {
        const { error } = await client.from('diary_shared_entries').upsert({
            author: s.profile.id,
            local_id: note.id,
            title: note.title.slice(0, 200),
            body: note.text.slice(0, 20000),
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
        const posts = s.feed.map(p => {
            const author = p.author_profile || { username: 'unknown', display_name: 'Someone' };
            const mine = p.author === me;
            const liked = p.likes.some(l => l.user_id === me);
            const long = p.body.length > 420 || p.body.split('\n').length > 7;
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
                        <p class="post-text${long ? ' clamped' : ''}">${esc(p.body)}</p>
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
                        <h2>Friends’ updates</h2>
                        <p class="muted">Entries you and your friends chose to share.</p>
                    </div>
                    <div class="head-actions">
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

    app.views.messages = () => {
        app.setTitle('Messages');
        const blocked = gate('Chat privately with friends and see what they’re writing.');
        if (blocked) return blocked;

        const friend = s.friends.find(f => f.id === s.activeFriend);
        const person = (f, extra = '') => `
            <span class="avatar sm">${esc(app.initials(f.display_name))}</span>
            <span class="friend-name">${esc(f.display_name)}<small>@${esc(f.username)}</small></span>${extra}`;

        const incoming = s.incoming.map(f => `
            <div class="friend-row static">${person(f)}
                <span class="row-actions">
                    <button class="chip" data-action="accept-request" data-id="${esc(f.friendshipId)}">Accept</button>
                    <button class="chip danger" data-action="decline-request" data-id="${esc(f.friendshipId)}" aria-label="Decline">✕</button>
                </span>
            </div>`).join('');

        const friends = s.friends.map(f => {
            const unread = s.unread[f.id] ? `<span class="badge">${s.unread[f.id]}</span>` : '';
            return `<button class="friend-row${f.id === s.activeFriend ? ' active' : ''}" data-action="open-chat" data-id="${esc(f.id)}">${person(f, unread)}</button>`;
        }).join('');

        const outgoing = s.outgoing.map(f => `
            <div class="friend-row static">${person(f)}
                <button class="chip" data-action="cancel-request" data-id="${esc(f.friendshipId)}">Cancel</button>
            </div>`).join('');

        return `
            <div class="messenger${friend ? ' has-active' : ''}">
                <aside class="friends-pane">
                    <form class="add-friend" data-form="add-friend">
                        <input id="add-friend-input" placeholder="Add a friend by username" autocomplete="off" aria-label="Friend's username">
                        <button class="primary-btn">Add</button>
                    </form>
                    <p class="muted small">Your username is <strong>@${esc(s.profile.username)}</strong> — share it so friends can add you.</p>
                    ${incoming ? `<h4 class="pane-label">Friend requests</h4>${incoming}` : ''}
                    <h4 class="pane-label">Friends</h4>
                    ${friends || '<p class="muted small">No friends yet. Add someone by their username.</p>'}
                    ${outgoing ? `<h4 class="pane-label">Waiting for reply</h4>${outgoing}` : ''}
                </aside>
                <section class="chat-pane">
                    ${friend ? chatPane(friend) : '<div class="chat-placeholder"><svg class="i"><use href="#i-chat"/></svg><p>Pick a friend to start chatting.</p></div>'}
                </section>
            </div>`;
    };

    function chatPane(friend) {
        const thread = s.threads[friend.id];
        const body = !thread
            ? '<p class="chat-empty">Loading…</p>'
            : thread.length
                ? thread.map(bubble).join('')
                : `<p class="chat-empty">Say hi to ${esc(friend.display_name)} 👋</p>`;
        return `
            <header class="chat-head">
                <button class="icon-btn back-chat" data-action="close-chat" aria-label="Back to friends"><svg class="i"><use href="#i-back"/></svg></button>
                <span class="avatar sm">${esc(app.initials(friend.display_name))}</span>
                <div class="friend-name">${esc(friend.display_name)}<small>@${esc(friend.username)}</small></div>
                <button class="more-btn" data-action="friend-menu" data-id="${esc(friend.id)}" aria-label="Friend options"><svg class="i"><use href="#i-more"/></svg></button>
            </header>
            <div class="chat-thread" id="chat-thread">${body}</div>
            <form class="chat-compose" data-form="send-message">
                <textarea id="chat-input" rows="1" maxlength="4000" placeholder="Message ${esc(friend.display_name)}…" aria-label="Message"></textarea>
                <button class="primary-btn send-btn" aria-label="Send"><svg class="i"><use href="#i-send"/></svg></button>
            </form>`;
    }

    function bubble(m) {
        const mine = m.sender === s.profile.id;
        const time = new Date(m.created_at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
        return `<div class="bubble${mine ? ' mine' : ''}"><p>${esc(m.body)}</p><time>${time}</time></div>`;
    }

    // ---------- View actions ----------
    Object.assign(app.actions, {
        'sign-in': () => openAuth(),
        'refresh-feed': () => { s.feed = null; app.render(); },
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
        'open-chat': el => openChat(el.dataset.id),
        'close-chat': () => { s.activeFriend = null; app.render(); },
        'accept-request': el => respond(el.dataset.id, true),
        'decline-request': el => respond(el.dataset.id, false),
        'cancel-request': el => removeFriendship(el.dataset.id),
        'friend-menu': el => {
            const friend = s.friends.find(f => f.id === el.dataset.id);
            if (!friend) return;
            app.openPopover(el, [{
                label: 'Remove friend', icon: 'i-trash', danger: true,
                onClick: () => removeFriendship(friend.friendshipId, {
                    title: `Remove ${friend.display_name}?`,
                    text: 'You’ll stop seeing each other’s shared entries and won’t be able to message until you’re friends again.',
                    ok: 'Remove'
                })
            }]);
        }
    });

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
        if (e.target.id === 'chat-input' && e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            sendMessage();
        }
    });

    content.addEventListener('input', e => {
        if (e.target.id === 'chat-input') {
            s.drafts[s.activeFriend] = e.target.value;
            autoGrow(e.target);
        }
    });
    content.addEventListener('focusin', e => { if (e.target.id === 'chat-input') s.chatFocused = true; });
    content.addEventListener('focusout', e => {
        if (e.target.id === 'chat-input' && e.relatedTarget) s.chatFocused = false;
    });

    // Catch up on anything missed while the tab was hidden
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState !== 'visible' || !signedIn()) return;
        if (app.state.view === 'messages' && s.activeFriend) {
            loadThread(s.activeFriend);
            markRead(s.activeFriend);
        } else {
            loadUnread();
        }
    });

    // ---------- Helpers ----------
    const MOOD_EMOJI = { happy: '😊', calm: '😌', thoughtful: '🤔', sad: '😔', stressed: '😤' };

    function autoGrow(el) {
        el.style.height = 'auto';
        el.style.height = Math.min(el.scrollHeight, 160) + 'px';
    }

    function timeAgo(iso) {
        const seconds = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
        if (seconds < 60) return 'just now';
        const units = [['year', 31536000], ['month', 2592000], ['week', 604800], ['day', 86400], ['hour', 3600], ['minute', 60]];
        const [unit, size] = units.find(([, size]) => seconds >= size);
        return new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' }).format(-Math.floor(seconds / size), unit);
    }
});
