// Notifications: a bell with an unread badge, a notification centre, live toasts and (opt-in)
// device alerts through the browser's Notification API while Cordial is open.
document.addEventListener('DOMContentLoaded', () => {
    const app = window.diaryApp;
    const social = window.diarySocial;
    const I = social && social.internals;
    if (!I) return;
    const { client, state: s, esc, avatar, avatarUrl, timeAgo } = I;
    const $ = id => document.getElementById(id);
    const panel = $('notif-panel');
    const canAlert = 'Notification' in window;

    const n = { userId: null, items: [], loaded: false, open: false, fresh: new Set(), channel: null };

    // ---------- Lifecycle ----------
    setInterval(() => {
        const id = s.profile && s.profile.id;
        if (id && n.userId !== id) start(id);
        if (!id && n.userId) stop();
    }, 1000);

    async function start(id) {
        stop();
        n.userId = id;
        await load();
        n.channel = client.channel(`diary-notify-${id}`)
            .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'diary_notifications', filter: `user_id=eq.${id}` },
                payload => onNew(payload.new))
            .subscribe();
        if (alertStatus() === 'on') subscribePush();
    }

    function stop() {
        if (n.channel) client.removeChannel(n.channel);
        Object.assign(n, { userId: null, items: [], loaded: false, fresh: new Set(), channel: null });
        close();
        paintBadge();
    }

    async function load() {
        const { data } = await client.from('diary_notifications')
            .select('*, actor_profile:diary_profiles!diary_notifications_actor_fkey(id, username, display_name, avatar_path)')
            .order('created_at', { ascending: false })
            .limit(60);
        n.items = data || [];
        n.loaded = true;
        paintBadge();
        if (n.open) paintPanel();
    }

    async function onNew(row) {
        if (n.items.some(x => x.id === row.id)) return;
        let actor = row.actor && s.friends.find(f => f.id === row.actor);
        if (!actor && row.actor) {
            const { data } = await client.from('diary_profiles').select('id, username, display_name, avatar_path').eq('id', row.actor).maybeSingle();
            actor = data;
        }
        const item = { ...row, actor_profile: actor || null };
        n.items.unshift(item);
        n.items = n.items.slice(0, 80);
        paintBadge();
        if (n.open) paintPanel();

        const plain = describe(item, true);
        if (item.type === 'call_started') showCallBanner(item);
        else if (item.type === 'live_started') showLivePopup(item);
        else if (item.type !== 'missed_call') app.showToast(plain);
        deviceAlert(item, plain);
    }

    // ---------- Text & navigation ----------
    const CATEGORY = {
        friend_request: ['friend', 'i-user-plus'], friend_accepted: ['friend', 'i-user'],
        entry_like: ['like', 'i-heart-fill'], post_like: ['like', 'i-heart-fill'],
        entry_comment: ['comment', 'i-chat'], post_comment: ['comment', 'i-chat'],
        community_post: ['group', 'i-users'], community_join: ['group', 'i-users'],
        call_started: ['call', 'i-phone'], missed_call: ['missed', 'i-phone-off'],
        entry_repost: ['group', 'i-repost'], reel_like: ['like', 'i-heart-fill'], reel_comment: ['comment', 'i-chat'], library_like: ['like', 'i-heart-fill'],
        live_started: ['call', 'i-live'], new_follower: ['group', 'i-user-plus'],
        entry_reaction: ['like', 'i-smile'], story_reaction: ['like', 'i-smile'],
        book_request: ['group', 'i-store'], book_request_update: ['group', 'i-store'], book_message: ['comment', 'i-store']
    };

    // plain=true gives text for toasts and device alerts
    function describe(x, plain = false) {
        const d = x.data || {};
        const actorName = (x.actor_profile && x.actor_profile.display_name) || 'Someone';
        const who = plain ? actorName : `<strong>${esc(actorName)}</strong>`;
        const group = d.community_name ? (plain ? `${d.emoji || ''} ${d.community_name}`.trim() : `<strong>${esc(d.emoji || '')} ${esc(d.community_name)}</strong>`) : '';
        const quote = d.snippet ? (plain ? ` “${d.snippet}”` : ` <span class="notif-quote">“${esc(d.snippet)}”</span>`) : '';
        switch (x.type) {
            case 'friend_request': return `${who} sent you a friend request`;
            case 'friend_accepted': return `${who} accepted your friend request — say hi!`;
            case 'entry_like': return `${who} liked your post${quote}`;
            case 'entry_comment': return `${who} commented:${quote}`;
            case 'post_like': return `${who} liked your post in ${group}`;
            case 'post_comment': return `${who} commented on your post in ${group}:${quote}`;
            case 'community_post': return `${who} posted in ${group}:${quote}`;
            case 'community_join': return `${who} joined ${group}`;
            case 'call_started': return `${who} started a voice call in ${group}`;
            case 'missed_call': return `Missed voice call from ${who}`;
            case 'entry_repost': return `${who} reposted your post${quote}`;
            case 'reel_like': return `${who} liked your reel${quote}`;
            case 'reel_comment': return `${who} commented on your reel:${quote}`;
            case 'library_like': return `${who} loved your writing${quote}`;
            case 'live_started': return `${who} is live now${quote}`;
            case 'new_follower': return `${who} started following you`;
            case 'entry_reaction': return `${who} reacted ${d.emoji || ''} to your post`;
            case 'story_reaction': return `${who} reacted ${d.emoji || ''} to your story`;
            case 'book_request': {
                const t = plain ? `“${d.title || 'your book'}”` : `<strong>${esc(d.title || 'your book')}</strong>`;
                return `${who} ${d.kind === 'rent' ? 'wants to rent' : d.kind === 'gift' ? 'would love your free copy of' : 'wants to buy'} ${t}`;
            }
            case 'book_request_update': {
                const t = plain ? `“${d.title || 'the book'}”` : `<strong>${esc(d.title || 'the book')}</strong>`;
                const verb = { accepted: 'accepted your request for', declined: 'declined your request for', completed: 'marked the handover done for', cancelled: 'cancelled the request for' }[d.status] || 'updated the request for';
                return `${who} ${verb} ${t}`;
            }
            case 'book_message': return `${who} sent you a message about ${plain ? `“${d.title || 'a book'}”` : `<strong>${esc(d.title || 'a book')}</strong>`}`;
            default: return `${who} did something`;
        }
    }

    function navigate(x) {
        const d = x.data || {};
        close();
        switch (x.type) {
            case 'friend_request':
                app.setView('messages');
                I.setInboxTab('requests');
                break;
            case 'friend_accepted':
            case 'missed_call':
                app.setView('messages');
                if (s.friends.some(f => f.id === x.actor)) I.openChat(x.actor);
                break;
            case 'live_started':
                if (window.diaryLive) window.diaryLive.watch(d.stream_id);
                break;
            case 'new_follower':
                I.loadFollows().then(() => app.render());
                app.setView('settings');
                break;
            case 'entry_reaction':
                app.setView('feed');
                I.focusPost(`entry:${d.entry}`, { open: false });
                break;
            case 'story_reaction':
                if (window.diaryStories && window.diaryStories.openMine) window.diaryStories.openMine();
                break;
            case 'book_request':
            case 'book_request_update':
            case 'book_message':
                app.setView('market');
                if (window.diaryMarket) window.diaryMarket.openRequest(d.request);
                break;
            case 'library_like':
                app.setView('library');
                if (window.diaryLibrary) window.diaryLibrary.open(d.item_id);
                break;
            case 'reel_like':
            case 'reel_comment':
                app.setView('reels', { reelId: d.reel_id });
                if (x.type === 'reel_comment' && window.diaryStories) window.diaryStories.openReelComments(d.reel_id);
                break;
            case 'entry_like':
            case 'entry_repost':
            case 'entry_comment':
                app.setView('feed');
                I.focusPost(`entry:${d.entry_id}`, { open: x.type === 'entry_comment' });
                break;
            case 'post_like':
            case 'post_comment':
            case 'community_post':
                app.setView('community', { communityId: d.community_id });
                I.focusPost(`post:${d.post_id}`, { open: x.type === 'post_comment' });
                break;
            case 'community_join':
            case 'call_started':
                app.setView('community', { communityId: d.community_id });
                break;
        }
    }

    // ---------- Badge ----------
    const unread = () => n.items.filter(x => !x.read_at).length;

    function paintBadge() {
        const count = unread();
        $('bell-count').textContent = count ? String(Math.min(count, 99)) : '';
        $('bell-btn').setAttribute('aria-label', count ? `Notifications, ${count} unread` : 'Notifications');
        document.title = (count ? `(${count}) ` : '') + document.title.replace(/^\(\d+\)\s/, '');
    }

    // Views reset the page title, so re-apply the unread count after each render
    const previousAfter = app.hooks.afterRender;
    app.hooks.afterRender = view => {
        if (previousAfter) previousAfter(view);
        paintBadge();
    };

    // ---------- Panel ----------
    $('bell-btn').addEventListener('click', e => {
        e.stopPropagation();
        if (!s.profile) {
            social.requireSignIn('Sign in to get notifications from friends and groups.');
            return;
        }
        n.open ? close() : openPanel();
    });

    function openPanel() {
        n.open = true;
        panel.hidden = false;
        document.body.classList.add('notif-open');
        // Everything unread right now stays highlighted while the panel is open
        n.fresh = new Set(n.items.filter(x => !x.read_at).map(x => x.id));
        paintPanel();
        if (!n.loaded) load();
        setTimeout(markAllRead, 1200);
    }

    function close() {
        n.open = false;
        panel.hidden = true;
        document.body.classList.remove('notif-open');
    }

    async function markAllRead() {
        const ids = n.items.filter(x => !x.read_at).map(x => x.id);
        if (!ids.length) return;
        const now = new Date().toISOString();
        n.items.forEach(x => { if (!x.read_at) x.read_at = now; });
        paintBadge();
        await client.from('diary_notifications').update({ read_at: now }).in('id', ids);
    }

    function paintPanel() {
        const alerts = alertStatus();
        $('notif-alerts').innerHTML = alerts === 'ask' ? `
            <div class="notif-optin">
                <svg class="i"><use href="#i-bell"/></svg>
                <span><strong>Get alerts on this device</strong><small>Messages from friends, likes, comments and group calls</small></span>
                <button class="chip accent" data-n-act="enable-alerts">Turn on</button>
            </div>` : alerts === 'on' ? `
            <div class="notif-optin quiet">
                <span><small>Device alerts are on</small></span>
                <button class="link-btn" data-n-act="disable-alerts">Turn off</button>
            </div>` : '';

        if (!n.loaded) {
            $('notif-list').innerHTML = '<p class="muted small notif-empty">Loading…</p>';
            return;
        }
        if (!n.items.length) {
            $('notif-list').innerHTML = `
                <div class="notif-empty">
                    <span class="notif-empty-icon"><svg class="i"><use href="#i-bell"/></svg></span>
                    <p><strong>You’re all caught up</strong></p>
                    <p class="muted small">Likes, comments, friend requests and group activity will show up here.</p>
                </div>`;
            return;
        }
        const fresh = n.items.filter(x => n.fresh.has(x.id));
        const earlier = n.items.filter(x => !n.fresh.has(x.id));
        $('notif-list').innerHTML = [
            fresh.length ? `<p class="notif-group">New</p>${fresh.map(itemHTML).join('')}` : '',
            earlier.length ? `<p class="notif-group">Earlier</p>${earlier.map(itemHTML).join('')}` : ''
        ].join('');
    }

    function itemHTML(x) {
        const [cat, icon] = CATEGORY[x.type] || ['group', 'i-bell'];
        const actor = x.actor_profile || { id: x.actor, display_name: 'Someone' };
        const d = x.data || {};
        let actions = '';
        if (x.type === 'friend_request' && d.friendship_id) {
            actions = `<span class="notif-actions">
                <button class="chip accent" data-n-act="accept" data-fid="${esc(d.friendship_id)}">Accept</button>
                <button class="chip" data-n-act="decline" data-fid="${esc(d.friendship_id)}">Decline</button></span>`;
        } else if (x.type === 'call_started') {
            actions = `<span class="notif-actions"><button class="chip call-chip" data-n-act="join"><svg class="i"><use href="#i-phone"/></svg>Join call</button></span>`;
        } else if (x.type === 'missed_call') {
            actions = `<span class="notif-actions"><button class="chip call-chip" data-n-act="callback"><svg class="i"><use href="#i-phone"/></svg>Call back</button></span>`;
        }
        return `
            <div class="notif${n.fresh.has(x.id) ? ' unread' : ''}" data-n="${esc(x.id)}" role="button" tabindex="0">
                <span class="notif-avatar">${avatar(actor, 'md')}<span class="notif-type t-${cat}"><svg class="i"><use href="#${icon}"/></svg></span></span>
                <span class="notif-main">
                    <span class="notif-text">${describe(x)}</span>
                    <time>${timeAgo(x.created_at)}</time>
                    ${actions}
                </span>
                <button class="notif-dismiss" data-n-act="dismiss" aria-label="Remove notification"><svg class="i"><use href="#i-close"/></svg></button>
            </div>`;
    }

    panel.addEventListener('click', async e => {
        e.stopPropagation();
        const act = e.target.closest('[data-n-act]');
        const row = e.target.closest('[data-n]');
        const item = row && n.items.find(x => x.id === row.dataset.n);

        if (act) {
            const what = act.dataset.nAct;
            if (what === 'enable-alerts') return enableAlerts();
            if (what === 'disable-alerts') {
                try { localStorage.setItem('diaryAlerts', '0'); } catch (err) {}
                return paintPanel();
            }
            if (!item) return;
            if (what === 'dismiss') {
                n.items = n.items.filter(x => x.id !== item.id);
                paintPanel();
                paintBadge();
                client.from('diary_notifications').delete().eq('id', item.id);
            } else if (what === 'accept' || what === 'decline') {
                act.disabled = true;
                await I.respond(act.dataset.fid, what === 'accept');
                n.items = n.items.filter(x => x.id !== item.id);
                client.from('diary_notifications').delete().eq('id', item.id);
                app.showToast(what === 'accept' ? 'Friend added 🎉' : 'Request declined');
                paintPanel();
            } else if (what === 'join') {
                close();
                const d = item.data || {};
                if (window.diaryCalls) window.diaryCalls.joinCommunity({ id: d.community_id, name: d.community_name, emoji: d.emoji });
            } else if (what === 'callback') {
                close();
                if (window.diaryCalls && item.actor_profile) window.diaryCalls.callUser(item.actor_profile);
            }
            return;
        }
        if (item) navigate(item);
    });

    panel.addEventListener('keydown', e => {
        if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('[data-n]')) {
            e.preventDefault();
            e.target.click();
        }
    });

    $('notif-close').addEventListener('click', close);
    $('notif-readall').addEventListener('click', async e => {
        e.stopPropagation();
        n.fresh = new Set();
        await markAllRead();
        paintPanel();
    });
    document.addEventListener('click', e => {
        if (n.open && !panel.contains(e.target) && !e.target.closest('#bell-btn')) close();
    });
    document.addEventListener('keydown', e => { if (e.key === 'Escape' && n.open) close(); });

    // ---------- "Went live" pop-up ----------
    // A friend (or someone you follow) starts a live video: a card pops up with Watch / Later
    let livePop = null;
    let liveTimer = null;
    function showLivePopup(item) {
        const d = item.data || {};
        if (window.diaryCalls && window.diaryCalls.inCall && window.diaryCalls.inCall()) return app.showToast(describe(item, true));
        if (!livePop) {
            livePop = document.createElement('div');
            livePop.className = 'live-pop';
            livePop.setAttribute('role', 'alertdialog');
            livePop.setAttribute('aria-live', 'assertive');
            document.body.append(livePop);
            livePop.addEventListener('click', e => {
                const b = e.target.closest('[data-lp]');
                if (!b) return;
                hideLive();
                if (b.dataset.lp === 'watch') {
                    markRead(livePop.dataset.id);
                    if (window.diaryLive) window.diaryLive.watch(livePop.dataset.stream);
                }
            });
            document.addEventListener('keydown', e => { if (e.key === 'Escape' && livePop && !livePop.hidden) hideLive(); });
        }
        const actor = item.actor_profile || { id: item.actor, display_name: 'Someone' };
        livePop.dataset.stream = d.stream_id || '';
        livePop.dataset.id = item.id;
        livePop.innerHTML = `
            <div class="live-pop-card">
                <span class="live-pop-av">${avatar(actor, 'lg')}<span class="live-pop-badge">LIVE</span></span>
                <span class="live-pop-text">
                    <strong>${esc(actor.display_name || 'Someone')} is live now</strong>
                    <small>${esc(d.snippet || d.title || 'Tap Watch to join them')}</small>
                </span>
                <span class="live-pop-actions">
                    <button type="button" class="chip" data-lp="later">Later</button>
                    <button type="button" class="primary-btn small live-watch" data-lp="watch"><svg class="i"><use href="#i-live"/></svg>Watch</button>
                </span>
            </div>`;
        livePop.hidden = false;
        livePop.classList.remove('leaving');
        if (navigator.vibrate) navigator.vibrate([60, 40, 60]);
        livePop.querySelector('[data-lp="watch"]').focus({ preventScroll: true });
        clearTimeout(liveTimer);
        liveTimer = setTimeout(hideLive, 20000);
    }
    function hideLive() {
        clearTimeout(liveTimer);
        if (livePop) livePop.hidden = true;
    }
    function markRead(id) {
        const it = n.items.find(x => x.id === id);
        if (it && !it.read_at) {
            it.read_at = new Date().toISOString();
            client.from('diary_notifications').update({ read_at: it.read_at }).eq('id', id).then(() => paintBadge());
        }
    }

    // ---------- Group call banner ----------
    let bannerTimer = null;

    function showCallBanner(item) {
        const d = item.data || {};
        if (window.diaryCalls && window.diaryCalls.activeTopic() === `diary_call:c:${d.community_id}`) return;
        const banner = $('call-banner');
        banner.innerHTML = `
            ${avatar(item.actor_profile || { id: item.actor, display_name: 'Someone' }, 'sm')}
            <span class="banner-text">${describe(item)}</span>
            <button class="call-join" data-b="join"><svg class="i"><use href="#i-phone"/></svg>Join</button>
            <button class="icon-btn" data-b="close" aria-label="Dismiss"><svg class="i"><use href="#i-close"/></svg></button>`;
        banner.hidden = false;
        banner.onclick = e => {
            const b = e.target.closest('[data-b]');
            if (!b) return;
            banner.hidden = true;
            if (b.dataset.b === 'join' && window.diaryCalls) {
                window.diaryCalls.joinCommunity({ id: d.community_id, name: d.community_name, emoji: d.emoji });
            }
        };
        clearTimeout(bannerTimer);
        bannerTimer = setTimeout(() => { banner.hidden = true; }, 45000);
    }

    // ---------- Device alerts ----------
    function alertStatus() {
        if (!canAlert || Notification.permission === 'denied') return 'unavailable';
        let on = false;
        try { on = localStorage.getItem('diaryAlerts') === '1'; } catch (e) {}
        return on && Notification.permission === 'granted' ? 'on' : 'ask';
    }

    async function enableAlerts() {
        let permission = Notification.permission;
        if (permission !== 'granted') {
            try { permission = await Notification.requestPermission(); } catch (e) { permission = 'denied'; }
        }
        if (permission === 'granted') {
            try { localStorage.setItem('diaryAlerts', '1'); } catch (e) {}
            const pushed = await subscribePush();
            showLocal('Cordial alerts are on', pushed
                ? 'You’ll get friend requests and new followers here — even when Cordial is closed.'
                : 'You’ll hear from friends and groups here while Cordial is open.');
        } else {
            app.showToast('Alerts were blocked — you can allow them in your browser settings');
        }
        paintPanel();
    }

    async function disableAlerts() {
        try { localStorage.removeItem('diaryAlerts'); } catch (e) {}
        await unsubscribePush();
        paintPanel();
    }

    // Android Chrome has no `new Notification()`: alerts must go through the service worker there
    async function showLocal(title, body, opts = {}) {
        try {
            const reg = await swReady();
            if (reg) return await reg.showNotification(title, { body, icon: '/icons/icon-192.png', badge: '/icons/icon-192.png', ...opts });
            const alert = new Notification(title, { body, ...opts });
            if (opts.onclick) alert.onclick = opts.onclick;
        } catch (e) { /* some browsers only allow alerts from installed apps */ }
    }

    // ---------- Push (alerts while Cordial is closed) ----------
    const PUSH_TYPES = new Set(['friend_request', 'friend_accepted', 'new_follower', 'live_started']);
    const pushKey = () => (window.DIARY_CONFIG || {}).pushPublicKey;
    const pushSupported = () => canAlert && 'serviceWorker' in navigator && 'PushManager' in window && !!pushKey();
    const swReady = () => ('serviceWorker' in navigator && navigator.serviceWorker.controller !== undefined)
        ? Promise.race([navigator.serviceWorker.ready, new Promise(r => setTimeout(() => r(null), 4000))]).catch(() => null)
        : Promise.resolve(null);
    const keyBytes = b64 => {
        const raw = atob(b64.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (b64.length % 4)) % 4));
        return Uint8Array.from(raw, c => c.charCodeAt(0));
    };

    async function subscribePush() {
        if (!pushSupported() || Notification.permission !== 'granted' || !s.profile) return false;
        try {
            const reg = await swReady();
            if (!reg) return false;
            let sub = await reg.pushManager.getSubscription();
            try {
                if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(pushKey()) });
            } catch (e) {
                // An old subscription made with a different key: replace it
                if (sub) await sub.unsubscribe();
                sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(pushKey()) });
            }
            const j = sub.toJSON();
            const { error } = await client.rpc('diary_save_push_subscription', {
                p_endpoint: j.endpoint, p_p256dh: j.keys.p256dh, p_auth: j.keys.auth, p_user_agent: navigator.userAgent.slice(0, 300)
            });
            return !error;
        } catch (e) {
            console.warn('[push] subscribe failed', e);
            return false;
        }
    }

    // Signing out (or turning alerts off) stops this device getting that account's alerts
    async function unsubscribePush() {
        try {
            const reg = await swReady();
            const sub = reg && await reg.pushManager.getSubscription();
            if (!sub) return;
            if (s.profile) await client.from('diary_push_subscriptions').delete().eq('endpoint', sub.endpoint);
            await sub.unsubscribe();
        } catch (e) { /* nothing to undo */ }
    }

    function deviceAlert(item, text) {
        if (alertStatus() !== 'on') return;
        if (PUSH_TYPES.has(item.type) && pushSupported()) return; // the push alert covers this one
        if (document.visibilityState === 'visible' && document.hasFocus()) return; // already on screen as a toast
        const actor = item.actor_profile;
        showLocal('Cordial', text, {
            tag: item.id,
            icon: actor && actor.avatar_path ? avatarUrl(actor.avatar_path) : '/icons/icon-192.png',
            onclick: () => { window.focus(); navigate(item); }
        });
    }

    // Missed calls are logged by the callee's own device (call.js calls this)
    window.diaryNotify = {
        alertStatus, enableAlerts, disableAlerts, unsubscribePush, pushSupported, showLivePopup,
        logMissedCall(callerId) {
            if (!s.profile || !callerId) return;
            client.from('diary_notifications').insert({ actor: callerId, type: 'missed_call', data: {} }).then(() => {});
        }
    };
});
