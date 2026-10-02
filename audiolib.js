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
            const table = cfg.audioCatalogTable || 'diary_sound_catalog';
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
            category: [...cat.map(c => String(c).trim().toLowerCase()).filter(Boolean), ...flags], source: 'licensed',
            licenseUrl: t.licenseUrl || t.license_url || null, licenseName: t.licenseName || t.license_name || null, provider: t.provider || null, shareurl: t.shareurl || null
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

    // ---------- The picker: a sheet with search, For you / Trending / Original audio / Saved, genres and a list ----------
    // Tap a sound to hear it and choose the part; "Use sound" hands it back. Counts ("N posts") and Trending come
    // from the server (diary_sound_usage / diary_sound_trending); saved sounds live in diary_saved_sounds, or on this
    // device until that table exists.
    const dlg = document.createElement('dialog');
    dlg.className = 'al-dlg';
    dlg.setAttribute('aria-labelledby', 'al-h');
    document.body.append(dlg);
    let P = null;
    const TABS = [['foryou', 'For you'], ['trending', 'Trending'], ['original', 'Original audio'], ['saved', 'Saved'], ['gospel', 'Gospel'], ['afrobeats', 'Afrobeats'], ['afropop', 'Afropop'], ['highlife', 'Highlife'], ['amapiano', 'Amapiano']];
    const GENRES = new Set(['gospel', 'afrobeats', 'afropop', 'highlife', 'amapiano']);
    const sb = () => window.diarySocial && window.diarySocial.internals && window.diarySocial.internals.client;
    const compact = n => (n >= 1e6 ? `${(n / 1e6).toFixed(1).replace(/\.0$/, '')}M` : n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1).replace(/\.0$/, '')}K` : String(n));

    // The sound record a post or reel stores. Older posts saved id / cover / start / length only; the aliases
    // (audioId, coverArt, audioUrl, genre, startTime, endTime, duration, createdAt) are filled in from those.
    function record(m) {
        if (!m || typeof m !== 'object') return null;
        const start = Number(m.startTime != null ? m.startTime : m.start) || 0;
        const length = Number(m.length != null ? m.length : m.duration) || 30;
        return {
            ...m,
            id: m.id || m.audioId, audioId: m.audioId || m.id,
            cover: m.cover || m.coverArt || null, coverArt: m.coverArt || m.cover || null,
            audioUrl: m.audioUrl || m.src || null,
            genre: m.genre || m.category || null, category: m.category || m.genre || null,
            start, startTime: start, length, duration: length, endTime: start + length
        };
    }
    // A post's sound back as a picker track, so "Use this sound" can start from it
    function trackFromMusic(m) {
        m = record(m);
        if (!m) return null;
        const own = CORDIAL.find(t => t.id === m.audioId);
        if (own) return own;
        if (!m.src) return null;
        return {
            id: m.audioId, title: m.title, artist: m.artist, cover: m.cover, preview: m.src, src: m.src,
            duration: Number(m.trackDuration) || Math.max(m.endTime, 30), category: m.genre ? [String(m.genre).toLowerCase()] : [], source: 'licensed',
            licenseUrl: m.licenseUrl || null, licenseName: m.licenseName || null, shareurl: m.shareurl || null, provider: m.provider || null
        };
    }
    // What a saved sound keeps (enough to list it and play it again)
    const savedRecord = t => ({
        id: t.id, audioId: t.id, title: t.title, artist: t.artist, cover: t.cover || null, style: t.style || null, category: catLabel(t) || null,
        source: t.source, trackDuration: Math.round(t.duration) || null, start: 0, length: 30,
        ...(t.src ? { src: t.src, audioUrl: t.src } : {}),
        ...(t.licenseUrl ? { licenseUrl: t.licenseUrl, licenseName: t.licenseName, shareurl: t.shareurl, provider: t.provider } : {})
    });

    // ---------- Usage counts, Trending and Saved (server first, device fallback) ----------
    const usage = new Map();
    let usageOff = false;
    async function fetchUsage(ids) {
        const c = sb();
        const want = [...new Set(ids)].filter(id => !usage.has(id)).slice(0, 100);
        if (usageOff || !c || !want.length) return false;
        const { data, error } = await c.rpc('diary_sound_usage', { p_ids: want });
        if (error) { usageOff = true; return false; }
        want.forEach(id => usage.set(id, 0));
        (data || []).forEach(r => usage.set(r.audio_id, r.uses));
        return true;
    }
    let trendingCache = null;
    async function fetchTrending() {
        if (trendingCache) return trendingCache;
        const c = sb();
        let list = [];
        if (c) {
            const { data, error } = await c.rpc('diary_sound_trending', { p_limit: 30 });
            if (!error) list = (data || []).map(r => { usage.set(r.audio_id, r.uses); return trackFromMusic({ ...r.music, audioId: r.audio_id }); }).filter(Boolean);
        }
        trendingCache = list.map(t => ({ ...t, hot: true }));
        return trendingCache;
    }
    const SAVED_KEY = 'cordial-saved-sounds';
    const saved = { list: null, server: true };
    const readLocal = () => { try { return JSON.parse(localStorage.getItem(SAVED_KEY) || '[]'); } catch (e) { return []; } };
    const writeLocal = list => { try { localStorage.setItem(SAVED_KEY, JSON.stringify(list.slice(0, 200))); } catch (e) {} };
    async function loadSaved() {
        if (saved.list) return saved.list;
        const c = sb();
        let rows = null;
        if (c) {
            const { data, error } = await c.from('diary_saved_sounds').select('audio_id, music').order('created_at', { ascending: false }).limit(200);
            if (!error) rows = (data || []).map(r => ({ ...r.music, audioId: r.audio_id }));
        }
        saved.server = !!rows;
        saved.list = rows || readLocal();
        return saved.list;
    }
    const isSaved = id => !!(saved.list && saved.list.some(m => (m.audioId || m.id) === id));
    async function toggleSave(t) {
        await loadSaved();
        const on = isSaved(t.id);
        const rec = savedRecord(t);
        saved.list = on ? saved.list.filter(m => (m.audioId || m.id) !== t.id) : [rec, ...saved.list];
        if (saved.server) {
            const c = sb();
            const { error } = on
                ? await c.from('diary_saved_sounds').delete().eq('audio_id', t.id)
                : await c.from('diary_saved_sounds').insert({ audio_id: t.id, music: rec });
            if (error) { saved.server = false; writeLocal(saved.list); }
        } else writeLocal(saved.list);
        app.showToast(on ? 'Removed from Saved' : 'Saved — find it under Saved');
    }

    // ---------- Open / close ----------
    function open(opts = {}) {
        return new Promise(async resolve => {
            stopAll();
            P = { tracks: CORDIAL, remote: [], loadingRemote: false, tab: 'foryou', q: '', sel: null, start: 0, length: 30, resolve, playing: null, own: opts.allowOwn !== false, trending: null };
            const pre = opts.track ? trackFromMusic(opts.track) : null;
            if (pre) {
                P.sel = pre;
                P.length = Math.min(30, pre.duration);
                P.start = Math.max(0, Math.min(Number(opts.track.start) || 0, pre.duration - P.length));
                paintEdit();
            } else paintBrowse();
            if (!dlg.open) dlg.showModal();
            dlg.classList.remove('leaving');
            loadSaved().then(() => { if (P && !P.sel && P.tab === 'saved') paintBrowse(); });
            P.tracks = await catalogue();
            if (P && !P.sel) { paintBrowse(); refreshRemote(); }
        });
    }
    function finish(value) {
        stopAll();
        stopHead();
        const r = P && P.resolve;
        P = null;
        if (dlg.open) dlg.close();
        dlg.style.transform = '';
        if (r) r(value);
    }
    dlg.addEventListener('close', () => { if (P) finish(null); });
    dlg.addEventListener('click', e => { if (e.target === dlg) finish(null); }); // tap above the sheet

    // ---------- Lists ----------
    const matches = (t, q) => !q || `${t.title} ${t.artist} ${t.category.join(' ')}`.toLowerCase().includes(q);
    function listFor() {
        const q = P.q.trim().toLowerCase();
        const tab = P.tab;
        let local;
        if (tab === 'saved') return (saved.list || []).map(trackFromMusic).filter(Boolean).filter(t => matches(t, q));
        if (tab === 'original') return CORDIAL.filter(t => matches(t, q));
        if (tab === 'trending') local = [...(P.trending || []), ...P.tracks.filter(t => t.category.includes('trending'))];
        else if (GENRES.has(tab)) local = P.tracks.filter(t => t.category.includes(tab));
        else local = P.tracks;
        local = local.filter(t => matches(t, q));
        const seen = new Set();
        return [...(tab === 'trending' ? local : []), ...P.remote, ...local].filter(t => !seen.has(t.id) && seen.add(t.id));
    }
    let remoteTimer = null;
    function refreshRemote(delay = 0) {
        clearTimeout(remoteTimer);
        if (!P) return;
        const tab = P.tab;
        if (tab === 'trending' && !P.trending) fetchTrending().then(list => { if (P) { P.trending = list; if (!P.sel && P.tab === 'trending') paintBrowse(document.activeElement && document.activeElement.id === 'al-q'); } });
        if (tab === 'original' || tab === 'saved') { P.remote = []; P.loadingRemote = false; return; }
        const want = { cat: tab === 'foryou' ? 'all' : tab, q: P.q.trim() };
        P.loadingRemote = remote.ready !== false;
        remoteTimer = setTimeout(async () => {
            const list = await remoteTracks(want.cat, want.q);
            if (!P || (P.tab === 'foryou' ? 'all' : P.tab) !== want.cat || P.q.trim() !== want.q) return;
            P.remote = list;
            P.loadingRemote = false;
            if (!P.sel) paintBrowse(document.activeElement && document.activeElement.id === 'al-q');
        }, delay);
    }
    function rowHTML(t) {
        const n = usage.get(t.id);
        const meta = [esc(t.artist), n ? `${compact(n)} ${n === 1 ? 'post' : 'posts'}` : '', fmt(t.duration)].filter(Boolean).join(' · ');
        const on = isSaved(t.id);
        return `
            <li class="al-row">
                <button type="button" class="al-pick" data-al="pick" data-id="${esc(t.id)}">${coverHTML(t)}<span class="al-text"><strong>${esc(t.title)}</strong><small>${t.hot || t.category.includes('trending') ? `<svg class="i al-up" aria-label="Trending"><use href="#i-trend"/></svg>` : ''}${meta}${t.licenseName ? ` · <span class="al-lic">${esc(t.licenseName)}</span>` : ''}</small></span></button>
                <button type="button" class="al-save" data-al="save" data-id="${esc(t.id)}" aria-pressed="${on}" aria-label="${on ? 'Remove from Saved' : 'Save'} ${esc(t.title)}">${ic(on ? 'i-bookmark-fill' : 'i-bookmark')}</button>
            </li>`;
    }
    function featuredHTML(list) {
        const top = list.filter(t => t.cover).slice(0, 4);
        const pick = top.length >= 2 ? top : list.slice(0, 4);
        if (pick.length < 2) return '';
        return `
            <div class="al-feat" aria-label="Featured sounds">
                <div class="al-feat-track" id="al-feat">${pick.map(t => `
                    <button type="button" class="al-feat-item" data-al="pick" data-id="${esc(t.id)}">
                        ${t.cover ? `<img class="al-feat-bg" src="${esc(t.cover)}" alt="" referrerpolicy="no-referrer">` : `<span class="al-feat-bg gen" style="--c1:${(STYLES[t.style] || STYLES.afrobeats).colors[0]};--c2:${(STYLES[t.style] || STYLES.afrobeats).colors[1]}"></span>`}
                        ${coverHTML(t, true)}
                        <span class="al-text"><strong>${esc(t.title)}</strong><small>${esc(t.artist)}</small></span>
                    </button>`).join('')}</div>
                <div class="al-dots" aria-hidden="true">${pick.map((_, i) => `<i${i === 0 ? ' class="on"' : ''}></i>`).join('')}</div>
            </div>`;
    }
    function paintBrowse(keepFocus = false) {
        if (!P) return;
        const list = listFor();
        const q = P.q.trim();
        const scrollTop = (dlg.querySelector('.al-list-wrap') || {}).scrollTop || 0;
        const tabsLeft = (dlg.querySelector('.al-cats') || {}).scrollLeft || 0;
        const ownRows = P.tab === 'original' && P.own && !q ? `
            <li class="al-row own"><button type="button" class="al-pick" data-al="own" data-kind="record"><span class="al-cover own">${ic('i-mic')}</span><span class="al-text"><strong>Record audio</strong><small>Your voice or a sound around you</small></span></button></li>
            <li class="al-row own"><button type="button" class="al-pick" data-al="own" data-kind="file"><span class="al-cover own">${ic('i-music')}</span><span class="al-text"><strong>Use an audio file</strong><small>A song or recording you have the rights to</small></span></button></li>
            <li class="al-label">Cordial Sounds — original instrumentals</li>` : '';
        const empty = P.tab === 'saved' ? '<li class="al-empty">Tap the bookmark on a sound to keep it here.</li>' : '<li class="al-empty">No sounds match that yet.</li>';
        dlg.innerHTML = `
            <div class="al-sheet">
                <div class="al-grab" data-al-drag aria-hidden="true"><i></i></div>
                <h3 id="al-h" class="sr-only">Add sound</h3>
                <label class="search al-search">${ic('i-search')}<input type="search" id="al-q" placeholder="Search songs and artists" value="${esc(P.q)}" autocomplete="off" enterkeyhint="search" aria-label="Search sounds"></label>
                <div class="al-cats" role="tablist" aria-label="Sound categories">${TABS.map(([k, l]) => `<button type="button" role="tab" class="al-cat" aria-selected="${P.tab === k}" data-al="tab" data-k="${k}">${l}</button>`).join('')}</div>
                <div class="al-list-wrap">
                    ${P.tab === 'foryou' && !q ? featuredHTML(list) : ''}
                    <ul class="al-list">${ownRows}${list.length ? list.map(rowHTML).join('') : (P.loadingRemote || (P.tab === 'trending' && !P.trending) || (P.tab === 'saved' && !saved.list) ? '' : empty)}${P.loadingRemote ? '<li class="al-loading" aria-live="polite"><span class="al-spin" aria-hidden="true"></span>Finding more music…</li>' : ''}</ul>
                    <p class="al-note">${P.tab === 'original' ? 'Cordial Sounds are original instrumentals made for Cordial — free to use.' : 'Licensed music is credited to the artist on your post. Cordial never stores copies of licensed songs.'}</p>
                </div>
            </div>`;
        const wrap = dlg.querySelector('.al-list-wrap');
        if (wrap && !keepFocus) wrap.scrollTop = scrollTop;
        dlg.querySelector('.al-cats').scrollLeft = tabsLeft;
        if (keepFocus) { const qe = dlg.querySelector('#al-q'); qe.focus(); qe.setSelectionRange(qe.value.length, qe.value.length); }
        const feat = dlg.querySelector('#al-feat');
        if (feat) feat.addEventListener('scroll', () => {
            const i = Math.round(feat.scrollLeft / Math.max(1, feat.clientWidth));
            dlg.querySelectorAll('.al-dots i').forEach((d, k) => d.classList.toggle('on', k === i));
        }, { passive: true });
        // Counts for what's on screen
        fetchUsage(list.slice(0, 60).map(t => t.id)).then(changed => { if (changed && P && !P.sel) paintBrowse(document.activeElement && document.activeElement.id === 'al-q'); });
    }

    // ---------- Choosing the part ----------
    const BARS = 64;
    const barsFor = t => {
        let seed = 0;
        for (const ch of String(t.id)) seed = (seed * 31 + ch.charCodeAt(0)) | 0;
        return Array.from({ length: BARS }, (_, i) => 0.22 + 0.78 * Math.abs(Math.sin(i * 0.43 + seed)) * (0.45 + 0.55 * hash(seed, i)));
    };
    function paintEdit() {
        const t = P.sel;
        const lens = [15, 30, 60].filter(n => n <= t.duration || n === 15);
        P.length = Math.min(P.length, Math.min(60, t.duration));
        P.start = Math.max(0, Math.min(P.start, t.duration - P.length));
        dlg.innerHTML = `
            <div class="al-sheet edit">
                <div class="al-grab" data-al-drag aria-hidden="true"><i></i></div>
                <header class="al-head"><button type="button" class="icon-btn" data-al="back" aria-label="Back to the library">${ic('i-chevron-left')}</button><h3 id="al-h">Choose the part</h3><span class="al-head-sp"></span></header>
                <div class="al-now">${coverHTML(t, true)}<span class="al-text"><strong>${esc(t.title)}</strong><small>${esc(t.artist)}${catLabel(t) ? ` · ${esc(catLabel(t))}` : ''} · ${fmt(t.duration)}</small></span>
                    <button type="button" class="al-save" data-al="save" data-id="${esc(t.id)}" aria-pressed="${isSaved(t.id)}" aria-label="${isSaved(t.id) ? 'Remove from Saved' : 'Save'}">${ic(isSaved(t.id) ? 'i-bookmark-fill' : 'i-bookmark')}</button></div>
                <p class="al-times" aria-live="polite"><b id="al-t0">${fmt(P.start)}</b><span aria-hidden="true"></span><b id="al-t1">${fmt(P.start + P.length)}</b></p>
                <div class="al-track" id="al-track">
                    <div class="al-bars" aria-hidden="true">${barsFor(t).map(h => `<i style="--h:${h.toFixed(2)}"></i>`).join('')}</div>
                    <div class="al-win" id="al-win" role="slider" tabindex="0" aria-label="Part of the song to use" aria-valuemin="0" aria-valuemax="${Math.floor(t.duration - P.length)}" aria-valuenow="${Math.round(P.start)}" aria-valuetext="${fmt(P.start)} to ${fmt(P.start + P.length)}"><i class="al-ph" id="al-ph"></i></div>
                </div>
                <p class="al-hint">Drag the box to choose the part you want</p>
                <div class="al-seg" role="radiogroup" aria-label="Length">${lens.map(n => `<button type="button" role="radio" aria-checked="${P.length === n}" data-al="len" data-n="${n}">${n}s</button>`).join('')}</div>
                <footer class="al-actions">
                    <button type="button" class="al-btn" data-al="back">Cancel</button>
                    <button type="button" class="al-btn" data-al="preview-sel" aria-pressed="${P.playing === 'sel'}">${ic(P.playing === 'sel' ? 'i-pause' : 'i-play')}<span>${P.playing === 'sel' ? 'Stop' : 'Preview'}</span></button>
                    <button type="button" class="al-btn primary" data-al="use">${ic('i-check')}<span>Use sound</span></button>
                </footer>
            </div>`;
        placeWindow();
    }
    function placeWindow() {
        const t = P && P.sel;
        const win = dlg.querySelector('#al-win');
        if (!t || !win) return;
        const left = (P.start / t.duration) * 100;
        const width = (P.length / t.duration) * 100;
        win.style.left = `${left}%`;
        win.style.width = `${Math.max(width, 6)}%`;
        dlg.querySelectorAll('.al-bars i').forEach((b, i) => {
            const at = ((i + 0.5) / BARS) * 100;
            b.classList.toggle('in', at >= left && at <= left + Math.max(width, 6));
        });
        dlg.querySelector('#al-t0').textContent = fmt(P.start);
        dlg.querySelector('#al-t1').textContent = fmt(Math.min(t.duration, P.start + P.length));
        win.setAttribute('aria-valuenow', String(Math.round(P.start)));
        win.setAttribute('aria-valuetext', `${fmt(P.start)} to ${fmt(P.start + P.length)}`);
    }
    // The playhead walks across the window while the part plays
    let headRaf = 0;
    function stopHead() { cancelAnimationFrame(headRaf); const ph = dlg.querySelector('#al-ph'); if (ph) ph.style.left = '0%'; }
    function runHead() {
        stopHead();
        const t0 = performance.now();
        const len = Math.min(P.length, P.sel.source === 'cordial' ? 20 : P.length);
        const tick = () => {
            const ph = dlg.querySelector('#al-ph');
            if (!P || P.playing !== 'sel' || !ph) return;
            ph.style.left = `${Math.min(100, ((performance.now() - t0) / 1000 / len) * 100)}%`;
            headRaf = requestAnimationFrame(tick);
        };
        headRaf = requestAnimationFrame(tick);
    }
    function startSelPreview() {
        P.playing = 'sel';
        playTrack(P.sel, P.start, P.length, 0.85, () => { if (P && P.playing === 'sel') { P.playing = null; stopHead(); if (P.sel) repaintPlay(); } });
        repaintPlay();
        runHead();
    }
    function repaintPlay() {
        const b = dlg.querySelector('[data-al="preview-sel"]');
        if (!b) return;
        const on = P.playing === 'sel';
        b.setAttribute('aria-pressed', String(on));
        b.innerHTML = `${ic(on ? 'i-pause' : 'i-play')}<span>${on ? 'Stop' : 'Preview'}</span>`;
    }
    // Drag the window along the song (or tap the timeline to jump there)
    let drag = null;
    dlg.addEventListener('pointerdown', e => {
        const track = e.target.closest('#al-track');
        if (!track || !P || !P.sel) return;
        const rect = track.getBoundingClientRect();
        const win = dlg.querySelector('#al-win');
        const wr = win.getBoundingClientRect();
        const onWin = e.clientX >= wr.left && e.clientX <= wr.right;
        drag = { rect, offset: onWin ? e.clientX - wr.left : wr.width / 2, id: e.pointerId };
        track.setPointerCapture(e.pointerId);
        track.classList.add('dragging');
        moveTo(e.clientX);
        e.preventDefault();
    });
    function moveTo(x) {
        const t = P.sel;
        const f = (x - drag.offset - drag.rect.left) / drag.rect.width;
        P.start = Math.round(Math.max(0, Math.min(t.duration - P.length, f * t.duration)));
        placeWindow();
    }
    dlg.addEventListener('pointermove', e => { if (drag && e.pointerId === drag.id && P && P.sel) moveTo(e.clientX); });
    const endDrag = e => {
        if (!drag || e.pointerId !== drag.id) return;
        drag = null;
        const track = dlg.querySelector('#al-track');
        if (track) track.classList.remove('dragging');
        if (P && P.sel) startSelPreview(); // hear the part you landed on
    };
    dlg.addEventListener('pointerup', endDrag);
    dlg.addEventListener('pointercancel', endDrag);
    dlg.addEventListener('keydown', e => {
        if (e.target.id !== 'al-win' || !P || !P.sel) return;
        const step = { ArrowLeft: -1, ArrowRight: 1, PageDown: -10, PageUp: 10 }[e.key];
        if (e.key === 'Home' || e.key === 'End') P.start = e.key === 'Home' ? 0 : P.sel.duration - P.length;
        else if (step) P.start = Math.max(0, Math.min(P.sel.duration - P.length, P.start + step));
        else return;
        e.preventDefault();
        placeWindow();
    });
    dlg.addEventListener('keyup', e => { if (e.target.id === 'al-win' && P && P.playing === 'sel' && /Arrow|Page|Home|End/.test(e.key)) startSelPreview(); });

    // Pull the sheet down by its handle to close it
    let pull = null;
    dlg.addEventListener('pointerdown', e => {
        if (!e.target.closest('[data-al-drag], .al-head h3')) return;
        pull = { y: e.clientY, t: performance.now(), id: e.pointerId, dy: 0 };
        e.target.setPointerCapture(e.pointerId);
    });
    dlg.addEventListener('pointermove', e => {
        if (!pull || e.pointerId !== pull.id) return;
        pull.dy = Math.max(0, e.clientY - pull.y);
        dlg.style.transform = `translateY(${pull.dy}px)`;
    });
    const endPull = e => {
        if (!pull || e.pointerId !== pull.id) return;
        const v = pull.dy / Math.max(1, performance.now() - pull.t);
        const close = pull.dy > 140 || v > 0.6;
        pull = null;
        dlg.style.transition = 'transform 220ms cubic-bezier(.2,.8,.2,1)';
        dlg.style.transform = close ? 'translateY(100%)' : '';
        setTimeout(() => { dlg.style.transition = ''; if (close) finish(null); }, 230);
    };
    dlg.addEventListener('pointerup', endPull);
    dlg.addEventListener('pointercancel', endPull);

    dlg.addEventListener('input', e => {
        if (!P || e.target.id !== 'al-q') return;
        P.q = e.target.value;
        P.remote = [];
        paintBrowse(true);
        refreshRemote(450);
    });
    const byId = id => (P.trending || []).find(t => t.id === id) || P.remote.find(t => t.id === id) || P.tracks.find(t => t.id === id)
        || (saved.list || []).map(trackFromMusic).filter(Boolean).find(t => t.id === id);
    dlg.addEventListener('click', async e => {
        const el = e.target.closest('[data-al]');
        if (!el || !P) return;
        const what = el.dataset.al;
        if (what === 'close') finish(null);
        else if (what === 'tab') {
            stopAll();
            P.playing = null;
            P.tab = el.dataset.k;
            P.remote = [];
            refreshRemote();
            paintBrowse();
            el.scrollIntoView && dlg.querySelector(`[data-al="tab"][data-k="${P.tab}"]`).scrollIntoView({ inline: 'nearest', block: 'nearest' });
        } else if (what === 'save') {
            const t = (P.sel && P.sel.id === el.dataset.id) ? P.sel : byId(el.dataset.id);
            if (!t) return;
            await toggleSave(t);
            if (!P) return;
            if (P.sel) { const on = isSaved(t.id); el.setAttribute('aria-pressed', String(on)); el.innerHTML = ic(on ? 'i-bookmark-fill' : 'i-bookmark'); }
            else paintBrowse();
        } else if (what === 'own') {
            const I = window.diarySocial && window.diarySocial.internals;
            if (!I || !I.ownAudio) return;
            const r = await I.ownAudio(el.dataset.kind);
            if (r && P) finish(r);
        } else if (what === 'pick') {
            stopAll();
            P.sel = byId(el.dataset.id);
            if (!P.sel) return;
            P.start = 0;
            P.length = Math.min(30, P.sel.duration);
            paintEdit();
            startSelPreview(); // tapping a sound plays it, like choosing a song should
        } else if (what === 'back') {
            stopAll(); stopHead(); P.playing = null; P.sel = null; paintBrowse(); if (!P.remote.length) refreshRemote();
        } else if (what === 'len') {
            P.length = Number(el.dataset.n);
            const playing = P.playing === 'sel';
            stopAll(); stopHead();
            paintEdit();
            if (playing) startSelPreview();
        } else if (what === 'preview-sel') {
            if (P.playing === 'sel') { stopAll(); stopHead(); P.playing = null; repaintPlay(); }
            else startSelPreview();
        } else if (what === 'use') {
            stopAll(); stopHead();
            const t = P.sel;
            el.disabled = true;
            el.innerHTML = '<span>Preparing…</span>';
            const music = record({ id: t.id, title: t.title, artist: t.artist, cover: t.cover || null, category: catLabel(t) || null, source: t.source, style: t.style || null, start: Math.round(P.start), length: P.length, volume: 0.8, trackDuration: Math.round(t.duration) || null, createdAt: new Date().toISOString(), ...(t.licenseUrl ? { licenseUrl: t.licenseUrl, licenseName: t.licenseName, shareurl: t.shareurl, provider: t.provider } : {}) });
            try {
                if (t.source === 'cordial') {
                    // Original instrumentals are rendered into a short clip that travels with the post (its volume is set on playback)
                    const buf = await renderCordial(t, P.start, P.length, 1);
                    const file = new File([wavFrom(buf)], `${t.title}.wav`, { type: 'audio/wav' });
                    finish({ file, duration: P.length, name: `${t.title} · ${t.artist}`, music });
                } else {
                    // Licensed music is streamed from its source, never copied
                    finish({ file: null, duration: P.length, name: `${t.title} · ${t.artist}`, music: { ...music, src: t.src, audioUrl: t.src } });
                }
            } catch (err) {
                el.disabled = false;
                el.innerHTML = `${ic('i-check')}<span>Use sound</span>`;
                app.showToast('Couldn’t prepare that sound on this device');
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
        const now = { btn, a, key: (btn.closest('[data-post]') || {}).dataset ? btn.closest('[data-post]').dataset.post : null };
        const setIcon = playing => { now.btn.classList.toggle('playing', playing); now.btn.setAttribute('aria-pressed', String(playing)); };
        const timer = fromRef ? setTimeout(() => a.pause(), (music.length || 30) * 1000) : null;
        a.onended = a.onpause = () => { clearTimeout(timer); setIcon(false); if (postPlaying && postPlaying.a === a) postPlaying = null; };
        setIcon(true);
        postPlaying = now;
        player = { a, stop: () => { a.onpause = a.onended = null; a.pause(); clearTimeout(timer); setIcon(false); postPlaying = null; } };
        try { await a.play(); } catch (e) { setIcon(false); app.showToast('Couldn’t play that audio'); }
    }
    // After the page redraws, the playing post's new button takes over (the sound carries on)
    function adopt(rootEl) {
        if (!postPlaying || postPlaying.btn.isConnected || !postPlaying.key) return;
        const b = rootEl.querySelector(`[data-post="${CSS.escape(postPlaying.key)}"] :is(.media-sound, .pm-play)`);
        if (!b) return;
        postPlaying.btn = b;
        b.classList.add('playing');
        b.setAttribute('aria-pressed', 'true');
    }

    window.diaryAudioLib = { open, playPost, stop: stopAll, catalogue, renderCordial, wavFrom, coverHTML, fetchAudio, record, trackFromMusic, adopt, categories: CATEGORIES };
});
