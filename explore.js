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
        const name = p.author === s.profile.id ? 'You' : ((p.author_profile && p.author_profile.display_name) || 'A friend');
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
    function searchResults(q) {
        const has = t => (t || '').toLowerCase().includes(q);
        const posts = (s.feed || []).filter(p => has(p.title) || has(p.body) || has(p.author_profile && p.author_profile.display_name) || I.hashtags(p).some(t => t.includes(q.replace(/^#/, '')))).slice(0, 12);
        const tags = trendingTags().filter(([t]) => t.includes(q.replace(/^#/, ''))).slice(0, 8);
        const everyone = I.peopleResults ? I.peopleResults(q) : '';
        const people = everyone ? [] : [...s.friends, ...s.suggestions].filter(p => has(p.display_name) || has(p.username)).slice(0, 8);
        const groups = (E.groups || []).filter(g => has(g.name) || has(g.description)).slice(0, 6);
        const books = window.diaryLibrary ? window.diaryLibrary.popular(100).filter(x => has(x.title) || has(x.genre) || has(x.description)).slice(0, 8) : [];
        const total = posts.length + tags.length + people.length + groups.length + books.length;
        if (!total && !everyone) return `<div class="ex-empty"><svg class="i"><use href="#i-search"/></svg><strong>Nothing found for “${esc(q)}”</strong><span>Try a name, a #tag or a word from a post.</span></div>`;
        return `
            ${tags.length ? `<section class="ex-sec">${head('i-tag', 'Tags')}<div class="ex-tags">${tags.map(([t, v]) => `<button type="button" class="ex-tag" data-action="ex-tag" data-tag="${esc(t)}">#${esc(t)}<small>${v.n}</small></button>`).join('')}</div></section>` : ''}
            ${everyone ? `<section class="ex-sec">${everyone}</section>` : ''}
            ${people.length ? `<section class="ex-sec">${head('i-users', 'People')}<div class="ex-people">${people.map(p => s.friends.includes(p)
                ? `<div class="ex-person">${avatar(p, 'md')}<span class="ex-person-text"><strong>${esc(p.display_name)}</strong><small>@${esc(p.username)} · friend</small></span><button type="button" class="chip" data-action="message-friend" data-id="${esc(p.id)}">Message</button></div>`
                : personRow(p)).join('')}</div></section>` : ''}
            ${posts.length ? `<section class="ex-sec">${head('i-feed', 'Posts')}<div class="ex-grid">${posts.map((p, i) => postTile(p, 99 + i)).join('')}</div></section>` : ''}
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

    function forYou({ loading, posts, reels, people }) {
        const out = [];
        // 1. The single most-loved post, given room to breathe
        if (loading) out.push('<section class="ex-sec"><span class="ex-feature skel"></span></section>');
        else if (posts.length) out.push(`<section class="ex-sec" aria-labelledby="ex-top-h">${fyHead('Most loved today', '', 'ex-top-h')}${featureCard(posts[0])}</section>`);
        else out.push('<section class="ex-sec"><div class="ex-empty small"><strong>No posts yet</strong><span>When friends share entries, the most loved ones show up here.</span></div></section>');
        // 2. Trending, as a rail instead of a wall of tiles
        if (posts.length > 1) {
            out.push(`<section class="ex-sec" aria-labelledby="ex-trend-h">${fyHead('Trending', posts.length > 10 ? seeAll('data-action="ex-tab" data-tab="posts"') : '', 'ex-trend-h')}
                <div class="ex-row ex-rail">${posts.slice(1, 10).map((p, i) => postTile(p, i + 1)).join('')}</div></section>`);
        }
        // 3. Happening now: live videos and audio rooms only when something is on; one quiet row to start your own
        const lives = window.diaryLive ? window.diaryLive.list() : [];
        const rooms = window.diarySpaces && window.diarySpaces.liveCount ? window.diarySpaces.liveCount() : 0;
        if (lives.length) out.push(`<section class="ex-sec">${fyHead('Live now', seeAll('data-action="ex-tab" data-tab="live"'))}<div class="lv-grid">${liveCards()}</div></section>`);
        if (rooms && window.diarySpaces) out.push(window.diarySpaces.exploreSection());
        out.push(`
            <div class="ex-start" role="group" aria-label="Start something">
                <span class="ex-start-text"><strong>${lives.length || rooms ? 'Start your own' : 'Nothing live right now'}</strong><small>Go live on video, or open an audio room</small></span>
                <span class="ex-start-btns">
                    <button type="button" class="chip" data-action="live-start"><svg class="i"><use href="#i-live"/></svg>Go live</button>
                    <button type="button" class="chip" data-action="space-new"><svg class="i"><use href="#i-headphones"/></svg>Host a room</button>
                </span>
            </div>`);
        // 4. Reels, games, people, news
        if (reels.length) out.push(`<section class="ex-sec">${fyHead('Popular reels', seeAll('data-action="go-reels"', 'Open Reels'))}<div class="ex-row">${reels.slice(0, 10).map(reelTile).join('')}</div></section>`);
        if (window.diaryPlay) out.push(window.diaryPlay.exploreSection());
        if (people.length) out.push(`<section class="ex-sec">${fyHead('People you may know', seeAll('data-action="ex-tab" data-tab="people"'))}<div class="ex-row ex-people-rail">${people.slice(0, 12).map(personCard).join('')}</div></section>`);
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
            <div class="explore" data-tab="${tab}">
                <section class="ex-top" aria-label="Search Explore">
                    <label class="search ex-search">
                        <svg class="i"><use href="#i-search"/></svg>
                        <input type="search" id="ex-search" placeholder="Search people, posts, #tags, books and groups" aria-label="Search Explore" value="${esc(E.raw ?? q)}" enterkeyhint="search" autocomplete="off">
                    </label>
                    ${tags.length && tab === 'all' ? `<div class="ex-topics" aria-label="Trending topics">${tags.slice(0, 8).map(([t]) => `<button type="button" class="ex-topic" data-action="ex-tag" data-tag="${esc(t)}">#${esc(t)}</button>`).join('')}</div>` : ''}
                </section>
                ${tabsHTML}
                <div id="ex-body">${q ? searchResults(q) : body}</div>
            </div>`;
    };

    // Search re-draws only the results, so typing keeps its focus
    content.addEventListener('input', e => {
        if (e.target.id !== 'ex-search') return;
        E.raw = e.target.value;
        E.query = e.target.value.trim().toLowerCase();
        const body = document.getElementById('ex-body');
        if (!body) return;
        if (E.query) body.innerHTML = searchResults(E.query);
        else app.render();
        I.hydrateStorage(body);
    });

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
        'ex-tab': el => {
            E.tab = el.dataset.tab;
            E.query = '';
            E.raw = '';
            app.render();
        },
        'ex-post': el => {
            if (!I.openEntry(el.dataset.id)) app.showToast('That post isn’t available any more');
        },
        'ex-tag': el => {
            s.feedAuthor = null;
            s.feedFilter = `tag:${el.dataset.tag}`;
            app.setView('feed');
        }
    });

    const previousAfter = app.hooks.afterRender;
    app.hooks.afterRender = view => {
        if (previousAfter) previousAfter(view);
        if (view === 'explore') I.hydrateStorage(content);
    };
});
