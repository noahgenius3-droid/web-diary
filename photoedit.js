/* Cordial photo editor — window.PhotoEditor.open(file, { title, done }) -> Promise<File|null>
 *
 * Preview and export are driven by the same "recipe":
 *   1. a chain of CSS-style filter functions (brightness, contrast, saturate, sepia, grayscale, hue-rotate)
 *      -> preview: CSS `filter` on the canvas; export: W3C Filter Effects math, clamped after every step
 *   2. a stack of overlay layers (tints, warmth, fade, vignette) composited with a blend mode
 *      -> preview: absolutely positioned divs with mix-blend-mode; export: the same blend formulas per pixel
 */
(function () {
    'use strict';

    var MAX_EDGE = 2048;
    var THUMB = 112;
    var JPEG_QUALITY = 0.9;

    /* ---------- Presets ---------- */
    // f: filter chain [name, amount]; tints: extra overlay layers; warmth -1..1; fade 0..1; vignette 0..1
    var PRESETS = [
        { id: 'normal', label: 'Normal', f: [] },
        { id: 'vivid', label: 'Vivid', f: [['saturate', 1.4], ['contrast', 1.1], ['brightness', 1.03]] },
        { id: 'warm', label: 'Warm', f: [['saturate', 1.1], ['brightness', 1.02]], warmth: 0.5 },
        { id: 'cool', label: 'Cool', f: [['brightness', 1.03], ['saturate', 0.95]], warmth: -0.5 },
        { id: 'mono', label: 'Mono', f: [['grayscale', 1], ['contrast', 1.06]] },
        { id: 'noir', label: 'Noir', f: [['grayscale', 1], ['contrast', 1.5], ['brightness', 0.92]], vignette: 0.45 },
        { id: 'fade', label: 'Fade', f: [['saturate', 0.8], ['contrast', 0.92]], fade: 0.6 },
        { id: 'vintage', label: 'Vintage', f: [['sepia', 0.35], ['saturate', 0.9], ['contrast', 0.95]], warmth: 0.15, fade: 0.35, vignette: 0.3 },
        { id: 'drama', label: 'Drama', f: [['contrast', 1.35], ['saturate', 1.12], ['brightness', 0.95]], vignette: 0.5 },
        { id: 'golden', label: 'Golden', f: [['sepia', 0.18], ['saturate', 1.25], ['brightness', 1.05]], warmth: 0.55 },
        { id: 'lagos', label: 'Lagos', f: [['saturate', 1.5], ['contrast', 1.12], ['brightness', 1.04]], warmth: 0.38 },
        {
            id: 'dusk', label: 'Dusk', f: [['contrast', 1.06], ['saturate', 1.1], ['brightness', 0.98]], warmth: -0.2,
            tints: [
                { mode: 'multiply', color: [0.93, 0.84, 1], alpha: 1 },
                { mode: 'screen', color: [0.5, 0.16, 0.62], alpha: 0.14 }
            ]
        }
    ];

    var ADJUST = [
        { id: 'brightness', label: 'Brightness', min: -100, max: 100 },
        { id: 'contrast', label: 'Contrast', min: -100, max: 100 },
        { id: 'saturation', label: 'Saturation', min: -100, max: 100 },
        { id: 'warmth', label: 'Warmth', min: -100, max: 100 },
        { id: 'fade', label: 'Fade', min: 0, max: 100 },
        { id: 'vignette', label: 'Vignette', min: 0, max: 100 }
    ];

    var ASPECTS = [
        { id: 'original', label: 'Original', ratio: 0, icon: [14, 18], dashed: true },
        { id: 'square', label: 'Square', sub: '1:1', ratio: 1, icon: [16, 16] },
        { id: 'portrait', label: 'Portrait', sub: '4:5', ratio: 4 / 5, icon: [14, 17.5] },
        { id: 'landscape', label: 'Landscape', sub: '16:9', ratio: 16 / 9, icon: [20, 11.25] }
    ];

    // Vignette curve shared by the CSS gradient and the pixel loop.
    var VIG_INNER = 0.38, VIG_MAX = 0.78, VIG_STOPS = 12;
    function vigEase(t) { return t * t * (3 - 2 * t); }

    /* ---------- Recipe (single source of truth) ---------- */
    function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

    function buildRecipe(preset, adj) {
        var filters = preset.f.slice();
        if (adj.brightness) filters.push(['brightness', 1 + adj.brightness * 0.004]);
        if (adj.contrast) filters.push(['contrast', 1 + adj.contrast * 0.005]);
        if (adj.saturation) filters.push(['saturate', 1 + adj.saturation / 100]);

        var layers = (preset.tints || []).slice();
        var warmth = clamp((preset.warmth || 0) + adj.warmth / 100, -1, 1);
        if (warmth > 0) {
            layers.push({ mode: 'screen', color: [1, 0.55, 0.12], alpha: 0.2 * warmth });
            layers.push({ mode: 'multiply', color: [1, 0.94, 0.78], alpha: warmth });
        } else if (warmth < 0) {
            layers.push({ mode: 'screen', color: [0.1, 0.42, 1], alpha: 0.2 * -warmth });
            layers.push({ mode: 'multiply', color: [0.82, 0.93, 1], alpha: -warmth });
        }
        var fade = clamp((preset.fade || 0) + adj.fade / 100, 0, 1);
        if (fade > 0) layers.push({ mode: 'screen', color: [0.5, 0.49, 0.47], alpha: 0.5 * fade });
        var vig = clamp((preset.vignette || 0) + adj.vignette / 100, 0, 1);
        if (vig > 0) layers.push({ mode: 'vignette', alpha: VIG_MAX * vig });
        return { filters: filters, layers: layers };
    }

    function round(n) { return Math.round(n * 1000) / 1000; }

    function cssFilter(recipe) {
        if (!recipe.filters.length) return 'none';
        return recipe.filters.map(function (op) {
            return op[0] === 'hue-rotate' ? 'hue-rotate(' + round(op[1]) + 'deg)' : op[0] + '(' + round(op[1]) + ')';
        }).join(' ');
    }

    function rgbCss(c, a) {
        return 'rgba(' + Math.round(c[0] * 255) + ',' + Math.round(c[1] * 255) + ',' + Math.round(c[2] * 255) + ',' + (a == null ? 1 : round(a)) + ')';
    }

    function vignetteCss(alpha) {
        var stops = ['rgba(0,0,0,0) ' + Math.round(VIG_INNER * 100) + '%'];
        for (var i = 1; i <= VIG_STOPS; i++) {
            var t = i / VIG_STOPS;
            stops.push('rgba(0,0,0,' + round(alpha * vigEase(t)) + ') ' + round((VIG_INNER + t * (1 - VIG_INNER)) * 100) + '%');
        }
        return 'radial-gradient(ellipse farthest-corner at 50% 50%, ' + stops.join(', ') + ')';
    }

    /* ---------- Pixel math (W3C Filter Effects) ---------- */
    function matrixFor(op) {
        var n = op[0], v = op[1], s, a, c;
        switch (n) {
            case 'brightness': return [v, 0, 0, 0, 0, v, 0, 0, 0, 0, v, 0];
            case 'contrast': c = 0.5 - 0.5 * v; return [v, 0, 0, c, 0, v, 0, c, 0, 0, v, c];
            case 'saturate':
                s = v;
                return [0.213 + 0.787 * s, 0.715 - 0.715 * s, 0.072 - 0.072 * s, 0,
                    0.213 - 0.213 * s, 0.715 + 0.285 * s, 0.072 - 0.072 * s, 0,
                    0.213 - 0.213 * s, 0.715 - 0.715 * s, 0.072 + 0.928 * s, 0];
            case 'grayscale':
                a = 1 - clamp(v, 0, 1);
                return [0.2126 + 0.7874 * a, 0.7152 - 0.7152 * a, 0.0722 - 0.0722 * a, 0,
                    0.2126 - 0.2126 * a, 0.7152 + 0.2848 * a, 0.0722 - 0.0722 * a, 0,
                    0.2126 - 0.2126 * a, 0.7152 - 0.7152 * a, 0.0722 + 0.9278 * a, 0];
            case 'sepia':
                a = 1 - clamp(v, 0, 1);
                return [0.393 + 0.607 * a, 0.769 - 0.769 * a, 0.189 - 0.189 * a, 0,
                    0.349 - 0.349 * a, 0.686 + 0.314 * a, 0.168 - 0.168 * a, 0,
                    0.272 - 0.272 * a, 0.534 - 0.534 * a, 0.131 + 0.869 * a, 0];
            case 'hue-rotate':
                var r = v * Math.PI / 180, cs = Math.cos(r), sn = Math.sin(r);
                return [0.213 + cs * 0.787 - sn * 0.213, 0.715 - cs * 0.715 - sn * 0.715, 0.072 - cs * 0.072 + sn * 0.928, 0,
                    0.213 - cs * 0.213 + sn * 0.143, 0.715 + cs * 0.285 + sn * 0.140, 0.072 - cs * 0.072 - sn * 0.283, 0,
                    0.213 - cs * 0.213 - sn * 0.787, 0.715 - cs * 0.715 + sn * 0.715, 0.072 + cs * 0.928 + sn * 0.072, 0];
        }
        return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0];
    }

    // Processes RGBA pixels in place, in a single pass. w/h are needed for the vignette geometry.
    function processPixels(data, w, h, recipe) {
        var mats = recipe.filters.map(matrixFor);
        var nm = mats.length;
        var layers = recipe.layers;
        var nl = layers.length;
        var hasVig = false, vigA = 0;
        var flat = [];
        for (var li = 0; li < nl; li++) {
            var L = layers[li];
            if (L.mode === 'vignette') { hasVig = true; vigA = L.alpha; flat.push(null); continue; }
            flat.push(L);
        }
        if (!nm && !nl) return;
        var cx = w / 2, cy = h / 2;
        var rx = cx * Math.SQRT2, ry = cy * Math.SQRT2; // ellipse farthest-corner
        var inv = 1 / 255;
        var i = 0;
        for (var y = 0; y < h; y++) {
            var dy2 = 0;
            if (hasVig) { var dy = (y + 0.5 - cy) / ry; dy2 = dy * dy; }
            for (var x = 0; x < w; x++, i += 4) {
                var r = data[i] * inv, g = data[i + 1] * inv, b = data[i + 2] * inv;
                for (var k = 0; k < nm; k++) {
                    var m = mats[k];
                    var nr = m[0] * r + m[1] * g + m[2] * b + m[3];
                    var ng = m[4] * r + m[5] * g + m[6] * b + m[7];
                    var nb = m[8] * r + m[9] * g + m[10] * b + m[11];
                    r = nr < 0 ? 0 : nr > 1 ? 1 : nr;
                    g = ng < 0 ? 0 : ng > 1 ? 1 : ng;
                    b = nb < 0 ? 0 : nb > 1 ? 1 : nb;
                }
                for (var j = 0; j < nl; j++) {
                    var Lj = flat[j];
                    if (Lj === null) {
                        var dx = (x + 0.5 - cx) / rx;
                        var d = Math.sqrt(dx * dx + dy2);
                        if (d > VIG_INNER) {
                            var t = (d - VIG_INNER) / (1 - VIG_INNER);
                            if (t > 1) t = 1;
                            var keep = 1 - vigA * vigEase(t);
                            r *= keep; g *= keep; b *= keep;
                        }
                        continue;
                    }
                    var c = Lj.color, a = Lj.alpha;
                    if (Lj.mode === 'screen') {
                        r += a * c[0] * (1 - r); g += a * c[1] * (1 - g); b += a * c[2] * (1 - b);
                    } else if (Lj.mode === 'multiply') {
                        r *= 1 - a + a * c[0]; g *= 1 - a + a * c[1]; b *= 1 - a + a * c[2];
                    } else { // normal
                        r += (c[0] - r) * a; g += (c[1] - g) * a; b += (c[2] - b) * a;
                    }
                }
                data[i] = r * 255 + 0.5; data[i + 1] = g * 255 + 0.5; data[i + 2] = b * 255 + 0.5;
            }
        }
    }

    /* ---------- Image loading ---------- */
    function isGif(file) {
        return /gif/i.test(file.type || '') || /\.gif$/i.test(file.name || '');
    }

    function loadImage(file) {
        if (window.createImageBitmap) {
            return createImageBitmap(file, { imageOrientation: 'from-image' }).then(function (bmp) {
                return { img: bmp, w: bmp.width, h: bmp.height, done: function () { if (bmp.close) bmp.close(); } };
            }).catch(function () { return loadViaImg(file); });
        }
        return loadViaImg(file);
    }

    function loadViaImg(file) {
        return new Promise(function (resolve, reject) {
            var url = URL.createObjectURL(file);
            var img = new Image();
            img.decoding = 'async';
            img.onload = function () {
                resolve({ img: img, w: img.naturalWidth, h: img.naturalHeight, done: function () { URL.revokeObjectURL(url); } });
            };
            img.onerror = function () { URL.revokeObjectURL(url); reject(new Error('Could not read this image')); };
            img.src = url;
        });
    }

    function makeCanvas(w, h) {
        var c = document.createElement('canvas');
        c.width = Math.max(1, Math.round(w));
        c.height = Math.max(1, Math.round(h));
        return c;
    }

    // Decoded + downscaled source (long edge <= MAX_EDGE), transparent areas flattened to white for JPEG.
    function toSourceCanvas(loaded) {
        var scale = Math.min(1, MAX_EDGE / Math.max(loaded.w, loaded.h));
        var c = makeCanvas(loaded.w * scale, loaded.h * scale);
        var ctx = c.getContext('2d');
        ctx.fillStyle = '#fff';
        ctx.fillRect(0, 0, c.width, c.height);
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(loaded.img, 0, 0, c.width, c.height);
        return c;
    }

    /* ---------- DOM helpers ---------- */
    function h(tag, attrs, kids) {
        var el = document.createElement(tag);
        if (attrs) for (var k in attrs) {
            if (attrs[k] == null || attrs[k] === false) continue;
            if (k === 'class') el.className = attrs[k];
            else if (k === 'text') el.textContent = attrs[k];
            else if (k === 'html') el.innerHTML = attrs[k];
            else el.setAttribute(k, attrs[k] === true ? '' : attrs[k]);
        }
        if (kids) kids.forEach(function (c) { if (c) el.append(c); });
        return el;
    }

    var ICON_ROTATE = '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12a8 8 0 1 0 2.4-5.7"/><path d="M4 4v4h4"/></svg>';

    /* ---------- Editor state ---------- */
    var ui = null;
    var S = null; // current session

    function freshAdj() { return { brightness: 0, contrast: 0, saturation: 0, warmth: 0, fade: 0, vignette: 0 }; }

    function build() {
        var dlg = h('dialog', { class: 'photo-editor', id: 'photo-editor', 'aria-labelledby': 'pe-title' });

        var cancelBtn = h('button', { type: 'button', class: 'pe-btn pe-cancel', text: 'Cancel' });
        var title = h('h2', { class: 'pe-title', id: 'pe-title', text: 'Edit photo' });
        var doneBtn = h('button', { type: 'button', class: 'pe-btn pe-done', text: 'Done' });
        var top = h('header', { class: 'pe-top' }, [cancelBtn, title, doneBtn]);

        var canvasSlot = h('div', { class: 'pe-canvas-slot' });
        var layersEl = h('div', { class: 'pe-layers', 'aria-hidden': 'true' });
        var frame = h('div', { class: 'pe-frame' }, [canvasSlot, layersEl]);
        var status = h('div', { class: 'pe-status', role: 'status', 'aria-live': 'polite' });
        var stage = h('div', { class: 'pe-stage', title: 'Press and hold to compare with the original' }, [frame, status]);

        // Tabs
        var tabDefs = [['filters', 'Filters'], ['adjust', 'Adjust'], ['crop', 'Crop']];
        var tabs = {}, panels = {};
        var tablist = h('div', { class: 'pe-tabs', role: 'tablist', 'aria-label': 'Editing tools' });
        tabDefs.forEach(function (d) {
            tabs[d[0]] = h('button', {
                type: 'button', role: 'tab', class: 'pe-tab', id: 'pe-tab-' + d[0],
                'aria-controls': 'pe-panel-' + d[0], text: d[1]
            });
            tablist.append(tabs[d[0]]);
        });
        var resetBtn = h('button', { type: 'button', class: 'pe-btn pe-reset', text: 'Reset' });

        // Filters panel
        var strip = h('div', { class: 'pe-strip', role: 'group', 'aria-label': 'Filter presets' });
        var presetBtns = {};
        PRESETS.forEach(function (p) {
            var thumb = makeCanvas(THUMB, THUMB);
            thumb.className = 'pe-thumb';
            var b = h('button', { type: 'button', class: 'pe-preset', 'aria-pressed': 'false', 'data-id': p.id }, [
                h('span', { class: 'pe-thumb-wrap' }, [thumb]),
                h('span', { class: 'pe-preset-label', text: p.label })
            ]);
            b._thumb = thumb;
            presetBtns[p.id] = b;
            strip.append(b);
        });
        panels.filters = h('div', { class: 'pe-panel pe-panel-filters' }, [strip]);

        // Adjust panel
        var sliders = {};
        var list = h('div', { class: 'pe-sliders' });
        ADJUST.forEach(function (a) {
            var id = 'pe-adj-' + a.id;
            var input = h('input', { type: 'range', id: id, class: 'pe-range', min: a.min, max: a.max, step: 1, value: 0 });
            var out = h('output', { class: 'pe-val', for: id, text: '0' });
            var label = h('label', { for: id, class: 'pe-label', title: 'Double-tap to reset', text: a.label });
            var row = h('div', { class: 'pe-row' + (a.min < 0 ? ' pe-row-center' : '') }, [
                h('div', { class: 'pe-row-head' }, [label, out]), input
            ]);
            sliders[a.id] = { input: input, out: out, label: label, def: a, row: row };
            list.append(row);
        });
        panels.adjust = h('div', { class: 'pe-panel pe-panel-adjust' }, [list]);

        // Crop panel
        var aspectBtns = {};
        var aspectGroup = h('div', { class: 'pe-aspects', role: 'group', 'aria-label': 'Crop aspect ratio' });
        ASPECTS.forEach(function (a) {
            var icon = h('span', { class: 'pe-aspect-icon' + (a.dashed ? ' pe-dashed' : ''), 'aria-hidden': 'true' });
            icon.style.width = a.icon[0] + 'px';
            icon.style.height = a.icon[1] + 'px';
            var b = h('button', { type: 'button', class: 'pe-aspect', 'aria-pressed': 'false', 'data-id': a.id }, [
                h('span', { class: 'pe-aspect-box' }, [icon]),
                h('span', { class: 'pe-aspect-label', text: a.label }),
                a.sub ? h('span', { class: 'pe-aspect-sub', text: a.sub }) : null
            ]);
            aspectBtns[a.id] = b;
            aspectGroup.append(b);
        });
        var rotateBtn = h('button', { type: 'button', class: 'pe-btn pe-rotate', 'aria-label': 'Rotate 90 degrees clockwise' });
        rotateBtn.innerHTML = ICON_ROTATE + '<span>Rotate 90°</span>';
        panels.crop = h('div', { class: 'pe-panel pe-panel-crop' }, [aspectGroup, rotateBtn]);

        var panelWrap = h('div', { class: 'pe-panels' });
        tabDefs.forEach(function (d) {
            var p = panels[d[0]];
            p.id = 'pe-panel-' + d[0];
            p.setAttribute('role', 'tabpanel');
            p.setAttribute('aria-labelledby', 'pe-tab-' + d[0]);
            panelWrap.append(p);
        });

        var toolbar = h('div', { class: 'pe-toolbar' }, [tablist, resetBtn]);
        var controls = h('div', { class: 'pe-controls' }, [panelWrap, toolbar]);
        var body = h('div', { class: 'pe-body' }, [stage, controls]);
        dlg.append(top, body);
        document.body.append(dlg);

        ui = {
            dlg: dlg, title: title, cancelBtn: cancelBtn, doneBtn: doneBtn, stage: stage, frame: frame,
            canvasSlot: canvasSlot, layersEl: layersEl, status: status, tabs: tabs, panels: panels,
            presetBtns: presetBtns, strip: strip, sliders: sliders, aspectBtns: aspectBtns,
            rotateBtn: rotateBtn, resetBtn: resetBtn
        };
        wire();
    }

    function wire() {
        ui.cancelBtn.addEventListener('click', function () { finish(null); });
        ui.doneBtn.addEventListener('click', exportImage);
        ui.dlg.addEventListener('cancel', function (e) { e.preventDefault(); finish(null); });
        // Closed from outside (e.g. the app's back-button handling): treat as cancel.
        ui.dlg.addEventListener('close', function () { if (S && !S.settled) finish(null, true); });

        Object.keys(ui.tabs).forEach(function (k) {
            ui.tabs[k].addEventListener('click', function () { selectTab(k); });
        });
        ui.tabs.filters.parentNode.addEventListener('keydown', function (e) {
            var keys = Object.keys(ui.tabs);
            var i = keys.indexOf(S && S.tab);
            var n = null;
            if (e.key === 'ArrowRight') n = keys[(i + 1) % keys.length];
            else if (e.key === 'ArrowLeft') n = keys[(i + keys.length - 1) % keys.length];
            else if (e.key === 'Home') n = keys[0];
            else if (e.key === 'End') n = keys[keys.length - 1];
            if (n) { e.preventDefault(); selectTab(n); ui.tabs[n].focus(); }
        });

        ui.strip.addEventListener('click', function (e) {
            var b = e.target.closest('.pe-preset');
            if (!b || !S) return;
            S.preset = PRESETS.filter(function (p) { return p.id === b.dataset.id; })[0];
            syncPresets(true);
            render();
        });

        Object.keys(ui.sliders).forEach(function (k) {
            var s = ui.sliders[k];
            s.input.addEventListener('input', function () {
                if (!S) return;
                S.adj[k] = +s.input.value;
                syncSlider(k);
                render();
            });
            var last = 0;
            s.label.addEventListener('click', function () {
                var now = Date.now();
                if (now - last < 350) { last = 0; if (S) { S.adj[k] = 0; syncSlider(k); render(); } }
                else last = now;
            });
        });

        Object.keys(ui.aspectBtns).forEach(function (k) {
            ui.aspectBtns[k].addEventListener('click', function () {
                if (!S || S.aspect === k) return;
                S.aspect = k;
                syncCrop();
                rebuildBase();
            });
        });
        ui.rotateBtn.addEventListener('click', function () {
            if (!S || !S.source) return;
            S.rotation = (S.rotation + 90) % 360;
            rebuildBase();
        });
        ui.resetBtn.addEventListener('click', function () {
            if (!S) return;
            var geo = S.rotation !== 0 || S.aspect !== 'original';
            S.preset = PRESETS[0];
            S.adj = freshAdj();
            S.rotation = 0;
            S.aspect = 'original';
            syncAll();
            if (geo) rebuildBase(); else render();
        });

        // Press and hold the photo to compare with the original.
        var holdTimer = null;
        function endHold() { clearTimeout(holdTimer); ui.stage.classList.remove('pe-comparing'); }
        ui.stage.addEventListener('pointerdown', function (e) {
            if (e.button) return;
            holdTimer = setTimeout(function () { ui.stage.classList.add('pe-comparing'); }, 180);
        });
        ['pointerup', 'pointercancel', 'pointerleave'].forEach(function (t) { ui.stage.addEventListener(t, endHold); });
        ui.stage.addEventListener('contextmenu', function (e) { e.preventDefault(); });

        if (window.ResizeObserver) new ResizeObserver(fitFrame).observe(ui.stage);
        else window.addEventListener('resize', fitFrame);
    }

    function selectTab(k) {
        if (!S) return;
        S.tab = k;
        Object.keys(ui.tabs).forEach(function (t) {
            var on = t === k;
            ui.tabs[t].setAttribute('aria-selected', on ? 'true' : 'false');
            ui.tabs[t].tabIndex = on ? 0 : -1;
            ui.panels[t].hidden = !on;
        });
    }

    function fmt(v) { return v > 0 ? '+' + v : String(v); }

    function syncSlider(k) {
        var s = ui.sliders[k], v = S.adj[k];
        s.input.value = v;
        s.out.textContent = fmt(v);
        var d = s.def;
        // Track fill from the neutral point (0) to the value.
        var zero = (0 - d.min) / (d.max - d.min) * 100, pos = (v - d.min) / (d.max - d.min) * 100;
        s.input.style.setProperty('--pe-a', Math.min(zero, pos) + '%');
        s.input.style.setProperty('--pe-b', Math.max(zero, pos) + '%');
        s.row.classList.toggle('pe-changed', v !== 0);
    }

    function syncPresets(scroll) {
        Object.keys(ui.presetBtns).forEach(function (id) {
            var on = id === S.preset.id;
            ui.presetBtns[id].setAttribute('aria-pressed', on ? 'true' : 'false');
            if (on && scroll) {
                var b = ui.presetBtns[id], st = ui.strip;
                var target = b.offsetLeft - (st.clientWidth - b.offsetWidth) / 2;
                if (st.scrollTo) st.scrollTo({ left: target, behavior: reducedMotion() ? 'auto' : 'smooth' });
            }
        });
    }

    function syncCrop() {
        Object.keys(ui.aspectBtns).forEach(function (id) {
            ui.aspectBtns[id].setAttribute('aria-pressed', id === S.aspect ? 'true' : 'false');
        });
    }

    function syncAll() {
        Object.keys(ui.sliders).forEach(syncSlider);
        syncPresets(false);
        syncCrop();
    }

    function reducedMotion() {
        return document.documentElement.getAttribute('data-motion') === 'reduce' ||
            (window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches);
    }

    /* ---------- Rendering ---------- */
    function rebuildBase() {
        if (!S || !S.source) return;
        var src = S.source;
        var rot = S.rotation;
        var rw = rot % 180 ? src.height : src.width;
        var rh = rot % 180 ? src.width : src.height;
        var ratio = ASPECTS.filter(function (a) { return a.id === S.aspect; })[0].ratio || rw / rh;
        var cw = rw, ch = rw / ratio;
        if (ch > rh) { ch = rh; cw = rh * ratio; }
        var base = makeCanvas(cw, ch);
        base.className = 'pe-canvas';
        var ctx = base.getContext('2d');
        ctx.imageSmoothingQuality = 'high';
        ctx.translate(base.width / 2, base.height / 2);
        ctx.rotate(rot * Math.PI / 180);
        ctx.drawImage(src, -src.width / 2, -src.height / 2);
        if (S.base) { S.base.width = S.base.height = 0; }
        S.base = base;
        ui.canvasSlot.replaceChildren(base);
        fitFrame();
        renderThumbs();
        render();
    }

    function fitFrame() {
        if (!S || !S.base) return;
        var sw = ui.stage.clientWidth, sh = ui.stage.clientHeight;
        var pad = window.matchMedia('(min-width: 760px)').matches ? 24 : 0;
        var aw = Math.max(1, sw - pad * 2), ah = Math.max(1, sh - pad * 2);
        var scale = Math.min(aw / S.base.width, ah / S.base.height);
        ui.frame.style.width = Math.floor(S.base.width * scale) + 'px';
        ui.frame.style.height = Math.floor(S.base.height * scale) + 'px';
    }

    function renderLayers(el, layers) {
        var need = layers.length;
        while (el.children.length > need) el.lastChild.remove();
        while (el.children.length < need) el.append(h('div', { class: 'pe-layer' }));
        layers.forEach(function (L, i) {
            var d = el.children[i];
            if (L.mode === 'vignette') {
                d.style.background = vignetteCss(L.alpha);
                d.style.mixBlendMode = 'normal';
            } else {
                d.style.background = rgbCss(L.color, L.alpha);
                d.style.mixBlendMode = L.mode;
            }
        });
    }

    function render() {
        if (!S || !S.base) return;
        var recipe = buildRecipe(S.preset, S.adj);
        S.base.style.filter = cssFilter(recipe);
        renderLayers(ui.layersEl, recipe.layers);
    }

    function renderThumbs() {
        var b = S.base;
        var side = Math.min(b.width, b.height);
        var sx = (b.width - side) / 2, sy = (b.height - side) / 2;
        var tmp = makeCanvas(THUMB, THUMB);
        var tctx = tmp.getContext('2d');
        tctx.imageSmoothingQuality = 'high';
        tctx.drawImage(b, sx, sy, side, side, 0, 0, THUMB, THUMB);
        var src = tctx.getImageData(0, 0, THUMB, THUMB);
        PRESETS.forEach(function (p) {
            var img = new ImageData(new Uint8ClampedArray(src.data), THUMB, THUMB);
            processPixels(img.data, THUMB, THUMB, buildRecipe(p, freshAdj()));
            ui.presetBtns[p.id]._thumb.getContext('2d').putImageData(img, 0, 0);
        });
        tmp.width = tmp.height = 0;
    }

    /* ---------- Export ---------- */
    function baseName(file) {
        var n = (file && file.name) || 'photo';
        n = n.replace(/\.[^./\\]+$/, '');
        return (n || 'photo') + '.jpg';
    }

    function exportImage() {
        if (!S || !S.base || S.saving) return;
        S.saving = true;
        var btn = ui.doneBtn;
        btn.disabled = true;
        btn.setAttribute('aria-busy', 'true');
        btn.textContent = 'Saving…';
        ui.cancelBtn.disabled = true;
        var session = S;
        // Let the button repaint before the pixel loop blocks the thread.
        new Promise(function (r) { requestAnimationFrame(function () { setTimeout(r, 0); }); }).then(function () {
            var b = session.base;
            var out = makeCanvas(b.width, b.height);
            var ctx = out.getContext('2d');
            ctx.drawImage(b, 0, 0);
            var img = ctx.getImageData(0, 0, out.width, out.height);
            processPixels(img.data, out.width, out.height, buildRecipe(session.preset, session.adj));
            ctx.putImageData(img, 0, 0);
            return new Promise(function (resolve, reject) {
                out.toBlob(function (blob) {
                    out.width = out.height = 0;
                    blob ? resolve(blob) : reject(new Error('Export failed'));
                }, 'image/jpeg', JPEG_QUALITY);
            });
        }).then(function (blob) {
            if (S !== session) return;
            finish(new File([blob], baseName(session.file), { type: 'image/jpeg', lastModified: Date.now() }));
        }).catch(function (err) {
            if (S !== session) return;
            console.error('PhotoEditor export failed', err);
            session.saving = false;
            resetDoneBtn();
            ui.cancelBtn.disabled = false;
            ui.status.textContent = 'Couldn’t save this photo. Try again.';
        });
    }

    function resetDoneBtn() {
        ui.doneBtn.disabled = false;
        ui.doneBtn.removeAttribute('aria-busy');
        ui.doneBtn.textContent = S ? S.doneLabel : 'Done';
    }

    /* ---------- Session lifecycle ---------- */
    function finish(result, alreadyClosed) {
        var session = S;
        if (!session || session.settled) return;
        session.settled = true;
        S = null;
        if (!alreadyClosed && ui.dlg.open) ui.dlg.close();
        ui.cancelBtn.disabled = false;
        ui.doneBtn.disabled = false;
        ui.doneBtn.removeAttribute('aria-busy');
        ui.stage.classList.remove('pe-comparing');
        if (session.base) { session.base.width = session.base.height = 0; }
        if (session.source) { session.source.width = session.source.height = 0; }
        ui.canvasSlot.replaceChildren();
        ui.layersEl.replaceChildren();
        session.resolve(result);
    }

    function open(file, opts) {
        opts = opts || {};
        if (!file) return Promise.resolve(null);
        if (isGif(file)) return Promise.resolve(file);
        if (!ui) build();
        if (S) finish(null);

        return new Promise(function (resolve) {
            var session = {
                file: file, resolve: resolve, settled: false, saving: false,
                preset: PRESETS[0], adj: freshAdj(), rotation: 0, aspect: 'original', tab: 'filters',
                doneLabel: opts.done || 'Done', source: null, base: null
            };
            S = session;
            ui.title.textContent = opts.title || 'Edit photo';
            ui.doneBtn.textContent = session.doneLabel;
            ui.doneBtn.disabled = true; // until the image is ready
            ui.status.textContent = 'Loading photo…';
            ui.stage.classList.add('pe-loading');
            syncAll();
            selectTab('filters');
            ui.strip.scrollLeft = 0;
            if (!ui.dlg.open) ui.dlg.showModal();
            ui.cancelBtn.focus();

            loadImage(file).then(function (loaded) {
                var src;
                try { src = toSourceCanvas(loaded); } finally { loaded.done(); }
                if (S !== session) { src.width = src.height = 0; return; }
                session.source = src;
                ui.stage.classList.remove('pe-loading');
                ui.status.textContent = '';
                resetDoneBtn();
                rebuildBase();
            }).catch(function (err) {
                if (S !== session) return;
                console.warn('PhotoEditor: could not decode image, using original', err);
                ui.stage.classList.remove('pe-loading');
                finish(file); // can't edit it — hand back the original untouched
            });
        });
    }

    // Exposed for tests; not part of the public contract.
    window.PhotoEditor = { open: open, _presets: PRESETS.map(function (p) { return p.id; }) };
    Object.defineProperty(window.PhotoEditor, '_internals', {
        value: { buildRecipe: buildRecipe, cssFilter: cssFilter, processPixels: processPixels, freshAdj: freshAdj, PRESETS: PRESETS },
        enumerable: false
    });
})();
