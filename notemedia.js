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
    const CHARACTERS = [['none', 'None', '—'], ['woman', 'Presenter (her)', '👩🏾'], ['man', 'Presenter (him)', '👨🏾'],
        ['buddy', 'Buddy', '🟣'], ['kitty', 'Kitty', '🐱'], ['robo', 'Robo', '🤖'], ['sunny', 'Sunny', '🌞']];
    const PRESENTER_VOICE = { woman: 'female', man: 'male' };
    const CHAR_INFO = { none: 'Just your words', woman: 'Presents in a female voice', man: 'Presents in a male voice', buddy: 'Friendly companion', kitty: 'Playful and soft', robo: 'Techy helper', sunny: 'Bright and cheerful' };
    const CHAR_GROUPS = [['Presenters', ['woman', 'man']], ['Characters', ['buddy', 'kitty', 'robo', 'sunny']], ['Simple', ['none']]];
    const LOOK_NAMES = { note: 'Note colour', sunset: 'Sunset', night: 'Night', ocean: 'Ocean', forest: 'Forest', paper: 'Paper' };
    const TRACK_MOOD = { none: 'Just the voice and your words', calm: 'Soft and slow', uplifting: 'Bright and hopeful', lofi: 'Chill beat', afro: 'Percussive groove', cinematic: 'Swelling and epic', praise: 'Joyful gospel chords', worship: 'Gentle and reflective' };
    const VOICES = [['off', 'No narrator', 'Music and your words only'], ['female', 'Female', 'Warm · reads your note aloud'], ['male', 'Male', 'Calm · reads your note aloud']];
    const VOICE_LABEL = { off: 'No narrator', female: 'Female · warm', male: 'Male · calm' };
    const charOf = k => CHARACTERS.find(c => c[0] === k) || CHARACTERS[0];
    const trackOf = k => TRACKS.find(t => t[0] === k) || null;

    // ---------- Drafts: your choices for a note are kept on this device and come back next time ----------
    const DRAFT_KEY = 'cordialNoteMedia';
    const draftIdOf = n => { let h = 0; const str = `${n.title}|${n.text.slice(0, 400)}`; for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) | 0; return String(h); };
    function loadDraft(id) { try { return (JSON.parse(localStorage.getItem(DRAFT_KEY) || '{}'))[id] || null; } catch (e) { return null; } }
    function saveDraft() {
        if (!S) return;
        try {
            const all = JSON.parse(localStorage.getItem(DRAFT_KEY) || '{}');
            const v = S.bg.video;
            all[S.draftId] = { character: S.character, narrate: S.narrate, look: S.look, speed: S.speed, voice: S.voice, music: v.music === 'mine' ? S.recommended : v.music, volume: v.volume, at: Date.now() };
            const keep = Object.keys(all).sort((a, b) => all[b].at - all[a].at).slice(0, 30);
            localStorage.setItem(DRAFT_KEY, JSON.stringify(Object.fromEntries(keep.map(k => [k, all[k]]))));
        } catch (e) { /* private mode: nothing kept */ }
    }
    function dropDraft() {
        try { const all = JSON.parse(localStorage.getItem(DRAFT_KEY) || '{}'); delete all[S.draftId]; localStorage.setItem(DRAFT_KEY, JSON.stringify(all)); } catch (e) { /* private mode */ }
    }

    // ---------- Narrator voices (diary-tts on the server; needs a Gemini key there) ----------
    const cfg = window.DIARY_CONFIG || {};
    let ttsReady = null;
    async function checkTTS() {
        if (ttsReady !== null) return ttsReady;
        try {
            const r = await fetch(`${cfg.supabaseUrl}/functions/v1/diary-tts`, { headers: { apikey: cfg.supabaseKey } });
            ttsReady = !!(await r.json()).ready;
        } catch (e) { ttsReady = false; }
        return ttsReady;
    }
    const scriptOf = slides => slides.filter(s => s.kind !== 'end').map(s => s.text).join('\n\n');
    // The narration for this note in this voice (fetched once, then reused for previews and the video)
    async function narration(slides) {
        const key = `${S.narrate}|${scriptOf(slides)}`;
        if (S.tts && S.tts.key === key) return S.tts.bytes;
        const token = social && social.accessToken ? await social.accessToken() : null;
        if (!token) throw new Error('Sign in to use narrator voices');
        const res = await fetch(`${cfg.supabaseUrl}/functions/v1/diary-tts`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, apikey: cfg.supabaseKey },
            body: JSON.stringify({ text: scriptOf(slides), voice: S.narrate })
        });
        if (!res.ok) {
            let msg = 'Couldn’t make the narration — try again';
            try { msg = (await res.json()).error || msg; } catch (e) { /* not json */ }
            throw new Error(msg);
        }
        S.tts = { key, bytes: await res.arrayBuffer() };
        return S.tts.bytes;
    }
    // ---------- The device's own voices (preview narration when the server voice isn't set up) ----------
    const FEMALE = /female|samantha|victoria|karen|moira|tessa|zira|fiona|serena|allison|ava\b|susan|joanna|kate|catherine|libby|sonia|natasha|aria|jenny|google us english|google uk english female/i;
    const MALE = /\bmale\b|daniel|alex\b|fred|oliver|david|mark\b|arthur|aaron|tom\b|ryan|guy\b|george|james|thomas|google uk english male/i;
    function deviceVoice(gender) {
        if (!('speechSynthesis' in window)) return null;
        const all = speechSynthesis.getVoices();
        const en = all.filter(v => /^en/i.test(v.lang));
        const want = gender === 'male' ? MALE : FEMALE, avoid = gender === 'male' ? FEMALE : MALE;
        return en.find(v => want.test(v.name) && !avoid.test(v.name)) || all.find(v => want.test(v.name) && !avoid.test(v.name)) || en[0] || all[0] || null;
    }
    if ('speechSynthesis' in window) { speechSynthesis.getVoices(); speechSynthesis.addEventListener?.('voiceschanged', () => speechSynthesis.getVoices()); }
    // Speak the slides one after another; tell the caller when each starts, and while it's speaking
    function speakSlides(slides, gender, onSlide, onSpeaking) {
        speechSynthesis.cancel();
        const voice = deviceVoice(gender);
        const isFemaleVoice = voice && FEMALE.test(voice.name);
        slides.forEach((sl, k) => {
            if (sl.kind === 'end') return;
            const u = new SpeechSynthesisUtterance(sl.text);
            if (voice) { u.voice = voice; u.lang = voice.lang; }
            u.rate = 0.98;
            // When the device has no voice of the chosen kind, shape the one it has
            u.pitch = gender === 'female' ? (isFemaleVoice ? 1 : 1.25) : (voice && MALE.test(voice.name) ? 1 : 0.8);
            u.onstart = () => { onSlide(k); onSpeaking(true); };
            u.onend = () => onSpeaking(false);
            u.onerror = () => onSpeaking(false);
            speechSynthesis.speak(u);
        });
    }

    // Each slide lasts about as long as it takes to read it aloud
    function narratedTimes(slides, seconds) {
        const words = slides.map(s => (s.kind === 'end' ? 0 : String(s.text).split(/\s+/).length + (s.kind === 'title' ? 2 : 0)));
        const sum = words.reduce((a, b) => a + b, 0) || 1;
        return slides.map((s, k) => (s.kind === 'end' ? 3 : Math.max(1.6, (seconds * words[k]) / sum) + (k === 0 ? 0.4 : 0)));
    }
    // How loud the voice is right now, 0..1, smoothed, for lip-sync
    function levelMeter(ac, node) {
        const an = ac.createAnalyser();
        an.fftSize = 512;
        node.connect(an);
        const buf = new Float32Array(an.fftSize);
        let smooth = 0;
        return () => {
            an.getFloatTimeDomainData(buf);
            let sum = 0;
            for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
            const v = Math.min(1, Math.sqrt(sum / buf.length) * 7);
            smooth = v > smooth ? smooth * 0.3 + v * 0.7 : smooth * 0.75 + v * 0.25;
            return smooth < 0.04 ? 0 : smooth;
        };
    }
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
    // level (0..1), when given, is the loudness of the voice right now: the mouth follows it (lip-sync)
    function drawCharacter(ctx, kind, x, y, s, t, talking, waving, level = null) {
        if (!kind || kind === 'none') return;
        const human = kind === 'woman' || kind === 'man';
        const bob = Math.sin(t * 3) * s * (human ? 0.015 : 0.05);
        const blink = (t % 3.4) < 0.13;
        const mouth = level != null ? Math.min(1, level) : talking ? 0.25 + 0.75 * Math.abs(Math.sin(t * 13)) * (0.6 + 0.4 * Math.sin(t * 5.3)) : 0;
        if (human) return drawPresenter(ctx, kind, x, y + bob, s, t, mouth, blink);
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

    // Human presenters: head and shoulders, a gentle sway, blinking, eyebrows that lift, lips that open with the voice
    const PRESENTERS = {
        woman: { skin: '#8d5a3b', shade: '#74472d', lips: '#6b2f2a', hair: '#1b1210', cloth: '#be185d', cloth2: '#9d174d' },
        man: { skin: '#6f4a32', shade: '#5a3a26', lips: '#4e2620', hair: '#141010', cloth: '#1e3a8a', cloth2: '#172554' }
    };
    function drawPresenter(ctx, kind, x, y, s, t, mouth, blink) {
        const P = PRESENTERS[kind];
        const woman = kind === 'woman';
        ctx.save();
        ctx.translate(x, y);
        ctx.rotate(Math.sin(t * 1.1) * 0.025 + (mouth > 0.2 ? Math.sin(t * 4) * 0.01 : 0));

        // Long hair falls behind the shoulders
        if (woman) {
            ctx.fillStyle = P.hair;
            ctx.beginPath();
            ctx.moveTo(-s * 0.95, -s * 0.2);
            ctx.quadraticCurveTo(-s * 1.15, s * 0.9, -s * 0.85, s * 1.35);
            ctx.lineTo(s * 0.85, s * 1.35);
            ctx.quadraticCurveTo(s * 1.15, s * 0.9, s * 0.95, -s * 0.2);
            ctx.closePath();
            ctx.fill();
        }
        // Shoulders and clothes
        const body = ctx.createLinearGradient(0, s * 0.9, 0, s * 3.4);
        body.addColorStop(0, P.cloth); body.addColorStop(1, P.cloth2);
        ctx.fillStyle = body;
        ctx.beginPath();
        ctx.moveTo(-s * 1.45, s * 3.4);
        ctx.quadraticCurveTo(-s * 1.4, s * 1.05, -s * 0.45, s * 0.95);
        ctx.lineTo(s * 0.45, s * 0.95);
        ctx.quadraticCurveTo(s * 1.4, s * 1.05, s * 1.45, s * 3.4);
        ctx.closePath();
        ctx.fill();
        // Neck
        ctx.fillStyle = P.shade;
        roundRect(ctx, -s * 0.24, s * 0.55, s * 0.48, s * 0.55, s * 0.12);
        ctx.fill();
        if (woman) {
            // Neckline
            ctx.fillStyle = P.skin;
            ctx.beginPath(); ctx.moveTo(-s * 0.35, s * 0.97); ctx.lineTo(0, s * 1.35); ctx.lineTo(s * 0.35, s * 0.97); ctx.closePath(); ctx.fill();
        } else {
            // Shirt collar and blazer lapels
            ctx.fillStyle = '#f8fafc';
            ctx.beginPath(); ctx.moveTo(-s * 0.32, s * 0.95); ctx.lineTo(0, s * 1.35); ctx.lineTo(s * 0.32, s * 0.95); ctx.lineTo(s * 0.12, s * 0.9); ctx.lineTo(0, s * 1.05); ctx.lineTo(-s * 0.12, s * 0.9); ctx.closePath(); ctx.fill();
            ctx.fillStyle = '#0f172a';
            ctx.beginPath(); ctx.moveTo(-s * 0.05, s * 1.1); ctx.lineTo(s * 0.05, s * 1.1); ctx.lineTo(s * 0.08, s * 1.7); ctx.lineTo(0, s * 1.8); ctx.lineTo(-s * 0.08, s * 1.7); ctx.closePath(); ctx.fill();
            ctx.fillStyle = P.cloth2;
            [-1, 1].forEach(side => { ctx.beginPath(); ctx.moveTo(side * s * 0.34, s * 0.96); ctx.lineTo(side * s * 0.06, s * 1.55); ctx.lineTo(side * s * 0.55, s * 1.2); ctx.closePath(); ctx.fill(); });
        }
        // Ears (and earrings)
        [-1, 1].forEach(side => {
            ctx.fillStyle = P.shade;
            ctx.beginPath(); ctx.ellipse(side * s * 0.7, s * 0.02, s * 0.1, s * 0.16, 0, 0, Math.PI * 2); ctx.fill();
            if (woman) circle(ctx, side * s * 0.71, s * 0.2 + Math.sin(t * 3 + side) * s * 0.01, s * 0.06, '#f59e0b');
        });
        // Face
        const face = ctx.createRadialGradient(-s * 0.2, -s * 0.25, s * 0.1, 0, 0, s * 0.95);
        face.addColorStop(0, P.skin); face.addColorStop(1, P.shade);
        ctx.fillStyle = face;
        ctx.beginPath(); ctx.ellipse(0, 0, s * 0.68, s * 0.86, 0, 0, Math.PI * 2); ctx.fill();
        // Hair on top
        ctx.fillStyle = P.hair;
        if (woman) {
            ctx.beginPath();
            ctx.moveTo(-s * 0.74, s * 0.15);
            ctx.quadraticCurveTo(-s * 0.85, -s * 0.95, 0, -s * 0.98);
            ctx.quadraticCurveTo(s * 0.85, -s * 0.95, s * 0.74, s * 0.15);
            ctx.quadraticCurveTo(s * 0.6, -s * 0.45, s * 0.05, -s * 0.52);
            ctx.quadraticCurveTo(-s * 0.35, -s * 0.5, -s * 0.74, s * 0.15);
            ctx.fill();
        } else {
            ctx.beginPath();
            ctx.moveTo(-s * 0.68, -s * 0.15);
            ctx.quadraticCurveTo(-s * 0.72, -s * 0.92, 0, -s * 0.94);
            ctx.quadraticCurveTo(s * 0.72, -s * 0.92, s * 0.68, -s * 0.15);
            ctx.quadraticCurveTo(s * 0.55, -s * 0.6, 0, -s * 0.62);
            ctx.quadraticCurveTo(-s * 0.55, -s * 0.6, -s * 0.68, -s * 0.15);
            ctx.fill();
            // A trimmed beard along the jaw
            ctx.fillStyle = 'rgba(20,16,16,0.55)';
            ctx.beginPath();
            ctx.moveTo(-s * 0.62, s * 0.2);
            ctx.quadraticCurveTo(-s * 0.5, s * 0.85, 0, s * 0.88);
            ctx.quadraticCurveTo(s * 0.5, s * 0.85, s * 0.62, s * 0.2);
            ctx.quadraticCurveTo(s * 0.4, s * 0.62, 0, s * 0.64);
            ctx.quadraticCurveTo(-s * 0.4, s * 0.62, -s * 0.62, s * 0.2);
            ctx.fill();
        }
        // Eyebrows lift a little when speaking
        const lift = mouth > 0.4 ? s * 0.03 : 0;
        ctx.strokeStyle = P.hair;
        ctx.lineWidth = s * (woman ? 0.045 : 0.06);
        ctx.lineCap = 'round';
        [-1, 1].forEach(side => { ctx.beginPath(); ctx.moveTo(side * s * 0.14, -s * 0.28 - lift); ctx.quadraticCurveTo(side * s * 0.28, -s * 0.36 - lift, side * s * 0.44, -s * 0.26 - lift); ctx.stroke(); });
        // Eyes
        [-1, 1].forEach(side => {
            const ex = side * s * 0.28, ey = -s * 0.1;
            if (blink) {
                ctx.strokeStyle = '#1f130e'; ctx.lineWidth = s * 0.03;
                ctx.beginPath(); ctx.moveTo(ex - s * 0.1, ey); ctx.quadraticCurveTo(ex, ey + s * 0.04, ex + s * 0.1, ey); ctx.stroke();
                return;
            }
            ctx.fillStyle = '#fbf7f2';
            ctx.beginPath(); ctx.ellipse(ex, ey, s * 0.12, s * 0.075, 0, 0, Math.PI * 2); ctx.fill();
            circle(ctx, ex + s * 0.01, ey, s * 0.06, '#3b2416');
            circle(ctx, ex + s * 0.01, ey, s * 0.03, '#0b0706');
            circle(ctx, ex + s * 0.03, ey - s * 0.025, s * 0.013, '#fff');
            if (woman) { ctx.strokeStyle = '#0b0706'; ctx.lineWidth = s * 0.02; ctx.beginPath(); ctx.ellipse(ex, ey, s * 0.12, s * 0.075, 0, Math.PI * 1.05, Math.PI * 1.95); ctx.stroke(); }
        });
        // Nose
        ctx.strokeStyle = 'rgba(40,20,12,0.45)';
        ctx.lineWidth = s * 0.028;
        ctx.beginPath(); ctx.moveTo(-s * 0.07, s * 0.2); ctx.quadraticCurveTo(0, s * 0.26, s * 0.07, s * 0.2); ctx.stroke();
        // Mouth: opens with the voice
        const my = s * 0.43;
        const open = Math.max(0, mouth);
        ctx.fillStyle = P.lips;
        ctx.beginPath(); ctx.ellipse(0, my, s * 0.18, s * (0.045 + 0.1 * open), 0, 0, Math.PI * 2); ctx.fill();
        if (open > 0.08) {
            ctx.fillStyle = '#2a0f0c';
            ctx.beginPath(); ctx.ellipse(0, my + s * 0.01, s * 0.14, s * 0.085 * open, 0, 0, Math.PI * 2); ctx.fill();
            ctx.fillStyle = '#f5f0ea';
            ctx.fillRect(-s * 0.1, my - s * 0.085 * open + s * 0.005, s * 0.2, s * 0.03 * Math.min(1, open * 1.5));
        } else {
            ctx.strokeStyle = 'rgba(30,10,8,0.6)'; ctx.lineWidth = s * 0.018;
            ctx.beginPath(); ctx.moveTo(-s * 0.16, my); ctx.quadraticCurveTo(0, my + s * 0.035, s * 0.16, my); ctx.stroke();
        }
        ctx.restore();
    }

    // Slide timing: a number (seconds per slide) or a list of seconds, one per slide (narrated videos)
    const timesOf = (slides, per) => (Array.isArray(per) ? per : slides.map(() => per));
    const totalOf = (slides, per) => timesOf(slides, per).reduce((a, b) => a + b, 0);

    function draw(ctx, slides, t, per, pal, character, level = null) {
        const [a, b, ink, isNote] = pal;
        const times = timesOf(slides, per);
        const total = times.reduce((x, y) => x + y, 0);
        const time = Math.min(Math.max(0, t), total - 0.001); // the first animation frame can land a hair before zero
        let i = 0, start = 0;
        while (i < times.length - 1 && time >= start + times[i]) { start += times[i]; i++; }
        const local = (time - start) / times[i]; // 0..1 within this slide
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
            const human = character === 'woman' || character === 'man';
            // Presenters stand at the bottom edge (head and shoulders); the cartoon characters float
            if (slide.kind === 'title') drawCharacter(ctx, character, W - 190, human ? H - 360 : H - 330, human ? 120 : 115, t, false, true, level);
            else if (slide.kind === 'body') drawCharacter(ctx, character, human ? 190 : 200, human ? H - 300 : H - 270, human ? 120 : 115, t, revealing, false, level);
            else drawCharacter(ctx, character, W / 2, human ? H * 0.6 : H * 0.62, human ? 140 : 140, t, false, true, level);
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
        stopTaste();
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
        if ('speechSynthesis' in window) speechSynthesis.cancel();
        S.deviceSync = null;
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
            denoise: true, audience: 'friends', videoBlob: null, audioBlob: null, audioDuration: 0, narrate: 'off', tts: null
        };
        S.draftId = draftIdOf(n);
        const d = loadDraft(S.draftId);
        if (d && note.tab !== 'audio') {
            Object.assign(S, { character: d.character || S.character, narrate: d.narrate || 'off', look: LOOKS[d.look] !== undefined ? d.look : 'note', speed: SPEEDS[d.speed] ? d.speed : 'normal', voice: !!d.voice });
            if (trackOf(d.music)) S.bg.video.music = d.music;
            if (typeof d.volume === 'number') S.bg.video.volume = d.volume;
            S.restored = true;
        }
        paint();
        if (!dlg.open) dlg.showModal();
        checkTTS(); // find out early whether narrator voices are available
    }

    function paint() {
        stopAll();
        S.sheet = null;
        dlg.innerHTML = `
            <form method="dialog" class="nm-card" novalidate>
                <header class="nm-head">
                    <h3 id="nm-h">${S.tab === 'audio' ? 'Create note audio' : 'Create note video'}</h3>
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

    // ---------- Video: a small studio. Preview first, one row per choice, each opening its own sheet ----------
    const totalSecs = () => Math.round(slidesFor(S.note).length * SPEEDS[S.speed]);
    function videoHTML() {
        const secs = totalSecs();
        if (S.videoBlob) {
            return `
                <div class="nm-video nm-studio">
                    <div class="nm-stage"><video class="nm-canvas" src="${URL.createObjectURL(S.videoBlob)}" controls playsinline loop></video></div>
                    <div class="nm-side">
                        <div class="nm-ready" role="status">
                            <span class="nm-ready-ic" aria-hidden="true">${ic('i-check')}</span>
                            <span><strong>Your video is ready</strong><small>${S.videoSecs || secs} seconds · play it above</small></span>
                        </div>
                        <div class="nm-rows">
                            <button type="button" class="nm-row" data-nm="save-video"><span class="nm-row-k">Save to this device</span><span class="nm-row-v">${S.videoType === 'video/mp4' ? 'MP4' : 'WebM'}</span><span class="nm-chev" aria-hidden="true">›</span></button>
                            <button type="button" class="nm-row" data-nm="redo-video"><span class="nm-row-k">Change it</span><span class="nm-row-v">Back to the studio</span><span class="nm-chev" aria-hidden="true">›</span></button>
                        </div>
                    </div>
                </div>
                <footer class="nm-action"><button type="button" class="primary-btn nm-wide" data-nm="post-video">${ic('i-reel')}Post to the Feed as a reel</button></footer>`;
        }
        return `
            <div class="nm-video nm-studio">
                <div class="nm-stage">
                    <canvas class="nm-canvas" width="720" height="1280" aria-label="Video preview"></canvas>
                    <button type="button" class="nm-play" data-nm="preview" aria-label="${S.previewing ? 'Stop the preview' : 'Play the preview with sound'}">${S.previewing ? '<span class="nm-stop" aria-hidden="true"></span>' : ic('i-play')}<span>${S.previewing ? 'Stop' : 'Preview with sound'}</span></button>
                    <div class="nm-progress" hidden><span></span><small>Making your video…</small></div>
                </div>
                <div class="nm-side">${sideHTML()}</div>
            </div>
            <div class="nm-sheet-wrap" hidden></div>
            <footer class="nm-action">
                <p class="nm-meta">${metaText()}</p>
                <button type="button" class="primary-btn nm-wide" data-nm="make-video">${ic('i-sparkle')}<span>Create video</span></button>
            </footer>`;
    }
    const metaText = () => `${slidesFor(S.note).length} slides · ${narrating() ? 'as long as the narration' : `about ${totalSecs()} seconds`}`;
    function row(sheet, label, value, extra = '') {
        return `<div class="nm-row-wrap">
            <button type="button" class="nm-row" data-nm="sheet" data-sheet="${sheet}" aria-haspopup="dialog"><span class="nm-row-k">${label}</span><span class="nm-row-v">${value}</span><span class="nm-chev" aria-hidden="true">›</span></button>${extra}</div>`;
    }
    function musicLabel() {
        const m = M();
        if (m.music === 'mine') return `${ic('i-music')}${esc(S.musicName || 'Your audio')}`;
        const t = trackOf(m.music);
        return t && t[0] !== 'none' ? `<span class="nm-row-em" aria-hidden="true">${t[2]}</span>${t[1]}` : 'No music';
    }
    // The rows to the side of (or under) the preview: redrawn in place, so the preview keeps playing
    function sideHTML() {
        const ch = charOf(S.character);
        const [a, b] = palette(S.look, S.note.color);
        const rec = trackOf(S.recommended);
        const showRec = rec && M().music !== S.recommended && M().music !== 'mine';
        return `
            ${S.restored ? `<p class="nm-restored">${ic('i-check')}<span>Picked up where you left off</span><button type="button" class="link-btn" data-nm="reset">Start fresh</button></p>` : ''}
            ${showRec ? `<div class="nm-recommend"><span class="nm-row-em" aria-hidden="true">${rec[2]}</span><span><small>Recommended for this note</small><strong>${rec[1]}</strong></span><button type="button" class="nm-chip" data-nm="use-rec">Use</button></div>` : ''}
            <div class="nm-rows">
                ${row('character', 'Character', `<span class="nm-row-em" aria-hidden="true">${ch[2]}</span>${ch[0] === 'none' ? 'None' : ch[1]}`)}
                ${row('voice', 'Voice', VOICE_LABEL[S.narrate], S.narrate !== 'off' ? `<button type="button" class="nm-sample" data-nm="sample" data-voice="${S.narrate}" aria-label="Hear a sample of the ${S.narrate} voice">${ic('i-play')}</button>` : '')}
                ${row('music', 'Music', musicLabel())}
                ${row('look', 'Look', `<span class="nm-swatch" style="background:linear-gradient(135deg,${a},${b})" aria-hidden="true"></span>${LOOK_NAMES[S.look]}`)}
                ${row('advanced', 'Advanced settings', `${S.speed[0].toUpperCase() + S.speed.slice(1)} pace${S.voice && !narrating() ? ' · your voice' : ''}`)}
            </div>`;
    }
    function refreshSide() {
        const side = dlg.querySelector('.nm-studio .nm-side');
        if (side && !S.videoBlob) side.innerHTML = sideHTML();
        const meta = dlg.querySelector('.nm-action .nm-meta');
        if (meta) meta.textContent = metaText();
        const row = dlg.querySelector('.nm-audio [data-sheet="music"] .nm-row-v');
        if (row) row.innerHTML = musicLabel();
    }

    // ---------- Sheets ----------
    function sheetHTML(kind) {
        const head = title => `<div class="nm-grab" aria-hidden="true"><i></i></div><header class="nm-sheet-head"><h4 id="nm-sheet-h">${title}</h4><button type="button" class="nm-done-btn" data-nm="sheet-done">Done</button></header>`;
        const tick = on => (on ? `<span class="nm-tick" aria-hidden="true">${ic('i-check')}</span>` : '');
        if (kind === 'character') {
            return head('Choose a character') + CHAR_GROUPS.map(([g, keys]) => `
                <h5 class="nm-group">${g}</h5>
                <div class="nm-grid" role="radiogroup" aria-label="${g}">${keys.map(k => { const c = charOf(k); const on = S.character === k; return `
                    <button type="button" role="radio" aria-checked="${on}" class="nm-tile" data-nm="char" data-char="${k}">
                        <span class="nm-tile-av" aria-hidden="true">${c[2]}</span><strong>${k === 'none' ? 'No character' : c[1]}</strong><small>${CHAR_INFO[k]}</small>${tick(on)}
                    </button>`; }).join('')}</div>`).join('');
        }
        if (kind === 'voice') {
            return head('Narrator voice') + `
                <div class="nm-list" role="radiogroup" aria-label="Narrator voice">${VOICES.map(([k, name, desc]) => { const on = S.narrate === k; return `
                    <div class="nm-item${on ? ' on' : ''}">
                        <button type="button" role="radio" aria-checked="${on}" class="nm-item-main" data-nm="narrate" data-voice="${k}"><span><strong>${name}</strong><small>${desc}</small></span>${tick(on)}</button>
                        ${k !== 'off' ? `<button type="button" class="nm-item-play" data-nm="sample" data-voice="${k}" aria-label="Hear a sample of the ${name.toLowerCase()} voice">${ic('i-play')}</button>` : ''}
                    </div>`; }).join('')}</div>
                <p class="nm-hint">${ttsReady === false
                    ? 'Samples and previews use this device’s voice. Putting the voice inside the saved video needs Cordial’s voice service — until then the presenter mouths the words, or turn on “Add my voice” in Advanced settings and read it yourself.'
                    : 'Samples use this device’s voice; your video is read in Cordial’s natural voice, and each slide stays up as long as it’s being read.'}</p>`;
        }
        if (kind === 'music') {
            const m = M();
            const list = TRACKS.map(([k, name, emoji]) => { const on = m.music === k; const tasting = S.tasting === k; return `
                <div class="nm-item${on ? ' on' : ''}">
                    ${k !== 'none' ? `<button type="button" class="nm-item-play${tasting ? ' playing' : ''}" data-nm="taste" data-music="${k}" aria-label="${tasting ? 'Stop' : 'Hear'} ${name}">${tasting ? '<span class="nm-stop" aria-hidden="true"></span>' : ic('i-play')}</button>` : `<span class="nm-item-play ghost" aria-hidden="true">${ic('i-volume-off')}</span>`}
                    <button type="button" role="radio" aria-checked="${on}" class="nm-item-main" data-nm="music" data-music="${k}"><span><strong>${name}${k === S.recommended && S.tab !== 'audio' ? ' <em class="nm-pick">Recommended</em>' : ''}</strong><small>${TRACK_MOOD[k]}${k !== 'none' ? ' · loops to fit' : ''}</small></span>${tick(on)}</button>
                </div>`; }).join('');
            const mine = m.music === 'mine' && S.musicFile;
            return head(S.tab === 'audio' ? 'Background music' : 'Music') + `
                <div class="nm-list" role="radiogroup" aria-label="Music">${list}</div>
                ${mine ? `
                    <div class="nm-item on nm-mine"><span class="nm-item-play ghost" aria-hidden="true">${ic('i-music')}</span><span class="nm-item-main static"><span><strong>${esc(S.musicName)}</strong><small>Your audio</small></span>${tick(true)}</span></div>
                    <div class="nm-mine-acts"><button type="button" class="nm-chip" data-nm="upload">Replace</button><button type="button" class="nm-chip" data-nm="music" data-music="none">Remove</button></div>`
                    : `<button type="button" class="nm-add" data-nm="upload">${ic('i-plus')}<span><strong>Add from device</strong><small>MP3, M4A or WAV · up to 20 MB</small></span></button>`}
                ${m.music !== 'none' ? `<label class="nm-volume"><span>Music volume <output>${Math.round(m.volume * 100)}%</output></span><input type="range" min="0" max="1.5" step="0.05" value="${m.volume}" data-nm="volume" aria-label="Music volume"></label>` : ''}`;
        }
        if (kind === 'look') {
            return head('Look') + `
                <div class="nm-looks2" role="radiogroup" aria-label="Look">${Object.keys(LOOKS).map(k => { const [a, b, c] = palette(k, S.note.color); const on = S.look === k; return `
                    <button type="button" role="radio" aria-checked="${on}" class="nm-look-tile" data-nm="look" data-look="${k}">
                        <span class="nm-look-thumb" style="background:linear-gradient(160deg,${a},${b});color:${c || '#fff'}"><b>Aa</b><i></i><i></i></span>
                        <span>${LOOK_NAMES[k]}</span>${tick(on)}
                    </button>`; }).join('')}</div>`;
        }
        // Advanced
        return head('Advanced settings') + `
            <div class="field"><span>Pace</span>
                <div class="nm-seg" role="radiogroup" aria-label="Pace">${Object.keys(SPEEDS).map(k => `<button type="button" role="radio" aria-checked="${S.speed === k}" data-nm="speed" data-speed="${k}">${k[0].toUpperCase() + k.slice(1)}</button>`).join('')}</div>
            </div>
            <label class="nm-switch"><input type="checkbox" data-nm="voice"${S.voice && !narrating() ? ' checked' : ''}${narrating() ? ' disabled' : ''}><span><strong>Add my voice</strong>${narrating() ? '<small>Off while the narrator reads your note.</small>' : ''}<small>Read along while it records — the slides are your prompt. Background noise is filtered out${M().music !== 'none' ? ', and the music dips under you (use headphones to hear it)' : ''}.</small></span></label>
            <button type="button" class="nm-reset" data-nm="reset">Reset all settings</button>`;
    }
    function openSheet(kind) {
        const wrap = dlg.querySelector('.nm-sheet-wrap');
        if (!wrap) return;
        S.sheet = kind;
        wrap.innerHTML = `<div class="nm-sheet-back" data-nm="sheet-done"></div><div class="nm-sheet" role="dialog" aria-modal="true" aria-labelledby="nm-sheet-h">${sheetHTML(kind)}</div>`;
        wrap.hidden = false;
        dragToClose(wrap.querySelector('.nm-sheet'));
        (wrap.querySelector('[aria-checked="true"]') || wrap.querySelector('.nm-done-btn'))?.focus({ preventScroll: true });
    }
    function refreshSheet() {
        const sh = dlg.querySelector('.nm-sheet');
        if (!S.sheet || !sh) return;
        const top = sh.scrollTop;
        sh.innerHTML = sheetHTML(S.sheet);
        sh.scrollTop = top;
    }
    function closeSheet() {
        const wrap = dlg.querySelector('.nm-sheet-wrap');
        const was = S.sheet;
        S.sheet = null;
        stopTaste();
        if (!wrap || wrap.hidden) return;
        wrap.classList.add('closing');
        setTimeout(() => { wrap.hidden = true; wrap.classList.remove('closing'); wrap.innerHTML = ''; }, 200);
        dlg.querySelector(`[data-sheet="${was}"]`)?.focus({ preventScroll: true });
    }
    function dragToClose(card) {
        if (!card) return;
        let d = null;
        card.addEventListener('pointerdown', e => {
            if (!e.target.closest('.nm-grab, .nm-sheet-head') || e.target.closest('button')) return;
            d = { y0: e.clientY, t0: e.timeStamp, id: e.pointerId, y: 0 };
            card.setPointerCapture(e.pointerId);
            card.style.transition = 'none';
        });
        card.addEventListener('pointermove', e => {
            if (!d || e.pointerId !== d.id) return;
            d.y = Math.max(0, e.clientY - d.y0);
            card.style.transform = `translateY(${d.y}px)`;
        });
        const end = e => {
            if (!d || e.pointerId !== d.id) return;
            const g = d;
            d = null;
            card.style.transition = '';
            const v = (g.y / Math.max(1, e.timeStamp - g.t0)) * 1000;
            if (g.y > 90 || v > 800) closeSheet();
            else card.style.transform = '';
        };
        card.addEventListener('pointerup', end);
        card.addEventListener('pointercancel', end);
    }

    // A choice changed: keep it, redraw what shows it, and let the preview pick it up straight away
    function changed() {
        saveDraft();
        if (S.restored) S.restored = false;
        if (!S.sheet) return paint();
        refreshSheet();
        refreshSide();
        if (S.tab === 'video' && !S.previewing) { cancelAnimationFrame(S.raf); startPreview(false); }
    }

    // ---------- Hearing things before choosing them ----------
    function taste(kind) {
        if (!AC) return;
        const was = S.tasting;
        stopTaste();
        if (was === kind) return refreshSheet();
        stopSound();
        refreshPlay();
        const ac = S.tasteAc = new AC();
        const g = ac.createGain();
        g.gain.value = Math.max(0.3, M().volume);
        g.connect(ac.destination);
        S.tasteEngine = musicEngine(ac, g, kind);
        S.tasting = kind;
        S.tasteTimer = setTimeout(() => { stopTaste(); refreshSheet(); }, 8000);
        refreshSheet();
    }
    function stopTaste() {
        if (!S) return;
        clearTimeout(S.tasteTimer);
        if (S.tasteEngine) { S.tasteEngine.stop(); S.tasteEngine = null; }
        if (S.tasteAc) { const a = S.tasteAc; S.tasteAc = null; setTimeout(() => a.close().catch(() => {}), 400); }
        S.tasting = null;
    }
    function sample(gender) {
        if (!('speechSynthesis' in window)) return app.showToast('Voice samples aren’t supported in this browser');
        stopTaste();
        stopSound();
        refreshPlay();
        const first = slidesFor(S.note).find(sl => sl.kind !== 'end');
        const text = String(first ? first.text : 'This is how your note will sound.').split(/(?<=[.!?])\s/)[0].slice(0, 160);
        const u = new SpeechSynthesisUtterance(text);
        const voice = deviceVoice(gender);
        if (voice) { u.voice = voice; u.lang = voice.lang; }
        u.rate = 0.98;
        u.pitch = gender === 'female' ? (voice && FEMALE.test(voice.name) ? 1 : 1.25) : (voice && MALE.test(voice.name) ? 1 : 0.8);
        speechSynthesis.cancel();
        speechSynthesis.speak(u);
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

    const narrating = () => S.narrate !== 'off' && ttsReady !== false;

    async function startPreview(withSound) {
        const canvas = dlg.querySelector('canvas.nm-canvas');
        if (!canvas) return;
        const ctx = canvas.getContext('2d');
        const slides = slidesFor(S.note);
        let per = SPEEDS[S.speed];
        const pal = palette(S.look, S.note.color);
        const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        let level = null;
        if (withSound && AC) {
            const ac = S.ac = new AC(); // made on the tap, before any waiting, so phones allow sound
            S.previewing = true;
            if (narrating()) {
                const play = dlg.querySelector('.nm-play span');
                if (play) play.textContent = 'Getting the voice…';
                try {
                    const buffer = await ac.decodeAudioData((await narration(slides)).slice(0));
                    if (S.ac !== ac) return; // stopped while waiting
                    per = narratedTimes(slides, buffer.duration + 0.4);
                    const src = ac.createBufferSource();
                    src.buffer = buffer;
                    const g = ac.createGain();
                    g.gain.value = 1.4;
                    src.connect(g);
                    g.connect(ac.destination);
                    level = levelMeter(ac, g);
                    src.start(ac.currentTime + 0.4);
                } catch (e) {
                    app.showToast(e.message || 'Couldn’t get the narrator’s voice');
                }
                refreshPlay();
            } else if (S.narrate !== 'off' && 'speechSynthesis' in window) {
                // Rough timing up front; each slide re-syncs the moment its sentence starts being spoken
                per = slides.map(sl => (sl.kind === 'end' ? 3 : Math.max(2, String(sl.text).split(/\s+/).length / 2.4 + 0.8)));
                let speaking = false;
                S.deviceSync = null;
                speakSlides(slides, S.narrate, k => { S.deviceSync = k; }, on => { speaking = on; });
                level = () => (speaking ? 0.3 + 0.6 * Math.abs(Math.sin(performance.now() / 1000 * 13)) * (0.6 + 0.4 * Math.sin(performance.now() / 190)) : 0);
            }
            if (S.ac !== ac) return;
            startMusic(ac, ac.destination);
        }
        cancelAnimationFrame(S.raf);
        const total = totalOf(slides, per);
        const t0 = performance.now();
        let start = t0;
        const loop = now => {
            // Device narration: jump to the slide whose sentence just started
            if (S.deviceSync !== null && S.deviceSync !== undefined) {
                const k = S.deviceSync;
                S.deviceSync = null;
                start = now - timesOf(slides, per).slice(0, k).reduce((x, y) => x + y, 0) * 1000;
            }
            const t = reduce && !withSound ? timesOf(slides, per)[0] * 0.8 : ((now - start) / 1000) % total;
            const lv = level ? level() : null;
            if (S.musicGain && level && S.ac) S.musicGain.gain.setTargetAtTime(lv > 0.05 ? M().volume * 0.35 : M().volume, S.ac.currentTime, 0.1);
            draw(ctx, slides, t, per, pal, S.character, lv);
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
        // The audio context is made on the tap, before any waiting, so phones allow sound
        const ac = AC && (S.voice || S.narrate !== 'off' || M().music !== 'none') ? new AC() : null;
        await checkTTS();
        const narrate = narrating();
        const useVoice = S.voice && !narrate;
        const slides = slidesFor(S.note);
        let per = SPEEDS[S.speed];
        const bar = dlg.querySelector('.nm-progress');
        const controls = dlg.querySelector('.nm-side');
        const go = dlg.querySelector('[data-nm="make-video"]');
        bar.hidden = false;
        dlg.querySelector('.nm-play').hidden = true;
        controls.classList.add('busy');
        if (go) { go.disabled = true; go.querySelector('span').textContent = 'Creating your video…'; }
        const fail = msg => {
            bar.hidden = true;
            dlg.querySelector('.nm-play').hidden = false;
            controls.classList.remove('busy');
            if (go) { go.disabled = false; go.querySelector('span').textContent = 'Create video'; }
            if (ac) ac.close().catch(() => {});
            app.showToast(msg);
            startPreview(false);
        };

        // The narrator's voice first: its length sets how long each slide stays up
        let voiceBuffer = null;
        if (narrate && ac) {
            bar.querySelector('small').textContent = 'Getting the narrator’s voice…';
            try {
                voiceBuffer = await ac.decodeAudioData((await narration(slides)).slice(0));
                per = narratedTimes(slides, voiceBuffer.duration + 0.4);
            } catch (e) {
                return fail(e.message || 'Couldn’t get the narrator’s voice — try again');
            }
        }

        let mic = null;
        if (useVoice) {
            try { mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } }); }
            catch (e) { return fail('Allow the microphone to add your voice — or switch “Add my voice” off'); }
        }
        const stream = canvas.captureStream(30);
        let level = null;
        let voiceSrc = null;
        if (ac) {
            S.ac = ac;
            const dest = ac.createMediaStreamDestination();
            const mix = mixBus(ac, dest);
            S.fading = false;
            startMusic(ac, mix);
            // Hear the music while it records — unless you're reading along (it would leak into the microphone)
            if (S.musicGain && !mic) S.musicGain.connect(ac.destination);
            if (mic) {
                addVoice(ac, mic, mix, true, (lv, open) => { S.liveLevel = open ? lv : 0; });
                level = () => S.liveLevel || 0;
            }
            if (voiceBuffer) {
                voiceSrc = ac.createBufferSource();
                voiceSrc.buffer = voiceBuffer;
                const g = ac.createGain();
                g.gain.value = 1.4;
                voiceSrc.connect(g);
                g.connect(mix);
                g.connect(ac.destination); // you hear the narrator while it records
                level = levelMeter(ac, g);
            }
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
        const total = totalOf(slides, per);
        const pal = palette(S.look, S.note.color);
        bar.querySelector('small').textContent = useVoice ? 'Recording — read along now 🎙️' : 'Making your video…';

        const done = new Promise(resolve => { recorder.onstop = resolve; });
        recorder.start(500);
        if (voiceSrc) voiceSrc.start(ac.currentTime + 0.4);
        const t0 = performance.now();
        const frame = now => {
            const t = (now - t0) / 1000;
            const lv = level ? level() : null;
            // The music dips while the narrator speaks
            if (voiceSrc && S.musicGain && !S.fading) S.musicGain.gain.setTargetAtTime(lv > 0.05 ? M().volume * 0.35 : M().volume, ac.currentTime, 0.1);
            draw(ctx, slides, t, per, pal, S.character, lv);
            const pct = Math.min(100, (t / total) * 100);
            bar.querySelector('span').style.width = `${pct}%`;
            if (go) go.querySelector('span').textContent = `Creating your video… ${Math.round(pct)}%`;
            if (S.musicGain && t > total - 1.2 && !S.fading) { S.fading = true; S.musicGain.gain.setTargetAtTime(0.0001, S.ac.currentTime, 0.35); } // fade the music out at the end
            if (t < total + 0.3) S.raf = requestAnimationFrame(frame);
            else if (recorder.state !== 'inactive') recorder.stop();
        };
        S.raf = requestAnimationFrame(frame);
        await done;
        stream.getTracks().forEach(t => t.stop());
        if (mic) mic.getTracks().forEach(t => t.stop());
        S.stream = S.mic = null;
        S.liveLevel = 0;
        stopSound();
        if (S.cancelled || !chunks.length) return;
        const type = (recorder.mimeType || mime || 'video/webm').split(';')[0];
        S.videoBlob = new Blob(chunks, { type });
        S.videoType = type;
        S.videoSecs = Math.round(total);
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
            if (S.sheet) { refreshSheet(); refreshSide(); } else paint();
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
                    <div class="nm-rows">${row('music', 'Background music', musicLabel())}</div>
                    ${M().music !== 'none' ? '<p class="nm-meta">The music is mixed in under your voice and dips while you speak. Use headphones to hear it as you record.</p>' : ''}
                    <div class="nm-meter" aria-hidden="true"><i></i><span class="nm-gate">Listening…</span></div>
                    <div class="nm-rec-row">
                        <span class="nm-timer" aria-live="off">0:00</span>
                        <button type="button" class="nm-rec" data-nm="record" aria-label="Start recording">${ic('i-mic')}</button>
                        <span class="nm-timer-cap">max 10 min</span>
                    </div>
                    <p class="nm-meta">Tap record and read your note aloud. It scrolls as you go.</p>`}
            </div>
            <div class="nm-sheet-wrap" hidden></div>`;
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
            await app.createEntry({ title, text: S.note.text, shared: true, color: S.note.color, audience: S.audience === 'public' ? 'public' : 'friends', origin: 'post' }, [file]);
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
        else if (what === 'sheet') openSheet(el.dataset.sheet);
        else if (what === 'sheet-done') closeSheet();
        else if (what === 'taste') taste(el.dataset.music);
        else if (what === 'sample') sample(el.dataset.voice);
        else if (what === 'use-rec') { M().music = S.recommended; changed(); refreshSide(); audition(); }
        else if (what === 'reset') {
            const custom = S.character !== 'buddy' || S.narrate !== 'off' || S.look !== 'note' || S.speed !== 'normal' || S.voice || M().music !== S.recommended;
            if (custom && !(await app.ask({ title: 'Reset all settings?', text: 'Character, voice, music, look and pace go back to Cordial’s suggestions for this note.', ok: 'Reset' }))) return;
            Object.assign(S, { character: 'buddy', narrate: 'off', look: 'note', speed: 'normal', voice: false, restored: false, sheet: null });
            S.bg.video = { music: S.recommended, volume: 1 };
            dropDraft();
            paint();
        }
        else if (what === 'tab') { if (S.recorder && S.recorder.state === 'recording') return; S.tab = el.dataset.tab; paint(); }
        else if (what === 'look') { S.look = el.dataset.look; changed(); }
        else if (what === 'speed') { S.speed = el.dataset.speed; changed(); }
        else if (what === 'char') {
            S.character = el.dataset.char;
            // A presenter reads in their own voice (when voices are available)
            if (PRESENTER_VOICE[S.character]) { await checkTTS(); S.narrate = PRESENTER_VOICE[S.character]; }
            changed();
        } else if (what === 'narrate') { S.narrate = el.dataset.voice; await checkTTS(); changed(); }
        else if (what === 'music') {
            stopTaste();
            M().music = el.dataset.music;
            changed();
            audition();
        } else if (what === 'upload') pickMusic();
        else if (what === 'preview') {
            const playing = S.previewing;
            stopAll();
            startPreview(!playing);
            refreshPlay();
            if (!playing && M().music === 'none') app.showToast('Pick some music to hear it — or add your voice when you make the video');
        } else if (what === 'make-video') makeVideo();
        else if (what === 'redo-video') { S.videoBlob = null; S.sheet = null; paint(); }
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
            clearTimeout(S.volSave);
            S.volSave = setTimeout(saveDraft, 400);
        }
    });
    dlg.addEventListener('change', e => {
        if (e.target.dataset.nm === 'voice') { S.voice = e.target.checked; saveDraft(); refreshSide(); }
        if (e.target.dataset.nm === 'denoise') S.denoise = e.target.checked;
    });
    dlg.addEventListener('close', () => { stopAll(); });
    dlg.addEventListener('cancel', e => {
        if (S && S.recorder && S.recorder.state === 'recording') return e.preventDefault();
        if (S && S.sheet) { e.preventDefault(); closeSheet(); } // Escape closes the open sheet first
    });

    // ---------- Picking a note (from the Feed) ----------
    function pickNote(anchor) {
        const notes = (app.getNotes() || []).filter(n => !n.trashedAt && !n.archived && n.origin !== 'post' && (String(n.text || '').trim() || String(n.title || '').trim()))
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
