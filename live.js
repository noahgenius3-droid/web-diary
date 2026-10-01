// Live video to friends. The host's camera goes straight to each viewer over WebRTC (one connection per viewer),
// with Supabase Realtime carrying the signalling, live chat and hearts on a private "diary_live:<id>" channel
// that only the host and their friends may join. A stream row in diary_live_streams lists who's live; the host's
// heartbeat keeps it fresh, so a stream whose phone died simply drops off the list.
document.addEventListener('DOMContentLoaded', () => {
    const app = window.diaryApp;
    const social = window.diarySocial;
    if (!app || !social || !social.available) return;
    const I = social.internals;
    const { client, esc, avatar, timeAgo } = I;
    const s = I.state;
    const cfg = window.DIARY_CONFIG || {};
    const $ = id => document.getElementById(id);
    const ICE = cfg.iceServers || [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }];
    const MAX_VIEWERS = 15;        // one upload per viewer — phones get warm beyond this
    const HEARTBEAT = 30000;
    const FRESH = 90000;           // a stream without a heartbeat for this long is over
    const PROFILE = 'username, display_name, avatar_path';

    const dialog = $('live');
    const video = $('lv-video');

    const L = {
        list: null,          // friends live right now
        listSub: null,
        loading: false,
        mode: null,          // 'setup' | 'live' | 'watch' | 'ended'
        stream: null,        // the diary_live_streams row
        media: null,         // host camera + mic
        facing: 'user',
        channel: null,
        selfId: null,        // this device in this stream (a user may watch on two devices)
        peers: new Map(),    // host: viewerId -> { pc, queue, remoteSet }
        pc: null,            // viewer: the connection to the host
        queue: [],
        remoteSet: false,
        viewers: 0,
        beat: null,
        clock: null
    };

    const me = () => s.profile && s.profile.id;
    const cameraFor = facing => {
        const upright = window.innerHeight > window.innerWidth && window.matchMedia('(pointer: coarse)').matches;
        // 720p in the camera's own shape: asking phones for more made many of them crop into the sensor (a zoomed
        // picture). resizeMode 'none' tells the browser not to crop or rescale to fit the request.
        return upright
            ? { facingMode: facing, width: { ideal: 720 }, height: { ideal: 1280 }, frameRate: { ideal: 30, max: 30 }, resizeMode: 'none' }
            : { facingMode: facing, width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30, max: 30 }, resizeMode: 'none' };
    };

    // ---------- Picture quality ----------
    // The host sends one copy per viewer, so the upload is shared out: a few viewers get full resolution and a
    // generous bitrate; a bigger audience gets each copy scaled down a little rather than everyone stuttering.
    function tuneViewers() {
        const n = Math.max(1, L.peers.size);
        const maxBitrate = Math.round(Math.min(2500000, Math.max(400000, 6000000 / n)));
        const scale = n <= 2 ? 1 : n <= 6 ? 1.5 : 2;
        L.peers.forEach(p => {
            const sender = p.vs;
            if (!sender || !sender.getParameters || !sender.setParameters) return;
            try {
                const params = sender.getParameters();
                if (!params.encodings || !params.encodings.length) params.encodings = [{}];
                params.encodings[0].maxBitrate = maxBitrate;
                params.encodings[0].maxFramerate = 30;
                params.encodings[0].scaleResolutionDownBy = scale;
                params.degradationPreference = 'balanced';
                sender.setParameters(params).catch(() => {});
            } catch (e) { /* older browsers: their defaults */ }
        });
    }

    // ---------- Filters ----------
    // The host's picture is redrawn with the filter and that redrawn picture is what viewers receive. Each look
    // is a short list of colour steps (the same ones CSS uses), turned into one colour matrix and applied on the
    // graphics chip with WebGL — fast, and it works on phones whose browsers can't filter a canvas (older iPhones).
    // Without WebGL, a 2D canvas filter does the same job; with neither, the Filters button isn't shown.
    const FX = [
        ['none', 'Normal', []],
        ['warm', 'Warm', [['sepia', 0.22], ['saturate', 1.25], ['brightness', 1.04]]],
        ['cool', 'Cool', [['hue', -10], ['saturate', 1.12], ['brightness', 1.04]]],
        ['vivid', 'Vivid', [['saturate', 1.5], ['contrast', 1.08]]],
        ['glow', 'Glow', [['brightness', 1.1], ['contrast', 0.92], ['saturate', 1.12]]],
        ['bright', 'Bright', [['brightness', 1.16], ['contrast', 1.04]]],
        ['rosy', 'Rosy', [['sepia', 0.15], ['hue', -12], ['saturate', 1.2], ['brightness', 1.05]]],
        ['vintage', 'Vintage', [['sepia', 0.5], ['contrast', 0.95], ['brightness', 1.05], ['saturate', 0.9]]],
        ['mono', 'Mono', [['grayscale', 1], ['contrast', 1.12]]],
        ['noir', 'Noir', [['grayscale', 1], ['contrast', 1.35], ['brightness', 0.95]]]
    ];
    const stepsOf = key => (FX.find(f => f[0] === key) || FX[0])[2];
    const cssOf = steps => steps.map(([k, v]) => (k === 'hue' ? `hue-rotate(${v}deg)` : `${k}(${v})`)).join(' ');
    const fxCss = key => cssOf(stepsOf(key));
    const fxEngine = (() => {
        try {
            if (!('captureStream' in HTMLCanvasElement.prototype)) return null;
            const probe = document.createElement('canvas');
            const gl = probe.getContext('webgl');
            if (gl) { const lose = gl.getExtension('WEBGL_lose_context'); if (lose) lose.loseContext(); return 'gl'; }
            return 'filter' in document.createElement('canvas').getContext('2d') ? '2d' : null;
        } catch (e) { return null; }
    })();
    const outgoingVideo = () => L.screen || (L.fx && L.fx.track) || (L.media && L.media.getVideoTracks()[0]) || null;

    // One colour step as a matrix: rows for red, green and blue, each [r, g, b, offset] (Filter Effects spec)
    function stepMatrix([k, v]) {
        const i = 1 - v;
        switch (k) {
            case 'brightness': return [[v, 0, 0, 0], [0, v, 0, 0], [0, 0, v, 0]];
            case 'contrast': return [[v, 0, 0, 0.5 * (1 - v)], [0, v, 0, 0.5 * (1 - v)], [0, 0, v, 0.5 * (1 - v)]];
            case 'saturate': return [[0.213 + 0.787 * v, 0.715 - 0.715 * v, 0.072 - 0.072 * v, 0], [0.213 - 0.213 * v, 0.715 + 0.285 * v, 0.072 - 0.072 * v, 0], [0.213 - 0.213 * v, 0.715 - 0.715 * v, 0.072 + 0.928 * v, 0]];
            case 'grayscale': return [[0.2126 + 0.7874 * i, 0.7152 - 0.7152 * i, 0.0722 - 0.0722 * i, 0], [0.2126 - 0.2126 * i, 0.7152 + 0.2848 * i, 0.0722 - 0.0722 * i, 0], [0.2126 - 0.2126 * i, 0.7152 - 0.7152 * i, 0.0722 + 0.9278 * i, 0]];
            case 'sepia': return [[0.393 + 0.607 * i, 0.769 - 0.769 * i, 0.189 - 0.189 * i, 0], [0.349 - 0.349 * i, 0.686 + 0.314 * i, 0.168 - 0.168 * i, 0], [0.272 - 0.272 * i, 0.534 - 0.534 * i, 0.131 + 0.869 * i, 0]];
            case 'hue': {
                const a = v * Math.PI / 180, c = Math.cos(a), s = Math.sin(a);
                return [[0.213 + c * 0.787 - s * 0.213, 0.715 - c * 0.715 - s * 0.715, 0.072 - c * 0.072 + s * 0.928, 0],
                    [0.213 - c * 0.213 + s * 0.143, 0.715 + c * 0.285 + s * 0.140, 0.072 - c * 0.072 - s * 0.283, 0],
                    [0.213 - c * 0.213 - s * 0.787, 0.715 - c * 0.715 + s * 0.715, 0.072 + c * 0.928 + s * 0.072, 0]];
            }
            default: return [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0]];
        }
    }
    // Steps run in order, so later ones are applied to the result of earlier ones
    const fxMatrices = new Map();
    function matrixOf(key) {
        if (fxMatrices.has(key)) return fxMatrices.get(key);
        let m = [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0]];
        stepsOf(key).forEach(step => {
            const b = stepMatrix(step);
            m = b.map(row => [0, 1, 2].map(col => row[0] * m[0][col] + row[1] * m[1][col] + row[2] * m[2][col]).concat(row[0] * m[0][3] + row[1] * m[1][3] + row[2] * m[2][3] + row[3]));
        });
        // WebGL wants the 3×3 part column by column, plus the offsets
        const out = { mat: [m[0][0], m[1][0], m[2][0], m[0][1], m[1][1], m[2][1], m[0][2], m[1][2], m[2][2]], off: [m[0][3], m[1][3], m[2][3]] };
        fxMatrices.set(key, out);
        return out;
    }

    function makeGL(canvas) {
        const gl = canvas.getContext('webgl', { antialias: false, alpha: false, premultipliedAlpha: false });
        if (!gl) return null;
        const shader = (type, src) => { const sh = gl.createShader(type); gl.shaderSource(sh, src); gl.compileShader(sh); return gl.getShaderParameter(sh, gl.COMPILE_STATUS) ? sh : null; };
        const vs = shader(gl.VERTEX_SHADER, 'attribute vec2 p; varying vec2 v; void main() { v = (p + 1.0) * 0.5; gl_Position = vec4(p, 0.0, 1.0); }');
        const fs = shader(gl.FRAGMENT_SHADER, 'precision mediump float; varying vec2 v; uniform sampler2D t; uniform mat3 m; uniform vec3 o; void main() { vec3 c = texture2D(t, v).rgb; gl_FragColor = vec4(clamp(m * c + o, 0.0, 1.0), 1.0); }');
        if (!vs || !fs) return null;
        const prog = gl.createProgram();
        gl.attachShader(prog, vs);
        gl.attachShader(prog, fs);
        gl.linkProgram(prog);
        if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return null;
        gl.useProgram(prog);
        const buf = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, buf);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW);
        const p = gl.getAttribLocation(prog, 'p');
        gl.enableVertexAttribArray(p);
        gl.vertexAttribPointer(p, 2, gl.FLOAT, false, 0, 0);
        const tex = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, tex);
        [[gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE], [gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR]].forEach(([k, v]) => gl.texParameteri(gl.TEXTURE_2D, k, v));
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
        return { gl, uM: gl.getUniformLocation(prog, 'm'), uO: gl.getUniformLocation(prog, 'o') };
    }

    function startFx() {
        if (!fxEngine || !L.media || L.fx) return;
        const src = document.createElement('video');
        src.muted = true;
        src.setAttribute('playsinline', '');
        src.className = 'lv-fx-src';
        dialog.append(src); // phones only decode a video that's on the page
        const canvas = document.createElement('canvas');
        canvas.width = 720;
        canvas.height = 1280;
        const g = fxEngine === 'gl' ? makeGL(canvas) : null;
        const ctx = g ? null : canvas.getContext('2d');
        if (!g && !(ctx && 'filter' in ctx)) { src.remove(); return; }
        L.fx = { src, canvas, g, ctx, raf: 0, track: canvas.captureStream(30).getVideoTracks()[0] };
        if (L.fx.track && 'contentHint' in L.fx.track) L.fx.track.contentHint = 'motion';
        src.srcObject = new MediaStream(L.media.getVideoTracks());
        src.play().catch(() => {});
        const draw = () => {
            const f = L.fx;
            if (!f) return;
            const w = f.src.videoWidth, h = f.src.videoHeight;
            if (w && h && f.src.readyState >= 2) {
                const k = Math.min(1, 1280 / Math.max(w, h));
                const cw = Math.round(w * k), ch = Math.round(h * k);
                if (f.canvas.width !== cw || f.canvas.height !== ch) { f.canvas.width = cw; f.canvas.height = ch; }
                if (f.g) {
                    const { gl, uM, uO } = f.g;
                    const m = matrixOf(L.filter);
                    gl.viewport(0, 0, cw, ch);
                    try { gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, f.src); } catch (e) { /* a frame not ready yet */ }
                    gl.uniformMatrix3fv(uM, false, m.mat);
                    gl.uniform3fv(uO, m.off);
                    gl.drawArrays(gl.TRIANGLES, 0, 6);
                } else {
                    f.ctx.filter = fxCss(L.filter) || 'none';
                    f.ctx.drawImage(f.src, 0, 0, cw, ch);
                }
            }
            f.raf = requestAnimationFrame(draw);
        };
        draw();
    }
    function stopFx() {
        const f = L.fx;
        if (!f) return;
        L.fx = null;
        cancelAnimationFrame(f.raf);
        if (f.track) f.track.stop();
        if (f.g) { const lose = f.g.gl.getExtension('WEBGL_lose_context'); if (lose) lose.loseContext(); }
        f.src.srcObject = null;
        f.src.remove();
    }
    function setFilter(key) {
        L.filter = key;
        const css = fxCss(key);
        if (!L.screen) video.style.filter = css; // your own preview, instantly
        if (css) startFx(); else stopFx();
        const track = outgoingVideo();
        L.peers.forEach(p => { if (p.vs && track) p.vs.replaceTrack(track).catch(() => {}); });
        paintFx();
    }
    // The filter choices (in the live bar's strip and on the setup screen), each with a tiny live preview of you
    function paintFx() {
        const opts = FX.map(([k, l, steps]) => `<button type="button" class="lv-fx-opt" data-fx="${k}" aria-pressed="${(L.filter || 'none') === k}"><canvas class="lv-fx-sw" width="96" height="96" style="filter:${cssOf(steps) || 'none'}" aria-hidden="true"></canvas>${l}</button>`).join('');
        ['lv-fx-strip', 'lv-setup-fx'].forEach(id => { const el = $(id); if (el) el.innerHTML = opts; });
        const w = video.videoWidth, h = video.videoHeight;
        if (!w || !h) return;
        const side = Math.min(w, h);
        document.querySelectorAll('#live .lv-fx-sw').forEach(c => {
            try { c.getContext('2d').drawImage(video, (w - side) / 2, (h - side) / 2, side, side, 0, 0, 96, 96); } catch (e) { /* not ready */ }
        });
    }

    // ---------- Sharing your screen ----------
    // Computers only (phone browsers can't share their screen). Viewers get the screen instead of the camera;
    // stopping — here or with the browser's own "Stop sharing" — brings the camera (and its filter) back.
    const canShareScreen = !!(navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia) && !window.matchMedia('(pointer: coarse)').matches;
    async function toggleScreen() {
        if (L.screen) return stopScreen();
        if (L.mode !== 'live') return;
        let stream;
        try {
            stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: 15, max: 30 } }, audio: false });
        } catch (e) {
            return app.showToast(e && e.name === 'NotAllowedError' ? 'Screen sharing was cancelled' : 'Couldn’t share your screen — try again');
        }
        const track = stream.getVideoTracks()[0];
        if (!track || L.mode !== 'live') { stream.getTracks().forEach(t => t.stop()); return; }
        if ('contentHint' in track) track.contentHint = 'detail'; // keep text sharp
        L.screen = track;
        track.addEventListener('ended', stopScreen);
        L.peers.forEach(p => { if (p.vs) p.vs.replaceTrack(track).catch(() => {}); });
        video.srcObject = new MediaStream([track]);
        video.classList.remove('mirror');
        video.style.filter = '';
        video.play().catch(() => {});
        send('screen', { on: true });
        paintScreen();
    }
    function stopScreen() {
        const t = L.screen;
        if (!t) return;
        L.screen = null;
        t.stop();
        const out = outgoingVideo();
        L.peers.forEach(p => { if (p.vs && out) p.vs.replaceTrack(out).catch(() => {}); });
        if (L.media) {
            video.srcObject = new MediaStream(L.media.getTracks());
            video.classList.remove('mirror'); // natural orientation, as viewers see it
            video.style.filter = fxCss(L.filter || 'none');
            video.play().catch(() => {});
        }
        if (L.mode === 'live') send('screen', { on: false });
        paintScreen();
    }
    function paintScreen() {
        const on = !!L.screen;
        dialog.dataset.screen = on ? '1' : '';
        const btn = $('lv-screen');
        if (btn) {
            btn.setAttribute('aria-pressed', String(on));
            btn.setAttribute('aria-label', on ? 'Stop sharing your screen' : 'Share your screen');
        }
        const pill = $('lv-screen-pill');
        if (pill) pill.hidden = !on;
        if (typeof adapt === 'function') adapt();
    }

    // ---------- Pinned comment ----------
    // The host pins a comment for everyone (sent again to anyone who joins later);
    // a viewer can pin one just for themselves.
    function paintPin() {
        const box = $('lv-pin');
        if (!box) return;
        const p = L.pin || L.myPin;
        box.hidden = !p;
        if (!p) { box.innerHTML = ''; return; }
        const byHost = !!L.pin;
        const canUnpin = byHost ? L.mode === 'live' : true;
        box.innerHTML = `<svg class="i lv-pin-ic" aria-hidden="true"><use href="#i-pin-note"/></svg>
            <span class="lv-pin-text"><small>${byHost ? 'Pinned by the host' : 'Pinned for you'}</small><span><strong>${esc(p.name)}</strong> ${esc(p.text)}</span></span>
            ${canUnpin ? '<button type="button" class="lv-pin-x" data-pin="off" aria-label="Unpin this comment"><svg class="i"><use href="#i-close"/></svg></button>' : ''}`;
    }
    const reduced = () => document.documentElement.dataset.motion === 'reduce' || window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    window.diaryLive = {
        start: goLive,
        watch: id => watch(id),
        strip: liveStrip,
        list: () => L.list || [],
        ensure: () => { if (L.list === null) loadLive(); },
        refresh: () => loadLive()
    };

    // ---------- Who's live ----------
    async function loadLive() {
        if (!me() || L.loading) return;
        L.loading = true;
        const { data, error } = await client.from('diary_live_streams')
            .select(`id, host, title, audience, started_at, last_seen, host_profile:diary_profiles!diary_live_streams_host_fkey(${PROFILE})`)
            .is('ended_at', null)
            .gt('last_seen', new Date(Date.now() - FRESH).toISOString())
            .order('started_at', { ascending: false })
            .limit(40);
        L.loading = false;
        const before = (L.list || []).map(x => x.id).join();
        L.list = error ? [] : data;
        paintStrips();
        if (L.mode === 'watch') paintHop();
        if (before !== L.list.map(x => x.id).join() && !document.getElementById('ex-search')?.value) app.requestRender('explore');
        if (!L.listSub) {
            L.listSub = client.channel(`diary-live-list-${me()}`)
                .on('postgres_changes', { event: '*', schema: 'public', table: 'diary_live_streams' }, () => {
                    clearTimeout(L.reload);
                    L.reload = setTimeout(loadLive, 400);
                })
                .subscribe();
        }
    }

    // Streams go stale when a heartbeat stops; re-check now and then while the list is on screen
    setInterval(() => {
        if (me() && ['feed', 'explore'].includes(app.state.view)) loadLive();
        if (!me() && L.list) {
            L.list = null;
            if (L.listSub) client.removeChannel(L.listSub);
            L.listSub = null;
        }
    }, 45000);

    function liveStrip() {
        if (!me()) return '';
        if (L.list === null) {
            loadLive();
            return '<div class="live-strip" id="live-strip" hidden></div>';
        }
        return `<div class="live-strip" id="live-strip"${L.list.length ? '' : ' hidden'}>${stripInner()}</div>`;
    }

    function stripInner() {
        return (L.list || []).map(x => {
            const p = x.host_profile || { display_name: 'Someone' };
            const mine = x.host === me();
            return `
                <button type="button" class="live-card" data-action="live-watch" data-id="${esc(x.id)}">
                    <span class="lc-av">${avatar({ id: x.host, ...p }, 'md')}<span class="live-badge">LIVE</span></span>
                    <span class="lc-text">
                        <strong>${mine ? 'You’re live' : esc(p.display_name)}</strong>
                        <small>${esc(x.title || 'Live now')} · ${timeAgo(x.started_at)}</small>
                    </span>
                </button>`;
        }).join('');
    }

    function paintStrips() {
        document.querySelectorAll('#live-strip').forEach(el => {
            el.innerHTML = stripInner();
            el.hidden = !(L.list && L.list.length);
            I.hydrateStorage(el);
        });
    }

    // ---------- Screen ----------
    function setMode(mode) {
        L.mode = mode;
        dialog.dataset.mode = mode;
        $('lv-setup').hidden = mode !== 'setup';
        $('lv-badge').hidden = !(mode === 'live' || mode === 'watch');
        $('lv-viewers').hidden = !(mode === 'live' || mode === 'watch');
        $('lv-bar').hidden = mode === 'setup' || mode === 'ended';
        if (typeof adapt === 'function') adapt();
    }

    function status(html) {
        $('lv-status').innerHTML = html || '';
        $('lv-status').hidden = !html;
    }

    function paintHost(profile, title) {
        const p = profile || s.profile;
        // Watching someone you're not friends with: follow them to hear next time they go live
        const follow = p.id && p.id !== me() && I.followButton ? I.followButton(p, 'lv-follow') : '';
        $('lv-host').innerHTML = `${avatar({ id: p.id, ...p }, 'sm')}<span><strong>${esc(p.display_name)}</strong><small id="lv-sub">${esc(title || '')}</small></span>${follow}`;
        I.hydrateStorage($('lv-host'));
    }

    function paintTitle() {
        const line = $('lv-title-line');
        const t = L.stream && L.stream.title;
        line.textContent = t || '';
        line.hidden = !t || !(L.mode === 'live' || L.mode === 'watch');
    }

    function paintViewers() {
        $('lv-viewers').querySelector('b').textContent = String(L.viewers);
    }

    function startClock() {
        clearInterval(L.clock);
        const started = L.stream ? Date.parse(L.stream.started_at) : Date.now();
        const tick = () => {
            const secs = Math.max(0, Math.floor((Date.now() - started) / 1000));
            $('lv-badge').textContent = `LIVE · ${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`;
        };
        tick();
        L.clock = setInterval(tick, 1000);
    }

    function addChat(name, text, cls = '', who = null) {
        const box = $('lv-chat');
        const row = document.createElement('div');
        row.className = `lv-msg ${cls}`;
        const face = who ? avatar({ id: who.id, display_name: who.name || name, avatar_path: who.av || null }, 'sm') : '';
        row.innerHTML = cls === 'lv-join' || cls === 'lv-love'
            ? `${face}<span class="lv-event"><strong>${esc(name)}</strong> ${esc(text)}</span>`
            : `${face}<span class="lv-bubble"><strong>${esc(name)}</strong><span>${esc(text)}</span></span>`;
        if (face) I.hydrateStorage(row);
        if (cls !== 'lv-join' && cls !== 'lv-love') {
            row.classList.add('pinnable');
            row.dataset.name = name;
            row.dataset.text = text;
            row.tabIndex = 0;
            row.setAttribute('role', 'button');
            row.setAttribute('aria-label', `${name}: ${text} — options`);
        }
        box.append(row);
        while (box.children.length > 40) box.firstChild.remove();
        box.scrollTop = box.scrollHeight;
    }

    function floatHeart() {
        if (reduced()) return;
        const h = document.createElement('span');
        h.className = 'lv-heart';
        h.textContent = ['❤️', '💜', '💖', '🔥', '👏'][Math.floor(Math.random() * 5)];
        h.style.setProperty('--x', `${Math.round((Math.random() - 0.5) * 60)}px`);
        $('lv-hearts').append(h);
        setTimeout(() => h.remove(), 2200);
    }

    // ---------- Hosting ----------
    async function goLive() {
        if (!social.requireSignIn('Sign in to go live with your friends.')) return;
        if (L.mode) return app.showToast('You’re already in a live video');
        if (!navigator.mediaDevices || !window.RTCPeerConnection) return app.showToast('Live video isn’t supported in this browser');
        try {
            L.media = await navigator.mediaDevices.getUserMedia({
                video: cameraFor(L.facing),
                audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
            });
            L.media.getVideoTracks().forEach(t => { if ('contentHint' in t) t.contentHint = 'motion'; });
        } catch (e) {
            return app.showToast('Allow camera and microphone access to go live');
        }
        video.srcObject = L.media;
        video.muted = true;
        video.classList.remove('mirror'); // natural orientation, as viewers see it
        video.play().catch(() => {});
        $('lv-chat').innerHTML = '';
        $('lv-title').value = '';
        setAudience(L.audience || 'public');
        const fans = s.followerCount || 0;
        const people = s.friends.length + fans;
        L.reachText = `Your ${s.friends.length} ${s.friends.length === 1 ? 'friend' : 'friends'}${fans ? ` and ${fans} ${fans === 1 ? 'follower' : 'followers'}` : ''} ${people === 1 ? 'gets' : 'get'} a notification`;
        paintReach();
        paintHost(s.profile, 'Preview — only you can see this');
        dialog.classList.add('hosting');
        setMode('setup');
        status('');
        dialog.showModal();
        setTimeout(() => $('lv-title').focus(), 200);
    }

    function setAudience(a) {
        L.audience = a;
        document.querySelectorAll('.lv-aud [data-aud]').forEach(b => b.setAttribute('aria-checked', String(b.dataset.aud === a)));
        paintReach();
    }
    function paintReach() {
        if (!L.reachText) return;
        $('lv-reach').textContent = L.audience === 'public'
            ? `${L.reachText}, and anyone on Cordial can find and join your live. Best with up to ${MAX_VIEWERS} people watching.`
            : `${L.reachText} and only they can watch. Best with up to ${MAX_VIEWERS} people watching.`;
    }

    async function startBroadcast() {
        const title = $('lv-title').value.trim().slice(0, 120);
        $('lv-go').disabled = true;
        const { data, error } = await client.from('diary_live_streams').insert({ title, audience: L.audience }).select('id, host, title, audience, started_at').single();
        $('lv-go').disabled = false;
        if (!error && !data) return app.showToast('Couldn’t start your live video — try again');
        if (error) {
            app.showToast(/duplicate|unique/i.test(error.message) ? 'You already have a live video going on another device — end it there first, or try again in 2 minutes'
                : /permission|policy|42501/i.test(`${error.message} ${error.code}`) ? 'Couldn’t start your live video — your account isn’t allowed to go live right now'
                : !navigator.onLine ? 'You’re offline — connect to go live' : `Couldn’t start your live video — ${error.message || 'try again'}`);
            return;
        }
        L.stream = data;
        L.selfId = `${me()}:host`;
        paintHost(s.profile, title || 'Live now');
        setMode('live');
        startClock();
        L.viewers = 0;
        paintViewers();
        status(`<span class="lv-wait">You’re live${L.stream.audience === 'public' ? ' to everyone' : ''}. Waiting for someone to join…</span>`);
        paintTitle();
        joinChannel(true);
        L.beat = setInterval(() => {
            client.from('diary_live_streams').update({ last_seen: new Date().toISOString() }).eq('id', L.stream.id).then(() => {});
        }, HEARTBEAT);
        if (navigator.vibrate) navigator.vibrate(20);
        loadLive();
    }

    function hostOffer(viewerId) {
        if (L.peers.has(viewerId)) closePeer(viewerId);
        if (L.peers.size >= MAX_VIEWERS) {
            send('full', { to: viewerId });
            return;
        }
        const pc = new RTCPeerConnection({ iceServers: ICE });
        const peer = { pc, queue: [], remoteSet: false };
        L.peers.set(viewerId, peer);
        L.media.getAudioTracks().forEach(t => pc.addTrack(t, L.media));
        const out = outgoingVideo();
        if (out) peer.vs = pc.addTrack(out, L.media);
        pc.onicecandidate = e => { if (e.candidate) send('ice', { to: viewerId, candidate: e.candidate.toJSON() }); };
        pc.onconnectionstatechange = () => {
            if (['failed', 'closed'].includes(pc.connectionState)) closePeer(viewerId);
            else if (pc.connectionState === 'connected') tuneViewers();
        };
        pc.createOffer()
            .then(offer => pc.setLocalDescription(offer))
            .then(() => send('offer', { to: viewerId, sdp: pc.localDescription.toJSON() }))
            .catch(() => closePeer(viewerId));
    }

    function closePeer(id) {
        const peer = L.peers.get(id);
        if (!peer) return;
        L.peers.delete(id);
        try { peer.pc.close(); } catch (e) {}
        tuneViewers();
    }

    async function flipCamera() {
        if (!L.media) return;
        const next = L.facing === 'user' ? 'environment' : 'user';
        try {
            const fresh = await navigator.mediaDevices.getUserMedia({ video: cameraFor(next) });
            const track = fresh.getVideoTracks()[0];
            const old = L.media.getVideoTracks()[0];
            if ('contentHint' in track) track.contentHint = 'motion';
            if (L.fx) L.fx.src.srcObject = new MediaStream([track]);
            else if (!L.screen) L.peers.forEach(p => { if (p.vs) p.vs.replaceTrack(track).catch(() => {}); });
            L.media.removeTrack(old);
            old.stop();
            L.media.addTrack(track);
            L.facing = next;
            // A fresh stream object makes the phone re-measure the picture — reusing the old one kept the
            // previous camera's size, so the back camera showed shrunk instead of filling the screen
            video.srcObject = new MediaStream(L.media.getTracks());
            video.play().catch(() => {});
            video.classList.remove('mirror');
        } catch (e) {
            app.showToast('This device has only one camera');
        }
    }

    function toggleMute() {
        if (!L.media) return;
        const track = L.media.getAudioTracks()[0];
        if (!track) return;
        track.enabled = !track.enabled;
        $('lv-mute').setAttribute('aria-pressed', String(!track.enabled));
        $('lv-mute').setAttribute('aria-label', track.enabled ? 'Mute microphone' : 'Unmute microphone');
        $('lv-mute').innerHTML = `<svg class="i"><use href="#${track.enabled ? 'i-mic' : 'i-mic-off'}"/></svg>`;
    }

    async function endBroadcast(silent = false) {
        if (!L.stream) return cleanup();
        const id = L.stream.id;
        send('end', {});
        await client.from('diary_live_streams').update({ ended_at: new Date().toISOString() }).eq('id', id);
        const secs = Math.floor((Date.now() - Date.parse(L.stream.started_at)) / 1000);
        cleanup();
        if (!silent) app.showToast(`Live video ended · ${Math.floor(secs / 60)}m ${secs % 60}s`);
        loadLive();
    }

    // ---------- Watching ----------
    // The tap that opens a live is the user's permission to play sound. Using it right away (before anything
    // async) unlocks audio on phones that otherwise only allow muted playback.
    let audioUnlock = null;
    function unlockSound() {
        try {
            const Ctx = window.AudioContext || window.webkitAudioContext;
            if (Ctx) {
                audioUnlock = audioUnlock || new Ctx();
                if (audioUnlock.state === 'suspended') audioUnlock.resume().catch(() => {});
                const b = audioUnlock.createBuffer(1, 1, 22050);
                const n = audioUnlock.createBufferSource();
                n.buffer = b;
                n.connect(audioUnlock.destination);
                n.start(0);
            }
        } catch (e) { /* not needed on this browser */ }
        L.wantSound = true;
    }
    // Play the live with sound; only if the browser refuses, play muted and offer "Tap for sound"
    function playWithSound() {
        video.volume = 1;
        video.muted = !L.wantSound;
        return video.play().then(() => {
            status(video.muted ? '<button type="button" class="lv-unmute" id="lv-unmute"><svg class="i"><use href="#i-volume-off"/></svg>Tap for sound</button>' : '');
        }).catch(() => {
            if (!video.muted) {
                video.muted = true;
                return video.play().then(() => status('<button type="button" class="lv-unmute" id="lv-unmute"><svg class="i"><use href="#i-volume-off"/></svg>Tap for sound</button>'))
                    .catch(() => status('<button type="button" class="lv-unmute" id="lv-unmute"><svg class="i"><use href="#i-play"/></svg>Tap to watch</button>'));
            }
            status('<button type="button" class="lv-unmute" id="lv-unmute"><svg class="i"><use href="#i-play"/></svg>Tap to watch</button>');
        });
    }

    async function watch(id) {
        unlockSound();
        if (!social.requireSignIn('Sign in to watch your friends live.')) return;
        if (L.mode === 'live') return app.showToast('End your own live video first');
        if (L.mode) cleanup(true);
        const { data } = await client.from('diary_live_streams')
            .select(`id, host, title, audience, started_at, last_seen, ended_at, host_profile:diary_profiles!diary_live_streams_host_fkey(${PROFILE})`)
            .eq('id', id).maybeSingle();
        if (!data) return app.showToast('That live video isn’t available');
        if (data.host === me()) return app.showToast('That’s your own live video');
        L.stream = data;
        L.fit = null;
        L.selfId = `${me()}:${Math.random().toString(36).slice(2, 8)}`;
        dialog.classList.remove('hosting');
        $('lv-chat').innerHTML = '';
        video.srcObject = null;
        video.muted = true;
        video.classList.remove('mirror');
        paintHost({ id: data.host, ...(data.host_profile || { display_name: 'A friend' }) }, data.title || 'Live now');
        if (data.ended_at || Date.now() - Date.parse(data.last_seen) > FRESH) {
            setMode('ended');
            status(`<strong>This live video has ended</strong><span>${esc((data.host_profile && data.host_profile.display_name) || 'They')} went live ${timeAgo(data.started_at)}.</span>`);
            dialog.showModal();
            return;
        }
        setMode('watch');
        paintTitle();
        paintHop();
        startClock();
        L.viewers = 0;
        paintViewers();
        status('<span class="lv-spinner" aria-hidden="true"></span><span>Connecting…</span>');
        dialog.showModal();
        joinChannel(false);
    }

    function viewerAnswer(sdp) {
        if (L.pc) try { L.pc.close(); } catch (e) {}
        const pc = L.pc = new RTCPeerConnection({ iceServers: ICE });
        L.queue = [];
        L.remoteSet = false;
        pc.ontrack = e => {
            const stream = e.streams[0] || new MediaStream([e.track]);
            if (video.srcObject !== stream) {
                video.srcObject = stream;
                playWithSound();
            } else if (e.track.kind === 'audio' && video.muted && L.wantSound) {
                playWithSound(); // the sound arrived after the picture
            }
        };
        pc.onicecandidate = e => { if (e.candidate) send('ice', { to: `${L.stream.host}:host`, candidate: e.candidate.toJSON() }); };
        pc.onconnectionstatechange = () => {
            if (pc.connectionState === 'failed') status('<span>The connection dropped.</span><button type="button" class="lv-retry" id="lv-retry">Reconnect</button>');
        };
        pc.setRemoteDescription(sdp)
            .then(() => {
                L.remoteSet = true;
                L.queue.splice(0).forEach(c => pc.addIceCandidate(c).catch(() => {}));
                return pc.createAnswer();
            })
            .then(answer => pc.setLocalDescription(answer))
            .then(() => send('answer', { to: `${L.stream.host}:host`, sdp: pc.localDescription.toJSON() }))
            .catch(() => status('<span>Couldn’t connect to this live video.</span><button type="button" class="lv-retry" id="lv-retry">Try again</button>'));
    }

    // ---------- Channel ----------
    function joinChannel(isHost) {
        const channel = client.channel(`diary_live:${L.stream.id}`, {
            config: { private: true, broadcast: { self: false }, presence: { key: L.selfId } }
        });
        L.channel = channel;
        const forMe = p => p && p.to === L.selfId;
        channel
            .on('broadcast', { event: 'join' }, ({ payload }) => {
                if (isHost && payload.from) {
                    hostOffer(payload.from);
                    if (L.pin) send('pin', { pin: L.pin });
                    if (L.screen) send('screen', { on: true });
                }
            })
            .on('broadcast', { event: 'screen' }, ({ payload }) => {
                if (isHost) return;
                dialog.dataset.screen = payload && payload.on ? '1' : '';
                const pill = $('lv-screen-pill');
                if (pill) { pill.hidden = !(payload && payload.on); pill.textContent = 'Sharing their screen'; }
                adapt();
            })
            .on('broadcast', { event: 'pin' }, ({ payload }) => {
                if (isHost) return;
                const p = payload && payload.pin;
                L.pin = p && typeof p.text === 'string' ? { name: String(p.name || 'Someone').slice(0, 60), text: p.text.slice(0, 200) } : null;
                paintPin();
            })
            .on('broadcast', { event: 'hello' }, () => { if (!isHost) send('join', {}); })
            .on('broadcast', { event: 'offer' }, ({ payload }) => { if (!isHost && forMe(payload)) viewerAnswer(payload.sdp); })
            .on('broadcast', { event: 'answer' }, ({ payload }) => {
                if (!isHost || !forMe(payload)) return;
                const peer = L.peers.get(payload.from);
                if (!peer) return;
                peer.pc.setRemoteDescription(payload.sdp).then(() => {
                    peer.remoteSet = true;
                    peer.queue.splice(0).forEach(c => peer.pc.addIceCandidate(c).catch(() => {}));
                }).catch(() => closePeer(payload.from));
            })
            .on('broadcast', { event: 'ice' }, ({ payload }) => {
                if (!forMe(payload)) return;
                if (isHost) {
                    const peer = L.peers.get(payload.from);
                    if (!peer) return;
                    if (peer.remoteSet) peer.pc.addIceCandidate(payload.candidate).catch(() => {});
                    else peer.queue.push(payload.candidate);
                } else if (L.pc && L.remoteSet) {
                    L.pc.addIceCandidate(payload.candidate).catch(() => {});
                } else {
                    L.queue.push(payload.candidate);
                }
            })
            .on('broadcast', { event: 'leave' }, ({ payload }) => { if (isHost) closePeer(payload.from); })
            .on('broadcast', { event: 'full' }, ({ payload }) => {
                if (!isHost && forMe(payload)) status('<strong>This live video is full</strong><span>Too many friends are watching right now — try again in a bit.</span>');
            })
            .on('broadcast', { event: 'end' }, () => {
                if (isHost) return;
                setMode('ended');
                video.srcObject = null;
                status('<strong>The live video has ended</strong><span>Thanks for watching 💜</span>');
                if (L.pc) try { L.pc.close(); } catch (e) {}
                L.pc = null;
            })
            .on('broadcast', { event: 'chat' }, ({ payload }) => addChat(payload.name || 'Someone', String(payload.text || '').slice(0, 200), '', { id: String(payload.from || '').split(':')[0], name: payload.name, av: payload.av }))
            .on('broadcast', { event: 'heart' }, ({ payload }) => {
                floatHeart();
                // "sent ❤️" once in a while per person, so the chat isn't flooded
                const uid = String((payload && payload.from) || '').split(':')[0];
                const now = Date.now();
                L.lovedAt = L.lovedAt || new Map();
                if (payload && payload.name && now - (L.lovedAt.get(uid) || 0) > 20000) {
                    L.lovedAt.set(uid, now);
                    addChat(String(payload.name).split(' ')[0], 'sent ❤️', 'lv-love', { id: uid, name: payload.name, av: payload.av });
                }
            })
            .on('presence', { event: 'sync' }, () => {
                const keys = Object.keys(channel.presenceState());
                L.viewers = keys.filter(k => !k.endsWith(':host')).length;
                paintViewers();
                if (isHost && L.viewers > 0) status('');
                if (isHost) {
                    // Someone who vanished without saying goodbye
                    [...L.peers.keys()].forEach(id => { if (!keys.includes(id)) closePeer(id); });
                }
            })
            .on('presence', { event: 'join' }, ({ key, newPresences }) => {
                if (key.endsWith(':host') || key === L.selfId) return;
                const meta = (newPresences && newPresences[0]) || {};
                const uid = key.split(':')[0];
                const name = uid === me() ? 'You' : meta.name || ((s.friends.find(f => f.id === uid) || {}).display_name) || 'Someone';
                addChat(String(name).split(' ')[0], 'joined 👋', 'lv-join', { id: uid, name, av: meta.av });
            })
            .subscribe(async state => {
                if (state !== 'SUBSCRIBED') {
                    if (state === 'CHANNEL_ERROR' && !isHost) status('<span>You can’t watch this live video.</span>');
                    return;
                }
                await channel.track({ at: Date.now(), name: s.profile.display_name, av: s.profile.avatar_path || null });
                if (isHost) send('hello', {});
                else send('join', {});
            });
    }

    function send(event, payload) {
        if (!L.channel) return;
        L.channel.send({ type: 'broadcast', event, payload: { ...payload, from: L.selfId } });
    }

    // ---------- Leaving ----------
    function cleanup(keepOpen = false) {
        clearInterval(L.beat);
        clearInterval(L.clock);
        if (L.mode === 'watch') send('leave', {});
        L.peers.forEach((_, id) => closePeer(id));
        if (L.pc) try { L.pc.close(); } catch (e) {}
        L.pc = null;
        if (L.screen) { L.screen.stop(); L.screen = null; }
        dialog.dataset.screen = '';
        if ($('lv-screen-pill')) $('lv-screen-pill').hidden = true;
        stopFx();
        L.filter = 'none';
        video.style.filter = '';
        const strip = $('lv-fx-strip');
        if (strip) strip.hidden = true;
        L.pin = null;
        L.myPin = null;
        paintPin();
        if (L.media) L.media.getTracks().forEach(t => t.stop());
        L.media = null;
        if (L.channel) client.removeChannel(L.channel);
        L.channel = null;
        L.stream = null;
        L.mode = null;
        video.srcObject = null;
        video.style.transform = '';
        dialog.classList.remove('hosting');
        $('lv-title-line').hidden = true;
        $('lv-hop').hidden = true;
        if (dialog.open && !keepOpen) dialog.close();
    }

    // ---------- Fit the device ----------
    // Wide stream on a computer: a wide stage. Tall stream: a tall stage. On a phone the stage is the whole
    // screen; a stream whose shape doesn't match the screen is shown whole (fit) unless you choose fill.
    function adapt() {
        const vw = video.videoWidth, vh = video.videoHeight;
        if (!vw || !vh) return;
        const wideVideo = vw > vh * 1.1;
        dialog.dataset.video = wideVideo ? 'wide' : 'tall';
        const desk = window.matchMedia('(min-width: 900px) and (min-height: 600px) and (hover: hover)').matches;
        // Filling the screen crops whatever doesn't match its shape. A small trim is fine; anything more looks
        // zoomed in, so then the whole picture is shown (for the host and viewers alike) unless they choose fill.
        const box = video.getBoundingClientRect();
        const crop = box.width && box.height ? 1 - Math.min(vw / vh, box.width / box.height) / Math.max(vw / vh, box.width / box.height) : 0;
        const fit = L.fit || (dialog.dataset.screen === '1' || (!desk && crop > 0.12) ? 'contain' : 'cover');
        // "Fill" shows the whole picture enlarged by at most 15%: more immersive, but the subject and the space
        // around it stay in frame on any screen. A small natural trim (shapes already close) still fills.
        const enlarge = fit === 'cover' && crop > 0.12 && dialog.dataset.screen !== '1' ? Math.min(1 / (1 - crop), 1.15) : 1;
        L.fitNow = fit;
        video.style.objectFit = enlarge > 1 ? 'contain' : fit;
        video.style.transform = enlarge > 1 ? `scale(${enlarge.toFixed(3)})` : '';
        const btn = $('lv-fit');
        btn.hidden = !(L.mode === 'watch' || L.mode === 'live') || desk || crop <= 0.12;
        btn.setAttribute('aria-pressed', String(fit === 'contain'));
        btn.setAttribute('aria-label', fit === 'contain' ? 'Fill the screen' : 'Show the whole picture');
    }
    video.addEventListener('loadedmetadata', adapt);
    video.addEventListener('resize', adapt);
    window.addEventListener('resize', () => { if (L.mode) adapt(); });
    $('lv-fit').addEventListener('click', () => {
        L.fit = L.fitNow === 'contain' ? 'cover' : 'contain';
        adapt();
    });

    // ---------- Many lives at once: hop between them ----------
    function others() { return (L.list || []).filter(x => x.host !== me()); }
    function paintHop() {
        const list = others();
        const i = list.findIndex(x => L.stream && x.id === L.stream.id);
        $('lv-hop').hidden = !(L.mode === 'watch' && list.length > 1);
        $('lv-hop-n').textContent = list.length > 1 ? `${Math.max(1, i + 1)}/${list.length}` : '';
    }
    async function hop(step) {
        if (L.mode !== 'watch' && L.mode !== 'ended') return;
        await loadLive();
        const list = others();
        if (list.length < 2) return app.showToast('No other lives right now');
        const i = list.findIndex(x => L.stream && x.id === L.stream.id);
        const next = list[(i + step + list.length) % list.length];
        if (next) watch(next.id);
    }
    // Swipe up / down on the video to change live (phones)
    let touchY = null;
    dialog.addEventListener('touchstart', e => { if (L.mode === 'watch' || L.mode === 'ended') touchY = e.touches[0].clientY; }, { passive: true });
    dialog.addEventListener('touchend', e => {
        if (touchY === null) return;
        const dy = e.changedTouches[0].clientY - touchY;
        touchY = null;
        if (Math.abs(dy) > 90 && !e.target.closest('.lv-bar, .lv-chat')) hop(dy < 0 ? 1 : -1);
    }, { passive: true });

    async function shareLive() {
        if (!L.stream) return;
        const link = `${location.origin}${location.pathname}?live=${encodeURIComponent(L.stream.id)}`;
        const title = L.stream.title || 'Live on Cordial';
        if (navigator.share) {
            try { await navigator.share({ title, text: `Watch “${title}” live on Cordial`, url: link }); return; }
            catch (e) { if (e && e.name === 'AbortError') return; }
        }
        try { await navigator.clipboard.writeText(link); app.showToast('Live link copied'); }
        catch (e) { app.ask({ title: 'Live link', text: 'Copy this link to share the live:', value: link, ok: 'Done' }); }
    }

    // A shared link: ?live=<id>
    (() => {
        const id = new URLSearchParams(location.search).get('live');
        if (!id || !/^[0-9a-f-]{36}$/i.test(id)) return;
        const url = new URL(location.href);
        url.searchParams.delete('live');
        history.replaceState(history.state, '', url.pathname + url.search + url.hash);
        let tries = 0;
        const wait = setInterval(() => {
            if (me()) { clearInterval(wait); watch(id); }
            else if (++tries > 40) clearInterval(wait);
        }, 500);
    })();

    async function leave() {
        if (L.mode === 'live') {
            const ok = await app.ask({ title: 'End your live video?', text: 'Everyone watching will see that it has ended.', ok: 'End live video', danger: true });
            if (ok) endBroadcast();
            return;
        }
        cleanup();
    }

    // ---------- Controls ----------
    $('lv-go').addEventListener('click', startBroadcast);
    document.querySelectorAll('.lv-aud [data-aud]').forEach(b => b.addEventListener('click', () => setAudience(b.dataset.aud)));
    $('lv-share').addEventListener('click', shareLive);
    $('lv-hop').addEventListener('click', e => { const b = e.target.closest('[data-hop]'); if (b) hop(Number(b.dataset.hop)); });
    $('lv-title').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); startBroadcast(); } });
    $('lv-close').addEventListener('click', leave);
    $('lv-end').addEventListener('click', leave);
    $('lv-flip').addEventListener('click', flipCamera);
    if (!canShareScreen) $('lv-screen').remove();
    else $('lv-screen').addEventListener('click', toggleScreen);
    if (!fxEngine) { $('lv-fx').remove(); $('lv-setup-fx').remove(); } // this browser can't draw filters into the stream
    else $('lv-fx').addEventListener('click', () => {
        const strip = $('lv-fx-strip');
        strip.hidden = !strip.hidden;
        $('lv-fx').setAttribute('aria-expanded', String(!strip.hidden));
        if (!strip.hidden) paintFx();
    });
    const pickFx = e => {
        const b = e.target.closest('[data-fx]');
        if (b) setFilter(b.dataset.fx);
    };
    $('lv-fx-strip').addEventListener('click', pickFx);
    if ($('lv-setup-fx')) $('lv-setup-fx').addEventListener('click', pickFx);
    // Choose a look before going live: the setup screen shows the choices once the camera is on
    video.addEventListener('loadeddata', () => { if (L.mode === 'setup' && fxEngine) paintFx(); });
    const pinMenu = row => {
        if (!row || !L.mode) return;
        const c = { name: row.dataset.name, text: row.dataset.text };
        if (L.mode === 'live') app.openPopover(row, [{ label: 'Pin for everyone', icon: 'i-pin-note', onClick: () => { L.pin = c; send('pin', { pin: c }); paintPin(); } }]);
        else if (L.mode === 'watch') app.openPopover(row, [{ label: 'Pin for me', icon: 'i-pin-note', onClick: () => { L.myPin = c; paintPin(); } }]);
    };
    $('lv-chat').addEventListener('click', e => {
        const row = e.target.closest('.lv-msg.pinnable');
        if (!row) return;
        e.stopPropagation(); // the page's "tap outside closes menus" would shut it straight away
        pinMenu(row);
    });
    $('lv-chat').addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { const row = e.target.closest('.lv-msg.pinnable'); if (row) { e.preventDefault(); pinMenu(row); } } });
    $('lv-pin').addEventListener('click', e => {
        if (!e.target.closest('[data-pin="off"]')) return;
        if (L.pin && L.mode === 'live') { L.pin = null; send('pin', { pin: null }); }
        else L.myPin = null;
        paintPin();
    });
    $('lv-mute').addEventListener('click', toggleMute);
    $('lv-heart').addEventListener('click', () => {
        floatHeart();
        send('heart', { name: s.profile.display_name, av: s.profile.avatar_path || null });
        if (navigator.vibrate) navigator.vibrate(8);
    });
    $('lv-say').addEventListener('submit', e => {
        e.preventDefault();
        const input = $('lv-say-input');
        const text = input.value.trim().slice(0, 200);
        if (!text || !L.channel) return;
        input.value = '';
        addChat('You', text, 'mine', { id: me(), name: s.profile.display_name, av: s.profile.avatar_path });
        send('chat', { name: s.profile.display_name.split(' ')[0], text, av: s.profile.avatar_path || null });
    });
    $('lv-host').addEventListener('click', e => {
        const b = e.target.closest('[data-action="follow"]');
        if (b) I.toggleFollow(b.dataset.id, b.dataset.name);
    });
    $('lv-status').addEventListener('click', e => {
        if (e.target.closest('#lv-unmute')) {
            unlockSound();
            video.muted = false;
            video.volume = 1;
            video.play().then(() => status('')).catch(() => {});
        }
        if (e.target.closest('#lv-retry') && L.stream) {
            status('<span class="lv-spinner" aria-hidden="true"></span><span>Reconnecting…</span>');
            send('join', {});
        }
    });
    dialog.addEventListener('cancel', e => {
        e.preventDefault();
        leave();
    });
    // Closing the tab mid-stream: say goodbye; the heartbeat takes care of the rest
    window.addEventListener('pagehide', () => {
        if (L.mode === 'live' && L.stream) {
            send('end', {});
            client.from('diary_live_streams').update({ ended_at: new Date().toISOString() }).eq('id', L.stream.id).then(() => {});
        } else if (L.mode === 'watch') {
            send('leave', {});
        }
    });

    Object.assign(app.actions, {
        'live-start': () => goLive(),
        'live-watch': el => watch(el.dataset.id)
    });
});
