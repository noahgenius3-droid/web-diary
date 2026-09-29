/* ============================================================
   Cordial — live location sharing
   window.LiveLocation = {
     supported, share(target), stop(id), cardHTML(att, opts), hydrate(root),
     open(id), active(), onchange
   }
   Rows live in public.diary_live_locations (RLS: owner / peer / community
   members can read, owner updates). One realtime channel carries every
   UPDATE; cards find themselves by [data-live-loc="<id>"].
   ============================================================ */
(function () {
    'use strict';
    if (window.LiveLocation) return;

    const TABLE = 'diary_live_locations';
    const COLS = 'id, owner, peer, community_id, lat, lng, accuracy, heading, speed, started_at, updated_at, expires_at, stopped_at';
    const TILE = 256;
    const ZOOM = 15;                    // card preview zoom (street level)
    const MIN_GAP = 8000;               // ms between position writes
    const JUMP = 25;                    // metres: send immediately when moved further
    const FIX_TIMEOUT = 15000;          // first fix
    const TICK = 10000;                 // "updated … ago" refresh
    const POLL_EVERY = 30000;           // fallback refetch when realtime is down
    const DURATIONS = [
        { label: '15 minutes', ms: 15 * 60e3 },
        { label: '1 hour', ms: 60 * 60e3 },
        { label: '8 hours', ms: 8 * 60 * 60e3 }
    ];
    const LEAFLET_JS = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js';
    const LEAFLET_CSS = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css';
    const OSM = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
    const OSM_ATTR = '© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>';

    const supported = !!(navigator.geolocation && navigator.geolocation.getCurrentPosition);
    const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) ||
        (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

    const ICONS = {
        pin: '<path d="M12 21s-6.5-5.6-6.5-11a6.5 6.5 0 0 1 13 0c0 5.4-6.5 11-6.5 11z"/><circle cx="12" cy="10" r="2.4"/>',
        close: '<path d="M6 6l12 12M18 6L6 18"/>',
        nav: '<path d="M3 11l18-8-8 18-2-8-8-2z"/>',
        stop: '<rect x="6.5" y="6.5" width="11" height="11" rx="2"/>',
        target: '<circle cx="12" cy="12" r="7"/><circle cx="12" cy="12" r="2.5"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/>',
        check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>'
    };
    const svg = (name, cls) => '<svg class="' + (cls || 'll-i') + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
        'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + ICONS[name] + '</svg>';

    // ---------- environment ----------
    const I = () => (window.diarySocial && window.diarySocial.internals) || {};
    const app = () => window.diaryApp || {};
    const client = () => I().client;
    const me = () => (I().state && I().state.profile) || null;
    const esc = s => (I().esc ? I().esc(s) : String(s == null ? '' : s).replace(/[&<>"']/g, c =>
        ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])));
    const toast = msg => { try { app().showToast ? app().showToast(msg) : console.info(msg); } catch (e) { /* ignore */ } };

    // ---------- state ----------
    const rows = new Map();             // id -> latest row we know about
    const missing = new Set();          // ids the server wouldn't return
    const inflight = new Set();         // ids being fetched
    const mine = new Map();             // id -> { id, peer, community_id, expires_at, timer }
    let watchId = null;
    let lastSent = null;                // { lat, lng, t }
    let pendingPos = null;
    let sendTimer = null;
    let channel = null;
    let channelOk = false;
    let ticker = null;
    let lastPoll = 0;
    let myFix = null;                   // { lat, lng, accuracy, t } — the viewer's own position
    let fixLookupAt = 0;
    let deniedToastShown = false;
    let resumed = false;
    let picker = null;
    let full = null;                    // open full-map state

    // ---------- geometry ----------
    function project(lat, lng, z) {
        const n = TILE * Math.pow(2, z);
        const s = Math.sin(Math.max(-85.0511, Math.min(85.0511, lat)) * Math.PI / 180);
        return {
            x: (lng + 180) / 360 * n,
            y: (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * n
        };
    }
    function metres(a, b) {
        const R = 6371e3, rad = Math.PI / 180;
        const dLat = (b.lat - a.lat) * rad, dLng = (b.lng - a.lng) * rad;
        const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
        return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
    }
    function distText(m) {
        if (m < 50) return 'right next to you';
        if (m < 1000) return Math.round(m / 10) * 10 + ' m away';
        const km = m / 1000;
        return (km < 10 ? km.toFixed(1) : Math.round(km).toLocaleString()) + ' km away';
    }
    const valid = (lat, lng) => Number.isFinite(+lat) && Number.isFinite(+lng) && lat !== null && lng !== null;

    // 3×2 OSM tiles around the point; returns markup + where the point falls inside the grid.
    function tileGrid(lat, lng) {
        const p = project(lat, lng, ZOOM);
        const tx = Math.floor(p.x / TILE), ty = Math.floor(p.y / TILE);
        const fy = p.y / TILE - ty;
        const row0 = fy < 0.5 ? ty - 1 : ty;
        const col0 = tx - 1;
        const max = Math.pow(2, ZOOM);
        let html = '';
        for (let r = 0; r < 2; r++) {
            for (let c = 0; c < 3; c++) {
                const x = ((col0 + c) % max + max) % max, y = row0 + r;
                if (y < 0 || y >= max) continue;
                html += '<img class="ll-tile" alt="" draggable="false" decoding="async" loading="lazy" style="left:' + (c * TILE) + 'px;top:' + (r * TILE) +
                    'px" src="' + OSM.replace('{z}', ZOOM).replace('{x}', x).replace('{y}', y) + '">';
            }
        }
        return { html, key: col0 + ':' + row0, mx: p.x - col0 * TILE, my: p.y - row0 * TILE };
    }

    // ---------- formatting ----------
    function clock(iso) {
        const d = new Date(iso);
        const t = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
        const today = new Date();
        if (d.toDateString() === today.toDateString()) return t;
        const tomorrow = new Date(today.getTime() + 864e5);
        if (d.toDateString() === tomorrow.toDateString()) return 'tomorrow ' + t;
        return d.toLocaleDateString([], { weekday: 'short' }) + ' ' + t;
    }
    function ago(iso) {
        if (!iso) return '';
        const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
        if (s < 10) return 'just now';
        if (s < 60) return Math.floor(s / 10) * 10 + 's ago';
        if (s < 3600) return Math.floor(s / 60) + ' min ago';
        if (s < 86400) return Math.floor(s / 3600) + ' h ago';
        return I().timeAgo ? I().timeAgo(iso) : new Date(iso).toLocaleDateString();
    }
    const isEnded = r => !!r && (!!r.stopped_at || new Date(r.expires_at).getTime() <= Date.now());
    const endedAt = r => r.stopped_at && new Date(r.stopped_at) < new Date(r.expires_at) ? r.stopped_at : r.expires_at;

    function personFor(row, fallback) {
        if (fallback) return fallback;
        const p = me();
        if (row && p && row.owner === p.id) return p;
        const friends = (I().state && I().state.friends) || [];
        return (row && friends.find(f => f.id === row.owner)) || null;
    }
    function pinHTML(person) {
        const face = person && I().avatar ? I().avatar(person, 'sm') : '<span class="ll-pin-dot">' + svg('pin') + '</span>';
        return '<span class="ll-pin" aria-hidden="true"><span class="ll-ring"></span><span class="ll-ring ll-ring-2"></span>' +
            '<span class="ll-pin-head">' + face + '</span><span class="ll-pin-tip"></span></span>';
    }

    // A merged view of what the card should show: server row if we have it, else the message attachment.
    function viewOf(id, att) {
        const r = rows.get(id);
        if (r) return r;
        return {
            id, lat: att && att.lat, lng: att && att.lng, expires_at: att && att.expires_at,
            updated_at: att && (att.updated_at || att.started_at) || null, stopped_at: null, owner: att && att.owner
        };
    }

    // ---------- card ----------
    function cardHTML(att, opts) {
        opts = opts || {};
        if (!att || !att.id) return '';
        const id = String(att.id);
        const v = viewOf(id, att);
        const isMine = !!opts.mine || (!!me() && v.owner === me().id);
        const person = personFor(v, opts.person || (isMine ? me() : null));
        const ended = isEnded(v) || missing.has(id);
        const hasPos = valid(v.lat, v.lng);
        const g = hasPos ? tileGrid(+v.lat, +v.lng) : null;
        const who = person ? (person.display_name || person.username || '') : '';
        return '<div class="ll-card' + (ended ? ' ll-ended' : '') + (isMine ? ' ll-mine' : '') + '" data-live-loc="' + esc(id) + '"' +
            (isMine ? ' data-ll-mine="1"' : '') + (person && person.id ? ' data-ll-person="' + esc(person.id) + '"' : '') + '>' +
            '<div class="ll-map">' +
            '<div class="ll-tiles"' + (g ? ' data-ll-key="' + g.key + '" style="left:calc(50% - ' + g.mx.toFixed(1) + 'px);top:calc(50% - ' + g.my.toFixed(1) + 'px)"' : '') + '>' +
            (g ? g.html : '') + '</div>' +
            pinHTML(person) +
            '<button type="button" class="ll-map-hit" data-ll-view aria-label="View ' + esc(who ? who + '’s ' : '') + 'live location on a map"></button>' +
            '<a class="ll-attrib" href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">© OpenStreetMap</a>' +
            '</div>' +
            '<div class="ll-body">' +
            '<div class="ll-head">' + '<span class="ll-live-dot" aria-hidden="true"></span>' +
            '<span class="ll-title">' + (ended ? 'Location sharing ended' : 'Live location') + '</span>' +
            '<span class="ll-until">' + esc(untilText(v, ended)) + '</span></div>' +
            '<div class="ll-meta"><span class="ll-updated">' + esc(updatedText(v, ended)) + '</span>' +
            '<span class="ll-dist">' + esc(isMine ? '' : distFor(v)) + '</span></div>' +
            '<div class="ll-actions">' +
            '<button type="button" class="ll-btn" data-ll-view>' + svg('pin') + '<span>View</span></button>' +
            (isMine ? '<button type="button" class="ll-btn ll-btn-stop" data-ll-stop' + (ended ? ' hidden' : '') + '>' + svg('stop') + '<span>Stop sharing</span></button>' : '') +
            '</div></div></div>';
    }
    function untilText(v, ended) {
        if (ended) return '';
        return v.expires_at ? 'until ' + clock(v.expires_at) : '';
    }
    function updatedText(v, ended) {
        if (ended) return v.expires_at || v.stopped_at ? 'Ended ' + clock(endedAt(v)) : 'Ended';
        const u = v.updated_at || v.started_at;
        return u ? 'updated ' + ago(u) : 'waiting for the first update…';
    }
    function distFor(v) {
        if (!myFix || !valid(v.lat, v.lng)) return '';
        return distText(metres(myFix, { lat: +v.lat, lng: +v.lng }));
    }

    function refreshCard(el) {
        const id = el.getAttribute('data-live-loc');
        const v = rows.get(id);
        const ended = missing.has(id) || (v ? isEnded(v) : el.classList.contains('ll-ended'));
        el.classList.toggle('ll-ended', ended);
        if (!v) return;
        const isMine = el.hasAttribute('data-ll-mine') || (!!me() && v.owner === me().id);
        // Late-resolved avatar (card rendered before we knew whose row it was)
        if (!el.hasAttribute('data-ll-person')) {
            const p = personFor(v, isMine ? me() : null);
            if (p) {
                el.setAttribute('data-ll-person', p.id || '');
                const pin = el.querySelector('.ll-pin');
                if (pin) pin.outerHTML = pinHTML(p);
            }
        }
        if (valid(v.lat, v.lng)) {
            const tiles = el.querySelector('.ll-tiles');
            const g = tileGrid(+v.lat, +v.lng);
            if (tiles) {
                if (tiles.getAttribute('data-ll-key') !== g.key) {
                    tiles.classList.add('ll-jump');
                    tiles.innerHTML = g.html;
                    tiles.setAttribute('data-ll-key', g.key);
                    tiles.getBoundingClientRect();
                } else tiles.classList.remove('ll-jump');
                tiles.style.left = 'calc(50% - ' + g.mx.toFixed(1) + 'px)';
                tiles.style.top = 'calc(50% - ' + g.my.toFixed(1) + 'px)';
                if (tiles.classList.contains('ll-jump')) requestAnimationFrame(() => tiles.classList.remove('ll-jump'));
            }
        }
        setText(el, '.ll-title', ended ? 'Location sharing ended' : 'Live location');
        setText(el, '.ll-until', untilText(v, ended));
        setText(el, '.ll-updated', updatedText(v, ended));
        setText(el, '.ll-dist', isMine ? '' : distFor(v));
        const stopBtn = el.querySelector('[data-ll-stop]');
        if (stopBtn) stopBtn.hidden = ended;
    }
    function setText(el, sel, text) {
        const n = el.querySelector(sel);
        if (n && n.textContent !== text) n.textContent = text;
    }
    function refreshId(id) {
        document.querySelectorAll('[data-live-loc="' + cssEsc(id) + '"]').forEach(refreshCard);
        if (full && full.id === id) refreshFull();
    }
    function refreshAll() {
        document.querySelectorAll('.ll-card[data-live-loc]').forEach(refreshCard);
        if (full) refreshFull();
    }
    const cssEsc = s => (window.CSS && CSS.escape ? CSS.escape(s) : String(s).replace(/["\\]/g, '\\$&'));

    // ---------- hydrate / realtime ----------
    function hydrate(root) {
        root = root || document;
        const cards = root.querySelectorAll ? root.querySelectorAll('[data-live-loc]') : [];
        const need = [];
        cards.forEach(el => {
            const id = el.getAttribute('data-live-loc');
            if (!id) return;
            if (!rows.has(id) && !missing.has(id) && !inflight.has(id) && need.indexOf(id) < 0) need.push(id);
            refreshCard(el);
        });
        if (!cards.length) return;
        ensureChannel();
        ensureTicker();
        lookupMyFix();
        if (need.length) fetchRows(need);
    }

    async function fetchRows(ids) {
        const c = client();
        if (!c || !ids.length) return;
        ids.forEach(id => inflight.add(id));
        try {
            const { data, error } = await c.from(TABLE).select(COLS).in('id', ids);
            if (error) throw error;
            const got = new Set();
            (data || []).forEach(r => { got.add(String(r.id)); applyRow(r, true); });
            // Only mark as missing once the fetch really succeeded without the row.
            ids.forEach(id => { if (!got.has(id)) { missing.add(id); refreshId(id); } });
        } catch (e) {
            console.warn('[live-location] fetch failed', e);
        } finally {
            ids.forEach(id => inflight.delete(id));
        }
    }

    function applyRow(r, force) {
        if (!r || !r.id) return;
        const id = String(r.id);
        const prev = rows.get(id);
        // Ignore out-of-order echoes
        if (!force && prev && prev.updated_at && r.updated_at && new Date(r.updated_at) < new Date(prev.updated_at) && !r.stopped_at) return;
        rows.set(id, Object.assign({}, prev || {}, r, { id }));
        missing.delete(id);
        scheduleExpiry(rows.get(id));
        // Someone stopped one of my shares from another tab/device
        if (mine.has(id) && isEnded(rows.get(id))) dropMine(id);
        refreshId(id);
    }

    // Flip cards to "Ended" right at expiry, not on the next tick.
    const expiryTimers = new Map();
    function scheduleExpiry(r) {
        const id = String(r.id);
        const old = expiryTimers.get(id);
        if (old && old.at === r.expires_at && !r.stopped_at) return;
        if (old) clearTimeout(old.t);
        expiryTimers.delete(id);
        if (isEnded(r) || !r.expires_at) return;
        const ms = new Date(r.expires_at).getTime() - Date.now();
        expiryTimers.set(id, {
            at: r.expires_at,
            t: setTimeout(() => { expiryTimers.delete(id); pruneMine(); refreshId(id); }, Math.min(ms + 100, 2147483000))
        });
    }

    function ensureChannel() {
        const c = client();
        if (channel || !c || !c.channel) return;
        try {
            channel = c.channel('ll-live-locations')
                .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: TABLE }, payload => {
                    const r = payload && payload.new;
                    if (!r || !r.id) return;
                    const id = String(r.id);
                    // One channel for every card: only keep rows someone on this page cares about.
                    if (rows.has(id) || mine.has(id) || inflight.has(id) || document.querySelector('[data-live-loc="' + cssEsc(id) + '"]')) applyRow(r);
                })
                .subscribe(status => { channelOk = status === 'SUBSCRIBED'; });
        } catch (e) {
            console.warn('[live-location] realtime unavailable', e);
            channel = null;
        }
    }

    function ensureTicker() {
        if (ticker) return;
        ticker = setInterval(tick, TICK);
    }
    function tick() {
        pruneMine();
        const cards = document.querySelectorAll('.ll-card[data-live-loc]');
        if (!cards.length && !full) { clearInterval(ticker); ticker = null; return; }
        lookupMyFix();
        refreshAll();
        // Realtime down? refetch the live ones now and then.
        if (!channelOk && Date.now() - lastPoll > POLL_EVERY) {
            lastPoll = Date.now();
            const live = [];
            cards.forEach(el => {
                const id = el.getAttribute('data-live-loc');
                const r = rows.get(id);
                if (r && !isEnded(r) && live.indexOf(id) < 0) live.push(id);
            });
            if (live.length) fetchRows(live);
        }
    }

    // The viewer's own position, for "1.2 km away" — never prompts; only reads when already allowed.
    async function lookupMyFix() {
        if (!supported) return;
        if (watchId !== null && myFix && Date.now() - myFix.t < 60e3) return;
        if (Date.now() - fixLookupAt < 60e3) return;
        fixLookupAt = Date.now();
        try {
            if (!navigator.permissions || !navigator.permissions.query) return;
            const st = await navigator.permissions.query({ name: 'geolocation' });
            if (st.state !== 'granted') return;
            navigator.geolocation.getCurrentPosition(p => {
                setMyFix(p);
                refreshAll();
            }, () => { }, { maximumAge: 60e3, timeout: 20e3, enableHighAccuracy: false });
        } catch (e) { /* ignore */ }
    }
    function setMyFix(p) {
        myFix = { lat: p.coords.latitude, lng: p.coords.longitude, accuracy: p.coords.accuracy, t: Date.now() };
    }

    // ---------- sharing ----------
    function permissionState() {
        try {
            if (!navigator.permissions || !navigator.permissions.query) return Promise.resolve('unknown');
            return navigator.permissions.query({ name: 'geolocation' }).then(s => s.state, () => 'unknown');
        } catch (e) { return Promise.resolve('unknown'); }
    }

    // First fix: 15 s once permission is settled (longer while the browser prompt is showing).
    function getFix(isCancelled) {
        return permissionState().then(state => new Promise((resolve, reject) => {
            let done = false;
            const limit = state === 'prompt' ? 60e3 : FIX_TIMEOUT + 1000;
            const guard = setTimeout(() => finish(null, { code: 3 }), limit);
            function finish(pos, err) {
                if (done) return;
                done = true;
                clearTimeout(guard);
                if (pos) resolve(pos); else reject(err);
            }
            navigator.geolocation.getCurrentPosition(p => finish(p), e => finish(null, e || { code: 2 }),
                { enableHighAccuracy: true, timeout: FIX_TIMEOUT, maximumAge: 30e3 });
            // allow the picker's Cancel to abandon the wait
            const poll = setInterval(() => { if (done) clearInterval(poll); else if (isCancelled && isCancelled()) { clearInterval(poll); finish(null, { code: 'cancel' }); } }, 200);
        }));
    }

    function share(target) {
        target = target || {};
        const peer = target.peer || null;
        const communityId = target.communityId || target.community_id || null;
        if (!supported) { toast('Location sharing isn’t available in this browser'); return Promise.resolve(null); }
        if (!me() || !client()) { toast('Sign in to share your location'); return Promise.resolve(null); }
        if (!!peer === !!communityId) { console.warn('[live-location] share() needs { peer } or { communityId }'); return Promise.resolve(null); }
        return runPicker(async (duration, isCancelled, setBusy) => {
            setBusy('Finding you…');
            let pos;
            try {
                pos = await getFix(isCancelled);
            } catch (e) {
                if (e && e.code === 'cancel') return null;
                if (e && e.code === 1) toast('Allow location access to share where you are');
                else if (e && e.code === 3) toast('Couldn’t find your location in time. Check location settings and try again');
                else toast('Couldn’t get your location. Try again');
                return null;
            }
            if (isCancelled()) return null;
            setBusy('Sharing…');
            setMyFix(pos);
            const c = pos.coords;
            const expires = new Date(Date.now() + duration).toISOString();
            const insert = {
                lat: c.latitude, lng: c.longitude,
                accuracy: num(c.accuracy), heading: num(c.heading), speed: num(c.speed),
                expires_at: expires
            };
            if (peer) insert.peer = peer; else insert.community_id = communityId;
            let row;
            try {
                const { data, error } = await client().from(TABLE).insert(insert).select(COLS).single();
                if (error) throw error;
                row = data;
            } catch (e) {
                console.warn('[live-location] insert failed', e);
                toast('Couldn’t start sharing your location. Try again');
                return null;
            }
            if (isCancelled()) {
                // Picker dismissed while inserting: don't leave a live row behind.
                client().from(TABLE).update({ stopped_at: new Date().toISOString() }).eq('id', row.id).then(() => { }, () => { });
                return null;
            }
            row = Object.assign({ owner: me().id, updated_at: new Date().toISOString() }, insert, row);
            applyRow(row, true);
            lastSent = { lat: c.latitude, lng: c.longitude, t: Date.now() };
            addMine(row);
            return { kind: 'location', id: String(row.id), lat: row.lat, lng: row.lng, expires_at: row.expires_at };
        });
    }
    const num = v => (typeof v === 'number' && Number.isFinite(v) ? v : null);

    function addMine(row) {
        const id = String(row.id);
        if (isEnded(row)) return;
        const prev = mine.get(id);
        if (prev) clearTimeout(prev.timer);
        const ms = new Date(row.expires_at).getTime() - Date.now();
        const entry = {
            id, peer: row.peer || null, community_id: row.community_id || null, expires_at: row.expires_at,
            timer: setTimeout(() => { dropMine(id); refreshId(id); }, Math.min(ms + 250, 2147483000))
        };
        mine.set(id, entry);
        startWatch();
        ensureTicker();
        notify();
    }
    function dropMine(id) {
        const e = mine.get(id);
        if (!e) return;
        clearTimeout(e.timer);
        mine.delete(id);
        if (!mine.size) stopWatch();
        notify();
    }
    function pruneMine() {
        mine.forEach((e, id) => { if (new Date(e.expires_at).getTime() <= Date.now()) { dropMine(id); refreshId(id); } });
    }
    function notify() {
        const api = window.LiveLocation;
        if (api && typeof api.onchange === 'function') {
            try { api.onchange(active()); } catch (e) { console.warn(e); }
        }
    }
    function active() {
        pruneMineQuiet();
        return Array.from(mine.values()).map(e => ({ id: e.id, peer: e.peer, community_id: e.community_id, expires_at: e.expires_at }));
    }
    function pruneMineQuiet() {
        mine.forEach((e, id) => { if (new Date(e.expires_at).getTime() <= Date.now()) { clearTimeout(e.timer); mine.delete(id); } });
        if (!mine.size) stopWatch();
    }

    function startWatch() {
        if (watchId !== null || !supported || !mine.size) return;
        watchId = navigator.geolocation.watchPosition(onPosition, onWatchError,
            { enableHighAccuracy: true, maximumAge: 5000, timeout: 30e3 });
    }
    function stopWatch() {
        if (watchId !== null) { try { navigator.geolocation.clearWatch(watchId); } catch (e) { /* ignore */ } }
        watchId = null;
        clearTimeout(sendTimer);
        sendTimer = null;
        pendingPos = null;
    }
    function onWatchError(e) {
        if (e && e.code === 1 && !deniedToastShown) {
            deniedToastShown = true;
            toast('Allow location access to keep sharing where you are');
        }
    }
    // Throttle: at most one write every 8 s, but straight away after moving more than 25 m.
    function onPosition(p) {
        setMyFix(p);
        pruneMine();
        if (!mine.size) return;
        pendingPos = p;
        const now = Date.now();
        const moved = lastSent ? metres(lastSent, { lat: p.coords.latitude, lng: p.coords.longitude }) : Infinity;
        const since = lastSent ? now - lastSent.t : Infinity;
        if (moved > JUMP || since >= MIN_GAP) { flush(); return; }
        if (!sendTimer) sendTimer = setTimeout(flush, MIN_GAP - since);
    }
    function flush() {
        clearTimeout(sendTimer);
        sendTimer = null;
        const p = pendingPos;
        pendingPos = null;
        if (!p) return;
        pruneMine();
        const ids = Array.from(mine.keys());
        if (!ids.length || !client()) return;
        const c = p.coords;
        const patch = {
            lat: c.latitude, lng: c.longitude, accuracy: num(c.accuracy), heading: num(c.heading), speed: num(c.speed),
            updated_at: new Date().toISOString()
        };
        lastSent = { lat: c.latitude, lng: c.longitude, t: Date.now() };
        ids.forEach(id => applyRow(Object.assign({}, rows.get(id) || { id }, patch, { id }), true));
        const q = client().from(TABLE).update(patch);
        const run = ids.length === 1 ? q.eq('id', ids[0]) : q.in('id', ids);
        Promise.resolve(run).then(res => { if (res && res.error) console.warn('[live-location] update failed', res.error); },
            e => console.warn('[live-location] update failed', e));
    }

    async function stop(id) {
        id = String(id);
        const now = new Date().toISOString();
        dropMine(id);
        const r = rows.get(id);
        if (r && !r.stopped_at) applyRow(Object.assign({}, r, { stopped_at: now }), true);
        else refreshId(id);
        const c = client();
        if (!c) return;
        try {
            const { error } = await c.from(TABLE).update({ stopped_at: now }).eq('id', id);
            if (error) throw error;
        } catch (e) {
            console.warn('[live-location] stop failed', e);
            toast('Couldn’t reach the server — sharing will still end at the set time');
        }
    }

    // ---------- resume after reload ----------
    async function resume() {
        if (resumed) return;
        const p = me(), c = client();
        if (!p || !c) return;
        resumed = true;
        try {
            const { data, error } = await c.from(TABLE).select(COLS).eq('owner', p.id)
                .is('stopped_at', null).gt('expires_at', new Date().toISOString());
            if (error) throw error;
            (data || []).forEach(r => { applyRow(r, true); addMine(r); });
            if (mine.size) ensureChannel();
        } catch (e) {
            resumed = false;
            console.warn('[live-location] resume failed', e);
        }
    }
    (function waitForProfile() {
        const poll = setInterval(() => {
            if (resumed) { clearInterval(poll); return; }
            if (me() && client()) resume().then(() => { if (resumed) clearInterval(poll); });
        }, 1000);
    })();

    // Leaving the page doesn't stop sharing (it resumes next load) — just make sure nothing keeps watching.
    window.addEventListener('pagehide', () => {
        if (pendingPos) flush();
        stopWatch();
    });
    window.addEventListener('pageshow', e => {
        if (!e.persisted) return;
        pruneMine();
        if (mine.size) startWatch();
    });

    // ---------- duration picker ----------
    function buildPicker() {
        const d = document.createElement('dialog');
        d.className = 'll-picker';
        d.setAttribute('aria-labelledby', 'll-picker-title');
        d.innerHTML =
            '<form method="dialog" class="ll-picker-body">' +
            '<div class="ll-picker-icon" aria-hidden="true">' + svg('pin') + '</div>' +
            '<h2 id="ll-picker-title" class="ll-picker-title">Share live location</h2>' +
            '<p class="ll-picker-copy">Your friend (or the group) will see where you are, updating as you move, until the time runs out or you stop. You can stop any time.</p>' +
            '<div class="ll-options" role="radiogroup" aria-label="How long to share">' +
            DURATIONS.map((o, i) => '<button type="button" class="ll-option" role="radio" aria-checked="' + (i === 1) + '" data-i="' + i + '">' +
                '<span>' + o.label + '</span><span class="ll-check">' + svg('check') + '</span></button>').join('') +
            '</div>' +
            '<p class="ll-picker-status" role="status" aria-live="polite"></p>' +
            '<div class="ll-picker-actions">' +
            '<button type="button" class="ll-btn ll-btn-ghost" data-ll-cancel>Cancel</button>' +
            '<button type="submit" class="ll-btn ll-btn-primary" data-ll-go>' + svg('pin') + '<span>Share</span></button>' +
            '</div></form>';
        document.body.appendChild(d);
        const opts = Array.from(d.querySelectorAll('.ll-option'));
        const select = i => opts.forEach((b, j) => { b.setAttribute('aria-checked', String(i === j)); b.tabIndex = i === j ? 0 : -1; });
        opts.forEach((b, i) => b.addEventListener('click', () => select(i)));
        d.querySelector('.ll-options').addEventListener('keydown', e => {
            const cur = opts.findIndex(b => b.getAttribute('aria-checked') === 'true');
            let n = -1;
            if (e.key === 'ArrowDown' || e.key === 'ArrowRight') n = (cur + 1) % opts.length;
            if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') n = (cur + opts.length - 1) % opts.length;
            if (n >= 0) { e.preventDefault(); select(n); opts[n].focus(); }
        });
        select(1);
        // Tap on the backdrop closes
        d.addEventListener('click', e => { if (e.target === d) d.querySelector('[data-ll-cancel]').click(); });
        return d;
    }

    // Opens the picker; `work(duration, isCancelled, setBusy)` runs after Share and its result resolves the promise.
    function runPicker(work) {
        if (!picker) picker = buildPicker();
        const d = picker;
        if (d.open) return Promise.resolve(null);
        return new Promise(resolve => {
            let cancelled = false, busy = false, settled = false;
            const go = d.querySelector('[data-ll-go]');
            const cancelBtn = d.querySelector('[data-ll-cancel]');
            const status = d.querySelector('.ll-picker-status');
            const opts = Array.from(d.querySelectorAll('.ll-option'));
            const setBusy = text => {
                busy = !!text;
                d.classList.toggle('ll-busy', busy);
                status.textContent = text || '';
                go.disabled = busy;
                opts.forEach(b => { b.disabled = busy; });
            };
            setBusy('');
            const finish = val => {
                if (settled) return;
                settled = true;
                cleanup();
                if (d.open) d.close();
                setBusy('');
                resolve(val);
            };
            const onCancelEvt = () => { cancelled = true; finish(null); };      // Esc / Back
            const onCancelBtn = () => { cancelled = true; finish(null); };
            const onClose = () => { if (!settled) { cancelled = true; finish(null); } };
            const onSubmit = async e => {
                e.preventDefault();
                if (busy) return;
                const i = Math.max(0, opts.findIndex(b => b.getAttribute('aria-checked') === 'true'));
                let result = null;
                try { result = await work(DURATIONS[i].ms, () => cancelled, setBusy); } catch (err) { console.warn(err); }
                if (!cancelled) finish(result);
            };
            function cleanup() {
                d.removeEventListener('cancel', onCancelEvt);
                d.removeEventListener('close', onClose);
                cancelBtn.removeEventListener('click', onCancelBtn);
                d.querySelector('form').removeEventListener('submit', onSubmit);
            }
            d.addEventListener('cancel', onCancelEvt);
            d.addEventListener('close', onClose);
            cancelBtn.addEventListener('click', onCancelBtn);
            d.querySelector('form').addEventListener('submit', onSubmit);
            d.showModal();
            const sel = opts.find(b => b.getAttribute('aria-checked') === 'true');
            if (sel) sel.focus();
        });
    }

    // ---------- full-screen map ----------
    let leafletPromise = null;
    function loadLeaflet() {
        if (window.L && window.L.map) return Promise.resolve(window.L);
        if (leafletPromise) return leafletPromise;
        leafletPromise = new Promise((resolve, reject) => {
            if (!document.querySelector('link[data-ll-leaflet]')) {
                const l = document.createElement('link');
                l.rel = 'stylesheet';
                l.href = LEAFLET_CSS;
                l.crossOrigin = '';
                l.setAttribute('data-ll-leaflet', '');
                document.head.appendChild(l);
            }
            const s = document.createElement('script');
            s.src = LEAFLET_JS;
            s.async = true;
            s.crossOrigin = '';
            s.onload = () => (window.L && window.L.map ? resolve(window.L) : reject(new Error('Leaflet missing')));
            s.onerror = () => { leafletPromise = null; s.remove(); reject(new Error('Leaflet failed to load')); };
            document.head.appendChild(s);
        });
        return leafletPromise;
    }

    function buildFull() {
        const d = document.createElement('dialog');
        d.className = 'll-full';
        d.setAttribute('aria-labelledby', 'll-full-title');
        d.innerHTML =
            '<div class="ll-full-map" role="application" aria-label="Map"></div>' +
            '<div class="ll-full-fallback" hidden><p>The map couldn’t load. Check your connection.</p></div>' +
            '<div class="ll-full-top">' +
            '<button type="button" class="ll-round" data-ll-close aria-label="Close map">' + svg('close') + '</button>' +
            '<button type="button" class="ll-round" data-ll-fit aria-label="Show both of you">' + svg('target') + '</button>' +
            '</div>' +
            '<div class="ll-full-panel">' +
            '<div class="ll-full-who"><span class="ll-full-av"></span><div class="ll-full-text">' +
            '<h2 id="ll-full-title" class="ll-full-title"></h2>' +
            '<p class="ll-full-sub"><span class="ll-live-dot" aria-hidden="true"></span><span class="ll-full-status"></span></p>' +
            '<p class="ll-full-meta"></p></div></div>' +
            '<div class="ll-full-actions">' +
            '<a class="ll-btn ll-btn-primary" data-ll-dir target="_blank" rel="noopener">' + svg('nav') + '<span>Directions</span></a>' +
            '<button type="button" class="ll-btn ll-btn-stop" data-ll-fstop>' + svg('stop') + '<span>Stop sharing</span></button>' +
            '</div></div>';
        document.body.appendChild(d);
        d.querySelector('[data-ll-close]').addEventListener('click', () => d.close());
        d.querySelector('[data-ll-fit]').addEventListener('click', () => { if (full) { full.follow = true; fitFull(true); } });
        d.querySelector('[data-ll-fstop]').addEventListener('click', () => { if (full) stop(full.id); });
        d.addEventListener('cancel', () => { /* allow the default close; cleanup happens on close */ });
        d.addEventListener('close', teardownFull);
        return d;
    }
    let fullDlg = null;

    function open(id) {
        id = String(id);
        if (!fullDlg) fullDlg = buildFull();
        if (fullDlg.open) teardownFull();
        const v = rows.get(id);
        const card = document.querySelector('[data-live-loc="' + cssEsc(id) + '"]');
        const isMine = (v && me() && v.owner === me().id) || (card && card.hasAttribute('data-ll-mine'));
        let person = v ? personFor(v, isMine ? me() : null) : null;
        if (!person && card && card.getAttribute('data-ll-person')) {
            const pid = card.getAttribute('data-ll-person');
            person = ((I().state && I().state.friends) || []).find(f => f.id === pid) || null;
        }
        full = { id, isMine: !!isMine, person, map: null, marker: null, acc: null, meMarker: null, follow: true, watch: null, fitted: false };
        if (!v && !missing.has(id)) fetchRows([id]);
        const d = fullDlg;
        d.classList.toggle('ll-is-mine', full.isMine);
        d.querySelector('.ll-full-av').innerHTML = person && I().avatar ? I().avatar(person, 'md') : svg('pin');
        d.querySelector('.ll-full-fallback').hidden = true;
        refreshFull();
        d.showModal();
        d.querySelector('[data-ll-close]').focus();
        ensureChannel();
        ensureTicker();
        // Your own position (not needed when it's your own share — that *is* you).
        if (!full.isMine && supported) {
            const f = full;
            f.watch = navigator.geolocation.watchPosition(p => {
                if (full !== f) return;
                setMyFix(p);
                refreshFull();
            }, () => { }, { enableHighAccuracy: true, maximumAge: 10e3, timeout: 30e3 });
        }
        const f = full;
        loadLeaflet().then(L => {
            if (full !== f || !d.open) return;
            buildLeaflet(L);
        }, () => {
            if (full !== f) return;
            d.querySelector('.ll-full-fallback').hidden = false;
        });
    }

    function buildLeaflet(L) {
        const d = fullDlg, f = full;
        const el = d.querySelector('.ll-full-map');
        const v = rows.get(f.id) || {};
        const start = valid(v.lat, v.lng) ? [+v.lat, +v.lng] : (myFix ? [myFix.lat, myFix.lng] : [0, 0]);
        f.map = L.map(el, { zoomControl: false, attributionControl: true }).setView(start, 16);
        L.tileLayer(OSM, { maxZoom: 19, attribution: OSM_ATTR, className: 'll-osm' }).addTo(f.map);
        L.control.zoom({ position: 'topright' }).addTo(f.map);
        f.map.attributionControl.setPrefix(false);
        const stopFollow = () => { f.follow = false; };
        f.map.on('dragstart', stopFollow);
        f.map.on('zoomstart', e => { if (e && e.originalEvent) stopFollow(); });
        el.addEventListener('wheel', stopFollow, { passive: true });
        const icon = L.divIcon({ className: 'll-leaf-icon', html: pinHTML(f.person), iconSize: [44, 46], iconAnchor: [22, 46] });
        f.marker = L.marker(start, { icon, keyboard: false, interactive: false, zIndexOffset: 1000 }).addTo(f.map);
        f.acc = L.circle(start, { radius: 0, className: 'll-acc', interactive: false }).addTo(f.map);
        // Map sizes itself once the dialog has laid out.
        requestAnimationFrame(() => { if (f.map) { f.map.invalidateSize(); refreshFull(); } });
    }

    function fitFull(animate) {
        const f = full;
        if (!f || !f.map) return;
        const v = rows.get(f.id);
        const pts = [];
        if (v && valid(v.lat, v.lng)) pts.push([+v.lat, +v.lng]);
        if (!f.isMine && myFix) pts.push([myFix.lat, myFix.lng]);
        if (!pts.length) return;
        if (pts.length === 1) f.map.setView(pts[0], Math.max(f.map.getZoom(), 16), { animate: !!animate });
        else {
            const small = window.innerWidth < 640;
            f.map.fitBounds(pts, {
                paddingTopLeft: [48, small ? 96 : 80], paddingBottomRight: [48, small ? 220 : 180],
                maxZoom: 17, animate: !!animate
            });
        }
    }

    function refreshFull() {
        const f = full;
        if (!f || !fullDlg) return;
        const d = fullDlg;
        const v = rows.get(f.id) || {};
        const ended = missing.has(f.id) || (rows.has(f.id) && isEnded(v));
        const name = f.isMine ? 'Your location' : (f.person ? (f.person.display_name || f.person.username) + '’s location' : 'Live location');
        d.classList.toggle('ll-ended', ended);
        setText(d, '.ll-full-title', name);
        setText(d, '.ll-full-status', ended ? 'Location sharing ended' + (v.expires_at ? ' · ' + clock(endedAt(v)) : '')
            : 'Live' + (v.expires_at ? ' until ' + clock(v.expires_at) : ''));
        const bits = [];
        const u = v.updated_at || v.started_at;
        if (u) bits.push((ended ? 'Last updated ' : 'Updated ') + ago(u));
        if (!f.isMine) { const dd = distFor(v); if (dd) bits.push(dd); }
        if (valid(v.accuracy, 0) && v.accuracy > 0 && !ended) bits.push('±' + Math.round(v.accuracy) + ' m');
        setText(d, '.ll-full-meta', bits.join(' · '));
        const dir = d.querySelector('[data-ll-dir]');
        if (valid(v.lat, v.lng)) {
            const ll = (+v.lat).toFixed(6) + ',' + (+v.lng).toFixed(6);
            dir.href = isIOS ? 'https://maps.apple.com/?daddr=' + ll : 'https://www.google.com/maps/dir/?api=1&destination=' + ll;
            dir.removeAttribute('aria-disabled');
        } else { dir.removeAttribute('href'); dir.setAttribute('aria-disabled', 'true'); }
        dir.hidden = f.isMine;
        d.querySelector('[data-ll-fstop]').hidden = !f.isMine || ended;
        if (!f.map || !window.L) return;
        if (valid(v.lat, v.lng)) {
            const pos = [+v.lat, +v.lng];
            f.marker.setLatLng(pos);
            f.acc.setLatLng(pos).setRadius(ended ? 0 : Math.min(+v.accuracy || 0, 2000));
        }
        const markerEl = f.marker && f.marker.getElement && f.marker.getElement();
        if (markerEl) markerEl.classList.toggle('ll-ended', ended);
        if (!f.isMine && myFix) {
            if (!f.meMarker) {
                f.meMarker = window.L.marker([myFix.lat, myFix.lng], {
                    icon: window.L.divIcon({ className: 'll-leaf-me', html: '<span class="ll-me-dot" aria-hidden="true"></span>', iconSize: [22, 22], iconAnchor: [11, 11] }),
                    keyboard: false, interactive: false
                }).addTo(f.map);
                f.fitted = false;
            } else f.meMarker.setLatLng([myFix.lat, myFix.lng]);
        }
        if (!f.fitted) { f.fitted = true; fitFull(false); }
        else if (f.follow && valid(v.lat, v.lng)) {
            const b = f.map.getBounds();
            const pos = window.L.latLng(+v.lat, +v.lng);
            if (!b.pad(-0.15).contains(pos)) f.map.panTo(pos, { animate: true });
        }
    }

    function teardownFull() {
        const f = full;
        full = null;
        if (!f) return;
        if (f.watch !== null && f.watch !== undefined) { try { navigator.geolocation.clearWatch(f.watch); } catch (e) { /* ignore */ } }
        if (f.map) { try { f.map.remove(); } catch (e) { /* ignore */ } }
        if (fullDlg) {
            const el = fullDlg.querySelector('.ll-full-map');
            const fresh = el.cloneNode(false);
            el.replaceWith(fresh);
        }
    }

    // ---------- delegated card actions ----------
    document.addEventListener('click', e => {
        const t = e.target;
        if (!t || !t.closest) return;
        const card = t.closest('.ll-card[data-live-loc]');
        if (!card) return;
        const id = card.getAttribute('data-live-loc');
        if (t.closest('[data-ll-stop]')) {
            e.preventDefault();
            e.stopPropagation();
            stop(id).then(() => toast('Stopped sharing your location'));
        } else if (t.closest('[data-ll-view]')) {
            e.preventDefault();
            e.stopPropagation();
            open(id);
        }
    });

    window.LiveLocation = {
        supported,
        share,
        stop,
        cardHTML,
        hydrate,
        open,
        active,
        onchange: null
    };
})();
