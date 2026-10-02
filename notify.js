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

    const n = { userId: null, items: [], loaded: false, open: false, fresh: new Set(), channel: null, filter: 'all' };

    // Same grouping as the server's notification categories (Settings → Notifications)
    function categoryOf(t) {
        if (['entry_like', 'post_like', 'reel_like', 'library_like', 'entry_reaction', 'story_reaction', 'entry_repost'].includes(t)) return 'reactions';
        if (['entry_comment', 'post_comment', 'reel_comment', 'post_activity'].includes(t)) return 'comments';
        if (['mention', 'reply'].includes(t)) return 'mentions';
        if (['new_follower', 'friend_request', 'friend_accepted', 'new_post'].includes(t)) return 'people';
        if (['community_post', 'community_join', 'call_started'].includes(t)) return 'groups';
        return 'other';
    }
    const FILTERS = [['all', 'All'], ['mentions', 'Mentions'], ['comments', 'Comments'], ['reactions', 'Reactions'], ['people', 'People'], ['groups', 'Groups'], ['other', 'More']];

    // Several people doing the same thing to the same post become one line: "Ada and 3 others reacted…"
    const GROUPABLE = new Set(['entry_like', 'post_like', 'reel_like', 'library_like', 'entry_reaction', 'story_reaction', 'entry_repost', 'entry_comment', 'post_comment', 'reel_comment', 'post_activity', 'community_join']);
    function targetOf(x) {
        const d = x.data || {};
        return d.entry_id || d.entry || d.post_id || d.reel_id || d.story || d.item_id || (x.type === 'community_join' ? d.community_id : '') || '';
    }
    function grouped(list) {
        const out = [];
        const byKey = new Map();
        list.forEach(x => {
            const key = GROUPABLE.has(x.type) && targetOf(x) ? `${x.type === 'entry_reaction' ? 'entry_like' : x.type}:${targetOf(x)}` : null;
            const head = key && byKey.get(key);
            if (head) {
                if (x.actor && x.actor !== head.actor && !head._others.some(o => o.actor === x.actor)) head._others.push(x);
                head._ids.push(x.id);
                return;
            }
            const item = { ...x, _others: [], _ids: [x.id] };
            if (key) byKey.set(key, item);
            out.push(item);
        });
        return out;
    }

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

        if (item.type.startsWith('scheduled_') && window.diarySchedule) window.diarySchedule.refresh();
        const plain = describe(item, true);
        if (item.type === 'call_started') { if (!(window.diaryCalls && window.diaryCalls.ringGroup && window.diaryCalls.ringGroup(item))) showCallBanner(item); }
        else if (item.type === 'live_started') showLivePopup(item);
        else if (item.type !== 'missed_call') app.showToast(plain);
        deviceAlert(item, plain);
    }

    // ---------- Text & navigation ----------
    const CATEGORY = {
        friend_request: ['friend', 'i-user-plus'], friend_accepted: ['friend', 'i-user'],
        entry_like: ['like', 'i-thumb'], post_like: ['like', 'i-thumb'], post_activity: ['comment', 'i-bell'],
        scheduled_published: ['group', 'i-clock'], scheduled_failed: ['missed', 'i-alert'], trivia_rank: ['like', 'i-trophy'], badge_earned: ['like', 'i-trophy'], announcement: ['group', 'i-sparkle'], verification_update: ['friend', 'i-verified'],
        support_reply: ['comment', 'i-chat'], helpline_handoff: ['missed', 'i-chat'],
        comment_reply: ['comment', 'i-reply'], referral_joined: ['friend', 'i-user-plus'], tagged: ['comment', 'i-user'], game_invite: ['friend', 'i-g-tiles'], game_turn: ['like', 'i-g-tiles'], game_over: ['like', 'i-trophy'],
        entry_comment: ['comment', 'i-chat'], post_comment: ['comment', 'i-chat'],
        community_post: ['group', 'i-users'], community_join: ['group', 'i-users'],
        call_started: ['call', 'i-phone'], missed_call: ['missed', 'i-phone-off'],
        entry_repost: ['group', 'i-repost'], reel_like: ['like', 'i-heart-fill'], reel_comment: ['comment', 'i-chat'], library_like: ['like', 'i-heart-fill'],
        live_started: ['call', 'i-live'], new_post: ['friend', 'i-feed'], space_live: ['call', 'i-headphones'], new_follower: ['group', 'i-user-plus'],
        entry_reaction: ['like', 'i-smile'], story_reaction: ['like', 'i-smile'],
        mention: ['comment', 'i-chat'], reply: ['comment', 'i-reply'], new_login: ['missed', 'i-shield'],
        book_request: ['group', 'i-store'], book_request_update: ['group', 'i-store'], book_message: ['comment', 'i-store']
    };

    // plain=true gives text for toasts and device alerts
    function describe(x, plain = false) {
        const d = x.data || {};
        const actorName = (x.actor_profile && x.actor_profile.display_name) || 'Someone';
        const others = (x._others || []).length;
        const more = others ? ` and ${others} ${others === 1 ? 'other' : 'others'}` : '';
        const who = more ? (plain ? `${actorName}${more}` : `<button type="button" class="name-link" data-profile="${esc(x.actor)}">${esc(actorName)}</button>${more}`) : plain ? actorName : x.actor ? `<button type="button" class="name-link" data-profile="${esc(x.actor)}">${esc(actorName)}</button>` : `<strong>${esc(actorName)}</strong>`;
        const group = d.community_name ? (plain ? `${d.emoji || ''} ${d.community_name}`.trim() : `<strong>${esc(d.emoji || '')} ${esc(d.community_name)}</strong>`) : '';
        const quote = d.snippet ? (plain ? ` “${d.snippet}”` : ` <span class="notif-quote">“${esc(d.snippet)}”</span>`) : '';
        switch (x.type) {
            case 'friend_request': return d.note ? `${who} said hello and wants to be friends:${plain ? ` “${d.note}”` : ` <span class="notif-quote">“${esc(d.note)}”</span>`}` : `${who} sent you a friend request`;
            case 'friend_accepted': return `${who} accepted your friend request — say hi!`;
            case 'entry_like': return `${who} reacted ${d.emoji || '👍'} to your post${quote}`;
            case 'entry_comment': return `${who} commented:${quote}`;
            case 'post_like': return `${who} reacted ${d.emoji || '👍'} to your post in ${group}`;
            case 'announcement': return `${plain ? '📣 ' : ''}${plain ? (d.title || 'News from Cordial') : `<strong>${esc(d.title || 'News from Cordial')}</strong>`}${d.snippet ? ` — ${plain ? d.snippet : esc(d.snippet)}` : ''}`;
            case 'verification_update': return d.approved ? `Your account is now verified ✓${d.note ? ` — ${plain ? d.note : esc(d.note)}` : ''}` : `Your verification request wasn’t approved${d.note ? `: ${plain ? d.note : esc(d.note)}` : ''}`;
            case 'comment_reply': return `${who} replied to your comment:${quote}`;
            case 'tagged': return `${who} tagged you in ${d.kind === 'comment' ? 'a comment' : 'a post'}${group ? ` in ${group}` : ''}:${quote}`;
            case 'referral_joined': return `🎉 ${who} joined Cordial with your invite — you’re now friends`;
            case 'game_invite': return `${who} challenged you to a game of Wordplay`;
            case 'game_turn': return d.kind === 'pass' ? `${who} passed — your turn in Wordplay` : d.kind === 'swap' ? `${who} swapped letters — your turn in Wordplay`
                : d.kind === 'resign' ? `${who} left your Wordplay match — your turn`
                : `${who} played ${plain ? (d.word || 'a word') : `<strong>${esc(d.word || 'a word')}</strong>`} for ${Number(d.points || 0)} — your turn in Wordplay`;
            case 'game_over': return d.won ? `🏆 You won your Wordplay match${d.resigned ? ` — ${who} resigned` : ` with ${Number(d.score || 0)} points`}` : `Your Wordplay match with ${who} is over — you scored ${Number(d.score || 0)}`;
            case 'support_reply': return `${plain ? (d.ai ? 'Cordial Assistant (AI)' : 'Cordial') : `<strong>${d.ai ? 'Cordial Assistant (AI)' : 'Cordial'}</strong>`} replied${d.subject ? ` about “${plain ? d.subject : esc(d.subject)}”` : ''}${d.snippet ? `: ${plain ? d.snippet : esc(d.snippet)}` : ''}`;
            case 'helpline_handoff': return `🙋 A helpline conversation needs you: ${plain ? `“${d.subject || ''}”` : `<strong>${esc(d.subject || '')}</strong>`}${d.reason ? ` — ${plain ? d.reason : esc(d.reason)}` : ''}`;
            case 'badge_earned': return `🏅 You earned the <strong>${esc(d.name || 'a new')}</strong> badge — ${esc(d.description || '')}`.replace(/<\/?strong>/g, m => (plain ? '' : m));
            case 'trivia_rank': {
                const place = d.rank === 1 ? '🥇 You came first' : d.rank === 2 ? '🥈 You came second' : d.rank === 3 ? '🥉 You came third' : `You placed #${d.rank}`;
                return `${place} of ${d.players} in ${d.kind === 'weekly' ? 'last week’s Weekly challenge' : 'yesterday’s Daily trivia'} — ${d.correct}/${d.total}, ${Number(d.score || 0).toLocaleString()} points`;
            }
            case 'scheduled_published': return d.target === 'message' ? `Your scheduled message was sent:${quote}` : d.target === 'group' ? `Your scheduled post is live in ${group || 'your group'}:${quote}` : `Your scheduled post is live:${quote}`;
            case 'scheduled_failed': return `A scheduled ${d.target === 'message' ? 'message' : 'post'} couldn’t go out — ${plain ? (d.reason || 'something went wrong') : esc(d.reason || 'something went wrong')}:${quote}`;
            case 'post_activity': return `${who} commented on a post you follow${group ? ` in ${group}` : ''}:${quote}`;
            case 'post_comment': return `${who} commented on your post in ${group}:${quote}`;
            case 'community_post': return `${who} posted in ${group}:${quote}`;
            case 'community_join': return `${who} joined ${group}`;
            case 'call_started': return `${who} started a ${d.video ? 'video' : 'voice'} call in ${group}`;
            case 'missed_call': return `Missed voice call from ${who}`;
            case 'entry_repost': return `${who} reposted your post${quote}`;
            case 'reel_like': return `${who} liked your reel${quote}`;
            case 'new_post': return `${who} posted on the Feed${quote || (d.photos ? ` — ${d.photos === 1 ? 'a photo' : `${d.photos} photos`}` : '')}`;
            case 'reel_comment': return `${who} commented on your reel:${quote}`;
            case 'library_like': return `${who} loved your writing${quote}`;
            case 'live_started': return `${who} is live now${quote}`;
            case 'space_live': return `🎙️ ${who} opened a space:${quote}`;
            case 'new_follower': return `${who} started following you`;
            case 'new_login': return `New sign-in to your account on ${plain ? (d.label || 'a new device') : `<strong>${esc(d.label || 'a new device')}</strong>`}. Not you? Change your password and sign out other devices.`;
            case 'mention': return d.everyone ? `${who} mentioned everyone in ${group}:${quote}` : `${who} mentioned you in ${group}:${quote}`;
            case 'reply': return `${who} replied to you in ${group}:${quote}`;
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
            case 'space_live':
                if (window.diarySpaces) window.diarySpaces.open(d.space_id);
                else app.setView('spaces');
                break;
            case 'new_follower':
                I.loadFollows().then(() => app.render());
                if (window.diaryProfile && x.actor) window.diaryProfile.open(x.actor);
                else app.setView('profile', { profileId: x.actor });
                break;
            case 'new_login':
                app.setView('settings');
                break;
            case 'mention':
            case 'reply':
                if (window.diaryGroupChat && window.diaryGroupChat.jump) window.diaryGroupChat.jump(d.community_id, d.message_id);
                app.setView('community', { communityId: d.community_id });
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
            case 'new_post':
            case 'entry_like':
            case 'entry_repost':
            case 'entry_comment':
            case 'entry_reaction':
                app.setView('feed');
                I.openEntry(d.entry_id || d.entry, x.type === 'entry_comment' ? { focus: 'input' } : undefined);
                break;
            case 'post_activity':
                if (d.kind === 'entry' && d.entry_id) { app.setView('feed'); I.openEntry(d.entry_id); }
                else if (d.post_id) { app.setView('community', { communityId: d.community_id }); I.focusPost(`post:${d.post_id}`, { open: true }); }
                break;
            case 'scheduled_published':
                if (d.target === 'feed') { app.setView('feed'); I.openEntry(d.ref); }
                else if (d.target === 'group') app.setView('post', { postId: `g-${d.ref}` });
                else { app.setView('messages'); if (I.openChat && d.recipient) I.openChat(d.recipient); }
                break;
            case 'scheduled_failed':
                app.setView('scheduled');
                break;
            case 'trivia_rank':
            case 'badge_earned':
                app.setView('play');
                break;
            case 'tagged':
                if (d.entry_id) { app.setView('feed'); I.openEntry(d.entry_id); }
                else if (d.post_id) app.setView('post', { postId: `g-${d.post_id}` });
                else if (d.reel_id) app.setView('reels', { reelId: d.reel_id });
                break;
            case 'referral_joined':
                if (window.diaryProfile && x.actor) window.diaryProfile.open(x.actor);
                break;
            case 'comment_reply':
                if (d.entry_id) { app.setView('feed'); I.openEntry(d.entry_id, { focus: 'input' }); }
                else if (d.post_id) app.setView('post', { postId: `g-${d.post_id}` });
                else if (d.reel_id) app.setView('reels', { reelId: d.reel_id });
                break;
            case 'game_invite':
            case 'game_turn':
            case 'game_over':
                app.setView('play');
                if (window.diaryGames && window.diaryGames.openMatch) window.diaryGames.openMatch(d.match_id);
                break;
            case 'announcement':
                app.setView('feed');
                break;
            case 'verification_update':
                app.setView('settings');
                break;
            case 'support_reply':
                if (window.diarySupport) window.diarySupport.open(d.ticket || null);
                break;
            case 'helpline_handoff':
                if (window.diaryHelpline) window.diaryHelpline.open(d.ticket);
                break;
            case 'post_like':
            case 'post_comment':
            case 'community_post':
                if (d.post_id) app.setView('post', { postId: `g-${d.post_id}` });
                else app.setView('community', { communityId: d.community_id });
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
        const counts = {};
        n.items.forEach(x => { const c = categoryOf(x.type); counts[c] = (counts[c] || 0) + (x.read_at ? 0 : 1); });
        $('notif-filters').innerHTML = FILTERS.filter(([k]) => k === 'all' || n.items.some(x => categoryOf(x.type) === k)).map(([k, l]) =>
            `<button type="button" role="tab" class="notif-filter" data-n-filter="${k}" aria-selected="${n.filter === k}">${l}${k !== 'all' && counts[k] ? ` <span class="nf-dot">${counts[k]}</span>` : ''}</button>`).join('');
        const shown = n.filter === 'all' ? n.items : n.items.filter(x => categoryOf(x.type) === n.filter);
        if (!shown.length) {
            $('notif-list').innerHTML = '<div class="notif-empty"><p class="muted small">Nothing here right now.</p></div>';
            return;
        }
        const fresh = grouped(shown.filter(x => n.fresh.has(x.id)));
        const earlier = grouped(shown.filter(x => !n.fresh.has(x.id)));
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
            <div class="notif${n.fresh.has(x.id) ? ' unread' : ''}" data-n="${esc(x.id)}" data-n-ids="${esc((x._ids || [x.id]).join(','))}" role="button" tabindex="0">
                <span class="notif-avatar${(x._others || []).length ? ' stacked' : ''}"${x.actor ? ` data-profile="${esc(x.actor)}"` : ''}>${avatar(actor, 'md')}${(x._others || []).length ? avatar(x._others[0].actor_profile || { id: x._others[0].actor, display_name: 'Someone' }, 'sm') : ''}<span class="notif-type t-${cat}"><svg class="i"><use href="#${icon}"/></svg></span></span>
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
        const filter = e.target.closest('[data-n-filter]');
        if (filter) { n.filter = filter.dataset.nFilter; return paintPanel(); }
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
                const ids = (row.dataset.nIds || item.id).split(',');
                n.items = n.items.filter(x => !ids.includes(x.id));
                paintPanel();
                paintBadge();
                client.from('diary_notifications').delete().in('id', ids);
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
    const PUSH_TYPES = new Set(['friend_request', 'friend_accepted', 'new_follower', 'live_started', 'mention', 'reply', 'new_login', 'call_started']);
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
        // Message previews off: the alert only says who it's from
        let previews = '1';
        try { previews = localStorage.getItem('diaryPreviews') || '1'; } catch (e) {}
        if (previews === '0') text = `New notification from ${(item.actor_profile && item.actor_profile.display_name) || 'someone'}`;
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
        alertStatus, enableAlerts, disableAlerts, unsubscribePush, pushSupported, showLivePopup, close, navigate,
        logMissedCall(callerId) {
            if (!s.profile || !callerId) return;
            client.from('diary_notifications').insert({ actor: callerId, type: 'missed_call', data: {} }).then(() => {});
        }
    };
});
