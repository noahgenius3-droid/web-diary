// Scan → Note: photograph handwritten notes, whiteboards, textbooks, receipts and documents, and Cordial reads
// the text into an editable note. The in-app scanner camera crops each shot to a page frame; photos are cleaned up
// (lighting, contrast) and read on the device — the browser's own text detector where there is one, otherwise
// Tesseract.js (open source), loaded only the first time someone scans. Nothing is uploaded.
document.addEventListener('DOMContentLoaded', () => {
    const app = window.diaryApp;
    if (!app) return;
    const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const ic = (id, cls = '') => `<svg class="i${cls ? ` ${cls}` : ''}" aria-hidden="true"><use href="#${id}"/></svg>`;
    const toast = m => app.showToast(m);

    // A dialog in the app's game-window style (full screen on phones)
    function sheet(cls, label, html) {
        const dlg = document.createElement('dialog');
        dlg.className = `gm st ${cls}`;
        dlg.setAttribute('aria-label', label);
        dlg.innerHTML = html;
        document.body.append(dlg);
        dlg.addEventListener('close', () => { try { speechSynthesis.cancel(); } catch (e) { /* ignore */ } dlg.remove(); });
        dlg.addEventListener('click', e => { if (e.target === dlg) dlg.close(); });
        dlg.showModal();
        return dlg;
    }
    const head = (title, sub, extra = '') => `<header class="gm-head"><button type="button" class="icon-btn" data-x aria-label="Close">${ic('i-close')}</button><div class="gm-title"><strong>${title}</strong>${sub ? `<small>${sub}</small>` : ''}</div>${extra}</header>`;

    // ======================================================================
    // Scan → Note
    // ======================================================================
    const SCAN_KINDS = [['handwritten', '✍️', 'Handwritten'], ['whiteboard', '🧑‍🏫', 'Whiteboard'], ['textbook', '📘', 'Textbook'], ['receipt', '🧾', 'Receipt'], ['document', '📄', 'Document']];
    // Reading text from a photo, on the device: a reader you plug in (window.diaryOCR), the browser's own text
    // detector where there is one, or Tesseract.js (open source, Apache-2.0) — loaded only the first time someone scans
    const OCR_SRC = 'https://cdn.jsdelivr.net/npm/tesseract.js@7.0.0/dist/tesseract.min.js';
    let ocrWorker = null, ocrProgress = null;
    const canRead = () => true;
    function loadScript(src) {
        return new Promise((resolve, reject) => {
            const el = document.createElement('script');
            el.src = src; el.async = true; el.crossOrigin = 'anonymous';
            el.onload = resolve; el.onerror = () => reject(new Error('The text reader couldn’t load'));
            document.head.append(el);
        });
    }
    async function tesseract(canvas) {
        if (!window.Tesseract) await loadScript(OCR_SRC);
        if (!ocrWorker) ocrWorker = window.Tesseract.createWorker('eng', 1, { logger: m => ocrProgress && ocrProgress(m) }).catch(e => { ocrWorker = null; throw e; });
        const worker = await ocrWorker;
        const { data } = await worker.recognize(canvas);
        return String(data.text || '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
    }
    function scan({ into = false } = {}) {
        const S = { kind: 'document', pages: [] };
        const dlg = sheet('st-scan', 'Scan to note', `<div class="gm-card">${head('🖨️ Scan → Note', into ? 'Add a scanned page to this note' : 'Turn a photo into an editable note')}
            <div class="gm-body st-body">
                <p class="st-label">What are you scanning?</p>
                <div class="st-cats">${SCAN_KINDS.map(([k, e, l]) => `<button type="button" data-kind="${k}" aria-pressed="${k === S.kind}">${e} ${l}</button>`).join('')}</div>
                <div class="st-pages" data-pages></div>
                <div class="st-row"><button type="button" class="primary-btn" data-shot>${ic('i-camera')}Scan with camera</button><button type="button" class="ghost-btn" data-pick>${ic('i-image')}From photos</button></div>
                <p class="st-tip">Text is read right here on your device — nothing is uploaded. The first scan downloads the text reader (about 5 MB, once). Clear, well-lit photos of printed text work best; neat handwriting usually works, joined-up writing less so.</p>
                <button type="button" class="primary-btn st-go" data-read hidden>Make the note</button>
            </div></div>`);
        const paintPages = () => {
            dlg.querySelector('[data-pages]').innerHTML = S.pages.map((p, i) => `<figure><img src="${p.url}" alt="Page ${i + 1}"><button type="button" class="icon-btn" data-drop="${i}" aria-label="Remove page ${i + 1}">${ic('i-close')}</button><figcaption>Page ${i + 1}</figcaption></figure>`).join('');
            dlg.querySelector('[data-read]').hidden = !S.pages.length;
            dlg.querySelector('[data-read]').textContent = canRead() ? `Read ${S.pages.length === 1 ? 'the page' : `${S.pages.length} pages`} into a note` : 'Save the scan as a note';
        };
        const add = async files => {
            for (const f of files) {
                try { const canvas = await enhance(f, S.kind); S.pages.push({ canvas, url: canvas.toDataURL('image/jpeg', 0.85) }); } catch (e) { toast('Couldn’t open that photo'); }
            }
            paintPages();
        };
        dlg.addEventListener('click', async e => {
            if (e.target.closest('[data-x]')) return dlg.close();
            const k = e.target.closest('[data-kind]'); if (k) { S.kind = k.dataset.kind; dlg.querySelectorAll('[data-kind]').forEach(b => b.setAttribute('aria-pressed', String(b === k))); return; }
            if (e.target.closest('[data-shot]')) {
                const shots = await camera(S.kind);
                if (shots === null) return add(await Media.pickFiles('image/*', false, 'environment'));
                return add(shots);
            }
            if (e.target.closest('[data-pick]')) return add(await Media.pickFiles('image/*', true));
            const d = e.target.closest('[data-drop]'); if (d) { S.pages.splice(Number(d.dataset.drop), 1); return paintPages(); }
            const go = e.target.closest('[data-read]');
            if (!go) return;
            go.disabled = true;
            go.textContent = 'Reading…';
            const texts = [];
            let failed = false;
            for (let i = 0; i < S.pages.length; i++) {
                const page = `${S.pages.length > 1 ? `page ${i + 1} of ${S.pages.length}` : 'the page'}`;
                ocrProgress = m => {
                    if (!go.isConnected) return;
                    if (m.status === 'recognizing text') go.textContent = `Reading ${page} · ${Math.round((m.progress || 0) * 100)}%`;
                    else if (/load|initializ/i.test(m.status || '')) go.textContent = 'Getting the text reader ready…';
                };
                try { texts.push(await readText(S.pages[i].canvas)); } catch (err) { failed = true; texts.push(''); }
            }
            ocrProgress = null;
            if (failed && !texts.some(Boolean)) toast('Couldn’t read the text (are you offline?) — the scan is saved as pages');
            const text = texts.filter(Boolean).join('\n\n').trim();
            dlg.close();
            const kind = SCAN_KINDS.find(x => x[0] === S.kind);
            const body = S.kind === 'receipt' ? receiptHTML(text) : text.split(/\n{2,}/).map(par => `<p>${esc(par).replace(/\n/g, '<br>')}</p>`).join('');
            if (into) {
                const ed = document.getElementById('editor-body');
                if (!text) return toast(failed ? 'Couldn’t read the text — check your connection and try again' : 'No text found on that page — try a clearer, brighter photo');
                if (ed) { ed.insertAdjacentHTML('beforeend', body); ed.dispatchEvent(new Event('input', { bubbles: true })); toast('Scanned text added'); }
                return;
            }
            const files = await Promise.all(S.pages.map((p, i) => new Promise(r => p.canvas.toBlob(b => r(new File([b], `scan-${i + 1}.jpg`, { type: 'image/jpeg' })), 'image/jpeg', 0.85))));
            const title = text ? text.split('\n').find(l => l.trim().length > 2)?.trim().slice(0, 80) || `${kind[2]} scan` : `${kind[2]} scan — ${new Date().toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}`;
            const made = await app.createEntry({ title, html: body || '<p></p>' }, files);
            app.updateNote(made.id, { ntype: 'scan' });
            toast(text ? 'Scanned into a new note ✨ — check and edit the text' : 'Scan saved as a note');
            app.openNote(made.id);
        });
    }
    // ---------- The scanner camera: the live rear camera, a page frame, shutter, flash, several pages ----------
    // Resolves with the captured pages (canvases, cropped to the frame), [] if closed, or null when the camera
    // can't be used here (then the phone's own camera / photo picker takes over).
    const FRAME = { receipt: 0.45, whiteboard: 1.6, textbook: 0.72, handwritten: 0.72, document: 0.71 }; // width ÷ height
    async function camera(kind) {
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || !window.isSecureContext) return null;
        let stream;
        try {
            stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: { ideal: 'environment' }, width: { ideal: 3840 }, height: { ideal: 2160 } } });
        } catch (e) {
            if (e && (e.name === 'NotAllowedError' || e.name === 'SecurityError')) toast('Camera access is off for Cordial — allow it in your browser’s site settings, or pick a photo');
            return null;
        }
        const track = stream.getVideoTracks()[0];
        const caps = track && track.getCapabilities ? track.getCapabilities() : {};
        try { if ((caps.focusMode || []).includes('continuous')) await track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] }); } catch (e) { /* fine without */ }
        const ratio = FRAME[kind] || 0.71;
        return new Promise(resolve => {
            const shots = [];
            let torch = false;
            const dlg = document.createElement('dialog');
            dlg.className = 'scam';
            dlg.setAttribute('aria-label', 'Scanner camera');
            dlg.innerHTML = `
                <video class="scam-video" playsinline muted autoplay></video>
                <div class="scam-shade" aria-hidden="true"><div class="scam-frame"><i></i><i></i><i></i><i></i></div></div>
                <div class="scam-flash" aria-hidden="true"></div>
                <header class="scam-top">
                    <button type="button" class="scam-btn" data-cam="close" aria-label="Close the camera">${ic('i-close')}</button>
                    <p class="scam-hint" aria-live="polite">Fit the page inside the frame</p>
                    ${caps.torch ? `<button type="button" class="scam-btn" data-cam="torch" aria-pressed="false" aria-label="Flash">${ic('i-flash')}</button>` : '<span class="scam-btn-spacer"></span>'}
                </header>
                <footer class="scam-bottom">
                    <div class="scam-thumbs" aria-live="polite"></div>
                    <button type="button" class="scam-shutter" data-cam="shot" aria-label="Take the photo"><span></span></button>
                    <button type="button" class="scam-done" data-cam="done" disabled>Done</button>
                </footer>`;
            document.body.append(dlg);
            const video = dlg.querySelector('video');
            video.srcObject = stream;
            video.play().catch(() => {});
            const frameEl = dlg.querySelector('.scam-frame');
            const layout = () => {
                const w = dlg.clientWidth, h = dlg.clientHeight - 210; // room for the bars
                let fw = w * 0.86, fh = fw / ratio;
                if (fh > h * 0.92) { fh = h * 0.92; fw = fh * ratio; }
                frameEl.style.width = `${fw}px`;
                frameEl.style.height = `${fh}px`;
            };
            const finish = result => {
                stream.getTracks().forEach(t => t.stop());
                window.removeEventListener('resize', layout);
                if (dlg.open) dlg.close();
                dlg.remove();
                resolve(result);
            };
            const thumbs = () => {
                dlg.querySelector('.scam-thumbs').innerHTML = shots.slice(-3).map((c, i, a) => `<img src="${c.toDataURL('image/jpeg', 0.4)}" alt=""${i === a.length - 1 ? ' class="new"' : ''}>`).join('') + (shots.length ? `<b>${shots.length}</b>` : '');
                const done = dlg.querySelector('[data-cam="done"]');
                done.disabled = !shots.length;
                done.textContent = shots.length ? `Done (${shots.length})` : 'Done';
                dlg.querySelector('.scam-hint').textContent = shots.length ? 'Next page, or tap Done' : 'Fit the page inside the frame';
            };
            // Copy just the part of the picture inside the frame (the video fills the screen, so map screen → camera pixels)
            const capture = () => {
                const vw = video.videoWidth, vh = video.videoHeight;
                if (!vw || !vh) return toast('The camera is still starting…');
                const vr = video.getBoundingClientRect(), fr = frameEl.getBoundingClientRect();
                const s = Math.max(vr.width / vw, vr.height / vh);
                const ox = vr.left + (vr.width - vw * s) / 2, oy = vr.top + (vr.height - vh * s) / 2;
                const pad = 0.04;
                let sx = (fr.left - ox) / s - fr.width / s * pad, sy = (fr.top - oy) / s - fr.height / s * pad;
                let sw = fr.width / s * (1 + 2 * pad), sh = fr.height / s * (1 + 2 * pad);
                sx = Math.max(0, sx); sy = Math.max(0, sy); sw = Math.min(vw - sx, sw); sh = Math.min(vh - sy, sh);
                const c = document.createElement('canvas');
                c.width = Math.round(sw); c.height = Math.round(sh);
                c.getContext('2d').drawImage(video, sx, sy, sw, sh, 0, 0, c.width, c.height);
                shots.push(c);
                const flash = dlg.querySelector('.scam-flash');
                flash.classList.remove('go'); void flash.offsetWidth; flash.classList.add('go');
                if (navigator.vibrate) { try { navigator.vibrate(20); } catch (e) { /* ignore */ } }
                thumbs();
            };
            dlg.addEventListener('click', async e => {
                const b = e.target.closest('[data-cam]');
                if (!b) {
                    // Tap the picture to refocus where the phone allows it
                    if (e.target === video && (caps.focusMode || []).includes('single-shot')) { try { await track.applyConstraints({ advanced: [{ focusMode: 'single-shot' }] }); } catch (err) { /* ignore */ } }
                    return;
                }
                const a = b.dataset.cam;
                if (a === 'shot') capture();
                else if (a === 'done') finish(shots);
                else if (a === 'close') finish(shots.length ? shots : []);
                else if (a === 'torch') {
                    torch = !torch;
                    try { await track.applyConstraints({ advanced: [{ torch }] }); b.setAttribute('aria-pressed', String(torch)); } catch (err) { toast('The flash isn’t available'); }
                }
            });
            dlg.addEventListener('cancel', e => { e.preventDefault(); finish(shots.length ? shots : []); });
            document.addEventListener('keydown', function key(e) { if (!dlg.isConnected) return document.removeEventListener('keydown', key); if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); capture(); } });
            track.addEventListener('ended', () => { if (dlg.isConnected) { toast('The camera stopped'); finish(shots); } });
            window.addEventListener('resize', layout);
            dlg.showModal();
            layout();
            dlg.querySelector('[data-cam="shot"]').focus({ preventScroll: true });
        });
    }
    // Clean the photo up for reading: scale it, flatten the lighting, boost contrast (stronger for receipts and boards)
    async function enhance(file, kind) {
        const bmp = await createImageBitmap(file);
        const scale = Math.min(1, 2000 / Math.max(bmp.width, bmp.height));
        const c = document.createElement('canvas');
        c.width = Math.round(bmp.width * scale); c.height = Math.round(bmp.height * scale);
        const g = c.getContext('2d', { willReadFrequently: true });
        g.drawImage(bmp, 0, 0, c.width, c.height);
        const img = g.getImageData(0, 0, c.width, c.height);
        const d = img.data;
        const strong = kind === 'receipt' || kind === 'whiteboard' || kind === 'handwritten';
        let sum = 0;
        for (let i = 0; i < d.length; i += 4) sum += 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
        const mean = sum / (d.length / 4);
        const gain = strong ? 1.9 : 1.4, lift = (strong ? 205 : 190) - mean;
        for (let i = 0; i < d.length; i += 4) {
            const y = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
            let v = (y - mean) * gain + mean + lift;
            v = Math.max(0, Math.min(255, v));
            if (kind === 'textbook' || kind === 'document') { const keep = 0.25; d[i] = d[i] * keep + v * (1 - keep); d[i + 1] = d[i + 1] * keep + v * (1 - keep); d[i + 2] = d[i + 2] * keep + v * (1 - keep); }
            else d[i] = d[i + 1] = d[i + 2] = v;
        }
        g.putImageData(img, 0, 0);
        return c;
    }
    async function readText(canvas) {
        if (typeof window.diaryOCR === 'function') return String(await window.diaryOCR(canvas) || '');
        let quick = '';
        try {
            if ('TextDetector' in window) {
                const found = await new window.TextDetector().detect(canvas);
                const rows = found.map(t => ({ y: t.boundingBox.y, x: t.boundingBox.x, h: t.boundingBox.height, s: t.rawValue })).sort((a, b) => a.y - b.y || a.x - b.x);
                const lines = [];
                for (const r of rows) { const last = lines[lines.length - 1]; if (last && Math.abs(last.y - r.y) < r.h * 0.6) { last.parts.push(r); } else lines.push({ y: r.y, parts: [r] }); }
                quick = lines.map(l => l.parts.sort((a, b) => a.x - b.x).map(p => p.s).join(' ')).join('\n');
            }
        } catch (e) { /* the browser's reader isn't usable here */ }
        if (quick.trim().length > 20) return quick;
        return tesseract(canvas); // throws if it can't load (e.g. offline the first time)
    }
    function receiptHTML(text) {
        if (!text) return '';
        const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
        const total = lines.slice().reverse().find(l => /\b(total|amount due|balance)\b/i.test(l));
        const items = lines.filter(l => /\d[.,]\d{2}\s*$/.test(l) && l !== total);
        return `${total ? `<h3>🧾 ${esc(total)}</h3>` : ''}${items.length ? `<ul>${items.map(l => `<li>${esc(l)}</li>`).join('')}</ul>` : ''}<p>${esc(lines.join('\n')).replace(/\n/g, '<br>')}</p>`;
    }

    document.addEventListener('click', e => { if (e.target.closest('[data-scan-note]')) scan(); });
    window.diaryScan = { scan };
});
