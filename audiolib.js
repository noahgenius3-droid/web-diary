// Audio for posts: a searchable library, a picker with preview, start point, length and volume, and playback on
// the Feed.
//
// The catalogue comes from pluggable sources, so licensed music can be connected without touching the picker:
//   • Cordial Sounds — original instrumentals in Nigerian styles, synthesised here (nothing to license, works
//     offline). Always available.
//   • A licensed catalogue — /audio/catalog.json (an admin-managed list, see audio/README.md) and, when
//     DIARY_CONFIG.audioCatalogTable is set, a Supabase table of the same shape. Licensed tracks are streamed from
//     their own URLs and never copied into Cordial's storage.
// No commercial recordings are bundled with the app.
document.addEventListener('DOMContentLoaded', () => {
    const app = window.diaryApp;
    if (!app) return;
    const cfg = window.DIARY_CONFIG || {};
    const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const ic = id => `<svg class="i" aria-hidden="true"><use href="#${id}"/></svg>`;
    const fmt = sec => { sec = Math.max(0, Math.round(sec)); return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`; };
    const Ctx = window.AudioContext || window.webkitAudioContext;
    const OfflineCtx = window.OfflineAudioContext || window.webkitOfflineAudioContext;

    // ---------- Categories ----------
    const CATEGORIES = [['all', 'For you'], ['trending', 'Trending'], ['popular', 'Popular'], ['new', 'New releases'], ['afrobeats', 'Afrobeats'], ['gospel', 'Gospel'], ['afropop', 'Afropop'], ['highlife', 'Highlife'], ['amapiano', 'Amapiano']];

    // ---------- Cordial Sounds: original instrumentals ----------
    // Each style is a 4-bar loop of 16th-note patterns over a chord progression; tracks vary key, seed and flags.
    const STYLES = {
        afrobeats: { bpm: 104, swing: 0.12, minor: true, prog: [0, 8, 3, 10], kick: 'x.....x...x.....', clap: '....x.......x...', hat: '..x...x...x...x.', shaker: 'xxxxxxxxxxxxxxxx', conga: '...x..x....x.x..', bass: 'x.....x...x...x.', pluck: '.x..x..x.x..x...', colors: ['#f97316', '#db2777'] },
        amapiano: { bpm: 112, swing: 0.08, minor: true, prog: [0, 5, 3, 7], kick: 'x...x...x...x...', clap: '....x.......x...', hat: '..x...x...x...x.', shaker: 'xxxxxxxxxxxxxxxx', log: '..x....x..x...x.', keys: '...x.....x......', colors: ['#7c3aed', '#0ea5e9'] },
        highlife: { bpm: 124, swing: 0.05, minor: false, prog: [0, 5, 7, 0], kick: 'x.......x.......', clap: '....x.......x...', bell: 'x.x.xx.x.x.xx.x.', shaker: 'x.x.x.x.x.x.x.x.', bass: 'x.......x...x...', arp: 'xxxxxxxxxxxxxxxx', colors: ['#16a34a', '#eab308'] },
        gospel: { bpm: 96, swing: 0.1, minor: false, prog: [0, 9, 5, 7], kick: 'x......x..x.....', clap: '....x.......x...', hat: 'x.x.x.x.x.x.x.x.', bass: 'x...x...x...x...', organ: 'x...............', colors: ['#2563eb', '#a855f7'] },
        afropop: { bpm: 100, swing: 0.1, minor: true, prog: [0, 3, 8, 10], kick: 'x...x.....x.....', clap: '....x.......x...', hat: '..x...x...x...x.', shaker: 'x.xxx.xxx.xxx.xx', bass: 'x..x....x..x....', pad: 'x...............', lead: 'x..x..x...x.x...', colors: ['#e11d48', '#f59e0b'] }
    };
    const CORDIAL = [
        ['lagos-sunset', 'Lagos Sunset', 'afrobeats', 57, 11, { trending: 1 }],
        ['island-groove', 'Island Groove', 'afrobeats', 54, 23, { popular: 1 }],
        ['eko-log-drum', 'Eko Log Drum', 'amapiano', 50, 31, { trending: 1 }],
        ['night-market', 'Night Market', 'amapiano', 55, 41, { new: 1 }],
        ['palmwine-road', 'Palmwine Road', 'highlife', 60, 53, { popular: 1 }],
        ['enugu-morning', 'Enugu Morning', 'highlife', 55, 61, {}],
        ['grace-dey', 'Grace Dey', 'gospel', 51, 71, { popular: 1, trending: 1 }],
        ['joyful-noise', 'Joyful Noise', 'gospel', 56, 83, { new: 1 }],
        ['owambe-lights', 'Owambe Lights', 'afropop', 58, 97, { trending: 1 }],
        ['abuja-drive', 'Abuja Drive', 'afropop', 52, 101, { new: 1 }]
    ].map(([id, title, style, root, seed, flags]) => ({
        id: `cordial:${id}`, title, artist: 'Cordial Sounds', category: [style, ...Object.keys(flags)], style, root, seed,
        duration: 60, source: 'cordial', cover: null
    }));

    // A deterministic random number per (seed, step), so a clip from 0:12 always sounds the same
    const hash = (seed, k) => { let x = (seed * 374761393 + k * 668265263) | 0; x = (x ^ (x >>> 13)) * 1274126177; return ((x ^ (x >>> 16)) >>> 0) / 4294967295; };
    const midi = n => 440 * Math.pow(2, (n - 69) / 12);

    // Render [start, start + length) of a Cordial track into an AudioBuffer
    async function renderCordial(track, start, length, volume = 1, rate = 32000) {
        if (!OfflineCtx) throw new Error('This browser can’t make audio');
        const st = STYLES[track.style];
        const ctx = new OfflineCtx(1, Math.ceil(length * rate), rate);
        const out = ctx.createGain();
        out.gain.value = volume;
        const comp = ctx.createDynamicsCompressor();
        comp.threshold.value = -18; comp.ratio.value = 4; comp.attack.value = 0.004; comp.release.value = 0.2;
        const make = ctx.createGain();
        make.gain.value = 1.8;
        const lim = ctx.createDynamicsCompressor();
        lim.threshold.value = -2; lim.ratio.value = 20; lim.attack.value = 0.001; lim.release.value = 0.08;
        out.connect(comp); comp.connect(make); make.connect(lim); lim.connect(ctx.destination);
        // Gentle fades at the clip's edges
        const fade = Math.min(0.4, length / 6);
        out.gain.setValueAtTime(0, 0);
        out.gain.linearRampToValueAtTime(volume, fade);
        out.gain.setValueAtTime(volume, Math.max(fade, length - fade));
        out.gain.linearRampToValueAtTime(0, length);

        const noiseBuf = ctx.createBuffer(1, rate, rate);
        const nd = noiseBuf.getChannelData(0);
        for (let i = 0; i < nd.length; i++) nd[i] = Math.random() * 2 - 1;
        const env = (g, t, peak, attack, dur) => {
            g.gain.setValueAtTime(0.0001, t);
            g.gain.linearRampToValueAtTime(peak, t + attack);
            g.gain.exponentialRampToValueAtTime(0.0001, t + attack + dur);
        };
        const tone = (t, freq, dur, { type = 'sine', gain = 0.2, attack = 0.005, cutoff = 0, glideTo = 0 } = {}) => {
            const o = ctx.createOscillator();
            o.type = type;
            o.frequency.setValueAtTime(freq, t);
            if (glideTo) o.frequency.exponentialRampToValueAtTime(glideTo, t + dur);
            const g = ctx.createGain();
            env(g, t, gain, attack, dur);
            let n = o;
            if (cutoff) { const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = cutoff; o.connect(f); n = f; }
            n.connect(g); g.connect(out);
            o.start(t); o.stop(t + attack + dur + 0.05);
        };
        const noise = (t, dur, { gain = 0.08, type = 'highpass', freq = 7000, q = 1 } = {}) => {
            const src = ctx.createBufferSource();
            src.buffer = noiseBuf;
            const f = ctx.createBiquadFilter();
            f.type = type; f.frequency.value = freq; f.Q.value = q;
            const g = ctx.createGain();
            env(g, t, gain, 0.002, dur);
            src.connect(f); f.connect(g); g.connect(out);
            src.start(t, hash(track.seed, Math.round(t * 100)) * 0.5); src.stop(t + dur + 0.05);
        };
        const kick = t => tone(t, 130, 0.22, { gain: 0.9, glideTo: 42 });
        const clap = t => { noise(t, 0.12, { gain: 0.32, type: 'bandpass', freq: 1500, q: 0.8 }); noise(t + 0.012, 0.1, { gain: 0.2, type: 'bandpass', freq: 1800, q: 0.8 }); };
        const hat = (t, v = 0.08) => noise(t, 0.035, { gain: v, freq: 8500 });
        const shaker = (t, v = 0.05) => noise(t, 0.05, { gain: v, type: 'bandpass', freq: 6500, q: 1.2 });
        const conga = (t, hi) => tone(t, hi ? 320 : 230, 0.16, { gain: 0.3, glideTo: hi ? 260 : 180 });
        const bell = (t, hi) => { tone(t, hi ? 1200 : 900, 0.12, { type: 'square', gain: 0.045, cutoff: 3000 }); tone(t, hi ? 1800 : 1350, 0.08, { gain: 0.03 }); };

        // Scale and chords from the track's root
        const scale = st.minor ? [0, 2, 3, 5, 7, 8, 10] : [0, 2, 4, 5, 7, 9, 11];
        const chordOf = deg => { // a triad (plus 7th) built on a semitone offset from the root
            const base = track.root + deg;
            const third = st.minor && [0, 5, 7].includes(deg % 12) ? 3 : (st.minor ? 4 : ([0, 5, 7].includes(deg % 12) ? 4 : 3));
            return [base, base + third, base + 7, base + 10 + (st.minor ? 0 : 1)];
        };
        const step = 60 / st.bpm / 4;
        const first = Math.max(0, Math.floor(start / step) - 1);
        const last = Math.ceil((start + length) / step);
        const on = (pat, pos) => pat && pat[pos % pat.length] === 'x';
        for (let k = first; k <= last; k++) {
            const pos = k % 16;
            const bar = Math.floor(k / 16);
            const t = k * step + (pos % 2 ? st.swing * step : 0) - start;
            if (t < 0 || t > length) continue;
            const r = hash(track.seed, k);
            const chord = chordOf(st.prog[bar % 4]);
            const rootNote = chord[0];
            // An intro: the first bar of the track is drums only
            const intro = bar === 0;
            if (on(st.kick, pos)) kick(t);
            if (on(st.clap, pos) && !intro) clap(t);
            if (on(st.hat, pos)) hat(t, pos % 4 === 2 ? 0.1 : 0.06);
            if (on(st.shaker, pos)) shaker(t, pos % 2 ? 0.035 : 0.055);
            if (on(st.conga, pos)) conga(t, r > 0.5);
            if (on(st.bell, pos)) bell(t, pos % 4 === 0);
            if (intro) continue;
            if (on(st.bass, pos)) tone(t, midi(rootNote - 24 + (r > 0.85 ? 7 : 0)), step * 2.5, { type: 'triangle', gain: 0.5, cutoff: 600 });
            if (on(st.log, pos)) tone(t, midi(rootNote - 24 + (r > 0.6 ? 7 : 0)), 0.42, { type: 'sine', gain: 0.75, glideTo: midi(rootNote - 26) });
            if (on(st.pluck, pos)) { const n = chord[Math.floor(r * 3)] + 12; tone(t, midi(n), 0.22, { type: 'triangle', gain: 0.16, cutoff: 2600 }); }
            if (on(st.arp, pos) && pos % 2 === 0) { const n = chord[(pos / 2) % 3] + 12; tone(t, midi(n), 0.2, { type: 'triangle', gain: 0.13, cutoff: 3200 }); }
            if (on(st.keys, pos)) chord.forEach((n, i) => tone(t, midi(n), 0.5, { type: 'sine', gain: 0.07 - i * 0.008 }));
            if (on(st.organ, pos)) chord.forEach((n, i) => { tone(t, midi(n), step * 15, { type: 'sine', gain: 0.06, attack: 0.08 }); tone(t, midi(n + 12), step * 15, { type: 'sine', gain: 0.025, attack: 0.08 }); });
            if (on(st.pad, pos)) chord.slice(0, 3).forEach(n => tone(t, midi(n), step * 15, { type: 'sawtooth', gain: 0.03, attack: 0.3, cutoff: 1400 }));
            if (on(st.lead, pos) && r > 0.25) { const n = track.root + 12 + scale[Math.floor(r * 7)]; tone(t, midi(n), 0.28, { type: 'square', gain: 0.05, cutoff: 2200 }); }
        }
        return ctx.startRendering();
    }

    // A 16-bit mono WAV from an AudioBuffer
    function wavFrom(buffer) {
        const data = buffer.getChannelData(0);
        const rate = buffer.sampleRate;
        const bytes = new ArrayBuffer(44 + data.length * 2);
        const v = new DataView(bytes);
        const str = (o, s) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
        str(0, 'RIFF'); v.setUint32(4, 36 + data.length * 2, true); str(8, 'WAVE'); str(12, 'fmt ');
        v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, rate, true);
        v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); str(36, 'data'); v.setUint32(40, data.length * 2, true);
        for (let i = 0; i < data.length; i++) v.setInt16(44 + i * 2, Math.max(-1, Math.min(1, data[i])) * 0x7fff, true);
        return new Blob([bytes], { type: 'audio/wav' });
    }

    // ---------- The licensed catalogue (admin-managed list or provider) ----------
    let licensed = null;
    async function loadLicensed() {
        if (licensed) return licensed;
        licensed = [];
        try {
            const res = await fetch('audio/catalog.json', { cache: 'no-cache' });
            if (res.ok) {
                const data = await res.json();
                (Array.isArray(data.tracks) ? data.tracks : []).forEach(t => licensed.push(normalise(t)));
            }
        } catch (e) { /* no list yet */ }
        try {
            const table = cfg.audioCatalogTable;
            const client = window.diarySocial && window.diarySocial.internals && window.diarySocial.internals.client;
            if (table && client) {
                const { data } = await client.from(table).select('*').eq('active', true).limit(500);
                (data || []).forEach(t => licensed.push(normalise(t)));
            }
        } catch (e) { /* provider unavailable */ }
        return licensed;
    }
    function normalise(t) {
        const cat = Array.isArray(t.category) ? t.category : String(t.category || '').split(',');
        const flags = ['trending', 'popular', 'new'].filter(f => t[f] || t[`is_${f}`]);
        return {
            id: String(t.id || t.audio_id), title: String(t.title || 'Untitled'), artist: String(t.artist || t.artist_name || ''),
            cover: t.cover || t.cover_url || t.artwork || null, preview: t.preview || t.preview_url || t.src || t.audio_url || null,
            src: t.src || t.audio_url || t.preview_url || null, duration: Number(t.duration) || 30,
            category: [...cat.map(c => String(c).trim().toLowerCase()).filter(Boolean), ...flags], source: 'licensed'
        };
    }
    // Licensed tracks from the diary-music function (Jamendo: independent artists, Creative Commons licences).
    // Searched on the server per category / query; answers { ready: false } until its client ID is set.
    const remote = { ready: null, cache: new Map() };
    async function token() {
        try {
            const c = window.diarySocial && window.diarySocial.internals && window.diarySocial.internals.client;
            const { data } = c ? await c.auth.getSession() : { data: null };
            return data && data.session && data.session.access_token;
        } catch (e) { return null; }
    }
    async function remoteTracks(category, q) {
        if (remote.ready === false) return [];
        const key = `${category}|${q}`;
        if (remote.cache.has(key)) return remote.cache.get(key);
        const t = await token();
        if (!t) return [];
        try {
            const res = await fetch(`${cfg.supabaseUrl}/functions/v1/diary-music`, {
                method: 'POST',
                headers: { Authorization: `Bearer ${t}`, apikey: cfg.supabaseKey, 'Content-Type': 'application/json' },
                body: JSON.stringify({ category, q })
            });
            const data = await res.json();
            remote.ready = !!(data && data.ready);
            const list = (data && Array.isArray(data.tracks) ? data.tracks : []).map(x => ({ ...normalise(x), licenseUrl: x.licenseUrl || null, licenseName: x.licenseName || null, shareurl: x.shareurl || null, provider: x.provider || 'Jamendo' }));
            remote.cache.set(key, list);
            return list;
        } catch (e) { return []; }
    }
    // Audio bytes for mixing into a reel: straight from the source, or through diary-music when the browser can't
    async function fetchAudio(music) {
        try {
            const res = await fetch(music.src);
            if (res.ok) return await res.arrayBuffer();
        } catch (e) { /* blocked: go through the server */ }
        const t = await token();
        const res = await fetch(`${cfg.supabaseUrl}/functions/v1/diary-music`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${t}`, apikey: cfg.supabaseKey, 'Content-Type': 'application/json' },
            body: JSON.stringify({ stream: music.src })
        });
        if (!res.ok) throw new Error('music');
        return res.arrayBuffer();
    }

    async function catalogue() {
        return [...(await loadLicensed()), ...CORDIAL];
    }

    // ---------- Previews ----------
    let player = null; // { stop } for whatever is playing in the picker or on a post
    function stopAll() { if (player) { try { player.stop(); } catch (e) {} player = null; } }
    async function playTrack(track, start, length, volume, onEnd) {
        stopAll();
        if (track.source === 'cordial') {
            if (!Ctx) return;
            const buf = await renderCordial(track, start, Math.min(length, 20), volume);
            const ctx = new Ctx();
            const src = ctx.createBufferSource();
            src.buffer = buf;
            src.connect(ctx.destination);
            src.onended = () => { if (player && player.src === src) { player = null; onEnd && onEnd(); } ctx.close().catch(() => {}); };
            src.start();
            player = { src, stop: () => { src.onended = null; try { src.stop(); } catch (e) {} ctx.close().catch(() => {}); onEnd && onEnd(); } };
            return;
        }
        const a = new Audio(track.preview || track.src);
        a.volume = volume;
        a.currentTime = start || 0;
        const timer = setTimeout(() => a.pause(), length * 1000);
        a.onended = a.onpause = () => { clearTimeout(timer); if (player && player.a === a) { player = null; onEnd && onEnd(); } };
        a.play().catch(() => { app.showToast('Couldn’t play that preview'); onEnd && onEnd(); });
        player = { a, stop: () => { a.onpause = a.onended = null; a.pause(); clearTimeout(timer); onEnd && onEnd(); } };
    }

    // ---------- Artwork ----------
    function coverHTML(track, big = false) {
        if (track.cover) return `<span class="al-cover${big ? ' big' : ''}"><img src="${esc(track.cover)}" alt="" loading="lazy" referrerpolicy="no-referrer"></span>`;
        const [a, b] = (STYLES[track.style] || STYLES.afrobeats).colors;
        return `<span class="al-cover${big ? ' big' : ''} gen" style="--c1:${a};--c2:${b}" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i></span>`;
    }
    const catLabel = track => (CATEGORIES.find(c => track.category.includes(c[0]) && !['trending', 'popular', 'new', 'all'].includes(c[0])) || ['', ''])[1];

    // ---------- The picker ----------
    const dlg = document.createElement('dialog');
    dlg.className = 'al-dlg';
    dlg.setAttribute('aria-labelledby', 'al-h');
    document.body.append(dlg);
    let P = null; // { tracks, cat, q, sel, start, length, volume, resolve, playing }

    function open() {
        return new Promise(async resolve => {
            P = { tracks: CORDIAL, remote: [], loadingRemote: true, cat: 'all', q: '', sel: null, start: 0, length: 30, volume: 0.8, resolve, playing: null };
            paintBrowse();
            if (!dlg.open) dlg.showModal();
            P.tracks = await catalogue();
            if (P && !P.sel) paintBrowse();
            refreshRemote();
        });
    }
    function finish(value) {
        stopAll();
        const r = P && P.resolve;
        P = null;
        if (dlg.open) dlg.close();
        if (r) r(value);
    }
    dlg.addEventListener('close', () => { if (P) finish(null); });

    function listFor() {
        const q = P.q.trim().toLowerCase();
        const local = P.tracks.filter(t => (P.cat === 'all' || t.category.includes(P.cat)) && (!q || `${t.title} ${t.artist} ${t.category.join(' ')}`.toLowerCase().includes(q)));
        // Licensed results first (already matched on the server), then the rest
        const seen = new Set(P.remote.map(t => t.id));
        return [...P.remote, ...local.filter(t => !seen.has(t.id))];
    }
    let remoteTimer = null;
    function refreshRemote(delay = 0) {
        clearTimeout(remoteTimer);
        if (!P) return;
        const want = { cat: P.cat, q: P.q.trim() };
        P.loadingRemote = remote.ready !== false;
        remoteTimer = setTimeout(async () => {
            const list = await remoteTracks(want.cat, want.q);
            if (!P || P.cat !== want.cat || P.q.trim() !== want.q) return;
            P.remote = list;
            P.loadingRemote = false;
            if (!P.sel) paintBrowse(document.activeElement && document.activeElement.id === 'al-q');
        }, delay);
    }
    function paintBrowse(keepFocus = false) {
        const list = listFor();
        const hasLicensed = P.remote.length > 0 || remote.ready || P.tracks.some(t => t.source === 'licensed');
        dlg.innerHTML = `
            <div class="al-card">
                <header class="al-head"><h3 id="al-h">Add audio</h3><button type="button" class="icon-btn" data-al="close" aria-label="Close">${ic('i-close')}</button></header>
                <label class="search al-search">${ic('i-search')}<input type="search" id="al-q" placeholder="Search songs, artists and genres" value="${esc(P.q)}" autocomplete="off" aria-label="Search audio"></label>
                <div class="al-cats" role="tablist" aria-label="Categories">${CATEGORIES.map(([k, l]) => `<button type="button" role="tab" class="al-cat" aria-selected="${P.cat === k}" data-al="cat" data-k="${k}">${l}</button>`).join('')}</div>
                <ul class="al-list">${list.length ? list.map(t => `
                    <li class="al-row">
                        <button type="button" class="al-pick" data-al="pick" data-id="${esc(t.id)}">${coverHTML(t)}<span class="al-text"><strong>${esc(t.title)}</strong><small>${esc(t.artist)}${t.licenseName ? ` · <span class="al-lic">${esc(t.licenseName)}</span>` : catLabel(t) ? ` · ${esc(catLabel(t))}` : ''} · ${fmt(t.duration)}</small></span></button>
                        <button type="button" class="al-play" data-al="preview" data-id="${esc(t.id)}" aria-label="${P.playing === t.id ? 'Stop' : 'Play'} ${esc(t.title)}" aria-pressed="${P.playing === t.id}">${ic(P.playing === t.id ? 'i-pause' : 'i-play')}</button>
                    </li>`).join('') : (P.loadingRemote ? '' : '<li class="al-empty">No audio matches that yet.</li>')}${P.loadingRemote ? '<li class="al-loading" aria-live="polite"><span class="al-spin" aria-hidden="true"></span>Finding licensed music…</li>' : ''}</ul>
                <p class="al-note">${hasLicensed ? 'Licensed music from independent artists via Jamendo, under Creative Commons licences — the artist and licence are credited on your post. Cordial Sounds are original instrumentals made for Cordial.' : 'Cordial Sounds are original instrumentals made for Cordial — free to use. Licensed music appears here once Cordial’s catalogue is connected.'}</p>
            </div>`;
        if (keepFocus) { const q = dlg.querySelector('#al-q'); q.focus(); q.setSelectionRange(q.value.length, q.value.length); }
    }
    function paintEdit() {
        const t = P.sel;
        const maxLen = Math.min(60, t.duration);
        P.length = Math.min(P.length, maxLen);
        const maxStart = Math.max(0, t.duration - P.length);
        P.start = Math.min(P.start, maxStart);
        dlg.innerHTML = `
            <div class="al-card">
                <header class="al-head"><button type="button" class="icon-btn" data-al="back" aria-label="Back to the library">${ic('i-chevron-left')}</button><h3 id="al-h">Choose the part</h3><button type="button" class="icon-btn" data-al="close" aria-label="Close">${ic('i-close')}</button></header>
                <div class="al-now">${coverHTML(t, true)}<span class="al-text"><strong>${esc(t.title)}</strong><small>${esc(t.artist)}${catLabel(t) ? ` · ${esc(catLabel(t))}` : ''}</small></span>
                    <button type="button" class="al-play big" data-al="preview-sel" aria-label="${P.playing === 'sel' ? 'Stop preview' : 'Preview this part'}" aria-pressed="${P.playing === 'sel'}">${ic(P.playing === 'sel' ? 'i-pause' : 'i-play')}</button></div>
                <label class="al-field"><span>Start at <b id="al-start-v">${fmt(P.start)}</b></span>
                    <input type="range" id="al-start" min="0" max="${Math.floor(maxStart)}" step="1" value="${Math.round(P.start)}" ${maxStart ? '' : 'disabled'}>
                    <span class="al-window" aria-hidden="true"><i style="left:${(P.start / t.duration) * 100}%;width:${(P.length / t.duration) * 100}%"></i></span></label>
                <div class="al-field"><span>Length</span><div class="al-seg" role="radiogroup" aria-label="Length">${[15, 30, 60].filter(n => n <= maxLen || n === 15).map(n => `<button type="button" role="radio" aria-checked="${P.length === n}" data-al="len" data-n="${n}">${n}s</button>`).join('')}</div></div>
                <label class="al-field"><span>Volume <b id="al-vol-v">${Math.round(P.volume * 100)}%</b></span><input type="range" id="al-vol" min="10" max="100" step="5" value="${Math.round(P.volume * 100)}"></label>
                <button type="button" class="primary-btn al-use" data-al="use">${ic('i-check')}Use this audio</button>
            </div>`;
    }
    dlg.addEventListener('input', e => {
        if (!P) return;
        if (e.target.id === 'al-q') { P.q = e.target.value; P.remote = []; paintBrowse(true); refreshRemote(450); }
        if (e.target.id === 'al-start') {
            P.start = Number(e.target.value);
            dlg.querySelector('#al-start-v').textContent = fmt(P.start);
            dlg.querySelector('.al-window i').style.left = `${(P.start / P.sel.duration) * 100}%`;
        }
        if (e.target.id === 'al-vol') { P.volume = Number(e.target.value) / 100; dlg.querySelector('#al-vol-v').textContent = `${e.target.value}%`; }
    });
    dlg.addEventListener('change', e => {
        // A new start or volume previews right away, so you hear what you chose
        if (P && P.sel && (e.target.id === 'al-start' || e.target.id === 'al-vol') && P.playing === 'sel') startSelPreview();
    });
    function startSelPreview() {
        P.playing = 'sel';
        playTrack(P.sel, P.start, P.length, P.volume, () => { if (P && P.playing === 'sel') { P.playing = null; if (P.sel) repaintPlay(); } });
        repaintPlay();
    }
    function repaintPlay() {
        const b = dlg.querySelector('[data-al="preview-sel"]');
        if (!b) return;
        b.setAttribute('aria-pressed', String(P.playing === 'sel'));
        b.innerHTML = ic(P.playing === 'sel' ? 'i-pause' : 'i-play');
    }
    dlg.addEventListener('click', async e => {
        const el = e.target.closest('[data-al]');
        if (!el || !P) return;
        const what = el.dataset.al;
        const byId = id => P.remote.find(t => t.id === id) || P.tracks.find(t => t.id === id);
        if (what === 'close') finish(null);
        else if (what === 'cat') { P.cat = el.dataset.k; P.remote = []; paintBrowse(); refreshRemote(); }
        else if (what === 'preview') {
            const t = byId(el.dataset.id);
            if (P.playing === t.id) { stopAll(); P.playing = null; return paintBrowse(); }
            P.playing = t.id;
            paintBrowse();
            playTrack(t, t.source === 'cordial' ? 0 : 0, 15, 0.8, () => { if (P && P.playing === t.id) { P.playing = null; if (!P.sel) paintBrowse(); } });
        } else if (what === 'pick') {
            stopAll();
            P.playing = null;
            P.sel = byId(el.dataset.id);
            P.start = 0;
            P.length = Math.min(30, P.sel.duration);
            paintEdit();
        } else if (what === 'back') { stopAll(); P.playing = null; P.sel = null; paintBrowse(); }
        else if (what === 'len') { P.length = Number(el.dataset.n); paintEdit(); }
        else if (what === 'preview-sel') {
            if (P.playing === 'sel') { stopAll(); P.playing = null; repaintPlay(); }
            else startSelPreview();
        } else if (what === 'use') {
            stopAll();
            const t = P.sel;
            el.disabled = true;
            el.innerHTML = 'Preparing…';
            const music = { id: t.id, title: t.title, artist: t.artist, cover: t.cover || null, category: catLabel(t) || null, source: t.source, style: t.style || null, start: Math.round(P.start), length: P.length, volume: P.volume, ...(t.licenseUrl ? { licenseUrl: t.licenseUrl, licenseName: t.licenseName, shareurl: t.shareurl, provider: t.provider } : {}) };
            try {
                if (t.source === 'cordial') {
                    // Original instrumentals are rendered into a short clip that travels with the post
                    const buf = await renderCordial(t, P.start, P.length, P.volume);
                    const file = new File([wavFrom(buf)], `${t.title}.wav`, { type: 'audio/wav' });
                    finish({ file, duration: P.length, name: `${t.title} · ${t.artist}`, music });
                } else {
                    // Licensed music is streamed from its source, never copied
                    finish({ file: null, duration: P.length, name: `${t.title} · ${t.artist}`, music: { ...music, src: t.src } });
                }
            } catch (err) {
                el.disabled = false;
                el.innerHTML = `${ic('i-check')}Use this audio`;
                app.showToast('Couldn’t prepare that audio on this device');
            }
        }
    });

    // ---------- Playing music on a post ----------
    // One track at a time; a post's music plays from its chosen start, for its length, at its volume.
    let postPlaying = null;
    async function playPost(btn, music, url) {
        if (postPlaying && postPlaying.btn === btn) { stopAll(); return; }
        stopAll();
        const a = new Audio(url);
        a.volume = Math.max(0.05, Math.min(1, music.volume || 0.8));
        const fromRef = music.source === 'licensed';
        if (fromRef) a.currentTime = music.start || 0;
        const setIcon = playing => { btn.classList.toggle('playing', playing); btn.setAttribute('aria-pressed', String(playing)); };
        const timer = fromRef ? setTimeout(() => a.pause(), (music.length || 30) * 1000) : null;
        a.onended = a.onpause = () => { clearTimeout(timer); setIcon(false); if (postPlaying && postPlaying.a === a) postPlaying = null; };
        setIcon(true);
        postPlaying = { btn, a };
        player = { a, stop: () => { a.onpause = a.onended = null; a.pause(); clearTimeout(timer); setIcon(false); postPlaying = null; } };
        try { await a.play(); } catch (e) { setIcon(false); app.showToast('Couldn’t play that audio'); }
    }

    window.diaryAudioLib = { open, playPost, stop: stopAll, catalogue, renderCordial, wavFrom, coverHTML, fetchAudio, categories: CATEGORIES };
});
