// Note → Slides: turn a note into a presentation.
// The note's title becomes the title slide; each paragraph or section becomes a slide (short first lines and
// "Heading:" lines become slide titles, list lines and sentences become bullets, a single short line becomes a
// quote). Pick a template (the ones that suit the note are recommended), edit any text in place, present full
// screen, save as PDF, or share the deck to the Feed as a photo carousel.
document.addEventListener('DOMContentLoaded', () => {
    const app = window.diaryApp;
    const social = window.diarySocial;
    if (!app) return;
    const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const ic = id => `<svg class="i"><use href="#${id}"/></svg>`;
    const W = 1280, H = 720;

    // ---------- Templates ----------
    // bg: CSS background; draw: the same look on a canvas (for sharing as pictures)
    const NOTE_COLOURS = {
        yellow: ['#fef3c7', '#b45309'], pink: ['#fce7f3', '#be185d'], blue: ['#dbeafe', '#1d4ed8'], green: ['#dcfce7', '#15803d'],
        purple: ['#ede9fe', '#6d28d9'], orange: ['#ffedd5', '#c2410c'], coral: ['#ffe4e6', '#be123c'], teal: ['#ccfbf1', '#0f766e'],
        sky: ['#e0f2fe', '#0369a1'], lime: ['#ecfccb', '#4d7c0f'], gray: ['#f1f5f9', '#334155']
    };
    const TEMPLATES = {
        minimal: { name: 'Minimal', bg: ['#ffffff', '#ffffff'], ink: '#111827', muted: '#6b7280', accent: '#4f46e5', serif: false },
        midnight: { name: 'Midnight', bg: ['#0f172a', '#312e81'], ink: '#ffffff', muted: '#c7d2fe', accent: '#a5b4fc', serif: false },
        grace: { name: 'Grace', bg: ['#fbf7ef', '#f3e8d2'], ink: '#3b2f1e', muted: '#7c6a52', accent: '#b45309', serif: true },
        naija: { name: 'Naija', bg: ['#ffffff', '#f0fdf4'], ink: '#0b3d2c', muted: '#3f6b5a', accent: '#008751', serif: false, bars: '#008751' },
        notebook: { name: 'Notebook', bg: ['#f8fafc', '#f8fafc'], ink: '#1e293b', muted: '#64748b', accent: '#2563eb', serif: false, lines: '#dbeafe' },
        executive: { name: 'Executive', bg: ['#0b1f3a', '#13294b'], ink: '#ffffff', muted: '#cbd5e1', accent: '#d4a017', serif: true },
        sunset: { name: 'Sunset', bg: ['#f97316', '#db2777'], ink: '#ffffff', muted: '#ffe4e6', accent: '#fde68a', serif: true },
        note: { name: 'Note colour', bg: null, ink: '#111827', muted: '#475569', accent: null, serif: false }
    };
    const templateOf = (key, color) => {
        const t = { ...(TEMPLATES[key] || TEMPLATES.minimal) };
        if (key === 'note') {
            const [soft, deep] = NOTE_COLOURS[color] || NOTE_COLOURS.purple;
            t.bg = [soft, '#ffffff']; t.accent = deep; t.ink = '#111827';
        }
        return t;
    };

    // The templates that suit this note, best first
    function recommend(note) {
        const t = `${note.title} ${note.text}`.toLowerCase();
        const picks = [];
        if (/\b(god|jesus|christ|lord|church|pray|prayer|bless|grace|praise|worship|faith|psalm|bible|sermon|amen)/.test(t)) picks.push('grace');
        if (/\b(independence|nigeria|naija|celebrat|party|birthday|wedding|festival|congrat)/.test(t)) picks.push('naija');
        if (/\b(study|exam|class|lesson|lecture|school|learn|revision|course|notes on|chapter)/.test(t)) picks.push('notebook');
        if (/\b(work|business|meeting|plan|strategy|project|goal|budget|team|client|quarter|report|pitch)/.test(t)) picks.push('executive');
        if (/\b(feel|felt|today|journal|dear diary|love|family|friend|life|dream|memory|grateful)/.test(t)) picks.push('sunset');
        picks.push('midnight', 'minimal');
        return [...new Set(picks)].slice(0, 3);
    }

    // ---------- Note → slides ----------
    const BULLET = /^\s*(?:[-*•–]|\d+[.)])\s+/;
    const words = s => String(s).trim().split(/\s+/).filter(Boolean).length;
    const isHeading = line => {
        const l = line.trim();
        return !!l && (/:$/.test(l) || (words(l) <= 7 && !/[.!?…,]$/.test(l) && !BULLET.test(l)));
    };
    const sentencesOf = text => (String(text).replace(/\s+/g, ' ').match(/[^.!?…]+[.!?…]*["”’)]*/g) || []).map(x => x.trim()).filter(Boolean);
    const chunk = (list, n) => { const out = []; for (let i = 0; i < list.length; i += n) out.push(list.slice(i, i + n)); return out; };

    function buildSlides(note) {
        const slides = [{ kind: 'title', title: note.title || 'My note', sub: [note.date, note.author ? `by @${note.author}` : ''].filter(Boolean).join(' · ') }];
        const blocks = String(note.text || '').replace(/\r/g, '').split(/\n\s*\n/).map(b => b.trim()).filter(Boolean);
        for (const block of blocks) {
            let lines = block.split('\n').map(l => l.trim()).filter(Boolean);
            let title = '';
            if (lines.length > 1 && isHeading(lines[0])) { title = lines[0].replace(/:$/, ''); lines = lines.slice(1); }
            const listy = lines.length > 1 && lines.filter(l => BULLET.test(l)).length >= Math.ceil(lines.length / 2);
            let points = listy ? lines.map(l => l.replace(BULLET, '')) : lines.length > 1 ? lines : sentencesOf(lines[0] || '');
            if (!title && points.length === 1 && points[0].length <= 140) { slides.push({ kind: 'quote', title: '', points }); continue; }
            // Long points get trimmed; long lists split across slides
            points = points.map(p => (p.length > 180 ? `${p.slice(0, 177).replace(/\s+\S*$/, '')}…` : p));
            chunk(points, 5).forEach((part, k) => slides.push({ kind: 'bullets', title: title ? (k ? `${title} (cont.)` : title) : '', points: part }));
        }
        if (slides.length === 1 && note.text) slides.push({ kind: 'quote', title: '', points: [String(note.text).slice(0, 140)] });
        slides.push({ kind: 'end', title: 'Thank you', sub: note.author ? `@${note.author} · made with Cordial` : 'Made with Cordial' });
        return slides.slice(0, 24);
    }

    // ---------- Drawing a slide (HTML, used for preview, editing, presenting and PDF) ----------
    function slideHTML(slide, t, i, total, editable) {
        const ed = editable ? ' contenteditable="true" spellcheck="true"' : '';
        const style = `--sl-bg1:${t.bg[0]};--sl-bg2:${t.bg[1]};--sl-ink:${t.ink};--sl-muted:${t.muted};--sl-accent:${t.accent};${t.lines ? `--sl-lines:${t.lines};` : ''}${t.bars ? `--sl-bars:${t.bars};` : ''}`;
        const cls = `nslide sl-${slide.kind}${t.serif ? ' serif' : ''}${t.lines ? ' lined' : ''}${t.bars ? ' barred' : ''}`;
        let inner;
        if (slide.kind === 'title') {
            inner = `<span class="sl-kicker">Presentation</span><h2 class="sl-h"${ed} data-f="title">${esc(slide.title)}</h2>${slide.sub ? `<p class="sl-sub"${ed} data-f="sub">${esc(slide.sub)}</p>` : ''}`;
        } else if (slide.kind === 'end') {
            inner = `<h2 class="sl-h"${ed} data-f="title">${esc(slide.title)}</h2><p class="sl-sub"${ed} data-f="sub">${esc(slide.sub || '')}</p>`;
        } else if (slide.kind === 'quote') {
            inner = `<span class="sl-quote-mark" aria-hidden="true">“</span><p class="sl-quote"${ed} data-f="p0">${esc(slide.points[0] || '')}</p>`;
        } else {
            inner = `${slide.title || editable ? `<h3 class="sl-t"${ed} data-f="title" data-placeholder="Add a slide title">${esc(slide.title)}</h3>` : ''}
                <ul class="sl-points">${slide.points.map((p, k) => `<li${ed} data-f="p${k}">${esc(p)}</li>`).join('')}</ul>`;
        }
        return `<div class="${cls}" style="${style}" data-i="${i}">${inner}<span class="sl-num">${i + 1} / ${total}</span></div>`;
    }

    // ---------- The same slide on a canvas (for sharing as pictures) ----------
    function wrap(ctx, text, max) {
        const out = [];
        let line = '';
        for (const w of String(text).split(' ')) {
            const test = line ? `${line} ${w}` : w;
            if (ctx.measureText(test).width > max && line) { out.push(line); line = w; } else line = test;
        }
        if (line) out.push(line);
        return out;
    }
    function drawSlide(slide, t, i, total) {
        const c = document.createElement('canvas');
        c.width = W; c.height = H;
        const ctx = c.getContext('2d');
        const g = ctx.createLinearGradient(0, 0, W, H);
        g.addColorStop(0, t.bg[0]); g.addColorStop(1, t.bg[1]);
        ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
        if (t.lines) { ctx.strokeStyle = t.lines; ctx.lineWidth = 2; for (let y = 120; y < H; y += 48) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke(); } ctx.strokeStyle = '#fca5a5'; ctx.beginPath(); ctx.moveTo(96, 0); ctx.lineTo(96, H); ctx.stroke(); }
        if (t.bars) { ctx.fillStyle = t.bars; ctx.fillRect(0, 0, 36, H); ctx.fillRect(W - 36, 0, 36, H); }
        const serif = t.serif ? '"Fraunces", Georgia, serif' : 'Inter, system-ui, sans-serif';
        const sans = 'Inter, system-ui, sans-serif';
        ctx.textBaseline = 'top';
        const left = t.lines ? 130 : 110;
        if (slide.kind === 'title' || slide.kind === 'end') {
            ctx.fillStyle = t.accent; ctx.fillRect(left, 230, 90, 8);
            ctx.fillStyle = t.ink; ctx.font = `800 76px ${serif}`;
            let y = 270;
            wrap(ctx, slide.title, W - left * 2).slice(0, 3).forEach(l => { ctx.fillText(l, left, y); y += 88; });
            if (slide.sub) { ctx.fillStyle = t.muted; ctx.font = `600 30px ${sans}`; ctx.fillText(slide.sub, left, y + 16); }
        } else if (slide.kind === 'quote') {
            ctx.fillStyle = t.accent; ctx.font = `800 180px ${serif}`; ctx.fillText('“', left - 10, 90);
            ctx.fillStyle = t.ink; ctx.font = `700 52px ${serif}`;
            let y = 270;
            wrap(ctx, slide.points[0] || '', W - left * 2).slice(0, 5).forEach(l => { ctx.fillText(l, left, y); y += 66; });
        } else {
            let y = 90;
            if (slide.title) { ctx.fillStyle = t.ink; ctx.font = `800 54px ${serif}`; wrap(ctx, slide.title, W - left * 2).slice(0, 2).forEach(l => { ctx.fillText(l, left, y); y += 64; }); ctx.fillStyle = t.accent; ctx.fillRect(left, y + 8, 70, 6); y += 50; }
            ctx.font = `500 34px ${sans}`;
            for (const p of slide.points) {
                const lines = wrap(ctx, p, W - left * 2 - 50);
                ctx.fillStyle = t.accent; ctx.beginPath(); ctx.arc(left + 10, y + 20, 8, 0, Math.PI * 2); ctx.fill();
                ctx.fillStyle = t.ink;
                lines.slice(0, 3).forEach(l => { ctx.fillText(l, left + 40, y); y += 46; });
                y += 18;
                if (y > H - 80) break;
            }
        }
        ctx.fillStyle = t.muted; ctx.font = `600 22px ${sans}`; ctx.textAlign = 'right';
        ctx.fillText(`${i + 1} / ${total}`, W - 48, H - 52);
        return new Promise(r => c.toBlob(b => r(b), 'image/jpeg', 0.9));
    }

    // ---------- The sheet ----------
    const dlg = document.createElement('dialog');
    dlg.className = 'nsd';
    dlg.setAttribute('aria-labelledby', 'nsd-h');
    document.body.append(dlg);
    let D = null; // { note, slides, tpl, rec, i }

    function open(note) {
        const text = String(note.text || '').trim();
        if (!text && !String(note.title || '').trim()) return app.showToast('Write something in the note first');
        const p = (social && social.internals && social.internals.state.profile) || {};
        const n = {
            title: String(note.title || '').trim() || text.split('\n')[0].slice(0, 80),
            text: note.title ? text : text.split('\n').slice(1).join('\n') || text,
            color: note.color || 'purple',
            date: new Date(note.createdAt || Date.now()).toLocaleDateString([], { day: 'numeric', month: 'long', year: 'numeric' }),
            author: p.username || ''
        };
        const rec = recommend(n);
        D = { note: n, slides: buildSlides(n), tpl: rec[0], rec, i: 0 };
        paint();
        if (!dlg.open) dlg.showModal();
    }

    function paint() {
        const t = templateOf(D.tpl, D.note.color);
        const total = D.slides.length;
        const order = [...D.rec, ...Object.keys(TEMPLATES).filter(k => !D.rec.includes(k))];
        dlg.innerHTML = `
            <div class="nsd-card">
                <header class="nsd-head">
                    <h3 id="nsd-h">Slides from your note</h3>
                    <button type="button" class="icon-btn" data-sd="close" aria-label="Close">${ic('i-close')}</button>
                </header>
                <div class="nsd-main">
                    <div class="nsd-stage">
                        <div class="nsd-frame">${slideHTML(D.slides[D.i], t, D.i, total, true)}</div>
                        <div class="nsd-nav">
                            <button type="button" class="nsd-arrow" data-sd="prev" aria-label="Previous slide"${D.i === 0 ? ' disabled' : ''}>${ic('i-chevron-left')}</button>
                            <span>${D.i + 1} of ${total} · tap any text to edit it</span>
                            <button type="button" class="nsd-arrow next" data-sd="next" aria-label="Next slide"${D.i === total - 1 ? ' disabled' : ''}>${ic('i-chevron-left')}</button>
                        </div>
                        <div class="nsd-thumbs" role="listbox" aria-label="Slides">
                            ${D.slides.map((sl, k) => `<button type="button" class="nsd-thumb" role="option" aria-selected="${k === D.i}" data-sd="go" data-k="${k}" aria-label="Slide ${k + 1}"><span class="nsd-thumb-in">${slideHTML(sl, t, k, total, false)}</span></button>`).join('')}
                        </div>
                    </div>
                    <aside class="nsd-side">
                        <p class="nsd-label">Template</p>
                        <div class="nsd-templates" role="radiogroup" aria-label="Template">
                            ${order.map(k => {
                                const tt = templateOf(k, D.note.color);
                                return `<button type="button" role="radio" aria-checked="${k === D.tpl}" class="nsd-tpl" data-sd="tpl" data-k="${k}">
                                    <span class="nsd-tpl-swatch${tt.serif ? ' serif' : ''}" style="background:linear-gradient(135deg,${tt.bg[0]},${tt.bg[1]});color:${tt.ink};border-color:${tt.accent}"><b>Aa</b><i style="background:${tt.accent}"></i></span>
                                    <span class="nsd-tpl-name">${esc(tt.name)}${D.rec.includes(k) ? '<small>Recommended</small>' : ''}</span>
                                </button>`;
                            }).join('')}
                        </div>
                        <div class="nsd-actions">
                            <button type="button" class="primary-btn nsd-wide" data-sd="present">${ic('i-play')}Present</button>
                            <button type="button" class="ghost-btn nsd-wide" data-sd="feed">${ic('i-feed')}Share to the Feed</button>
                            <button type="button" class="ghost-btn nsd-wide" data-sd="pdf">${ic('i-download')}Save as PDF</button>
                            <div class="nsd-row">
                                <button type="button" class="link-btn" data-sd="add">${ic('i-plus')}Add slide</button>
                                <button type="button" class="link-btn danger" data-sd="del"${total <= 2 ? ' disabled' : ''}>${ic('i-trash')}Delete slide</button>
                            </div>
                        </div>
                    </aside>
                </div>
            </div>`;
        dlg.querySelector('.nsd-thumb[aria-selected="true"]')?.scrollIntoView({ block: 'nearest', inline: 'center' });
    }

    // Typing on the slide updates the deck (without redrawing, so the cursor stays put)
    dlg.addEventListener('input', e => {
        const el = e.target.closest('[data-f]');
        if (!el || !D) return;
        const slide = D.slides[D.i];
        const v = el.textContent.replace(/\s+/g, ' ').trim();
        const f = el.dataset.f;
        if (f === 'title') slide.title = v;
        else if (f === 'sub') slide.sub = v;
        else if (/^p\d+$/.test(f)) slide.points[Number(f.slice(1))] = v;
    });
    // Enter in a bullet adds the next bullet
    dlg.addEventListener('keydown', e => {
        const el = e.target.closest('[data-f]');
        if (!el || !D || e.key !== 'Enter') return;
        e.preventDefault();
        const slide = D.slides[D.i];
        if (slide.kind === 'bullets' && /^p\d+$/.test(el.dataset.f) && slide.points.length < 7) {
            slide.points.splice(Number(el.dataset.f.slice(1)) + 1, 0, '');
            paint();
            const next = dlg.querySelector(`[data-f="p${Number(el.dataset.f.slice(1)) + 1}"]`);
            if (next) next.focus();
        } else el.blur();
    });

    dlg.addEventListener('click', e => {
        const el = e.target.closest('[data-sd]');
        if (!el || !D) return;
        const what = el.dataset.sd;
        const clean = () => { D.slides.forEach(sl => { if (sl.points) sl.points = sl.points.filter(p => p.trim()); }); };
        if (what === 'close') dlg.close();
        else if (what === 'prev') { clean(); D.i = Math.max(0, D.i - 1); paint(); }
        else if (what === 'next') { clean(); D.i = Math.min(D.slides.length - 1, D.i + 1); paint(); }
        else if (what === 'go') { clean(); D.i = Number(el.dataset.k); paint(); }
        else if (what === 'tpl') { D.tpl = el.dataset.k; paint(); }
        else if (what === 'add') {
            clean();
            D.slides.splice(D.i + 1, 0, { kind: 'bullets', title: 'New slide', points: ['Your point here'] });
            D.i += 1;
            paint();
        } else if (what === 'del') {
            if (D.slides.length <= 2) return;
            D.slides.splice(D.i, 1);
            D.i = Math.min(D.i, D.slides.length - 1);
            paint();
        } else if (what === 'present') { clean(); present(); }
        else if (what === 'pdf') { clean(); savePdf(); }
        else if (what === 'feed') { clean(); shareToFeed(el); }
    });

    // ---------- Present: full screen, arrows / taps / swipes ----------
    const show = document.createElement('div');
    show.className = 'nsd-show';
    show.hidden = true;
    show.setAttribute('role', 'dialog');
    show.setAttribute('aria-label', 'Presenting');
    document.body.append(show);
    let P = 0;
    function paintShow() {
        const t = templateOf(D.tpl, D.note.color);
        show.innerHTML = `
            <div class="nsd-show-frame">${slideHTML(D.slides[P], t, P, D.slides.length, false)}</div>
            <div class="nsd-show-bar">
                <button type="button" data-ps="prev" aria-label="Previous slide"${P === 0 ? ' disabled' : ''}>${ic('i-chevron-left')}</button>
                <span>${P + 1} / ${D.slides.length}</span>
                <button type="button" data-ps="next" class="next" aria-label="Next slide"${P === D.slides.length - 1 ? ' disabled' : ''}>${ic('i-chevron-left')}</button>
                <button type="button" data-ps="exit" aria-label="Stop presenting">${ic('i-close')}</button>
            </div>`;
    }
    function present() {
        P = D.i;
        dlg.close();
        show.hidden = false;
        paintShow();
        if (show.requestFullscreen) show.requestFullscreen().catch(() => {});
    }
    function stopShow() {
        show.hidden = true;
        if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
        D.i = P;
        paint();
        dlg.showModal();
    }
    const step = d => { const n = Math.min(D.slides.length - 1, Math.max(0, P + d)); if (n !== P) { P = n; paintShow(); } };
    show.addEventListener('click', e => {
        const b = e.target.closest('[data-ps]');
        if (b) return b.dataset.ps === 'exit' ? stopShow() : step(b.dataset.ps === 'next' ? 1 : -1);
        step(e.clientX > window.innerWidth / 3 ? 1 : -1); // tap the right two-thirds to go on, the left third to go back
    });
    document.addEventListener('keydown', e => {
        if (show.hidden) return;
        if (['ArrowRight', 'ArrowDown', 'PageDown', ' ', 'Enter'].includes(e.key)) { e.preventDefault(); step(1); }
        else if (['ArrowLeft', 'ArrowUp', 'PageUp'].includes(e.key)) { e.preventDefault(); step(-1); }
        else if (e.key === 'Escape') stopShow();
    });
    let sx = null;
    show.addEventListener('touchstart', e => { sx = e.touches[0].clientX; }, { passive: true });
    show.addEventListener('touchend', e => {
        if (sx === null) return;
        const dx = e.changedTouches[0].clientX - sx;
        sx = null;
        if (Math.abs(dx) > 60) step(dx < 0 ? 1 : -1);
    }, { passive: true });
    document.addEventListener('fullscreenchange', () => { if (!document.fullscreenElement && !show.hidden) stopShow(); });

    // ---------- Save as PDF (the browser's print → PDF, one slide per page) ----------
    function savePdf() {
        const t = templateOf(D.tpl, D.note.color);
        const css = [...document.styleSheets].map(sh => { try { return [...sh.cssRules].map(r => r.cssText).filter(x => x.includes('.nslide') || x.includes('.sl-')).join('\n'); } catch (e) { return ''; } }).join('\n');
        const frame = document.createElement('iframe');
        frame.style.cssText = 'position:fixed;width:0;height:0;border:0;opacity:0';
        document.body.append(frame);
        const doc = frame.contentDocument;
        doc.open();
        doc.write(`<!doctype html><html><head><meta charset="utf-8"><title>${esc(D.note.title)}</title>
            <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400..800&family=Fraunces:wght@500..800&display=swap" rel="stylesheet">
            <style>@page{size:1280px 720px;margin:0}html,body{margin:0;background:#fff}${css}
            .page{width:1280px;height:720px;page-break-after:always;break-after:page;overflow:hidden}.page .nslide{width:1280px;height:720px;border-radius:0;font-size:32px}
            *{-webkit-print-color-adjust:exact;print-color-adjust:exact}</style></head><body>
            ${D.slides.map((sl, k) => `<div class="page">${slideHTML(sl, t, k, D.slides.length, false)}</div>`).join('')}</body></html>`);
        doc.close();
        app.showToast('Choose “Save as PDF” in the print window');
        setTimeout(() => { frame.contentWindow.focus(); frame.contentWindow.print(); setTimeout(() => frame.remove(), 60000); }, 900);
    }

    // ---------- Share to the Feed as a photo carousel ----------
    async function shareToFeed(btn) {
        if (!(social && social.isSignedIn && social.isSignedIn())) return app.showToast('Sign in to share to the Feed');
        if (social.isGuest && social.isGuest()) return social.internals.openUpgrade && social.internals.openUpgrade();
        btn.disabled = true;
        btn.textContent = 'Preparing your slides…';
        try {
            const t = templateOf(D.tpl, D.note.color);
            const deck = D.slides.slice(0, 10); // a post holds up to 10 pictures
            const files = [];
            for (let k = 0; k < deck.length; k++) {
                const blob = await drawSlide(deck[k], t, k, deck.length);
                files.push(new File([blob], `slide-${k + 1}.jpg`, { type: 'image/jpeg' }));
            }
            const summary = D.slides.filter(sl => sl.kind === 'bullets' || sl.kind === 'quote').flatMap(sl => [sl.title, ...(sl.points || [])]).filter(Boolean).slice(0, 6).join('\n');
            await app.createEntry({ title: `📊 ${D.note.title}`, text: summary, shared: true, color: D.note.color, origin: 'post' }, files);
            dlg.close();
            app.showToast(D.slides.length > 10 ? 'Shared the first 10 slides to the Feed 📊' : 'Your slides are on the Feed 📊');
            setTimeout(() => app.setView('feed'), 400);
        } catch (e) {
            btn.disabled = false;
            btn.innerHTML = `${ic('i-feed')}Share to the Feed`;
            app.showToast('Couldn’t share your slides — try again');
        }
    }

    // Pick one of your notes (from the Feed's create menu)
    function pickNote(anchor) {
        const notes = (app.getNotes() || []).filter(n => !n.trashedAt && !n.archived && !n.private && n.origin !== 'post' && (String(n.text || '').trim() || String(n.title || '').trim()))
            .sort((a, b) => (b.updatedAt || b.createdAt || 0) - (a.updatedAt || a.createdAt || 0)).slice(0, 12);
        if (!notes.length) return app.showToast('Write a note first — then turn it into slides');
        app.openPopover(anchor, [
            { heading: 'Pick a note' },
            ...notes.map(n => ({ label: (n.title || String(n.text || '').slice(0, 40) || 'Untitled').slice(0, 48), icon: 'i-book', onClick: () => open(n) }))
        ]);
    }
    app.actions['note-slides'] = el => pickNote(el);
    window.diaryNoteSlides = { open, pickNote };
});
