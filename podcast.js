// Note → Podcast: turn a note into a podcast episode.
//  • Your own voice — read from a scrolling teleprompter in a recording booth, with a live level meter and
//    chapter marks — or natural AI voices (one narrator, or two hosts in conversation; clearly labelled AI).
//  • Podcast equipment, done in the browser: a microphone choice (broadcast, studio condenser, warm radio,
//    natural — each its own EQ), noise reduction, a broadcast compressor and limiter, a room (dry studio,
//    small room, hall), and an intro, outro and music bed that dips under the voice.
//  • The mix is rendered offline (Web Audio), loudness-matched, with chapters from the note's headings;
//    save it to the note, download it, or post it to the Feed.
document.addEventListener('DOMContentLoaded', () => {
    const app = window.diaryApp;
    if (!app) return;
    const social = window.diarySocial;
    const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const ic = (id, cls = '') => `<svg class="i${cls ? ` ${cls}` : ''}" aria-hidden="true"><use href="#${id}"/></svg>`;
    const toast = m => app.showToast(m);
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const fmt = s => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

    // ---------- The note as a script ----------
    function sections(note) {
        const html = String(note.html || '');
        const heads = new Set([...html.matchAll(/<h[1-3][^>]*>(.*?)<\/h[1-3]>/gi)].map(m => m[1].replace(/<[^>]+>/g, '').trim()).filter(Boolean));
        const out = [];
        let cur = { title: '', lines: [] };
        for (const raw of String(note.text || '').split('\n')) {
            const l = raw.trim();
            if (!l) continue;
            if (heads.has(l)) { if (cur.lines.length || cur.title) out.push(cur); cur = { title: l, lines: [] }; }
            else cur.lines.push(l.replace(/^[-•*]\s*/, ''));
        }
        if (cur.lines.length || cur.title) out.push(cur);
        return out.filter(sc => sc.lines.length);
    }
    const showName = () => { const n = social && social.internals && social.internals.state.profile && social.internals.state.profile.display_name; return n ? `${String(n).split(' ')[0]}’s Notes` : 'My Notes'; };
    function soloScript(note, title) {
        const secs = sections(note);
        const parts = [`Hi, and welcome to ${showName()}. In this episode: ${title}.`];
        secs.forEach((sc, i) => parts.push(`${sc.title ? `${i ? 'Next, ' : ''}${sc.title}.\n` : ''}${sc.lines.join('\n')}`));
        parts.push(`That’s it for ${title}. Thanks for listening — see you in the next episode.`);
        return parts.join('\n\n');
    }

    // ---------- Equipment ----------
    const MICS = {
        broadcast: { name: 'Broadcast dynamic', hint: 'Rich, close, radio-ready', eq: [['highpass', 90, 0, 0.7], ['peaking', 250, -3, 1], ['peaking', 3500, 4, 0.9], ['highshelf', 10000, 1, 0]] },
        condenser: { name: 'Studio condenser', hint: 'Clear and airy', eq: [['highpass', 70, 0, 0.7], ['peaking', 200, -1.5, 1], ['peaking', 5000, 2, 1], ['highshelf', 9000, 4, 0]] },
        radio: { name: 'Warm radio', hint: 'Deep and cosy', eq: [['highpass', 60, 0, 0.7], ['lowshelf', 150, 4, 0], ['peaking', 3000, 2, 1], ['highshelf', 8000, -3, 0]], warmth: true },
        natural: { name: 'Natural', hint: 'Just your voice', eq: [['highpass', 70, 0, 0.7]] }
    };
    const ROOMS = { dry: ['Dry studio', 0, 0], small: ['Small room', 0.5, 0.14], hall: ['Hall', 2.2, 0.2] };
    const MUSIC = { chill: 'Chill', upbeat: 'Upbeat', ambient: 'Ambient', none: 'No music' };
    const VOICES = [['kore', 'Kore', 'warm'], ['aoede', 'Aoede', 'bright'], ['charon', 'Charon', 'deep'], ['puck', 'Puck', 'upbeat']];

    // ---------- Natural voices (Gemini, via /api/tts) ----------
    let ttsReady = null;
    async function voicesReady() {
        if (ttsReady !== null) return ttsReady;
        try { ttsReady = !!(await (await fetch('/api/tts', { cache: 'no-store' })).json()).ready; } catch (e) { ttsReady = false; }
        return ttsReady;
    }
    async function speak(payload) {
        const token = social && social.accessToken ? await social.accessToken() : null;
        if (!token) throw new Error('Please sign in to use AI voices');
        const res = await fetch('/api/tts', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify(payload) });
        const buf = await res.arrayBuffer();
        const head = String.fromCharCode(...new Uint8Array(buf.slice(0, 4)));
        if (head !== 'RIFF') { let msg = 'Couldn’t make the voice'; try { msg = JSON.parse(new TextDecoder().decode(buf)).error || msg; } catch (e) { /* ignore */ } throw new Error(msg); }
        return buf;
    }
    // Split text into pieces the voice service takes in one go, keeping paragraphs together
    function chunks(text, max = 2400) {
        const out = [];
        let buf = '';
        for (const p of text.split(/\n{2,}/)) {
            if ((buf + '\n\n' + p).length > max && buf) { out.push(buf); buf = p; } else buf = buf ? `${buf}\n\n${p}` : p;
        }
        if (buf) out.push(buf);
        return out;
    }

    // ---------- The mixing desk (offline) ----------
    const RATE = 44100;
    function impulse(ctx, seconds) {
        const len = Math.max(1, Math.floor(ctx.sampleRate * seconds));
        const buf = ctx.createBuffer(2, len, ctx.sampleRate);
        for (let ch = 0; ch < 2; ch++) { const d = buf.getChannelData(ch); for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3); }
        return buf;
    }
    function music(ctx, out, start, dur, style) {
        const SETS = {
            chill: { chords: [[57, 60, 64], [53, 57, 60], [55, 59, 62], [52, 55, 59]], bar: 3.2, wave: 'sine' },
            upbeat: { chords: [[60, 64, 67], [55, 59, 62], [57, 60, 64], [53, 57, 60]], bar: 2, wave: 'triangle' },
            ambient: { chords: [[50, 57, 62], [46, 53, 58], [48, 55, 60], [45, 52, 57]], bar: 4.4, wave: 'sine' }
        };
        const S = SETS[style];
        if (!S) return;
        const hz = n => 440 * 2 ** ((n - 69) / 12);
        for (let t = start, i = 0; t < start + dur; t += S.bar, i++) {
            const ch = S.chords[i % 4];
            ch.forEach(n => {
                const o = ctx.createOscillator(), g = ctx.createGain();
                o.type = S.wave; o.frequency.value = hz(n); o.detune.value = (Math.random() - 0.5) * 8;
                g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(0.045, t + 0.4); g.gain.setValueAtTime(0.045, t + S.bar - 0.5); g.gain.linearRampToValueAtTime(0, t + S.bar + 0.1);
                o.connect(g).connect(out); o.start(t); o.stop(t + S.bar + 0.15);
            });
            const b = ctx.createOscillator(), bg = ctx.createGain();
            b.type = 'sine'; b.frequency.value = hz(ch[0] - 12);
            bg.gain.setValueAtTime(0, t); bg.gain.linearRampToValueAtTime(0.07, t + 0.05); bg.gain.exponentialRampToValueAtTime(0.001, t + S.bar);
            b.connect(bg).connect(out); b.start(t); b.stop(t + S.bar + 0.05);
            if (style === 'upbeat') for (let k = 0; k < 8; k++) { // a soft pluck arpeggio
                const at = t + k * S.bar / 8, p = ctx.createOscillator(), pg = ctx.createGain();
                p.type = 'square'; p.frequency.value = hz(ch[k % 3] + 12);
                pg.gain.setValueAtTime(0.012, at); pg.gain.exponentialRampToValueAtTime(0.0005, at + 0.22);
                p.connect(pg).connect(out); p.start(at); p.stop(at + 0.25);
            }
        }
    }
    async function mixEpisode(voice, set) {
        const INTRO = set.music !== 'none' ? 4 : 0.4, OUTRO = set.music !== 'none' ? 5 : 0.6;
        const total = INTRO + voice.duration + OUTRO;
        const ctx = new OfflineAudioContext(2, Math.ceil(total * RATE), RATE);
        // Voice chain: EQ (the mic) → warmth → compressor → limiter → room
        const src = ctx.createBufferSource();
        src.buffer = voice;
        let node = src;
        for (const [type, f, gain, q] of MICS[set.mic].eq) { const b = ctx.createBiquadFilter(); b.type = type; b.frequency.value = f; if (gain) b.gain.value = gain; if (q) b.Q.value = q; node.connect(b); node = b; }
        if (MICS[set.mic].warmth) { const ws = ctx.createWaveShaper(); const c = new Float32Array(1024); for (let i = 0; i < 1024; i++) { const x = i / 512 - 1; c[i] = Math.tanh(1.6 * x) / Math.tanh(1.6); } ws.curve = c; node.connect(ws); node = ws; }
        if (set.compressor) {
            const comp = ctx.createDynamicsCompressor(); comp.threshold.value = -24; comp.ratio.value = 4; comp.attack.value = 0.005; comp.release.value = 0.2; comp.knee.value = 6;
            const make = ctx.createGain(); make.gain.value = 1.8;
            node.connect(comp).connect(make); node = make;
        }
        const lim = ctx.createDynamicsCompressor(); lim.threshold.value = -3; lim.ratio.value = 20; lim.attack.value = 0.001; lim.release.value = 0.05; lim.knee.value = 0;
        node.connect(lim);
        const voiceBus = ctx.createGain(); voiceBus.gain.value = 1;
        lim.connect(voiceBus);
        const [, seconds, wet] = ROOMS[set.room];
        if (seconds) { const conv = ctx.createConvolver(); conv.buffer = impulse(ctx, seconds); const wg = ctx.createGain(); wg.gain.value = wet; lim.connect(conv).connect(wg).connect(ctx.destination); }
        voiceBus.connect(ctx.destination);
        src.start(INTRO);
        // Music: up for the intro, down (or out) under the voice, up again for the outro
        if (set.music !== 'none') {
            const bus = ctx.createGain();
            const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 5000;
            bus.connect(lp).connect(ctx.destination);
            const under = set.bed ? 0.16 : 0.0001;
            const g = bus.gain;
            g.setValueAtTime(0.0001, 0); g.exponentialRampToValueAtTime(0.9, 0.8);
            g.setValueAtTime(0.9, INTRO - 1.2); g.exponentialRampToValueAtTime(under, INTRO + 0.2);
            g.setValueAtTime(under, INTRO + voice.duration - 0.4); g.exponentialRampToValueAtTime(0.85, INTRO + voice.duration + 0.8);
            g.setValueAtTime(0.85, total - 2.2); g.exponentialRampToValueAtTime(0.0001, total);
            music(ctx, bus, 0, total, set.music);
        }
        const mixed = await ctx.startRendering();
        // Loudness: bring the peak to about -1 dBFS
        let peak = 0;
        for (let ch = 0; ch < mixed.numberOfChannels; ch++) { const d = mixed.getChannelData(ch); for (let i = 0; i < d.length; i += 3) peak = Math.max(peak, Math.abs(d[i])); }
        const gain = peak > 0 ? Math.min(4, 0.89 / peak) : 1;
        if (gain !== 1) for (let ch = 0; ch < mixed.numberOfChannels; ch++) { const d = mixed.getChannelData(ch); for (let i = 0; i < d.length; i++) d[i] *= gain; }
        return { buffer: mixed, offset: INTRO };
    }
    // A podcast-friendly file: mono 24 kHz, 16-bit WAV (small enough to post)
    function toWav(buffer) {
        const rate = 24000, ratio = buffer.sampleRate / rate;
        const len = Math.floor(buffer.length / ratio);
        const L = buffer.getChannelData(0), R = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : L;
        const out = new DataView(new ArrayBuffer(44 + len * 2));
        const str = (o, s) => { for (let i = 0; i < s.length; i++) out.setUint8(o + i, s.charCodeAt(i)); };
        str(0, 'RIFF'); out.setUint32(4, 36 + len * 2, true); str(8, 'WAVE'); str(12, 'fmt '); out.setUint32(16, 16, true); out.setUint16(20, 1, true); out.setUint16(22, 1, true);
        out.setUint32(24, rate, true); out.setUint32(28, rate * 2, true); out.setUint16(32, 2, true); out.setUint16(34, 16, true); str(36, 'data'); out.setUint32(40, len * 2, true);
        for (let i = 0; i < len; i++) { const j = Math.floor(i * ratio); const v = Math.max(-1, Math.min(1, (L[j] + R[j]) / 2)); out.setInt16(44 + i * 2, v < 0 ? v * 0x8000 : v * 0x7fff, true); }
        return new Blob([out.buffer], { type: 'audio/wav' });
    }
    async function decode(arrayBuffer) {
        const ctx = new (window.AudioContext || window.webkitAudioContext)();
        try { return await ctx.decodeAudioData(arrayBuffer.slice(0)); } finally { ctx.close().catch(() => {}); }
    }
    function join(buffers) {
        const rate = buffers[0].sampleRate;
        const gap = Math.floor(rate * 0.6);
        const len = buffers.reduce((a, b) => a + b.length, 0) + gap * (buffers.length - 1);
        const ctx = new OfflineAudioContext(1, Math.max(1, len), rate);
        const out = ctx.createBuffer(1, Math.max(1, len), rate);
        const d = out.getChannelData(0);
        let at = 0;
        const starts = [];
        buffers.forEach((b, i) => { starts.push(at / rate); d.set(b.getChannelData(0), at); at += b.length + (i < buffers.length - 1 ? gap : 0); });
        return { buffer: out, starts };
    }
    // A cover: the note's colour, a microphone, the title
    function cover(title, colour) {
        const c = document.createElement('canvas'); c.width = c.height = 600;
        const g = c.getContext('2d');
        const pal = { yellow: ['#f59e0b', '#7c2d12'], pink: ['#ec4899', '#831843'], blue: ['#3b82f6', '#1e3a8a'], green: ['#22c55e', '#14532d'], purple: ['#8b5cf6', '#3b0764'] }[colour] || ['#6366f1', '#1e1b4b'];
        const gr = g.createLinearGradient(0, 0, 600, 600); gr.addColorStop(0, pal[0]); gr.addColorStop(1, pal[1]); g.fillStyle = gr; g.fillRect(0, 0, 600, 600);
        g.fillStyle = 'rgba(255,255,255,0.08)'; for (let r = 80; r < 520; r += 60) { g.beginPath(); g.arc(470, 150, r, 0, Math.PI * 2); g.lineWidth = 2; g.strokeStyle = 'rgba(255,255,255,0.08)'; g.stroke(); }
        g.font = '150px serif'; g.fillText('🎙️', 400, 230);
        g.fillStyle = '#fff'; g.font = '800 30px system-ui, sans-serif'; g.fillText(showName().toUpperCase(), 44, 380);
        g.font = '800 54px system-ui, sans-serif';
        const words = String(title).split(/\s+/); let line = '', y = 450;
        for (const w of words) { if (g.measureText(`${line} ${w}`).width > 512 && line) { g.fillText(line, 44, y); line = w; y += 60; if (y > 570) break; } else line = line ? `${line} ${w}` : w; }
        if (y <= 570) g.fillText(line, 44, y);
        return c.toDataURL('image/jpeg', 0.85);
    }

    // ======================================================================
    // The studio
    // ======================================================================
    async function open(note, opts = {}) {
        if (!note || !String(note.text || '').trim()) return toast('Write something first — then turn it into a podcast');
        const title = note.title || String(note.text).split('\n').find(Boolean).slice(0, 80);
        const S = { voice: 'me', mic: 'broadcast', denoise: true, compressor: true, room: 'small', music: 'chill', bed: true, va: 'kore', vb: 'puck', title, script: soloScript(note, title), convo: '', result: null };
        const ready = await voicesReady();
        const dlg = document.createElement('dialog');
        dlg.className = 'gm pod';
        dlg.setAttribute('aria-label', 'Podcast studio');
        document.body.append(dlg);
        const seg = (name, val, label, sub = '', dis = false) => `<button type="button" class="pod-seg" data-set="${name}" data-val="${val}" aria-pressed="${S[name] === val}"${dis ? ' disabled' : ''}>${label}${sub ? `<small>${sub}</small>` : ''}</button>`;
        const paint = () => {
            const ai = S.voice !== 'me';
            dlg.innerHTML = `
            <div class="gm-card pod-card">
                <header class="gm-head"><button type="button" class="icon-btn" data-p="close" aria-label="Close">${ic('i-close')}</button>
                    <div class="gm-title"><strong>🎙️ Podcast studio</strong><small>Turn this note into an episode</small></div></header>
                <div class="gm-body pod-body">
                    <div class="pod-episode"><img class="pod-cover" src="${cover(S.title, note.color)}" alt="Episode cover"><div>
                        <label class="pod-field"><span>Episode title</span><input type="text" data-f="title" maxlength="100" value="${esc(S.title)}"></label>
                        <p class="pod-show">${esc(showName())} · Episode</p></div></div>

                    <p class="pod-label">Voice</p>
                    <div class="pod-segs three">
                        ${seg('voice', 'me', '🎙️ My voice', 'Record yourself')}
                        ${seg('voice', 'ai', '🗣️ AI narrator', ready ? 'Natural AI voice' : 'Not switched on yet', !ready)}
                        ${seg('voice', 'duo', '👥 AI hosts', ready ? 'Two AI voices chat' : 'Not switched on yet', !ready)}
                    </div>
                    ${!ready ? '<p class="pod-tip">AI voices switch on once a Gemini key is added to Cordial (the same key as the AI assistant). Your own voice works now.</p>' : ''}
                    ${S.voice === 'ai' ? `<div class="pod-voices">${VOICES.map(([k, n, d]) => `<button type="button" class="pod-chip" data-set="va" data-val="${k}" aria-pressed="${S.va === k}">${n}<small>${d}</small></button>`).join('')}</div>` : ''}
                    ${S.voice === 'duo' ? `<div class="pod-voices duo"><span>Host A</span>${VOICES.map(([k, n]) => `<button type="button" class="pod-chip" data-set="va" data-val="${k}" aria-pressed="${S.va === k}">${n}</button>`).join('')}</div>
                        <div class="pod-voices duo"><span>Host B</span>${VOICES.map(([k, n]) => `<button type="button" class="pod-chip" data-set="vb" data-val="${k}" aria-pressed="${S.vb === k}">${n}</button>`).join('')}</div>` : ''}

                    <p class="pod-label">Equipment</p>
                    <div class="pod-rack">
                        <div class="pod-unit"><span class="pod-unit-name">${ic('i-mic')}Microphone</span><div class="pod-segs">${Object.entries(MICS).map(([k, m]) => seg('mic', k, m.name, m.hint)).join('')}</div></div>
                        <div class="pod-unit"><span class="pod-unit-name">🎚️ Processing</span><div class="pod-toggles">
                            ${S.voice === 'me' ? `<label class="pod-toggle"><input type="checkbox" data-t="denoise"${S.denoise ? ' checked' : ''}><span>Noise reduction</span></label>` : ''}
                            <label class="pod-toggle"><input type="checkbox" data-t="compressor"${S.compressor ? ' checked' : ''}><span>Broadcast compressor</span></label>
                            <label class="pod-toggle"><input type="checkbox" data-t="bed"${S.bed ? ' checked' : ''}${S.music === 'none' ? ' disabled' : ''}><span>Music under the voice</span></label></div></div>
                        <div class="pod-unit"><span class="pod-unit-name">🏛️ Room</span><div class="pod-segs">${Object.entries(ROOMS).map(([k, r]) => seg('room', k, r[0])).join('')}</div></div>
                        <div class="pod-unit"><span class="pod-unit-name">🎵 Intro & outro music</span><div class="pod-segs">${Object.entries(MUSIC).map(([k, n]) => seg('music', k, n)).join('')}</div></div>
                    </div>

                    <p class="pod-label">${S.voice === 'duo' ? 'Conversation' : 'Script'}</p>
                    ${S.voice === 'duo'
                        ? (S.convo ? `<textarea class="pod-script" data-f="convo" rows="9" aria-label="Conversation">${esc(S.convo)}</textarea>` : `<button type="button" class="ghost-btn pod-write" data-p="write">${ic('i-sparkle')}Write the conversation (AI)</button><p class="pod-tip">Two AI hosts talk through your note. You can edit what they say before they record it.</p>`)
                        : `<textarea class="pod-script" data-f="script" rows="8" aria-label="Script">${esc(S.script)}</textarea>`}
                    ${S.voice === 'me' ? '<p class="pod-tip">This scrolls in front of you while you record, like a teleprompter. Use headphones for the cleanest sound.</p>' : '<p class="pod-tip">AI-generated voices — your episode will say so when you post it.</p>'}
                </div>
                <footer class="pod-foot">${S.voice === 'me' ? `<button type="button" class="primary-btn pod-go" data-p="record">${ic('i-mic')}Start recording</button>` : `<button type="button" class="primary-btn pod-go" data-p="make"${S.voice === 'duo' && !S.convo ? ' disabled' : ''}>${ic('i-sparkle')}Make the episode</button>`}</footer>
            </div>`;
        };
        dlg.addEventListener('input', e => {
            const f = e.target.dataset.f;
            if (f) { S[f] = e.target.value; if (f === 'title') dlg.querySelector('.pod-cover').src = cover(S.title || 'Episode', note.color); }
        });
        dlg.addEventListener('change', e => { const t = e.target.dataset.t; if (t) S[t] = e.target.checked; });
        dlg.addEventListener('click', async e => {
            const set = e.target.closest('[data-set]');
            if (set && !set.disabled) { S[set.dataset.set] = set.dataset.val; return paint(); }
            const p = e.target.closest('[data-p]');
            if (!p) return;
            const a = p.dataset.p;
            if (a === 'close') return dlg.close();
            if (a === 'write') {
                p.disabled = true; p.innerHTML = `${ic('i-sparkle')}Writing the conversation…`;
                try {
                    let text = '';
                    await window.diaryAI.stream({ mode: 'assist', task: 'podcast', title: S.title, text: note.text }, t => { text = t; });
                    S.convo = text.split('\n').map(l => l.trim()).filter(l => /^[AB]:/.test(l)).join('\n');
                    if (!S.convo) throw new Error('empty');
                } catch (err) { toast(err && err.message && err.message !== 'empty' ? err.message : 'Couldn’t write the conversation — try again'); }
                return paint();
            }
            if (a === 'record') return booth(note, S, dlg);
            if (a === 'make') return makeAI(note, S, dlg);
        });
        dlg.addEventListener('close', () => dlg.remove());
        paint();
        dlg.showModal();
    }

    // Progress overlay inside the studio
    function busy(dlg, text) {
        let el = dlg.querySelector('.pod-busy');
        if (!el) { el = document.createElement('div'); el.className = 'pod-busy'; el.innerHTML = '<span class="pod-spin" aria-hidden="true"></span><p role="status"></p>'; dlg.querySelector('.pod-card').append(el); }
        el.querySelector('p').textContent = text;
        return { set: t => { el.querySelector('p').textContent = t; }, done: () => el.remove() };
    }

    // ---------- AI voices ----------
    async function makeAI(note, S, dlg) {
        const b = busy(dlg, 'Warming up the voices…');
        try {
            let pieces, labels;
            if (S.voice === 'duo') {
                const turns = S.convo.split('\n').map(l => { const m = l.match(/^([AB]):\s*(.+)$/); return m ? { speaker: m[1], text: m[2] } : null; }).filter(Boolean);
                pieces = []; let cur = [], size = 0;
                for (const t of turns) { if (size + t.text.length > 2200 && cur.length) { pieces.push(cur); cur = []; size = 0; } cur.push(t); size += t.text.length; }
                if (cur.length) pieces.push(cur);
                labels = pieces.map((_, i) => `Part ${i + 1}`);
            } else {
                pieces = chunks(S.script);
                labels = pieces.map(p => p.split('\n')[0].replace(/\.$/, '').slice(0, 60));
            }
            const buffers = [];
            for (let i = 0; i < pieces.length; i++) {
                b.set(`Recording ${pieces.length > 1 ? `part ${i + 1} of ${pieces.length}` : 'the episode'}… (natural voices take a moment)`);
                const wavBuf = S.voice === 'duo' ? await speak({ turns: pieces[i], voices: { A: S.va, B: S.vb } }) : await speak({ text: pieces[i], voice: S.va });
                buffers.push(await decode(wavBuf));
            }
            b.set('Mixing with your equipment…');
            const { buffer, starts } = join(buffers);
            const chapters = labels.map((l, i) => ({ title: l, at: starts[i] }));
            await finish(note, S, dlg, buffer, chapters, true);
        } catch (err) {
            toast(err.message || 'Couldn’t make the episode');
        } finally { b.done(); }
    }

    // ---------- Your voice: the recording booth ----------
    async function booth(note, S, dlg) {
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || !window.MediaRecorder) return toast('Recording isn’t supported in this browser');
        let stream;
        try { stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: S.denoise, autoGainControl: true, channelCount: 1 } }); }
        catch (e) { return toast('Microphone access is off — allow it in your browser’s site settings'); }
        const marks = [{ title: 'Intro', at: 0 }];
        const secs = sections(note);
        const ov = document.createElement('div');
        ov.className = 'pod-booth';
        ov.innerHTML = `
            <header class="pod-booth-top"><span class="pod-rec"><i></i>REC</span><span class="pod-time" aria-live="off">0:00</span><div class="pod-meter" aria-hidden="true"><i></i></div></header>
            <div class="pod-prompter" tabindex="0" aria-label="Teleprompter"><div class="pod-prompter-text">${esc(S.script).split(/\n{2,}/).map(p => `<p>${p.replace(/\n/g, '<br>')}</p>`).join('')}</div></div>
            <div class="pod-speed"><span>Scroll</span><input type="range" min="0" max="60" value="22" aria-label="Teleprompter speed"></div>
            <footer class="pod-booth-ctl">
                <button type="button" class="ghost-btn" data-b="chapter">${ic('i-plus')}Chapter</button>
                <button type="button" class="pod-stop" data-b="pause" aria-label="Pause">${ic('i-pause')}</button>
                <button type="button" class="primary-btn" data-b="done">Done</button>
            </footer>`;
        dlg.querySelector('.pod-card').append(ov);
        // Live level meter
        const AC = window.AudioContext || window.webkitAudioContext;
        const actx = new AC();
        const an = actx.createAnalyser(); an.fftSize = 512;
        actx.createMediaStreamSource(stream).connect(an);
        const data = new Uint8Array(an.fftSize);
        const meter = ov.querySelector('.pod-meter i');
        const mime = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg'].find(t => MediaRecorder.isTypeSupported(t)) || '';
        const rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
        const parts = [];
        rec.ondataavailable = e => { if (e.data && e.data.size) parts.push(e.data); };
        let started = performance.now(), pausedFor = 0, pausedAt = 0, raf = 0;
        const elapsed = () => ((pausedAt || performance.now()) - started - pausedFor) / 1000;
        const prompter = ov.querySelector('.pod-prompter');
        const speed = ov.querySelector('input[type="range"]');
        let last = performance.now();
        const tick = now => {
            an.getByteTimeDomainData(data);
            let peak = 0; for (const v of data) peak = Math.max(peak, Math.abs(v - 128));
            meter.style.transform = `scaleX(${Math.min(1, peak / 90)})`;
            meter.parentElement.classList.toggle('hot', peak > 110);
            ov.querySelector('.pod-time').textContent = fmt(elapsed());
            if (!pausedAt) prompter.scrollTop += (Number(speed.value) / 1000) * (now - last);
            last = now;
            raf = requestAnimationFrame(tick);
        };
        rec.start(1000);
        raf = requestAnimationFrame(tick);
        const stop = () => new Promise(r => { rec.onstop = r; rec.stop(); });
        const cleanup = () => { cancelAnimationFrame(raf); stream.getTracks().forEach(t => t.stop()); actx.close().catch(() => {}); ov.remove(); };
        let chapterIdx = 0;
        ov.addEventListener('click', async e => {
            const b = e.target.closest('[data-b]');
            if (!b) return;
            if (b.dataset.b === 'chapter') {
                chapterIdx += 1;
                marks.push({ title: (secs[chapterIdx - 1] && secs[chapterIdx - 1].title) || `Chapter ${marks.length}`, at: elapsed() });
                toast(`Chapter ${marks.length - 1} marked`);
            } else if (b.dataset.b === 'pause') {
                if (rec.state === 'recording') { rec.pause(); pausedAt = performance.now(); b.innerHTML = ic('i-mic'); b.setAttribute('aria-label', 'Resume'); ov.classList.add('paused'); }
                else { rec.resume(); pausedFor += performance.now() - pausedAt; pausedAt = 0; b.innerHTML = ic('i-pause'); b.setAttribute('aria-label', 'Pause'); ov.classList.remove('paused'); }
            } else if (b.dataset.b === 'done') {
                if (elapsed() < 2) return toast('Record a little more first');
                await stop();
                cleanup();
                const bz = busy(dlg, 'Mixing with your equipment…');
                try {
                    const voice = await decode(await new Blob(parts, { type: rec.mimeType || 'audio/webm' }).arrayBuffer());
                    await finish(note, S, dlg, voice, marks, false);
                } catch (err) { toast('Couldn’t process the recording — try again'); }
                finally { bz.done(); }
            }
        });
        dlg.addEventListener('close', () => { if (ov.isConnected) { try { rec.stop(); } catch (e) { /* ignore */ } cleanup(); } }, { once: true });
    }

    // ---------- The finished episode ----------
    async function finish(note, S, dlg, voice, chapters, ai) {
        const { buffer, offset } = await mixEpisode(voice, S);
        const blob = toWav(buffer);
        const name = `${S.title.replace(/[^\w\- ]+/g, '').trim().slice(0, 60) || 'episode'}.wav`;
        const file = new File([blob], name, { type: 'audio/wav' });
        file.duration = buffer.duration;
        const url = URL.createObjectURL(blob);
        const chaps = chapters.map(c => ({ title: c.title, at: c.at + offset }));
        const card = dlg.querySelector('.pod-card');
        card.innerHTML = `
            <header class="gm-head"><button type="button" class="icon-btn" data-r="close" aria-label="Close">${ic('i-close')}</button>
                <div class="gm-title"><strong>🎧 Your episode</strong><small>${fmt(buffer.duration)} · ${esc(MICS[S.mic].name)}${ai ? ' · AI voices' : ''}</small></div></header>
            <div class="gm-body pod-body">
                <div class="pod-episode done"><img class="pod-cover" src="${cover(S.title, note.color)}" alt="Episode cover"><div><strong>${esc(S.title)}</strong><p class="pod-show">${esc(showName())}${ai ? ' · <span class="pod-ai">AI voices</span>' : ''}</p></div></div>
                <audio class="pod-player" controls preload="auto" src="${url}"></audio>
                ${chaps.length > 1 ? `<p class="pod-label">Chapters</p><ol class="pod-chapters">${chaps.map(c => `<li><button type="button" data-at="${c.at}"><span>${fmt(c.at)}</span>${esc(c.title)}</button></li>`).join('')}</ol>` : ''}
                <div class="pod-actions">
                    <button type="button" class="primary-btn" data-r="save">${ic('i-plus')}Save to note</button>
                    <button type="button" class="ghost-btn" data-r="post">${ic('i-feed')}Post to Feed</button>
                    <a class="ghost-btn" href="${url}" download="${esc(name)}">${ic('i-download')}Download</a>
                    <button type="button" class="link-btn" data-r="again">Back to the studio</button>
                </div>
            </div>`;
        card.onclick = async e => {
            const ch = e.target.closest('[data-at]');
            if (ch) { const a = card.querySelector('audio'); a.currentTime = Number(ch.dataset.at); a.play().catch(() => {}); return; }
            const b = e.target.closest('[data-r]');
            if (!b) return;
            const r = b.dataset.r;
            if (r === 'close') return dlg.close();
            if (r === 'again') { dlg.close(); return open(note); }
            if (r === 'save') {
                b.disabled = true;
                const ok = await saveToNote(note, file);
                if (ok) { b.textContent = 'Saved ✓'; toast('Episode saved to your note 🎧'); } else b.disabled = false;
            }
            if (r === 'post') {
                if (!social || !social.isSignedIn || !social.isSignedIn()) return social && social.requireSignIn ? social.requireSignIn('Sign in to post your episode.') : null;
                if (file.size > 20 * 1048576) return toast('This episode is too long to post (20 MB max) — download it instead');
                b.disabled = true;
                await app.createEntry({ text: `🎙️ ${S.title}\n${showName()}${ai ? ' · AI voices' : ''}\n#podcast`, shared: true, origin: 'post' }, [file]);
                b.textContent = 'Posted ✓';
                toast('Your episode is on the Feed 🎙️');
            }
        };
    }
    async function saveToNote(note, file) {
        if (app.addFilesToEditor && app.addFilesToEditor(note.id, [file])) return true;
        try {
            const id = Math.random().toString(36).slice(2, 12) + Date.now().toString(36);
            await Media.put(id, file);
            const n = app.getNotes().find(x => x.id === note.id);
            if (!n) return false;
            app.updateNote(n.id, { attachments: [...(n.attachments || []), { id, kind: 'audio', name: file.name, type: file.type, size: file.size, duration: file.duration }] });
            return true;
        } catch (e) { toast('Couldn’t save it on this device'); return false; }
    }

    window.diaryPodcast = { open };
});
