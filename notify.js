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
        else if (item.type !== 'missed_call') app.showToast(plain);
        deviceAlert(item, plain);
    }

    // ---------- Text & navigation ----------
    const CATEGORY = {
        friend_request: ['friend', 'i-user-plus'], friend_accepted: ['friend', 'i-user'],
        entry_like: ['like', 'i-heart-fill'], post_like: ['like', 'i-heart-fill'],
        entry_comment: ['comment', 'i-chat'], post_comment: ['comment', 'i-chat'],
        community_post: ['group', 'i-users'], community_join: ['group', 'i-users'],
        call_started: ['call', 'i-phone'], missed_call: ['missed', 'i-phone-off']
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
            case 'entry_like':
            case 'entry_comment':
                app.setView('feed');
                if (x.type === 'entry_comment') I.openComments(`entry:${d.entry_id}`);
                I.focusPost(`entry:${d.entry_id}`);
                break;
            case 'post_like':
            case 'post_comment':
            case 'community_post':
                app.setView('community', { communityId: d.community_id });
                if (x.type === 'post_comment') I.openComments(`post:${d.post_id}`);
                I.focusPost(`post:${d.post_id}`);
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
            new Notification('Cordial alerts are on', { body: 'You’ll hear from friends and groups here while Cordial is open.' });
        } else {
            app.showToast('Alerts were blocked — you can allow them in your browser settings');
        }
        paintPanel();
    }

    function deviceAlert(item, text) {
        if (alertStatus() !== 'on') return;
        if (document.visibilityState === 'visible' && document.hasFocus()) return; // already on screen as a toast
        try {
            const actor = item.actor_profile;
            const alert = new Notification('Cordial', {
                body: text,
                tag: item.id,
                icon: actor && actor.avatar_path ? avatarUrl(actor.avatar_path) : undefined
            });
            alert.onclick = () => {
                window.focus();
                navigate(item);
                alert.close();
            };
        } catch (e) { /* some mobile browsers only allow alerts from installed apps */ }
    }

    // Missed calls are logged by the callee's own device (call.js calls this)
    window.diaryNotify = {
        logMissedCall(callerId) {
            if (!s.profile || !callerId) return;
            client.from('diary_notifications').insert({ actor: callerId, type: 'missed_call', data: {} }).then(() => {});
        }
    };
});
