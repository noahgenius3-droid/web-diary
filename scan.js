// Scan → Note: photograph handwritten notes, whiteboards, textbooks, receipts and documents, and Cordial types out
// exactly what's on the page into an editable note. The in-app scanner camera crops each shot to a page frame;
// the photo is cleaned up and read on the device by Tesseract.js (open source), loaded only the first time someone
// scans. Nothing is uploaded, and no AI touches the text: Cordial transcribes, it never guesses or "fixes".
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
        dlg.addEventListener('close', () => dlg.remove());
        dlg.addEventListener('click', e => { if (e.target === dlg) dlg.close(); });
        dlg.showModal();
        return dlg;
    }
    const head = (title, sub, extra = '') => `<header class="gm-head"><button type="button" class="icon-btn" data-x aria-label="Close">${ic('i-close')}</button><div class="gm-title"><strong>${title}</strong>${sub ? `<small>${sub}</small>` : ''}</div>${extra}</header>`;

    // ======================================================================
    // Scan → Note
    // ======================================================================
    const SCAN_KINDS = [['handwritten', '✍️', 'Handwritten'], ['whiteboard', '🧑‍🏫', 'Whiteboard'], ['textbook', '📘', 'Textbook'], ['receipt', '🧾', 'Receipt'], ['document', '📄', 'Document']];
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const pct = n => `${Math.round(n)}%`;
    const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

    function scan({ into = false } = {}) {
        const S = { kind: 'document', pages: [], job: 0, results: null };
        const dlg = sheet('st-scan', 'Scan to note', `<div class="gm-card">${head('🖨️ Scan → Note', into ? 'Add a scanned page to this note' : 'Turn a photo into an editable note')}
            <div class="gm-body st-body" data-view></div><footer class="sc-foot" data-foot hidden></footer></div>`);
        const view = dlg.querySelector('[data-view]'), foot = dlg.querySelector('[data-foot]');
        const show = (html, footHTML = '') => { view.innerHTML = html; foot.innerHTML = footHTML; foot.hidden = !footHTML; view.scrollTop = 0; };
        const wide = on => dlg.classList.toggle('sc-wide', on);
        let rv = null; // the review screen, while it's open

        // ---------- 1. Choose what you're scanning and take the photos ----------
        const pickView = () => {
            wide(false); rv = null;
            show(`<p class="st-label">What are you scanning?</p>
                <div class="st-cats">${SCAN_KINDS.map(([k, e, l]) => `<button type="button" data-kind="${k}" aria-pressed="${k === S.kind}">${e} ${l}</button>`).join('')}</div>
                <div class="st-pages" data-pages></div>
                <div class="st-row"><button type="button" class="primary-btn" data-shot>${ic('i-camera')}Scan with camera</button><button type="button" class="ghost-btn" data-pick>${ic('i-image')}From photos</button></div>
                <p class="st-tip">Cordial types out only what it can see — it never fills in or “fixes” words. Anything it can’t read clearly is flagged for you to check. Text is read on your device; nothing is uploaded (the first scan downloads the reader, about 5 MB, once).</p>
                <button type="button" class="primary-btn st-go" data-read hidden>Read the page</button>`);
            paintPages();
        };
        const paintPages = () => {
            const box = view.querySelector('[data-pages]'); if (!box) return;
            box.innerHTML = S.pages.map((p, i) => `<figure><img src="${p.url}" alt="Page ${i + 1}"><button type="button" class="icon-btn" data-drop="${i}" aria-label="Remove page ${i + 1}">${ic('i-close')}</button><figcaption>Page ${i + 1}</figcaption></figure>`).join('');
            const go = view.querySelector('[data-read]');
            go.hidden = !S.pages.length;
            go.textContent = S.pages.length > 1 ? `Read ${S.pages.length} pages` : 'Read the page';
        };
        const add = async files => {
            for (const f of files) {
                let canvas = null;
                for (let t = 0; t < 2 && !canvas; t++) { try { canvas = await original(f); } catch (e) { await sleep(600); } }
                if (canvas) S.pages.push({ canvas, url: canvas.toDataURL('image/jpeg', 0.85) }); else toast('Couldn’t open that photo — try another one');
            }
            paintPages();
        };
        const shoot = async () => {
            const shots = await camera(S.kind);
            if (shots === null) return add(await Media.pickFiles('image/*', false, 'environment'));
            return add(shots);
        };

        // ---------- 2. Reading, with honest progress (and a way out) ----------
        const busyView = () => {
            wide(false);
            show(`<div class="sc-busy" role="status" aria-live="polite">
                    <div class="sc-thumb"><img src="${S.pages[0].url}" alt=""><i class="sc-beam" aria-hidden="true"></i></div>
                    <strong>Scanning document…</strong>
                    <p data-step>Getting ready</p>
                    <div class="sc-bar" aria-hidden="true"><i data-bar></i></div>
                </div>`, `<div class="st-row"><button type="button" class="ghost-btn" data-cancel>Cancel</button></div>`);
        };
        const STEP = { clean: 'Cleaning up the photo — light, contrast, straightening', load: 'Getting the text reader ready (first time only)', read: 'Detecting and reading text', check: 'Double-checking the words it wasn’t sure of', retry: 'Connection hiccup — trying again…' };
        const SPAN = { clean: [0, 0.08], load: [0.08, 0.12], read: [0.12, 0.85], check: [0.85, 1], retry: [0.08, 0.12] };
        const read = async () => {
            const job = ++S.job;
            busyView();
            const results = [];
            for (let i = 0; i < S.pages.length; i++) {
                const onStep = (step, p = 0) => {
                    if (job !== S.job) return;
                    const [a, b] = SPAN[step] || [0, 1], f = (i + a + (b - a) * Math.max(0, Math.min(1, p))) / S.pages.length;
                    const el = view.querySelector('[data-step]'), bar = view.querySelector('[data-bar]');
                    if (el) el.textContent = `${S.pages.length > 1 ? `Page ${i + 1} of ${S.pages.length} · ` : ''}${STEP[step] || ''}${step === 'read' ? ` · ${pct(p * 100)}` : ''}`;
                    if (bar) bar.style.transform = `scaleX(${f})`;
                };
                let r = null, err = null;
                for (let t = 0; t < 2 && !r; t++) {
                    try { r = await readPage(S.pages[i].canvas, S.kind, onStep, () => job === S.job); } catch (e) { err = e; if (job !== S.job) return; if (!t) await sleep(800); }
                }
                if (job !== S.job) return; // cancelled
                if (!r) { toast(navigator.onLine === false ? 'You’re offline — the text reader needs a connection the first time' : `Couldn’t read the text${err && err.message ? ` (${err.message})` : ''} — try again`); return pickView(); }
                results.push(r);
            }
            S.results = results;
            doneView();
        };
        const cancel = () => { S.job++; toast('Scan cancelled'); pickView(); };

        // ---------- 3. The result: how sure Cordial is, and what (if anything) needs a look ----------
        const totals = () => {
            const rs = S.results || [];
            let words = 0, q = 0, bad = 0, wsum = 0, csum = 0, known = true;
            for (const r of rs) { words += r.words; q += r.flagged; bad += r.unreadable; if (r.conf == null) known = false; else { wsum += r.weight; csum += r.conf * r.weight; } }
            const conf = known && wsum ? csum / wsum : null;
            const low = !words || (conf != null && (conf < 62 || bad > Math.max(2, words * 0.15)));
            return { words, q, bad, conf, low, check: q + bad };
        };
        const doneView = () => {
            wide(false); rv = null;
            const t = totals();
            const peek = renderParas(S.results, true);
            if (!t.words) {
                return show(`<div class="sc-done warn"><span class="sc-badge" aria-hidden="true">?</span><strong>No text found</strong><p>Cordial couldn’t find any writing it could read on ${S.pages.length > 1 ? 'these pages' : 'this page'}. A sharper, brighter photo, square to the page, usually fixes it.</p></div>`,
                    `<div class="st-row"><button type="button" class="ghost-btn" data-act="photo">${into ? 'Add just the photo' : 'Save the photo as a note'}</button><button type="button" class="primary-btn" data-act="retake">${ic('i-camera')}Retake scan</button></div>`);
            }
            const sure = t.conf == null ? '' : `${pct(t.conf)} confident`;
            const need = t.check ? `${plural(t.check, 'word')} may need review` : 'Nothing flagged';
            if (t.low) {
                return show(`<div class="sc-done warn"><span class="sc-badge" aria-hidden="true">!</span><strong>Some text couldn’t be read clearly</strong><p>${[sure, need].filter(Boolean).join(' · ')}. Rather than guess, Cordial has marked those spots — retake the photo for a cleaner read, or review them yourself.</p></div>
                    <div class="sc-peek" aria-label="Detected text (preview)">${peek}</div>`,
                    `<div class="st-row"><button type="button" class="ghost-btn" data-act="retake">${ic('i-camera')}Retake scan</button><button type="button" class="ghost-btn" data-act="review">Review scan</button><button type="button" class="primary-btn" data-act="add">Use detected text</button></div>`);
            }
            show(`<div class="sc-done"><span class="sc-badge ok" aria-hidden="true">✓</span><strong>Scan complete</strong><p>${[sure, need].filter(Boolean).join(' · ')}</p></div>
                <div class="sc-peek" aria-label="Detected text (preview)">${peek}</div>`,
                `<div class="st-row"><button type="button" class="ghost-btn" data-act="review">${t.check ? `Review ${plural(t.check, 'word')}` : 'Review scan'}</button><button type="button" class="primary-btn" data-act="add">${into ? 'Add to this note' : 'Add to note'}</button></div>`);
        };

        // ---------- 4. Review: the photo beside the text, flagged words one tap away ----------
        const reviewView = () => {
            wide(true);
            show(`<div class="sc-review">
                    <div class="sc-tabs" role="tablist" aria-label="Show"><button type="button" role="tab" data-tab="0" aria-selected="false">Original</button><button type="button" role="tab" data-tab="1" aria-selected="true">Scanned text</button></div>
                    <div class="sc-panes" data-panes>
                        <section class="sc-pane sc-orig" aria-label="Original scan">
                            <div class="sc-stage" data-stage><div class="sc-zoom" data-zoom><img alt="" data-img><div class="sc-boxes" data-boxes></div></div></div>
                            ${S.pages.length > 1 ? `<div class="sc-pagesw" data-pagesw>${S.pages.map((p, i) => `<button type="button" data-pg="${i}" aria-label="Page ${i + 1}">${i + 1}</button>`).join('')}</div>` : ''}
                            <p class="sc-hint">Tap a highlighted word in the text to zoom in here. Tap the picture to zoom out.</p>
                        </section>
                        <section class="sc-pane sc-textpane" aria-label="Scanned text">
                            <canvas class="sc-lens" data-lens hidden aria-hidden="true"></canvas>
                            <div class="sc-edit" contenteditable="true" spellcheck="false" autocapitalize="off" data-edit>${renderParas(S.results)}</div>
                        </section>
                    </div>
                </div>`,
                `<div class="sc-check" data-check></div><div class="st-row"><button type="button" class="ghost-btn" data-act="back">Back</button><button type="button" class="primary-btn" data-act="add">${into ? 'Add to this note' : 'Add to note'}</button></div>`);
            rv = { page: 0, z: { s: 1, x: 0, y: 0 }, active: null };
            const panes = view.querySelector('[data-panes]');
            const tabs = [...view.querySelectorAll('[data-tab]')];
            const syncTabs = () => { const i = panes.scrollLeft > panes.clientWidth / 2 ? 1 : 0; tabs.forEach((b, k) => b.setAttribute('aria-selected', String(k === i))); };
            panes.addEventListener('scroll', syncTabs, { passive: true });
            requestAnimationFrame(() => { panes.scrollLeft = panes.scrollWidth; syncTabs(); }); // start on the text (phones)
            const edit = view.querySelector('[data-edit]');
            edit.addEventListener('input', () => {
                // A flagged word you've changed counts as checked
                edit.querySelectorAll('mark.sc-q:not(.done)').forEach(m => { if (m.textContent !== m.dataset.orig) m.classList.add('done'); });
                paintCheck();
            });
            edit.addEventListener('click', e => { const m = e.target.closest('mark.sc-q'); if (m && !m.classList.contains('done')) focusMark(m, false); });
            view.querySelector('[data-img]').addEventListener('load', layoutStage);
            showPage(0);
            paintCheck();
            const first = edit.querySelector('mark.sc-q:not(.done)');
            if (first) focusMark(first, false, true);
        };
        const marks = () => [...view.querySelectorAll('mark.sc-q:not(.done)')];
        const paintCheck = () => {
            const bar = foot.querySelector('[data-check]'); if (!bar || !rv) return;
            const left = marks();
            if (!left.length) { bar.innerHTML = '<p class="sc-allgood">✓ Nothing left to check — edit anything else you like.</p>'; paintBoxes(); return; }
            const m = rv.active && rv.active.isConnected && !rv.active.classList.contains('done') ? rv.active : null;
            const i = m ? left.indexOf(m) : -1;
            bar.innerHTML = `<span class="sc-count">${m ? `${i + 1} of ${left.length} to check` : `${plural(left.length, 'word')} to check`}</span>
                <button type="button" class="icon-btn" data-q="prev" aria-label="Previous word to check">‹</button>
                <button type="button" class="ghost-btn" data-q="ok"${m ? '' : ' disabled'}>${m && m.classList.contains('bad') ? 'Leave as [?]' : 'Looks right'}</button>
                <button type="button" class="icon-btn" data-q="next" aria-label="Next word to check">›</button>`;
            paintBoxes();
        };
        const showPage = i => {
            if (!rv) return;
            rv.page = i;
            const img = view.querySelector('[data-img]');
            if (img.dataset.pg !== String(i)) { img.dataset.pg = String(i); img.src = S.pages[i].url; img.alt = `Page ${i + 1} of the scan`; }
            view.querySelectorAll('[data-pg]').forEach(b => b.setAttribute('aria-pressed', String(Number(b.dataset.pg) === i)));
            layoutStage();
        };
        const pageSize = i => ({ w: S.pages[i].canvas.width, h: S.pages[i].canvas.height });
        const layoutStage = () => {
            if (!rv) return;
            const stage = view.querySelector('[data-stage]'), zoom = view.querySelector('[data-zoom]');
            const { w, h } = pageSize(rv.page);
            const fit = Math.min(stage.clientWidth / w, stage.clientHeight / h) || 1;
            rv.fit = fit;
            zoom.style.width = `${w * fit}px`; zoom.style.height = `${h * fit}px`;
            zoom.style.left = `${(stage.clientWidth - w * fit) / 2}px`; zoom.style.top = `${(stage.clientHeight - h * fit) / 2}px`;
            applyZoom();
            paintBoxes();
        };
        const applyZoom = () => { const zoom = view.querySelector('[data-zoom]'); if (zoom) { zoom.style.transform = `translate(${rv.z.x}px, ${rv.z.y}px) scale(${rv.z.s})`; zoom.style.setProperty('--z', rv.z.s); } };
        const zoomTo = box => {
            const stage = view.querySelector('[data-stage]'), zoom = view.querySelector('[data-zoom]');
            if (!box) { rv.z = { s: 1, x: 0, y: 0 }; return applyZoom(); }
            const f = rv.fit, bw = (box[2] - box[0]) * f, bh = (box[3] - box[1]) * f;
            const s = Math.max(1.6, Math.min(5, Math.min(stage.clientWidth * 0.55 / Math.max(bw, 1), stage.clientHeight * 0.3 / Math.max(bh, 1))));
            const cx = (box[0] + box[2]) / 2 * f + zoom.offsetLeft, cy = (box[1] + box[3]) / 2 * f + zoom.offsetTop;
            // Scale about the picture's own corner, then slide the word to the middle of the frame
            rv.z = { s, x: stage.clientWidth / 2 - zoom.offsetLeft - (cx - zoom.offsetLeft) * s, y: stage.clientHeight / 2 - zoom.offsetTop - (cy - zoom.offsetTop) * s };
            applyZoom();
        };
        const paintBoxes = () => {
            const layer = view.querySelector('[data-boxes]'); if (!layer || !rv) return;
            const { w, h } = pageSize(rv.page);
            layer.innerHTML = marks().filter(m => Number(m.dataset.page) === rv.page).map(m => {
                const b = m.dataset.box.split(',').map(Number);
                return `<i class="sc-box${m.classList.contains('bad') ? ' bad' : ''}${m === rv.active ? ' on' : ''}" style="left:${b[0] / w * 100}%;top:${b[1] / h * 100}%;width:${(b[2] - b[0]) / w * 100}%;height:${(b[3] - b[1]) / h * 100}%"></i>`;
            }).join('');
        };
        // A close-up of the flagged word, right above the text, so you can check it without leaving the text
        const paintLens = m => {
            const lens = view.querySelector('[data-lens]'); if (!lens) return;
            if (!m) { lens.hidden = true; return; }
            const b = m.dataset.box.split(',').map(Number), src = S.pages[Number(m.dataset.page)].canvas;
            const W = lens.clientWidth || lens.parentElement.clientWidth, H = 96, dpr = Math.min(2, window.devicePixelRatio || 1);
            lens.hidden = false;
            lens.width = Math.round(W * dpr); lens.height = Math.round(H * dpr);
            const bh = Math.max(8, b[3] - b[1]), sh = bh * 2.6, sw = sh * (W / H);
            const sx = Math.max(0, Math.min(src.width - sw, (b[0] + b[2]) / 2 - sw / 2)), sy = Math.max(0, Math.min(src.height - sh, (b[1] + b[3]) / 2 - sh / 2));
            const g = lens.getContext('2d'), k = lens.width / sw;
            g.fillStyle = '#fff'; g.fillRect(0, 0, lens.width, lens.height);
            g.drawImage(src, sx, sy, sw, sh, 0, 0, lens.width, lens.height);
            g.strokeStyle = m.classList.contains('bad') ? '#dc2626' : '#f59e0b'; g.lineWidth = 2.5 * dpr;
            const pad = 3 * dpr;
            g.strokeRect((b[0] - sx) * k - pad, (b[1] - sy) * k - pad, (b[2] - b[0]) * k + pad * 2, (b[3] - b[1]) * k + pad * 2);
        };
        const focusMark = (m, jump = true, quiet = false) => {
            if (!rv) return;
            view.querySelectorAll('mark.sc-q.on').forEach(x => x.classList.remove('on'));
            rv.active = m;
            if (!m) { paintLens(null); paintCheck(); return; }
            m.classList.add('on');
            const pg = Number(m.dataset.page);
            if (pg !== rv.page) showPage(pg);
            zoomTo(m.dataset.box.split(',').map(Number));
            paintLens(m);
            paintCheck();
            if (!quiet) m.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
            if (jump) { const r = document.createRange(); r.selectNodeContents(m); const s = getSelection(); s.removeAllRanges(); s.addRange(r); }
        };
        const step = dir => {
            const left = marks(); if (!left.length) return;
            const i = rv.active ? left.indexOf(rv.active) : -1;
            focusMark(left[(i + dir + left.length) % left.length] || left[0]);
        };

        // ---------- 5. Into the note: the text as read (and checked), plus the original photos ----------
        const finish = async (withText = true) => {
            const paras = withText ? (rv ? domParas(view.querySelector('[data-edit]')) : domParas(htmlToNode(renderParas(S.results)))) : [];
            const html = paras.map(p => `<p>${esc(p).replace(/\n/g, '<br>')}</p>`).join('');
            const files = await Promise.all(S.pages.map((p, i) => new Promise(r => p.canvas.toBlob(b => r(new File([b], `scan-${i + 1}.jpg`, { type: 'image/jpeg' })), 'image/jpeg', 0.9))));
            const kind = SCAN_KINDS.find(x => x[0] === S.kind);
            dlg.close();
            if (into) {
                const ed = document.getElementById('editor-body');
                if (ed && html) { ed.insertAdjacentHTML('beforeend', html); ed.dispatchEvent(new Event('input', { bubbles: true })); }
                const attached = app.editingId && app.addFilesToEditor && app.addFilesToEditor(app.editingId(), files);
                toast(html ? `Scanned text added${attached ? ' — the original photo is attached below' : ''}` : (attached ? 'Photo added' : 'Nothing was added'));
                return;
            }
            const date = new Date().toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
            // Only a short first line that stands on its own (a heading on the page) becomes the title
            const firstLine = paras[0] && !paras[0].includes('\n') ? paras[0].trim() : '';
            const title = firstLine && firstLine.length <= 60 && paras.length > 1 && !/[.,;:]$/.test(firstLine) && !firstLine.includes('[?]') ? firstLine : `${kind[2]} scan — ${date}`;
            const made = await app.createEntry({ title, html: html || '<p></p>' }, files);
            app.updateNote(made.id, { ntype: 'scan' });
            toast(html ? 'Scanned into a new note — the original photo is attached' : 'Scan saved as a note');
            app.openNote(made.id);
        };

        dlg.addEventListener('click', async e => {
            if (e.target.closest('[data-x]')) { S.job++; return dlg.close(); }
            const k = e.target.closest('[data-kind]'); if (k) { S.kind = k.dataset.kind; view.querySelectorAll('[data-kind]').forEach(b => b.setAttribute('aria-pressed', String(b === k))); return; }
            if (e.target.closest('[data-shot]')) return shoot();
            if (e.target.closest('[data-pick]')) return add(await Media.pickFiles('image/*', true));
            const d = e.target.closest('[data-drop]'); if (d) { S.pages.splice(Number(d.dataset.drop), 1); return paintPages(); }
            if (e.target.closest('[data-read]')) return read();
            if (e.target.closest('[data-cancel]')) return cancel();
            const tab = e.target.closest('[data-tab]');
            if (tab) { const panes = view.querySelector('[data-panes]'); return panes.scrollTo({ left: tab.dataset.tab === '1' ? panes.scrollWidth : 0, behavior: 'smooth' }); }
            const pg = e.target.closest('[data-pg]'); if (pg) { rv.z = { s: 1, x: 0, y: 0 }; return showPage(Number(pg.dataset.pg)); }
            if (e.target.closest('[data-stage]')) { if (rv) { rv.z.s > 1 ? zoomTo(null) : rv.active && zoomTo(rv.active.dataset.box.split(',').map(Number)); } return; }
            const q = e.target.closest('[data-q]');
            if (q) {
                if (q.dataset.q === 'prev') return step(-1);
                if (q.dataset.q === 'next') return step(1);
                if (q.dataset.q === 'ok' && rv.active) { rv.active.classList.add('done'); rv.active.classList.remove('on'); const left = marks(); rv.active = null; return left.length ? focusMark(left[0]) : focusMark(null); }
                return;
            }
            const a = e.target.closest('[data-act]'); if (!a) return;
            const act = a.dataset.act;
            if (act === 'review') return reviewView();
            if (act === 'back') return doneView();
            if (act === 'add') { a.disabled = true; return finish(true); }
            if (act === 'photo') { a.disabled = true; return finish(false); }
            if (act === 'retake') { S.pages = []; S.results = null; pickView(); return shoot(); }
        });
        window.addEventListener('resize', function re() { if (!dlg.isConnected) return window.removeEventListener('resize', re); if (rv) { layoutStage(); if (rv.active) { zoomTo(rv.active.dataset.box.split(',').map(Number)); paintLens(rv.active); } } });
        pickView();
    }

    // The scanned text as HTML: paragraphs, with flagged words marked (for the preview and the review screen)
    function renderParas(results, peek = false) {
        let html = '', n = 0;
        (results || []).forEach((r, page) => {
            for (const para of r.paras) {
                if (peek && n >= 6) return;
                n++;
                html += `<p>${para.lines.map((line, li) => {
                    const joint = li === 0 ? '' : para.keepLines ? '<br>' : (para.lines[li - 1].glue ? '' : ' ');
                    return joint + line.tokens.map(t => t.q ? `<mark class="sc-q${t.q === 2 ? ' bad' : ''}" data-page="${page}" data-box="${t.box.map(Math.round).join(',')}" data-orig="${esc(t.t)}">${esc(t.t)}</mark>` : esc(t.t)).join(' ');
                }).join('')}</p>`;
            }
        });
        return html;
    }
    const htmlToNode = html => { const d = document.createElement('div'); d.innerHTML = html; return d; };
    // Back to plain paragraphs (with line breaks) from the text — including anything the person typed
    function domParas(root) {
        const paras = [];
        let cur = '';
        const push = () => { const t = cur.replace(/ /g, ' ').replace(/[ \t]+\n/g, '\n').replace(/\n[ \t]+/g, '\n').replace(/[ \t]{2,}/g, ' ').trim(); if (t) paras.push(t); cur = ''; };
        const walk = node => {
            for (const c of node.childNodes) {
                if (c.nodeType === 3) cur += c.nodeValue;
                else if (c.nodeName === 'BR') cur += '\n';
                else if (/^(P|DIV|H[1-6]|LI|BLOCKQUOTE)$/.test(c.nodeName)) { push(); walk(c); push(); }
                else if (c.nodeType === 1) walk(c);
            }
        };
        walk(root);
        push();
        return paras;
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
        let track = stream.getVideoTracks()[0];
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
            const capture = async () => {
                if (!video.videoWidth) { dlg.querySelector('.scam-hint').textContent = 'Starting the camera…'; await ready(4000); }
                const vw = video.videoWidth, vh = video.videoHeight;
                if (!vw || !vh) return toast('The camera didn’t start — close it and try again');
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
            // Ready = the camera is actually sending pictures (the first time, right after the permission prompt, it can lag)
            const ready = ms => new Promise(r => {
                if (video.videoWidth && video.readyState >= 2) return r(true);
                const done = () => { clearTimeout(t); video.removeEventListener('loadeddata', on); r(!!video.videoWidth); };
                const on = () => done();
                const t = setTimeout(done, ms);
                video.addEventListener('loadeddata', on);
            });
            (async () => {
                if (await ready(5000)) return;
                // Still nothing: ask for the camera again (once)
                try {
                    stream.getTracks().forEach(t => t.stop());
                    stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: { ideal: 'environment' } } });
                    track = stream.getVideoTracks()[0];
                    video.srcObject = stream;
                    video.play().catch(() => {});
                    if (!(await ready(5000)) && dlg.isConnected) dlg.querySelector('.scam-hint').textContent = 'The camera isn’t responding — close and try again';
                } catch (e) { if (dlg.isConnected) dlg.querySelector('.scam-hint').textContent = 'The camera isn’t responding — close and try again'; }
            })();
            window.addEventListener('resize', layout);
            dlg.showModal();
            layout();
            dlg.querySelector('[data-cam="shot"]').focus({ preventScroll: true });
        });
    }
    // The photo as taken (scaled to a sensible size): this is what's kept with the note as the original scan
    async function decode(file) {
        try { return await createImageBitmap(file); } catch (e) { /* try the slower way */ }
        const url = URL.createObjectURL(file);
        try {
            const img = new Image();
            img.decoding = 'async';
            img.src = url;
            await img.decode();
            return img;
        } finally { setTimeout(() => URL.revokeObjectURL(url), 1000); }
    }
    async function original(file) {
        const bmp = file instanceof HTMLCanvasElement ? file : await decode(file);
        const scale = Math.min(1, 2600 / Math.max(bmp.width, bmp.height));
        const c = makeCanvas(Math.round(bmp.width * scale), Math.round(bmp.height * scale));
        const g = c.getContext('2d');
        g.imageSmoothingQuality = 'high';
        g.drawImage(bmp, 0, 0, c.width, c.height);
        return c;
    }
    const makeCanvas = (w, h) => { const c = document.createElement('canvas'); c.width = Math.max(1, w); c.height = Math.max(1, h); return c; };

    // ======================================================================
    // Reading a page — a faithful transcription, never a guess
    // ======================================================================
    // 1. prepare: clean the photo up for reading — flatten shadows and uneven light, stretch the contrast,
    //    straighten the page, and wipe out printed ruled lines (column dividers, borders, long underlines) and the
    //    dark surroundings of the page, so they can't be read as |, 1 or l. The picture stays greyscale (not
    //    black-and-white) so thin strokes and punctuation survive; the reader does its own fine thresholding.
    // 2. Tesseract reads it, keeping the position and confidence of every word.
    // 3. recheck: words it wasn't sure of get a second, closer look on their own. A different reading is only
    //    taken when the closer look is clearly surer — never because it "makes more sense".
    // 4. transcribe: the text is rebuilt from what was read. Things that aren't writing (a ruled line read as |,
    //    specks read as % © ¢ « », slivers of a neighbouring column cut by the frame) are left out; words still
    //    unsure are kept exactly as read and flagged for review; unreadable ones become [?]. Nothing is added,
    //    completed, numbered or "corrected" from context, and there's no AI step anywhere.
    function percentiles(y, ps) {
        const hist = new Uint32Array(256);
        for (let i = 0; i < y.length; i++) hist[y[i] < 0 ? 0 : y[i] > 255 ? 255 : y[i] | 0]++;
        return ps.map(p => { const want = y.length * p; let acc = 0; for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc >= want) return v; } return 255; });
    }
    // Even out the lighting: divide by the local paper brightness. Areas that aren't paper at all (the table
    // around the page, the page's dark edge, a photo) are turned white so nothing there can be read as text.
    function flatten(y, W, H) {
        const cell = Math.max(12, Math.round(Math.max(W, H) / 64));
        const gw = Math.ceil(W / cell), gh = Math.ceil(H / cell);
        let bg = new Float32Array(gw * gh);
        const hist = new Uint32Array(64);
        for (let cy = 0; cy < gh; cy++) for (let cx = 0; cx < gw; cx++) {
            hist.fill(0); let n = 0;
            const x1 = Math.min(W, (cx + 1) * cell), y1 = Math.min(H, (cy + 1) * cell);
            for (let yy = cy * cell; yy < y1; yy += 2) for (let xx = cx * cell; xx < x1; xx += 2) { hist[Math.min(255, y[yy * W + xx]) >> 2]++; n++; }
            let acc = 0, b = 63;
            for (; b > 0; b--) { acc += hist[b]; if (acc >= n * 0.1) break; } // the paper is the bright part of the cell
            bg[cy * gw + cx] = b * 4 + 2;
        }
        const raw = bg.slice();
        // Cells full of ink (a big heading) borrow the paper from their neighbours…
        const grow = (src, op) => { const out = new Float32Array(src.length); for (let cy = 0; cy < gh; cy++) for (let cx = 0; cx < gw; cx++) { let v = op === 'max' ? 0 : 0, n = 0; for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const x = cx + dx, yy = cy + dy; if (x < 0 || yy < 0 || x >= gw || yy >= gh) continue; const s = src[yy * gw + x]; if (op === 'max') v = Math.max(v, s); else { v += s; n++; } } out[cy * gw + cx] = op === 'max' ? v : v / n; } return out; };
        bg = grow(grow(bg, 'max'), 'max');
        bg = grow(grow(bg, 'avg'), 'avg');
        // …and what's left dark after that isn't paper
        const paper = percentiles(raw, [0.85])[0];
        const notPaper = new Uint8Array(gw * gh);
        for (let i = 0; i < raw.length; i++) notPaper[i] = bg[i] < paper * 0.5 ? 1 : 0;
        const out = new Float32Array(W * H);
        for (let yy = 0; yy < H; yy++) {
            const fy = Math.min(gh - 1, Math.max(0, (yy + 0.5) / cell - 0.5)), y0 = Math.floor(fy), y1 = Math.min(gh - 1, y0 + 1), ty = fy - y0;
            for (let xx = 0; xx < W; xx++) {
                const fx = Math.min(gw - 1, Math.max(0, (xx + 0.5) / cell - 0.5)), x0 = Math.floor(fx), x1 = Math.min(gw - 1, x0 + 1), tx = fx - x0;
                if (notPaper[Math.floor(yy / cell) * gw + Math.floor(xx / cell)]) { out[yy * W + xx] = 255; continue; }
                const b = (bg[y0 * gw + x0] * (1 - tx) + bg[y0 * gw + x1] * tx) * (1 - ty) + (bg[y1 * gw + x0] * (1 - tx) + bg[y1 * gw + x1] * tx) * ty;
                out[yy * W + xx] = Math.min(255, y[yy * W + xx] / Math.max(b, 24) * 255);
            }
        }
        // Big solid dark patches left over (a page edge in shadow, a thick border) aren't writing either
        const dark = new Float32Array(gw * gh);
        for (let cy = 0; cy < gh; cy++) for (let cx = 0; cx < gw; cx++) {
            let n = 0, k = 0;
            const x1 = Math.min(W, (cx + 1) * cell), y1 = Math.min(H, (cy + 1) * cell);
            for (let yy = cy * cell; yy < y1; yy += 2) for (let xx = cx * cell; xx < x1; xx += 2) { k++; if (out[yy * W + xx] < 110) n++; }
            dark[cy * gw + cx] = n / Math.max(1, k);
        }
        const seen = new Uint8Array(gw * gh);
        for (let i0 = 0; i0 < gw * gh; i0++) {
            if (seen[i0] || dark[i0] < 0.75) continue;
            const comp = [], stack = [i0]; seen[i0] = 1;
            while (stack.length) { const i = stack.pop(); comp.push(i); const cx = i % gw, cy = (i / gw) | 0; for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { const x = cx + dx, yy = cy + dy; if (x < 0 || yy < 0 || x >= gw || yy >= gh) continue; const j = yy * gw + x; if (!seen[j] && dark[j] >= 0.75) { seen[j] = 1; stack.push(j); } } }
            if (comp.length < 4 || comp.reduce((a, i) => a + dark[i], 0) / comp.length < 0.88) continue; // letters are never this solid
            for (const i of comp) { const cx = i % gw, cy = (i / gw) | 0; for (let yy = cy * cell, y1 = Math.min(H, (cy + 1) * cell); yy < y1; yy++) out.fill(255, yy * W + cx * cell, yy * W + Math.min(W, (cx + 1) * cell)); }
        }
        return out;
    }
    // How far the lines of writing are tilted: the angle at which rows of ink line up best
    function skewAngle(y, W, H) {
        const step = Math.max(1, Math.round(Math.max(W, H) / 1000));
        const pts = [];
        for (let yy = 0; yy < H; yy += step) for (let xx = 0; xx < W; xx += step) if (y[yy * W + xx] < 120) pts.push(xx, yy);
        if (pts.length < 400) return 0;
        const stride = Math.max(1, Math.floor(pts.length / 2 / 60000)) * 2;
        const off = Math.ceil(W * 0.12 / step) + 2, rows = new Float64Array(Math.ceil(H / step) + off * 2 + 2);
        const score = a => {
            const t = Math.tan(a * Math.PI / 180);
            rows.fill(0);
            for (let i = 0; i < pts.length; i += stride) rows[Math.round((pts[i + 1] - pts[i] * t) / step) + off]++;
            let s = 0; for (let i = 0; i < rows.length; i++) s += rows[i] * rows[i];
            return s;
        };
        let best = 0, bestS = score(0);
        const flat = bestS;
        for (let a = -6; a <= 6; a += 0.5) { const s = score(a); if (s > bestS) { bestS = s; best = a; } }
        for (let a = best - 0.45; a <= best + 0.45; a += 0.05) { const s = score(a); if (s > bestS) { bestS = s; best = a; } }
        return bestS > flat * 1.04 ? best : 0;
    }
    // Turn the picture so the lines are level (the page keeps its size; the corners fill with white)
    function rotate(y, W, H, deg) {
        const a = deg * Math.PI / 180, ca = Math.cos(a), sa = Math.sin(a), out = new Float32Array(W * H).fill(255);
        const cx = W / 2, cy = H / 2;
        for (let Y = 0; Y < H; Y++) {
            const v = Y - cy;
            for (let X = 0; X < W; X++) {
                const u = X - cx, sx = u * ca - v * sa + cx, sy = u * sa + v * ca + cy;
                const x0 = Math.floor(sx), y0 = Math.floor(sy);
                if (x0 < 0 || y0 < 0 || x0 >= W - 1 || y0 >= H - 1) continue;
                const tx = sx - x0, ty = sy - y0, i = y0 * W + x0;
                out[Y * W + X] = (y[i] * (1 - tx) + y[i + 1] * tx) * (1 - ty) + (y[i + W] * (1 - tx) + y[i + W + 1] * tx) * ty;
            }
        }
        return out;
    }
    // Printed ruled lines — the divider between columns, boxes, long underlines — are much longer and thinner than
    // any letter. They're wiped out so the reader can't turn them into | or 1 or l. Returns the typical line height.
    function removeRules(y, W, H) {
        const INK = 150;
        // Typical height of a line of writing: runs of rows with a fair amount of ink (a ruled line or the page's
        // edge adds only a few dots to each row, so it doesn't count)
        const counts = new Uint32Array(H);
        for (let yy = 0; yy < H; yy++) { let n = 0; for (let xx = 0; xx < W; xx += 2) if (y[yy * W + xx] < INK) n++; counts[yy] = n; }
        const busy = Array.from(counts).filter(n => n > 2).sort((a, b) => a - b);
        const floor = Math.max(3, (busy[Math.floor(busy.length * 0.95)] || 0) * 0.15);
        const runs = [];
        let run = 0;
        for (let yy = 0; yy <= H; yy++) { if (yy < H && counts[yy] > floor) run++; else { if (run >= 4) runs.push(run); run = 0; } }
        runs.sort((a, b) => a - b);
        const lineH = runs.length ? Math.min(runs[Math.floor(runs.length / 2)], Math.round(H / 4)) : 30;
        const LV = Math.max(40, Math.round(lineH * 2.6)), LH = Math.max(Math.round(W * 0.2), lineH * 6);
        const side = Math.max(5, Math.round(lineH * 0.18));
        const margin = Math.max(10, Math.round(Math.min(W, H) * 0.035)); // the page's own edge, in shadow, along the photo's border
        const wipe = new Uint8Array(W * H);
        // Vertical
        for (let xx = 2; xx < W - 2; xx++) {
            let start = -1;
            for (let yy = 0; yy <= H; yy++) {
                const ink = yy < H && y[yy * W + xx] < INK;
                if (ink && start < 0) start = yy;
                if (!ink && start >= 0) {
                    if (yy - start >= LV) {
                        let thick = 0, n = 0;
                        for (let k = start; k < yy; k += 3) { n++; if (y[k * W + Math.max(0, xx - side)] < INK && y[k * W + Math.min(W - 1, xx + side)] < INK) thick++; }
                        if (thick / n < 0.25 || xx < margin || xx > W - margin) for (let k = start; k < yy; k++) for (let d = -2; d <= 2; d++) wipe[k * W + xx + d] = 1;
                    }
                    start = -1;
                }
            }
        }
        // Horizontal
        for (let yy = 2; yy < H - 2; yy++) {
            let start = -1;
            for (let xx = 0; xx <= W; xx++) {
                const ink = xx < W && y[yy * W + xx] < INK;
                if (ink && start < 0) start = xx;
                if (!ink && start >= 0) {
                    if (xx - start >= LH) {
                        let thick = 0, n = 0;
                        for (let k = start; k < xx; k += 3) { n++; if (y[Math.max(0, yy - side) * W + k] < INK && y[Math.min(H - 1, yy + side) * W + k] < INK) thick++; }
                        if (thick / n < 0.25 || yy < margin || yy > H - margin) for (let k = start; k < xx; k++) for (let d = -2; d <= 2; d++) wipe[(yy + d) * W + k] = 1;
                    }
                    start = -1;
                }
            }
        }
        for (let i = 0; i < wipe.length; i++) if (wipe[i] && y[i] < 235) y[i] = 255;
        return lineH;
    }
    // Columns: a clear vertical gutter running down the page (with ink on both sides) splits it into columns, read
    // one at a time — so lines are never stitched across two columns. A heading above (or a footer below) the columns
    // is read on its own, full width.
    function columns(y, W, H, lineH) {
        const INK = 150, step = 2, colInk = new Uint32Array(W);
        let inkRows = 0, top = H, bottom = 0;
        for (let yy = 0; yy < H; yy += step) {
            let any = false;
            for (let xx = 0; xx < W; xx++) if (y[yy * W + xx] < INK) { colInk[xx]++; any = true; }
            if (any) { inkRows++; top = Math.min(top, yy); bottom = Math.max(bottom, yy); }
        }
        const whole = [{ left: 0, top: 0, width: W, height: H }];
        if (inkRows < 10) return whole;
        let xa = 0, xb = W - 1;
        while (xa < W && colInk[xa] <= Math.max(1, inkRows * 0.01)) xa++;
        while (xb > 0 && colInk[xb] <= Math.max(1, inkRows * 0.01)) xb--;
        const total = colInk.reduce((a, v) => a + v, 0), thr = Math.max(1, inkRows * 0.06), minGap = Math.max(lineH * 1.2, W * 0.025);
        const gutters = [];
        for (let x = xa, start = -1; x <= xb + 1; x++) {
            const clear = x <= xb && colInk[x] <= thr;
            if (clear && start < 0) start = x;
            if (!clear && start >= 0) {
                if (x - start >= minGap) {
                    let left = 0; for (let k = xa; k < start; k++) left += colInk[k];
                    if (left > total * 0.12 && total - left > total * 0.12) gutters.push([start, x]);
                }
                start = -1;
            }
        }
        if (!gutters.length) return whole;
        // The stretch of rows where every gutter is completely clear (small specks allowed)…
        const clearRow = new Uint8Array(H), twoSided = new Uint8Array(H);
        const edges = [xa, ...gutters.flat(), xb + 1];
        for (let yy = 0; yy < H; yy++) {
            let ok = true; for (const [g0, g1] of gutters) { for (let x = g0 + 2; x < g1 - 2 && ok; x++) if (y[yy * W + x] < INK) ok = false; }
            clearRow[yy] = ok ? 1 : 0;
            let all = true; // …and with writing in every column on that row
            for (let c = 0; c < edges.length && all; c += 2) { let any = false; for (let x = edges[c]; x < edges[c + 1] && !any; x += 2) if (y[yy * W + x] < INK) any = true; all = any; }
            twoSided[yy] = all ? 1 : 0;
        }
        let best = [0, 0];
        for (let yy = 0, start = -1, bad = 0; yy <= H; yy++) {
            const ok = yy < H && (clearRow[yy] || ++bad < 4);
            if (yy < H && clearRow[yy]) bad = 0;
            if (ok && start < 0) start = yy;
            if (!ok && start >= 0) { if (yy - start > best[1] - best[0]) best = [start, yy]; start = -1; bad = 0; }
        }
        let [ya, yb] = best, both = 0, first = -1, last = -1;
        for (let yy = ya; yy < yb; yy++) if (twoSided[yy]) { both++; if (first < 0) first = yy; last = yy; }
        if (both < lineH * 1.6 || first < 0) return whole;
        let inkA = -1, inkB = -1;
        for (let yy = ya; yy < yb; yy++) { let any = false; for (let x = xa; x <= xb && !any; x += 2) if (y[yy * W + x] < INK) any = true; if (any) { if (inkA < 0) inkA = yy; inkB = yy; } }
        ya = Math.max(ya, Math.min(first, inkA) - Math.round(lineH * 0.6)); yb = Math.min(yb, Math.max(last, inkB) + Math.round(lineH * 0.6));
        const rects = [];
        if (ya - top > lineH * 0.6) rects.push({ left: 0, top: 0, width: W, height: ya });
        const xs = [0, ...gutters.map(([g0, g1]) => Math.round((g0 + g1) / 2)), W];
        for (let i = 0; i < xs.length - 1; i++) rects.push({ left: xs[i], top: ya, width: xs[i + 1] - xs[i], height: yb - ya });
        if (bottom - yb > lineH * 0.6) rects.push({ left: 0, top: yb, width: W, height: H - yb });
        return rects;
    }
    function prepare(src, kind) {
        const long = Math.max(src.width, src.height);
        const scale = long < 1500 ? Math.min(2.2, 2000 / long) : Math.min(1, 2400 / long);
        const W = Math.max(1, Math.round(src.width * scale)), H = Math.max(1, Math.round(src.height * scale));
        const c = makeCanvas(W, H), g = c.getContext('2d', { willReadFrequently: true });
        g.imageSmoothingQuality = 'high';
        g.drawImage(src, 0, 0, W, H);
        const d = g.getImageData(0, 0, W, H).data, N = W * H;
        let y = new Float32Array(N);
        for (let i = 0, j = 0; i < N; i++, j += 4) y[i] = 0.299 * d[j] + 0.587 * d[j + 1] + 0.114 * d[j + 2];
        // Light writing on a dark surface (a blackboard, a dark-mode screenshot): flip it so the ink is dark
        const [p5, p50, p95] = percentiles(y, [0.05, 0.5, 0.95]);
        if (p50 < 128 && p95 - p50 > (p50 - p5) * 1.4) for (let i = 0; i < N; i++) y[i] = 255 - y[i];
        y = flatten(y, W, H);
        // Contrast: the darkest ink to black; the paper is already white
        const lo = percentiles(y, [0.004])[0];
        if (lo > 8 && lo < 200) { const k = 255 / (255 - lo); for (let i = 0; i < N; i++) y[i] = Math.max(0, (y[i] - lo) * k); }
        const angle = skewAngle(y, W, H);
        if (angle) y = rotate(y, W, H, angle);
        const lineH = removeRules(y, W, H);
        const out = makeCanvas(W, H), og = out.getContext('2d'), oi = og.createImageData(W, H);
        for (let i = 0, j = 0; i < N; i++, j += 4) { oi.data[j] = oi.data[j + 1] = oi.data[j + 2] = y[i]; oi.data[j + 3] = 255; }
        og.putImageData(oi, 0, 0);
        const rects = kind === 'receipt' ? [{ left: 0, top: 0, width: W, height: H }] : columns(y, W, H, lineH);
        return { canvas: out, W, H, scale, angle, lineH, kind, rects };
    }
    // A box on the cleaned-up picture → the same spot on the original photo
    function toSource(P, b) {
        const a = P.angle * Math.PI / 180, ca = Math.cos(a), sa = Math.sin(a), cx = P.W / 2, cy = P.H / 2;
        const xs = [], ys = [];
        for (const [X, Y] of [[b.x0, b.y0], [b.x1, b.y0], [b.x0, b.y1], [b.x1, b.y1]]) {
            const u = X - cx, v = Y - cy;
            xs.push((u * ca - v * sa + cx) / P.scale); ys.push((u * sa + v * ca + cy) / P.scale);
        }
        return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
    }

    // ---------- The reader (Tesseract.js, Apache-2.0), loaded the first time someone scans ----------
    const OCR_SRC = 'https://cdn.jsdelivr.net/npm/tesseract.js@7.0.0/dist/tesseract.min.js';
    const TRIES = [0, 1500, 4000]; // the first go, then two more after a pause
    let ocrWorker = null, ocrProgress = null, scriptP = null;
    function loadScript(src) {
        if (scriptP) return scriptP;
        scriptP = (async () => {
            for (const wait of TRIES) {
                if (wait) await sleep(wait);
                document.querySelectorAll('script[data-ocr]').forEach(el => el.remove()); // a half-loaded try
                const ok = await new Promise(resolve => {
                    const el = document.createElement('script');
                    el.src = src; el.async = true; el.crossOrigin = 'anonymous'; el.dataset.ocr = '1';
                    el.onload = () => resolve(true); el.onerror = () => resolve(false);
                    document.head.append(el);
                });
                if (ok && window.Tesseract) return;
            }
            throw new Error('The text reader couldn’t load');
        })().catch(e => { scriptP = null; throw e; });
        return scriptP;
    }
    // One reading at a time: every request waits its turn, so a cancelled scan finishing in the background never
    // trips over the next one. A reader that failed to start is started afresh; one that's running is never stopped
    // half-way (that can leave it broken).
    let queue = Promise.resolve();
    function recognize(canvas, params, tries = TRIES) {
        const run = queue.then(() => recognizeNow(canvas, params, tries));
        queue = run.catch(() => {});
        return run;
    }
    async function recognizeNow(canvas, params, tries) {
        let last = null;
        for (const wait of tries) {
            if (wait) { if (ocrProgress) ocrProgress({ status: 'retrying' }); await sleep(wait); }
            let worker;
            try {
                if (!window.Tesseract) await loadScript(OCR_SRC);
                if (!ocrWorker) ocrWorker = window.Tesseract.createWorker('eng', 1, { logger: m => ocrProgress && ocrProgress(m) }).catch(e => { ocrWorker = null; throw e; });
                worker = await ocrWorker;
            } catch (e) { last = e; ocrWorker = null; continue; } // couldn't start (offline, a download cut short): try again
            try {
                const { data } = await worker.recognize(canvas, params, { text: false, blocks: true });
                return data;
            } catch (e) { last = e; }
        }
        throw last || new Error('Couldn’t read the text');
    }
    const wordsOf = blocks => {
        const out = [];
        (blocks || []).forEach((b, bi) => (b.paragraphs || []).forEach((p, pi) => (p.lines || []).forEach((l, li) => (l.words || []).forEach(w => {
            out.push({ text: String(w.text || ''), conf: Number(w.confidence) || 0, bbox: w.bbox, b: bi, p: pi, l: li, block: b.bbox, line: l.bbox });
        }))));
        return out;
    };

    // A second, closer look at the words the reader wasn't sure of: each one cut out, enlarged and read on its own
    async function relines(P, words, check) {
        const lines = new Map();
        for (const w of words) { const k = `${w.b}.${w.p}.${w.l}`; if (!lines.has(k)) lines.set(k, []); lines.get(k).push(w); }
        const weak = [...lines.values()].filter(ws => ws.length && ws.reduce((a, w) => a + w.conf, 0) / ws.length < 55).slice(0, 8);
        for (const ws of weak) {
            check();
            const b = ws[0].line || { x0: Math.min(...ws.map(w => w.bbox.x0)), y0: Math.min(...ws.map(w => w.bbox.y0)), x1: Math.max(...ws.map(w => w.bbox.x1)), y1: Math.max(...ws.map(w => w.bbox.y1)) };
            const h = b.y1 - b.y0, pad = Math.round(h * 0.3);
            const sx = Math.max(0, b.x0 - pad), sy = Math.max(0, b.y0 - pad), sw = Math.min(P.W, b.x1 + pad) - sx, sh = Math.min(P.H, b.y1 + pad) - sy;
            const k = Math.min(3, Math.max(1, 60 / Math.max(h, 1)));
            const c = makeCanvas(Math.round(sw * k) + 40, Math.round(sh * k) + 40), g = c.getContext('2d');
            g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height);
            g.imageSmoothingQuality = 'high';
            g.drawImage(P.canvas, sx, sy, sw, sh, 20, 20, sw * k, sh * k);
            let got;
            try { got = wordsOf((await recognize(c, { tessedit_pageseg_mode: '7', preserve_interword_spaces: '1' }, [0])).blocks); } catch (e) { continue; }
            if (!got.length) continue;
            const before = ws.reduce((a, w) => a + w.conf, 0) / ws.length, after = got.reduce((a, w) => a + w.conf, 0) / got.length;
            if (after < 75 || after < before + 20) continue; // only a clearly better reading replaces the first
            const at = words.indexOf(ws[0]);
            const back = v => ({ x0: sx + (v.x0 - 20) / k, y0: sy + (v.y0 - 20) / k, x1: sx + (v.x1 - 20) / k, y1: sy + (v.y1 - 20) / k });
            const fresh = got.map(w => ({ ...ws[0], text: w.text, conf: w.conf, bbox: back(w.bbox) }));
            for (const w of ws) words.splice(words.indexOf(w), 1);
            words.splice(at, 0, ...fresh);
        }
    }
    async function recheck(P, words, onStep) {
        const shaky = words.filter(w => (w.conf < 80 || (LOOKALIKE.test(w.text) && w.conf < 95)) && /[\p{L}\p{N}|]/u.test(w.text) && w.bbox.x1 - w.bbox.x0 > 1 && w.bbox.y1 - w.bbox.y0 > 5)
            .sort((a, b) => a.conf - b.conf).slice(0, 30);
        for (let i = 0; i < shaky.length; i++) {
            onStep(i / shaky.length);
            const w = shaky[i], h = w.bbox.y1 - w.bbox.y0;
            const px = Math.round(h * 0.15), py = Math.round(h * 0.35);
            const sx = Math.max(0, w.bbox.x0 - px), sy = Math.max(0, w.bbox.y0 - py);
            const sw = Math.min(P.W, w.bbox.x1 + px) - sx, sh = Math.min(P.H, w.bbox.y1 + py) - sy;
            const k = Math.min(4, Math.max(1, 56 / h));
            const c = makeCanvas(Math.round(sw * k) + 32, Math.round(sh * k) + 32), g = c.getContext('2d');
            g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height);
            g.imageSmoothingQuality = 'high';
            g.drawImage(P.canvas, sx, sy, sw, sh, 16, 16, sw * k, sh * k);
            let got;
            try { got = wordsOf((await recognize(c, { tessedit_pageseg_mode: '8' }, [0])).blocks); } catch (e) { continue; }
            if (got.length !== 1) continue;
            const t2 = got[0].text, c2 = got[0].conf;
            if (t2 === w.text) w.conf = Math.max(w.conf, c2); // both looks agree
            else if (c2 >= 88 && c2 >= w.conf + 15 && Math.abs(t2.length - w.text.length) <= 1) { w.first = w.text; w.text = t2; w.conf = c2; } // clearly surer, same shape
        }
        onStep(1);
    }

    // ---------- From what was read to the text: keep what's visible, drop what isn't writing, flag the unsure ----------
    const LOOKALIKE = /^[1Il|0O]$/;                         // one character that has look-alikes
    const RULE = /^[|¦‖]+$/;                              // a ruled line read as a character
    const PUNCT = /^[-–—:;,.!?'"“”‘’()[\]&/*•·…]+$/;       // ordinary punctuation standing on its own
    const NOWORD = /^[^\p{L}\p{N}]+$/u;                     // no letter or digit at all
    const ODD = /[{}|¦‖§©®¢«»~^_\\¤]/;                       // characters that are usually a misread speck — always shown for review
    const MARKER = /^(\d{1,3}[.):]?|[•·▪◦*–-]|[a-zA-Z][.)])$/; // a verse number, list number or bullet that starts a line
    function transcribe(P, words, kind) {
        const W = P.W, H = P.H, edge = Math.max(6, W * 0.012), vEdge = Math.max(6, H * 0.008);
        const touches = b => b.x0 <= edge || b.x1 >= W - edge;
        // A narrow block hugging the photo's left or right edge is a sliver of the next column or page — unless
        // it's clearly real words (a margin note)
        const blocks = new Map();
        for (const w of words) { const k = w.b; if (!blocks.has(k)) blocks.set(k, []); blocks.get(k).push(w); }
        const dropBlock = new Set();
        for (const [k, ws] of blocks) {
            const b = ws[0].block; if (!b) continue;
            const narrow = b.x1 - b.x0 < W * 0.15 && (b.x0 <= edge * 2 || b.x1 >= W - edge * 2);
            if (narrow && kind !== 'receipt') dropBlock.add(k);
        }
        // Group into lines (in reading order)
        const lines = [];
        let cur = null;
        for (const w of words) {
            if (dropBlock.has(w.b)) continue;
            const key = `${w.b}.${w.p}.${w.l}`;
            if (!cur || cur.key !== key) { cur = { key, b: w.b, p: w.p, box: w.line, words: [] }; lines.push(cur); }
            cur.words.push(w);
        }
        const out = [];
        for (const line of lines) {
            let ws = line.words.map(w => ({ ...w, text: w.text.replace(/^[|¦‖]+(?=\S)/, '').replace(/(?<=\S)[|¦‖]+$/, '') })); // a ruled line stuck to a word
            ws = ws.filter((w, i) => {
                if (!w.text) return false;
                if (RULE.test(w.text)) return w.conf >= 92 && i > 0 && i < ws.length - 1; // a real | between words (a table)
                if (NOWORD.test(w.text)) return PUNCT.test(w.text) ? w.conf >= 55 : w.conf >= 93; // ©, %, ¢, « on their own only when sure
                return true;
            });
            // Fragments cut by the frame at the left/right edge, set apart from the rest of the line by a wide gap
            const gap = Math.max(P.lineH, 20) * 1.6;
            while (ws.length > 1 && ws[0].bbox.x0 <= edge && ws[1].bbox.x0 - ws[0].bbox.x1 > gap && ws[0].text.length <= 4 && ws[0].conf < 90) ws.shift();
            while (ws.length > 1 && ws[ws.length - 1].bbox.x1 >= W - edge && ws[ws.length - 1].bbox.x0 - ws[ws.length - 2].bbox.x1 > gap && ws[ws.length - 1].text.length <= 4 && ws[ws.length - 1].conf < 90) ws.pop();
            if (ws.length === 1 && touches(ws[0].bbox) && ws[0].text.length <= 2 && ws[0].conf < 80) ws = [];
            if (!ws.length) continue;
            // A line that's nothing but unreadable marks along the top or bottom edge is a line cut off by the frame
            const allBad = ws.every(w => w.conf < 40);
            const lb = line.box || ws[0].bbox;
            if (allBad && (lb.y0 <= vEdge || lb.y1 >= H - vEdge || ws.reduce((n, w) => n + w.text.length, 0) <= 3)) continue;
            const tokens = [];
            for (const w of ws) {
                const q = w.conf < 40 ? 2 : (w.conf < 75 || touches(w.bbox) || ODD.test(w.text) || (NOWORD.test(w.text) && !PUNCT.test(w.text)) || (LOOKALIKE.test(w.text) && w.conf < 92)) ? 1 : 0;
                const box = toSource(P, w.bbox);
                const last = tokens[tokens.length - 1];
                if (q === 2 && last && last.q === 2) { last.box = [Math.min(last.box[0], box[0]), Math.min(last.box[1], box[1]), Math.max(last.box[2], box[2]), Math.max(last.box[3], box[3])]; last.n++; continue; }
                tokens.push({ t: q === 2 ? '[?]' : w.text, q, conf: w.conf, n: 1, len: w.text.length, box });
            }
            out.push({ b: line.b, p: line.p, box: { x0: Math.min(...ws.map(w => w.bbox.x0)), y0: Math.min(...ws.map(w => w.bbox.y0)), x1: Math.max(...ws.map(w => w.bbox.x1)), y1: Math.max(...ws.map(w => w.bbox.y1)) }, tokens });
        }
        // Paragraphs: the reader's own paragraphs; a new one also starts where a line begins with a visible verse or
        // list number and the line before finished a sentence. Lines inside a paragraph are joined up again
        // (a physical line break isn't a new paragraph) — except for handwriting, boards and receipts, where the
        // lines themselves mean something.
        const keepLines = kind === 'handwritten' || kind === 'whiteboard' || kind === 'receipt';
        const right = new Map(); // how far right the lines of each block reach
        for (const ln of out) right.set(ln.b, Math.max(right.get(ln.b) || 0, ln.box.x1));
        const lh = Math.max(P.lineH, 12);
        const paras = [];
        let para = null, prevLn = null;
        for (const ln of out) {
            const first = ln.tokens[0].t, prev = para && para.lines[para.lines.length - 1];
            const prevEnd = prev ? prev.tokens[prev.tokens.length - 1].t : '';
            let split = !para;
            if (!split) {
                const continues = !keepLines && !/[.!?:;"”’)\]]$/.test(prevEnd) && /^\p{Ll}/u.test(first); // mid-sentence: same paragraph
                if (para.b !== ln.b || para.p !== ln.p) split = true;
                if (prevLn.box.x1 < right.get(ln.b) - lh * 3) split = true; // the line before stopped short
                if (ln.box.y0 - prevLn.box.y1 > lh * 1.1) split = true; // a blank line
                if (MARKER.test(first) && ln.tokens.length > 1 && /[.;:!?)\]"'”’]$/.test(prevEnd)) split = true; // a verse or list number
                if (continues) split = false;
            }
            if (split) { para = { b: ln.b, p: ln.p, keepLines, lines: [] }; paras.push(para); }
            else if (!keepLines && /\p{L}-$/u.test(prevEnd) && /^\p{Ll}/u.test(first)) prev.glue = true; // "well-" + "known": no space added
            para.lines.push({ tokens: ln.tokens });
            prevLn = ln;
        }
        // A lone 1, l or | standing between ordinary words (even across a line break) is most likely the word I —
        // never changed, but always shown for review
        for (const p of paras) { const toks = p.lines.flatMap(l => l.tokens); toks.forEach((t, i) => { if (t.q === 0 && /^[1l|]$/.test(t.t) && /^\p{L}+[,;:]?$/u.test(toks[i - 1]?.t || '') && /^\p{L}/u.test(toks[i + 1]?.t || '')) t.q = 1; }); }
        let weight = 0, sum = 0, n = 0, flagged = 0, unreadable = 0;
        for (const p of paras) for (const l of p.lines) for (const t of l.tokens) {
            n += t.n; if (t.q === 1) flagged++; if (t.q === 2) unreadable++;
            const wgt = Math.max(1, t.len); weight += wgt; sum += (t.q === 2 ? Math.min(t.conf, 20) : t.conf) * wgt;
        }
        return { paras, words: n, flagged, unreadable, conf: weight ? sum / weight : null, weight };
    }
    // Text from somewhere without word positions (a plugged-in reader, or the browser's own) — kept as it came
    const plainResult = text => {
        const paras = String(text || '').replace(/\r/g, '').split(/\n{2,}/).map(p => p.trim()).filter(Boolean)
            .map(p => ({ keepLines: true, lines: p.split('\n').map(l => ({ tokens: l.split(/\s+/).filter(Boolean).map(t => ({ t, q: 0, box: [0, 0, 0, 0] })) })) }));
        const words = paras.reduce((n, p) => n + p.lines.reduce((m, l) => m + l.tokens.length, 0), 0);
        return { paras, words, flagged: 0, unreadable: 0, conf: null, weight: 0 };
    };
    async function browserReader(canvas) {
        try {
            if (!('TextDetector' in window)) return '';
            const found = await new window.TextDetector().detect(canvas);
            const rows = found.map(t => ({ y: t.boundingBox.y, x: t.boundingBox.x, h: t.boundingBox.height, s: t.rawValue })).sort((a, b) => a.y - b.y || a.x - b.x);
            const lines = [];
            for (const r of rows) { const last = lines[lines.length - 1]; if (last && Math.abs(last.y - r.y) < r.h * 0.6) last.parts.push(r); else lines.push({ y: r.y, parts: [r] }); }
            return lines.map(l => l.parts.sort((a, b) => a.x - b.x).map(p => p.s).join(' ')).join('\n');
        } catch (e) { return ''; }
    }
    const CANCELLED = 'cancelled';
    async function readPage(src, kind = 'document', onStep = () => {}, alive = () => true) {
        const check = () => { if (!alive()) throw new Error(CANCELLED); };
        if (typeof window.diaryOCR === 'function') return plainResult(await window.diaryOCR(src));
        onStep('clean', 0);
        await sleep(30); // let the screen update before the busy work
        const P = prepare(src, kind);
        onStep('clean', 1);
        check();
        let data;
        const words = [];
        try {
            for (let i = 0; i < P.rects.length; i++) {
                check();
                const one = P.rects.length === 1;
                ocrProgress = m => {
                    if (m.status === 'recognizing text') onStep('read', (i + (m.progress || 0)) / P.rects.length);
                    else if (m.status === 'retrying') onStep('retry', 0);
                    else if (/load|initializ/i.test(m.status || '')) onStep('load', m.progress || 0);
                };
                const r = P.rects[i], pad = 16;
                let pic = P.canvas, dx = 0, dy = 0;
                if (!one) {
                    pic = makeCanvas(r.width + pad * 2, r.height + pad * 2);
                    const g = pic.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, pic.width, pic.height);
                    g.drawImage(P.canvas, r.left, r.top, r.width, r.height, pad, pad, r.width, r.height);
                    dx = r.left - pad; dy = r.top - pad;
                }
                data = await recognize(pic, { tessedit_pageseg_mode: kind === 'receipt' ? '4' : '3', preserve_interword_spaces: '1' });
                const base = words.length ? words[words.length - 1].b + 1 : 0;
                const move = b => b && { x0: b.x0 + dx, y0: b.y0 + dy, x1: b.x1 + dx, y1: b.y1 + dy };
                for (const w of wordsOf(data.blocks)) words.push({ ...w, b: w.b + base, bbox: move(w.bbox), block: move(w.block), line: move(w.line) });
            }
        } catch (e) {
            ocrProgress = null;
            if (e.message === CANCELLED) throw e;
            const quick = await browserReader(src); // offline the first time: the browser's own reader, where there is one
            if (quick.trim()) return plainResult(quick);
            throw e;
        }
        ocrProgress = null;
        if (window.__scanDebug) window.__scanDebug = { words: words.map(w => [w.text, Math.round(w.conf), w.b, w.p, w.l, w.bbox.x0, w.bbox.y0, w.bbox.x1, w.bbox.y1]), rects: P.rects, angle: P.angle, lineH: P.lineH, W: P.W, H: P.H };
        check();
        await relines(P, words, check);
        await recheck(P, words, p => { check(); onStep('check', p); });
        return transcribe(P, words, kind);
    }

    document.addEventListener('click', e => { if (e.target.closest('[data-scan-note]')) scan(); });
    window.diaryScan = { scan, read: readPage, prepare, toText: r => domParas(htmlToNode(renderParas([r]))).join('\n\n') };
});
