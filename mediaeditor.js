// The media editor: picking a photo, several photos or a video for a post, reel or story opens this full-screen
// screen before anything is published. The media fills the screen; a column of tools sits on the right — Text,
// Stickers, Sound, Effects, Volume and More — the chosen sound shows at the top (tap to change, × to remove), and
// the caption, who sees it and Share sit at the bottom.
//
// diaryMediaEditor.open({ files, mode: 'post' | 'reel' | 'story', caption, audience, alsoStory, audio, ... })
// resolves with null (discarded) or
//   { files, isVideo, caption, audience, alsoStory, audio, video: { filter, overlay, ownVolume } }
// Photos come back with their effect, text and stickers drawn in. A video comes back untouched, with its effect
// (a CSS filter), an overlay canvas (text + stickers) and the volume of its own sound — stories.js records those
// into the uploaded video together with the sound.
document.addEventListener('DOMContentLoaded', () => {
    const app = window.diaryApp;
    if (!app) return;
    const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const ic = id => `<svg class="i" aria-hidden="true"><use href="#${id}"/></svg>`;
    const I = () => (window.diarySocial && window.diarySocial.internals) || {};
    const lib = () => window.diaryAudioLib;
    const canvasFilter = typeof CanvasRenderingContext2D !== 'undefined' && 'filter' in CanvasRenderingContext2D.prototype;

    // ---------- Effects: CSS filters on screen, the same maths when the photo is saved ----------
    const FX = [
        ['normal', 'Normal', ''],
        ['lagos', 'Lagos', 'saturate(1.25) sepia(0.15) contrast(1.05)'],
        ['harmattan', 'Harmattan', 'sepia(0.35) saturate(0.85) brightness(1.06) contrast(0.92)'],
        ['vivid', 'Vivid', 'saturate(1.5) contrast(1.12)'],
        ['golden', 'Golden', 'sepia(0.3) saturate(1.4) hue-rotate(-8deg) brightness(1.04)'],
        ['cool', 'Cool', 'hue-rotate(-12deg) saturate(1.1) brightness(1.03)'],
        ['rosy', 'Rosy', 'hue-rotate(-18deg) saturate(1.2) brightness(1.04)'],
        ['fade', 'Fade', 'contrast(0.85) brightness(1.1) saturate(0.8)'],
        ['mono', 'Mono', 'grayscale(1) contrast(1.1)'],
        ['noir', 'Noir', 'grayscale(1) contrast(1.45) brightness(0.92)']
    ];
    const fxCss = id => (FX.find(f => f[0] === id) || FX[0])[2];

    // The filter functions as colour matrices (Filter Effects spec), applied in order with clamping — what CSS does
    function opMatrix(name, a) {
        const sat = s => [0.213 + 0.787 * s, 0.715 - 0.715 * s, 0.072 - 0.072 * s, 0, 0.213 - 0.213 * s, 0.715 + 0.285 * s, 0.072 - 0.072 * s, 0, 0.213 - 0.213 * s, 0.715 - 0.715 * s, 0.072 + 0.928 * s, 0];
        if (name === 'brightness') return [a, 0, 0, 0, 0, a, 0, 0, 0, 0, a, 0];
        if (name === 'contrast') { const o = 0.5 - 0.5 * a; return [a, 0, 0, o, 0, a, 0, o, 0, 0, a, o]; }
        if (name === 'saturate') return sat(a);
        if (name === 'grayscale') { const g = 1 - Math.min(1, a); return [0.2126 + 0.7874 * g, 0.7152 - 0.7152 * g, 0.0722 - 0.0722 * g, 0, 0.2126 - 0.2126 * g, 0.7152 + 0.2848 * g, 0.0722 - 0.0722 * g, 0, 0.2126 - 0.2126 * g, 0.7152 - 0.7152 * g, 0.0722 + 0.9278 * g, 0]; }
        if (name === 'sepia') { const g = 1 - Math.min(1, a); return [0.393 + 0.607 * g, 0.769 - 0.769 * g, 0.189 - 0.189 * g, 0, 0.349 - 0.349 * g, 0.686 + 0.314 * g, 0.168 - 0.168 * g, 0, 0.272 - 0.272 * g, 0.534 - 0.534 * g, 0.131 + 0.869 * g, 0]; }
        if (name === 'hue-rotate') {
            const r = a * Math.PI / 180, c = Math.cos(r), s = Math.sin(r);
            return [0.213 + c * 0.787 - s * 0.213, 0.715 - c * 0.715 - s * 0.715, 0.072 - c * 0.072 + s * 0.928, 0,
                0.213 - c * 0.213 + s * 0.143, 0.715 + c * 0.285 + s * 0.140, 0.072 - c * 0.072 - s * 0.283, 0,
                0.213 - c * 0.213 - s * 0.787, 0.715 - c * 0.715 + s * 0.715, 0.072 + c * 0.928 + s * 0.072, 0];
        }
        return null;
    }
    function applyFilterPixels(ctx, w, h, css) {
        const ops = [...css.matchAll(/([a-z-]+)\(([-\d.]+)(deg)?\)/g)].map(m => opMatrix(m[1], Number(m[2]))).filter(Boolean);
        if (!ops.length) return;
        const img = ctx.getImageData(0, 0, w, h);
        const d = img.data;
        const cl = v => (v < 0 ? 0 : v > 1 ? 1 : v);
        for (let i = 0; i < d.length; i += 4) {
            let r = d[i] / 255, g = d[i + 1] / 255, b = d[i + 2] / 255;
            for (const m of ops) {
                const nr = cl(m[0] * r + m[1] * g + m[2] * b + m[3]);
                const ng = cl(m[4] * r + m[5] * g + m[6] * b + m[7]);
                const nb = cl(m[8] * r + m[9] * g + m[10] * b + m[11]);
                r = nr; g = ng; b = nb;
            }
            d[i] = r * 255; d[i + 1] = g * 255; d[i + 2] = b * 255;
        }
        ctx.putImageData(img, 0, 0);
    }

    // ---------- Text and stickers ----------
    const COLORS = ['#ffffff', '#111111', '#facc15', '#f97316', '#ef4444', '#ec4899', '#8b5cf6', '#3b82f6', '#22c55e'];
    const EMOJI = ['🙏', '❤️', '🔥', '😂', '😍', '🎉', '✨', '🙌', '👏', '💯', '😎', '🥳', '🇳🇬', '☀️', '🌙', '⭐', '🎶', '📍', '☕', '🍲', '⚽', '📖', '✝️', '🕊️'];
    const LABELS = () => {
        const now = new Date();
        return ['Amen 🙏', 'Blessed', 'Good morning ☀️', 'Happy Sunday', 'Naija 🇳🇬', 'Thank God',
            now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }), now.toLocaleDateString([], { day: 'numeric', month: 'short' })];
    };
    const onColor = hex => { const n = parseInt(hex.slice(1), 16); const l = (0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255; return l > 0.6 ? '#111111' : '#ffffff'; };
    const SIZES = { text: 0.068, emoji: 0.2, label: 0.055 };
    const EMOJI_FONT = '"Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji",sans-serif';

    function ovHTML(o, i) {
        const style = `left:${o.x * 100}%;top:${o.y * 100}%;--s:${o.scale};--r:${o.rot}rad`;
        const label = o.type === 'text' ? `Text: ${o.text}` : `Sticker: ${o.text}`;
        if (o.type === 'text') {
            return `<div class="me-ov text${o.boxed ? ' boxed' : ''}" data-ov="${i}" role="button" tabindex="0" aria-label="${esc(label)} — drag to move, tap to edit" style="${style};color:${o.boxed ? onColor(o.color) : o.color};--bg:${o.color}">${esc(o.text).replace(/\n/g, '<br>')}</div>`;
        }
        return `<div class="me-ov ${o.kind}" data-ov="${i}" role="button" tabindex="0" aria-label="${esc(label)} — drag to move" style="${style}">${esc(o.text)}</div>`;
    }
    // Draw overlays onto a canvas the size of the picture — the same proportions as on screen
    function drawOverlays(ctx, W, H, list) {
        list.forEach(o => {
            ctx.save();
            ctx.translate(o.x * W, o.y * H);
            ctx.rotate(o.rot);
            ctx.scale(o.scale, o.scale);
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            if (o.type === 'text') {
                const fs = SIZES.text * W;
                ctx.font = `800 ${fs}px Mulish, system-ui, sans-serif`;
                const lines = o.text.split('\n');
                const lh = fs * 1.2;
                const tw = Math.max(...lines.map(l => ctx.measureText(l).width));
                const th = lh * lines.length;
                if (o.boxed) {
                    const px = fs * 0.45, py = fs * 0.22;
                    roundRect(ctx, -tw / 2 - px, -th / 2 - py, tw + px * 2, th + py * 2, fs * 0.3);
                    ctx.fillStyle = o.color;
                    ctx.fill();
                    ctx.fillStyle = onColor(o.color);
                } else {
                    ctx.fillStyle = o.color;
                    ctx.shadowColor = 'rgba(0,0,0,0.45)';
                    ctx.shadowBlur = fs * 0.15;
                }
                lines.forEach((l, k) => ctx.fillText(l, 0, -th / 2 + lh * (k + 0.5)));
            } else if (o.kind === 'emoji') {
                const fs = SIZES.emoji * W;
                ctx.font = `${fs}px ${EMOJI_FONT}`;
                ctx.fillText(o.text, 0, fs * 0.04);
            } else {
                const fs = SIZES.label * W;
                ctx.font = `800 ${fs}px Mulish, system-ui, ${EMOJI_FONT}`;
                const tw = ctx.measureText(o.text).width;
                const px = fs * 0.6, py = fs * 0.4;
                roundRect(ctx, -tw / 2 - px, -fs / 2 - py, tw + px * 2, fs + py * 2, fs * 0.6);
                ctx.fillStyle = '#ffffff';
                ctx.shadowColor = 'rgba(0,0,0,0.25)';
                ctx.shadowBlur = fs * 0.3;
                ctx.fill();
                ctx.shadowColor = 'transparent';
                ctx.fillStyle = '#111111';
                ctx.fillText(o.text, 0, fs * 0.04);
            }
            ctx.restore();
        });
    }
    function roundRect(ctx, x, y, w, h, r) {
        ctx.beginPath();
        ctx.moveTo(x + r, y);
        ctx.arcTo(x + w, y, x + w, y + h, r);
        ctx.arcTo(x + w, y + h, x, y + h, r);
        ctx.arcTo(x, y + h, x, y, r);
        ctx.arcTo(x, y, x + w, y, r);
        ctx.closePath();
    }

    // ---------- The screen ----------
    const dlg = document.createElement('dialog');
    dlg.className = 'me';
    dlg.setAttribute('aria-label', 'Edit before sharing');
    document.body.append(dlg);
    let E = null;

    const MODE = {
        post: { share: 'Share', who: null },
        reel: { share: 'Share reel', who: 'Reel · Friends' },
        story: { share: 'Share to your story', who: 'Your story · Friends' }
    };

    function open(opts) {
        const files = (opts.files || []).filter(Boolean);
        if (!files.length) return Promise.resolve(null);
        if (E) finish(null);
        return new Promise(resolve => {
            E = {
                mode: opts.mode || 'post', resolve,
                items: files.map(itemFor),
                idx: 0,
                caption: opts.caption || '',
                maxCaption: opts.maxCaption || 2200,
                audience: opts.audience || 'friends',
                alsoStory: !!opts.alsoStory,
                offerStory: opts.offerStory !== false && opts.mode !== 'story',
                allowAudio: opts.allowAudio !== false,
                audio: opts.audio || null,
                soundVol: (opts.audio && opts.audio.music && opts.audio.music.volume) || 0.8,
                ownVol: 1,
                maxPhotos: opts.maxPhotos || 1,
                addFiles: opts.addFiles || null,
                panel: null,
                player: null,
                note: opts.note || ''
            };
            paint();
            dlg.showModal();
            document.documentElement.classList.add('me-open');
            requestAnimationFrame(layout);
            if (E.audio) startSound();
        });
    }
    function itemFor(file) {
        const isVideo = (file.type || '').startsWith('video/') || /\.(mp4|mov|m4v|webm)$/i.test(file.name || '');
        return { file, url: URL.createObjectURL(file), isVideo, fx: 'normal', ov: [], w: 0, h: 0 };
    }
    function finish(value) {
        if (!E) return;
        const e = E;
        E = null;
        stopSound(e);
        e.items.forEach(it => URL.revokeObjectURL(it.url));
        if (e.thumbUrls) e.thumbUrls.forEach(u => URL.revokeObjectURL(u));
        if (dlg.open) dlg.close();
        dlg.innerHTML = '';
        document.documentElement.classList.remove('me-open');
        e.resolve(value);
    }
    const cur = () => E.items[E.idx];
    const hasVideo = () => E.items.some(it => it.isVideo);
    const edited = () => E.items.some(it => it.fx !== 'normal' || it.ov.length) || !!E.audio || !!E.caption.trim();

    function paint() {
        const m = MODE[E.mode];
        const multi = E.items.length > 1;
        dlg.innerHTML = `
            <div class="me-frame">
                <div class="me-stage" id="me-stage">
                    <img class="me-backdrop" id="me-backdrop" alt="" aria-hidden="true"${cur().isVideo ? ' hidden' : ` src="${cur().url}"`}>
                    <div class="me-slides" id="me-slides">${E.items.map((it, i) => `
                        <div class="me-slide" data-i="${i}">
                            <div class="me-box" id="me-box-${i}">
                                ${it.isVideo
                                    ? `<video class="me-media" src="${it.url}" playsinline autoplay loop muted preload="auto" style="filter:${fxCss(it.fx) || 'none'}"></video>`
                                    : `<img class="me-media" src="${it.url}" alt="Photo ${i + 1}${multi ? ` of ${E.items.length}` : ''}" style="filter:${fxCss(it.fx) || 'none'}">`}
                                <div class="me-ov-layer" data-layer="${i}">${it.ov.map(ovHTML).join('')}</div>
                            </div>
                        </div>`).join('')}</div>
                    ${multi ? `<div class="me-dots" aria-hidden="true">${E.items.map((_, i) => `<i${i === E.idx ? ' class="on"' : ''}></i>`).join('')}</div>` : ''}
                </div>
                <header class="me-top">
                    <button type="button" class="me-round" data-me="close" aria-label="Discard and go back">${ic('i-close')}</button>
                    <div class="me-chip-slot" id="me-chip">${chipHTML()}</div>
                    <span class="me-top-sp" aria-hidden="true"></span>
                </header>
                ${toolsHTML()}
                <div class="me-panel" id="me-panel"${E.panel && E.panel !== 'more' ? '' : ' hidden'}>${panelHTML()}</div>
                <footer class="me-foot">
                    <label class="me-cap"><span class="sr-only">Caption</span><textarea id="me-cap" rows="1" maxlength="${E.maxCaption}" placeholder="Add a caption…" enterkeyhint="done">${esc(E.caption)}</textarea></label>
                    <div class="me-actions">
                        ${E.mode === 'post'
                            ? `<button type="button" class="me-pill" data-me="audience" aria-label="Who can see this: ${E.audience === 'public' ? 'Everyone' : 'Friends'} — tap to change">${ic(E.audience === 'public' ? 'i-globe' : 'i-lock')}<span>${E.audience === 'public' ? 'Everyone' : 'Friends'}</span></button>`
                            : `<span class="me-pill static">${ic(E.mode === 'reel' ? 'i-reel' : 'i-plus')}<span>${esc(m.who)}</span></span>`}
                        ${E.offerStory ? `<button type="button" class="me-pill" data-me="story" aria-pressed="${E.alsoStory}" aria-label="Also share to your story"><span class="me-ring" aria-hidden="true"></span><span>Your story</span></button>` : ''}
                        <button type="button" class="me-go" data-me="publish" aria-label="${esc(m.share)}">${ic('i-arrow-right')}</button>
                    </div>
                </footer>
                <div class="me-trash" id="me-trash" aria-hidden="true">${ic('i-trash')}</div>
                <div class="me-sheet-back" id="me-te" hidden></div>
                <div class="me-confirm" id="me-confirm" hidden role="alertdialog" aria-labelledby="me-cf-h">
                    <div class="me-cf-card"><h3 id="me-cf-h">Discard this ${E.mode === 'story' ? 'story' : E.mode === 'reel' ? 'reel' : 'post'}?</h3><p>Your edits won’t be saved.</p>
                        <button type="button" class="me-cf-btn danger" data-me="discard">Discard</button>
                        <button type="button" class="me-cf-btn" data-me="keep">Keep editing</button></div>
                </div>
            </div>`;
        const slides = dlg.querySelector('#me-slides');
        slides.scrollLeft = E.idx * slides.clientWidth;
        slides.addEventListener('scroll', () => {
            const i = Math.round(slides.scrollLeft / Math.max(1, slides.clientWidth));
            if (!E || i === E.idx || !E.items[i]) return;
            E.idx = i;
            dlg.querySelectorAll('.me-dots i').forEach((d, k) => d.classList.toggle('on', k === i));
            const bd = dlg.querySelector('#me-backdrop');
            if (bd) { bd.hidden = E.items[i].isVideo; if (!E.items[i].isVideo) bd.src = E.items[i].url; }
            paintTools();
            if (E.panel === 'fx') refreshPanel();
        }, { passive: true });
        dlg.querySelectorAll('.me-media').forEach((el, i) => {
            const it = E.items[i];
            const ready = () => { it.w = el.naturalWidth || el.videoWidth; it.h = el.naturalHeight || el.videoHeight; layout(); };
            if (it.isVideo) {
                el.addEventListener('loadedmetadata', ready, { once: true });
                el.volume = E.ownVol;
                el.muted = !E.unmuted;
            } else if (el.complete && el.naturalWidth) ready();
            else el.addEventListener('load', ready, { once: true });
        });
        autoGrow();
        layout();
    }
    function chipHTML() {
        if (!E.allowAudio) return '';
        const a = E.audio;
        if (!a) return `<button type="button" class="me-chip add" data-me="sound">${ic('i-music')}<span>Add sound</span></button>`;
        const mus = a.music;
        const line = mus ? `${mus.artist} · ${mus.title}` : a.name || 'Your audio';
        return `<span class="me-chip-wrap"><button type="button" class="me-chip" data-me="sound" aria-label="Sound: ${esc(line)} — tap to change">
                ${mus && lib() ? lib().coverHTML({ cover: mus.cover, style: mus.style }) : `<span class="al-cover own">${ic('i-music')}</span>`}
                <span class="me-chip-text"><span class="me-marquee${line.length > 26 ? ' run' : ''}">${esc(line)}${line.length > 26 ? `<span aria-hidden="true">${esc(line)}</span>` : ''}</span></span>
            </button><button type="button" class="me-chip-x" data-me="sound-x" aria-label="Remove sound">${ic('i-close')}</button></span>
            <small class="me-chip-sub">${a.music ? `${fmtT(a.music.start)}–${fmtT(a.music.start + a.music.length)} · tap to change` : 'Your audio'}</small>`;
    }
    const fmtT = s => { s = Math.max(0, Math.round(s || 0)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
    function moreHTML() {
        const it = cur();
        const items = [];
        if (!it.isVideo && window.PhotoEditor && it.file.type !== 'image/gif') items.push(['crop', 'i-wand', 'Crop & adjust']);
        if (E.addFiles && !hasVideo() && E.items.length < E.maxPhotos) items.push(['add', 'i-image', 'Add photos']);
        if (E.items.length > 1) items.push(['remove', 'i-trash', 'Remove this photo']);
        if (it.ov.length) items.push(['clear', 'i-eraser', 'Clear text & stickers']);
        if (!items.length) items.push(['none', 'i-info', 'Nothing more for this one']);
        return `<div class="me-more" role="menu">${items.map(([k, icon, label]) => `<button type="button" role="menuitem" data-me="more-${k}"${k === 'none' ? ' disabled' : ''}>${ic(icon)}<span>${label}</span></button>`).join('')}</div>`;
    }
    function panelHTML() {
        if (!E || !E.panel) return '';
        const it = cur();
        if (E.panel === 'fx') {
            const thumb = it.isVideo ? (it.thumb || '') : it.url;
            return `<div class="me-fx" role="radiogroup" aria-label="Effects">${FX.map(([id, name, css]) => `
                <button type="button" role="radio" class="me-fx-item" data-me="fx-pick" data-fx="${id}" aria-checked="${it.fx === id}">
                    <span class="me-fx-thumb">${thumb ? `<img src="${thumb}" alt="" style="filter:${css || 'none'}">` : ''}</span><span>${name}</span>
                </button>`).join('')}</div>`;
        }
        if (E.panel === 'vol') {
            return `<div class="me-vol">
                ${hasVideo() ? `<label><span>${ic('i-video')}Original audio <b>${Math.round(E.ownVol * 100)}%</b></span><input type="range" data-vol="own" min="0" max="100" step="5" value="${Math.round(E.ownVol * 100)}"></label>` : ''}
                ${E.audio ? `<label><span>${ic('i-music')}Added sound <b>${Math.round(E.soundVol * 100)}%</b></span><input type="range" data-vol="sound" min="0" max="100" step="5" value="${Math.round(E.soundVol * 100)}"></label>` : ''}
                <button type="button" class="me-panel-done" data-me="panel-done">Done</button>
            </div>`;
        }
        if (E.panel === 'sticker') {
            return `<div class="me-stickers">
                <div class="me-st-labels">${LABELS().map(l => `<button type="button" class="me-st-label" data-me="sticker-add" data-kind="label" data-t="${esc(l)}">${esc(l)}</button>`).join('')}</div>
                <div class="me-st-grid">${EMOJI.map(e => `<button type="button" data-me="sticker-add" data-kind="emoji" data-t="${e}" aria-label="Add ${e}">${e}</button>`).join('')}</div>
            </div>`;
        }
        return '';
    }
    function refreshPanel() {
        const p = dlg.querySelector('#me-panel');
        if (!p) return;
        p.hidden = !E.panel || E.panel === 'more';
        p.innerHTML = panelHTML();
    }
    function setPanel(name) {
        E.panel = E.panel === name ? null : name;
        if (E.panel === 'fx' && cur().isVideo && !cur().thumb) grabThumb(cur()).then(() => { if (E && E.panel === 'fx') refreshPanel(); });
        paintTools();
        refreshPanel();
    }
    // Repaint the tools and the sound chip without touching the media (videos keep playing)
    function paintTools() {
        const nav = dlg.querySelector('.me-tools');
        if (!nav) return;
        const frame = document.createElement('template');
        frame.innerHTML = toolsHTML();
        nav.replaceWith(frame.content.firstElementChild);
        const chip = dlg.querySelector('#me-chip');
        if (chip) chip.innerHTML = chipHTML();
    }
    function toolsHTML() {
        return `<nav class="me-tools" aria-label="Editing tools">
            <button type="button" class="me-round" data-me="text" aria-label="Add text"><span class="me-aa" aria-hidden="true">Aa</span></button>
            <button type="button" class="me-round${E.panel === 'sticker' ? ' on' : ''}" data-me="sticker" aria-label="Add a sticker" aria-expanded="${E.panel === 'sticker'}">${ic('i-smile')}</button>
            ${E.allowAudio ? `<button type="button" class="me-round${E.audio ? ' on' : ''}" data-me="sound" aria-label="${E.audio ? 'Change sound' : 'Add sound'}">${ic('i-music')}</button>` : ''}
            ${!cur().isVideo || canvasFilter ? `<button type="button" class="me-round${cur().fx !== 'normal' || E.panel === 'fx' ? ' on' : ''}" data-me="fx" aria-label="Effects" aria-expanded="${E.panel === 'fx'}">${ic('i-sparkle')}</button>` : ''}
            ${E.audio || hasVideo() ? `<button type="button" class="me-round${E.panel === 'vol' ? ' on' : ''}" data-me="vol" aria-label="Volume" aria-expanded="${E.panel === 'vol'}">${ic('i-volume')}</button>` : ''}
            <button type="button" class="me-round small" data-me="more" aria-label="More options" aria-expanded="${E.panel === 'more'}">${ic(E.panel === 'more' ? 'i-chevron-up' : 'i-chevron-down')}</button>
            ${E.panel === 'more' ? moreHTML() : ''}
        </nav>`;
    }
    function paintLayer(i = E.idx) {
        const layer = dlg.querySelector(`[data-layer="${i}"]`);
        if (layer) layer.innerHTML = E.items[i].ov.map(ovHTML).join('');
    }
    // Fit each picture inside the screen (between the top bar and the caption) and size its overlay layer to match
    function layout() {
        if (!E) return;
        dlg.querySelectorAll('.me-slide').forEach((slide, i) => {
            const it = E.items[i];
            const box = slide.querySelector('.me-box');
            if (!it || !box) return;
            const sw = slide.clientWidth, sh = slide.clientHeight;
            const w = it.w || 4, h = it.h || 5;
            const k = Math.min(sw / w, sh / h);
            box.style.width = `${Math.floor(w * k)}px`;
            box.style.height = `${Math.floor(h * k)}px`;
            box.style.setProperty('--w', `${Math.floor(w * k)}px`);
        });
    }
    window.addEventListener('resize', () => { if (E) layout(); });
    function autoGrow() {
        const t = dlg.querySelector('#me-cap');
        if (!t) return;
        t.style.height = 'auto';
        t.style.height = `${Math.min(120, t.scrollHeight)}px`;
    }
    async function grabThumb(it) {
        const v = dlg.querySelector(`#me-box-${E.items.indexOf(it)} video`);
        if (!v || !v.videoWidth) return;
        const c = document.createElement('canvas');
        const k = 160 / Math.max(v.videoWidth, v.videoHeight);
        c.width = Math.round(v.videoWidth * k); c.height = Math.round(v.videoHeight * k);
        c.getContext('2d').drawImage(v, 0, 0, c.width, c.height);
        const blob = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.8));
        if (!blob) return;
        it.thumb = URL.createObjectURL(blob);
        (E.thumbUrls = E.thumbUrls || []).push(it.thumb);
    }

    // ---------- Sound in the editor: the chosen part loops while you edit ----------
    function stopSound(e = E) {
        if (e && e.player) { e.player.stop(); e.player = null; }
        if (e && e.soundUrl) { URL.revokeObjectURL(e.soundUrl); e.soundUrl = null; }
    }
    function startSound() {
        stopSound();
        const a = E.audio;
        if (!a || !I().soundPlayer) return;
        let url = a.music && a.music.src;
        if (a.file) { E.soundUrl = URL.createObjectURL(a.file); url = E.soundUrl; }
        if (!url) return;
        E.player = I().soundPlayer(a.music || { volume: E.soundVol }, url);
        E.player.audio.volume = E.soundVol;
        // Videos restart with the sound so you hear them together
        dlg.querySelectorAll('video.me-media').forEach(v => { v.currentTime = 0; v.muted = E.ownVol === 0; v.volume = E.ownVol; E.unmuted = true; v.play().catch(() => {}); });
        E.player.play().catch(() => {});
    }
    async function chooseSound() {
        if (!lib()) return;
        if (E.player) E.player.audio.pause();
        const picked = await lib().open({ allowOwn: true });
        if (!E) return;
        if (!picked) { if (E.player) E.player.play().catch(() => {}); return; }
        E.audio = picked;
        if (picked.music && picked.music.volume) E.soundVol = picked.music.volume;
        paintTools();
        startSound();
    }

    // ---------- Text editing ----------
    function openText(index = null) {
        const it = cur();
        const o = index != null ? it.ov[index] : { type: 'text', text: '', color: '#ffffff', boxed: false, x: 0.5, y: 0.42, scale: 1, rot: 0 };
        const te = dlg.querySelector('#me-te');
        E.textEdit = { index, o: { ...o } };
        const paintTE = () => {
            const t = E.textEdit.o;
            te.innerHTML = `
                <div class="me-te">
                    <div class="me-te-top"><button type="button" class="me-te-style" data-me="te-style" aria-pressed="${t.boxed}" aria-label="Text background">A</button><button type="button" class="me-te-done" data-me="te-done">Done</button></div>
                    <div class="me-te-field"><textarea id="me-te-input" rows="2" maxlength="200" placeholder="Type something…" aria-label="Your text" class="${t.boxed ? 'boxed' : ''}" style="color:${t.boxed ? onColor(t.color) : t.color};--bg:${t.color}">${esc(t.text)}</textarea></div>
                    <div class="me-te-colors" role="radiogroup" aria-label="Colour">${COLORS.map(c => `<button type="button" role="radio" data-me="te-color" data-c="${c}" aria-checked="${t.color === c}" aria-label="${c}" style="--c:${c}"></button>`).join('')}</div>
                </div>`;
            const input = te.querySelector('#me-te-input');
            input.addEventListener('input', () => { E.textEdit.o.text = input.value; fitTE(input); });
            fitTE(input);
            return input;
        };
        E.paintTE = paintTE;
        te.hidden = false;
        const input = paintTE();
        input.focus();
        input.setSelectionRange(input.value.length, input.value.length);
    }
    function fitTE(input) { input.style.height = 'auto'; input.style.height = `${Math.min(240, input.scrollHeight)}px`; }
    function closeText(save) {
        const te = dlg.querySelector('#me-te');
        if (!E.textEdit) { te.hidden = true; return; }
        const { index, o } = E.textEdit;
        const it = cur();
        o.text = o.text.replace(/\s+$/, '');
        if (save && o.text.trim()) {
            if (index != null) it.ov[index] = o; else it.ov.push(o);
        } else if (save && index != null) it.ov.splice(index, 1);
        E.textEdit = null;
        te.hidden = true;
        te.innerHTML = '';
        paintLayer();
    }

    // ---------- Moving, pinching and binning overlays ----------
    let g = null;
    dlg.addEventListener('pointerdown', e => {
        const el = e.target.closest('.me-ov');
        if (!el || !E) return;
        e.preventDefault();
        const layer = el.parentElement;
        const i = Number(layer.dataset.layer);
        const k = Number(el.dataset.ov);
        if (!g || g.el !== el) g = { el, i, k, pts: new Map(), moved: false, start: null };
        g.pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
        el.setPointerCapture(e.pointerId);
        const o = E.items[i].ov[k];
        const pts = [...g.pts.values()];
        g.start = { o: { ...o }, pts: pts.map(p => ({ ...p })), rect: layer.getBoundingClientRect() };
        el.classList.add('grab');
    });
    dlg.addEventListener('pointermove', e => {
        if (!g || !g.pts.has(e.pointerId) || !E) return;
        g.pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
        const o = E.items[g.i].ov[g.k];
        const s = g.start;
        const pts = [...g.pts.values()];
        if (pts.length === 1 && s.pts.length === 1) {
            const dx = pts[0].x - s.pts[0].x, dy = pts[0].y - s.pts[0].y;
            if (Math.hypot(dx, dy) > 4) g.moved = true;
            o.x = Math.max(0, Math.min(1, s.o.x + dx / s.rect.width));
            o.y = Math.max(0, Math.min(1, s.o.y + dy / s.rect.height));
        } else if (pts.length >= 2 && s.pts.length >= 2) {
            g.moved = true;
            const d0 = Math.hypot(s.pts[1].x - s.pts[0].x, s.pts[1].y - s.pts[0].y) || 1;
            const d1 = Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y);
            const a0 = Math.atan2(s.pts[1].y - s.pts[0].y, s.pts[1].x - s.pts[0].x);
            const a1 = Math.atan2(pts[1].y - pts[0].y, pts[1].x - pts[0].x);
            o.scale = Math.max(0.3, Math.min(5, s.o.scale * d1 / d0));
            o.rot = s.o.rot + (a1 - a0);
        } else return;
        g.el.style.left = `${o.x * 100}%`;
        g.el.style.top = `${o.y * 100}%`;
        g.el.style.setProperty('--s', o.scale);
        g.el.style.setProperty('--r', `${o.rot}rad`);
        if (g.moved) {
            const trash = dlg.querySelector('#me-trash');
            trash.classList.add('show');
            const tr = trash.getBoundingClientRect();
            const over = Math.hypot(e.clientX - (tr.left + tr.width / 2), e.clientY - (tr.top + tr.height / 2)) < 56;
            trash.classList.toggle('hot', over);
            g.el.classList.toggle('binning', over);
            dlg.classList.add('dragging');
        }
    });
    const endOv = e => {
        if (!g || !g.pts.has(e.pointerId) || !E) return;
        g.pts.delete(e.pointerId);
        if (g.pts.size) {
            const o = E.items[g.i].ov[g.k];
            g.start = { o: { ...o }, pts: [...g.pts.values()].map(p => ({ ...p })), rect: g.start.rect };
            return;
        }
        const trash = dlg.querySelector('#me-trash');
        const binned = trash.classList.contains('hot');
        trash.classList.remove('show', 'hot');
        dlg.classList.remove('dragging');
        const { i, k, moved } = g;
        g.el.classList.remove('grab');
        g = null;
        if (binned) { E.items[i].ov.splice(k, 1); paintLayer(i); if (navigator.vibrate) navigator.vibrate(10); return; }
        if (!moved && E.items[i].ov[k].type === 'text') openText(k);
    };
    dlg.addEventListener('pointerup', endOv);
    dlg.addEventListener('pointercancel', endOv);
    dlg.addEventListener('wheel', e => {
        const el = e.target.closest('.me-ov');
        if (!el || !E) return;
        e.preventDefault();
        const o = E.items[Number(el.parentElement.dataset.layer)].ov[Number(el.dataset.ov)];
        o.scale = Math.max(0.3, Math.min(5, o.scale * (e.deltaY < 0 ? 1.08 : 0.93)));
        el.style.setProperty('--s', o.scale);
    }, { passive: false });
    dlg.addEventListener('keydown', e => {
        const el = e.target.closest && e.target.closest('.me-ov');
        if (!el || !E) return;
        const it = E.items[Number(el.parentElement.dataset.layer)];
        const k = Number(el.dataset.ov);
        const o = it.ov[k];
        const step = e.shiftKey ? 0.05 : 0.01;
        if (e.key === 'Delete' || e.key === 'Backspace') { it.ov.splice(k, 1); paintLayer(); e.preventDefault(); return; }
        if (e.key === 'Enter' && o.type === 'text') { openText(k); e.preventDefault(); return; }
        const d = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
        if (!d) return;
        e.preventDefault();
        o.x = Math.max(0, Math.min(1, o.x + d[0]));
        o.y = Math.max(0, Math.min(1, o.y + d[1]));
        el.style.left = `${o.x * 100}%`;
        el.style.top = `${o.y * 100}%`;
    });

    // ---------- Controls ----------
    dlg.addEventListener('input', e => {
        if (!E) return;
        if (e.target.id === 'me-cap') { E.caption = e.target.value; autoGrow(); }
        const v = e.target.dataset && e.target.dataset.vol;
        if (v) {
            const val = Number(e.target.value) / 100;
            e.target.previousElementSibling.querySelector('b').textContent = `${e.target.value}%`;
            if (v === 'own') {
                E.ownVol = val;
                E.unmuted = true;
                dlg.querySelectorAll('video.me-media').forEach(el => { el.muted = val === 0; el.volume = val; el.play().catch(() => {}); });
            } else {
                E.soundVol = val;
                if (E.player) E.player.audio.volume = val;
                else if (E.audio) startSound();
            }
        }
    });
    dlg.addEventListener('cancel', e => {
        e.preventDefault();
        if (!E) return;
        if (E.textEdit) return closeText(true);
        if (E.panel) { E.panel = null; paintTools(); return refreshPanel(); }
        askClose();
    });
    function askClose() {
        if (!edited()) return finish(null);
        dlg.querySelector('#me-confirm').hidden = false;
        dlg.querySelector('[data-me="keep"]').focus();
    }
    dlg.addEventListener('click', async e => {
        if (!E) return;
        const el = e.target.closest('[data-me]');
        if (!el) {
            // Tapping the picture closes an open panel; on a video it pauses / plays
            if (e.target.closest('.me-stage') && !e.target.closest('.me-ov')) {
                if (E.panel) { E.panel = null; paintTools(); refreshPanel(); return; }
                const v = e.target.closest('.me-slide') && e.target.closest('.me-slide').querySelector('video');
                if (v) { if (v.paused) v.play().catch(() => {}); else v.pause(); }
            }
            return;
        }
        const what = el.dataset.me;
        const it = cur();
        if (what === 'close') askClose();
        else if (what === 'discard') finish(null);
        else if (what === 'keep') dlg.querySelector('#me-confirm').hidden = true;
        else if (what === 'text') { E.panel = null; paintTools(); refreshPanel(); openText(); }
        else if (what === 'te-done') closeText(true);
        else if (what === 'te-color') { E.textEdit.o.color = el.dataset.c; E.paintTE().focus(); }
        else if (what === 'te-style') { E.textEdit.o.boxed = !E.textEdit.o.boxed; E.paintTE().focus(); }
        else if (what === 'sticker') setPanel('sticker');
        else if (what === 'sticker-add') {
            it.ov.push({ type: 'sticker', kind: el.dataset.kind, text: el.dataset.t, x: 0.5, y: 0.5, scale: 1, rot: el.dataset.kind === 'label' ? -0.05 : 0 });
            E.panel = null;
            paintTools(); refreshPanel(); paintLayer();
        } else if (what === 'sound') { E.panel = null; refreshPanel(); chooseSound(); }
        else if (what === 'sound-x') { stopSound(); E.audio = null; paintTools(); if (E.panel === 'vol') refreshPanel(); }
        else if (what === 'fx') setPanel('fx');
        else if (what === 'fx-pick') {
            it.fx = el.dataset.fx;
            const media = dlg.querySelector(`#me-box-${E.idx} .me-media`);
            if (media) media.style.filter = fxCss(it.fx) || 'none';
            dlg.querySelectorAll('.me-fx-item').forEach(b => b.setAttribute('aria-checked', String(b.dataset.fx === it.fx)));
            paintTools();
        } else if (what === 'vol') setPanel('vol');
        else if (what === 'panel-done') { E.panel = null; paintTools(); refreshPanel(); }
        else if (what === 'more') setPanel('more');
        else if (what === 'more-crop') {
            E.panel = null; paintTools();
            const out = await window.PhotoEditor.open(it.file, { title: 'Crop & adjust', done: 'Use photo' });
            if (!out || !E) return;
            URL.revokeObjectURL(it.url);
            it.file = out; it.url = URL.createObjectURL(out); it.w = 0; it.h = 0;
            paint();
        } else if (what === 'more-add') {
            E.panel = null; paintTools();
            const more = await E.addFiles();
            if (!E || !more || !more.length) return;
            more.slice(0, E.maxPhotos - E.items.length).forEach(f => E.items.push(itemFor(f)));
            E.idx = E.items.length - 1;
            paint();
        } else if (what === 'more-remove') {
            URL.revokeObjectURL(it.url);
            E.items.splice(E.idx, 1);
            E.idx = Math.max(0, E.idx - 1);
            E.panel = null;
            paint();
        } else if (what === 'more-clear') { it.ov = []; E.panel = null; paintTools(); paintLayer(); }
        else if (what === 'audience') { E.audience = E.audience === 'public' ? 'friends' : 'public'; paintFoot(); app.showToast(E.audience === 'public' ? 'Everyone can see this' : 'Only your friends can see this'); }
        else if (what === 'story') { E.alsoStory = !E.alsoStory; el.setAttribute('aria-pressed', String(E.alsoStory)); }
        else if (what === 'publish') publish(el);
    });
    function paintFoot() {
        const b = dlg.querySelector('[data-me="audience"]');
        if (b) { b.innerHTML = `${ic(E.audience === 'public' ? 'i-globe' : 'i-lock')}<span>${E.audience === 'public' ? 'Everyone' : 'Friends'}</span>`; b.setAttribute('aria-label', `Who can see this: ${E.audience === 'public' ? 'Everyone' : 'Friends'} — tap to change`); }
    }

    // ---------- Share: draw the edits into the photos, hand everything back ----------
    async function flatten(it) {
        if (it.isVideo || (it.fx === 'normal' && !it.ov.length) || it.file.type === 'image/gif') return it.file;
        const img = new Image();
        img.src = it.url;
        await img.decode();
        const k = Math.min(1, 2048 / Math.max(img.naturalWidth, img.naturalHeight));
        const W = Math.round(img.naturalWidth * k), H = Math.round(img.naturalHeight * k);
        const c = document.createElement('canvas');
        c.width = W; c.height = H;
        const ctx = c.getContext('2d', { willReadFrequently: !canvasFilter });
        const css = fxCss(it.fx);
        if (css && canvasFilter) ctx.filter = css;
        ctx.drawImage(img, 0, 0, W, H);
        ctx.filter = 'none';
        if (css && !canvasFilter) applyFilterPixels(ctx, W, H, css);
        if (document.fonts && document.fonts.ready) await document.fonts.ready;
        drawOverlays(ctx, W, H, it.ov);
        const blob = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.9));
        if (!blob) return it.file;
        return new File([blob], (it.file.name || 'photo').replace(/\.[a-z0-9]+$/i, '') + '.jpg', { type: 'image/jpeg' });
    }
    function overlayFor(it) {
        if (!it.ov.length) return null;
        const w = it.w || 720, h = it.h || 1280;
        const k = Math.min(1, 1280 / Math.max(w, h));
        const c = document.createElement('canvas');
        c.width = Math.round(w * k); c.height = Math.round(h * k);
        drawOverlays(c.getContext('2d'), c.width, c.height, it.ov);
        return c;
    }
    async function publish(btn) {
        if (E.textEdit) closeText(true);
        btn.disabled = true;
        btn.classList.add('busy');
        try {
            const files = [];
            for (const it of E.items) files.push(await flatten(it));
            const v = E.items.find(it => it.isVideo);
            const audio = E.audio ? { ...E.audio, volume: E.soundVol, ...(E.audio.music ? { music: { ...E.audio.music, volume: E.soundVol } } : {}) } : null;
            finish({
                files, isVideo: !!v, caption: E.caption.trim(), audience: E.audience, alsoStory: E.offerStory && E.alsoStory, audio,
                video: v ? { filter: fxCss(v.fx) || null, overlay: overlayFor(v), ownVolume: E.ownVol } : null
            });
        } catch (err) {
            btn.disabled = false;
            btn.classList.remove('busy');
            app.showToast('Couldn’t prepare your photo on this device — try again');
        }
    }

    window.diaryMediaEditor = { open, effects: FX, drawOverlays };
});
