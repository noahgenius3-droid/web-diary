// Communities: public or invite-only groups where members post updates, photos and diary notes.
// Builds on social.js (auth, storage, the shared post card and comments).
document.addEventListener('DOMContentLoaded', () => {
    const app = window.diaryApp;
    const social = window.diarySocial;
    const I = social && social.internals;
    if (!I) return;
    const { client, state: s, esc, avatar, timeAgo, gate, randomId, uploadImage, hydrateStorage, renderPost, commentCount } = I;
    const $ = id => document.getElementById(id);
    const content = $('content');
    const BUCKET = 'diary-community';
    const COLORS = ['yellow', 'pink', 'blue', 'green', 'purple'];
    const EMOJIS = ['📓', '📚', '✍️', '🎨', '🎵', '🏃', '🍳', '✈️', '🌱', '💼', '🙏', '🎮', '📸', '💡', '🧘', '⚽'];
    const MAX_PHOTOS = 10;

    const c = {
        list: null,              // every community you can see (public + yours)
        loading: false,
        memberships: new Map(),  // community id -> role
        current: null,           // open community
        opening: null,
        posts: [],
        members: [],
        loadingPosts: false,
        tab: 'posts',
        draft: { text: '', photos: [], poll: null },
        filter: 'all',           // communities page: all | joined | discover
        query: '',
        here: [],                // who's on this community's page right now
        presence: null,
        posting: false
    };

    window.diaryCommunities = {
        posts: () => c.posts,
        // For the group chat (groupchat.js)
        current: () => c.current,
        role: id => roleOf(id),
        members: () => c.members,
        loadMembers: () => loadMembers(),
        presenceChannel: () => (c.presence ? c.presence.channel : null),
        joinCall: (opts = {}) => { if (window.diaryCalls && c.current) window.diaryCalls.joinCommunity(c.current, opts); },
        canInteract: () => !!(c.current && c.memberships.has(c.current.id)),
        // Open a community straight on its chat (message links, mentions)
        showChat(id) {
            if (c.current && c.current.id === id) { c.tab = 'chat'; app.render(); }
            else c.wantTab = 'chat';
        },
        postMenu, onRemoteChange, reset,
        isMember: cid => !!roleOf(cid),
        // For the note share sheet
        async myGroups() {
            if (c.list === null) await loadCommunities();
            return (c.list || []).filter(x => c.memberships.has(x.id));
        },
        postNoteTo: (cm, note) => postNoteTo(cm, note),
        // For Explore: every community you can see, biggest first, with whether you're in it
        async all() {
            if (c.list === null) await loadCommunities();
            return (c.list || []).map(x => ({ ...x, joined: c.memberships.has(x.id), size: (x.members && x.members[0] && x.members[0].count) || 0 }))
                .sort((a, b) => b.size - a.size);
        }
    };

    function reset() {
        Object.assign(c, { list: null, memberships: new Map(), current: null, posts: [], members: [], draft: { text: '', photos: [], poll: null }, here: [] });
    }

    const me = () => s.profile.id;
    const roleOf = id => c.memberships.get(id);
    const isMod = id => ['owner', 'admin'].includes(roleOf(id));          // can edit the community
    const isStaff = id => ['owner', 'admin', 'moderator'].includes(roleOf(id)); // can moderate
    const ROLE_LABEL = { owner: 'Owner', admin: 'Admin', moderator: 'Moderator', member: 'Member' };
    const memberCount = cm => (Array.isArray(cm.members) && cm.members[0] ? cm.members[0].count : 0);
    const inView = () => ['communities', 'community'].includes(app.state.view);

    const POST_SELECT = `id, community_id, author, kind, title, body, html, photos, poll, pinned_at, created_at,
        author_profile:diary_profiles!diary_community_posts_author_fkey(username, display_name, avatar_path),
        likes:diary_community_likes(user_id, emoji),
        comments:diary_comments(count),
        votes:diary_community_poll_votes(user_id, option)`;

    // ---------- Data ----------
    // Phones on weak signal (or waking from the background) can leave a request hanging;
    // give up after a while so the page can offer a retry instead of "Loading…" forever.
    function withTimeout(promise, ms = 15000) {
        return Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms))]);
    }

    // Everyone waiting on the list shares one request, so memberships are always known before a group opens
    function loadCommunities() {
        if (c.loading) return c.loading;
        c.loadError = false;
        c.loading = (async () => {
            try {
                const [all, mine] = await withTimeout(Promise.all([
                    client.from('diary_communities')
                        .select('id, name, description, emoji, color, visibility, owner, created_at, members:diary_community_members(count)')
                        .order('created_at', { ascending: false })
                        .limit(100),
                    client.from('diary_community_members').select('community_id, role').eq('user_id', me())
                ]));
                if (all.error || mine.error) throw all.error || mine.error;
                c.list = all.data || [];
                c.memberships = new Map((mine.data || []).map(m => [m.community_id, m.role]));
            } catch (e) {
                c.loadError = true;
            } finally {
                c.loading = null;
            }
            if (inView()) app.render();
        })();
        return c.loading;
    }

    async function openCommunity(id) {
        if (c.opening === id) return;
        c.opening = id;
        c.openError = null;
        let cm = null;
        try {
            if (c.list === null) await loadCommunities();
            const res = await withTimeout(client.from('diary_communities')
                .select('*, members:diary_community_members(count)')
                .eq('id', id)
                .maybeSingle());
            if (res.error) throw res.error;
            cm = res.data;
        } catch (e) {
            c.openError = id;
            if (app.state.view === 'community') app.render();
            return;
        } finally {
            c.opening = null;
        }
        if (!cm) {
            app.showToast('That community isn’t available');
            app.setView('communities');
            return;
        }
        Object.assign(c, { current: cm, tab: c.wantTab || 'posts', posts: [], members: [], draft: { text: '', photos: [], poll: null } });
        c.wantTab = null;
        loadPosts();
        loadMembers();
        app.render();
    }

    async function loadPosts() {
        if (!c.current) return;
        const id = c.current.id;
        c.loadingPosts = true;
        const { data } = await client.from('diary_community_posts')
            .select(POST_SELECT)
            .eq('community_id', id)
            .order('created_at', { ascending: false })
            .limit(60);
        if (!c.current || c.current.id !== id) return;
        c.loadingPosts = false;
        c.posts = data || [];
        if (app.state.view === 'community') app.render();
    }

    async function loadMembers() {
        if (!c.current) return;
        const id = c.current.id;
        const { data } = await client.from('diary_community_members')
            .select('role, joined_at, user_id, profile:diary_profiles!diary_community_members_user_id_fkey(id, username, display_name, avatar_path)')
            .eq('community_id', id)
            .order('joined_at');
        if (!c.current || c.current.id !== id) return;
        c.members = data || [];
        if (app.state.view === 'community' && c.tab !== 'posts') app.render();
    }

    async function refreshPost(id) {
        const i = c.posts.findIndex(p => p.id === id);
        if (i < 0) return;
        const { data } = await client.from('diary_community_posts').select(POST_SELECT).eq('id', id).maybeSingle();
        if (!data) return;
        c.posts[i] = data;
        repaintPost(id);
    }

    function repaintPost(id) {
        const el = content.querySelector(`[data-post="post:${CSS.escape(id)}"]`);
        const p = c.posts.find(x => x.id === id);
        if (!el || !p) return;
        el.outerHTML = postHTML(p, !!roleOf(p.community_id));
        hydrateStorage(content);
    }

    function onRemoteChange(payload) {
        const row = payload.new && payload.new.id ? payload.new : payload.old;
        if (!c.current || !row) return;
        if (payload.eventType === 'DELETE') {
            const before = c.posts.length;
            c.posts = c.posts.filter(p => p.id !== row.id);
            if (c.posts.length !== before && app.state.view === 'community') app.render();
            return;
        }
        if (row.community_id === c.current.id && row.author !== me() && !c.posts.some(p => p.id === row.id)) loadPosts();
    }

    // ---------- Views ----------
    // ---------- Groups: the place to find, join and start groups ----------
    // (They're "communities" in the database; people see them as Groups.)
    const GROUP_CATS = [['all', 'All'], ['faith', 'Faith', /church|faith|god|pray|bible|gospel|worship|jesus|christ|psalm|grace/], ['education', 'Education', /study|school|learn|exam|educat|class|lesson|university|student/],
        ['business', 'Business', /business|money|startup|market|sell|finance|invest|brand|hustle/], ['tech', 'Technology', /tech|code|coding|\bai\b|app|software|computer|program|developer/],
        ['sports', 'Sports', /sport|football|soccer|basketball|run|fitness|gym|cycl|match|league/], ['health', 'Health', /health|wellness|mental|diet|doctor|medic|fitness|sleep/],
        ['music', 'Music', /music|song|choir|sing|beat|album|artist|praise/], ['entertainment', 'Entertainment', /movie|film|show|series|comedy|celebr|drama|fun/],
        ['lifestyle', 'Lifestyle', /life|style|food|recipe|travel|fashion|home|family|cook/], ['gaming', 'Gaming', /game|gaming|play|trivia|wordplay|puzzle/],
        ['art', 'Art', /\bart\b|draw|paint|photo|design|poem|poetry|creative/], ['career', 'Career', /career|job|work|\bcv\b|interview|hiring|intern/]];
    c.cat = (() => { try { return sessionStorage.getItem('cordialGroupCat') || 'all'; } catch (e) { return 'all'; } })();
    const catRe = k => (GROUP_CATS.find(x => x[0] === k) || [])[2];
    const textOf = x => `${x.name} ${x.description || ''}`.toLowerCase();
    const inCat = (k, x) => k === 'all' || (catRe(k) ? catRe(k).test(textOf(x)) : true);
    const interests = () => { try { const v = JSON.parse(localStorage.getItem(`cordialInterests:${me()}`) || 'null'); return Array.isArray(v) ? v : []; } catch (e) { return []; } };
    const short = n => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}K` : String(n));

    app.views.communities = () => {
        app.setTitle('Groups');
        const blocked = gate('Create or join groups to share notes and updates with people who care about the same things.');
        if (blocked) return blocked;
        if (c.list === null) {
            if (c.loadError) return retryBlock('Couldn’t load your groups', 'cm-retry-list');
            loadCommunities();
            return `<div class="gx"><div class="gx-head"><h2 class="notes-title">Groups</h2></div><div class="ex-row ex-cc-rail">${'<span class="ex-cc skel"></span>'.repeat(3)}</div></div>`;
        }
        const q = c.query.trim().toLowerCase();
        const shown = c.list.filter(x => (!q || textOf(x).includes(q)) && inCat(c.cat, x));
        const joined = x => c.memberships.has(x.id);
        const mine = shown.filter(joined);
        const open = shown.filter(x => !joined(x) && x.visibility === 'public');
        const trending = shown.filter(x => x.visibility === 'public' || joined(x)).sort((a, b) => memberCount(b) - memberCount(a)).slice(0, 10);
        const top3 = new Set(trending.slice(0, 3).map(x => x.id));
        const likes = interests();
        const rec = c.cat === 'all' && likes.length ? open.filter(x => !top3.has(x.id) && likes.some(k => catRe(k) && catRe(k).test(textOf(x)))).slice(0, 10) : [];
        const fresh = open.filter(x => Date.now() - Date.parse(x.created_at) < 45 * 86400000 && !top3.has(x.id))
            .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at)).slice(0, 10);
        const sec = (title, body, more = '') => `<section class="gx-sec"><header class="ex-head"><h3>${title}</h3>${more}</header>${body}</section>`;
        const filtering = q || c.cat !== 'all';

        return `
            <div class="gx">
                <header class="gx-head">
                    <div><h2 class="notes-title">Groups</h2><p class="muted">Find your people — join a group or start your own.</p></div>
                    <button class="chip" data-action="cm-join-code"><svg class="i"><use href="#i-link"/></svg>Join with code</button>
                </header>
                <label class="search gx-search">
                    <svg class="i"><use href="#i-search"/></svg>
                    <input type="search" id="cm-search" value="${esc(c.query)}" placeholder="Search groups" aria-label="Search groups" enterkeyhint="search" autocomplete="off">
                </label>
                <div class="ex-cats gx-cats" role="tablist" aria-label="Topics">${GROUP_CATS.map(([k, l]) => `<button type="button" class="ex-cat" role="tab" aria-selected="${c.cat === k}" data-action="gx-cat" data-k="${k}">${l}</button>`).join('')}</div>
                <button type="button" class="ex-create gx-create" data-action="cm-create"><svg class="i"><use href="#i-plus"/></svg>Create Group</button>
                ${!shown.length ? `
                    <div class="chat-onboard gx-empty"><span class="chat-onboard-ic" aria-hidden="true"><svg class="i"><use href="#i-users"/></svg></span>
                        <strong>No groups found</strong><span>${filtering ? 'We couldn’t find a group matching that. Start one, or look at everything.' : 'There are no groups yet — be the first to start one.'}</span>
                        <div><button type="button" class="primary-btn" data-action="cm-create">Create Group</button>${filtering ? '<button type="button" class="ghost-btn" data-action="gx-clear">Show all groups</button>' : ''}</div>
                    </div>` : ''}
                ${mine.length ? sec(`Your groups <span class="gx-count">${mine.length}</span>`, `<div class="ex-row gx-mine-rail">${mine.map(mineTile).join('')}</div>`) : ''}
                ${trending.length ? sec('Trending groups', `<div class="ex-row ex-cc-rail">${trending.map(groupCard).join('')}</div>`) : ''}
                ${rec.length ? sec('Recommended for you', `<div class="ex-row ex-cc-rail">${rec.map(groupCard).join('')}</div>`) : ''}
                ${fresh.length ? sec('New &amp; growing', `<div class="ex-row ex-cc-rail">${fresh.map(groupCard).join('')}</div>`) : ''}
                ${open.length ? sec('Browse all groups', `<div class="cm-grid">${open.map(card).join('')}</div>`) : ''}
            </div>`;
    };

    // A group you're in: emoji tile, name, size and your role — one tap into it
    function mineTile(cm) {
        const role = roleOf(cm.id);
        return `
            <button type="button" class="gx-mine" data-action="cm-open" data-id="${esc(cm.id)}" aria-label="Open ${esc(cm.name)}">
                <span class="gx-mine-tile c-${esc(cm.color)}" aria-hidden="true">${esc(cm.emoji || '👥')}</span>
                <strong>${esc(cm.name)}</strong>
                <small>${short(memberCount(cm))} ${memberCount(cm) === 1 ? 'member' : 'members'}${role && role !== 'member' ? ` · ${ROLE_LABEL[role] || ''}` : ''}</small>
            </button>`;
    }
    // The big card: a cover in the group's colours, member count, two lines about it, Join (or Open)
    function groupCard(cm) {
        const n = memberCount(cm);
        const role = roleOf(cm.id);
        return `
            <article class="ex-cc c-${esc(cm.color)}" style="--g: var(--deep, #6366f1)">
                <button type="button" class="ex-cc-open" data-action="cm-open" data-id="${esc(cm.id)}" aria-label="${esc(cm.name)}, ${n} ${n === 1 ? 'member' : 'members'}">
                    <span class="ex-cc-cover"><span class="ex-cc-emoji" aria-hidden="true">${esc(cm.emoji || '👥')}</span><span class="ex-cc-count"><svg class="i" aria-hidden="true"><use href="#i-users"/></svg>${short(n)}</span>${cm.visibility === 'private' ? '<span class="gx-lock" title="Invite-only">🔒</span>' : ''}</span>
                    <strong>${esc(cm.name)}</strong>
                    <small>${esc((cm.description || (cm.visibility === 'private' ? 'An invite-only group' : 'A group on Cordial')).slice(0, 110))}</small>
                </button>
                ${role ? `<button type="button" class="chip small ex-cc-btn" data-action="cm-open" data-id="${esc(cm.id)}">Open</button>`
                    : `<button type="button" class="chip small ex-cc-btn" data-action="cm-join" data-id="${esc(cm.id)}"><svg class="i"><use href="#i-plus"/></svg>Join</button>`}
            </article>`;
    }

    function retryBlock(title, action) {
        return `
            <div class="empty">
                <p class="empty-title">${title}</p>
                <p>Check your connection, then try again.</p>
                <button class="primary-btn" style="margin-top:18px" data-action="${action}">Try again</button>
            </div>`;
    }

    // Big colourful card for the Trending row
    function trendCard(cm) {
        const role = roleOf(cm.id);
        return `
            <article class="cm-trend c-${esc(cm.color)}" data-action="cm-open" data-id="${esc(cm.id)}" tabindex="0" role="button" aria-label="Open ${esc(cm.name)}">
                <span class="cm-trend-emoji" aria-hidden="true">${esc(cm.emoji)}</span>
                <strong>${esc(cm.name)}</strong>
                <small>${memberCount(cm)} ${memberCount(cm) === 1 ? 'member' : 'members'}</small>
                ${role
                    ? '<span class="cm-trend-tag">Joined ✓</span>'
                    : `<button class="cm-trend-join" data-action="cm-join" data-id="${esc(cm.id)}">Join</button>`}
            </article>`;
    }

    function card(cm) {
        const role = roleOf(cm.id);
        return `
            <article class="cm-card" data-action="cm-open" data-id="${esc(cm.id)}" tabindex="0" role="button" aria-label="Open ${esc(cm.name)}">
                <div class="cm-cover c-${esc(cm.color)}"><span class="cm-emoji">${esc(cm.emoji)}</span></div>
                <div class="cm-info">
                    <h3>${esc(cm.name)}</h3>
                    <p class="cm-meta">${cm.visibility === 'private' ? '🔒 Invite-only' : '🌐 Public'} · ${memberCount(cm)} ${memberCount(cm) === 1 ? 'member' : 'members'}</p>
                    ${cm.description ? `<p class="cm-desc">${esc(cm.description)}</p>` : ''}
                </div>
                <div class="cm-card-foot">
                    ${role
                        ? `<span class="cm-role">${ROLE_LABEL[role] || 'Member'}</span>`
                        : `<button class="chip accent" data-action="cm-join" data-id="${esc(cm.id)}">Join</button>`}
                </div>
            </article>`;
    }

    app.views.community = () => {
        const blocked = gate('Sign in to see this community.');
        if (blocked) return blocked;
        const id = app.state.communityId;
        if (!c.current || c.current.id !== id) {
            if (c.openError === id) return retryBlock('Couldn’t open this community', 'cm-retry-open');
            openCommunity(id);
            return '<p class="muted">Loading community…</p>';
        }
        const cm = c.current;
        const role = roleOf(cm.id);
        app.setTitle(cm.name);
        const tab = (key, label) => `<button class="tab" role="tab" aria-selected="${c.tab === key}" data-action="cm-tab" data-tab="${key}">${label}</button>`;

        return `
            <button class="back-link" data-action="cm-back" aria-label="Back to all communities" title="All communities"><svg class="i"><use href="#i-back"/></svg></button>
            <header class="cm-hero c-${esc(cm.color)}">
                <span class="cm-hero-emoji" aria-hidden="true">${esc(cm.emoji)}</span>
                <div class="cm-hero-text">
                    <h2>${esc(cm.name)}</h2>
                    ${cm.description ? `<p>${esc(cm.description)}</p>` : ''}
                    <p class="cm-meta">${cm.visibility === 'private' ? '🔒 Invite-only' : '🌐 Public'} · ${memberCount(cm)} ${memberCount(cm) === 1 ? 'member' : 'members'}${role ? ` · You’re ${role === 'member' ? 'a member' : `the ${role}`}` : ''}</p>
                    <div class="cm-stats">
                        <span><b>${postsThisWeek()}</b> posts this week</span>
                        <span class="cm-here" id="cm-here">${hereHTML()}</span>
                    </div>
                </div>
                <div class="cm-hero-actions">
                    ${role
                        ? `<span class="cm-call-slot" id="cm-call-slot">${callButton(lastCallPeople)}</span>
                           <button class="chip" data-action="cm-invite"><svg class="i"><use href="#i-user-plus"/></svg>Invite</button>
                           <button class="icon-btn" data-action="cm-settings" aria-label="Community options"><svg class="i"><use href="#i-more"/></svg></button>`
                        : `<button class="primary-btn" data-action="cm-join" data-id="${esc(cm.id)}">Join community</button>`}
                </div>
            </header>
            <div class="tabs" role="tablist">${tab('posts', 'Posts')}${role && window.diaryGroupChat ? tab('chat', 'Chat') : ''}${tab('members', `Members · ${memberCount(cm)}`)}${tab('about', 'About')}</div>
            ${c.tab === 'members' ? membersTab(cm) : c.tab === 'about' ? aboutTab(cm)
                : c.tab === 'chat' && role && window.diaryGroupChat ? window.diaryGroupChat.html(cm)
                : `<div class="cm-layout">${sideRail(cm)}${postsTab(cm)}</div>`}`;
    };

    function postsThisWeek() {
        const since = Date.now() - 7 * 86400000;
        return c.posts.filter(p => Date.parse(p.created_at) > since).length;
    }

    function hereHTML() {
        const others = c.here.filter(h => h.id !== me());
        if (!others.length) return c.current && roleOf(c.current.id) ? '<span class="cm-here-dot"></span>Just you here right now' : '';
        return `<span class="avatar-stack">${others.slice(0, 4).map(h => avatar(h, 'xs')).join('')}</span><span class="cm-here-dot"></span>${others.length} here now`;
    }

    // A fresh prompt every week, different per community
    const PROMPTS = [
        'What made you smile this week?', 'Share a photo from your week 📸', 'What are you reading or watching right now?',
        'One small win worth celebrating 🎉', 'What’s something you learned recently?', 'Recommend one song everyone should hear 🎵',
        'What are you looking forward to next week?', 'Show us your workspace or favourite corner', 'Describe your week in three emojis',
        'What’s a goal you’re working towards?'
    ];

    function weeklyPrompt(cm) {
        const week = Math.floor(Date.now() / (7 * 86400000));
        let h = 0;
        for (const ch of cm.id) h = (h * 31 + ch.charCodeAt(0)) | 0;
        return PROMPTS[Math.abs(h + week) % PROMPTS.length];
    }

    // Prompt, top voices — beside the posts on desktop, above them on phones
    function sideRail(cm) {
        const member = !!roleOf(cm.id);
        const since = Date.now() - 7 * 86400000;
        const tally = new Map();
        c.posts.forEach(p => {
            if (Date.parse(p.created_at) < since) return;
            const t = tally.get(p.author) || { n: 0, profile: p.author_profile, id: p.author };
            t.n += 1 + (p.likes || []).length * 0.25 + (p.reactions || []).length * 0.25;
            tally.set(p.author, t);
        });
        const top = [...tally.values()].sort((a, b) => b.n - a.n).slice(0, 3);
        const medals = ['🥇', '🥈', '🥉'];
        return `
            <aside class="cm-rail">
                <div class="cm-prompt">
                    <span class="cm-prompt-tag">This week’s prompt</span>
                    <p>${esc(weeklyPrompt(cm))}</p>
                    ${member ? '<button class="cm-prompt-btn" data-action="cm-answer-prompt">Answer it</button>' : ''}
                </div>
                ${top.length ? `
                    <div class="cm-top">
                        <h3>Top voices this week</h3>
                        ${top.map((t, i) => {
                            const p = t.profile || { display_name: 'Member', username: '' };
                            return `<div class="cm-top-row"><span class="cm-medal" aria-hidden="true">${medals[i]}</span>${avatar({ id: t.id, ...p }, 'sm')}<span>${t.id === me() ? 'You' : esc(p.display_name)}</span></div>`;
                        }).join('')}
                    </div>` : ''}
            </aside>`;
    }

    function pollHTML(p, member) {
        const poll = p.poll;
        if (!poll || !Array.isArray(poll.options)) return '';
        const votes = p.votes || [];
        const total = votes.length;
        const mine = votes.find(v => v.user_id === me());
        const showResults = !!mine || !member;
        return `
            <div class="cm-poll${showResults ? ' results' : ''}">
                <p class="cm-poll-q">${esc(poll.question || '')}</p>
                ${poll.options.map((o, i) => {
                    const n = votes.filter(v => v.option === i).length;
                    const pct = total ? Math.round((n / total) * 100) : 0;
                    const chosen = mine && mine.option === i;
                    return `
                        <button type="button" class="cm-poll-opt${chosen ? ' chosen' : ''}" data-action="cm-vote" data-id="${esc(p.id)}" data-opt="${i}"${member ? '' : ' disabled'} style="--pct:${showResults ? pct : 0}%" aria-pressed="${!!chosen}">
                            <span class="cm-poll-fill" aria-hidden="true"></span>
                            <span class="cm-poll-label">${chosen ? '✓ ' : ''}${esc(o)}</span>
                            ${showResults ? `<span class="cm-poll-pct">${pct}%</span>` : ''}
                        </button>`;
                }).join('')}
                <p class="cm-poll-foot">${total} ${total === 1 ? 'vote' : 'votes'} · ${!member ? 'Join to vote' : mine ? 'Tap another option to change your vote' : 'Tap to vote — results show after you vote'}</p>
            </div>`;
    }

    function pollBuilder() {
        const poll = c.draft.poll;
        if (!poll) return '';
        return `
            <div class="cm-poll-build">
                <input class="cm-poll-in" data-poll="q" maxlength="200" placeholder="Ask a question…" value="${esc(poll.question)}" aria-label="Poll question">
                ${poll.options.map((o, i) => `<input class="cm-poll-in opt" data-poll="${i}" maxlength="80" placeholder="Option ${i + 1}" value="${esc(o)}" aria-label="Option ${i + 1}">`).join('')}
                <div class="cm-poll-build-foot">
                    ${poll.options.length < 4 ? '<button type="button" class="chip" data-action="cm-poll-add">+ Add option</button>' : ''}
                    <button type="button" class="chip" data-action="cm-poll-remove">Remove poll</button>
                </div>
            </div>`;
    }

    function postsTab(cm) {
        const member = !!roleOf(cm.id);
        const first = s.profile.display_name.split(' ')[0];
        const composer = member ? `
            <form class="post-composer" data-form="cm-post">
                <div class="pc-row">
                    ${avatar(s.profile, 'md')}
                    <textarea id="cm-text" rows="2" maxlength="5000" placeholder="Share an update with ${esc(cm.name)}, ${esc(first)}…" aria-label="Write a post"></textarea>
                </div>
                <div class="pc-photos" id="cm-photos" hidden></div>
                ${pollBuilder()}
                <div class="pc-foot">
                    <button type="button" class="pc-tool" data-action="cm-add-photos"><svg class="i"><use href="#i-image"/></svg>Photo</button>
                    <button type="button" class="pc-tool poll" data-action="cm-poll" aria-pressed="${!!c.draft.poll}"><svg class="i"><use href="#i-chart"/></svg>Poll</button>
                    <button type="button" class="pc-tool camera" data-action="cm-camera"><svg class="i"><use href="#i-camera"/></svg>Camera</button>
                    <button type="button" class="pc-tool note" data-action="cm-share-note"><svg class="i"><use href="#i-notes"/></svg>Share a note</button>
                    ${window.diarySchedule ? '<button type="button" class="pc-tool schedule" data-action="cm-schedule"><svg class="i"><use href="#i-clock"/></svg>Schedule</button>' : ''}
                    <button type="submit" class="pc-post" id="cm-post-btn"${c.posting ? ' disabled' : ''}>${c.posting ? 'Posting…' : 'Post'}</button>
                </div>
            </form>` : `
            <div class="cm-join-banner">
                <p><strong>Join ${esc(cm.name)}</strong> to post, like and comment.</p>
                <button class="primary-btn" data-action="cm-join" data-id="${esc(cm.id)}">Join</button>
            </div>`;

        const posts = c.loadingPosts && !c.posts.length
            ? '<p class="muted">Loading posts…</p>'
            : [...c.posts].sort((a, b) => (b.pinned_at ? 1 : 0) - (a.pinned_at ? 1 : 0)).map(p => postHTML(p, member)).join('') || `<div class="empty"><p class="empty-title">No posts yet</p><p>${member ? 'Be the first to share something.' : 'Nothing has been shared here yet.'}</p></div>`;

        return `<div class="cm-posts">${composer}<div class="feed-list">${posts}</div></div>`;
    }

    function postHTML(p, member) {
        if (I.isHidden && I.isHidden('post', p.id)) return '';
        return renderPost({
            kind: 'post',
            id: p.id,
            author: p.author,
            profile: p.author_profile,
            createdAt: p.created_at,
            title: p.title,
            body: p.body,
            html: p.html,
            photos: p.photos,
            bucket: BUCKET,
            likes: p.likes || [],
            commentCount: commentCount(p),
            canComment: member,
            mine: p.author === me(),
            pinned: !!p.pinned_at,
            bodyExtra: pollHTML(p, member),
            badge: p.kind === 'note' ? '📓 shared a note' : p.kind === 'poll' ? '📊 started a poll' : ''
        });
    }

    // Who can do what to whom: owner > admin > moderator > member
    const RANK = { owner: 3, admin: 2, moderator: 1, member: 0 };
    function canManageMember(cm, m) {
        const mine = roleOf(cm.id);
        if (!mine || m.user_id === me() || m.role === 'owner') return false;
        if (mine === 'owner') return true;
        if (mine === 'admin') return RANK[m.role] < RANK.admin;
        if (mine === 'moderator') return m.role === 'member';
        return false;
    }

    function membersTab(cm) {
        if (!c.members.length) return '<p class="muted">Loading members…</p>';
        const order = [...c.members].sort((a, b) => RANK[b.role] - RANK[a.role] || Date.parse(a.joined_at) - Date.parse(b.joined_at));
        const staff = order.filter(m => m.role !== 'member').length;
        return `
            <p class="cm-members-note muted small">${staff} ${staff === 1 ? 'person runs' : 'people run'} this community. ${isStaff(cm.id) ? 'Tap ⋯ next to someone to change their role, mute or remove them.' : ''}</p>
            <div class="cm-members">${order.map(m => {
            const p = m.profile || { id: m.user_id, display_name: 'Member', username: '' };
            return `
                <div class="contact-row">
                    ${avatar(p, 'md')}
                    <span class="contact-name"><strong>${m.user_id === me() ? 'You' : esc(p.display_name)}</strong><small>@${esc(p.username)} · joined ${timeAgo(m.joined_at)}</small></span>
                    ${m.role !== 'member' ? `<span class="cm-role role-${m.role}">${ROLE_LABEL[m.role]}</span>` : ''}
                    ${I.followButton({ ...p, id: m.user_id })}
                    ${m.user_id !== me() && roleOf(cm.id) && window.diaryCalls ? `<button class="icon-btn ghost accent" data-action="cm-call-member" data-id="${esc(m.user_id)}" aria-label="Call ${esc(p.display_name)}"><svg class="i"><use href="#i-phone"/></svg></button>` : ''}
                    ${canManageMember(cm, m) ? `<button class="icon-btn ghost" data-action="cm-member-menu" data-id="${esc(m.user_id)}" aria-label="Manage ${esc(p.display_name)}" aria-haspopup="menu"><svg class="i"><use href="#i-more"/></svg></button>` : ''}
                </div>`;
        }).join('')}</div>`;
    }

    async function setRole(userId, role) {
        const { error } = await client.rpc('diary_set_member_role', { cid: c.current.id, target: userId, new_role: role });
        if (error) return app.showToast(error.message || 'Couldn’t change their role');
        const m = c.members.find(x => x.user_id === userId);
        if (m) m.role = role;
        app.showToast(`${m && m.profile ? m.profile.display_name.split(' ')[0] : 'They'} ${role === 'member' ? 'is now a member' : `is now ${role === 'admin' ? 'an admin' : 'a moderator'}`}`);
        app.render();
    }

    async function muteMember(userId, minutes) {
        const { error } = await client.rpc('diary_mute_member', { cid: c.current.id, target: userId, minutes });
        if (error) return app.showToast(error.message || 'Couldn’t mute them');
        app.showToast(minutes ? `Muted in the chat for ${minutes >= 1440 ? `${minutes / 1440} day` : minutes >= 60 ? `${minutes / 60} hour${minutes > 60 ? 's' : ''}` : `${minutes} minutes`}` : 'Unmuted');
        if (window.diaryGroupChat) window.diaryGroupChat.refreshMutes();
    }

    function aboutTab(cm) {
        const role = roleOf(cm.id);
        const owner = c.members.find(m => m.role === 'owner');
        return `
            <div class="cm-about">
                <div class="info-row"><span class="info-ic purple"><svg class="i"><use href="#i-info"/></svg></span><span>About</span><b>${cm.description ? esc(cm.description) : 'No description yet'}</b></div>
                <div class="info-row"><span class="info-ic blue"><svg class="i"><use href="#i-lock"/></svg></span><span>Visibility</span><b>${cm.visibility === 'private' ? 'Invite-only' : 'Public — anyone can join'}</b></div>
                <div class="info-row"><span class="info-ic green"><svg class="i"><use href="#i-user"/></svg></span><span>Owner</span><b>${owner && owner.profile ? esc(owner.profile.display_name) : '—'}</b></div>
                <div class="info-row"><span class="info-ic pink"><svg class="i"><use href="#i-calendar"/></svg></span><span>Created</span><b>${new Date(cm.created_at).toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' })}</b></div>
                ${role ? `<div class="info-row"><span class="info-ic yellow"><svg class="i"><use href="#i-link"/></svg></span><span>Invite code</span><b class="invite-code">${esc(cm.invite_code)}</b>
                    <button class="chip" data-action="cm-copy-code">Copy</button></div>` : ''}
            </div>`;
    }

    // ---------- Calls ----------
    let lastCallPeople = [];
    let watching = null; // { topic, stop }

    function callButton(people) {
        if (!window.diaryCalls || !c.current) return '';
        const topic = window.diaryCalls.topicFor(c.current);
        if (window.diaryCalls.activeTopic() === topic) {
            return '<button class="call-join live" data-action="cm-call"><svg class="i"><use href="#i-phone"/></svg>You’re in the call</button>';
        }
        if (people.length) {
            return `<button class="call-join live" data-action="cm-call">
                <span class="avatar-stack">${people.slice(0, 3).map(p => avatar({ id: p.id, display_name: p.name, avatar_path: p.avatar_path }, 'xs')).join('')}</span>
                <span class="call-join-text"><strong>Join call</strong><small>${esc(people.slice(0, 2).map(p => String(p.name || 'Someone').split(' ')[0]).join(', '))}${people.length > 2 ? ` and ${people.length - 2} more` : ''} ${people.length === 1 ? 'is' : 'are'} in it</small></span></button>`;
        }
        return '<button class="chip call-chip" data-action="cm-call"><svg class="i"><use href="#i-phone"/></svg>Voice call</button>';
    }

    // Watch the community's call room while its page is open, so "Join call · 3" stays live
    function syncCallWatch() {
        const want = app.state.view === 'community' && c.current && roleOf(c.current.id) && window.diaryCalls
            ? window.diaryCalls.topicFor(c.current) : null;
        if (watching && watching.topic !== want) {
            watching.stop();
            watching = null;
            lastCallPeople = [];
        }
        if (want && !watching) {
            watching = {
                topic: want,
                stop: window.diaryCalls.watch(want, people => {
                    lastCallPeople = people;
                    const slot = $('cm-call-slot');
                    if (slot) slot.innerHTML = callButton(people);
                })
            };
        }
    }

    // "Who's here now" — a members-only presence channel while a community page is open
    function syncPresence() {
        const want = app.state.view === 'community' && c.current && roleOf(c.current.id) ? c.current.id : null;
        if (c.presence && c.presence.id !== want) {
            client.removeChannel(c.presence.channel);
            c.presence = null;
            c.here = [];
        }
        if (!want || c.presence) return;
        const channel = client.channel(`diary_comm:${want}`, { config: { private: true, presence: { key: me() } } });
        channel
            .on('presence', { event: 'sync' }, () => {
                const state = channel.presenceState();
                c.here = Object.values(state).map(list => list[0]).filter(Boolean);
                const el = $('cm-here');
                if (el) el.innerHTML = hereHTML();
            })
            .on('postgres_changes', { event: '*', schema: 'public', table: 'diary_community_poll_votes' }, payload => {
                const row = payload.new && payload.new.post_id ? payload.new : payload.old;
                if (row && row.user_id !== me()) refreshPost(row.post_id);
            })
            .on('postgres_changes', { event: '*', schema: 'public', table: 'diary_community_likes' }, payload => {
                const row = payload.new && payload.new.post_id ? payload.new : payload.old;
                if (row && row.user_id !== me()) refreshPost(row.post_id);
            })
            .subscribe(async status => {
                if (status === 'SUBSCRIBED') {
                    await channel.track({ id: me(), display_name: s.profile.display_name, username: s.profile.username, avatar_path: s.profile.avatar_path || null });
                }
            });
        c.presence = { id: want, channel };
    }

    // Keep the composer's text and photos across re-renders, and load private photos
    const previousAfter = app.hooks.afterRender;
    app.hooks.afterRender = view => {
        if (previousAfter) previousAfter(view);
        syncCallWatch();
        syncPresence();
        if (view !== 'community') return;
        hydrateStorage(content);
        const text = $('cm-text');
        if (text) {
            text.value = c.draft.text;
            renderDraftPhotos();
        }
    };

    // ---------- Composer ----------
    async function addDraftPhotos(files) {
        for (const original of files) {
            if (c.draft.photos.length >= MAX_PHOTOS) {
                app.showToast(`Up to ${MAX_PHOTOS} photos per post`);
                break;
            }
            const file = await Media.compressImage(original);
            if (!['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(file.type)) {
                app.showToast(`${original.name || 'That photo'} isn’t a supported format`);
                continue;
            }
            c.draft.photos.push({ id: randomId(), file, preview: URL.createObjectURL(file) });
        }
        renderDraftPhotos();
    }

    function renderDraftPhotos() {
        const box = $('cm-photos');
        if (!box) return;
        box.hidden = !c.draft.photos.length;
        box.innerHTML = c.draft.photos.map(p => `
            <figure class="pc-thumb">
                <img src="${p.preview}" alt="">
                ${window.PhotoEditor && p.file.type !== 'image/gif' ? `<button type="button" class="pc-edit" data-action="cm-edit-photo" data-id="${p.id}" aria-label="Edit photo with filters"><svg class="i"><use href="#i-wand"/></svg>Edit</button>` : ''}
                <button type="button" class="att-remove" data-action="cm-remove-photo" data-id="${p.id}" aria-label="Remove photo"><svg class="i"><use href="#i-close"/></svg></button>
            </figure>`).join('');
    }

    async function uploadAll(sources, cid) {
        const paths = [];
        for (const src of sources) {
            const path = await uploadImage(BUCKET, `${cid}/${me()}/${randomId()}`, src);
            if (path) paths.push({ path });
        }
        return paths;
    }

    // Post into a community (the open one by default). Returns the new post, or null.
    async function publish(fields, sources, cm = c.current) {
        const onPage = c.current && c.current.id === cm.id;
        if (onPage) {
            c.posting = true;
            app.render();
        }
        try {
            const photos = await uploadAll(sources, cm.id);
            if (sources.length && photos.length < sources.length) {
                app.showToast(`${sources.length - photos.length} photo(s) couldn’t upload`);
            }
            if (!fields.body && !fields.title && !photos.length && !fields.poll) throw new Error('Nothing to post');
            const { data, error } = await client.from('diary_community_posts')
                .insert({ community_id: cm.id, photos, ...fields })
                .select(POST_SELECT)
                .single();
            if (error) throw error;
            if (c.current && c.current.id === cm.id) c.posts.unshift(data);
            return data;
        } catch (err) {
            app.showToast(err.message === 'Nothing to post' ? 'Write something or add a photo first' : 'Couldn’t post — please try again');
            return null;
        } finally {
            if (onPage) {
                c.posting = false;
                if (app.state.view === 'community') app.render();
            }
        }
    }

    async function postUpdate() {
        if (c.posting) return;
        const body = c.draft.text.trim();
        const photos = c.draft.photos;
        let poll = null;
        if (c.draft.poll) {
            const question = c.draft.poll.question.trim();
            const options = c.draft.poll.options.map(o => o.trim()).filter(Boolean);
            if (!question || options.length < 2) return app.showToast('A poll needs a question and at least two options');
            poll = { question, options };
        }
        if (!body && !photos.length && !poll) return app.showToast('Write something or add a photo first');
        const ok = await publish(poll ? { kind: 'poll', body, poll } : { kind: 'update', body }, photos.map(p => p.file));
        if (ok) {
            photos.forEach(p => URL.revokeObjectURL(p.preview));
            c.draft = { text: '', photos: [], poll: null };
            const btn = $('cm-post-btn');
            if (btn) celebrate(btn, 14);
            app.render();
            app.showToast(`Posted to ${c.current.name}`);
        }
    }

    function pickNoteToShare(anchor) {
        const notes = app.getNotes().filter(n => !n.trashedAt && !n.private && n.origin !== 'post').slice(0, 8);
        if (!notes.length) return app.showToast('Write a note first — private notes can’t be shared');
        app.openPopover(anchor, notes.map(n => ({
            label: (n.title || n.text.split('\n')[0] || 'Untitled').slice(0, 48),
            icon: n.attachments.some(a => a.kind === 'image' || a.kind === 'drawing') ? 'i-image' : 'i-notes',
            onClick: () => shareNote(n)
        })));
    }

    async function shareNote(n) {
        const ok = await app.ask({ title: `Share this note with ${c.current.name}?`, text: `“${n.title || n.text.slice(0, 60) || 'Untitled'}” will be visible to ${c.current.visibility === 'public' ? 'anyone who opens this community' : 'its members'}.`, ok: 'Share' });
        if (!ok) return;
        if (await postNoteTo(c.current, n)) app.showToast('Note shared 📓');
    }

    // Post a diary note (text, formatting and photos) to any community you belong to
    async function postNoteTo(cm, n) {
        const images = [];
        for (const a of n.attachments
            .filter(x => x.kind === 'image' || x.kind === 'drawing')
            .sort((x, y) => (y.id === n.cover) - (x.id === n.cover))
            .slice(0, MAX_PHOTOS)) {
            const blob = await Media.get(a.id);
            if (blob) images.push(new File([blob], a.name || 'photo', { type: a.type || blob.type }));
        }
        const html = Rich.sanitize(n.html || '');
        const posted = await publish({
            kind: 'note',
            title: (n.title || '').slice(0, 200),
            body: n.text.slice(0, 20000),
            html: html.length <= 60000 ? html : ''
        }, images, cm);
        if (posted) {
            // Remember where it went so the share sheet can show "✓ Shared"
            const groups = [...new Set([...(n.sharedGroups || []), cm.id])];
            app.updateNote(n.id, { sharedGroups: groups });
        }
        return !!posted;
    }

    // ---------- Polls & post menu ----------
    async function vote(postId, option) {
        const p = c.posts.find(x => x.id === postId);
        if (!p || !roleOf(p.community_id)) return app.showToast('Join the community to vote');
        const before = (p.votes || []).map(v => ({ ...v }));
        const mine = before.find(v => v.user_id === me());
        if (mine && mine.option === option) return; // same choice — nothing to do
        p.votes = [...before.filter(v => v.user_id !== me()), { user_id: me(), option }];
        repaintPost(postId);
        const { error } = mine
            ? await client.from('diary_community_poll_votes').update({ option }).eq('post_id', postId).eq('user_id', me())
            : await client.from('diary_community_poll_votes').insert({ post_id: postId, option });
        if (error) {
            p.votes = before;
            repaintPost(postId);
            app.showToast('Couldn’t save your vote');
        } else if (!mine) {
            const el = content.querySelector(`[data-post="post:${CSS.escape(postId)}"] .cm-poll-opt.chosen`);
            if (el) celebrate(el, 10);
        }
    }

    async function togglePin(post) {
        const pinned = !post.pinned_at;
        const { error } = await client.from('diary_community_posts').update({ pinned_at: pinned ? new Date().toISOString() : null }).eq('id', post.id);
        if (error) return app.showToast('Couldn’t pin that post');
        post.pinned_at = pinned ? new Date().toISOString() : null;
        app.showToast(pinned ? 'Pinned to the top 📌' : 'Unpinned');
        app.render();
    }

    // A small burst of confetti from an element (skipped when motion is reduced)
    function celebrate(el, count = 22) {
        if (!el || (document.documentElement.dataset.motion === 'reduce' || window.matchMedia('(prefers-reduced-motion: reduce)').matches)) return;
        const r = el.getBoundingClientRect();
        const colours = ['#4f46e5', '#ec4899', '#f59e0b', '#10b981', '#8b5cf6', '#06b6d4'];
        for (let i = 0; i < count; i++) {
            const bit = document.createElement('span');
            bit.className = 'confetti-bit';
            bit.style.left = `${r.left + r.width / 2}px`;
            bit.style.top = `${r.top + r.height / 2}px`;
            bit.style.background = colours[i % colours.length];
            document.body.appendChild(bit);
            const angle = (Math.PI * 2 * i) / count + Math.random() * 0.5;
            const dist = 60 + Math.random() * 90;
            bit.animate([
                { transform: 'translate(-50%, -50%) rotate(0deg)', opacity: 1 },
                { transform: `translate(calc(-50% + ${Math.cos(angle) * dist}px), calc(-50% + ${Math.sin(angle) * dist + 40}px)) rotate(${Math.random() * 540}deg)`, opacity: 0 }
            ], { duration: 700 + Math.random() * 400, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' }).onfinish = () => bit.remove();
        }
    }

    function postMenu(el) {
        const post = c.posts.find(p => p.id === el.dataset.id);
        if (!post) return;
        const canDelete = post.author === me() || isMod(post.community_id);
        const pinItem = isMod(post.community_id)
            ? [{ label: post.pinned_at ? 'Unpin post' : 'Pin to top', icon: 'i-pin-note', onClick: () => togglePin(post) }]
            : [];
        const isFriend = s.friends.some(f => f.id === post.author);
        const items = [...pinItem];
        if (isFriend && post.author !== me()) {
            items.push({ label: 'Message', icon: 'i-chat', onClick: () => { app.setView('messages'); content.querySelector(`.convo[data-id="${CSS.escape(post.author)}"]`)?.click(); } });
        }
        if (canDelete) {
            items.push({ label: 'Delete post', icon: 'i-trash', danger: true, onClick: () => deletePost(post) });
        }
        if (post.author !== me() && window.diarySafety) items.push({ label: 'Report post', icon: 'i-flag', onClick: () => window.diarySafety.report('post', post.id) });
        if (I.postExtras) items.unshift(...I.postExtras('post', post));
        app.openPopover(el, items);
    }

    async function deletePost(post) {
        const ok = await app.ask({ title: 'Delete this post?', text: 'It will be removed for everyone in the community.', ok: 'Delete', danger: true });
        if (!ok) return;
        const { error } = await client.from('diary_community_posts').delete().eq('id', post.id);
        if (error) return app.showToast('Couldn’t delete that post');
        if (post.author === me() && post.photos?.length) {
            client.storage.from(BUCKET).remove(post.photos.map(p => p.path));
        }
        c.posts = c.posts.filter(p => p.id !== post.id);
        app.render();
        app.showToast('Post deleted');
    }

    // ---------- Create / edit / join / leave ----------
    const dialog = $('cm-dialog');
    let editing = null; // community being edited, or null when creating

    $('cm-emojis').innerHTML = EMOJIS.map(e => `<button type="button" class="cm-emoji-opt" data-emoji="${e}" role="radio" aria-label="${e}">${e}</button>`).join('');
    $('cm-colors').innerHTML = COLORS.map(col => `<button type="button" class="swatch c-${col}" data-color="${col}" role="radio" aria-label="${col}"></button>`).join('');
    const choice = { emoji: EMOJIS[0], color: 'purple' };

    function paintChoice() {
        $('cm-emojis').querySelectorAll('[data-emoji]').forEach(b => b.setAttribute('aria-checked', String(b.dataset.emoji === choice.emoji)));
        $('cm-colors').querySelectorAll('[data-color]').forEach(b => b.setAttribute('aria-checked', String(b.dataset.color === choice.color)));
    }

    $('cm-emojis').addEventListener('click', e => {
        const b = e.target.closest('[data-emoji]');
        if (b) { choice.emoji = b.dataset.emoji; paintChoice(); }
    });
    $('cm-colors').addEventListener('click', e => {
        const b = e.target.closest('[data-color]');
        if (b) { choice.color = b.dataset.color; paintChoice(); }
    });

    function openDialog(cm = null) {
        editing = cm;
        $('cm-dialog-title').textContent = cm ? 'Edit community' : 'Create a community';
        $('cm-save').textContent = cm ? 'Save' : 'Create';
        $('cm-name').value = cm ? cm.name : '';
        $('cm-desc').value = cm ? cm.description : '';
        choice.emoji = cm ? cm.emoji : EMOJIS[Math.floor(Math.random() * EMOJIS.length)];
        choice.color = cm ? cm.color : COLORS[Math.floor(Math.random() * COLORS.length)];
        dialog.querySelectorAll('input[name="cm-vis"]').forEach(r => { r.checked = r.value === (cm ? cm.visibility : 'public'); });
        paintChoice();
        dialog.showModal();
        $('cm-name').focus();
    }

    $('cm-cancel').addEventListener('click', () => dialog.close());
    $('cm-form').addEventListener('submit', async e => {
        e.preventDefault();
        const name = $('cm-name').value.trim();
        if (name.length < 2) {
            $('cm-name').focus();
            return app.showToast('Give your community a name');
        }
        const fields = {
            name: name.slice(0, 60),
            description: $('cm-desc').value.trim().slice(0, 400),
            emoji: choice.emoji,
            color: choice.color,
            visibility: dialog.querySelector('input[name="cm-vis"]:checked').value
        };
        $('cm-save').disabled = true;
        try {
            if (editing) {
                const { data, error } = await client.from('diary_communities').update(fields).eq('id', editing.id)
                    .select('*, members:diary_community_members(count)').single();
                if (error) throw error;
                c.current = data;
                c.list = null;
                dialog.close();
                app.render();
                app.showToast('Community updated');
            } else {
                const { data, error } = await client.rpc('diary_create_community', {
                    p_name: fields.name, p_description: fields.description, p_emoji: fields.emoji,
                    p_color: fields.color, p_visibility: fields.visibility
                });
                if (error) throw error;
                c.memberships.set(data.id, 'owner');
                c.list = null;
                dialog.close();
                app.showToast(`${data.name} is ready — invite some people!`);
                app.setView('community', { communityId: data.id });
            }
        } catch (err) {
            app.showToast(err.message || 'Couldn’t save the community');
        } finally {
            $('cm-save').disabled = false;
        }
    });

    async function join(id, code = null) {
        const { data, error } = await client.rpc('diary_join_community', { p_id: id, p_code: code });
        if (error) return app.showToast(error.message);
        c.memberships.set(data.id, 'member');
        c.list = null;
        app.showToast(`Welcome to ${data.name} 🎉`);
        celebrate(document.querySelector(`[data-action="cm-join"][data-id="${CSS.escape(data.id)}"]`) || $('page-title'), 28);
        if (c.current && c.current.id === data.id) {
            c.current = null;
            app.render();
        } else {
            app.setView('community', { communityId: data.id });
        }
    }

    async function leave(cm) {
        const owner = roleOf(cm.id) === 'owner';
        const ok = await app.ask({
            title: `Leave ${cm.name}?`,
            text: owner ? 'You own this community. Ownership passes to the longest-standing member — if you’re the only one, the community is deleted.' : 'You can rejoin later.',
            ok: 'Leave', danger: true
        });
        if (!ok) return;
        const { error } = await client.rpc('diary_leave_community', { p_id: cm.id });
        if (error) return app.showToast('Couldn’t leave the community');
        c.memberships.delete(cm.id);
        c.list = null;
        c.current = null;
        app.setView('communities');
        app.showToast(`You left ${cm.name}`);
    }

    async function destroy(cm) {
        const ok = await app.ask({ title: `Delete ${cm.name}?`, text: 'All posts, comments and photos in it are removed for everyone. This can’t be undone.', ok: 'Delete community', danger: true });
        if (!ok) return;
        const { error } = await client.from('diary_communities').delete().eq('id', cm.id);
        if (error) return app.showToast('Couldn’t delete the community');
        c.memberships.delete(cm.id);
        c.list = null;
        c.current = null;
        app.setView('communities');
        app.showToast('Community deleted');
    }

    async function copyCode(code) {
        try {
            await navigator.clipboard.writeText(code);
            app.showToast('Invite code copied');
        } catch (e) {
            app.showToast(`Invite code: ${code}`);
        }
    }

    // ---------- Actions ----------
    Object.assign(app.actions, {
        'cm-open': el => app.setView('community', { communityId: el.dataset.id }),
        'gx-cat': el => { c.cat = el.dataset.k; try { sessionStorage.setItem('cordialGroupCat', c.cat); } catch (e) { /* private mode */ } app.render(); },
        'gx-clear': () => { c.cat = 'all'; c.query = ''; try { sessionStorage.setItem('cordialGroupCat', 'all'); } catch (e) { /* private mode */ } app.render(); },
        'cm-back': () => app.setView('communities'),
        'cm-retry-list': () => { c.loadError = false; loadCommunities(); app.render(); },
        'cm-retry-open': () => { c.openError = null; app.render(); },
        'cm-create': () => openDialog(),
        'cm-tab': el => {
            c.tab = el.dataset.tab;
            if (c.tab !== 'posts' && !c.members.length) loadMembers();
            app.render();
        },
        'cm-join': (el, e) => {
            e.stopPropagation();
            join(el.dataset.id);
        },
        'cm-join-code': async () => {
            const r = await app.ask({ title: 'Join with an invite code', text: 'Ask a member of the community for its 8-character code.', value: '', placeholder: 'e.g. 4f9a2c1b', ok: 'Join' });
            if (r) join(null, r.value);
        },
        'cm-invite': async () => {
            const cm = c.current;
            const ok = await app.ask({
                title: `Invite people to ${cm.name}`,
                text: cm.visibility === 'public'
                    ? `Anyone can find ${cm.name} under Discover, or join straight away with the code ${cm.invite_code}.`
                    : `Share this code — anyone with it can join: ${cm.invite_code}`,
                ok: 'Copy code'
            });
            if (ok) copyCode(cm.invite_code);
        },
        'cm-copy-code': () => copyCode(c.current.invite_code),
        'cm-settings': el => {
            const cm = c.current;
            const role = roleOf(cm.id);
            const items = [];
            if (isMod(cm.id)) items.push({ label: 'Edit community', icon: 'i-pencil', onClick: () => openDialog(cm) });
            if (isMod(cm.id)) items.push({ label: 'Chat settings', icon: 'i-chat', onClick: () => { c.tab = 'chat'; app.render(); } });
            if (isStaff(cm.id)) items.push({ label: 'Manage members & roles', icon: 'i-users', onClick: () => { c.tab = 'members'; if (!c.members.length) loadMembers(); app.render(); } });
            items.push({ label: 'Copy invite code', icon: 'i-link', onClick: () => copyCode(cm.invite_code) });
            items.push({ label: 'Leave community', icon: 'i-logout', danger: true, onClick: () => leave(cm) });
            if (role === 'owner') items.push({ label: 'Delete community', icon: 'i-trash', danger: true, onClick: () => destroy(cm) });
            app.openPopover(el, items);
        },
        'cm-member-menu': el => {
            const cm = c.current;
            const m = c.members.find(x => x.user_id === el.dataset.id);
            if (!cm || !m) return;
            const mine = roleOf(cm.id);
            const name = m.profile ? m.profile.display_name.split(' ')[0] : 'them';
            const items = [];
            if (mine === 'owner' && m.role !== 'admin') items.push({ label: `Make ${name} an admin`, icon: 'i-lock', onClick: () => setRole(m.user_id, 'admin') });
            if (['owner', 'admin'].includes(mine) && m.role !== 'moderator') items.push({ label: `Make ${name} a moderator`, icon: 'i-checks', onClick: () => setRole(m.user_id, 'moderator') });
            if (['owner', 'admin'].includes(mine) && m.role !== 'member') items.push({ label: 'Change to member', icon: 'i-user', onClick: () => setRole(m.user_id, 'member') });
            if (m.role === 'member') {
                items.push({ label: 'Mute in chat for 1 hour', icon: 'i-volume-off', onClick: () => muteMember(m.user_id, 60) });
                items.push({ label: 'Mute in chat for 1 day', icon: 'i-volume-off', onClick: () => muteMember(m.user_id, 1440) });
                items.push({ label: 'Unmute', icon: 'i-volume', onClick: () => muteMember(m.user_id, 0) });
            }
            if (mine === 'owner') items.push({ label: `Hand ownership to ${name}`, icon: 'i-user-plus', onClick: async () => {
                const ok = await app.ask({ title: `Make ${name} the owner?`, text: `${name} will own ${cm.name}. You’ll become an admin. This can’t be undone by you.`, ok: 'Hand over', danger: true });
                if (!ok) return;
                const { error } = await client.rpc('diary_transfer_community', { cid: cm.id, target: m.user_id });
                if (error) return app.showToast(error.message || 'Couldn’t hand it over');
                c.memberships.set(cm.id, 'admin');
                await loadMembers();
                app.showToast(`${name} now owns ${cm.name}`);
                app.render();
            } });
            items.push({ label: `Remove ${name}`, icon: 'i-close', danger: true, onClick: () => app.actions['cm-remove-member']({ dataset: { id: m.user_id } }) });
            items.push({ label: `Ban ${name}`, icon: 'i-block', danger: true, onClick: async () => {
                const res = await app.ask({ title: `Ban ${name} from ${cm.name}?`, text: 'They’re removed and can’t rejoin, even with an invite code, until a moderator lifts the ban. Add a reason for the other moderators (optional).', value: '', placeholder: 'Reason', allowEmpty: true, ok: 'Ban', danger: true });
                if (!res) return;
                const { error } = await client.rpc('diary_ban_member', { p_cid: cm.id, p_user: m.user_id, p_reason: (res.value || '').trim() || null });
                if (error) return app.showToast(error.message === 'Not allowed' ? 'You can only ban people below your role' : 'Couldn’t ban them');
                c.members = c.members.filter(x => x.user_id !== m.user_id);
                app.showToast(`${name} is banned from ${cm.name}`);
                app.render();
            } });
            items.unshift({ label: `View ${name}’s profile`, icon: 'i-user', onClick: () => window.diaryProfile && window.diaryProfile.open(m.user_id) });
            app.openPopover(el, items);
        },
        'cm-chat-settings': el => {
            const cm = c.current;
            const staffOnly = cm.chat_mode === 'staff';
            const set = async fields => {
                const { error } = await client.from('diary_communities').update(fields).eq('id', cm.id);
                if (error) return app.showToast('Couldn’t change the chat settings');
                Object.assign(cm, fields);
                app.render();
            };
            app.openPopover(el, [
                { label: staffOnly ? 'Let everyone chat' : 'Announcements only (staff can post)', icon: staffOnly ? 'i-chat' : 'i-lock', onClick: () => set({ chat_mode: staffOnly ? 'everyone' : 'staff' }) },
                { label: cm.slow_mode ? 'Turn off slow mode' : 'Slow mode: one message every 30s', icon: 'i-clock', onClick: () => set({ slow_mode: cm.slow_mode ? 0 : 30 }) }
            ]);
        },
        'cm-remove-member': async el => {
            const m = c.members.find(x => x.user_id === el.dataset.id);
            const ok = await app.ask({ title: `Remove ${m && m.profile ? m.profile.display_name : 'this member'}?`, text: 'They can rejoin a public community, or with the invite code.', ok: 'Remove', danger: true });
            if (!ok) return;
            const { error } = await client.from('diary_community_members').delete().eq('community_id', c.current.id).eq('user_id', el.dataset.id);
            if (error) return app.showToast('Couldn’t remove that member');
            c.members = c.members.filter(x => x.user_id !== el.dataset.id);
            c.current.members = [{ count: Math.max(0, memberCount(c.current) - 1) }];
            app.render();
        },
        'cm-add-photos': async () => addDraftPhotos(await Media.pickFiles('image/*')),
        'cm-camera': async () => addDraftPhotos(await Media.pickFiles('image/*', false, 'environment')),
        'cm-edit-photo': async el => {
            const photo = c.draft.photos.find(p => p.id === el.dataset.id);
            if (!photo || !window.PhotoEditor) return;
            const edited = await window.PhotoEditor.open(photo.file, { title: 'Edit photo', done: 'Use photo' });
            if (!edited) return;
            URL.revokeObjectURL(photo.preview);
            photo.file = edited;
            photo.preview = URL.createObjectURL(edited);
            renderDraftPhotos();
        },
        'cm-remove-photo': el => {
            const photo = c.draft.photos.find(p => p.id === el.dataset.id);
            if (photo) URL.revokeObjectURL(photo.preview);
            c.draft.photos = c.draft.photos.filter(p => p.id !== el.dataset.id);
            renderDraftPhotos();
        },
        'cm-share-note': el => pickNoteToShare(el),
        'cm-filter': el => { c.filter = el.dataset.filter; app.render(); },
        'cm-poll': () => {
            c.draft.poll = c.draft.poll ? null : { question: '', options: ['', ''] };
            app.render();
            const q = content.querySelector('[data-poll="q"]');
            if (q) q.focus();
        },
        'cm-poll-add': () => {
            if (c.draft.poll && c.draft.poll.options.length < 4) c.draft.poll.options.push('');
            app.render();
            const inputs = content.querySelectorAll('.cm-poll-in.opt');
            if (inputs.length) inputs[inputs.length - 1].focus();
        },
        'cm-poll-remove': () => { c.draft.poll = null; app.render(); },
        'cm-vote': el => vote(el.dataset.id, Number(el.dataset.opt)),
        'cm-answer-prompt': () => {
            const text = $('cm-text');
            if (!text) return;
            if (!c.draft.text.trim()) {
                c.draft.text = `💬 ${weeklyPrompt(c.current)}\n`;
                text.value = c.draft.text;
            }
            text.scrollIntoView({ behavior: 'smooth', block: 'center' });
            text.focus();
            text.setSelectionRange(text.value.length, text.value.length);
        },
        'cm-call': () => {
            if (!window.diaryCalls) return app.showToast('Calls aren’t supported in this browser');
            window.diaryCalls.joinCommunity(c.current);
        },
        'cm-call-member': el => {
            const m = c.members.find(x => x.user_id === el.dataset.id);
            if (m && window.diaryCalls) window.diaryCalls.callUser(m.profile || { id: m.user_id, display_name: 'Member' });
        }
    });

    content.addEventListener('submit', e => {
        const form = e.target.closest('form[data-form="cm-post"]');
        if (!form) return;
        e.preventDefault();
        postUpdate();
    });

    content.addEventListener('input', e => {
        if (e.target.id === 'cm-search') {
            c.query = e.target.value;
            // Filter cards in place so typing isn't interrupted
            const q = c.query.trim().toLowerCase();
            content.querySelectorAll('.cm-card[data-id], .cm-trend[data-id]').forEach(card => {
                card.hidden = !!q && !card.textContent.toLowerCase().includes(q);
            });
            const trending = content.querySelector('.cm-trending-wrap');
            if (trending) trending.hidden = !!q;
            return;
        }
        if (e.target.dataset && e.target.dataset.poll && c.draft.poll) {
            const k = e.target.dataset.poll;
            if (k === 'q') c.draft.poll.question = e.target.value;
            else c.draft.poll.options[Number(k)] = e.target.value;
            return;
        }
        if (e.target.id !== 'cm-text') return;
        c.draft.text = e.target.value;
        e.target.style.height = 'auto';
        e.target.style.height = Math.min(e.target.scrollHeight, 240) + 'px';
    });
});
