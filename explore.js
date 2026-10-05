// Explore: what's trending in your circle — hot posts, #tags, reels, who's live, the Library and communities —
// with one search box across all of it. Everything comes from data the other pages already load (so it
// respects the same privacy rules); posts are ranked by likes, comments and reposts, fading with age.
document.addEventListener('DOMContentLoaded', () => {
    const app = window.diaryApp;
    const social = window.diarySocial;
    if (!app || !social || !social.available) return;
    const I = social.internals;
    const { esc, avatar, timeAgo } = I;
    const s = I.state;
    const content = document.getElementById('content');
    const FEED_BUCKET = 'diary-feed';
    const TABS = [['all', 'For you'], ['news', 'News'], ['posts', 'Posts'], ['reels', 'Reels'], ['live', 'Live'], ['spaces', 'Spaces'], ['library', 'Library'], ['groups', 'Communities'], ['people', 'People']];
    const TAB_ICONS = { all: 'i-sparkle', news: 'i-globe', posts: 'i-feed', reels: 'i-reel', live: 'i-live', spaces: 'i-headphones', library: 'i-book', groups: 'i-users', people: 'i-user-plus' };

    // ---------- News ----------
    // Headlines come from publishers' feeds through our diary-news function; each story opens on the publisher's site
    const NEWS_KINDS = [['world', 'World'], ['local', 'Local'], ['business', 'Business'], ['technology', 'Tech'], ['sports', 'Sports'], ['health', 'Health'], ['science', 'Science'], ['entertainment', 'Entertainment']];
    const COUNTRIES = [['NG', 'Nigeria'], ['GH', 'Ghana'], ['KE', 'Kenya'], ['ZA', 'South Africa'], ['EG', 'Egypt'], ['GB', 'United Kingdom'], ['US', 'United States'], ['CA', 'Canada'], ['IN', 'India'], ['AU', 'Australia'], ['FR', 'France'], ['DE', 'Germany'], ['AE', 'UAE'], ['BR', 'Brazil'], ['CN', 'China'], ['JP', 'Japan']];
    const TZ_COUNTRY = { 'Africa/Lagos': 'NG', 'Africa/Accra': 'GH', 'Africa/Nairobi': 'KE', 'Africa/Johannesburg': 'ZA', 'Africa/Cairo': 'EG', 'Europe/London': 'GB', 'America/New_York': 'US', 'America/Chicago': 'US', 'America/Los_Angeles': 'US', 'America/Toronto': 'CA', 'Asia/Kolkata': 'IN', 'Australia/Sydney': 'AU', 'Europe/Paris': 'FR', 'Europe/Berlin': 'DE', 'Asia/Dubai': 'AE', 'America/Sao_Paulo': 'BR', 'Asia/Shanghai': 'CN', 'Asia/Tokyo': 'JP' };
    const N = {
        kind: 'world',
        results: new Map(),   // request key -> { items, at, error, loading }
        place: (() => {
            try { const saved = JSON.parse(localStorage.getItem('diaryNewsPlace')); if (saved && saved.country) return saved; } catch (e) {}
            let tz = '';
            try { tz = Intl.DateTimeFormat().resolvedOptions().timeZone; } catch (e) {}
            const fromLang = (navigator.language || '').split('-')[1];
            return { country: TZ_COUNTRY[tz] || (fromLang && fromLang.length === 2 ? fromLang.toUpperCase() : 'US'), city: '' };
        })()
    };
    const countryName = code => (COUNTRIES.find(c => c[0] === code) || [code, code])[1];

    function newsRequest(kind) {
        if (kind === 'world') return { scope: 'world', country: N.place.country };
        if (kind === 'local') return { scope: 'local', country: N.place.country, city: N.place.city || '' };
        return { scope: 'topic', topic: kind };
    }

    function loadNews(kind, force = false) {
        const req = newsRequest(kind);
        const key = JSON.stringify(req);
        const have = N.results.get(key);
        if (have && (have.loading || (!force && Date.now() - have.at < (have.error ? 60000 : 10 * 60000)))) return have;
        const entry = { items: have ? have.items : null, at: Date.now(), loading: true, error: false };
        // Show the last copy we saved while the fresh one loads (and when offline)
        if (!entry.items) {
            try { const saved = JSON.parse(localStorage.getItem(`diaryNews:${key}`)); if (saved) entry.items = saved.items; } catch (e) {}
        }
        N.results.set(key, entry);
        (async () => {
            try {
                const token = await social.accessToken();
                if (!token) throw new Error('signin');
                const cfg = window.DIARY_CONFIG;
                const res = await fetch(`${cfg.supabaseUrl}/functions/v1/diary-news`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, apikey: cfg.supabaseKey },
                    body: JSON.stringify(req)
                });
                const data = await res.json();
                if (!res.ok || !Array.isArray(data.items)) throw new Error(data.error || 'news');
                entry.items = data.items;
                entry.sources = data.sources || [];
                entry.error = false;
                try { localStorage.setItem(`diaryNews:${key}`, JSON.stringify({ items: data.items.slice(0, 20) })); } catch (e) {}
            } catch (e) {
                entry.error = e.message === 'signin' ? 'signin' : true;
            }
            entry.loading = false;
            entry.at = Date.now();
            if (!document.getElementById('ex-search')?.value) app.requestRender('explore');
        })();
        return entry;
    }

    function newsAgo(iso) {
        if (!iso) return '';
        const mins = Math.round((Date.now() - Date.parse(iso)) / 60000);
        if (mins < 1) return 'just now';
        if (mins < 60) return `${mins}m ago`;
        if (mins < 1440) return `${Math.round(mins / 60)}h ago`;
        return new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
    }

    function newsCard(item, { big = false } = {}) {
        return `
            <a class="ex-news${big ? ' big' : ''}${item.image ? '' : ' noimg'}" href="${esc(item.link)}" target="_blank" rel="noopener noreferrer">
                ${item.image ? `<span class="exn-img"><img src="${esc(item.image)}" alt="" loading="lazy" referrerpolicy="no-referrer"></span>` : `<span class="exn-img exn-mark" aria-hidden="true">${esc(item.source.slice(0, 1))}</span>`}
                <span class="exn-text">
                    <span class="exn-src">${esc(item.source)} · ${esc(newsAgo(item.published))}</span>
                    <strong>${esc(item.title)}</strong>
                    ${big && item.summary ? `<small>${esc(item.summary)}</small>` : ''}
                </span>
            </a>`;
    }

    function newsBody(entry, { compact = false } = {}) {
        if (!entry.items && entry.loading) return `<div class="ex-row ex-news-row">${'<span class="ex-news skel"></span>'.repeat(compact ? 4 : 5)}</div>`;
        if (!entry.items || !entry.items.length) {
            if (entry.error === 'signin') return '<div class="ex-empty small"><strong>Sign in to see the news</strong><span>World and local headlines appear once you’re signed in.</span></div>';
            return `<div class="ex-empty small"><strong>${!navigator.onLine ? 'You’re offline' : 'Couldn’t load the news'}</strong><span>${!navigator.onLine ? 'Headlines will load when you’re back online.' : 'Try again in a moment.'}</span><button type="button" class="chip" data-action="ex-news-retry">Try again</button></div>`;
        }
        if (compact) return `<div class="ex-row ex-news-row">${entry.items.slice(0, 8).map(i => newsCard(i)).join('')}</div>`;
        const [lead, ...rest] = entry.items;
        return `<div class="ex-news-list">${newsCard(lead, { big: true })}${rest.map(i => newsCard(i)).join('')}</div>`;
    }

    function newsSection(kind, compact) {
        const entry = loadNews(kind);
        const title = kind === 'world' ? 'World news' : kind === 'local' ? `Around you · ${esc(N.place.city ? `${N.place.city}, ` : '')}${esc(countryName(N.place.country))}` : `${(NEWS_KINDS.find(k => k[0] === kind) || ['', 'News'])[1]} news`;
        const sub = kind === 'world' ? 'Top stories from around the world' : kind === 'local' ? 'Headlines from your country' : 'The latest in this topic';
        const more = compact ? `<button type="button" class="link-btn accent ex-more" data-action="ex-news-open" data-kind="${kind}">See all</button>` : '';
        return `<section class="ex-sec">${head(kind === 'local' ? 'i-pin' : 'i-feed', title, sub, more)}${newsBody(entry, { compact })}</section>`;
    }

    function newsTab() {
        const kind = N.kind;
        const listen = window.Speak && window.Speak.supported ? '<button type="button" class="chip ex-news-listen" data-action="ex-news-listen"><svg class="i"><use href="#i-volume"/></svg>Listen to the headlines</button>' : '';
        return `
            <section class="ex-sec">
                <div class="ex-news-kinds" role="tablist" aria-label="News">
                    ${NEWS_KINDS.map(([k, l]) => `<button type="button" class="cm-filter" role="tab" aria-selected="${kind === k}" data-action="ex-news-kind" data-kind="${k}">${l}</button>`).join('')}
                </div>
                ${kind === 'local' ? `
                    <form class="ex-place" data-form="ex-place">
                        <label><span>Country</span><select id="ex-country">${COUNTRIES.map(([c, n]) => `<option value="${c}"${c === N.place.country ? ' selected' : ''}>${n}</option>`).join('')}${COUNTRIES.some(c => c[0] === N.place.country) ? '' : `<option value="${esc(N.place.country)}" selected>${esc(N.place.country)}</option>`}</select></label>
                        <label><span>City (optional)</span><input id="ex-city" value="${esc(N.place.city || '')}" placeholder="e.g. Lagos" maxlength="60" autocomplete="address-level2"></label>
                        <button type="submit" class="chip">Update</button>
                    </form>` : ''}
                <div class="ex-news-bar"><span class="muted small">${kind === 'local' ? `Local headlines for ${esc(countryName(N.place.country))}` : 'Headlines'} · tap a story to read it on the publisher’s site</span>${listen}</div>
            </section>
            ${newsSection(kind, false)}`;
    }
    const TILE_TINTS = [['#4f46e5', '#a855f7'], ['#0f766e', '#22c55e'], ['#be123c', '#f97316'], ['#1d4ed8', '#06b6d4'], ['#7c2d12', '#eab308'], ['#6d28d9', '#ec4899']];

    const E = { tab: 'all', query: '', groups: null, groupsLoading: false };

    // ---------- Ranking ----------
    function score(p) {
        const likes = (p.likes || []).length;
        const comments = I.commentCount(p);
        const reposts = (p.reposts || []).length;
        const photos = (p.photos || []).length ? 1 : 0;
        const hours = Math.max(0, (Date.now() - (p.sortAt || Date.parse(p.shared_at))) / 3600000);
        return (1 + likes * 2 + comments * 3 + reposts * 4 + photos) / Math.pow(hours + 2, 1.15);
    }

    function trendingPosts() {
        const feed = s.feed || [];
        const recent = feed.filter(p => Date.now() - Date.parse(p.shared_at) < 14 * 86400000);
        return (recent.length >= 3 ? recent : feed).slice().sort((a, b) => score(b) - score(a));
    }

    function trendingTags() {
        const counts = new Map();
        (s.feed || []).forEach(p => I.hashtags(p).forEach(t => {
            const cur = counts.get(t) || { n: 0, heat: 0 };
            counts.set(t, { n: cur.n + 1, heat: cur.heat + score(p) });
        }));
        return [...counts.entries()].sort((a, b) => b[1].heat - a[1].heat).slice(0, 10);
    }

    function trendingReels() {
        const reels = window.diaryStories ? window.diaryStories.feedReels({}) : [];
        return reels.slice().sort((a, b) => ((b.likes || []).length * 2 + ((b.comments && b.comments[0] && b.comments[0].count) || 0) * 3)
            - ((a.likes || []).length * 2 + ((a.comments && a.comments[0] && a.comments[0].count) || 0) * 3)
            || Date.parse(b.created_at) - Date.parse(a.created_at));
    }

    async function loadGroups() {
        if (E.groupsLoading || !window.diaryCommunities || !window.diaryCommunities.all) return;
        E.groupsLoading = true;
        try { E.groups = await window.diaryCommunities.all(); } catch (e) { E.groups = []; }
        E.groupsLoading = false;
        app.requestRender('explore');
    }

    // ---------- Pieces ----------
    const head = (icon, title, sub, more = '') => `
        <header class="ex-head">
            <h3><span class="ex-ic"><svg class="i"><use href="#${icon}"/></svg></span>${title}</h3>
            ${sub ? `<p>${sub}</p>` : ''}
            ${more}
        </header>`;

    function postTile(p, rank) {
        const photo = (p.photos || []).find(ph => ph && typeof ph.path === 'string');
        const tint = TILE_TINTS[Math.abs([...p.id].reduce((h, c) => h * 31 + c.charCodeAt(0), 7)) % TILE_TINTS.length];
        const name = nameOf(p);
        const text = (p.title || p.body || '').trim();
        return `
            <button type="button" class="ex-tile${photo ? ' photo' : ' text'}${rank < 3 ? ' hot' : ''}" data-action="ex-post" data-id="${esc(p.id)}"
                style="--t1:${tint[0]};--t2:${tint[1]}" aria-label="${esc(`${name}: ${text.slice(0, 80)}`)}">
                ${photo ? `<img data-path="${esc(photo.path)}" data-bucket="${FEED_BUCKET}" alt="" loading="lazy">`
                    : `<span class="ex-tile-text">${p.title ? `<strong>${esc(p.title)}</strong>` : ''}${esc((p.body || '').slice(0, 160))}</span>`}
                ${rank < 3 ? `<span class="ex-rank" aria-label="Trending number ${rank + 1}"><svg class="i"><use href="#i-flame"/></svg>${rank + 1}</span>` : ''}
                <span class="ex-tile-foot">
                    <span class="ex-who">${avatar({ id: p.author, ...(p.author_profile || {}) }, 'xs')}${esc(name)}</span>
                    <span class="ex-stats"><svg class="i"><use href="#i-heart-fill"/></svg>${(p.likes || []).length}<svg class="i"><use href="#i-chat"/></svg>${I.commentCount(p)}</span>
                </span>
            </button>`;
    }

    function reelTile(r) {
        const p = r.author_profile || { display_name: 'Someone' };
        return `
            <button type="button" class="ex-reel" data-action="reel-open" data-id="${esc(r.id)}" aria-label="Reel by ${esc(p.display_name)}">
                ${r.poster_path ? `<img data-path="${esc(r.poster_path)}" data-bucket="diary-reels" alt="" loading="lazy">` : ''}
                <span class="ex-reel-play" aria-hidden="true"><svg class="i"><use href="#i-play"/></svg></span>
                <span class="ex-reel-foot"><strong>${esc(p.display_name)}</strong><small><svg class="i"><use href="#i-heart-fill"/></svg>${(r.likes || []).length}</small></span>
            </button>`;
    }

    // ---------- Live now: real-time rooms as a first-class part of Explore ----------
    // Live videos (live.js) and audio rooms (spaces.js) side by side; Go live / Host a room always one tap away.
    // Nothing heavy loads here — the stream only starts when you open it.
    function liveNowHTML() {
        const LV = window.diaryLive, SP = window.diarySpaces;
        if (!LV && !SP) return '';
        if (LV && LV.ensure) LV.ensure();
        const lives = LV ? LV.list() : [];
        const rooms = SP && SP.rooms ? SP.rooms() : [];
        const states = [LV && LV.state ? LV.state() : 'ok', SP && SP.state ? SP.state() : 'ok'];
        const n = lives.length + rooms.length;
        const loading = !n && states.includes('loading');
        const failed = !n && !loading && states.includes('error');
        const see = n ? seeAll(lives.length ? 'data-action="ex-tab" data-tab="live"' : 'data-action="go-spaces"') : '';
        let body;
        if (loading) body = `<div class="ln-rail" aria-busy="true" aria-label="Loading live sessions">${'<span class="ln-card skel"></span>'.repeat(3)}</div>`;
        else if (n) body = `<div class="ln-rail" role="list" aria-label="Live now">${lives.map(liveTile).join('')}${rooms.map(roomTile).join('')}</div>`;
        else body = `<div class="ln-empty" role="status"><span class="ln-empty-ic" aria-hidden="true"><svg class="i"><use href="#i-live"/></svg></span><span><strong>${failed ? 'Couldn’t load live sessions' : 'Nothing live right now'}</strong><small>${failed ? 'You can still start your own.' : 'Be the first — start something people can join in real time.'}</small></span>${failed ? '<button type="button" class="link-btn accent" data-action="ex-live-retry">Try again</button>' : ''}</div>`;
        return `
            <section class="ex-sec ln${n ? ' on' : ''}" aria-labelledby="ln-h">
                <header class="ex-head"><h3 id="ln-h"><span class="ln-dot${n ? ' on' : ''}" aria-hidden="true"></span>Live now${n ? ` <span class="ln-count" aria-label="${n} live">${n}</span>` : ''}</h3>${see}</header>
                ${n ? "" : body}
                <div class="ln-acts" role="group" aria-label="Start something live">
                    <button type="button" class="ln-btn primary" data-action="live-start" aria-label="Go live on video"><svg class="i" aria-hidden="true"><use href="#i-live"/></svg><span><strong>Go live</strong><small>Video</small></span></button>
                    <button type="button" class="ln-btn" data-action="space-new" aria-label="Host an audio room"><svg class="i" aria-hidden="true"><use href="#i-headphones"/></svg><span><strong>Host a room</strong><small>Audio</small></span></button>
                </div>
                ${n ? body : ""}
            </section>`;
    }
    function liveTile(x) {
        const p = x.host_profile || { display_name: 'Someone' };
        const mine = x.host === s.profile.id;
        const who = mine ? s.profile.display_name : p.display_name || 'Someone';
        return `
            <button type="button" role="listitem" class="ln-card video" data-action="live-watch" data-id="${esc(x.id)}" aria-label="${esc(who)} is live on video: ${esc(x.title || 'Live now')}. Watch">
                <span class="ln-badges"><span class="ln-live">LIVE</span><span class="ln-kind"><svg class="i" aria-hidden="true"><use href="#i-video"/></svg>Video</span></span>
                <span class="ln-av">${avatar({ id: x.host, ...p }, 'lg')}</span>
                <strong class="ln-title">${esc(x.title || 'Live now')}</strong>
                <span class="ln-who">${esc(who)}</span>
                <span class="ln-meta">Started ${esc(timeAgo(x.started_at))}<span class="ln-join">Watch</span></span>
            </button>`;
    }
    function roomTile(x) {
        const p = x.host_profile || { display_name: 'Someone' };
        const who = x.mine ? s.profile.display_name : p.display_name || 'Someone';
        const n = Math.max(Number(x.listening || 0), 1);
        return `
            <button type="button" role="listitem" class="ln-card audio" data-action="space-open" data-id="${esc(x.id)}" aria-label="Audio room: ${esc(x.title)}, hosted by ${esc(who)}, ${n} listening. Join">
                <span class="ln-badges"><span class="ln-live">LIVE</span><span class="ln-kind"><svg class="i" aria-hidden="true"><use href="#i-headphones"/></svg>Audio</span></span>
                <span class="ln-av">${avatar({ id: x.host, ...p }, 'lg')}</span>
                <strong class="ln-title">${esc(x.title || 'Audio room')}</strong>
                <span class="ln-who">${esc(who)}</span>
                <span class="ln-meta">${n} listening<span class="ln-join">Join</span></span>
            </button>`;
    }

    function liveCards() {
        const list = window.diaryLive ? window.diaryLive.list() : [];
        const cards = list.map(x => {
            const p = x.host_profile || { display_name: 'Someone' };
            const mine = x.host === s.profile.id;
            return `
                <button type="button" class="lv-tile" data-action="live-watch" data-id="${esc(x.id)}" aria-label="${esc(mine ? 'Your live' : p.display_name)} — ${esc(x.title || 'Live now')}">
                    <span class="lv-tile-top"><span class="lv-tile-live">LIVE</span>${x.audience === 'public' ? '<span class="lv-tile-aud" title="Open to everyone"><svg class="i"><use href="#i-globe"/></svg></span>' : ''}</span>
                    <span class="lv-tile-av">${avatar({ id: x.host, ...p }, 'lg')}</span>
                    <span class="lv-tile-text"><strong>${mine ? 'You’re live' : esc(p.display_name)}</strong><small>${esc(x.title || 'Live now')}</small><small class="lv-tile-time">started ${timeAgo(x.started_at)}</small></span>
                </button>`;
        }).join('');
        return `${cards}
            <button type="button" class="lv-tile go" data-action="live-start">
                <span class="lv-tile-av go"><svg class="i"><use href="#i-live"/></svg></span>
                <span class="lv-tile-text"><strong>Go live</strong><small>To everyone, or just friends and followers</small></span>
            </button>`;
    }

    function bookTile(x) {
        return `
            <button type="button" class="ex-book" data-action="lib-open" data-id="${esc(x.id)}">
                ${window.diaryLibrary.cover(x)}
                <strong>${esc(x.title)}</strong>
                <small>${esc((x.author_profile && x.author_profile.display_name) || 'Someone')} · <svg class="i"><use href="#i-heart-fill"/></svg>${(x.likes || []).length}</small>
            </button>`;
    }

    function groupCard(g) {
        return `
            <div class="ex-group" style="--g:${esc(g.color || '#4f46e5')}">
                <span class="ex-group-emoji" aria-hidden="true">${esc(g.emoji || '👥')}</span>
                <span class="ex-group-text"><strong>${esc(g.name)}</strong><small>${g.size} ${g.size === 1 ? 'member' : 'members'}${g.description ? ` · ${esc(g.description.slice(0, 60))}` : ''}</small></span>
                <button type="button" class="${g.joined ? 'chip' : 'primary-btn small'}" data-action="cm-open" data-id="${esc(g.id)}">${g.joined ? 'Open' : 'View'}</button>
            </div>`;
    }

    function personRow(p) {
        return `
            <div class="ex-person">
                ${avatar(p, 'md')}
                <span class="ex-person-text"><strong>${esc(p.display_name)}</strong><small>${p.mutual ? `${p.mutual} mutual friend${p.mutual === 1 ? '' : 's'}` : `@${esc(p.username)}`}</small></span>
                ${I.followButton(p)}
                <button type="button" class="primary-btn small" data-action="suggest-add" data-username="${esc(p.username)}"><svg class="i"><use href="#i-user-plus"/></svg>Add</button>
            </div>`;
    }

    // ---------- Search across everything ----------
    // Recent searches stay on this device only
    const RECENT_KEY = 'diaryExploreRecent';
    const recent = () => { try { return JSON.parse(localStorage.getItem(RECENT_KEY)) || []; } catch (e) { return []; } };
    function remember(q) {
        q = String(q || '').trim();
        if (q.length < 2) return;
        const list = [q, ...recent().filter(x => x.toLowerCase() !== q.toLowerCase())].slice(0, 8);
        try { localStorage.setItem(RECENT_KEY, JSON.stringify(list)); } catch (e) {}
    }
    function forget(q) {
        const list = q ? recent().filter(x => x !== q) : [];
        try { localStorage.setItem(RECENT_KEY, JSON.stringify(list)); } catch (e) {}
    }

    // A note is a shared entry with a title and no media; a Playnote result is the #trivia share
    const isPlaynotePost = p => /#trivia\b/i.test(p.body || '');
    const isNotePost = p => !!(p.title && (p.body || '').trim() && !(p.photos || []).length && !p.audio && !isPlaynotePost(p) && !/^📊 /.test(p.title));
    const nameOf = p => (p.author === s.profile.id ? s.profile.display_name : (p.author_profile && p.author_profile.display_name)) || 'A friend';

    function noteRow(p) {
        return `
            <button type="button" class="ex-r ex-r-note" data-action="ex-post" data-id="${esc(p.id)}">
                <span class="ex-r-ic note" aria-hidden="true"><svg class="i"><use href="#i-note"/></svg></span>
                <span class="ex-r-text"><strong>${esc(p.title)}</strong><small>${esc(nameOf(p))} · ${esc((p.body || '').replace(/\s+/g, ' ').slice(0, 90))}</small></span>
                <span class="ex-r-go">Read</span>
            </button>`;
    }
    function postRow(p) {
        const text = (p.title || p.body || '').replace(/\s+/g, ' ').trim();
        const photo = (p.photos || []).find(ph => ph && typeof ph.path === 'string');
        return `
            <button type="button" class="ex-r" data-action="ex-post" data-id="${esc(p.id)}">
                ${photo ? `<span class="ex-r-thumb"><img data-path="${esc(photo.path)}" data-bucket="${FEED_BUCKET}" alt="" loading="lazy"></span>` : `<span class="ex-r-av">${avatar({ id: p.author, ...(p.author_profile || {}) }, 'md')}</span>`}
                <span class="ex-r-text"><strong>${esc(nameOf(p))}</strong><small>${esc(text.slice(0, 110))}</small></span>
                <span class="ex-r-meta"><svg class="i"><use href="#i-heart-fill"/></svg>${(p.likes || []).length}</span>
            </button>`;
    }
    // Playnote: today's challenges and the puzzles, matched by name
    function playnoteMatches(q) {
        const daily = [['Daily trivia', 'Ten questions, the same for everyone'], ['Weekly challenge', 'Twenty questions, new every Monday'], ['Bible challenge', 'Five questions from Scripture'], ['Brain challenge', 'One puzzle — think before you tap'], ['Question of the day', 'Then see how everyone answered']]
            .filter(([t, d]) => `${t} ${d} trivia quiz playnote`.toLowerCase().includes(q)).map(([t, d]) => ({ title: t, sub: d, attrs: 'data-action="go-play"' }));
        const games = window.diaryGames && window.diaryGames.GAMES ? Object.entries(window.diaryGames.GAMES)
            .filter(([k, g]) => `${g.title} ${g.sub || ''} game puzzle playnote`.toLowerCase().includes(q)).map(([k, g]) => ({ title: g.title, sub: g.sub || 'Puzzle', attrs: `data-game="${esc(k)}"` })) : [];
        return [...daily, ...games].slice(0, 6);
    }
    function playRow(x) {
        return `
            <button type="button" class="ex-r ex-r-play" ${x.attrs}>
                <span class="ex-r-ic play" aria-hidden="true"><svg class="i"><use href="#i-trophy"/></svg></span>
                <span class="ex-r-text"><strong>${esc(x.title)}</strong><small>${esc(x.sub)}</small></span>
                <span class="ex-r-go">Play</span>
            </button>`;
    }
    const groupHead = (title, n) => `<h3 class="ex-r-h">${title}${n ? ` <span>${n}</span>` : ''}</h3>`;

    // Search mode with nothing typed yet: recent searches, topics, people
    function searchIdle() {
        const r = recent();
        const tags = trendingTags().slice(0, 8);
        const people = (s.suggestions || []).slice(0, 4);
        if (!r.length && !tags.length && !people.length) return '<div class="ex-empty small"><strong>Search Cordial</strong><span>Find people, notes, posts, #tags, books, groups and games.</span></div>';
        return `
            ${r.length ? `<section class="ex-sec ex-recent" aria-labelledby="ex-recent-h">
                <header class="ex-head"><h3 id="ex-recent-h">Recent</h3><button type="button" class="link-btn ex-more" data-action="ex-recent-clear">Clear all</button></header>
                <ul class="ex-recent-list">${r.map(x => `<li><button type="button" class="ex-recent-go" data-action="ex-recent" data-q="${esc(x)}"><svg class="i"><use href="#i-clock"/></svg>${esc(x)}</button><button type="button" class="ex-recent-x" data-action="ex-recent-forget" data-q="${esc(x)}" aria-label="Remove ${esc(x)} from recent searches"><svg class="i"><use href="#i-close"/></svg></button></li>`).join('')}</ul>
            </section>` : ''}
            ${tags.length ? `<section class="ex-sec"><header class="ex-head"><h3>Topics</h3></header><div class="ex-topics wrap">${tags.map(([t]) => `<button type="button" class="ex-topic" data-action="ex-tag" data-tag="${esc(t)}">#${esc(t)}</button>`).join('')}</div></section>` : ''}
            ${people.length ? `<section class="ex-sec"><header class="ex-head"><h3>People you may know</h3></header><div class="ex-people">${people.map(personRow).join('')}</div></section>` : ''}`;
    }

    function searchResults(q) {
        const has = t => (t || '').toLowerCase().includes(q);
        const posts = (s.feed || []).filter(p => has(p.title) || has(p.body) || has(p.author_profile && p.author_profile.display_name) || I.hashtags(p).some(t => t.includes(q.replace(/^#/, '')))).slice(0, 12);
        const tags = trendingTags().filter(([t]) => t.includes(q.replace(/^#/, ''))).slice(0, 8);
        const everyone = I.peopleResults ? I.peopleResults(q) : '';
        const people = everyone ? [] : [...s.friends, ...s.suggestions].filter(p => has(p.display_name) || has(p.username)).slice(0, 8);
        const groups = (E.groups || []).filter(g => has(g.name) || has(g.description)).slice(0, 6);
        const books = window.diaryLibrary ? window.diaryLibrary.popular(100).filter(x => has(x.title) || has(x.genre) || has(x.description)).slice(0, 8) : [];
        const notes = posts.filter(isNotePost);
        const others = posts.filter(p => !isNotePost(p));
        const plays = playnoteMatches(q);
        const total = posts.length + tags.length + people.length + groups.length + books.length + plays.length;
        if (!total && !everyone) return `<div class="ex-empty"><svg class="i"><use href="#i-search"/></svg><strong>Nothing found for “${esc(q)}”</strong><span>Try a name, a #tag or a word from a post.</span></div>`;
        return `
            ${tags.length ? `<section class="ex-sec">${head('i-tag', 'Tags')}<div class="ex-tags">${tags.map(([t, v]) => `<button type="button" class="ex-tag" data-action="ex-tag" data-tag="${esc(t)}">#${esc(t)}<small>${v.n}</small></button>`).join('')}</div></section>` : ''}
            ${everyone ? `<section class="ex-sec">${everyone}</section>` : ''}
            ${people.length ? `<section class="ex-sec">${head('i-users', 'People')}<div class="ex-people">${people.map(p => s.friends.includes(p)
                ? `<div class="ex-person">${avatar(p, 'md')}<span class="ex-person-text"><strong>${esc(p.display_name)}</strong><small>@${esc(p.username)} · friend</small></span><button type="button" class="chip" data-action="message-friend" data-id="${esc(p.id)}">Message</button></div>`
                : personRow(p)).join('')}</div></section>` : ''}
            ${notes.length ? `<section class="ex-sec">${groupHead('Notes', notes.length)}<div class="ex-r-list">${notes.map(noteRow).join('')}</div></section>` : ''}
            ${plays.length ? `<section class="ex-sec">${groupHead('Playnote')}<div class="ex-r-list">${plays.map(playRow).join('')}</div></section>` : ''}
            ${others.length ? `<section class="ex-sec">${groupHead('Posts', others.length)}<div class="ex-r-list">${others.map(postRow).join('')}</div></section>` : ''}
            ${books.length ? `<section class="ex-sec">${head('i-book', 'Library')}<div class="ex-row">${books.map(bookTile).join('')}</div></section>` : ''}
            ${groups.length ? `<section class="ex-sec">${head('i-users', 'Communities')}<div class="ex-groups">${groups.map(groupCard).join('')}</div></section>` : ''}`;
    }

    // ---------- Page ----------
    // "For you" is a calm discovery page: one featured post, a trending rail, what's happening now, then rails
    // for reels, games, people and news. Everything else (Library, Communities, Marketplace, local news, the full
    // tag list) lives one tap away in its own tab or under "More to explore".
    const fyHead = (title, more = '', id = '') => `<header class="ex-head"><h3${id ? ` id="${id}"` : ''}>${title}</h3>${more}</header>`;
    const seeAll = (attrs, label = 'See all') => `<button type="button" class="link-btn accent ex-more" ${attrs}>${label}</button>`;

    function featureCard(p) {
        const photo = (p.photos || []).find(ph => ph && typeof ph.path === 'string');
        const name = p.author === s.profile.id ? 'You' : ((p.author_profile && p.author_profile.display_name) || 'A friend');
        const body = (p.body || '').trim();
        const title = (p.title || '').trim() || body.split('\n')[0].slice(0, 90);
        const rest = p.title ? body : body.split('\n').slice(1).join(' ') || (body.length > 90 ? body : '');
        return `
            <button type="button" class="ex-feature${photo ? ' has-photo' : ''}" data-action="ex-post" data-id="${esc(p.id)}" aria-label="${esc(`${name}: ${title}`)}">
                ${photo ? `<span class="ex-feature-img"><img data-path="${esc(photo.path)}" data-bucket="${FEED_BUCKET}" alt="" loading="lazy"></span>` : ''}
                <span class="ex-feature-body">
                    <span class="ex-feature-who">${avatar({ id: p.author, ...(p.author_profile || {}) }, 'xs')}<span>${esc(name)}</span><span class="ex-dot" aria-hidden="true">·</span><span>${esc(timeAgo(p.shared_at))}</span></span>
                    <strong class="ex-feature-title">${esc(title)}</strong>
                    ${rest ? `<span class="ex-feature-text">${esc(rest.slice(0, 220))}</span>` : ''}
                    <span class="ex-feature-foot">
                        <span class="ex-stats"><svg class="i"><use href="#i-heart-fill"/></svg>${(p.likes || []).length}<svg class="i"><use href="#i-chat"/></svg>${I.commentCount(p)}</span>
                        <span class="ex-feature-go">Read post<svg class="i"><use href="#i-forward"/></svg></span>
                    </span>
                </span>
            </button>`;
    }

    function personCard(p) {
        return `
            <div class="ex-pcard">
                <button type="button" class="ex-pcard-who" data-profile="${esc(p.id)}" aria-label="${esc(p.display_name)}’s profile">${avatar(p, 'lg')}</button>
                <strong>${esc(p.display_name)}</strong>
                <small>${p.mutual ? `${p.mutual} mutual` : `@${esc(p.username)}`}</small>
                <button type="button" class="chip accent" data-action="suggest-add" data-username="${esc(p.username)}"><svg class="i"><use href="#i-user-plus"/></svg>Add</button>
            </div>`;
    }

    // ---------- Discovery: interests, communities, creators ----------
    const CATS = [['all', 'All'], ['faith', 'Faith', /church|faith|god|pray|bible|gospel|worship|jesus|christ|psalm|grace/], ['education', 'Education', /study|school|learn|exam|educat|class|lesson|university|student/],
        ['business', 'Business', /business|money|startup|market|sell|finance|invest|brand|hustle/], ['tech', 'Technology', /tech|code|coding|\bai\b|app|software|computer|program|developer/],
        ['sports', 'Sports', /sport|football|soccer|basketball|run|fitness|gym|cycl|match|league/], ['health', 'Health', /health|wellness|mental|diet|doctor|medic|fitness|sleep/],
        ['music', 'Music', /music|song|choir|sing|beat|album|artist|praise/], ['entertainment', 'Entertainment', /movie|film|show|series|comedy|celebr|drama|fun/],
        ['lifestyle', 'Lifestyle', /life|style|food|recipe|travel|fashion|home|family/], ['gaming', 'Gaming', /game|gaming|play|trivia|wordplay|puzzle/],
        ['art', 'Art', /\bart\b|draw|paint|photo|design|poem|poetry|creative/], ['career', 'Career', /career|job|work|\bcv\b|interview|hiring|intern/]];
    E.cat = (() => { try { return sessionStorage.getItem('cordialExCat') || 'all'; } catch (e) { return 'all'; } })();
    const catOf = k => CATS.find(c => c[0] === k) || CATS[0];
    const inCat = (k, text) => k === 'all' || (catOf(k)[2] && catOf(k)[2].test(String(text || '').toLowerCase()));
    const INTERESTS_KEY = () => `cordialInterests:${s.profile.id}`;
    function myInterests() { try { const v = JSON.parse(localStorage.getItem(INTERESTS_KEY()) || 'null'); return Array.isArray(v) ? v : null; } catch (e) { return null; } }
    function saveInterests(list) { try { localStorage.setItem(INTERESTS_KEY(), JSON.stringify(list)); } catch (e) { /* private mode */ } }

    // People whose posts your circle loves most lately (likes, comments and reposts, newer counting more)
    function topCreators(cat) {
        const by = new Map();
        (s.feed || []).forEach(p => {
            if (!p.author || p.author === s.profile.id || Date.now() - Date.parse(p.shared_at) > 45 * 86400000) return;
            if (!inCat(cat, `${p.title || ''} ${p.body || ''}`)) return;
            const cur = by.get(p.author) || { p: { id: p.author, ...(p.author_profile || {}) }, posts: 0, likes: 0, heat: 0 };
            cur.posts++; cur.likes += (p.likes || []).length; cur.heat += score(p);
            by.set(p.author, cur);
        });
        return [...by.values()].sort((a, b) => b.heat - a.heat).slice(0, 12);
    }

    function communityCard(g) {
        const size = g.size || 0;
        return `
            <article class="ex-cc" style="--g:${esc(g.color || '#6366f1')}">
                <button type="button" class="ex-cc-open" data-action="cm-open" data-id="${esc(g.id)}" aria-label="${esc(g.name)}, ${size} ${size === 1 ? 'member' : 'members'}">
                    <span class="ex-cc-cover"><span class="ex-cc-emoji" aria-hidden="true">${esc(g.emoji || '👥')}</span><span class="ex-cc-count"><svg class="i" aria-hidden="true"><use href="#i-users"/></svg>${size >= 1000 ? `${(size / 1000).toFixed(size >= 10000 ? 0 : 1)}K` : size}</span></span>
                    <strong>${esc(g.name)}</strong>
                    <small>${esc((g.description || (g.visibility === 'private' ? 'A private community' : 'A community on Cordial')).slice(0, 110))}</small>
                </button>
                ${g.joined ? `<button type="button" class="chip small ex-cc-btn" data-action="cm-open" data-id="${esc(g.id)}">Open</button>`
                    : `<button type="button" class="chip accent small ex-cc-btn" data-action="ex-join" data-id="${esc(g.id)}"><svg class="i"><use href="#i-plus"/></svg>Join</button>`}
            </article>`;
    }

    function creatorCard(c) {
        const p = c.p;
        const friend = (s.friends || []).some(f => f.id === p.id);
        return `
            <div class="ex-cr">
                <button type="button" class="ex-cr-photo" data-profile="${esc(p.id)}" aria-label="${esc(p.display_name || 'Creator')}’s profile">${avatar(p, 'xl')}</button>
                <strong>${esc(String(p.display_name || 'Someone').split(' ')[0])}${I.tick ? I.tick(p.id) : ''}</strong>
                <small>${c.likes} ${c.likes === 1 ? 'like' : 'likes'} · ${c.posts} ${c.posts === 1 ? 'post' : 'posts'}</small>
                ${friend ? `<button type="button" class="chip small" data-action="message-friend" data-id="${esc(p.id)}">Message</button>` : I.followButton(p, 'chip small accent') || ''}
            </div>`;
    }

    function interestsCard() {
        const picked = new Set(E.pickInterests || []);
        return `
            <section class="ex-interests" aria-labelledby="ex-int-h">
                <h3 id="ex-int-h">What are you interested in?</h3>
                <p>Pick a few — Explore and Groups will put them first. You can change this any time.</p>
                <div class="ex-int-chips" role="group" aria-label="Interests">${CATS.slice(1).map(([k, l]) => `<button type="button" class="ex-int${picked.has(k) ? ' on' : ''}" data-action="ex-interest" data-k="${k}" aria-pressed="${picked.has(k)}">${l}</button>`).join('')}</div>
                <div class="ex-int-acts"><button type="button" class="link-btn" data-action="ex-interests-skip">Not now</button><button type="button" class="primary-btn small" data-action="ex-interests-save"${picked.size ? '' : ' disabled'}>Show me</button></div>
            </section>`;
    }

    function forYou({ loading, posts, reels, people }) {
        const out = [];
        const cat = E.cat;
        const interests = myInterests();
        if (!interests && !E.skipInterests) out.push(interestsCard());
        // Categories (remembered for this visit) and a clear way to start a community
        out.push(`<div class="ex-cats" role="tablist" aria-label="Topics">${CATS.map(([k, l]) => `<button type="button" class="ex-cat" role="tab" aria-selected="${cat === k}" data-action="ex-cat" data-k="${k}">${l}</button>`).join('')}</div>`);
        // Posts and notes in this category
        posts = posts.filter(p => inCat(cat, `${p.title || ''} ${p.body || ''}`));
        // 1. Trending: one compact rail — the most-loved post leads it
        if (loading) out.push(`<section class="ex-sec" aria-busy="true">${fyHead('Trending')}<div class="ex-row ex-rail">${'<span class="ex-tile skel"></span>'.repeat(3)}</div></section>`);
        else if (posts.length) out.push(`<section class="ex-sec" aria-labelledby="ex-trend-h">${fyHead('Trending', posts.length > 10 ? seeAll('data-action="ex-tab" data-tab="posts"') : '', 'ex-trend-h')}
                <div class="ex-row ex-rail">${posts.slice(0, 10).map((p, i) => postTile(p, i)).join('')}</div></section>`);
        // 2. Live now: what's happening in real time, and the two ways to start something
        out.push(liveNowHTML());
        // 3. Notes, reels, people, creators, topics, games, news
        const notes = posts.filter(isNotePost).slice(0, 10);
        if (notes.length) out.push(`<section class="ex-sec" aria-labelledby="ex-notes-h">${fyHead('Notes worth reading', '', 'ex-notes-h')}<div class="ex-row ex-note-rail">${notes.map(p => `
            <button type="button" class="ex-ncard" data-action="ex-post" data-id="${esc(p.id)}">
                <span class="ex-ncard-kind"><svg class="i"><use href="#i-note"/></svg>Note</span>
                <strong>${esc(p.title)}</strong>
                <span class="ex-ncard-text">${esc((p.body || '').replace(/\s+/g, ' ').slice(0, 160))}</span>
                <span class="ex-ncard-who">${avatar({ id: p.author, ...(p.author_profile || {}) }, 'xs')}${esc(nameOf(p))}</span>
            </button>`).join('')}</div></section>`);
        if (reels.length) out.push(`<section class="ex-sec">${fyHead('Popular reels', seeAll('data-action="go-reels"', 'Open Reels'))}<div class="ex-row">${reels.slice(0, 10).map(reelTile).join('')}</div></section>`);
        if (people.length) out.push(`<section class="ex-sec">${fyHead('People you may know', seeAll('data-action="ex-tab" data-tab="people"', 'View all'))}<div class="ex-row ex-people-rail">${people.slice(0, 12).map(personCard).join('')}</div></section>`);
        const creators = topCreators(cat);
        if (creators.length) out.push(`<section class="ex-sec" aria-labelledby="ex-cr-h">${fyHead('Top creators', '', 'ex-cr-h')}<div class="ex-row ex-cr-rail">${creators.map(creatorCard).join('')}</div></section>`);
        const tags = trendingTags();
        if (tags.length) out.push(`<section class="ex-sec">${fyHead('Trending topics', seeAll('data-action="ex-tab" data-tab="posts"', 'View all'))}<div class="ex-topics wrap">${tags.slice(0, 10).map(([t]) => `<button type="button" class="ex-topic" data-action="ex-tag" data-tag="${esc(t)}">#${esc(t)}</button>`).join('')}</div></section>`);
        if (window.diaryPlay) out.push(window.diaryPlay.exploreSection());
        out.push(newsSection('world', true));
        // 5. Everything else, one tap away
        out.push(`
            <nav class="ex-elsewhere" aria-labelledby="ex-else-h">
                <h3 id="ex-else-h">More to explore</h3>
                <div class="ex-else-links">
                    <button type="button" data-action="ex-news-open" data-kind="local"><svg class="i"><use href="#i-pin"/></svg>News near you</button>
                    <button type="button" data-action="ex-tab" data-tab="library"><svg class="i"><use href="#i-book"/></svg>Library</button>
                    <button type="button" data-action="ex-tab" data-tab="groups"><svg class="i"><use href="#i-users"/></svg>Communities</button>
                    <button type="button" data-action="go-market"><svg class="i"><use href="#i-store"/></svg>Marketplace</button>
                    <button type="button" data-action="go-spaces"><svg class="i"><use href="#i-headphones"/></svg>Spaces</button>
                    <button type="button" data-action="ex-tab" data-tab="posts"><svg class="i"><use href="#i-trend"/></svg>All trending tags</button>
                </div>
            </nav>`);
        return out.join('');
    }

    app.views.explore = () => {
        app.setTitle('Explore');
        const blocked = I.gate('See what’s trending with your friends — posts, reels, live videos, stories from the Library and communities.');
        if (blocked) return blocked;
        I.loadFeed();
        if (E.groups === null) loadGroups();
        if (window.diaryLive) window.diaryLive.ensure();

        const loading = s.feed === null;
        const tab = E.tab;
        const show = k => tab === k;
        const posts = trendingPosts();
        const tags = trendingTags();
        const reels = trendingReels();
        const books = window.diaryLibrary ? window.diaryLibrary.popular(10) : [];
        const allGroups = E.groups || [];
        const people = s.suggestions || [];
        const q = E.query;
        const tabsHTML = `
            <nav class="ex-tabs" role="tablist" aria-label="Show">
                ${TABS.map(([k, l]) => `<button type="button" class="cm-filter" role="tab" aria-selected="${tab === k}" data-action="ex-tab" data-tab="${k}"><svg class="i"><use href="#${TAB_ICONS[k]}"/></svg>${l}</button>`).join('')}
            </nav>`;

        if (tab === 'news') return `<div class="explore" data-tab="news">${tabsHTML}${newsTab()}</div>`;

        let body;
        if (tab === 'all') {
            body = forYou({ loading, posts, reels, people });
        } else {
            const sections = [];
            if (show('spaces') && window.diarySpaces) sections.push(window.diarySpaces.exploreSection());
            if (show('live')) {
                sections.push(`<section class="ex-sec">${head('i-live', 'Live now', (window.diaryLive && window.diaryLive.list().length) ? `${window.diaryLive.list().length} live right now — tap to join` : 'Nobody’s live right now — start one')}<div class="lv-grid">${liveCards()}</div></section>`);
            }
            if (show('posts') && tags.length) {
                sections.push(`<section class="ex-sec">${head('i-trend', 'Trending tags', 'What your circle is talking about')}
                    <div class="ex-tags">${tags.map(([t, v], i) => `<button type="button" class="ex-tag${i < 3 ? ' top' : ''}" data-action="ex-tag" data-tag="${esc(t)}"><span class="ex-tag-rank">${i + 1}</span>#${esc(t)}<small>${v.n} ${v.n === 1 ? 'post' : 'posts'}</small></button>`).join('')}</div></section>`);
            }
            if (show('posts')) {
                sections.push(`<section class="ex-sec">${head('i-sparkle', 'Trending posts', 'Most loved and talked about this week')}
                    ${loading ? `<div class="ex-grid">${'<span class="ex-tile skel"></span>'.repeat(6)}</div>`
                        : posts.length ? `<div class="ex-grid">${posts.map((p, i) => postTile(p, i)).join('')}</div>`
                        : '<div class="ex-empty small"><strong>No posts yet</strong><span>When friends share entries, the most loved ones show up here.</span></div>'}</section>`);
            }
            if (show('reels')) {
                sections.push(`<section class="ex-sec">${head('i-reel', 'Popular reels', 'Short videos your friends are watching', seeAll('data-action="go-reels"', 'Open Reels'))}
                    ${reels.length ? `<div class="ex-row">${reels.slice(0, 30).map(reelTile).join('')}</div>` : '<div class="ex-empty small"><strong>No reels yet</strong><span>Post one from the Feed with the Video button.</span></div>'}</section>`);
            }
            if (show('library') && window.diaryLibrary) {
                sections.push(`<section class="ex-sec">${head('i-book', 'Top in the Library', 'Stories, poems and books people love', seeAll('data-action="go-library"', 'Browse'))}
                    ${books.length ? `<div class="ex-row">${books.map(bookTile).join('')}</div>` : '<div class="ex-empty small"><strong>The Library is quiet</strong><span>Publish a story or poem to get it started.</span></div>'}</section>`);
                if (window.diaryMarket) sections.push(window.diaryMarket.exploreSection());
            }
            if (show('groups')) {
                sections.push(`<section class="ex-sec">${head('i-users', 'Communities', 'The biggest groups on Cordial')}
                    ${E.groups === null ? '<p class="muted">Loading communities…</p>' : allGroups.length ? `<div class="ex-groups">${allGroups.map(groupCard).join('')}</div>` : '<div class="ex-empty small"><strong>No communities yet</strong><span>Start one from the Groups tab.</span></div>'}</section>`);
            }
            if (show('people')) {
                sections.push(`<section class="ex-sec">${head('i-user-plus', 'People you may know', 'Friends of your friends')}
                    ${people.length ? `<div class="ex-people">${people.map(personRow).join('')}</div>` : '<div class="ex-empty small"><strong>No suggestions right now</strong><span>Add friends by username from Chats.</span></div>'}</section>`);
            }
            body = sections.join('');
        }

        return `
            <div class="explore${E.searching ? ' searching' : ''}" data-tab="${tab}">
                <section class="ex-top" aria-label="Search Explore">
                    <div class="ex-search-row">
                        <label class="search ex-search">
                            <svg class="i"><use href="#i-search"/></svg>
                            <input type="search" id="ex-search" placeholder="Search people, notes, posts and #tags" aria-label="Search Explore" value="${esc(E.raw ?? q)}" enterkeyhint="search" autocomplete="off">
                            <button type="button" class="ex-clear" data-action="ex-clear" aria-label="Clear search"${q ? '' : ' hidden'}><svg class="i"><use href="#i-close"/></svg></button>
                        </label>
                        <button type="button" class="link-btn ex-cancel" data-action="ex-cancel">Cancel</button>
                    </div>
                </section>
                ${tabsHTML}
                <div id="ex-body" aria-live="polite">${E.searching ? (q ? searchResults(q) : searchIdle()) : q ? searchResults(q) : body}</div>
            </div>`;
    };

    // Search re-draws only the results, so typing keeps its focus
    let typing = null;
    function paintSearch() {
        const body = document.getElementById('ex-body');
        if (!body) return;
        body.innerHTML = E.query ? searchResults(E.query) : searchIdle();
        const clear = document.querySelector('.ex-clear');
        if (clear) clear.hidden = !E.query;
        I.hydrateStorage(body);
    }
    function enterSearch() {
        if (E.searching) return;
        E.searching = true;
        document.querySelector('.explore')?.classList.add('searching');
        paintSearch();
    }
    function leaveSearch() {
        E.searching = false;
        E.query = '';
        E.raw = '';
        clearTimeout(typing);
        app.render();
    }
    content.addEventListener('focusin', e => { if (e.target.id === 'ex-search') enterSearch(); });
    content.addEventListener('input', e => {
        if (e.target.id !== 'ex-search') return;
        E.raw = e.target.value;
        E.query = e.target.value.trim().toLowerCase();
        enterSearch();
        clearTimeout(typing);
        typing = setTimeout(paintSearch, 140);
    });
    content.addEventListener('keydown', e => {
        if (e.target.id !== 'ex-search') return;
        if (e.key === 'Enter') { remember(E.raw); e.target.blur(); }
        else if (e.key === 'Escape') leaveSearch();
    });
    // Opening something you searched for remembers the search
    content.addEventListener('click', e => {
        if (!E.searching || !E.query) return;
        if (e.target.closest('#ex-body [data-action], #ex-body [data-game], #ex-body [data-profile]')) remember(E.raw);
    }, true);

    content.addEventListener('submit', e => {
        const form = e.target.closest('form[data-form="ex-place"]');
        if (!form) return;
        e.preventDefault();
        N.place = { country: $id('ex-country').value, city: $id('ex-city').value.trim().slice(0, 60) };
        try { localStorage.setItem('diaryNewsPlace', JSON.stringify(N.place)); } catch (err) {}
        app.render();
    });
    const $id = id => document.getElementById(id);

    Object.assign(app.actions, {
        'ex-news-kind': el => { N.kind = el.dataset.kind; app.render(); },
        'ex-live-retry': () => { if (window.diaryLive && window.diaryLive.refresh) window.diaryLive.refresh(); if (window.diarySpaces && window.diarySpaces.refresh) window.diarySpaces.refresh(); app.render(); },
        'ex-cat': el => { E.cat = el.dataset.k; try { sessionStorage.setItem('cordialExCat', E.cat); } catch (e) { /* private mode */ } app.render(); },
        'ex-join': (el, e) => {
            if (!app.actions['cm-join']) return;
            el.disabled = true;
            el.innerHTML = 'Joined ✓';
            app.actions['cm-join'](el, e || { stopPropagation() {} });
            setTimeout(() => { E.groups = null; loadGroups(); }, 1200);
        },
        'ex-interest': el => {
            const set = new Set(E.pickInterests || []);
            if (set.has(el.dataset.k)) set.delete(el.dataset.k); else set.add(el.dataset.k);
            E.pickInterests = [...set];
            el.classList.toggle('on', set.has(el.dataset.k));
            el.setAttribute('aria-pressed', String(set.has(el.dataset.k)));
            const save = document.querySelector('[data-action="ex-interests-save"]');
            if (save) save.disabled = !set.size;
        },
        'ex-interests-save': () => { saveInterests(E.pickInterests || []); app.showToast('Explore is tuned to your interests ✨'); app.render(); },
        'ex-interests-skip': () => { E.skipInterests = true; app.render(); },
        'ex-news-open': el => { E.tab = 'news'; N.kind = el.dataset.kind; app.render(); document.querySelector('.main-col').scrollTo({ top: 0 }); },
        'ex-news-retry': () => {
            [...N.results.keys()].forEach(k => { const v = N.results.get(k); if (v.error || !v.items) N.results.delete(k); });
            app.render();
        },
        'ex-news-listen': () => {
            const entry = N.results.get(JSON.stringify(newsRequest(N.kind)));
            if (!entry || !entry.items || !window.Speak) return;
            const lines = entry.items.slice(0, 10).map(i => `${i.title}. From ${i.source}.`).join(' ');
            window.Speak.read(`Here are the latest headlines. ${lines}`, { title: `${(NEWS_KINDS.find(k => k[0] === N.kind) || ['', 'News'])[1]} headlines` });
        },
        'ex-clear': () => {
            E.query = '';
            E.raw = '';
            const input = document.getElementById('ex-search');
            if (input) { input.value = ''; input.focus(); }
            paintSearch();
        },
        'ex-cancel': () => leaveSearch(),
        'ex-recent': el => {
            const input = document.getElementById('ex-search');
            E.raw = el.dataset.q;
            E.query = el.dataset.q.trim().toLowerCase();
            if (input) input.value = el.dataset.q;
            remember(el.dataset.q);
            paintSearch();
        },
        'ex-recent-forget': el => { forget(el.dataset.q); paintSearch(); },
        'ex-recent-clear': () => { forget(); paintSearch(); },
        'ex-tab': el => {
            E.searching = false;
            E.tab = el.dataset.tab;
            E.query = '';
            E.raw = '';
            app.render();
        },
        'ex-post': el => {
            if (!I.openEntry(el.dataset.id)) app.showToast('That post isn’t available any more');
        },
        'ex-tag': el => {
            if (E.searching && E.raw) remember(E.raw);
            E.searching = false;
            E.query = '';
            E.raw = '';
            s.feedAuthor = null;
            s.feedFilter = `tag:${el.dataset.tag}`;
            app.setView('feed');
        }
    });

    window.diaryExplore = { showTab: tab => { E.tab = tab; E.query = ''; E.raw = ''; app.setView('explore'); } };

    const previousAfter = app.hooks.afterRender;
    app.hooks.afterRender = view => {
        if (previousAfter) previousAfter(view);
        if (view === 'explore') I.hydrateStorage(content);
    };
});
