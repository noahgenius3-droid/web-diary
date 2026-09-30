// Turn a note into a video or an audio post for the Feed.
//  • Video: the note becomes an animated story-style slideshow (9:16), made right here in the browser
//    (canvas + MediaRecorder) — optionally with your voice reading along — then posted as a reel.
//  • Audio: you read the note aloud with it scrolling as a teleprompter; the recording is posted
//    to the Feed as a voice post with the note's text underneath.
document.addEventListener('DOMContentLoaded', () => {
    const app = window.diaryApp;
    const social = window.diarySocial;
    if (!app) return;
    const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const ic = id => `<svg class="i"><use href="#${id}"/></svg>`;
    const W = 720, H = 1280;

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
                // A very long sentence: break it on words
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

    function draw(ctx, slides, t, per, pal) {
        const [a, b, ink, isNote] = pal;
        const total = slides.length * per;
        const time = Math.min(Math.max(0, t), total - 0.001); // the first animation frame can land a hair before zero
        const i = Math.floor(time / per);
        const local = (time - i * per) / per; // 0..1 within this slide
        const slide = slides[i];

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
        ctx.save();
        ctx.globalAlpha = inT * outT;
        ctx.translate(0, (1 - inT) * 40);
        ctx.fillStyle = ink;
        ctx.textBaseline = 'top';
        const boxW = W - 128;
        if (slide.kind === 'title') {
            const f = fit(ctx, slide.text, '"Fraunces", Georgia, serif', 700, 96, 48, boxW, 560, 1.1);
            const blockH = f.lines.length * f.size * 1.1;
            let y = (H - blockH) / 2 - 40;
            ctx.textAlign = 'left';
            f.lines.forEach(line => { ctx.fillText(line, 64, y); y += f.size * 1.1; });
            if (slide.sub) {
                ctx.font = `600 32px Inter, system-ui, sans-serif`;
                ctx.globalAlpha *= 0.85;
                ctx.fillText(slide.sub, 64, y + 28);
            }
        } else if (slide.kind === 'body') {
            const f = fit(ctx, slide.text, 'Inter, system-ui, sans-serif', 700, 64, 34, boxW, 820, 1.3);
            const words = slide.text.split(' ').length;
            const shown = Math.ceil(words * ease(Math.min(1, local / 0.55)));
            const blockH = f.lines.length * f.size * 1.3;
            let y = (H - blockH) / 2;
            let count = 0;
            ctx.textAlign = 'left';
            for (const line of f.lines) {
                let x = 64;
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
            ctx.font = `700 88px "Fraunces", Georgia, serif`;
            ctx.fillText(slide.text, W / 2, H / 2 - 70);
            if (slide.sub) {
                ctx.font = `600 34px Inter, system-ui, sans-serif`;
                ctx.globalAlpha *= 0.85;
                ctx.fillText(slide.sub, W / 2, H / 2 + 40);
            }
        }
        ctx.restore();

        // Small signature at the bottom
        ctx.save();
        ctx.fillStyle = ink;
        ctx.globalAlpha = 0.7;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'alphabetic';
        ctx.font = '600 26px Inter, system-ui, sans-serif';
        if (slide.kind !== 'end') ctx.fillText('Made with Cordial', W / 2, H - 56);
        ctx.restore();
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

    // ---------- The sheet ----------
    const dlg = document.createElement('dialog');
    dlg.className = 'nm';
    dlg.setAttribute('aria-labelledby', 'nm-h');
    document.body.append(dlg);

    let S = null; // { note, tab, look, speed, voice, slides, raf, previewStart, recording, video, audio... }

    function stopAll() {
        if (!S) return;
        cancelAnimationFrame(S.raf);
        if (S.recorder && S.recorder.state !== 'inactive') { S.cancelled = true; S.recorder.stop(); }
        if (S.stream) S.stream.getTracks().forEach(t => t.stop());
        if (S.mic) S.mic.getTracks().forEach(t => t.stop());
        clearInterval(S.tick);
        S.stream = S.mic = null;
    }

    function open(note) {
        const text = String(note.text || '').trim();
        if (!text && !String(note.title || '').trim()) return app.showToast('Write something in the note first');
        const p = (social && social.internals && social.internals.state.profile) || {};
        stopAll();
        S = {
            note: {
                title: String(note.title || '').trim(),
                text,
                color: note.color || 'purple',
                date: new Date(note.createdAt || Date.now()).toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long' }),
                author: p.username || ''
            },
            tab: note.tab || 'video', look: 'note', speed: 'normal', voice: false,
            videoBlob: null, audioBlob: null, audioDuration: 0
        };
        paint();
        if (!dlg.open) dlg.showModal();
    }

    function paint() {
        stopAll();
        const n = S.note;
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
        if (S.tab === 'video') startPreview();
    }

    // ---------- Video ----------
    function videoHTML() {
        const secs = Math.round(slidesFor(S.note).length * SPEEDS[S.speed]);
        return `
            <div class="nm-video">
                <div class="nm-stage">
                    ${S.videoBlob
                        ? `<video class="nm-canvas" src="${URL.createObjectURL(S.videoBlob)}" controls playsinline loop></video>`
                        : '<canvas class="nm-canvas" width="720" height="1280" aria-label="Video preview"></canvas>'}
                    <div class="nm-progress" hidden><span></span><small>Making your video…</small></div>
                </div>
                <div class="nm-controls">
                    ${S.videoBlob ? `
                        <p class="nm-done">${ic('i-check')}Your video is ready — ${secs} seconds.</p>
                        <button type="button" class="primary-btn nm-wide" data-nm="post-video">${ic('i-reel')}Post to the Feed as a reel</button>
                        <button type="button" class="ghost-btn nm-wide" data-nm="save-video">Save to this device</button>
                        <button type="button" class="link-btn" data-nm="redo-video">Change the look and make it again</button>`
                    : `
                        <div class="field"><span>Look</span>
                            <div class="nm-looks" role="radiogroup" aria-label="Look">${Object.keys(LOOKS).map(k => {
                                const [a, b] = palette(k, S.note.color);
                                return `<button type="button" role="radio" aria-checked="${S.look === k}" class="nm-look" data-nm="look" data-look="${k}" style="background:linear-gradient(135deg,${a},${b})" aria-label="${k === 'note' ? 'Note colour' : k}"></button>`;
                            }).join('')}</div>
                        </div>
                        <div class="field"><span>Pace</span>
                            <div class="nm-seg" role="radiogroup" aria-label="Pace">${Object.keys(SPEEDS).map(k => `<button type="button" role="radio" aria-checked="${S.speed === k}" data-nm="speed" data-speed="${k}">${k[0].toUpperCase() + k.slice(1)}</button>`).join('')}</div>
                        </div>
                        <label class="nm-switch"><input type="checkbox" data-nm="voice"${S.voice ? ' checked' : ''}><span><strong>Add my voice</strong><small>Read along while it plays — the slides are your prompt</small></span></label>
                        <p class="nm-meta">${slidesFor(S.note).length} slides · about ${secs} seconds</p>
                        <button type="button" class="primary-btn nm-wide" data-nm="make-video">${ic('i-sparkle')}Make my video</button>`}
                </div>
            </div>`;
    }

    function startPreview() {
        const canvas = dlg.querySelector('canvas.nm-canvas');
        if (!canvas) return;
        const ctx = canvas.getContext('2d');
        const slides = slidesFor(S.note);
        const per = SPEEDS[S.speed];
        const pal = palette(S.look, S.note.color);
        const t0 = performance.now();
        const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        const loop = now => {
            const t = reduce ? per * 0.8 : ((now - t0) / 1000) % (slides.length * per);
            draw(ctx, slides, t, per, pal);
            if (!reduce) S.raf = requestAnimationFrame(loop);
        };
        S.raf = requestAnimationFrame(loop);
    }

    async function makeVideo() {
        const canvas = dlg.querySelector('canvas.nm-canvas');
        if (!canvas || !canvas.captureStream || !window.MediaRecorder) {
            return app.showToast('Making videos isn’t supported in this browser — try Chrome, Edge or a recent Safari');
        }
        cancelAnimationFrame(S.raf);
        let mic = null;
        if (S.voice) {
            try { mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } }); }
            catch (e) { return app.showToast('Allow the microphone to add your voice — or switch “Add my voice” off'); }
        }
        const stream = canvas.captureStream(30);
        if (mic) mic.getAudioTracks().forEach(t => stream.addTrack(t));
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
        bar.querySelector('small').textContent = S.voice ? 'Recording — read along now 🎙️' : 'Making your video…';
        dlg.querySelector('.nm-controls').classList.add('busy');

        const done = new Promise(resolve => { recorder.onstop = resolve; });
        recorder.start(500);
        const t0 = performance.now();
        const frame = now => {
            const t = (now - t0) / 1000;
            draw(ctx, slides, t, per, pal);
            bar.querySelector('span').style.width = `${Math.min(100, (t / total) * 100)}%`;
            if (t < total + 0.3) S.raf = requestAnimationFrame(frame);
            else if (recorder.state !== 'inactive') recorder.stop();
        };
        S.raf = requestAnimationFrame(frame);
        await done;
        stream.getTracks().forEach(t => t.stop());
        if (mic) mic.getTracks().forEach(t => t.stop());
        S.stream = S.mic = null;
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
                    <div class="field"><span>Who can see it</span>
                        <div class="nm-seg" role="radiogroup" aria-label="Audience">
                            <button type="button" role="radio" aria-checked="${S.audience !== 'public'}" data-nm="aud" data-aud="friends">${ic('i-lock')}Friends</button>
                            <button type="button" role="radio" aria-checked="${S.audience === 'public'}" data-nm="aud" data-aud="public">${ic('i-globe')}Everyone</button>
                        </div>
                    </div>
                    <button type="button" class="primary-btn nm-wide" data-nm="post-audio">${ic('i-feed')}Post to the Feed</button>
                    <button type="button" class="link-btn" data-nm="redo-audio">Record again</button>`
                : `
                    <p class="nm-meta">Tap record and read your note aloud. It scrolls as you go.</p>
                    <div class="nm-rec-row">
                        <span class="nm-timer" aria-live="off">0:00</span>
                        <button type="button" class="nm-rec" data-nm="record" aria-label="Start recording">${ic('i-mic')}</button>
                        <span class="nm-timer-cap">max 10 min</span>
                    </div>`}
            </div>`;
    }

    async function toggleRecord(btn) {
        if (S.recorder && S.recorder.state === 'recording') { S.recorder.stop(); return; }
        if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) return app.showToast('Recording isn’t supported in this browser');
        let mic;
        try { mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } }); }
        catch (e) { return app.showToast('Allow the microphone for Cordial to record'); }
        const mime = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg'].find(t => MediaRecorder.isTypeSupported(t)) || '';
        const recorder = new MediaRecorder(mic, mime ? { mimeType: mime } : undefined);
        const chunks = [];
        S.recorder = recorder;
        S.mic = mic;
        S.cancelled = false;
        recorder.ondataavailable = e => { if (e.data.size) chunks.push(e.data); };
        const started = Date.now();
        const prompter = dlg.querySelector('.nm-prompter');
        const timer = dlg.querySelector('.nm-timer');
        recorder.onstop = () => {
            clearInterval(S.tick);
            cancelAnimationFrame(S.raf);
            mic.getTracks().forEach(t => t.stop());
            S.mic = null;
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
        else if (what === 'make-video') makeVideo();
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
    dlg.addEventListener('change', e => { if (e.target.dataset.nm === 'voice') S.voice = e.target.checked; });
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
