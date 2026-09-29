/* Cordial — read aloud (text-to-speech) module.
 * Exposes a single global: window.Speak (see API below). No dependencies.
 *
 *   Speak.supported                     boolean
 *   Speak.read(text, { title, lang })   read text aloud + show the mini player (replaces current reading)
 *   Speak.pause() / resume() / stop()
 *   Speak.isSpeaking()                  true while a reading session is active (also while paused)
 *   Speak.getPrefs() / setPrefs(p)      { voice: 'female'|'male', rate: 0.75–1.5 } in localStorage 'diarySpeak'
 *   Speak.voiceNames()                  { female, male } real voice names that will be used, or null
 *   Speak.onchange                      optional callback({ speaking, paused })
 */
(function () {
    'use strict';

    var synth = window.speechSynthesis;
    var supported = !!(synth && typeof window.SpeechSynthesisUtterance === 'function');

    var STORE_KEY = 'diarySpeak';
    var MAX_CHUNK = 200;
    var RATES = [0.75, 1, 1.25, 1.5];
    var ua = navigator.userAgent || '';
    var isAndroid = /Android/i.test(ua);
    // Chromium desktop (Chrome, Edge, Opera, Brave…) — has the "stops after ~15s" bug.
    var isChromeDesktop = /Chrome\//.test(ua) && !isAndroid && !/Mobile/i.test(ua);

    /* ------------------------------------------------------------------ prefs */
    function readPrefs() {
        var p = { voice: 'female', rate: 1 };
        try {
            var raw = JSON.parse(localStorage.getItem(STORE_KEY) || 'null');
            if (raw && typeof raw === 'object') {
                if (raw.voice === 'male' || raw.voice === 'female') p.voice = raw.voice;
                if (typeof raw.rate === 'number' && isFinite(raw.rate)) p.rate = clampRate(raw.rate);
            }
        } catch (e) { /* storage blocked or bad JSON */ }
        return p;
    }
    function clampRate(r) { return Math.min(1.5, Math.max(0.75, Math.round(r * 100) / 100)); }
    var prefs = readPrefs();
    function savePrefs() {
        try { localStorage.setItem(STORE_KEY, JSON.stringify(prefs)); } catch (e) { /* ignore */ }
    }

    /* ----------------------------------------------------------------- voices */
    var FEMALE = ['female', 'samantha', 'victoria', 'karen', 'moira', 'tessa', 'fiona', 'serena', 'zira',
        'jenny', 'aria', 'sonia', 'libby', 'natasha', 'clara', 'hazel', 'susan', 'catherine', 'heera', 'ava',
        'allison', 'emma', 'joanna', 'salli', 'kendra', 'kimberly', 'ivy', 'amy', 'michelle', 'emily', 'jessica',
        'nancy', 'sara', 'sarah', 'elizabeth', 'linda', 'heather', 'eva', 'kate', 'veena', 'lekha', 'neerja',
        'isla', 'maisie', 'bella', 'hollie', 'abbi', 'olivia', 'jane', 'ashley', 'cora', 'monica',
        'amelie', 'audrey', 'aurelie', 'julie', 'hortense', 'denise', 'anna', 'petra', 'katja', 'hedda',
        'marlene', 'vicki', 'helena', 'laura', 'lucia', 'paulina', 'elvira', 'dalia', 'luciana', 'francisca',
        'raquel', 'alice', 'elsa', 'isabella', 'joana', 'ellen', 'yuna', 'sunhi', 'kyoko', 'nanami', 'haruka',
        'ayumi', 'tingting', 'ting-ting', 'meijia', 'mei-jia', 'sinji', 'sin-ji', 'xiaoxiao', 'huihui', 'yaoyao',
        'milena', 'svetlana', 'irina', 'katya', 'zuzana', 'nora', 'ioana', 'dariya', 'yelda', 'carmit',
        'swara', 'kalpana', 'google us english', 'google uk english female'];
    var MALE = ['male', 'daniel', 'alex', 'fred', 'tom', 'aaron', 'arthur', 'oliver', 'rishi', 'gordon', 'david',
        'mark', 'guy', 'ryan', 'thomas', 'george', 'christopher', 'eric', 'roger', 'steffan', 'brian', 'matthew',
        'justin', 'joey', 'james', 'william', 'richard', 'sean', 'liam', 'andrew', 'davis', 'tony', 'jason',
        'brandon', 'connor', 'mitchell', 'prabhat', 'ravi', 'hemant', 'kevin', 'russell', 'lee', 'nicolas',
        'henri', 'paul', 'jacques', 'thierry', 'markus', 'stefan', 'conrad', 'killian', 'jorge', 'diego',
        'pablo', 'alvaro', 'raul', 'juan', 'carlos', 'luca', 'cosimo', 'diego', 'antonio', 'otoya', 'keita',
        'ichiro', 'yuri', 'pavel', 'dmitry', 'maged', 'xander', 'kangkang', 'yunyang', 'yunxi', 'google uk english male'];

    function listRe(list) {
        return new RegExp('(?:^|[^a-z])(?:' + list.map(function (n) {
            return n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        }).join('|') + ')(?![a-z])', 'i');
    }
    var FEMALE_RE = listRe(FEMALE);
    var MALE_RE = listRe(MALE);
    var NOVELTY_RE = /\b(albert|bad news|bahh|bells|boing|bubbles|cellos|wobble|good news|jester|organ|superstar|trinoids|whisper|zarvox|deranged|hysterical|junior|ralph|kathy|princess)\b/i;

    function genderOf(v) {
        var name = v.name || '';
        if (/(?:^|[^a-z])female(?![a-z])/i.test(name)) return 'female';
        if (/(?:^|[^a-z])male(?![a-z])/i.test(name)) return 'male';
        if (/^google us english$/i.test(name.trim())) return 'female';
        // Strip the vendor/language tail so e.g. "English (United States)" never matches a name.
        var core = name.replace(/\s+-\s+.*$/, '').replace(/\(.*?\)/g, ' ');
        var f = FEMALE_RE.test(core), m = MALE_RE.test(core);
        if (f && !m) return 'female';
        if (m && !f) return 'male';
        return null;
    }

    function qualityOf(v, fullLang) {
        var name = v.name || '', s = 0;
        if (/natural|neural|online|premium|enhanced|wavenet|studio|siri/i.test(name)) s += 4;
        if (/^google/i.test(name)) s += 1;
        if (fullLang && normLang(v.lang) === fullLang) s += 3;
        if (v.localService === false) s += 0.5;
        if (v['default']) s += 1;
        if (/multilingual/i.test(name)) s -= 1; // may switch accent on short mixed-language chunks
        if (/compact|eloquence|espeak/i.test(name)) s -= 3;
        if (NOVELTY_RE.test(name)) s -= 6;
        return s;
    }

    function normLang(l) { return String(l || '').replace('_', '-').toLowerCase(); }

    function targetLang(lang) {
        var l = normLang(lang || document.documentElement.getAttribute('lang') || navigator.language || 'en');
        if (!/^[a-z]{2,3}(-|$)/.test(l)) l = 'en';
        // Bare "en" → use the browser's regional variant if it is English, else en-US.
        if (l.indexOf('-') < 0) {
            var nav = normLang(navigator.language);
            l = nav.indexOf(l + '-') === 0 ? nav : (l === 'en' ? 'en-us' : l);
        }
        return l;
    }

    var voices = [];
    var pickCache = {};
    function loadVoices() {
        if (!supported) return;
        try { voices = synth.getVoices() || []; } catch (e) { voices = []; }
        pickCache = {};
    }

    // Returns { voice, pitch, exact } for a gender + language.
    function pick(gender, lang) {
        var full = targetLang(lang);
        var key = gender + '|' + full;
        if (pickCache[key]) return pickCache[key];
        if (!voices.length) loadVoices();
        var base = full.split('-')[0];
        var pool = voices.filter(function (v) { return normLang(v.lang).split('-')[0] === base; });
        if (!pool.length && base !== 'en') {
            full = 'en-us';
            pool = voices.filter(function (v) { return normLang(v.lang).split('-')[0] === 'en'; });
        }
        if (!pool.length) pool = voices.slice();
        var shift = gender === 'male' ? 0.8 : 1.1;
        var res = { voice: null, pitch: shift, exact: false, lang: full };
        if (pool.length) {
            var best = null, bestScore = -Infinity, exact = false;
            pool.forEach(function (v) {
                var g = genderOf(v);
                var score = qualityOf(v, full) + (g === gender ? 100 : g === null ? 0 : -3);
                if (score > bestScore) { bestScore = score; best = v; exact = g === gender; }
            });
            res.voice = best;
            res.exact = exact;
            res.pitch = exact ? 1 : shift;
            res.lang = best.lang || full;
        }
        if (voices.length) pickCache[key] = res;
        return res;
    }

    function shortName(v) {
        if (!v) return null;
        return String(v.name)
            .replace(/\s+-\s+.*$/, '')
            .replace(/\((natural|neural|enhanced|premium)\)/ig, '')
            .replace(/\bonline\b/ig, '')
            .replace(/\s{2,}/g, ' ')
            .trim();
    }

    /* ------------------------------------------------------------- text prep */
    var ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', hellip: '…', mdash: '—', ndash: '–', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“' };
    var PICTO_RE, PICTO_OK = false;
    try { PICTO_RE = new RegExp('\\p{Extended_Pictographic}(?:\\uFE0F|\\u200D\\p{Extended_Pictographic}|[\\u{1F3FB}-\\u{1F3FF}])*', 'gu'); PICTO_OK = true; } catch (e) { /* old engine */ }
    var WORDY_RE;
    try { WORDY_RE = new RegExp('[\\p{L}\\p{N}]', 'u'); } catch (e) { WORDY_RE = /[A-Za-z0-9\u00c0-\uffff]/; }
    var HASHTAG_RE;
    try { HASHTAG_RE = new RegExp('(^|[^\\p{L}\\p{N}_&])#([\\p{L}\\p{N}_]+)', 'gu'); } catch (e) { HASHTAG_RE = /(^|[^\w&])#(\w+)/g; }

    function clean(text) {
        var t = String(text == null ? '' : text);
        t = t.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
            .replace(/<br\s*\/?>|<\/(?:p|div|li|h[1-6]|blockquote|tr)>/gi, '\n')
            .replace(/<[^>]+>/g, ' ')
            .replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, function (m, e) {
                if (e[0] === '#') {
                    var n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
                    try { return String.fromCodePoint(n); } catch (x) { return ' '; }
                }
                return Object.prototype.hasOwnProperty.call(ENTITIES, e.toLowerCase()) ? ENTITIES[e.toLowerCase()] : m;
            })
            .replace(/\r\n?/g, '\n')
            .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')           // markdown images
            .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')            // markdown links
            .replace(/\bhttps?:\/\/[^\s<>"')]+|\bwww\.[^\s<>"')]+/gi, ' link ')
            .replace(/^[ \t]{0,3}#{1,6}[ \t]+/gm, '')           // headings
            .replace(/^[ \t]*>[ \t]?/gm, '')                    // blockquotes
            .replace(/^[ \t]*(?:[-*+•▪◦]|\d{1,3}[.)])[ \t]+/gm, '') // list markers
            .replace(/(\*\*|__|~~|`+)/g, '')                    // bold / strike / code
            .replace(/(^|[^\w*])[*_]([^*_\n]+)[*_](?![\w*])/g, '$1$2') // *italic* _italic_
            .replace(/[-_=*~]{3,}/g, ' ')                       // separators
            .replace(HASHTAG_RE, '$1$2');                       // #tag -> tag
        if (PICTO_OK) t = t.replace(PICTO_RE, ' ');
        t = t.replace(/[︎️‍]/g, '')
            .replace(/([!?])[!?]+/g, '$1')
            .replace(/[ \t\f\v  -​  　]+/g, ' ')
            .replace(/ *\n */g, '\n')
            .trim();
        return t;
    }

    function sentences(block, lang) {
        if (typeof Intl !== 'undefined' && Intl.Segmenter) {
            try {
                var seg = new Intl.Segmenter(lang || undefined, { granularity: 'sentence' });
                var out = [];
                var it = seg.segment(block)[Symbol.iterator](), r;
                while (!(r = it.next()).done) {
                    var s = r.value.segment.trim();
                    if (s) out.push(s);
                }
                return out;
            } catch (e) { /* fall through */ }
        }
        return (block.match(/[^.!?…。！？]+(?:[.!?…。！？]+["'”’)\]]*|$)\s*/g) || [block])
            .map(function (s) { return s.trim(); }).filter(Boolean);
    }

    // Break one over-long sentence at clause punctuation, else at spaces. Never mid-word
    // (unless a single "word" is itself longer than the limit).
    function splitLong(s, max) {
        var out = [];
        while (s.length > max) {
            var head = s.slice(0, max + 1), cut = -1, m, re = /[,;:—–)](?=\s)|\s[-–—]\s/g;
            while ((m = re.exec(head))) { if (m.index + m[0].length <= max && m.index >= max * 0.4) cut = m.index + m[0].length; }
            if (cut < 0) cut = head.lastIndexOf(' ');
            if (cut <= 0) { cut = max; out.push(s.slice(0, cut)); s = s.slice(cut).trim(); continue; }
            out.push(s.slice(0, cut).trim());
            s = s.slice(cut).trim();
        }
        if (s) out.push(s);
        return out;
    }

    function chunk(text, lang) {
        var cleaned = clean(text);
        if (!cleaned) return [];
        var chunks = [];
        cleaned.split(/\n+/).forEach(function (block) {
            block = block.trim();
            if (!block) return;
            var cur = '';
            sentences(block, lang).forEach(function (s) {
                splitLong(s, MAX_CHUNK).forEach(function (piece) {
                    if (!cur) cur = piece;
                    else if (cur.length + 1 + piece.length <= MAX_CHUNK) cur += ' ' + piece;
                    else { chunks.push(cur); cur = piece; }
                });
            });
            if (cur) chunks.push(cur);
        });
        return chunks.filter(function (c) { return WORDY_RE.test(c); });
    }

    /* ------------------------------------------------------------------ state */
    var st = {
        active: false, paused: false, chunks: [], idx: 0, title: '', lang: null,
        token: 0, utter: null, lastStart: 0, stall: 0, ticks: 0, returnFocus: null,
        softPaused: false // Android: pause implemented as cancel + restart chunk
    };
    var timer = null;

    function emit() {
        var detail = { speaking: st.active, paused: st.active && st.paused };
        render();
        if (typeof api.onchange === 'function') {
            try { api.onchange(detail); } catch (e) { setTimeout(function () { throw e; }); }
        }
    }

    function speakChunk(i) {
        if (!st.active) return;
        if (i >= st.chunks.length) { finish(); return; }
        st.idx = i;
        var my = ++st.token;
        var p = pick(prefs.voice, st.lang);
        var u = new SpeechSynthesisUtterance(st.chunks[i]);
        if (p.voice) u.voice = p.voice;
        u.lang = p.lang;
        u.rate = prefs.rate;
        u.pitch = p.pitch;
        u.volume = 1;
        u.onstart = function () { if (my === st.token) { st.lastStart = Date.now(); st.stall = 0; } };
        u.onend = function () { if (my === st.token && !st.paused) advance(); };
        u.onerror = function (e) {
            if (my !== st.token) return;
            var err = e && e.error;
            if (err === 'interrupted' || err === 'canceled') return;
            if (err === 'not-allowed' || err === 'synthesis-unavailable' || err === 'audio-busy') { stop(); return; }
            advance();
        };
        st.utter = u; // keep a reference: Chrome GCs utterances and never fires onend
        st.lastStart = Date.now();
        st.stall = 0;
        synth.speak(u);
        render();
    }

    function advance() {
        if (!st.active) return;
        if (st.idx + 1 >= st.chunks.length) finish();
        else speakChunk(st.idx + 1);
    }

    // Cancel whatever is speaking and restart the current chunk (voice / rate changes, Android resume).
    function restart() {
        if (!st.active) return;
        st.token++;
        try { synth.cancel(); } catch (e) { /* ignore */ }
        var idx = st.idx;
        // A short delay: Chrome and Safari may drop a speak() issued right after cancel().
        setTimeout(function () { if (st.active && !st.paused) speakChunk(idx); }, 60);
    }

    function finish() {
        st.token++;
        st.active = false;
        st.paused = false;
        st.utter = null;
        stopTimer();
        hidePlayer();
        emit();
    }

    function startTimer() {
        if (timer) return;
        timer = setInterval(function () {
            if (!st.active || st.paused) return;
            st.ticks++;
            // Chrome desktop: nudging resume() keeps long sessions alive when the tab is idle.
            if (isChromeDesktop && st.ticks % 10 === 0 && synth.speaking) { try { synth.resume(); } catch (e) { /* */ } }
            // Watchdog: an engine that silently drops an utterance never fires onend.
            if (!synth.speaking && !synth.pending && Date.now() - st.lastStart > 1500) {
                if (++st.stall >= 3) advance();
            } else st.stall = 0;
        }, 1000);
    }
    function stopTimer() { if (timer) { clearInterval(timer); timer = null; } }

    /* ------------------------------------------------------------ public api */
    function read(text, opts) {
        if (!supported) return;
        opts = opts || {};
        var lang = opts.lang || null;
        var chunks = chunk(text, lang ? targetLang(lang) : targetLang(null));
        // Replace any current reading.
        st.token++;
        try { synth.cancel(); } catch (e) { /* ignore */ }
        if (!chunks.length) { if (st.active) finish(); return; }
        if (!voices.length) loadVoices();
        var ae = document.activeElement;
        if (ae && ae !== document.body && !(el && el.contains(ae))) st.returnFocus = ae;
        st.active = true;
        st.paused = false;
        st.softPaused = false;
        st.chunks = chunks;
        st.idx = 0;
        st.title = String(opts.title || '').replace(/\s+/g, ' ').trim();
        st.lang = lang;
        showPlayer();
        startTimer();
        // Speak synchronously so the call stays inside the user gesture (required on iOS / Chrome).
        speakChunk(0);
        emit();
    }

    function pause() {
        if (!st.active || st.paused) return;
        st.paused = true;
        if (isAndroid) {
            // Android Chrome's pause() is unreliable: cancel and restart the chunk on resume.
            st.softPaused = true;
            st.token++;
            try { synth.cancel(); } catch (e) { /* */ }
        } else {
            try { synth.pause(); } catch (e) { /* */ }
        }
        emit();
    }

    function resume() {
        if (!st.active || !st.paused) return;
        st.paused = false;
        st.lastStart = Date.now();
        if (st.softPaused || (!synth.speaking && !synth.pending)) {
            st.softPaused = false;
            speakChunk(st.idx);
        } else {
            try { synth.resume(); } catch (e) { /* */ }
        }
        emit();
    }

    function stop() {
        if (!supported) return;
        st.token++;
        try { synth.cancel(); } catch (e) { /* */ }
        if (st.active) finish();
    }

    function getPrefs() { return { voice: prefs.voice, rate: prefs.rate }; }

    function setPrefs(partial) {
        if (!partial || typeof partial !== 'object') return;
        var changed = false;
        if ((partial.voice === 'female' || partial.voice === 'male') && partial.voice !== prefs.voice) {
            prefs.voice = partial.voice; changed = true;
        }
        if (typeof partial.rate === 'number' && isFinite(partial.rate)) {
            var r = clampRate(partial.rate);
            if (r !== prefs.rate) { prefs.rate = r; changed = true; }
        }
        if (!changed) return;
        savePrefs();
        if (st.active && !st.paused) restart();
        else if (st.active) {
            // Paused: drop the half-read utterance so resume restarts the chunk with the new settings.
            st.softPaused = true;
            st.token++;
            try { synth.cancel(); } catch (e) { /* */ }
        }
        emit();
    }

    function voiceNames() {
        if (!supported) return { female: null, male: null };
        if (!voices.length) loadVoices();
        var f = pick('female', null), m = pick('male', null);
        return { female: f.exact ? shortName(f.voice) : null, male: m.exact ? shortName(m.voice) : null };
    }

    /* ----------------------------------------------------------------- player */
    var el = null, ui = {};
    var hideTimer = null;
    var ICONS = {
        pause: '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" focusable="false"><rect x="6.5" y="5" width="3.6" height="14" rx="1.2" fill="currentColor"/><rect x="13.9" y="5" width="3.6" height="14" rx="1.2" fill="currentColor"/></svg>',
        play: '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" focusable="false"><path d="M8 5.6v12.8a1 1 0 0 0 1.52.85l10.2-6.4a1 1 0 0 0 0-1.7L9.52 4.75A1 1 0 0 0 8 5.6z" fill="currentColor"/></svg>',
        close: '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" fill="none"/></svg>'
    };

    function build() {
        if (el) return;
        el = document.createElement('div');
        el.className = 'ra-player';
        el.setAttribute('role', 'region');
        el.setAttribute('aria-label', 'Read aloud');
        el.hidden = true;
        el.innerHTML =
            '<div class="ra-head">' +
                '<span class="ra-eq" aria-hidden="true"><i></i><i></i><i></i><i></i></span>' +
                '<div class="ra-info">' +
                    '<div class="ra-title"><span class="ra-label">Reading</span><span class="ra-dot" aria-hidden="true"> · </span><span class="ra-name"></span></div>' +
                    '<div class="ra-progress" role="progressbar" aria-label="Reading progress" aria-valuemin="1"><span class="ra-fill"></span></div>' +
                '</div>' +
                '<button type="button" class="ra-btn ra-stop" aria-label="Stop reading">' + ICONS.close + '</button>' +
            '</div>' +
            '<div class="ra-controls">' +
                '<button type="button" class="ra-btn ra-play" aria-label="Pause reading">' + ICONS.pause + '</button>' +
                '<div class="ra-seg" role="group" aria-label="Voice">' +
                    '<button type="button" class="ra-seg-btn" data-voice="female" aria-label="Female voice"><span class="ra-sym" aria-hidden="true">♀︎</span><span class="ra-seg-text">Female</span></button>' +
                    '<button type="button" class="ra-seg-btn" data-voice="male" aria-label="Male voice"><span class="ra-sym" aria-hidden="true">♂︎</span><span class="ra-seg-text">Male</span></button>' +
                '</div>' +
                '<button type="button" class="ra-btn ra-speed" aria-label="Reading speed"></button>' +
            '</div>';
        ui.name = el.querySelector('.ra-name');
        ui.progress = el.querySelector('.ra-progress');
        ui.fill = el.querySelector('.ra-fill');
        ui.play = el.querySelector('.ra-play');
        ui.speed = el.querySelector('.ra-speed');
        ui.stop = el.querySelector('.ra-stop');
        ui.seg = [].slice.call(el.querySelectorAll('.ra-seg-btn'));

        ui.play.addEventListener('click', function () { if (st.paused) resume(); else pause(); });
        ui.stop.addEventListener('click', function () {
            var back = st.returnFocus;
            stop();
            if (back && back.isConnected && typeof back.focus === 'function') { try { back.focus({ preventScroll: true }); } catch (e) { /* */ } }
        });
        ui.speed.addEventListener('click', function () {
            var i = RATES.indexOf(prefs.rate);
            var next = RATES[(i < 0 ? 0 : i + 1) % RATES.length];
            if (i < 0) { next = RATES[0]; for (var k = 0; k < RATES.length; k++) if (RATES[k] > prefs.rate) { next = RATES[k]; break; } }
            setPrefs({ rate: next });
        });
        ui.seg.forEach(function (b) {
            b.addEventListener('click', function () { setPrefs({ voice: b.getAttribute('data-voice') }); });
        });
        el.addEventListener('keydown', function (e) {
            if (e.key === 'Escape') { e.stopPropagation(); ui.stop.click(); }
        });
        (document.body || document.documentElement).appendChild(el);
    }

    function fmtRate(r) { return (r === 1 ? '1' : String(r)) + '×'; }

    function render() {
        if (!el) return;
        var n = st.chunks.length || 1, cur = Math.min(st.idx + 1, n);
        ui.name.textContent = st.title || 'Text';
        ui.name.title = st.title || '';
        ui.fill.style.transform = 'scaleX(' + (cur / n) + ')';
        ui.progress.setAttribute('aria-valuemax', String(n));
        ui.progress.setAttribute('aria-valuenow', String(cur));
        ui.progress.setAttribute('aria-valuetext', 'Part ' + cur + ' of ' + n);
        var paused = st.active && st.paused;
        el.classList.toggle('ra-paused', paused);
        ui.play.innerHTML = paused ? ICONS.play : ICONS.pause;
        ui.play.setAttribute('aria-label', paused ? 'Resume reading' : 'Pause reading');
        ui.speed.textContent = fmtRate(prefs.rate);
        ui.speed.setAttribute('aria-label', 'Reading speed ' + fmtRate(prefs.rate).replace('×', ' times') + '. Change speed');
        ui.seg.forEach(function (b) {
            b.setAttribute('aria-pressed', String(b.getAttribute('data-voice') === prefs.voice));
        });
    }

    function showPlayer() {
        build();
        clearTimeout(hideTimer);
        render();
        if (el.hidden) {
            el.hidden = false;
            el.classList.remove('ra-show');
            void el.offsetWidth; // commit the hidden state so the entrance transitions
        }
        el.classList.add('ra-show');
    }

    function hidePlayer() {
        if (!el || el.hidden) return;
        var hadFocus = el.contains(document.activeElement);
        el.classList.remove('ra-show');
        clearTimeout(hideTimer);
        hideTimer = setTimeout(function () {
            if (!st.active) el.hidden = true;
        }, 260);
        if (hadFocus && st.returnFocus && st.returnFocus.isConnected) {
            try { st.returnFocus.focus({ preventScroll: true }); } catch (e) { /* */ }
        }
    }

    /* ------------------------------------------------------------------- init */
    if (supported) {
        loadVoices();
        var onVoices = function () { loadVoices(); };
        if (typeof synth.addEventListener === 'function') synth.addEventListener('voiceschanged', onVoices);
        else synth.onvoiceschanged = onVoices;
        // Some engines (Safari) fill the list late without firing the event.
        var tries = 0;
        var poll = setInterval(function () {
            if (voices.length || ++tries > 20) { clearInterval(poll); return; }
            loadVoices();
        }, 250);
        // Chrome can keep speaking across reloads — start clean.
        try { synth.cancel(); } catch (e) { /* */ }
        window.addEventListener('pagehide', function () { stop(); });
    }

    var api = {
        supported: supported,
        read: read,
        pause: function () { if (supported) pause(); },
        resume: function () { if (supported) resume(); },
        stop: stop,
        isSpeaking: function () { return st.active; },
        getPrefs: getPrefs,
        setPrefs: setPrefs,
        voiceNames: voiceNames,
        onchange: null,
        // Internal helper (used by tests): the chunks read() would queue for a text.
        _chunks: function (text, lang) { return chunk(text, targetLang(lang || null)); }
    };
    window.Speak = api;
})();
