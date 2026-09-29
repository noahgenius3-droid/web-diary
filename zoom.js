/* ============================================================
   Cordial — zoomable photo viewer
   window.ZoomViewer.open(sources, { index, origin, startScale, caption })
   window.ZoomViewer.close()
   window.ZoomViewer.isOpen()
   Pinch / double-tap / wheel zoom, momentum pan, swipe between photos,
   drag down to dismiss, FLIP from the thumbnail it was opened from.
   ============================================================ */
(function () {
    'use strict';
    if (window.ZoomViewer) return;

    const MIN = 1;
    const MAX = 5;
    const DOUBLE = 2.5;       // double-tap zoom level
    const STEP = 1.75;        // +/- button & key step
    const GAP = 16;           // px between photos in the carousel
    const UI_IDLE = 2500;     // auto-hide the chrome after this long
    const TAP_SLOP = 8;       // px before a press becomes a drag
    const DOUBLE_MS = 300;
    const EPS = { s: 0.0005, x: 0.1, y: 0.1, tx: 0.1, bg: 0.002, op: 0.002 };

    const ICONS = {
        close: '<path d="M6 6l12 12M18 6L6 18"/>',
        zoomIn: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="M15.5 15.5L20 20M10.5 7.5v6M7.5 10.5h6"/>',
        zoomOut: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="M15.5 15.5L20 20M7.5 10.5h6"/>',
        reset: '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>',
        prev: '<path d="M15 5l-7 7 7 7"/>',
        next: '<path d="M9 5l7 7-7 7"/>',
        broken: '<rect x="3" y="4" width="18" height="16" rx="2.5"/><path d="M3 15l5-5 4 4M14 12l2-2 5 5"/><path d="M4 4l16 16"/>'
    };
    const svg = (d, sw) => '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="' + (sw || 2) +
        '" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + d + '</svg>';

    // ---------- state ----------
    let dlg, bgEl, stage, track, counterEl, captionEl, dotsEl, bottomEl, liveEl;
    let btnClose, btnIn, btnOut, btnReset, btnPrev, btnNext;
    let slides = [];
    let index = 0;
    let caption = '';
    let vw = 0, vh = 0;
    let phase = 'closed';               // closed | opening | open | closing
    let origin = null, originIndex = 0, originHidden = false, originVis = '';
    let returnFocus = null;
    // Everything the screen shows is derived from V: active frame (s,x,y), track offset, backdrop, dialog opacity
    const V = { s: 1, x: 0, y: 0, tx: 0, bg: 0, op: 1 };
    let anim = null;
    let writeRaf = 0;
    let lastFlags = '';
    let uiTimer = 0, tapTimer = 0, lastTap = null;
    const pointers = new Map();
    let g = null;                       // current gesture

    const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
    const rubber = (d, dim) => (1 - 1 / (d * 0.55 / dim + 1)) * dim;
    const rubberClamp = (v, lo, hi, dim) => v < lo ? lo - rubber(lo - v, dim) : v > hi ? hi + rubber(v - hi, dim) : v;
    const reduced = () => document.documentElement.getAttribute('data-motion') === 'reduce' ||
        (window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches);
    const cur = () => slides[index];

    // ---------- DOM ----------
    function build() {
        if (dlg) return;
        dlg = document.createElement('dialog');
        dlg.className = 'zoom-viewer';
        dlg.id = 'zoom-viewer';
        dlg.tabIndex = -1;
        dlg.setAttribute('aria-label', 'Photo viewer');
        dlg.innerHTML =
            '<div class="zv-bg"></div>' +
            '<div class="zv-stage"><div class="zv-track"></div></div>' +
            '<div class="zv-top zv-ui">' +
                '<button type="button" class="zv-btn zv-close" aria-label="Close">' + svg(ICONS.close, 2.2) + '</button>' +
                '<span class="zv-spacer"></span>' +
                '<span class="zv-counter" aria-hidden="true"></span>' +
                '<button type="button" class="zv-btn zv-out" aria-label="Zoom out">' + svg(ICONS.zoomOut) + '</button>' +
                '<button type="button" class="zv-btn zv-in" aria-label="Zoom in">' + svg(ICONS.zoomIn) + '</button>' +
                '<button type="button" class="zv-btn zv-reset" aria-label="Fit to screen">' + svg(ICONS.reset) + '</button>' +
            '</div>' +
            '<button type="button" class="zv-btn zv-nav zv-prev zv-ui" aria-label="Previous photo">' + svg(ICONS.prev, 2.2) + '</button>' +
            '<button type="button" class="zv-btn zv-nav zv-next zv-ui" aria-label="Next photo">' + svg(ICONS.next, 2.2) + '</button>' +
            '<div class="zv-bottom zv-ui"><div class="zv-dots" aria-hidden="true"></div><div class="zv-caption"></div></div>' +
            '<div class="zv-sr" aria-live="polite"></div>';
        const q = s => dlg.querySelector(s);
        bgEl = q('.zv-bg'); stage = q('.zv-stage'); track = q('.zv-track');
        counterEl = q('.zv-counter'); captionEl = q('.zv-caption'); dotsEl = q('.zv-dots');
        bottomEl = q('.zv-bottom'); liveEl = q('.zv-sr');
        btnClose = q('.zv-close'); btnIn = q('.zv-in'); btnOut = q('.zv-out'); btnReset = q('.zv-reset');
        btnPrev = q('.zv-prev'); btnNext = q('.zv-next');
        document.body.appendChild(dlg);

        btnClose.addEventListener('click', () => close());
        btnIn.addEventListener('click', () => { bumpUI(); zoomBy(STEP); });
        btnOut.addEventListener('click', () => { bumpUI(); zoomBy(1 / STEP); });
        btnReset.addEventListener('click', () => { bumpUI(); zoomTo(1, 0, 0, true); });
        btnPrev.addEventListener('click', () => { bumpUI(); go(index - 1); });
        btnNext.addEventListener('click', () => { bumpUI(); go(index + 1); });

        dlg.addEventListener('cancel', e => { e.preventDefault(); close(); });
        dlg.addEventListener('close', () => { if (!dlg.open) cleanup(); }); // stale if it was reopened
        dlg.addEventListener('keydown', onKey);
        dlg.addEventListener('wheel', onWheel, { passive: false });
        dlg.addEventListener('pointermove', e => { if (e.pointerType === 'mouse' && !e.buttons) bumpUI(); });
        dlg.addEventListener('contextmenu', e => { if (e.target.closest('.zv-stage')) e.preventDefault(); });
        // Safari's own pinch-zoom of the page
        ['gesturestart', 'gesturechange'].forEach(t => dlg.addEventListener(t, e => e.preventDefault()));
        dlg.addEventListener('touchmove', e => e.preventDefault(), { passive: false });

        stage.addEventListener('pointerdown', onDown);
        stage.addEventListener('pointermove', onMove);
        stage.addEventListener('pointerup', onUp);
        stage.addEventListener('pointercancel', onUp);
        stage.addEventListener('lostpointercapture', e => { if (pointers.has(e.pointerId)) onUp(e); });
        stage.addEventListener('dragstart', e => e.preventDefault());

        window.addEventListener('resize', () => { if (phase !== 'closed') layout(); });
    }

    function makeSlide(src, i) {
        const el = document.createElement('div');
        el.className = 'zv-slide';
        el.innerHTML = '<div class="zv-frame"><img class="zv-img" alt="" draggable="false"></div>' +
            '<div class="zv-spinner" role="progressbar" aria-label="Loading photo"></div>' +
            '<div class="zv-error">' + svg(ICONS.broken, 1.6) + '<span>This photo couldn’t be loaded.</span></div>';
        track.appendChild(el);
        return { el, frame: el.firstChild, img: el.querySelector('img'), src, i,
            started: false, loaded: false, failed: false, nw: 0, nh: 0, fw: 0, fh: 0 };
    }

    function loadSlide(sl) {
        if (!sl || sl.started) return;
        sl.started = true;
        const img = sl.img;
        sl.el.classList.add('zv-loading');
        img.alt = caption && sl.i === index ? caption : ('Photo ' + (sl.i + 1) + (slides.length > 1 ? ' of ' + slides.length : ''));
        const done = () => {
            if (sl.loaded || !slides.includes(sl)) return;
            if (!img.naturalWidth) return fail();
            sl.loaded = true;
            sl.nw = img.naturalWidth; sl.nh = img.naturalHeight;
            sl.el.classList.remove('zv-loading');
            sl.el.classList.add('zv-loaded');
            sizeSlide(sl);
            if (sl === cur()) {
                // provisional size (from the thumbnail) may have differed — keep the view valid
                if (!g && !anim && phase === 'open') { const t = clampView(V.s, V.x, V.y); V.x = t.x; V.y = t.y; }
                write();
            }
        };
        const fail = () => {
            if (sl.failed || !slides.includes(sl)) return;
            sl.failed = true;
            sl.el.classList.remove('zv-loading');
            sl.el.classList.add('zv-failed');
            if (sl === cur()) announce('This photo couldn’t be loaded');
        };
        img.onload = () => {
            if (img.decode) img.decode().then(done, done); else done();
        };
        img.onerror = fail;
        img.decoding = 'async';
        img.src = sl.src;
    }

    function fitSize(nw, nh) {
        if (!nw || !nh || !vw || !vh) return { w: vw, h: vh };
        const r = Math.min(vw / nw, vh / nh);
        return { w: Math.round(nw * r), h: Math.round(nh * r) };
    }

    function sizeSlide(sl) {
        const f = fitSize(sl.nw, sl.nh);
        sl.fw = f.w; sl.fh = f.h;
        const st = sl.frame.style;
        st.width = f.w + 'px';
        st.height = f.h + 'px';
        st.left = ((vw - f.w) / 2) + 'px';
        st.top = ((vh - f.h) / 2) + 'px';
    }

    function layout() {
        vw = stage.clientWidth || window.innerWidth;
        vh = stage.clientHeight || window.innerHeight;
        measureStage();
        slides.forEach((sl, i) => {
            sl.el.style.transform = 'translate3d(' + (i * (vw + GAP)) + 'px,0,0)';
            sizeSlide(sl);
        });
        if (phase === 'open' && !g) {
            V.s = clamp(V.s, MIN, MAX);
            const t = clampView(V.s, V.x, V.y); V.x = t.x; V.y = t.y;
        }
        write(true);
    }

    // ---------- rendering ----------
    function write(now) {
        if (now === true) { cancelAnimationFrame(writeRaf); writeRaf = 0; paint(); return; }
        if (!writeRaf) writeRaf = requestAnimationFrame(() => { writeRaf = 0; paint(); });
    }
    function paint() {
        if (!dlg || !slides.length) return;
        const sl = cur();
        if (sl) sl.frame.style.transform = 'translate3d(' + V.x + 'px,' + V.y + 'px,0) scale(' + V.s + ')';
        track.style.transform = 'translate3d(' + (-index * (vw + GAP) + V.tx) + 'px,0,0)';
        bgEl.style.opacity = clamp(V.bg, 0, 1);
        dlg.style.opacity = V.op >= 1 ? '' : clamp(V.op, 0, 1);
        const zoomed = V.s > 1.01;
        const b = bounds(V.s);
        const ok = usable();
        const flags = (ok ? 'u' : '') + (zoomed ? 'z' : '') + (b.x > 0.5 || b.y > 0.5 ? 'p' : '') + (V.s >= MAX - 0.01 ? 'm' : '') + index;
        if (flags !== lastFlags) {
            lastFlags = flags;
            dlg.classList.toggle('zv-zoomed', zoomed);
            stage.classList.toggle('zv-can-pan', zoomed && (b.x > 0.5 || b.y > 0.5));
            btnOut.disabled = !zoomed;
            btnReset.disabled = !zoomed;
            btnIn.disabled = !ok || V.s >= MAX - 0.01;
            btnPrev.disabled = index <= 0;
            btnNext.disabled = index >= slides.length - 1;
        }
    }

    function bounds(s) {
        const sl = cur();
        const fw = sl && sl.fw ? sl.fw : vw, fh = sl && sl.fh ? sl.fh : vh;
        return { x: Math.max(0, (fw * s - vw) / 2), y: Math.max(0, (fh * s - vh) / 2) };
    }
    function clampView(s, x, y) {
        const b = bounds(s);
        return { x: clamp(x, -b.x, b.x), y: clamp(y, -b.y, b.y) };
    }

    // ---------- animation ----------
    function stopAnim() {
        if (!anim) return;
        cancelAnimationFrame(anim.raf);
        const a = anim; anim = null;
        a.res(false);
    }
    function run(step) {
        stopAnim();
        return new Promise(res => {
            const a = { raf: 0, res, last: performance.now() };
            anim = a;
            const tick = now => {
                if (anim !== a) return;
                const dt = Math.min(0.064, Math.max(0, (now - a.last) / 1000));
                a.last = now;
                const done = step(dt);
                paint();
                if (done) { anim = null; res(true); } else a.raf = requestAnimationFrame(tick);
            };
            a.raf = requestAnimationFrame(tick);
        });
    }
    // Damped spring on any subset of V; `v` = initial velocities (units per second)
    function spring(to, o) {
        o = o || {};
        const k = o.k || 260;
        const c = o.c || 2 * Math.sqrt(k);
        const keys = Object.keys(to);
        if (reduced() && !o.force) { stopAnim(); Object.assign(V, to); write(true); return Promise.resolve(true); }
        const vel = {};
        keys.forEach(key => { vel[key] = (o.v && o.v[key]) || 0; });
        return run(dt => {
            const h = 1 / 240;
            let t = dt;
            while (t > 1e-6) {
                const s = Math.min(h, t); t -= s;
                for (const key of keys) {
                    const a = -k * (V[key] - to[key]) - c * vel[key];
                    vel[key] += a * s;
                    V[key] += vel[key] * s;
                }
            }
            let done = true;
            for (const key of keys) {
                const e = EPS[key] || 0.01;
                if (Math.abs(V[key] - to[key]) > e || Math.abs(vel[key]) > e * 20) { done = false; break; }
            }
            if (done) Object.assign(V, to);
            return done;
        });
    }
    const easeOut = t => 1 - Math.pow(1 - t, 3);
    function tween(to, ms, ease) {
        ease = ease || easeOut;
        const from = {}, keys = Object.keys(to);
        keys.forEach(k => { from[k] = V[k]; });
        let t = 0;
        return run(dt => {
            t = Math.min(1, t + dt * 1000 / ms);
            const e = ease(t);
            keys.forEach(k => { V[k] = from[k] + (to[k] - from[k]) * e; });
            return t >= 1;
        });
    }
    // Pan momentum: exponential friction inside the bounds, stiff spring back once past an edge
    function momentum(vx, vy) {
        const b = bounds(V.s);
        if (reduced()) { stopAnim(); const t = clampView(V.s, V.x, V.y); V.x = t.x; V.y = t.y; write(true); return Promise.resolve(true); }
        const T = 0.325, k = 240, c = 2 * Math.sqrt(k);
        const ax = [{ key: 'x', v: vx, lim: b.x }, { key: 'y', v: vy, lim: b.y }];
        return run(dt => {
            const h = 1 / 240;
            let t = dt;
            while (t > 1e-6) {
                const s = Math.min(h, t); t -= s;
                for (const a of ax) {
                    const p = V[a.key];
                    const over = p > a.lim ? p - a.lim : p < -a.lim ? p + a.lim : 0;
                    if (over) a.v += (-k * over - c * a.v) * s;
                    else a.v *= Math.exp(-s / T);
                    V[a.key] += a.v * s;
                }
            }
            let done = true;
            for (const a of ax) {
                const p = V[a.key];
                const over = p > a.lim ? p - a.lim : p < -a.lim ? p + a.lim : 0;
                if (Math.abs(over) > 0.1 || Math.abs(a.v) > 6) done = false;
            }
            if (done) { const t2 = clampView(V.s, V.x, V.y); V.x = t2.x; V.y = t2.y; }
            return done;
        });
    }

    // ---------- zoom helpers (q = point relative to the stage centre) ----------
    function viewAround(ns, qx, qy) {
        const r = ns / V.s;
        return clampView(ns, qx - r * (qx - V.x), qy - r * (qy - V.y));
    }
    function zoomTo(ns, qx, qy, animate) {
        ns = clamp(ns, MIN, MAX);
        const t = ns <= MIN ? { x: 0, y: 0 } : viewAround(ns, qx, qy);
        const to = { s: ns, x: t.x, y: t.y };
        if (animate) return spring(to, { k: 300 });
        stopAnim();
        Object.assign(V, to);
        write();
        return Promise.resolve(true);
    }
    function zoomBy(f) {
        if (phase !== 'open' || !usable()) return;
        zoomTo(V.s * f, 0, 0, true);
    }
    const usable = () => { const sl = cur(); return sl && sl.loaded; };
    let stageL = 0, stageT = 0;   // cached once per gesture so moves never read layout
    function measureStage() {
        const sr = stage.getBoundingClientRect();
        stageL = sr.left; stageT = sr.top;
    }
    function stagePoint(cx, cy) {
        return { x: cx - stageL - vw / 2, y: cy - stageT - vh / 2 };
    }
    // Put everything back into a valid resting state (after an interrupted animation)
    function settle() {
        const ns = clamp(V.s, MIN, MAX);
        const t = ns <= MIN ? { x: 0, y: 0 } : clampView(ns, V.x, V.y);
        const to = { s: ns, x: t.x, y: t.y, tx: 0, bg: 1 };
        if (Object.keys(to).some(k => Math.abs(V[k] - to[k]) > EPS[k])) spring(to, { k: 300 });
    }

    // ---------- navigation ----------
    function go(i, velocity) {
        if (phase !== 'open' || i < 0 || i >= slides.length || i === index) {
            if (V.tx) spring({ tx: 0 }, { k: 320, v: { tx: velocity || 0 } });
            return;
        }
        const old = cur();
        const step = i - index;
        old.frame.style.transform = '';
        index = i;
        V.tx += step * (vw + GAP);
        V.s = 1; V.x = 0; V.y = 0; V.bg = 1;
        loadSlide(cur()); loadSlide(slides[i + 1]); loadSlide(slides[i - 1]);
        paintMeta();
        announce('Photo ' + (i + 1) + ' of ' + slides.length);
        write(true);
        spring({ tx: 0 }, { k: 300, c: 32, v: { tx: velocity || 0 } });
    }

    function paintMeta() {
        const n = slides.length;
        dlg.classList.toggle('zv-multi', n > 1);
        counterEl.textContent = n > 1 ? (index + 1) + ' / ' + n : '';
        if (n > 1 && n <= 15) {
            if (dotsEl.children.length !== n) dotsEl.innerHTML = '<span class="zv-dot"></span>'.repeat(n);
            [...dotsEl.children].forEach((d, i) => d.classList.toggle('zv-on', i === index));
        } else dotsEl.innerHTML = '';
        captionEl.textContent = caption || '';
        bottomEl.classList.toggle('zv-none', !caption && !(n > 1 && n <= 15));
    }

    function announce(t) { if (liveEl) liveEl.textContent = t; }

    // ---------- chrome auto-hide ----------
    function bumpUI() {
        if (!dlg || phase === 'closed') return;
        dlg.classList.remove('zv-ui-hidden');
        clearTimeout(uiTimer);
        uiTimer = setTimeout(() => {
            if (dlg.contains(document.activeElement) && document.activeElement !== dlg &&
                document.activeElement.matches(':focus-visible')) return; // keyboard user is on a button
            dlg.classList.add('zv-ui-hidden');
        }, UI_IDLE);
    }
    function toggleUI() {
        if (dlg.classList.contains('zv-ui-hidden')) bumpUI();
        else { clearTimeout(uiTimer); dlg.classList.add('zv-ui-hidden'); }
    }

    // ---------- gestures ----------
    function sample(p, e) {
        p.samples.push({ t: e.timeStamp, x: e.clientX, y: e.clientY });
        while (p.samples.length > 2 && e.timeStamp - p.samples[0].t > 100) p.samples.shift();
    }
    function velocityOf(p, e) { // px per second
        const s = p.samples;
        if (s.length < 2) return { x: 0, y: 0 };
        const last = s[s.length - 1], first = s[0];
        const dt = last.t - first.t;
        if (dt <= 0 || (e && e.timeStamp - last.t > 80)) return { x: 0, y: 0 };
        return { x: (last.x - first.x) / dt * 1000, y: (last.y - first.y) / dt * 1000 };
    }
    function pinchInfo() {
        const [a, b] = [...pointers.values()];
        return { mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2, d: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)) };
    }

    function onDown(e) {
        if (e.pointerType === 'mouse' && e.button !== 0) return;
        if (phase === 'closing' || phase === 'closed') return;
        if (phase === 'opening') finishOpen();
        try { stage.setPointerCapture(e.pointerId); } catch (err) { /* synthetic */ }
        pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, sx: e.clientX, sy: e.clientY, t0: e.timeStamp, samples: [], type: e.pointerType });
        sample(pointers.get(e.pointerId), e);
        if (pointers.size === 1) {
            stopAnim();
            measureStage();
            g = { type: 'pending', id: e.pointerId, start: Object.assign({}, V) };
        } else if (pointers.size === 2 && usable() && (!g || g.type === 'pending' || g.type === 'pan')) {
            stopAnim();
            clearTimeout(tapTimer); lastTap = null;
            const pi = pinchInfo();
            const q = stagePoint(pi.mx, pi.my);
            g = { type: 'pinch', d0: pi.d, s0: V.s, px: (q.x - V.x) / V.s, py: (q.y - V.y) / V.s, q };
            stage.classList.add('zv-grabbing');
        }
    }

    function onMove(e) {
        const p = pointers.get(e.pointerId);
        if (!p || !g) return;
        p.x = e.clientX; p.y = e.clientY;
        sample(p, e);
        if (g.type === 'pinch') {
            if (pointers.size < 2) return;
            const pi = pinchInfo();
            const raw = g.s0 * pi.d / g.d0;
            const s = raw > MAX ? MAX * Math.pow(raw / MAX, 0.3) : raw < MIN ? MIN * Math.pow(raw / MIN, 0.45) : raw;
            const q = stagePoint(pi.mx, pi.my);
            g.q = q;
            V.s = s; V.x = q.x - s * g.px; V.y = q.y - s * g.py;
            write();
            return;
        }
        if (e.pointerId !== g.id) return;
        const dx = p.x - p.sx, dy = p.y - p.sy;
        if (g.type === 'pending') {
            if (Math.hypot(dx, dy) < TAP_SLOP) return;
            clearTimeout(tapTimer);
            if (V.s > 1.01) g.type = 'pan';
            else if (!usable() && slides.length < 2) g.type = 'dismiss';
            else g.type = Math.abs(dx) > Math.abs(dy) ? 'swipe' : 'dismiss';
            g.start = Object.assign({}, V);
            if (g.type === 'dismiss') dlg.classList.add('zv-dragging');
            stage.classList.add('zv-grabbing');
        }
        if (g.type === 'pan') {
            const b = bounds(V.s);
            V.x = rubberClamp(g.start.x + dx, -b.x, b.x, vw);
            V.y = rubberClamp(g.start.y + dy, -b.y, b.y, vh);
        } else if (g.type === 'swipe') {
            let t = g.start.tx + dx;
            if ((index === 0 && t > 0) || (index === slides.length - 1 && t < 0)) t = Math.sign(t) * rubber(Math.abs(t), vw * 0.5);
            V.tx = t;
        } else if (g.type === 'dismiss') {
            const down = Math.max(0, dy);
            V.y = dy >= 0 ? dy : -rubber(-dy, vh * 0.25);
            V.x = dx * 0.85;
            V.s = 1 - Math.min(1, down / vh) * 0.35;
            V.bg = 1 - Math.min(1, down / (vh * 0.45));
        }
        write();
    }

    function onUp(e) {
        const p = pointers.get(e.pointerId);
        if (!p) return;
        pointers.delete(e.pointerId);
        try { stage.releasePointerCapture(e.pointerId); } catch (err) { /* ignore */ }
        if (!g) return;
        const cancelled = e.type !== 'pointerup';
        if (g.type === 'pinch') {
            if (pointers.size < 2) {
                const ns = clamp(V.s, MIN, MAX);
                let to;
                if (ns <= MIN) to = { s: MIN, x: 0, y: 0 };
                else {
                    const r = ns / V.s;
                    const t = clampView(ns, g.q.x - r * (g.q.x - V.x), g.q.y - r * (g.q.y - V.y));
                    to = { s: ns, x: t.x, y: t.y };
                }
                spring(to, { k: 280 });
                g = { type: 'done' };
            }
        } else if (e.pointerId === g.id) {
            const v = velocityOf(p, e);
            const dx = p.x - p.sx, dy = p.y - p.sy;
            if (g.type === 'pending') {
                if (!cancelled && e.timeStamp - p.t0 < 500) onTap(p, e);
                if (!anim) settle();
            } else if (g.type === 'pan') {
                momentum(v.x, v.y);
            } else if (g.type === 'swipe') {
                const w = vw + GAP;
                let dir = 0;
                if (dx < -w * 0.22 || (v.x < -450 && dx < -20)) dir = 1;
                else if (dx > w * 0.22 || (v.x > 450 && dx > 20)) dir = -1;
                if (dir && !cancelled) go(index + dir, v.x);
                else spring({ tx: 0 }, { k: 320, v: { tx: v.x } });
            } else if (g.type === 'dismiss') {
                dlg.classList.remove('zv-dragging');
                if (!cancelled && ((dy > vh * 0.14 && v.y > -150) || (v.y > 700 && dy > 20))) close({ velocity: v });
                else spring({ s: 1, x: 0, y: 0, bg: 1 }, { k: 300, c: 30, v: { x: v.x, y: v.y } });
            }
            g = pointers.size ? { type: 'done' } : null;
        }
        if (!pointers.size) {
            g = null;
            stage.classList.remove('zv-grabbing');
        }
    }

    function onTap(p, e) {
        const now = e.timeStamp;
        if (lastTap && now - lastTap.t < DOUBLE_MS && Math.hypot(p.x - lastTap.x, p.y - lastTap.y) < 40) {
            clearTimeout(tapTimer);
            lastTap = null;
            if (!usable()) return;
            if (V.s > 1.01) zoomTo(1, 0, 0, true);
            else { const q = stagePoint(p.x, p.y); zoomTo(DOUBLE, q.x, q.y, true); }
            return;
        }
        lastTap = { t: now, x: p.x, y: p.y };
        const mouse = p.type === 'mouse';
        clearTimeout(tapTimer);
        tapTimer = setTimeout(() => {
            lastTap = null;
            if (phase !== 'open') return;
            // Desktop lightbox habit: a click on the black area (outside the photo, at fit) closes
            if (mouse && V.s <= 1.01 && !onImage(p.x, p.y)) close();
            else toggleUI();
        }, DOUBLE_MS);
    }
    function onImage(cx, cy) {
        const sl = cur();
        if (!sl || !sl.loaded) return false;
        const r = sl.frame.getBoundingClientRect();
        return cx >= r.left && cx <= r.right && cy >= r.top && cy <= r.bottom;
    }

    function onWheel(e) {
        e.preventDefault();
        if (phase !== 'open' || g || !usable()) return;
        if (e.target.closest && e.target.closest('.zv-caption') && !e.ctrlKey) return;
        let dy = e.deltaY;
        if (e.deltaMode === 1) dy *= 16; else if (e.deltaMode === 2) dy *= vh;
        dy = clamp(dy, -300, 300);
        if (!g && !anim) measureStage();
        const f = Math.exp(-dy * (e.ctrlKey ? 0.01 : 0.0025));
        const q = stagePoint(e.clientX, e.clientY);
        zoomTo(V.s * f, q.x, q.y, false);
        bumpUI();
    }

    function onKey(e) {
        if (phase !== 'open' && phase !== 'opening') return;
        if (e.altKey || e.metaKey || (e.ctrlKey && !['+', '=', '-', '0'].includes(e.key))) return;
        bumpUI();
        switch (e.key) {
            case 'ArrowLeft': go(index - 1); break;
            case 'ArrowRight': go(index + 1); break;
            case '+': case '=': zoomBy(STEP); break;
            case '-': case '_': zoomBy(1 / STEP); break;
            case '0': if (usable()) zoomTo(1, 0, 0, true); break;
            default: return;
        }
        e.preventDefault();
    }

    // ---------- open / close ----------
    function originRect(pre) {
        if (!origin || index !== originIndex || !origin.isConnected) return null;
        const r = pre || origin.getBoundingClientRect();
        if (r.width < 2 || r.height < 2) return null;
        if (r.bottom <= 0 || r.right <= 0 || r.top >= window.innerHeight || r.left >= window.innerWidth) return null;
        const cs = getComputedStyle(origin);
        if (cs.visibility === 'hidden' && !originHidden) return null;
        return { cx: r.left + r.width / 2 - stageL - vw / 2, cy: r.top + r.height / 2 - stageT - vh / 2, w: r.width, h: r.height };
    }
    let lockGutter = -1;   // -1 = not locked; else the page scrollbar width we hid
    function lockScroll(on) {
        const root = document.documentElement;
        if (on && lockGutter < 0) {
            lockGutter = Math.max(0, window.innerWidth - root.clientWidth);
            root.classList.add('zv-lock');
            return lockGutter > 0;
        }
        if (!on && lockGutter >= 0) {
            const changed = lockGutter > 0;
            lockGutter = -1;
            root.classList.remove('zv-lock');
            return changed;
        }
        return false;
    }
    function hideOrigin(on) {
        if (!origin) return;
        if (on && !originHidden) { originVis = origin.style.visibility; origin.style.visibility = 'hidden'; originHidden = true; }
        else if (!on && originHidden) { origin.style.visibility = originVis; originHidden = false; }
    }

    function open(sources, opts) {
        opts = opts || {};
        const list = (Array.isArray(sources) ? sources : [sources])
            .map(s => (s && typeof s === 'object' && s.src) ? s.src : s)
            .filter(s => typeof s === 'string' && s);
        if (!list.length) return;
        build();
        if (phase !== 'closed') { stopAnim(); if (dlg.open) dlg.close(); cleanup(); }

        returnFocus = document.activeElement;
        caption = opts.caption ? String(opts.caption) : '';
        index = clamp(Math.floor(opts.index || 0), 0, list.length - 1);
        origin = opts.origin && opts.origin.getBoundingClientRect ? opts.origin : null;
        originIndex = index;
        track.innerHTML = '';
        slides = list.map((src, i) => makeSlide(src, i));
        lastFlags = '';

        // Size the first photo straight away if the thumbnail already knows its shape
        const first = cur();
        if (origin) {
            const o = origin.tagName === 'IMG' ? origin : origin.querySelector && origin.querySelector('img');
            if (o && o.naturalWidth) { first.nw = o.naturalWidth; first.nh = o.naturalHeight; }
            else { const r = origin.getBoundingClientRect(); first.nw = r.width; first.nh = r.height; }
            first.el.classList.add('zv-instant');
        }

        dlg.classList.remove('zv-ui-hidden', 'zv-dragging', 'zv-zoomed');
        dlg.classList.add('zv-intro');
        phase = 'opening';
        Object.assign(V, { s: 1, x: 0, y: 0, tx: 0, bg: 0, op: 1 });
        const pre = origin ? origin.getBoundingClientRect() : null; // before the scroll lock reflows the page
        dlg.showModal();
        lockScroll(true);
        try { dlg.focus({ preventScroll: true }); } catch (err) { dlg.focus(); }
        layout();
        paintMeta();
        loadSlide(first); loadSlide(slides[index + 1]); loadSlide(slides[index - 1]);
        announce(slides.length > 1 ? 'Photo ' + (index + 1) + ' of ' + slides.length : '');

        const target = clamp(+opts.startScale || 1, MIN, MAX);
        const end = { s: target, x: 0, y: 0, bg: 1, op: 1 };
        let p;
        const r = reduced() ? null : originRect(pre);
        if (reduced()) {
            Object.assign(V, end, { op: 0 });
            write(true);
            p = tween({ op: 1 }, 180, t => t);
        } else if (r) {
            const f = fitSize(first.nw, first.nh);
            Object.assign(V, { s: Math.max(r.w / f.w, r.h / f.h), x: r.cx, y: r.cy, bg: 0 });
            write(true);
            hideOrigin(true);
            p = spring(end, { k: 300, c: 31 });
        } else {
            Object.assign(V, { s: target * 0.9, bg: 0, op: 0 });
            write(true);
            p = spring(end, { k: 320, c: 36 });
        }
        p.then(() => { if (phase === 'opening') finishOpen(); });
    }

    function finishOpen() {
        if (phase !== 'opening') return;
        stopAnim();
        phase = 'open';
        V.bg = 1; V.op = 1;
        if (!g) { V.s = clamp(V.s, MIN, MAX); const t = V.s <= MIN ? { x: 0, y: 0 } : clampView(V.s, V.x, V.y); V.x = t.x; V.y = t.y; }
        write(true);
        const sl = cur();
        if (sl) sl.el.classList.remove('zv-instant');
        dlg.classList.remove('zv-intro');
        bumpUI();
    }

    function close(opts) {
        if (!dlg || phase === 'closed' || phase === 'closing') return;
        opts = opts || {};
        stopAnim();
        phase = 'closing';
        if (lockScroll(false)) layout(); // page scrollbar is back: re-measure before aiming at the thumbnail
        clearTimeout(tapTimer); clearTimeout(uiTimer); lastTap = null;
        pointers.clear(); g = null;
        stage.classList.remove('zv-grabbing');
        dlg.classList.remove('zv-dragging');
        dlg.classList.add('zv-intro');
        const vel = opts.velocity || { x: 0, y: 0 };
        V.tx = 0;
        let p;
        const r = reduced() ? null : originRect();
        const sl = cur();
        if (reduced()) {
            p = tween({ op: 0 }, 160, t => t);
        } else if (r && sl && !sl.failed) {
            hideOrigin(true);
            p = spring({ s: Math.max(r.w / (sl.fw || vw), r.h / (sl.fh || vh)), x: r.cx, y: r.cy, bg: 0 },
                { k: 340, c: 36, v: { x: vel.x, y: vel.y }, force: true });
        } else if (opts.velocity) {
            const dir = V.y < 0 ? -1 : 1;
            p = tween({ y: V.y + dir * vh * 0.6, bg: 0, op: 0 }, 220);
        } else {
            p = tween({ s: V.s * 0.92, bg: 0, op: 0 }, 200);
        }
        p.then(() => { if (phase === 'closing' && dlg.open) dlg.close(); });
    }

    function cleanup() {
        if (phase === 'closed') return;
        stopAnim();
        cancelAnimationFrame(writeRaf); writeRaf = 0;
        phase = 'closed';
        clearTimeout(tapTimer); clearTimeout(uiTimer); lastTap = null;
        pointers.clear(); g = null;
        hideOrigin(false);
        lockScroll(false);
        origin = null;
        slides.forEach(sl => { sl.img.onload = sl.img.onerror = null; sl.img.removeAttribute('src'); });
        slides = [];
        track.innerHTML = '';
        track.style.transform = '';
        Object.assign(V, { s: 1, x: 0, y: 0, tx: 0, bg: 0, op: 1 });
        dlg.style.opacity = '';
        bgEl.style.opacity = 0;
        dlg.classList.remove('zv-intro', 'zv-dragging', 'zv-zoomed', 'zv-ui-hidden', 'zv-multi');
        stage.classList.remove('zv-grabbing', 'zv-can-pan');
        lastFlags = '';
        announce('');
        const f = returnFocus;
        returnFocus = null;
        if (f && f.isConnected && typeof f.focus === 'function' && f !== document.body) {
            try { f.focus({ preventScroll: true }); } catch (err) { /* ignore */ }
        }
    }

    window.ZoomViewer = {
        open: open,
        close: function () { close(); },
        isOpen: function () { return !!dlg && dlg.open && (phase === 'opening' || phase === 'open'); }
    };
})();
