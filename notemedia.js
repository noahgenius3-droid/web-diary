// Turn a note into a video or an audio post for the Feed.
//  • Video: the note becomes an animated story-style slideshow (9:16), made right here in the browser
//    (canvas + MediaRecorder). Add music (built-in tracks generated live, or your own audio file),
//    an animated character that "reads" the note, and optionally your own voice — then post it as a reel.
//  • Audio: you read the note aloud with it scrolling as a teleprompter; background noise can be
//    silenced for a clean voice-over. The recording is posted to the Feed as a voice post.
document.addEventListener('DOMContentLoaded', () => {
    const app = window.diaryApp;
    const social = window.diarySocial;
    if (!app) return;
    const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const ic = id => `<svg class="i"><use href="#${id}"/></svg>`;
    const W = 720, H = 1280;
    const AC = window.AudioContext || window.webkitAudioContext;

    const LOOKS = {
        note: null, // the note's own colour
        sunset: ['#db2777', '#f97316', '#fff'],
        night: ['#0f172a', '#4338ca', '#fff'],
        ocean: ['#0369a1', '#0d9488', '#fff'],
        forest: ['#14532d', '#65a30d', '#fff'],
        paper: ['#faf7f0', '#ede4d3', '#1f2937']
    };
    const NOTE_COLOURS = {
        yellow: ['#f59e0b', '#fde68a'], pink: ['#db2777', '#fbcfe8'], blue: ['#2563eb', '#bfdbfe'], green: ['#16a34a', '#bbf7d0'],
        purple: ['#7c3aed', '#ddd6fe'], orange: ['#ea580c', '#fed7aa'], coral: ['#e11d48', '#fecdd3'], teal: ['#0d9488', '#99f6e4'],
        sky: ['#0284c7', '#bae6fd'], lime: ['#65a30d', '#d9f99d'], gray: ['#475569', '#e2e8f0']
    };
    const SPEEDS = { slow: 5.5, normal: 4, fast: 2.8 }; // seconds per slide
    const TRACKS = [
        ['none', 'No music', '🔇'], ['calm', 'Calm', '🌙'], ['uplifting', 'Uplifting', '☀️'],
        ['lofi', 'Lo-fi', '🎧'], ['afro', 'Afro groove', '🥁'], ['cinematic', 'Cinematic', '🎬'],
        ['praise', 'Gospel praise', '🙌'], ['worship', 'Worship', '🕊️']
    ];
    const CHARACTERS = [['none', 'None', '—'], ['buddy', 'Buddy', '🟣'], ['kitty', 'Kitty', '🐱'], ['robo', 'Robo', '🤖'], ['sunny', 'Sunny', '🌞']];
    const MAX_MUSIC = 20 * 1048576;

    // Which built-in track suits the note, from its words
    function recommend(note) {
        const t = `${note.title} ${note.text}`.toLowerCase();
        if (/\b(god|jesus|christ|lord|church|pray|prayer|bless|grace|praise|worship|amen|hallelujah|gospel|holy|faith|psalm|bible|spirit|mercy|testimony)/.test(t)) {
            return /\b(praise|celebrat|dance|testimony|victory|hallelujah|joy|thank|win|won|breakthrough)/.test(t) ? 'praise' : 'worship';
        }
        if (/\b(sad|miss(ed|ing)?|lost|grief|griev|cry|cried|tired|alone|lonely|hurt|pray|prayer|peace|calm|rest|sorry|heal)/.test(t)) return 'calm';
        if (/\b(party|dance|danc|celebrat|independence|birthday|vibes|jollof|owambe|naija|afro|wedding|festival)/.test(t)) return 'afro';
        if (/\b(win|won|grateful|thank|happy|excited|joy|success|proud|love|blessed|amazing)/.test(t)) return 'uplifting';
        if (/\b(study|exam|work|focus|night|coffee|rain|read|late|chill|relax)/.test(t)) return 'lofi';
        if (/\b(dream|future|journey|story|begin|hope|chapter|life|goal|vision)/.test(t)) return 'cinematic';
        return 'lofi';
    }

    // ---------- Built-in music, generated live with Web Audio (no files, no licences) ----------
    const mtof = m => 440 * Math.pow(2, (m - 69) / 12);
    function musicEngine(ctx, out, kind) {
        const bpm = { calm: 70, uplifting: 100, lofi: 80, afro: 108, cinematic: 64, praise: 112, worship: 68 }[kind] || 80;
        const step = 60 / bpm / 4; // a sixteenth note
        // Every voice goes through a compressor and a big make-up gain, then a limiter: loud and full, never clipping
        const master = ctx.createGain();
        master.gain.value = 1;
        const glue = ctx.createDynamicsCompressor();
        glue.threshold.value = -24; glue.knee.value = 10; glue.ratio.value = 4; glue.attack.value = 0.005; glue.release.value = 0.25;
        const makeup = ctx.createGain();
        makeup.gain.value = 2.6;
        const limit = ctx.createDynamicsCompressor();
        limit.threshold.value = -2; limit.knee.value = 0; limit.ratio.value = 20; limit.attack.value = 0.002; limit.release.value = 0.1;
        master.connect(glue); glue.connect(makeup); makeup.connect(limit); limit.connect(out);
        const noiseBuf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
        const nd = noiseBuf.getChannelData(0);
        for (let i = 0; i < nd.length; i++) nd[i] = Math.random() * 2 - 1;
        let seed = 7;
        const rand = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };

        const note = (freq, t, dur, { type = 'sine', gain = 0.2, attack = 0.01, cutoff = 0, detune = 0 } = {}) => {
            const o = ctx.createOscillator();
            o.type = type;
            o.frequency.value = freq;
            o.detune.value = detune;
            const g = ctx.createGain();
            g.gain.setValueAtTime(0.0001, t);
            g.gain.linearRampToValueAtTime(gain, t + attack);
            g.gain.exponentialRampToValueAtTime(0.0001, t + attack + dur);
            let node = o;
            if (cutoff) { const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = cutoff; o.connect(f); node = f; }
            node.connect(g);
            g.connect(master);
            o.start(t);
            o.stop(t + attack + dur + 0.05);
        };
        const noise = (t, dur, { gain = 0.1, hp = 6000, bp = 0 } = {}) => {
            const src = ctx.createBufferSource();
            src.buffer = noiseBuf;
            const f = ctx.createBiquadFilter();
            f.type = bp ? 'bandpass' : 'highpass';
            f.frequency.value = bp || hp;
            const g = ctx.createGain();
            g.gain.setValueAtTime(gain, t);
            g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
            src.connect(f); f.connect(g); g.connect(master);
            src.start(t, rand() * 0.5);
            src.stop(t + dur + 0.05);
        };
        const kick = (t, gain = 0.45, from = 140) => {
            const o = ctx.createOscillator();
            const g = ctx.createGain();
            o.frequency.setValueAtTime(from, t);
            o.frequency.exponentialRampToValueAtTime(42, t + 0.14);
            g.gain.setValueAtTime(gain, t);
            g.gain.exponentialRampToValueAtTime(0.0001, t + 0.4);
            o.connect(g); g.connect(master);
            o.start(t); o.stop(t + 0.45);
        };

        const PROGS = {
            calm: [[60, 64, 67, 71], [57, 60, 64, 67], [53, 57, 60, 64], [55, 59, 62, 67]],
            uplifting: [[60, 64, 67], [67, 71, 74], [69, 72, 76], [65, 69, 72]],
            lofi: [[62, 65, 69, 72], [67, 71, 74, 77], [60, 64, 67, 71], [57, 60, 64, 67]],
            afro: [[57, 60, 64], [53, 57, 60], [60, 64, 67], [55, 59, 62]],
            cinematic: [[45, 52, 57], [41, 48, 53], [48, 55, 60], [43, 50, 55]],
            // Gospel: I – vi7 – ii7 – V7 in C (praise), and a slow I – V/7 – vi – IV (worship)
            praise: [[60, 64, 67, 72], [57, 60, 64, 67], [62, 65, 69, 72], [55, 59, 62, 65]],
            worship: [[60, 64, 67], [59, 62, 67], [57, 60, 64], [53, 57, 60, 65]]
        };
        const PENTA = [69, 72, 74, 76, 79, 81];
        // A church organ: a few sine harmonics (like drawbars) with a gentle vibrato
        const organ = (m, t, dur, gain) => {
            [[1, 1], [2, 0.5], [3, 0.25], [4, 0.18], [0.5, 0.4]].forEach(([h, g]) => {
                const o = ctx.createOscillator();
                o.frequency.value = mtof(m) * h;
                const lfo = ctx.createOscillator();
                const depth = ctx.createGain();
                lfo.frequency.value = 5.5;
                depth.gain.value = 3 * h;
                lfo.connect(depth); depth.connect(o.frequency);
                const env = ctx.createGain();
                env.gain.setValueAtTime(0.0001, t);
                env.gain.linearRampToValueAtTime(gain * g, t + 0.06);
                env.gain.setValueAtTime(gain * g, t + dur - 0.08);
                env.gain.linearRampToValueAtTime(0.0001, t + dur);
                o.connect(env); env.connect(master);
                o.start(t); lfo.start(t);
                o.stop(t + dur + 0.05); lfo.stop(t + dur + 0.05);
            });
        };
        // A piano-ish note: bright attack, long decay
        const piano = (m, t, dur, gain) => {
            note(mtof(m), t, dur, { type: 'triangle', gain, attack: 0.003 });
            note(mtof(m) * 2, t, dur * 0.4, { gain: gain * 0.35, attack: 0.002 });
        };

        function play(i, t) {
            const bar = Math.floor(i / 16), s = i % 16;
            const chord = PROGS[kind][bar % 4];
            const barLen = step * 16;
            if (kind === 'calm') {
                if (s === 0) {
                    chord.forEach(m => note(mtof(m), t, barLen, { gain: 0.035, attack: 1.2 }));
                    note(mtof(chord[0] - 12), t, barLen, { gain: 0.06, attack: 0.8 });
                }
                if (s % 4 === 0) note(mtof(chord[(s / 4) % chord.length] + 12), t, 1.6, { type: 'triangle', gain: 0.045, attack: 0.005 });
            } else if (kind === 'uplifting') {
                if (s % 2 === 0) note(mtof(chord[(s / 2) % 3] + 12), t, 0.45, { type: 'triangle', gain: 0.07, attack: 0.004 });
                if (s % 8 === 0) note(mtof(chord[0] - 24), t, step * 7, { gain: 0.16, attack: 0.01 });
                if (s % 4 === 0) kick(t, 0.32);
                if (s === 4 || s === 12) noise(t, 0.16, { gain: 0.11, bp: 1500 });
                if (s % 4 === 2) noise(t, 0.05, { gain: 0.035, hp: 7000 });
            } else if (kind === 'lofi') {
                if (s === 0 || s === 10) chord.forEach(m => note(mtof(m), t, 1.8, { gain: 0.04, attack: 0.02, cutoff: 1600, detune: rand() * 8 - 4 }));
                if (s === 0 || s === 8) note(mtof(chord[0] - 24), t, step * 6, { gain: 0.15, attack: 0.02, cutoff: 500 });
                if (s === 0 || s === 7 || s === 10) kick(t, 0.35, 110);
                if (s === 4 || s === 12) noise(t, 0.18, { gain: 0.08, bp: 1800 });
                if (s % 2 === 0) noise(t + (s % 4 === 2 ? step * 0.33 : 0), 0.04, { gain: 0.022, hp: 7500 });
                if (rand() < 0.35) noise(t, 0.012, { gain: 0.012, hp: 3000 }); // vinyl crackle
            } else if (kind === 'afro') {
                if ([0, 6, 8, 14].includes(s)) kick(t, 0.36);
                noise(t, 0.035, { gain: s % 2 ? 0.014 : 0.03, hp: 8500 }); // shaker
                if ([0, 3, 6, 10, 12].includes(s)) noise(t, 0.04, { gain: 0.05, bp: 3200 }); // clave
                if ([0, 3, 8, 11].includes(s)) note(mtof(chord[0] - 12), t, 0.28, { gain: 0.16, attack: 0.005 }); // log-drum bass
                if (s % 2 === 0 && rand() < 0.55) note(mtof(PENTA[Math.floor(rand() * PENTA.length)]), t, 0.3, { gain: 0.07, attack: 0.003 }); // marimba
            } else if (kind === 'cinematic') {
                if (s === 0) {
                    chord.forEach(m => note(mtof(m), t, barLen * 1.1, { type: 'sawtooth', gain: 0.036, attack: 2, cutoff: 900 }));
                    note(mtof(chord[2] + 24), t, barLen, { gain: 0.04, attack: 1.5 });
                    if (bar % 2 === 0) { kick(t, 0.5, 80); noise(t, 0.6, { gain: 0.05, bp: 120 }); }
                }
                if (s === 8 && bar % 2 === 1) note(mtof(chord[1] + 12), t, 2.4, { type: 'triangle', gain: 0.035, attack: 0.3 });
            } else if (kind === 'praise') {
                // Organ stabs on the off-beats, claps on 2 and 4, tambourine, walking bass, shout-kick
                if (s === 0) chord.forEach(m => organ(m, t, step * 3.5, 0.02));
                if (s === 6 || s === 10 || s === 14) chord.forEach(m => organ(m, t, step * 1.5, 0.018));
                if (s === 4 || s === 12) { noise(t, 0.14, { gain: 0.12, bp: 1400 }); noise(t + 0.012, 0.1, { gain: 0.08, bp: 2200 }); }
                if (s % 2 === 0) noise(t, 0.07, { gain: s % 4 === 2 ? 0.05 : 0.03, bp: 7500 }); // tambourine
                if (s === 0 || s === 8 || s === 11) kick(t, 0.38);
                const walk = [chord[0] - 24, chord[1] - 24, chord[2] - 24, chord[1] - 24];
                if (s % 4 === 0) note(mtof(walk[s / 4]), t, step * 3.5, { gain: 0.17, attack: 0.01, cutoff: 700 });
                if (s === 2 || s === 9) piano(chord[3 % chord.length] + 12, t, 0.5, 0.05);
            } else if (kind === 'worship') {
                // Soft pads, gentle piano arpeggios, a swell at the start of every other bar
                if (s === 0) {
                    chord.forEach(m => note(mtof(m), t, barLen * 1.05, { gain: 0.03, attack: 1.4, cutoff: 1800 }));
                    note(mtof(chord[0] - 12), t, barLen, { gain: 0.07, attack: 0.9 });
                    if (bar % 2 === 0) organ(chord[0], t, barLen, 0.008);
                }
                if (s % 2 === 0) piano([...chord, chord[0] + 12][(s / 2) % (chord.length + 1)] + 12, t, 1.4, 0.035);
                if (s === 0 && bar % 4 === 3) noise(t, 1.2, { gain: 0.015, hp: 5000 }); // a soft cymbal swell
            }
        }

        let next = ctx.currentTime + 0.06, n = 0;
        const timer = setInterval(() => {
            while (next < ctx.currentTime + 0.2) { play(n, next); n++; next += step; }
        }, 25);
        return {
            stop() {
                clearInterval(timer);
                try { master.gain.setTargetAtTime(0.0001, ctx.currentTime, 0.08); } catch (e) { /* closed */ }
                setTimeout(() => { try { master.disconnect(); } catch (e) { /* gone */ } }, 500);
            }
        };
    }

    // ---------- Clean voice: filters out hum and hiss, and silences the gaps between words ----------
    function cleanVoice(ctx, src, on, onLevel) {
        if (!on) return { node: src, stop() {} };
        const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 90;
        const notch = ctx.createBiquadFilter(); notch.type = 'notch'; notch.frequency.value = 50; notch.Q.value = 8; // mains hum
        const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 8500;
        const comp = ctx.createDynamicsCompressor();
        comp.threshold.value = -28; comp.ratio.value = 3; comp.attack.value = 0.005; comp.release.value = 0.2;
        const gate = ctx.createGain();
        const an = ctx.createAnalyser();
        an.fftSize = 1024;
        src.connect(hp); hp.connect(notch); notch.connect(lp); lp.connect(an); lp.connect(comp); comp.connect(gate);
        const buf = new Float32Array(an.fftSize);
        let floor = -55, open = true;
        const timer = setInterval(() => {
            an.getFloatTimeDomainData(buf);
            let sum = 0;
            for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
            const db = 10 * Math.log10(sum / buf.length + 1e-12);
            // The noise floor follows the quiet moments down fast and creeps up slowly
            floor = db < floor ? floor * 0.7 + db * 0.3 : Math.min(-30, floor + 0.03);
            const want = db > Math.max(floor + 9, -60);
            if (want !== open) {
                open = want;
                gate.gain.setTargetAtTime(open ? 1 : 0.02, ctx.currentTime, open ? 0.008 : 0.12);
            }
            if (onLevel) onLevel(Math.max(0, Math.min(1, (db + 70) / 60)), open);
        }, 20);
        return { node: gate, stop: () => clearInterval(timer) };
    }

    // ---------- Turning text into slides ----------
    function slidesFor(note) {
        const text = String(note.text || '').replace(/\s+/g, ' ').trim();
        const sentences = text.match(/[^.!?…]+[.!?…]*["”’)]*\s*/g) || (text ? [text] : []);
        const chunks = [];
        let cur = '';
        for (const raw of sentences) {
            const s = raw.trim();
            if (!s) continue;
            if (s.length > 200) {
                if (cur) { chunks.push(cur); cur = ''; }
                let part = '';
                for (const w of s.split(' ')) {
                    if ((part + ' ' + w).trim().length > 170) { chunks.push(part.trim()); part = ''; }
                    part += ' ' + w;
                }
                if (part.trim()) cur = part.trim();
                continue;
            }
            if ((cur + ' ' + s).trim().length > 170 && cur) { chunks.push(cur); cur = s; }
            else cur = (cur + ' ' + s).trim();
        }
        if (cur) chunks.push(cur);
        const body = chunks.slice(0, 14);
        const more = chunks.length > body.length;
        return [
            { kind: 'title', text: note.title || 'A note', sub: note.date || '' },
            ...body.map((t, i) => ({ kind: 'body', text: more && i === body.length - 1 ? `${t}…` : t })),
            { kind: 'end', text: 'Cordial', sub: note.author ? `@${note.author}` : '' }
        ];
    }

    function palette(look, color) {
        if (look === 'note' || !LOOKS[look]) {
            const [a, b] = NOTE_COLOURS[color] || NOTE_COLOURS.purple;
            return [a, b, '#fff', true];
        }
        return LOOKS[look];
    }

    // ---------- Drawing ----------
    function wrap(ctx, text, maxWidth) {
        const words = String(text).split(' ');
        const lines = [];
        let line = '';
        for (const w of words) {
            const test = line ? `${line} ${w}` : w;
            if (ctx.measureText(test).width > maxWidth && line) { lines.push(line); line = w; }
            else line = test;
        }
        if (line) lines.push(line);
        return lines;
    }

    // Largest font size (within limits) whose wrapped text fits the box
    function fit(ctx, text, family, weight, maxSize, minSize, boxW, boxH, lh) {
        for (let size = maxSize; size >= minSize; size -= 2) {
            ctx.font = `${weight} ${size}px ${family}`;
            const lines = wrap(ctx, text, boxW);
            if (lines.length * size * lh <= boxH) return { size, lines };
        }
        ctx.font = `${weight} ${minSize}px ${family}`;
        return { size: minSize, lines: wrap(ctx, text, boxW) };
    }

    const ease = t => 1 - Math.pow(1 - Math.min(1, Math.max(0, t)), 3);

    function roundRect(ctx, x, y, w, h, r) {
        ctx.beginPath();
        ctx.moveTo(x + r, y);
        ctx.arcTo(x + w, y, x + w, y + h, r);
        ctx.arcTo(x + w, y + h, x, y + h, r);
        ctx.arcTo(x, y + h, x, y, r);
        ctx.arcTo(x, y, x + w, y, r);
        ctx.closePath();
    }

    const circle = (ctx, x, y, r, fill) => { ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fillStyle = fill; ctx.fill(); };

    // ---------- Characters ----------
    // Drawn around (x, y) at size s. They bob, blink, wave when idle and move their mouth while "talking".
    function drawCharacter(ctx, kind, x, y, s, t, talking, waving) {
        if (!kind || kind === 'none') return;
        const bob = Math.sin(t * 3) * s * 0.05;
        const blink = (t % 3.4) < 0.13;
        const mouth = talking ? 0.25 + 0.75 * Math.abs(Math.sin(t * 13)) * (0.6 + 0.4 * Math.sin(t * 5.3)) : 0;
        ctx.save();
        // Soft shadow on the floor
        ctx.fillStyle = 'rgba(0,0,0,0.18)';
        ctx.beginPath();
        ctx.ellipse(x, y + s * 1.05, s * 0.75 - bob * 0.5, s * 0.12, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.translate(x, y + bob);

        const eyes = (ex, ey, r, col = '#1f2937') => {
            [-1, 1].forEach(side => {
                if (blink) { ctx.fillStyle = col; ctx.fillRect(side * ex - r, ey - r * 0.15, r * 2, r * 0.3); return; }
                circle(ctx, side * ex, ey, r, '#fff');
                circle(ctx, side * ex + r * 0.2, ey + r * 0.1, r * 0.55, col);
                circle(ctx, side * ex + r * 0.35, ey - r * 0.2, r * 0.18, '#fff');
            });
        };
        const mouthShape = (my, w, col = '#3b0a1a') => {
            if (mouth > 0.05) {
                ctx.fillStyle = col;
                ctx.beginPath();
                ctx.ellipse(0, my, w * 0.55, w * 0.45 * mouth + 2, 0, 0, Math.PI * 2);
                ctx.fill();
                ctx.fillStyle = '#f472b6';
                ctx.beginPath();
                ctx.ellipse(0, my + w * 0.22 * mouth, w * 0.3, w * 0.15 * mouth + 1, 0, 0, Math.PI * 2);
                ctx.fill();
            } else {
                ctx.strokeStyle = col;
                ctx.lineWidth = Math.max(3, s * 0.045);
                ctx.lineCap = 'round';
                ctx.beginPath();
                ctx.arc(0, my - w * 0.25, w * 0.5, Math.PI * 0.2, Math.PI * 0.8);
                ctx.stroke();
            }
        };
        const cheeks = (cx, cy, r) => { circle(ctx, -cx, cy, r, 'rgba(244,114,182,0.55)'); circle(ctx, cx, cy, r, 'rgba(244,114,182,0.55)'); };
        const arm = (side, col) => {
            const ang = waving && side === 1 ? -0.9 + Math.sin(t * 7) * 0.5 : 0.5 + Math.sin(t * 3 + side) * 0.1;
            ctx.save();
            ctx.translate(side * s * 0.82, s * 0.2);
            ctx.rotate(side * ang);
            ctx.strokeStyle = col;
            ctx.lineWidth = s * 0.16;
            ctx.lineCap = 'round';
            ctx.beginPath();
            ctx.moveTo(0, 0);
            ctx.lineTo(side * s * 0.32, s * 0.3);
            ctx.stroke();
            ctx.restore();
        };

        if (kind === 'buddy') {
            arm(-1, '#7c3aed'); arm(1, '#7c3aed');
            const g = ctx.createRadialGradient(-s * 0.3, -s * 0.4, s * 0.1, 0, 0, s);
            g.addColorStop(0, '#c4b5fd'); g.addColorStop(1, '#7c3aed');
            circle(ctx, 0, 0, s, g);
            ctx.fillStyle = 'rgba(255,255,255,0.25)';
            ctx.beginPath(); ctx.ellipse(0, s * 0.45, s * 0.55, s * 0.4, 0, 0, Math.PI * 2); ctx.fill();
            eyes(s * 0.34, -s * 0.2, s * 0.2);
            cheeks(s * 0.55, s * 0.12, s * 0.12);
            mouthShape(s * 0.3, s * 0.36);
        } else if (kind === 'kitty') {
            const fur = '#f59e0b';
            [-1, 1].forEach(side => {
                ctx.fillStyle = fur;
                ctx.beginPath(); ctx.moveTo(side * s * 0.85, -s * 0.35); ctx.lineTo(side * s * 0.65, -s * 1.15); ctx.lineTo(side * s * 0.2, -s * 0.8); ctx.closePath(); ctx.fill();
                ctx.fillStyle = '#fbcfe8';
                ctx.beginPath(); ctx.moveTo(side * s * 0.7, -s * 0.5); ctx.lineTo(side * s * 0.62, -s * 0.95); ctx.lineTo(side * s * 0.35, -s * 0.75); ctx.closePath(); ctx.fill();
            });
            circle(ctx, 0, 0, s * 0.95, fur);
            ctx.fillStyle = '#fde68a';
            ctx.beginPath(); ctx.ellipse(0, s * 0.35, s * 0.5, s * 0.4, 0, 0, Math.PI * 2); ctx.fill();
            eyes(s * 0.36, -s * 0.15, s * 0.18, '#14532d');
            ctx.fillStyle = '#f472b6';
            ctx.beginPath(); ctx.moveTo(-s * 0.09, s * 0.1); ctx.lineTo(s * 0.09, s * 0.1); ctx.lineTo(0, s * 0.2); ctx.closePath(); ctx.fill();
            ctx.strokeStyle = 'rgba(31,41,55,0.7)'; ctx.lineWidth = 3;
            [-1, 1].forEach(side => [0, 1].forEach(k => {
                ctx.beginPath(); ctx.moveTo(side * s * 0.3, s * (0.22 + k * 0.1)); ctx.lineTo(side * s * 0.95, s * (0.15 + k * 0.2)); ctx.stroke();
            }));
            mouthShape(s * 0.38, s * 0.26);
        } else if (kind === 'robo') {
            ctx.strokeStyle = '#64748b'; ctx.lineWidth = s * 0.06;
            ctx.beginPath(); ctx.moveTo(0, -s * 0.9); ctx.lineTo(0, -s * 1.25); ctx.stroke();
            circle(ctx, 0, -s * 1.3, s * 0.12, Math.floor(t * 2) % 2 ? '#ef4444' : '#22c55e');
            [-1, 1].forEach(side => { ctx.fillStyle = '#64748b'; roundRect(ctx, side * s * 1.02 - s * 0.1, -s * 0.25, s * 0.2, s * 0.5, s * 0.08); ctx.fill(); });
            const g = ctx.createLinearGradient(0, -s, 0, s);
            g.addColorStop(0, '#e2e8f0'); g.addColorStop(1, '#94a3b8');
            ctx.fillStyle = g;
            roundRect(ctx, -s * 0.95, -s * 0.9, s * 1.9, s * 1.8, s * 0.35); ctx.fill();
            ctx.fillStyle = '#0f172a';
            roundRect(ctx, -s * 0.72, -s * 0.62, s * 1.44, s * 1.15, s * 0.22); ctx.fill();
            ctx.fillStyle = '#22d3ee';
            [-1, 1].forEach(side => { roundRect(ctx, side * s * 0.32 - s * 0.14, -s * 0.38, s * 0.28, blink ? s * 0.05 : s * 0.24, s * 0.06); ctx.fill(); });
            // Equaliser mouth
            for (let k = 0; k < 5; k++) {
                const h = talking ? s * (0.06 + 0.2 * Math.abs(Math.sin(t * 11 + k * 1.3))) : s * 0.05;
                ctx.fillRect(-s * 0.42 + k * s * 0.2, s * 0.25 - h / 2, s * 0.12, h);
            }
        } else if (kind === 'sunny') {
            ctx.save();
            ctx.rotate(t * 0.4);
            ctx.fillStyle = '#fbbf24';
            for (let k = 0; k < 12; k++) {
                ctx.rotate(Math.PI / 6);
                ctx.beginPath(); ctx.moveTo(-s * 0.16, -s * 0.95); ctx.lineTo(0, -s * 1.35); ctx.lineTo(s * 0.16, -s * 0.95); ctx.closePath(); ctx.fill();
            }
            ctx.restore();
            const g = ctx.createRadialGradient(-s * 0.3, -s * 0.3, s * 0.1, 0, 0, s);
            g.addColorStop(0, '#fef08a'); g.addColorStop(1, '#f59e0b');
            circle(ctx, 0, 0, s * 0.95, g);
            eyes(s * 0.32, -s * 0.15, s * 0.17, '#78350f');
            cheeks(s * 0.52, s * 0.15, s * 0.13);
            mouthShape(s * 0.32, s * 0.34, '#7c2d12');
        }
        ctx.restore();
    }

    function draw(ctx, slides, t, per, pal, character) {
        const [a, b, ink, isNote] = pal;
        const total = slides.length * per;
        const time = Math.min(Math.max(0, t), total - 0.001); // the first animation frame can land a hair before zero
        const i = Math.floor(time / per);
        const local = (time - i * per) / per; // 0..1 within this slide
        const slide = slides[i];
        const hasChar = character && character !== 'none';

        // Background: gradient with two slow-moving soft lights
        const g = ctx.createLinearGradient(0, 0, W, H);
        g.addColorStop(0, a);
        g.addColorStop(1, b);
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, W, H);
        const blob = (x, y, r, alpha) => {
            const rg = ctx.createRadialGradient(x, y, 0, x, y, r);
            rg.addColorStop(0, `rgba(255,255,255,${alpha})`);
            rg.addColorStop(1, 'rgba(255,255,255,0)');
            ctx.fillStyle = rg;
            ctx.fillRect(0, 0, W, H);
        };
        blob(W * (0.2 + 0.1 * Math.sin(t / 3)), H * (0.2 + 0.05 * Math.cos(t / 4)), 520, ink === '#fff' ? 0.22 : 0.5);
        blob(W * (0.85 + 0.08 * Math.cos(t / 5)), H * (0.8 + 0.05 * Math.sin(t / 3)), 600, ink === '#fff' ? 0.14 : 0.35);
        if (isNote) { ctx.fillStyle = 'rgba(0,0,0,0.18)'; ctx.fillRect(0, 0, W, H); }

        // Story-style progress segments
        const segW = (W - 64 - (slides.length - 1) * 8) / slides.length;
        slides.forEach((_, k) => {
            const x = 32 + k * (segW + 8);
            ctx.fillStyle = ink === '#fff' ? 'rgba(255,255,255,0.35)' : 'rgba(0,0,0,0.15)';
            roundRect(ctx, x, 40, segW, 6, 3);
            ctx.fill();
            const fill = k < i ? 1 : k === i ? local : 0;
            if (fill > 0) {
                ctx.fillStyle = ink;
                roundRect(ctx, x, 40, segW * fill, 6, 3);
                ctx.fill();
            }
        });

        // Slide text: fades up, then the words appear in reading order
        const inT = i === 0 ? 1 : ease(local / 0.18); // the title shows from the first frame, so the reel's thumbnail isn't blank
        const outT = local > 0.9 && i < slides.length - 1 ? 1 - (local - 0.9) / 0.1 : 1;
        const revealing = slide.kind === 'body' && local < 0.6;
        ctx.save();
        ctx.globalAlpha = inT * outT;
        ctx.translate(0, (1 - inT) * 40);
        ctx.fillStyle = ink;
        ctx.textBaseline = 'top';
        if (slide.kind === 'title') {
            const boxW = W - 128;
            const f = fit(ctx, slide.text, '"Fraunces", Georgia, serif', 700, 96, 48, boxW, hasChar ? 440 : 560, 1.1);
            const blockH = f.lines.length * f.size * 1.1;
            let y = (hasChar ? H * 0.42 : H / 2) - blockH / 2 - 40;
            ctx.textAlign = 'left';
            f.lines.forEach(line => { ctx.fillText(line, 64, y); y += f.size * 1.1; });
            if (slide.sub) {
                ctx.font = `600 32px Inter, system-ui, sans-serif`;
                ctx.globalAlpha *= 0.85;
                ctx.fillText(slide.sub, 64, y + 28);
            }
        } else if (slide.kind === 'body') {
            // With a character the text sits in a speech bubble above them
            const box = hasChar ? { x: 48, y: 130, w: W - 96, h: H - 130 - 470 } : { x: 64, y: 110, w: W - 128, h: H - 240 };
            if (hasChar) {
                ctx.save();
                ctx.globalAlpha = inT * outT;
                ctx.fillStyle = ink === '#fff' ? 'rgba(255,255,255,0.16)' : 'rgba(255,255,255,0.75)';
                roundRect(ctx, box.x, box.y, box.w, box.h, 44);
                ctx.fill();
                ctx.beginPath();
                ctx.moveTo(170, box.y + box.h - 2); ctx.lineTo(210, box.y + box.h + 60); ctx.lineTo(250, box.y + box.h - 2); ctx.closePath();
                ctx.fill();
                ctx.restore();
                ctx.fillStyle = ink;
            }
            const pad = hasChar ? 44 : 0;
            const f = fit(ctx, slide.text, 'Inter, system-ui, sans-serif', 700, hasChar ? 58 : 64, 32, box.w - pad * 2, box.h - pad * 2, 1.3);
            const words = slide.text.split(' ').length;
            const shown = Math.ceil(words * ease(Math.min(1, local / 0.55)));
            const blockH = f.lines.length * f.size * 1.3;
            let y = box.y + (box.h - blockH) / 2;
            let count = 0;
            ctx.textAlign = 'left';
            for (const line of f.lines) {
                let x = box.x + pad;
                for (const w of line.split(' ')) {
                    count++;
                    ctx.globalAlpha = inT * outT * (count <= shown ? 1 : 0.18);
                    ctx.fillText(w, x, y);
                    x += ctx.measureText(`${w} `).width;
                }
                y += f.size * 1.3;
            }
        } else {
            ctx.textAlign = 'center';
            const cy = hasChar ? H * 0.3 : H / 2;
            ctx.font = `700 88px "Fraunces", Georgia, serif`;
            ctx.fillText(slide.text, W / 2, cy - 70);
            if (slide.sub) {
                ctx.font = `600 34px Inter, system-ui, sans-serif`;
                ctx.globalAlpha *= 0.85;
                ctx.fillText(slide.sub, W / 2, cy + 40);
            }
        }
        ctx.restore();

        if (hasChar) {
            if (slide.kind === 'title') drawCharacter(ctx, character, W - 190, H - 330, 115, t, false, true);
            else if (slide.kind === 'body') drawCharacter(ctx, character, 200, H - 270, 115, t, revealing, false);
            else drawCharacter(ctx, character, W / 2, H * 0.62, 140, t, false, true);
        }

        // Small signature at the bottom
        ctx.save();
        ctx.fillStyle = ink;
        ctx.globalAlpha = 0.7;
        ctx.textAlign = hasChar && slide.kind === 'body' ? 'right' : 'center';
        ctx.textBaseline = 'alphabetic';
        ctx.font = '600 26px Inter, system-ui, sans-serif';
        if (slide.kind !== 'end') ctx.fillText('Made with Cordial', hasChar && slide.kind === 'body' ? W - 48 : W / 2, H - 56);
        ctx.restore();
    }

    // ---------- The sheet ----------
    const dlg = document.createElement('dialog');
    dlg.className = 'nm';
    dlg.setAttribute('aria-labelledby', 'nm-h');
    document.body.append(dlg);

    let S = null;
    // Music settings for the tab you are on (video and audio each keep their own)
    const M = () => S.bg[S.tab === 'audio' ? 'audio' : 'video'];

    // Everything that makes sound or draws: stopped when the sheet changes or closes
    function stopAll() {
        if (!S) return;
        cancelAnimationFrame(S.raf);
        if (S.recorder && S.recorder.state !== 'inactive') { S.cancelled = true; S.recorder.stop(); }
        if (S.stream) S.stream.getTracks().forEach(t => t.stop());
        if (S.mic) S.mic.getTracks().forEach(t => t.stop());
        stopSound();
        clearInterval(S.tick);
        S.stream = S.mic = null;
    }
    function stopSound() {
        if (!S) return;
        if (S.engine) { S.engine.stop(); S.engine = null; }
        if (S.musicEl) { S.musicEl.pause(); S.musicEl = null; }
        if (S.clean) { S.clean.stop(); S.clean = null; }
        if (S.ac) { const ac = S.ac; S.ac = null; setTimeout(() => ac.close().catch(() => {}), 600); }
        S.previewing = false;
    }

    function open(note) {
        const text = String(note.text || '').trim();
        if (!text && !String(note.title || '').trim()) return app.showToast('Write something in the note first');
        const p = (social && social.internals && social.internals.state.profile) || {};
        stopAll();
        const n = {
            title: String(note.title || '').trim(),
            text,
            color: note.color || 'purple',
            date: new Date(note.createdAt || Date.now()).toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long' }),
            author: p.username || ''
        };
        const rec = recommend(n);
        S = {
            note: n, tab: note.tab || 'video', look: 'note', speed: 'normal', voice: false,
            bg: { video: { music: rec, volume: 1 }, audio: { music: 'none', volume: 0.5 } }, recommended: rec, musicFile: null, musicName: '', character: 'buddy',
            denoise: true, audience: 'friends', videoBlob: null, audioBlob: null, audioDuration: 0
        };
        paint();
        if (!dlg.open) dlg.showModal();
    }

    function paint() {
        stopAll();
        dlg.innerHTML = `
            <form method="dialog" class="nm-card" novalidate>
                <header class="nm-head">
                    <h3 id="nm-h">Share your note as…</h3>
                    <button type="button" class="icon-btn" data-nm="close" aria-label="Close">${ic('i-close')}</button>
                </header>
                <nav class="nm-tabs" role="tablist" aria-label="Format">
                    <button type="button" role="tab" aria-selected="${S.tab === 'video'}" data-nm="tab" data-tab="video">${ic('i-reel')}Video</button>
                    <button type="button" role="tab" aria-selected="${S.tab === 'audio'}" data-nm="tab" data-tab="audio">${ic('i-mic')}Audio</button>
                </nav>
                ${S.tab === 'video' ? videoHTML() : audioHTML()}
            </form>`;
        if (S.tab === 'video') startPreview(false);
    }

    // ---------- Video ----------
    function videoHTML() {
        const secs = Math.round(slidesFor(S.note).length * SPEEDS[S.speed]);
        if (S.videoBlob) {
            return `
                <div class="nm-video">
                    <div class="nm-stage"><video class="nm-canvas" src="${URL.createObjectURL(S.videoBlob)}" controls playsinline loop></video></div>
                    <div class="nm-controls">
                        <p class="nm-done">${ic('i-check')}Your video is ready — ${secs} seconds.</p>
                        <button type="button" class="primary-btn nm-wide" data-nm="post-video">${ic('i-reel')}Post to the Feed as a reel</button>
                        <button type="button" class="ghost-btn nm-wide" data-nm="save-video">Save to this device</button>
                        <button type="button" class="link-btn" data-nm="redo-video">Change it and make it again</button>
                    </div>
                </div>`;
        }
        return `
            <div class="nm-video">
                <div class="nm-stage">
                    <canvas class="nm-canvas" width="720" height="1280" aria-label="Video preview"></canvas>
                    <button type="button" class="nm-play" data-nm="preview" aria-label="${S.previewing ? 'Stop the preview' : 'Play the preview with sound'}">${S.previewing ? '<span class="nm-stop" aria-hidden="true"></span>' : ic('i-play')}<span>${S.previewing ? 'Stop' : 'Preview with sound'}</span></button>
                    <div class="nm-progress" hidden><span></span><small>Making your video…</small></div>
                </div>
                <div class="nm-controls">
                    <div class="field"><span>Character</span>
                        <div class="nm-chars" role="radiogroup" aria-label="Character">${CHARACTERS.map(([k, label, emoji]) => `
                            <button type="button" role="radio" aria-checked="${S.character === k}" class="nm-char" data-nm="char" data-char="${k}"><span aria-hidden="true">${emoji}</span>${label}</button>`).join('')}
                        </div>
                    </div>
                    ${musicPicker('Music')}
                    <div class="field"><span>Look</span>
                        <div class="nm-looks" role="radiogroup" aria-label="Look">${Object.keys(LOOKS).map(k => {
                            const [a, b] = palette(k, S.note.color);
                            return `<button type="button" role="radio" aria-checked="${S.look === k}" class="nm-look" data-nm="look" data-look="${k}" style="background:linear-gradient(135deg,${a},${b})" aria-label="${k === 'note' ? 'Note colour' : k}"></button>`;
                        }).join('')}</div>
                    </div>
                    <div class="field"><span>Pace</span>
                        <div class="nm-seg" role="radiogroup" aria-label="Pace">${Object.keys(SPEEDS).map(k => `<button type="button" role="radio" aria-checked="${S.speed === k}" data-nm="speed" data-speed="${k}">${k[0].toUpperCase() + k.slice(1)}</button>`).join('')}</div>
                    </div>
                    <label class="nm-switch"><input type="checkbox" data-nm="voice"${S.voice ? ' checked' : ''}><span><strong>Add my voice</strong><small>Read along while it records — the slides are your prompt. Background noise is filtered out${M().music !== 'none' ? ', and the music is mixed in underneath (use headphones to hear it)' : ''}.</small></span></label>
                    <p class="nm-meta">${slidesFor(S.note).length} slides · about ${secs} seconds</p>
                    <button type="button" class="primary-btn nm-wide" data-nm="make-video">${ic('i-sparkle')}Make my video</button>
                </div>
            </div>`;
    }

    // Music choice (used by both tabs): built-in tracks, gospel included, or your own audio file
    function musicPicker(label) {
        const m = M();
        const trackBtn = ([k, name, emoji]) => `
            <button type="button" role="radio" aria-checked="${m.music === k}" class="nm-track" data-nm="music" data-music="${k}">
                <span aria-hidden="true">${emoji}</span>${name}${k === S.recommended && S.tab !== 'audio' ? '<small>suits your note</small>' : ''}
            </button>`;
        return `
            <div class="field"><span>${label}</span>
                <button type="button" class="nm-upload${m.music === 'mine' ? ' on' : ''}" data-nm="upload">
                    <span class="nm-upload-ic" aria-hidden="true">📁</span>
                    <span class="nm-upload-text"><strong>${m.music === 'mine' && S.musicFile ? esc(S.musicName) : 'Upload your own audio'}</strong><small>${m.music === 'mine' && S.musicFile ? 'Playing your audio · tap to change it' : 'A song, beat or instrumental from your device — MP3, M4A, WAV'}</small></span>
                </button>
                <div class="nm-tracks" role="radiogroup" aria-label="${label}">${TRACKS.map(trackBtn).join('')}</div>
                ${m.music !== 'none' ? `<label class="nm-volume"><span>Volume <output>${Math.round(m.volume * 100)}%</output></span><input type="range" min="0" max="1.5" step="0.05" value="${m.volume}" data-nm="volume" aria-label="${label} volume"></label>` : ''}
            </div>`;
    }

    // The final mix goes through a limiter, so music + voice can be loud without distorting
    function mixBus(ac, dest) {
        const lim = ac.createDynamicsCompressor();
        lim.threshold.value = -4; lim.knee.value = 0; lim.ratio.value = 20; lim.attack.value = 0.002; lim.release.value = 0.12;
        lim.connect(dest);
        return lim;
    }

    // Your voice: cleaned, boosted, and the music dips under it while you speak
    function addVoice(ac, mic, mix, clean, onLevel) {
        const base = M().volume;
        S.clean = cleanVoice(ac, ac.createMediaStreamSource(mic), clean, (level, open) => {
            if (S.musicGain && !S.fading) S.musicGain.gain.setTargetAtTime(open ? base * 0.35 : base, ac.currentTime, open ? 0.05 : 0.5);
            if (onLevel) onLevel(level, open);
        });
        const boost = ac.createGain();
        boost.gain.value = 2.2;
        S.clean.node.connect(boost);
        boost.connect(mix);
    }

    // Build the soundtrack into an audio context: built-in track or your file, at the chosen volume
    function startMusic(ac, out) {
        if (M().music === 'none') return;
        const gain = ac.createGain();
        gain.gain.value = M().volume;
        gain.connect(out);
        S.musicGain = gain;
        if (M().music === 'mine' && S.musicFile) {
            const el = new Audio(URL.createObjectURL(S.musicFile));
            el.loop = true;
            el.crossOrigin = 'anonymous';
            ac.createMediaElementSource(el).connect(gain);
            el.play().catch(() => {});
            S.musicEl = el;
        } else if (M().music !== 'mine') {
            S.engine = musicEngine(ac, gain, M().music);
        }
    }

    function startPreview(withSound) {
        const canvas = dlg.querySelector('canvas.nm-canvas');
        if (!canvas) return;
        const ctx = canvas.getContext('2d');
        const slides = slidesFor(S.note);
        const per = SPEEDS[S.speed];
        const pal = palette(S.look, S.note.color);
        const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        if (withSound && AC) {
            S.ac = new AC();
            startMusic(S.ac, S.ac.destination);
            S.previewing = true;
        }
        const t0 = performance.now();
        const loop = now => {
            const t = reduce && !withSound ? per * 0.8 : ((now - t0) / 1000) % (slides.length * per);
            draw(ctx, slides, t, per, pal, S.character);
            if (!(reduce && !withSound)) S.raf = requestAnimationFrame(loop);
        };
        S.raf = requestAnimationFrame(loop);
    }

    async function makeVideo() {
        const canvas = dlg.querySelector('canvas.nm-canvas');
        if (!canvas || !canvas.captureStream || !window.MediaRecorder) {
            return app.showToast('Making videos isn’t supported in this browser — try Chrome, Edge or a recent Safari');
        }
        stopSound();
        cancelAnimationFrame(S.raf);
        const ac = AC && (S.voice || M().music !== 'none') ? new AC() : null; // created on the tap, so phones allow sound
        let mic = null;
        if (S.voice) {
            try { mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } }); }
            catch (e) { if (ac) ac.close(); return app.showToast('Allow the microphone to add your voice — or switch “Add my voice” off'); }
        }
        const stream = canvas.captureStream(30);
        if (ac) {
            S.ac = ac;
            const dest = ac.createMediaStreamDestination();
            const mix = mixBus(ac, dest);
            S.fading = false;
            startMusic(ac, mix);
            // Hear the music while it records — unless you're reading along (it would leak into the microphone)
            if (S.musicGain && !mic) S.musicGain.connect(ac.destination);
            if (mic) addVoice(ac, mic, mix, true);
            dest.stream.getAudioTracks().forEach(t => stream.addTrack(t));
        }
        const mime = ['video/mp4;codecs=avc1,mp4a', 'video/mp4', 'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm']
            .find(t => MediaRecorder.isTypeSupported(t)) || '';
        const recorder = new MediaRecorder(stream, { ...(mime ? { mimeType: mime } : {}), videoBitsPerSecond: 3_000_000 });
        const chunks = [];
        S.recorder = recorder;
        S.stream = stream;
        S.mic = mic;
        S.cancelled = false;
        recorder.ondataavailable = e => { if (e.data.size) chunks.push(e.data); };

        const ctx = canvas.getContext('2d');
        const slides = slidesFor(S.note);
        const per = SPEEDS[S.speed];
        const total = slides.length * per;
        const pal = palette(S.look, S.note.color);
        const bar = dlg.querySelector('.nm-progress');
        bar.hidden = false;
        dlg.querySelector('.nm-play').hidden = true;
        bar.querySelector('small').textContent = S.voice ? 'Recording — read along now 🎙️' : 'Making your video…';
        dlg.querySelector('.nm-controls').classList.add('busy');

        const done = new Promise(resolve => { recorder.onstop = resolve; });
        recorder.start(500);
        const t0 = performance.now();
        const frame = now => {
            const t = (now - t0) / 1000;
            draw(ctx, slides, t, per, pal, S.character);
            bar.querySelector('span').style.width = `${Math.min(100, (t / total) * 100)}%`;
            if (S.musicGain && t > total - 1.2 && !S.fading) { S.fading = true; S.musicGain.gain.setTargetAtTime(0.0001, S.ac.currentTime, 0.35); } // fade the music out at the end
            if (t < total + 0.3) S.raf = requestAnimationFrame(frame);
            else if (recorder.state !== 'inactive') recorder.stop();
        };
        S.raf = requestAnimationFrame(frame);
        await done;
        stream.getTracks().forEach(t => t.stop());
        if (mic) mic.getTracks().forEach(t => t.stop());
        S.stream = S.mic = null;
        stopSound();
        if (S.cancelled || !chunks.length) return;
        const type = (recorder.mimeType || mime || 'video/webm').split(';')[0];
        S.videoBlob = new Blob(chunks, { type });
        S.videoType = type;
        paint();
    }

    function videoFile() {
        const ext = S.videoType === 'video/mp4' ? 'mp4' : 'webm';
        const name = (S.note.title || 'note').replace(/[^\w\- ]+/g, '').trim().slice(0, 40) || 'note';
        return new File([S.videoBlob], `${name}.${ext}`, { type: S.videoType });
    }

    async function pickMusic() {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = 'audio/*,.mp3,.m4a,.aac,.wav,.ogg,.flac';
        input.onchange = () => {
            const file = input.files && input.files[0];
            if (!file) return;
            if (!String(file.type || '').startsWith('audio/') && !/\.(mp3|m4a|aac|wav|ogg|flac)$/i.test(file.name)) return app.showToast('Pick an audio file (MP3, M4A, WAV…)');
            if (file.size > MAX_MUSIC) return app.showToast('That audio is over 20 MB — try a shorter clip');
            S.musicFile = file;
            S.musicName = String(file.name || 'Your audio').replace(/\.[a-z0-9]+$/i, '').slice(0, 28);
            M().music = 'mine';
            paint();
            audition();
        };
        input.click();
    }

    // ---------- Audio ----------
    function audioHTML() {
        const n = S.note;
        return `
            <div class="nm-audio">
                <div class="nm-prompter" tabindex="0" aria-label="Your note — read it aloud">
                    ${n.title ? `<h4>${esc(n.title)}</h4>` : ''}
                    <p>${esc(n.text).replace(/\n/g, '<br>')}</p>
                </div>
                ${S.audioBlob ? `
                    <audio class="nm-player" controls src="${URL.createObjectURL(S.audioBlob)}"></audio>
                    ${S.denoise ? `<p class="nm-clean-note">${ic('i-check')}Background noise silenced</p>` : ''}
                    <div class="field"><span>Who can see it</span>
                        <div class="nm-seg" role="radiogroup" aria-label="Audience">
                            <button type="button" role="radio" aria-checked="${S.audience !== 'public'}" data-nm="aud" data-aud="friends">${ic('i-lock')}Friends</button>
                            <button type="button" role="radio" aria-checked="${S.audience === 'public'}" data-nm="aud" data-aud="public">${ic('i-globe')}Everyone</button>
                        </div>
                    </div>
                    <button type="button" class="primary-btn nm-wide" data-nm="post-audio">${ic('i-feed')}Post to the Feed</button>
                    <button type="button" class="link-btn" data-nm="redo-audio">Record again</button>`
                : `
                    <label class="nm-switch"><input type="checkbox" data-nm="denoise"${S.denoise ? ' checked' : ''}><span><strong>Silence background noise</strong><small>For a clean voice-over: filters out hum, fans, traffic and chatter, and silences the gaps between your words.</small></span></label>
                    ${musicPicker('Background music (optional)')}
                    ${M().music !== 'none' ? '<p class="nm-meta">The music is mixed in under your voice and dips while you speak. Use headphones to hear it as you record.</p>' : ''}
                    <div class="nm-meter" aria-hidden="true"><i></i><span class="nm-gate">Listening…</span></div>
                    <div class="nm-rec-row">
                        <span class="nm-timer" aria-live="off">0:00</span>
                        <button type="button" class="nm-rec" data-nm="record" aria-label="Start recording">${ic('i-mic')}</button>
                        <span class="nm-timer-cap">max 10 min</span>
                    </div>
                    <p class="nm-meta">Tap record and read your note aloud. It scrolls as you go.</p>`}
            </div>`;
    }

    async function toggleRecord(btn) {
        if (S.recorder && S.recorder.state === 'recording') { S.recorder.stop(); return; }
        if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) return app.showToast('Recording isn’t supported in this browser');
        const ac = AC ? new AC() : null; // made on the tap so phones allow it
        let mic;
        try {
            mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: S.denoise, autoGainControl: S.denoise } });
        } catch (e) {
            if (ac) ac.close();
            return app.showToast('Allow the microphone for Cordial to record');
        }
        const meter = dlg.querySelector('.nm-meter');
        let recStream = mic;
        if (ac) {
            S.ac = ac;
            const dest = ac.createMediaStreamDestination();
            const mix = mixBus(ac, dest);
            S.fading = false;
            // Background music under the voice-over (mixed in, not played out loud — it would leak into the mic)
            startMusic(ac, mix);
            if (S.denoise) {
                addVoice(ac, mic, mix, true, (level, open) => {
                    if (!meter) return;
                    meter.querySelector('i').style.width = `${Math.round(level * 100)}%`;
                    meter.querySelector('.nm-gate').textContent = open ? 'Voice' : '🔇 Background silenced';
                    meter.classList.toggle('closed', !open);
                });
            } else {
                // Recording as is: still boosted and limited, and still a level meter
                const an = ac.createAnalyser();
                const src = ac.createMediaStreamSource(mic);
                const boost = ac.createGain();
                boost.gain.value = 1.8;
                src.connect(an);
                src.connect(boost);
                boost.connect(mix);
                const buf = new Float32Array(1024);
                const timer = setInterval(() => {
                    an.getFloatTimeDomainData(buf);
                    let sum = 0;
                    for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
                    const db = 10 * Math.log10(sum / buf.length + 1e-12);
                    if (meter) { meter.querySelector('i').style.width = `${Math.round(Math.max(0, Math.min(1, (db + 70) / 60)) * 100)}%`; meter.querySelector('.nm-gate').textContent = 'Recording as is'; }
                }, 40);
                S.clean = { node: src, stop: () => clearInterval(timer) };
            }
            recStream = dest.stream;
        }
        const mime = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg'].find(t => MediaRecorder.isTypeSupported(t)) || '';
        const recorder = new MediaRecorder(recStream, mime ? { mimeType: mime } : undefined);
        const chunks = [];
        S.recorder = recorder;
        S.mic = mic;
        S.cancelled = false;
        recorder.ondataavailable = e => { if (e.data.size) chunks.push(e.data); };
        const started = Date.now();
        const prompter = dlg.querySelector('.nm-prompter');
        const timer = dlg.querySelector('.nm-timer');
        dlg.querySelector('[data-nm="denoise"]').disabled = true;
        recorder.onstop = () => {
            clearInterval(S.tick);
            cancelAnimationFrame(S.raf);
            mic.getTracks().forEach(t => t.stop());
            S.mic = null;
            stopSound();
            if (S.cancelled || !chunks.length) return;
            const type = (recorder.mimeType || mime || 'audio/webm').split(';')[0];
            S.audioBlob = new Blob(chunks, { type });
            S.audioType = type;
            S.audioDuration = Math.max(1, Math.round((Date.now() - started) / 1000));
            paint();
        };
        recorder.start(500);
        btn.classList.add('on');
        btn.setAttribute('aria-label', 'Stop recording');
        btn.innerHTML = '<span class="nm-stop" aria-hidden="true"></span>';
        S.tick = setInterval(() => {
            const sec = Math.floor((Date.now() - started) / 1000);
            timer.textContent = `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
            if (sec >= 600) recorder.stop();
        }, 250);
        // Gentle auto-scroll, about the pace of reading aloud (~2.5 words a second); scrolling by hand still works
        const words = (S.note.title + ' ' + S.note.text).split(/\s+/).length;
        const readSecs = Math.max(8, words / 2.5);
        let last = performance.now();
        const scroll = now => {
            const max = prompter.scrollHeight - prompter.clientHeight;
            prompter.scrollTop = Math.min(max, prompter.scrollTop + (max / readSecs) * ((now - last) / 1000));
            last = now;
            if (recorder.state === 'recording') S.raf = requestAnimationFrame(scroll);
        };
        S.raf = requestAnimationFrame(scroll);
    }

    async function postAudio(btn) {
        if (social && social.isGuest && social.isGuest()) return social.internals.openUpgrade && social.internals.openUpgrade();
        if (!(social && social.isSignedIn && social.isSignedIn())) return app.showToast('Sign in to post to the Feed');
        btn.disabled = true;
        btn.textContent = 'Posting…';
        const ext = { 'audio/mp4': 'm4a', 'audio/ogg': 'ogg' }[S.audioType] || 'webm';
        const file = new File([S.audioBlob], `${S.note.title || 'Voice note'}.${ext}`, { type: S.audioType });
        file.duration = S.audioDuration;
        const title = S.note.title ? `🎙️ ${S.note.title}` : '🎙️ Listen to my note';
        try {
            await app.createEntry({ title, text: S.note.text, shared: true, color: S.note.color, audience: S.audience === 'public' ? 'public' : 'friends' }, [file]);
            dlg.close();
            app.showToast('Posted — your note is on the Feed as audio 🎧');
            setTimeout(() => app.setView('feed'), 400);
        } catch (e) {
            btn.disabled = false;
            btn.textContent = 'Post to the Feed';
            app.showToast('Couldn’t post it — try again');
        }
    }

    // ---------- Events ----------
    dlg.addEventListener('click', async e => {
        const el = e.target.closest('[data-nm]');
        if (!el || !S) return;
        const what = el.dataset.nm;
        if (what === 'close') { dlg.close(); }
        else if (what === 'tab') { if (S.recorder && S.recorder.state === 'recording') return; S.tab = el.dataset.tab; paint(); }
        else if (what === 'look') { S.look = el.dataset.look; paint(); }
        else if (what === 'speed') { S.speed = el.dataset.speed; paint(); }
        else if (what === 'char') { S.character = el.dataset.char; paint(); }
        else if (what === 'music') {
            M().music = el.dataset.music;
            paint();
            audition();
        } else if (what === 'upload') pickMusic();
        else if (what === 'preview') {
            const playing = S.previewing;
            stopAll();
            startPreview(!playing);
            refreshPlay();
            if (!playing && M().music === 'none') app.showToast('Pick some music to hear it — or add your voice when you make the video');
        } else if (what === 'make-video') makeVideo();
        else if (what === 'redo-video') { S.videoBlob = null; paint(); }
        else if (what === 'save-video') {
            const f = videoFile();
            const a = document.createElement('a');
            a.href = URL.createObjectURL(f);
            a.download = f.name;
            a.click();
            setTimeout(() => URL.revokeObjectURL(a.href), 4000);
        } else if (what === 'post-video') {
            if (!window.diaryStories) return app.showToast('Sign in to post reels');
            const f = videoFile();
            dlg.close();
            window.diaryStories.addReel(f);
        } else if (what === 'record') toggleRecord(el);
        else if (what === 'redo-audio') { S.audioBlob = null; paint(); }
        else if (what === 'aud') { S.audience = el.dataset.aud; dlg.querySelectorAll('[data-nm="aud"]').forEach(b => b.setAttribute('aria-checked', String(b === el))); }
        else if (what === 'post-audio') postAudio(el);
    });
    // Hear a track as soon as you pick it: the video preview plays with it; on the Audio tab, a 6-second taste
    function audition() {
        if (!S || M().music === 'none' || !AC) return;
        if (S.tab === 'video') {
            stopAll();
            startPreview(true);
            refreshPlay();
            return;
        }
        if (S.recorder && S.recorder.state === 'recording') return;
        stopSound();
        S.ac = new AC();
        startMusic(S.ac, S.ac.destination);
        const ac = S.ac;
        clearTimeout(S.auditionTimer);
        S.auditionTimer = setTimeout(() => { if (S && S.ac === ac) stopSound(); }, 6000);
    }

    function refreshPlay() {
        const b = dlg.querySelector('.nm-play');
        if (!b) return;
        b.setAttribute('aria-label', S.previewing ? 'Stop the preview' : 'Play the preview with sound');
        b.innerHTML = `${S.previewing ? '<span class="nm-stop" aria-hidden="true"></span>' : ic('i-play')}<span>${S.previewing ? 'Stop' : 'Preview with sound'}</span>`;
    }
    dlg.addEventListener('input', e => {
        if (e.target.dataset.nm === 'volume') {
            M().volume = Number(e.target.value);
            const out = e.target.closest('.nm-volume')?.querySelector('output');
            if (out) out.textContent = `${Math.round(M().volume * 100)}%`;
            if (S.musicGain && S.ac) S.musicGain.gain.setTargetAtTime(M().volume, S.ac.currentTime, 0.05);
        }
    });
    dlg.addEventListener('change', e => {
        if (e.target.dataset.nm === 'voice') S.voice = e.target.checked;
        if (e.target.dataset.nm === 'denoise') S.denoise = e.target.checked;
    });
    dlg.addEventListener('close', () => { stopAll(); });
    dlg.addEventListener('cancel', e => { if (S && S.recorder && S.recorder.state === 'recording') e.preventDefault(); });

    // ---------- Picking a note (from the Feed) ----------
    function pickNote(anchor) {
        const notes = (app.getNotes() || []).filter(n => !n.trashedAt && !n.archived && (String(n.text || '').trim() || String(n.title || '').trim()))
            .sort((a, b) => (b.updatedAt || b.createdAt || 0) - (a.updatedAt || a.createdAt || 0)).slice(0, 12);
        if (!notes.length) return app.showToast('Write a note first — then turn it into a video or audio');
        app.openPopover(anchor, [
            { heading: 'Pick a note' },
            ...notes.map(n => ({
                label: (n.title || String(n.text || '').slice(0, 40) || 'Untitled').slice(0, 48),
                icon: 'i-book',
                onClick: () => open(n)
            }))
        ]);
    }

    app.actions['note-media'] = el => pickNote(el);
    window.diaryNoteMedia = { open, pickNote };
});
