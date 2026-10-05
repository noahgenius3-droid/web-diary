// Profiles: everyone has their own page (#/profile/<id>). Tap a name or a picture anywhere — posts, comments,
// reactions, chats, group chat, calls, search, notifications — to open it. It shows who they are (photo, name,
// @username, bio, location, interests, when they joined), their numbers (posts, followers, following, reactions,
// reposts), how you're connected, and tabs for their posts and reposts; your own page adds your activity and an
// editor. What others see follows their privacy settings (Settings → Privacy), enforced by the server.
document.addEventListener('DOMContentLoaded', () => {
    const app = window.diaryApp;
    const social = window.diarySocial;
    if (!app || !social || !social.internals) return;
    const I = social.internals;
    const { client, state: s, esc, avatar, timeAgo, hydrateStorage } = I;
    const content = document.getElementById('content');

    const P = { id: null, data: null, loading: false, error: false, tab: 'posts', posts: null, reposts: null, activity: null, token: 0 };
    const me = () => s.profile && s.profile.id;
    const fmt = n => (n >= 10000 ? `${Math.round(n / 1000)}k` : n >= 1000 ? `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k` : String(n || 0));

    function open(id) {
        if (!id || !s.profile) return;
        const dlg = document.querySelector('.profile-sheet[open]');
        if (dlg) dlg.close();
        if (I.closePost) I.closePost();
        if (window.diaryNotify && window.diaryNotify.close) window.diaryNotify.close();
        if (app.state.view === 'profile' && app.state.profileId === id) return;
        app.setView('profile', { profileId: id });
    }

    async function load(id) {
        const token = ++P.token;
        Object.assign(P, { id, data: null, loading: true, error: false, posts: null, reposts: null, activity: null, trivia: undefined, tab: 'posts' });
        const [{ data, error }] = await Promise.all([
            client.rpc('diary_profile_full', { p_id: id }),
            I.refreshPresence ? I.refreshPresence([id]) : null
        ]);
        if (token !== P.token) return;
        P.loading = false;
        P.error = !!error;
        P.data = data || null;
        paint();
        loadTab();
    }

    async function loadTab() {
        const id = P.id;
        const token = P.token;
        if (!P.data || P.data.blocked) return;
        if ((P.tab === 'posts' || P.tab === 'photos') && P.posts === null) {
            const { data } = await client.from('diary_shared_entries').select(I.FEED_SELECT).eq('author', id).order('shared_at', { ascending: false }).limit(40);
            if (token !== P.token) return;
            P.posts = (data || []).map(p => (I.decorateRepost(p), p));
            s.profilePosts = P.posts;
            paint();
            I.loadPreviews(P.posts);
        } else if (P.tab === 'reposts' && P.reposts === null) {
            const { data } = await client.from('diary_reposts')
                .select(`created_at, entry:diary_shared_entries!diary_reposts_entry_id_fkey(${I.FEED_SELECT})`)
                .eq('user_id', id).order('created_at', { ascending: false }).limit(40);
            if (token !== P.token) return;
            P.reposts = (data || []).map(r => r.entry).filter(e => e && e.author !== id).map(p => (I.decorateRepost(p), p));
            s.profilePosts = [...(P.posts || []), ...P.reposts];
            paint();
        } else if (P.tab === 'about' && P.trivia === undefined && window.diaryPlay) {
            P.trivia = null;
            const [t, b] = await Promise.all([window.diaryPlay.statsFor(id), window.diaryPlay.badgesFor ? window.diaryPlay.badgesFor(id) : null]);
            if (token !== P.token) return;
            P.trivia = t || false;
            P.badges = b || false;
            paint();
        } else if (P.tab === 'activity' && P.activity === null && id === me()) {
            const { data } = await client.rpc('diary_my_activity', { p_limit: 40 });
            if (token !== P.token) return;
            P.activity = data || { totals: {}, items: [] };
            paint();
        }
    }

    function paint() {
        if (app.state.view !== 'profile') return;
        app.requestRender ? app.requestRender('profile') : app.render();
    }

    // ---------- The page ----------
    app.views.profile = () => {
        const id = app.state.profileId;
        app.setTitle('Profile');
        const blocked = I.gate('See people’s profiles, posts and who they follow.');
        if (blocked) return blocked;
        if (id !== P.id) { load(id); return skeleton(); }
        if (P.loading) return skeleton();
        if (!P.data) {
            return `<div class="empty"><p class="empty-title">${P.error ? 'Couldn’t load this profile' : 'This account doesn’t exist'}</p>
                <p>${P.error ? 'Check your connection and try again.' : 'It may have been deleted.'}</p>
                ${P.error ? '<button class="primary-btn" style="margin-top:14px" data-pf="retry">Try again</button>' : ''}</div>`;
        }
        const p = P.data;
        app.setTitle('Profile'); // the page is named for what it is; the person's name is right below
        return `
            <div class="pf">
                ${headerHTML(p)}
                ${p.blocked ? '' : tabsHTML(p)}
                <section class="pf-body" aria-live="polite">${p.blocked ? '' : bodyHTML(p)}</section>
            </div>`;
    };

    function skeleton() {
        return `<div class="pf pf-skel" aria-busy="true"><div class="pf-head"><div class="pf-cover"></div><div class="pf-id"><i class="sk-av xl"></i><i class="sk-line w40"></i><i class="sk-line w70"></i></div></div></div>`;
    }

    function relationOf(id) {
        if (s.friends.some(f => f.id === id)) return 'friend';
        if (s.incoming.some(f => f.id === id)) return 'incoming';
        if (s.outgoing.some(f => f.id === id)) return 'requested';
        return 'none';
    }

    function headerHTML(p) {
        const mine = p.id === me();
        const rel = relationOf(p.id);
        const online = s.online && s.online.has(p.id);
        const status = I.presenceText && !mine ? I.presenceText(p.id) : '';
        const st = I.statusOf ? I.statusOf(p.id) : null;
        const since = p.created_at ? new Date(p.created_at).toLocaleDateString(undefined, { month: 'long', year: 'numeric' }) : '';
        const following = s.following && s.following.has(p.id);
        const stats = p.stats;
        // Verification given by the Cordial team (admin): from the profile itself, or the verified list
        const vkind = p.verified || (s.verified && s.verified.get(p.id)) || '';
        const stat = (key, one, many, n) => {
            const inner = `<b>${fmt(n)}</b> ${n === 1 ? one : many}`;
            return key ? `<button type="button" class="pf-stat" data-pf="list" data-which="${key}" aria-label="${n} ${n === 1 ? one : many} — see who">${inner}</button>` : `<span class="pf-stat">${inner}</span>`;
        };
        const btn = (act, icon, label, cls = '') => `<button type="button" class="pf-btn ${cls}" data-pf="${act}"><svg class="i"><use href="#${icon}"/></svg><span>${label}</span></button>`;
        let actions;
        if (mine) {
            // Two equal labelled actions that never wrap, plus a compact invite (the common profile pattern)
            actions = btn('edit', 'i-pencil', 'Edit profile', 'primary') + btn('share', 'i-share', 'Share profile')
                + '<button type="button" class="pf-btn icon" data-pf="invite" aria-label="Invite friends" title="Invite friends"><svg class="i"><use href="#i-user-plus"/></svg></button>';
        } else if (p.blocked) {
            actions = btn('unblock', 'i-block', 'Unblock', 'primary');
        } else {
            actions = (rel !== 'friend' ? btn('follow', following ? 'i-check' : 'i-user-plus', following ? 'Following' : 'Follow', following ? 'on' : 'primary') : '')
                + (rel === 'friend' ? btn('message', 'i-chat', 'Message', 'primary')
                    : rel === 'incoming' ? btn('accept', 'i-user-plus', 'Accept request')
                    : rel === 'requested' ? '<button type="button" class="pf-btn" disabled><svg class="i"><use href="#i-user-plus"/></svg><span>Requested</span></button>'
                    : btn('add', 'i-user-plus', 'Add friend'))
                + (rel === 'friend' && window.diaryCalls ? btn('call', 'i-phone', 'Call') : '')
                + `<button type="button" class="pf-btn icon" data-pf="more" aria-label="More options" aria-haspopup="menu"><svg class="i"><use href="#i-more"/></svg></button>`;
        }
        const connections = [
            p.friends ? 'Friends' : '',
            p.follows_you ? 'Follows you' : '',
            p.mutual_friends ? `${p.mutual_friends} mutual friend${p.mutual_friends === 1 ? '' : 's'}` : '',
            p.shared_groups ? `${p.shared_groups} group${p.shared_groups === 1 ? '' : 's'} in common` : ''
        ].filter(Boolean);
        return `
            <header class="pf-head">
                <div class="pf-cover c-${esc(avatarColor(p.id))}${p.cover_path ? ' has-img' : ''}">
                    ${p.cover_path ? `<button type="button" class="pf-cover-view" data-pf="cover-view" aria-label="View ${esc(p.display_name)}’s cover photo"><img src="${esc(I.avatarUrl(p.cover_path))}" alt="" loading="lazy" decoding="async"></button>` : ''}
                    ${mine ? `<button type="button" class="pf-cover-edit" data-pf="cover" aria-haspopup="menu"><svg class="i"><use href="#i-camera"/></svg><span>${p.cover_path ? 'Edit cover' : 'Add cover'}</span></button>` : ''}
                </div>
                <div class="pf-id">
                    <div class="pf-photo${online ? ' online' : ''}${vkind ? ' is-verified' : ''}">${p.avatar_path ? `<button type="button" class="pf-photo-view" data-action="photo-view" data-name="${esc(p.display_name)}" aria-label="View ${esc(p.display_name)}’s profile photo">${avatar(p, 'xl')}</button>` : avatar(p, 'xl')}${mine ? '<button type="button" class="pf-photo-edit" data-pf="photo" aria-label="Change profile photo"><svg class="i"><use href="#i-camera"/></svg></button>' : ''}</div>
                    <div class="pf-names">
                        <h1>${esc(p.display_name)}${I.tick ? I.tick(p.id, vkind || undefined) : ''}</h1>
                        <p class="pf-handle">@${esc(p.username)}${status ? ` · <span class="pf-status${online ? ' on' : ''}" data-status="${esc(p.id)}">${esc(status)}</span>` : ''}</p>
                        ${vkind ? `<button type="button" class="pf-verified" data-pf="verified" aria-label="Verified ${VLABEL[vkind] || 'account'} — what this means"><svg class="i" aria-hidden="true"><use href="#i-verified"/></svg><span>Verified ${VLABEL[vkind] || 'account'}</span></button>` : ''}
                    </div>
                    <div class="pf-actions">${actions}</div>
                </div>
                ${st ? `<p class="pf-custom">${esc(st.label)}${st.text ? ` · ${esc(st.text)}` : ''}</p>` : ''}
                ${p.bio ? `<p class="pf-bio">${esc(p.bio)}</p>` : mine ? '<button type="button" class="link-btn accent pf-add-bio" data-pf="edit">Add a bio so people know who you are</button>' : ''}
                <ul class="pf-facts">
                    ${p.location ? `<li><svg class="i"><use href="#i-map-pin"/></svg>${esc(p.location)}</li>` : ''}
                    ${since ? `<li><svg class="i"><use href="#i-calendar"/></svg>Joined ${esc(since)}</li>` : ''}
                    ${connections.length ? `<li><svg class="i"><use href="#i-users"/></svg>${esc(connections.join(' · '))}</li>` : ''}
                </ul>
                ${p.interests && p.interests.length ? `<div class="pf-interests" aria-label="Interests">${p.interests.map(t => `<button type="button" class="pf-interest" data-pf="interest" data-q="${esc(t)}">${esc(t)}</button>`).join('')}</div>` : ''}
                ${p.blocked ? '<p class="ps-note">You blocked this person. They can’t message, call or see your posts. Unblock to see their profile.</p>'
                    : p.limited ? '<p class="ps-note">Some of this profile is only visible to their friends.</p>' : ''}
                ${stats ? `<div class="pf-stats">
                    ${stat('', 'post', 'posts', stats.posts)}
                    ${stat('friends', 'friend', 'friends', stats.friends || 0)}
                    ${stat('followers', 'follower', 'followers', stats.followers)}
                    ${stat('following', 'following', 'following', stats.following)}
                </div>
                ${stats.reactions || stats.reposts ? `<p class="pf-substats">${[stats.reactions ? `${fmt(stats.reactions)} ${stats.reactions === 1 ? 'reaction' : 'reactions'} on their posts` : '', stats.reposts ? `${fmt(stats.reposts)} ${stats.reposts === 1 ? 'repost' : 'reposts'}` : ''].filter(Boolean).join(' · ')}</p>` : ''}
                ${newcomerHTML(p)}` : p.blocked ? '' : '<p class="pf-private muted small"><svg class="i"><use href="#i-lock"/></svg>Their numbers and follower lists are private.</p>'}
            </header>`;
    }

    function newcomerHTML(p) {
        if (!p.created_at || p.blocked) return '';
        const days = Math.floor((Date.now() - Date.parse(p.created_at)) / 86400000);
        if (days > 14) return '';
        const when = days <= 0 ? 'today' : days === 1 ? 'yesterday' : `${days} days ago`;
        const first = esc((p.display_name || '').split(' ')[0] || 'them');
        if (p.id !== me()) {
            const rel = relationOf(p.id);
            const action = rel === 'friend' ? '<button type="button" class="pf-btn primary" data-pf="message"><svg class="i"><use href="#i-chat"/></svg><span>Say hello</span></button>'
                : rel === 'incoming' ? '<button type="button" class="pf-btn primary" data-pf="accept"><svg class="i"><use href="#i-user-plus"/></svg><span>Accept request</span></button>'
                : '<button type="button" class="pf-btn primary" data-pf="hello"><svg class="i"><use href="#i-chat"/></svg><span>' + (rel === 'requested' ? 'Edit your hello' : 'Say hello') + '</span></button>';
            return `
                <section class="pf-new">
                    <span class="pf-new-ic" aria-hidden="true"><svg class="i"><use href="#i-sparkle"/></svg></span>
                    <div class="pf-new-text"><strong>New to Cordial</strong><span>${first} joined ${when}. Say hello and help them feel at home.</span></div>
                    ${action}
                </section>`;
        }
        const st = p.stats || {};
        const steps = [
            { done: !!p.avatar_path, label: 'Add a profile photo', act: 'photo' },
            { done: !!(p.bio || '').trim(), label: 'Write a short bio', act: 'edit' },
            { done: (st.posts || 0) > 0, label: 'Share your first post', act: 'go-feed' },
            { done: (st.friends || 0) > 0, label: 'Make your first friend', act: 'invite' }
        ];
        const doneCount = steps.filter(x => x.done).length;
        if (doneCount === steps.length) return '';
        return `
            <section class="pf-welcome" aria-label="Getting started">
                <header><strong>Welcome to Cordial, ${first}!</strong><span>${doneCount} of ${steps.length} done</span></header>
                <div class="pf-welcome-bar" aria-hidden="true"><i style="width:${Math.round(doneCount / steps.length * 100)}%"></i></div>
                <ul>${steps.map(x => `
                    <li class="${x.done ? 'done' : ''}">
                        <span class="pf-step-dot" aria-hidden="true">${x.done ? '<svg class="i"><use href="#i-check"/></svg>' : ''}</span>
                        <span class="pf-step-label">${x.label}</span>
                        ${x.done ? '<span class="sr-only">Done</span>' : `<button type="button" class="link-btn accent" data-pf="${x.act}">${x.act === 'invite' ? 'Invite' : x.act === 'go-feed' ? 'Post' : x.act === 'photo' ? 'Add' : 'Write'}</button>`}
                    </li>`).join('')}</ul>
            </section>`;
    }

    // A steady colour per person for the cover band
    function avatarColor(id) {
        const colors = ['purple', 'blue', 'green', 'orange', 'pink', 'teal'];
        let h = 0;
        for (const ch of String(id)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
        return colors[h % colors.length];
    }

    function tabsHTML(p) {
        const mine = p.id === me();
        const tabs = [['posts', 'Posts'], ['photos', 'Photos'], ['reposts', 'Reposts'], ['about', 'About'], ...(mine ? [['activity', 'Activity']] : [])];
        return `<div class="pf-tabs" role="tablist" aria-label="Profile sections">${tabs.map(([k, l]) =>
            `<button type="button" role="tab" class="pf-tab" data-pf="tab" data-tab="${k}" aria-selected="${P.tab === k}">${l}</button>`).join('')}</div>`;
    }

    function bodyHTML(p) {
        const mine = p.id === me();
        const first = esc((p.display_name || '').split(' ')[0]);
        if (P.tab === 'posts') {
            if (P.posts === null) return '<div class="post-skel"><span class="sk-row"><i class="sk-av"></i><i class="sk-line w40"></i></span><i class="sk-line"></i><i class="sk-line w70"></i></div>';
            if (!P.posts.length) return `<div class="empty small"><p class="empty-title">No posts ${mine ? 'yet' : 'you can see'}</p><p>${mine ? 'Share an entry or write a post from the feed — it shows up here.' : p.friends ? `${first} hasn’t shared anything yet.` : `${first}’s friends-only posts show here once you’re friends. Posts for everyone always show.`}</p></div>`;
            return `<div class="feed-list">${P.posts.map(x => I.postCard(x)).join('')}</div>`;
        }
        if (P.tab === 'photos') {
            if (P.posts === null) return `<div class="pf-photos">${'<span class="pf-ph skel"></span>'.repeat(6)}</div>`;
            const photos = P.posts.flatMap(x => (x.photos || []).filter(ph => ph && typeof ph.path === 'string' && !/\.(mp4|mov|webm)$/i.test(ph.path)).map(ph => ({ ph, post: x })));
            if (!photos.length) return `<div class="empty small"><p class="empty-title">No photos ${mine ? 'yet' : 'you can see'}</p><p>${mine ? 'Photos you add to posts collect here.' : `Photos from ${first}’s posts show here.`}</p></div>`;
            return `<div class="pf-photos">${photos.slice(0, 90).map(({ ph, post }) => `
                <button type="button" class="pf-ph" data-pf="open-post" data-id="${esc(post.id)}" aria-label="Open the post with this photo">
                    <img data-path="${esc(ph.path)}" data-bucket="${esc(ph.bucket || 'diary-feed')}" alt="" loading="lazy">
                </button>`).join('')}</div>`;
        }
        if (P.tab === 'reposts') {
            if (P.reposts === null) return '<div class="post-skel"><i class="sk-line"></i><i class="sk-line w70"></i></div>';
            if (!P.reposts.length) return `<div class="empty small"><p class="empty-title">No reposts ${mine ? 'yet' : 'you can see'}</p><p>${mine ? 'Tap the repost button on a friend’s post to share it with your friends.' : 'Reposts show to their friends.'}</p></div>`;
            return `<div class="feed-list">${P.reposts.map(x => I.postCard(x)).join('')}</div>`;
        }
        if (P.tab === 'about') {
            const since = p.created_at ? new Date(p.created_at).toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' }) : '';
            const row = (icon, label, value) => (value ? `<div class="pf-about-row"><svg class="i"><use href="#${icon}"/></svg><span><small>${label}</small>${value}</span></div>` : '');
            return `
                <div class="pf-about">
                    ${row('i-user', 'Name', esc(p.display_name))}
                    ${row('i-link', 'Username', `@${esc(p.username)}`)}
                    ${row('i-edit', 'Bio', p.bio ? esc(p.bio) : '')}
                    ${row('i-map-pin', 'Location', p.location ? esc(p.location) : '')}
                    ${row('i-sparkle', 'Interests', p.interests && p.interests.length ? esc(p.interests.join(', ')) : '')}
                    ${row('i-calendar', 'Joined Cordial', since ? esc(since) : '')}
                    ${p.limited ? '<p class="muted small">More details are only visible to their friends.</p>' : ''}
                    ${P.badges && P.badges.badges ? `<h4 class="pf-sub">Level ${P.badges.level} · ${Number(P.badges.xp).toLocaleString()} XP</h4>
                        <ul class="badge-grid compact">${P.badges.badges.filter(b => b.earned_at).map(b => `<li class="bdg ${esc(b.tier)} earned" title="${esc(b.description)}"><span class="badge-medal"><svg class="i"><use href="#${esc(b.icon)}"/></svg></span><strong>${esc(b.name)}</strong></li>`).join('') || '<li class="muted small">No badges yet.</li>'}</ul>` : ''}
                    ${P.trivia && P.trivia.answered ? `<h4 class="pf-sub">Trivia</h4>
                        <div class="pf-totals">
                            <div><b>${Number(P.trivia.score || 0).toLocaleString()}</b><span>Trivia points</span></div>
                            <div><b>${P.trivia.accuracy ?? 0}%</b><span>Answers right</span></div>
                            <div><b>🔥 ${P.trivia.streak || 0}</b><span>Day streak</span></div>
                            <div><b>${esc(P.trivia.best_category && window.diaryPlay.CATS[P.trivia.best_category] ? window.diaryPlay.CATS[P.trivia.best_category][1] : '—')}</b><span>Best topic</span></div>
                        </div>` : ''}
                    ${mine ? '<p class="muted small">Choose who sees your details and numbers in <button type="button" class="link-btn accent" data-pf="privacy">Settings → Privacy</button>.</p>' : ''}
                </div>`;
        }
        if (P.tab === 'activity') {
            if (P.activity === null) return '<div class="post-skel"><i class="sk-line"></i><i class="sk-line w70"></i></div>';
            const t = P.activity.totals || {};
            const ICON = { post: 'i-edit', comment: 'i-chat', reaction: 'i-thumb', follower: 'i-user-plus' };
            const line = x => {
                if (x.kind === 'post') return `You posted <q>${esc(x.text || 'a photo')}</q>`;
                if (x.kind === 'comment') return `You commented <q>${esc(x.text || 'a voice note')}</q>`;
                if (x.kind === 'reaction') return `You reacted ${esc(x.text || '👍')} to ${esc(x.who || 'a')}’s post`;
                return `<button type="button" class="name-link" data-profile="${esc(x.ref)}">${esc(x.who || 'Someone')}</button> started following you`;
            };
            return `
                <div class="pf-activity">
                    <div class="pf-totals">
                        <div><b>${fmt(t.posts)}</b><span>Posts</span></div>
                        <div><b>${fmt(t.comments)}</b><span>Comments</span></div>
                        <div><b>${fmt(t.reactions_given)}</b><span>Reactions given</span></div>
                        <div><b>${fmt(t.followers_30d)}</b><span>New followers (30 days)</span></div>
                    </div>
                    <p class="muted small">Trivia, games, achievements and badges will show here once they arrive.</p>
                    <ol class="pf-feed">${(P.activity.items || []).map(x => `
                        <li class="pf-act">
                            <span class="pf-act-ic"><svg class="i"><use href="#${ICON[x.kind] || 'i-activity'}"/></svg></span>
                            <span class="pf-act-text">${line(x)}<time datetime="${esc(x.at)}">${esc(timeAgo(x.at))}</time></span>
                            ${x.kind === 'follower' ? '' : `<button type="button" class="link-btn" data-pf="open-ref" data-kind="${esc(x.kind)}" data-ref="${esc(x.ref)}">Open</button>`}
                        </li>`).join('') || '<li class="muted small">Nothing yet — post, comment or react and it shows up here.</li>'}</ol>
                </div>`;
        }
        return '';
    }

    // ---------- Verified by Cordial ----------
    const VLABEL = { person: 'public figure', organisation: 'organisation', minister: 'minister', educator: 'educator', administrator: 'administrator' };
    function openVerified(p) {
        const kind = p.verified || (s.verified && s.verified.get(p.id)) || '';
        if (!kind) return;
        const mine = p.id === me();
        const first = esc((p.display_name || '').split(' ')[0] || 'This account');
        const label = esc(VLABEL[kind] || 'account');
        // The perks a verified account gets (each one is live in the app)
        const perks = [
            ['i-verified', 'The blue tick, everywhere', 'Next to the name on posts, comments, chats, search and the profile'],
            ['i-user', 'A verified profile', 'A verified badge under the name and a premium ring around the photo'],
            ['i-search', 'Found first', 'Verified people appear first in people search and “People you may know”'],
            ['i-shield', 'Trust at a glance', 'People can see Cordial confirmed who they are before they follow, call or message']
        ];
        const dlg = document.createElement('dialog');
        dlg.className = 'sheet-dialog pf-vsheet';
        dlg.setAttribute('aria-labelledby', 'pf-v-title');
        dlg.innerHTML = `<div class="rx-card">
            <header class="rx-head"><h2 id="pf-v-title">Verified by Cordial</h2><button type="button" class="icon-btn" data-x="close" aria-label="Close"><svg class="i"><use href="#i-close"/></svg></button></header>
            <div class="pf-v-hero"><span class="pf-v-badge" aria-hidden="true"><svg class="i"><use href="#i-verified"/></svg></span>
                <p>${mine ? `You’re a verified <b>${label}</b> on Cordial.` : `Cordial confirmed this is the real ${first} — a verified <b>${label}</b>.`}</p></div>
            <h3 class="pf-v-h">${mine ? 'Your verified perks' : 'What verification means'}</h3>
            <ul class="pf-v-perks">${perks.map(([icon, t, d]) => `<li><span class="pf-v-ic" aria-hidden="true"><svg class="i"><use href="#${icon}"/></svg></span><span><strong>${t}</strong><small>${d}</small></span></li>`).join('')}</ul>
            <p class="muted small pf-v-foot">Verification is given by the Cordial team to recognised people, organisations, ministers and educators.</p>
        </div>`;
        document.body.append(dlg);
        dlg.showModal();
        dlg.addEventListener('close', () => dlg.remove());
        dlg.addEventListener('click', e => { if (e.target === dlg || e.target.closest('[data-x="close"]')) dlg.close(); });
    }

    // ---------- Followers / following ----------
    async function openList(which) {
        const p = P.data;
        if (!p) return;
        const dlg = document.createElement('dialog');
        dlg.className = 'sheet-dialog reactors-sheet';
        const TITLE = { followers: 'Followers', following: 'Following', friends: `${p.id === me() ? 'Your' : `${esc((p.display_name || '').split(' ')[0])}’s`} friends` };
        dlg.setAttribute('aria-label', which === 'friends' ? 'Friends' : TITLE[which]);
        dlg.innerHTML = `<div class="rx-card"><header class="rx-head"><h2>${TITLE[which]}</h2><button type="button" class="icon-btn" data-x="close" aria-label="Close"><svg class="i"><use href="#i-close"/></svg></button></header>
            <label class="search rx-search"><svg class="i"><use href="#i-search"/></svg><input type="search" placeholder="Search" aria-label="Search this list"></label>
            <div class="rx-list"><span class="lv-spinner" aria-hidden="true"></span></div></div>`;
        document.body.append(dlg);
        dlg.showModal();
        dlg.addEventListener('close', () => dlg.remove());
        let list = [];
        const paintList = () => {
            const q = dlg.querySelector('input').value.trim().toLowerCase();
            const shown = q ? list.filter(x => `${x.display_name} ${x.username}`.toLowerCase().includes(q)) : list;
            dlg.querySelector('.rx-list').innerHTML = shown.map(x => `
                <div class="rx-row">
                    <button type="button" class="rx-who" data-profile="${esc(x.id)}" aria-label="${esc(x.display_name)}’s profile">${avatar(x, 'md')}</button>
                    <button type="button" class="rx-name" data-profile="${esc(x.id)}"><strong>${esc(x.id === me() ? 'You' : x.display_name)}</strong><small>@${esc(x.username)}${x.id === me() ? '' : x.friend ? (which === 'friends' && p.id !== me() ? ' · Mutual friend' : ' · Friend') : ''}</small></button>
                    ${x.id === me() || x.friend ? '' : I.followButton({ ...x })}
                </div>`).join('') || `<p class="muted small">${q ? 'No one matches.' : which === 'followers' ? 'No followers yet.' : which === 'friends' ? 'No friends yet.' : 'Not following anyone yet.'}</p>`;
            hydrateStorage(dlg);
        };
        dlg.querySelector('input').addEventListener('input', paintList);
        dlg.addEventListener('click', e => {
            if (e.target.closest('[data-profile]')) { dlg.close(); return; }
            if (e.target === dlg || e.target.closest('[data-x="close"]')) return dlg.close();
            const f = e.target.closest('.follow-btn');
            if (f) I.toggleFollow(f.dataset.id, f.dataset.name);
        }, true);
        const { data, error } = which === 'friends'
            ? await client.rpc('diary_friends_list', { p_user: p.id, p_limit: 300 })
            : await client.rpc('diary_follow_list', { p_user: p.id, p_which: which, p_limit: 300 });
        if (!dlg.isConnected) return;
        if (error) { dlg.querySelector('.rx-list').innerHTML = '<p class="muted small">Couldn’t load this list.</p>'; return; }
        list = data || [];
        paintList();
    }

    // ---------- Editing your profile ----------
    async function openEditor() {
        const { data: details } = await client.from('diary_profile_details').select('bio, location, interests').maybeSingle();
        const d = details || { bio: '', location: '', interests: [] };
        const dlg = document.createElement('dialog');
        dlg.className = 'sheet-dialog pf-edit';
        dlg.setAttribute('aria-labelledby', 'pf-edit-title');
        dlg.innerHTML = `
            <form class="rx-card pf-edit-form" method="dialog">
                <header class="rx-head"><h2 id="pf-edit-title">Edit profile</h2><button type="button" class="icon-btn" data-x="close" aria-label="Close"><svg class="i"><use href="#i-close"/></svg></button></header>
                <div class="pf-edit-photo">${avatar(s.profile, 'xl')}<button type="button" class="chip" data-x="photo"><svg class="i"><use href="#i-camera"/></svg>Change photo</button><button type="button" class="chip" data-x="cover"><svg class="i"><use href="#i-image"/></svg>${P.data && P.data.cover_path ? 'Change cover' : 'Add cover'}</button></div>
                <label class="field"><span>Name</span><input name="display_name" maxlength="40" required value="${esc(s.profile.display_name)}" autocomplete="name"></label>
                <label class="field"><span>Bio <small class="muted" data-count="bio">${(d.bio || '').length}/300</small></span><textarea name="bio" maxlength="300" rows="3" placeholder="A line or two about you">${esc(d.bio || '')}</textarea></label>
                <label class="field"><span>Location</span><input name="location" maxlength="60" value="${esc(d.location || '')}" placeholder="City, country" autocomplete="address-level2"></label>
                <label class="field"><span>Interests</span><input name="interests" maxlength="300" value="${esc((d.interests || []).join(', '))}" placeholder="e.g. chess, bible, poetry, football" autocapitalize="none">
                    <small class="muted">Separate with commas — up to 12. People can find you by them.</small></label>
                <p class="muted small">Your @username is <strong>@${esc(s.profile.username)}</strong>. Choose who sees your details in Settings → Privacy.</p>
                <footer class="pf-edit-foot"><button type="button" class="ghost-btn" data-x="close">Cancel</button><button type="submit" class="primary-btn">Save</button></footer>
            </form>`;
        document.body.append(dlg);
        dlg.showModal();
        dlg.addEventListener('close', () => dlg.remove());
        const form = dlg.querySelector('form');
        form.bio.addEventListener('input', () => { dlg.querySelector('[data-count="bio"]').textContent = `${form.bio.value.length}/300`; });
        dlg.addEventListener('click', async e => {
            if (e.target === dlg || e.target.closest('[data-x="close"]')) return dlg.close();
            if (e.target.closest('[data-x="cover"]')) { dlg.close(); return changeCover(); }
            if (e.target.closest('[data-x="photo"]')) {
                await I.changeAvatar();
                dlg.querySelector('.pf-edit-photo .avatar')?.replaceWith(document.createRange().createContextualFragment(avatar(s.profile, 'xl')));
                hydrateStorage(dlg);
            }
        });
        hydrateStorage(dlg);
        form.addEventListener('submit', async e => {
            e.preventDefault();
            const name = form.display_name.value.trim().slice(0, 40);
            if (!name) return form.display_name.focus();
            const btn = form.querySelector('[type="submit"]');
            btn.disabled = true;
            btn.textContent = 'Saving…';
            const interests = form.interests.value.split(/[,\n#]/).map(x => x.trim().toLowerCase()).filter(x => x.length >= 2 && x.length <= 30).slice(0, 12);
            const details = { bio: form.bio.value.trim().slice(0, 300), location: form.location.value.trim().slice(0, 60), interests, updated_at: new Date().toISOString() };
            // Update your details row, or create it the first time. (Not an upsert: that also rewrites user_id,
            // which people may not change, so the database refused every save.)
            const saveDetails = async () => {
                const up = await client.from('diary_profile_details').update(details).eq('user_id', me()).select('user_id');
                if (up.error || (up.data && up.data.length)) return up;
                return client.from('diary_profile_details').insert({ user_id: me(), ...details });
            };
            const [a, b] = await Promise.all([
                name !== s.profile.display_name ? client.from('diary_profiles').update({ display_name: name }).eq('id', me()).select('id, username, display_name, avatar_path, cover_path').single() : { data: s.profile },
                saveDetails()
            ]);
            if (a.error || b.error) {
                btn.disabled = false;
                btn.textContent = 'Save';
                console.warn('Profile save failed', a.error || b.error);
                return app.showToast(`Couldn’t save your profile — ${(a.error || b.error).message || 'please try again'}`);
            }
            if (a.data) s.profile = { ...s.profile, ...a.data };
            dlg.close();
            app.showToast('Profile updated');
            load(me());
        });
    }

    // ---------- Cover photo ----------
    async function changeCover() {
        const [file] = await Media.pickFiles('image/*', false);
        if (!file) return;
        let blob;
        try { blob = await Media.compressImage(file, 1800, 0.85); } catch (e) { return app.showToast('Couldn’t read that photo — try a JPEG or PNG'); }
        if (window.PhotoEditor && blob.type !== 'image/gif') {
            const edited = await window.PhotoEditor.open(blob, { title: 'Cover photo', done: 'Use photo' });
            if (!edited) return;
            blob = edited;
        }
        app.showToast('Updating your cover…');
        const path = `${me()}/cover-${I.randomId()}.jpg`;
        const up = await client.storage.from('diary-avatars').upload(path, blob, { contentType: blob.type || 'image/jpeg', upsert: false });
        if (up.error) return app.showToast('Couldn’t upload your cover photo');
        const old = P.data && P.data.cover_path;
        const { error } = await client.from('diary_profiles').update({ cover_path: path }).eq('id', me());
        if (error) { client.storage.from('diary-avatars').remove([path]); return app.showToast('Couldn’t save your cover photo'); }
        if (old) client.storage.from('diary-avatars').remove([old]);
        s.profile.cover_path = path;
        app.showToast('Cover photo updated');
        load(me());
    }
    async function removeCover() {
        const old = P.data && P.data.cover_path;
        const { error } = await client.from('diary_profiles').update({ cover_path: null }).eq('id', me());
        if (error) return app.showToast('Couldn’t remove your cover');
        if (old) client.storage.from('diary-avatars').remove([old]);
        s.profile.cover_path = null;
        app.showToast('Cover removed');
        load(me());
    }

    // ---------- Actions ----------
    async function act(what, el) {
        const p = P.data;
        if (what === 'retry') return load(app.state.profileId);
        if (!p) return;
        const first = (p.display_name || '').split(' ')[0] || 'them';
        const refresh = () => load(p.id);
        if (what === 'tab') {
            P.tab = el.dataset.tab;
            paint();
            loadTab();
        } else if (what === 'verified') {
            openVerified(p);
        } else if (what === 'list') {
            openList(el.dataset.which);
        } else if (what === 'edit') {
            openEditor();
        } else if (what === 'photo') {
            await I.changeAvatar();
            refresh();
        } else if (what === 'cover') {
            const items = [{ label: p.cover_path ? 'Change cover photo' : 'Upload a cover photo', icon: 'i-image', onClick: () => changeCover() }];
            if (p.cover_path) items.push({ label: 'Remove cover', icon: 'i-trash', danger: true, onClick: () => removeCover() });
            app.openPopover(el, items);
        } else if (what === 'cover-view') {
            const url = I.avatarUrl(p.cover_path);
            if (window.ZoomViewer) window.ZoomViewer.open([url], { origin: el.querySelector('img') });
            else if (window.Media && Media.lightbox) Media.lightbox(url);
        } else if (what === 'open-post') {
            I.openEntry(el.dataset.id);
        } else if (what === 'share') {
            const url = `${location.origin}${location.pathname}#/profile/${encodeURIComponent(p.id)}`;
            if (navigator.share) {
                try { await navigator.share({ title: `${p.display_name} on Cordial`, url }); return; } catch (e) { if (e && e.name === 'AbortError') return; }
            }
            I.copyText(url, 'Profile link copied');
        } else if (what === 'hello') {
            const pending = (s.outgoing || []).find(f => f.id === p.id);
            const r = await app.ask({
                title: `Say hello to ${first}`,
                text: `${first} gets your note with a friend request. When they accept, it’s the first message in your chat.`,
                value: (pending && pending.note) || `Welcome to Cordial, ${first}! 👋`,
                placeholder: 'Write a short hello', ok: 'Send hello'
            });
            if (!r) return;
            const { data, error } = await client.rpc('diary_say_hello', { p_user: p.id, p_note: r.value.slice(0, 300) });
            if (error) return app.showToast(error.message || 'Couldn’t send your hello');
            if (I.loadFriends) await I.loadFriends();
            app.showToast(data && data.friends ? (data.sent ? `You and ${first} are friends — your hello is in your chat` : `You’re already friends — say hi in your chat`) : `Hello sent — you can chat once ${first} accepts`);
            if (data && data.friends) { app.setView('messages'); if (I.openChat) I.openChat(p.id); } else refresh();
        } else if (what === 'go-feed') {
            app.setView('feed');
            setTimeout(() => document.getElementById('feed-text')?.focus(), 400);
        } else if (what === 'invite') {
            app.setView('invite');
        } else if (what === 'privacy') {
            app.setView('settings', { settingsPage: 'privacy' });
        } else if (what === 'interest') {
            app.setView('explore');
            setTimeout(() => {
                const input = document.getElementById('ex-search');
                if (input) { input.value = el.dataset.q; input.dispatchEvent(new Event('input', { bubbles: true })); input.focus(); }
            }, 350);
        } else if (what === 'follow') {
            await I.toggleFollow(p.id, first);
            refresh();
        } else if (what === 'message') {
            app.setView('messages');
            if (I.openChat) I.openChat(p.id);
        } else if (what === 'call') {
            const friend = s.friends.find(f => f.id === p.id);
            if (!friend || !window.diaryCalls) return;
            app.openPopover(el, [
                { label: 'Voice call', icon: 'i-phone', onClick: () => window.diaryCalls.callUser(friend, { video: false }) },
                { label: 'Video call', icon: 'i-video', onClick: () => window.diaryCalls.callUser(friend, { video: true }) }
            ]);
        } else if (what === 'add') {
            el.disabled = true;
            const { error } = await client.rpc('diary_send_friend_request', { target_username: p.username });
            if (error) { el.disabled = false; return app.showToast(error.message || 'Couldn’t send the request'); }
            if (I.loadFriends) await I.loadFriends();
            app.showToast('Friend request sent');
            paint();
        } else if (what === 'accept') {
            const req = s.incoming.find(f => f.id === p.id);
            if (!req || !I.respond) return;
            el.disabled = true;
            await I.respond(req.friendshipId, true);
            refresh();
        } else if (what === 'unblock') {
            if (window.diarySafety && await window.diarySafety.unblock(p)) refresh();
        } else if (what === 'more') {
            const items = [
                { label: 'Copy profile link', icon: 'i-link', onClick: () => I.copyText(`${location.origin}${location.pathname}#/profile/${encodeURIComponent(p.id)}`, 'Profile link copied') }
            ];
            if (s.friends.some(f => f.id === p.id) && I.toggleFollow) {
                items.push(s.following.has(p.id)
                    ? { label: `Unfollow ${first}`, icon: 'i-user', onClick: async () => { await I.toggleFollow(p.id, first); refresh(); } }
                    : { label: `Follow ${first}`, icon: 'i-user-plus', onClick: async () => { await I.toggleFollow(p.id, first); refresh(); } });
            }
            if (window.diarySafety) {
                items.push({ label: `Block ${first}`, icon: 'i-block', danger: true, onClick: async () => { if (await window.diarySafety.block(p)) refresh(); } });
                items.push({ label: 'Report profile', icon: 'i-flag', onClick: () => window.diarySafety.report('user', p.id, { who: p.display_name, offerBlock: p }) });
            }
            app.openPopover(el, items);
        } else if (what === 'open-ref') {
            const kind = el.dataset.kind;
            const ref = el.dataset.ref;
            if (kind === 'post' || kind === 'reaction') I.openEntry(ref);
            else if (kind === 'comment') {
                // A comment's ref is the post it's on: a feed post if we can find it, otherwise a group post
                const { data } = await client.from('diary_shared_entries').select('id').eq('id', ref).maybeSingle();
                if (data) I.openEntry(ref);
                else app.setView('post', { postId: `g-${ref}` });
            }
        }
    }

    content.addEventListener('click', e => {
        const el = e.target.closest('[data-pf]');
        if (!el || !content.contains(el) || app.state.view !== 'profile') return;
        act(el.dataset.pf, el);
    });

    // The page follows along when you follow / friend someone elsewhere while it's open
    app.onRefresh && app.onRefresh('profile', () => load(app.state.profileId));

    window.diaryProfile = { open, reload: () => P.id && load(P.id) };

    const previousAfter = app.hooks.afterRender;
    app.hooks.afterRender = (view, how) => {
        if (previousAfter) previousAfter(view, how);
        if (view === 'profile') hydrateStorage(content);
    };

    // Anything marked data-profile="<user id>" opens that person's page
    document.addEventListener('click', e => {
        const el = e.target.closest('[data-profile]');
        if (!el || !el.dataset.profile || e.defaultPrevented) return;
        e.preventDefault();
        e.stopPropagation();
        const dlg = el.closest('dialog[open]');
        if (dlg && !dlg.matches('#post-view')) dlg.close();
        open(el.dataset.profile);
    }, true);
    document.addEventListener('keydown', e => {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        const el = e.target.closest && e.target.closest('[data-profile][role="button"]');
        if (!el) return;
        e.preventDefault();
        open(el.dataset.profile);
    });
});
