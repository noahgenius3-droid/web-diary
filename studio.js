// Note Studio: everything that turns a note into something more.
//  • Smart Notes: "What do you want to create?" — note, voice, image, video, checklist, document, scan, templates
//  • Scan → Note: photograph handwriting, whiteboards, textbooks, receipts and documents into an editable note
//  • Note covers: every note gets a visual identity (emoji, subject, pages, last update)
//  • Smart Study Mode: flashcards, multiple choice, true/false, short answers, a revision summary, key terms — and mastery
//  • Playnote 2.0: a note played as pages — sections, an interactive concept map, a quick question, a mini quiz
//  • Create from Note: post, carousel, story, quiz, flashcards, Playnote, video script, thread — and Discover
//  • CORDIAL Discover: publish your best notes into public categories
//  • What's new: an animated tour of all of the above, shown once
// Study sets and Playnotes are built on this device from the note's own structure (definitions, headings, bold
// terms, key sentences). Nothing is sent anywhere, and no AI is involved.
document.addEventListener('DOMContentLoaded', () => {
    const app = window.diaryApp;
    if (!app) return;
    const social = window.diarySocial;
    const I = social && social.internals;
    const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const ic = (id, cls = '') => `<svg class="i${cls ? ` ${cls}` : ''}" aria-hidden="true"><use href="#${id}"/></svg>`;
    const shuffle = a => { const b = a.slice(); for (let i = b.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [b[i], b[j]] = [b[j], b[i]]; } return b; };
    const hash = str => { let h = 2166136261; for (const ch of String(str)) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); } return (h >>> 0).toString(36); };
    const toast = m => app.showToast(m);
    const noteById = id => app.getNotes().find(n => n.id === id);
    const plain = n => String(n.text || '').replace(/\r/g, '');
    const confetti = host => { if (window.diaryGamesFx && window.diaryGamesFx.confetti) window.diaryGamesFx.confetti(host); };

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
    // Reading a note: sections, definitions, key terms, key sentences
    // ======================================================================
    const STOP = new Set('the a an and or but if then so of to in on at for with by from as is are was were be been being it its this that these those there their they them we you your i me my our he she his her not no yes do does did can could should would will just also than into about over under more most less very much many such only own same other some any each both few all what which who whom whose when where why how up out off again once here'.split(' '));
    const DEF = /^(?:[-•*▪◦]\s*|\d+[.)]\s*)?([A-Za-z][A-Za-z0-9\s'’()/&-]{1,48}?)\s*(?::|–|—|=|\s-\s|\sis\s(?:an?\s|the\s)?|\sare\s|\smeans\s|\srefers to\s)\s*(.{4,240})$/;
    function parse(n) {
        const text = plain(n);
        const html = String(n.html || '');
        const headings = new Set([...html.matchAll(/<h[1-3][^>]*>(.*?)<\/h[1-3]>/gi)].map(m => m[1].replace(/<[^>]+>/g, '').trim()).filter(Boolean));
        const bold = [...html.matchAll(/<(?:b|strong)>(.*?)<\/(?:b|strong)>/gi)].map(m => m[1].replace(/<[^>]+>/g, '').trim()).filter(t => t && t.split(/\s+/).length <= 5);
        const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
        const sections = [];
        let cur = { title: '', lines: [] };
        for (const l of lines) {
            const isHead = headings.has(l) || (/:$/.test(l) && l.split(/\s+/).length <= 7) || (l.length <= 42 && /^[A-Z#]/.test(l) && !/[.!?,;]$/.test(l) && l.split(/\s+/).length <= 6 && !DEF.test(l));
            if (isHead) { if (cur.title || cur.lines.length) sections.push(cur); cur = { title: l.replace(/^#+\s*/, '').replace(/:$/, ''), lines: [] }; }
            else cur.lines.push(l.replace(/^[-•*▪◦]\s*/, ''));
        }
        if (cur.title || cur.lines.length) sections.push(cur);
        const terms = [];
        const seen = new Set();
        for (const l of lines) {
            const m = l.match(DEF);
            if (!m) continue;
            const term = m[1].trim().replace(/\s+/g, ' ');
            const def = m[2].trim().replace(/[.;]\s*$/, '');
            if (term.split(' ').length > 6 || def.split(' ').length < 2 || seen.has(term.toLowerCase())) continue;
            seen.add(term.toLowerCase());
            terms.push({ term, def });
        }
        const sentences = text.replace(/\n+/g, ' . ').split(/(?<=[.!?])\s+/).map(x => x.replace(/^[\s.]+/, '').trim()).filter(x => x.split(/\s+/).length >= 6 && x.split(/\s+/).length <= 40);
        // Bold words that aren't already defined get the sentence they appear in as their meaning
        for (const b of bold) {
            if (seen.has(b.toLowerCase())) continue;
            const sen = sentences.find(x => x.toLowerCase().includes(b.toLowerCase()));
            if (sen) { seen.add(b.toLowerCase()); terms.push({ term: b, def: sen.replace(/[.]$/, ''), loose: true }); }
        }
        // Words that matter here: frequent, long, not common
        const freq = new Map();
        text.toLowerCase().match(/[a-z][a-z’'-]{4,}/g)?.forEach(w => { if (!STOP.has(w)) freq.set(w, (freq.get(w) || 0) + 1); });
        const keywords = [...freq.entries()].sort((a, b) => b[1] - a[1] || b[0].length - a[0].length).slice(0, 24).map(([w]) => w);
        return { title: n.title || firstLine(text), sections, terms, sentences, keywords, words: (text.match(/\S+/g) || []).length };
    }
    const firstLine = t => (String(t).split('\n').find(l => l.trim()) || 'Untitled note').trim().slice(0, 80);

    // ======================================================================
    // Covers: a visual identity for each note
    // ======================================================================
    const SUBJECTS = [
        ['Biology', '🧬', 'green', /\b(biolog|cells?\b|organell|dna|genes?\b|photosynth|enzyme|mitosis|meiosis|protein|nucleus|ecosystem)/i],
        ['Chemistry', '⚗️', 'teal', /\b(chemi|atoms?\b|molecul|reaction|acids?\b|periodic|electron|compound)/i],
        ['Physics', '🧲', 'indigo', /\b(physics|force|velocity|newton|quantum|momentum|gravity|electric|magnet)/i],
        ['Maths', '📐', 'blue', /\b(math|algebra|equation|calculus|geometry|theorem|integral|fraction|probability)/i],
        ['History', '🏛️', 'amber', /\b(history|empire|century|dynasty|revolution|independence|colonial|ancient)/i],
        ['Literature', '📖', 'rose', /\b(novel|poem|poetry|literature|chapter|protagonist|author|stanza)/i],
        ['Faith', '🙏', 'violet', /\b(god|prayer|bible|faith|church|jesus|scripture|psalm|sermon|worship)/i],
        ['Business', '💼', 'slate', /\b(business|marketing|sales|revenue|startup|customer|strategy|profit|pitch)/i],
        ['Technology', '💻', 'cyan', /\b(code|coding|software|javascript|python|database|server|api\b|algorithm|frontend)/i],
        ['Meeting', '🗓️', 'slate', /\b(meeting|agenda|minutes|attendees|action items)/i],
        ['Recipe', '🍲', 'orange', /\b(recipe|ingredients|tbsp|tsp|bake|oven)\b/i],
        ['Travel', '✈️', 'sky', /\b(trip|travel|flight|hotel|itinerary|passport)/i],
        ['Health', '🩺', 'green', /\b(workout|exercise|diet|calories|doctor|symptom|sleep)/i],
        ['Money', '🧾', 'amber', /\b(receipt|subtotal|budget|expense|invoice|vat)\b/i],
        ['Ideas', '💡', 'yellow', /\b(idea|brainstorm|what if|concept)\b/i]
    ];
    const TYPES = {
        note: ['Note', '✍️'], voice: ['Voice note', '🎙️'], image: ['Image note', '📷'], video: ['Video note', '🎥'], checklist: ['Checklist', '✅'],
        document: ['Document', '📄'], scan: ['Scanned note', '🖨️'], study: ['Study notes', '📚'], journal: ['Journal', '📓'], idea: ['Idea', '💡'], meeting: ['Meeting notes', '🗓️']
    };
    const THEMES = ['indigo', 'violet', 'rose', 'orange', 'amber', 'yellow', 'green', 'teal', 'cyan', 'sky', 'blue', 'slate'];
    function lookOf(n) {
        const own = n.look || {};
        const title = n.title || '';
        const prefix = title.match(/^([A-Za-z][A-Za-z &]{2,24}):\s*\S/);
        const text = `${title} ${plain(n).slice(0, 1500)}`;
        const subj = SUBJECTS.find(x => x[3].test(text));
        const type = TYPES[n.ntype];
        const voice = (n.attachments || []).some(a => a.kind === 'audio');
        const subject = own.subject || (prefix ? prefix[1].trim() : subj ? subj[0] : type ? type[0] : voice ? 'Voice note' : n.kind && n.kind !== 'free' ? 'Journal' : 'Note');
        const emoji = own.emoji || (subj ? subj[1] : type ? type[1] : voice ? '🎙️' : n.kind && n.kind !== 'free' ? '📓' : '📝');
        const theme = own.theme || (subj ? subj[2] : THEMES[Math.abs(parseInt(hash(n.id || title), 36)) % THEMES.length]);
        return { emoji, subject, theme };
    }
    function ago(t) {
        const s = Math.max(0, (Date.now() - t) / 1000);
        if (s < 60) return 'just now';
        if (s < 3600) return `${Math.floor(s / 60)}m ago`;
        if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
        if (s < 86400 * 7) return `${Math.floor(s / 86400)}d ago`;
        return new Date(t).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
    }
    function pagesOf(n) { const words = (plain(n).match(/\S+/g) || []).length; return Math.max(1, Math.ceil(words / 250)); }
    function mastery(n) {
        const st = n.study;
        if (!st || !st.total) return null;
        const boxes = Object.values(st.boxes || {});
        const mastered = boxes.filter(b => b >= 3).length;
        const understood = boxes.filter(b => b >= 2).length;
        return { pct: Math.round((mastered / st.total) * 100), understood, total: st.total };
    }
    function cardBits(n) {
        const L = lookOf(n);
        const m = mastery(n);
        const pages = pagesOf(n);
        return {
            band: `<div class="mcard-cover th-${esc(L.theme)}" aria-hidden="true"><span class="mcc-emoji">${esc(L.emoji)}</span><span class="mcc-sub">${esc(L.subject)}</span></div>`,
            meta: `<span class="mcard-meta">${pages} ${pages === 1 ? 'page' : 'pages'} · Updated ${esc(ago(n.updatedAt || n.createdAt))}${m ? ` · <b>${m.pct}% mastered</b>` : ''}</span>`
        };
    }
    function coverPicker(n, fromEditor) {
        const L = lookOf(n);
        const EMOJI = ['📚', '🧬', '⚗️', '🧲', '📐', '🏛️', '📖', '🙏', '💼', '💻', '🎨', '💡', '🗓️', '✅', '🍲', '✈️', '🩺', '🧾', '🎵', '⚽', '🌱', '❤️', '⭐', '📝'];
        const dlg = sheet('st-cover', 'Note cover', `<div class="gm-card">${head(`${ic('i-cover')}Note cover`, 'Give this note its own look')}
            <div class="gm-body st-body">
                <div class="st-cover-preview th-${esc(L.theme)}"><span class="mcc-emoji">${esc(L.emoji)}</span><div><strong>${esc(n.title || 'Untitled note')}</strong><small>${esc(L.subject)} · ${pagesOf(n)} pages</small></div></div>
                <label class="st-field"><span>Subject</span><input type="text" maxlength="24" value="${esc(L.subject)}" data-subject></label>
                <p class="st-label">Emoji</p><div class="st-emoji">${EMOJI.map(e => `<button type="button" data-emoji="${e}" aria-pressed="${e === L.emoji}">${e}</button>`).join('')}</div>
                <p class="st-label">Colour</p><div class="st-themes">${THEMES.map(t => `<button type="button" class="th-${t}" data-theme="${t}" aria-pressed="${t === L.theme}" aria-label="${t}"></button>`).join('')}</div>
                <div class="st-row"><button type="button" class="ghost-btn" data-auto>Automatic</button><button type="button" class="primary-btn" data-save>Save cover</button></div>
            </div></div>`);
        let look = { ...L };
        const paint = () => {
            const p = dlg.querySelector('.st-cover-preview');
            p.className = `st-cover-preview th-${look.theme}`;
            p.querySelector('.mcc-emoji').textContent = look.emoji;
            p.querySelector('small').textContent = `${look.subject} · ${pagesOf(n)} pages`;
            dlg.querySelectorAll('[data-emoji]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.emoji === look.emoji)));
            dlg.querySelectorAll('[data-theme]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.theme === look.theme)));
        };
        const store = v => { if (fromEditor) app.setEditorLook(v); else app.updateNote(n.id, { look: v }); };
        dlg.addEventListener('input', e => { if (e.target.matches('[data-subject]')) { look.subject = e.target.value.trim() || 'Note'; paint(); } });
        dlg.addEventListener('click', e => {
            if (e.target.closest('[data-x]')) return dlg.close();
            const em = e.target.closest('[data-emoji]'); if (em) { look.emoji = em.dataset.emoji; paint(); }
            const th = e.target.closest('[data-theme]'); if (th) { look.theme = th.dataset.theme; paint(); }
            if (e.target.closest('[data-auto]')) { store(null); dlg.close(); toast('Cover set to automatic'); }
            if (e.target.closest('[data-save]')) { store({ emoji: look.emoji, subject: look.subject.slice(0, 24), theme: look.theme }); dlg.close(); toast('Cover saved'); }
        });
    }

    // ======================================================================
    // Study sets: flashcards, questions, a summary and key terms
    // ======================================================================
    function studySet(n) {
        const P = parse(n);
        const cards = [];
        P.terms.forEach(t => cards.push({ id: `t:${hash(t.term.toLowerCase())}`, front: t.term, back: t.def, term: t.term }));
        // Few definitions: fill-in-the-blank cards from the key sentences
        if (cards.length < 6) {
            const used = new Set(cards.map(c => c.term.toLowerCase()));
            for (const s of P.sentences) {
                if (cards.length >= 14) break;
                const word = P.keywords.find(k => !used.has(k) && new RegExp(`\\b${k}\\b`, 'i').test(s)) || (s.match(/[A-Za-z]{7,}/) || [])[0];
                if (!word) continue;
                used.add(word.toLowerCase());
                cards.push({ id: `c:${hash(s)}`, front: s.replace(new RegExp(`\\b${word}\\b`, 'i'), '_____'), back: word, term: word, cloze: true });
            }
        }
        const others = (c, key) => shuffle(cards.filter(x => x !== c).map(x => x[key])).filter((v, i, a) => a.indexOf(v) === i && v !== c[key]).slice(0, 3);
        const questions = [];
        cards.forEach((c, i) => {
            if (c.cloze) {
                const opts = others(c, 'back');
                if (opts.length >= 2) questions.push({ id: c.id, type: 'mcq', q: `Fill the gap: ${c.front}`, options: shuffle([c.back, ...opts]), answer: c.back });
                questions.push({ id: c.id, type: 'short', q: `What word completes this? ${c.front}`, answer: c.back });
                return;
            }
            const defs = others(c, 'back');
            if (defs.length >= 2) questions.push({ id: c.id, type: 'mcq', q: `Which best describes “${c.term}”?`, options: shuffle([c.back, ...defs]), answer: c.back });
            const terms = others(c, 'term');
            if (terms.length >= 2 && i % 2) questions.push({ id: c.id, type: 'mcq', q: `Which term means: “${c.back}”?`, options: shuffle([c.term, ...terms]), answer: c.term });
            const wrong = defs[0];
            const truth = !wrong || Math.random() < 0.5;
            questions.push({ id: c.id, type: 'tf', q: `True or false: ${c.term} — ${truth ? c.back : wrong}`, answer: truth ? 'True' : 'False', fix: truth ? null : c.back });
            questions.push({ id: c.id, type: 'short', q: `In your own words, what is ${c.term}?`, answer: c.back });
        });
        // A revision summary: each section's first point, or the most "keyword-rich" sentences
        const summary = P.sections.filter(s => s.lines.length).map(s => `${s.title ? `${s.title}: ` : ''}${s.lines[0]}`).slice(0, 8);
        if (summary.length < 3) {
            const score = s => P.keywords.reduce((a, k) => a + (s.toLowerCase().includes(k) ? 1 : 0), 0);
            P.sentences.slice().sort((a, b) => score(b) - score(a)).slice(0, 5).forEach(s => { if (!summary.includes(s)) summary.push(s); });
        }
        return { P, cards, questions, summary, terms: P.terms };
    }
    function boxesOf(n) { return { ...((n.study && n.study.boxes) || {}) }; }
    function record(nid, id, right, total) {
        const n = noteById(nid);
        if (!n) return;
        const boxes = boxesOf(n);
        boxes[id] = right ? Math.min(5, (boxes[id] || 0) + 1) : Math.max(0, (boxes[id] || 0) - 1);
        app.updateNote(nid, { study: { boxes, total, at: Date.now() } });
    }

    function openStudy(n, start = 'overview') {
        const set = studySet(n);
        if (!set.cards.length) return toast('Add a few lines to this note first — definitions like “Term: meaning” work best');
        const total = set.cards.length;
        const dlg = sheet('st-study', `Study ${n.title || 'note'}`, `<div class="gm-card">${head(`📚 Study mode`, esc(n.title || 'Untitled note'))}
            <div class="st-tabs" role="tablist">${[['overview', 'Overview'], ['flash', 'Flashcards'], ['quiz', 'Quiz'], ['summary', 'Summary'], ['terms', 'Key terms']].map(([k, l]) => `<button type="button" role="tab" data-tab="${k}">${l}</button>`).join('')}</div>
            <div class="gm-body st-body" data-pane></div></div>`);
        const S = { tab: start, fi: 0, flip: false, order: null, qi: 0, score: 0, qs: null, answered: false };
        const pane = dlg.querySelector('[data-pane]');
        const live = () => noteById(n.id) || n;
        const paint = () => {
            dlg.querySelectorAll('[data-tab]').forEach(b => b.setAttribute('aria-selected', String(b.dataset.tab === S.tab)));
            const boxes = boxesOf(live());
            const m = mastery({ study: { boxes, total } }) || { pct: 0, understood: 0, total };
            if (S.tab === 'overview') {
                pane.innerHTML = `
                    <div class="st-ring" style="--p:${m.pct}"><div><strong>${m.pct}%</strong><small>mastered</small></div></div>
                    <p class="st-big">${esc(n.title || 'Your note')}</p>
                    <p class="st-muted">${m.understood}/${total} concepts understood</p>
                    <div class="st-row"><button type="button" class="primary-btn" data-go="flash">Flashcards</button><button type="button" class="ghost-btn" data-go="quiz">Take the quiz</button></div>
                    <div class="st-stats"><span><b>${total}</b>flashcards</span><span><b>${set.questions.length}</b>questions</span><span><b>${set.terms.length}</b>key terms</span></div>
                    ${set.P.terms.length < 3 ? '<p class="st-tip">Tip: write definitions as “Term: meaning” (or make terms bold) and Study mode can make better cards.</p>' : ''}`;
            } else if (S.tab === 'flash') {
                if (!S.order) S.order = set.cards.slice().sort((a, b) => (boxes[a.id] || 0) - (boxes[b.id] || 0));
                const c = S.order[S.fi % S.order.length];
                pane.innerHTML = `
                    <p class="st-muted">${(S.fi % S.order.length) + 1} of ${S.order.length} · box ${boxes[c.id] || 0}/5</p>
                    <button type="button" class="st-flash${S.flip ? ' flipped' : ''}" data-flip aria-label="Flip the card">
                        <span class="st-face front"><small>${c.cloze ? 'Fill the gap' : 'Term'}</small><strong>${esc(c.front)}</strong><em>Tap to flip</em></span>
                        <span class="st-face back"><small>${c.cloze ? 'Answer' : 'Meaning'}</small><strong>${esc(c.back)}</strong></span>
                    </button>
                    <div class="st-row"><button type="button" class="ghost-btn" data-card="again">Again</button><button type="button" class="primary-btn" data-card="got">Got it ✓</button></div>`;
            } else if (S.tab === 'quiz') {
                if (!S.qs) { S.qs = shuffle(set.questions).slice(0, Math.min(10, set.questions.length)); S.qi = 0; S.score = 0; S.answered = false; }
                if (S.qi >= S.qs.length) {
                    const pct = Math.round((S.score / S.qs.length) * 100);
                    pane.innerHTML = `<div class="st-done"><span>${pct >= 70 ? '🏆' : '💪'}</span><strong>${S.score} / ${S.qs.length}</strong><p>${pct >= 70 ? 'Brilliant — you know this.' : 'Good effort — try the flashcards, then again.'}</p>
                        <div class="st-row"><button type="button" class="ghost-btn" data-go="flash">Flashcards</button><button type="button" class="primary-btn" data-again>New quiz</button></div></div>`;
                    if (pct >= 70) confetti(pane);
                    return;
                }
                const q = S.qs[S.qi];
                const opts = q.type === 'tf' ? ['True', 'False'] : q.options;
                pane.innerHTML = `
                    <p class="st-muted">Question ${S.qi + 1} of ${S.qs.length} · ${q.type === 'mcq' ? 'Multiple choice' : q.type === 'tf' ? 'True or false' : 'Short answer'}</p>
                    <p class="st-q">${esc(q.q)}</p>
                    ${q.type === 'short'
                        ? `<textarea class="st-answer" rows="3" placeholder="Type your answer…" aria-label="Your answer"></textarea>
                           <div class="st-reveal" hidden><small>Model answer</small><p>${esc(q.answer)}</p><div class="st-row"><button type="button" class="ghost-btn" data-self="0">I missed it</button><button type="button" class="primary-btn" data-self="1">I got it</button></div></div>
                           <button type="button" class="primary-btn" data-check>Check</button>`
                        : `<div class="st-opts">${opts.map(o => `<button type="button" class="st-opt" data-opt="${esc(o)}">${esc(o)}</button>`).join('')}</div><p class="st-feedback" aria-live="polite"></p>`}
                    <button type="button" class="ghost-btn st-next" data-next hidden>Next →</button>`;
            } else if (S.tab === 'summary') {
                pane.innerHTML = `<div class="st-summary"><p class="st-label">Revision summary</p><ul>${set.summary.map(x => `<li>${esc(x)}</li>`).join('')}</ul></div>`;
            } else {
                pane.innerHTML = set.terms.length ? `<dl class="st-terms">${set.terms.map(t => `<div><dt>${esc(t.term)}${(boxes[`t:${hash(t.term.toLowerCase())}`] || 0) >= 3 ? ' <span class="st-ok">✓</span>' : ''}</dt><dd>${esc(t.def)}</dd></div>`).join('')}</dl>`
                    : `<p class="st-muted">No definitions found yet. Key words in this note: ${set.P.keywords.slice(0, 12).map(esc).join(', ')}</p>`;
            }
        };
        dlg.addEventListener('click', e => {
            if (e.target.closest('[data-x]')) return dlg.close();
            const t = e.target.closest('[data-tab]'); if (t) { S.tab = t.dataset.tab; S.flip = false; return paint(); }
            const go = e.target.closest('[data-go]'); if (go) { S.tab = go.dataset.go; S.flip = false; return paint(); }
            if (e.target.closest('[data-flip]')) { S.flip = !S.flip; return dlg.querySelector('.st-flash').classList.toggle('flipped', S.flip); }
            const cb = e.target.closest('[data-card]');
            if (cb) { const c = S.order[S.fi % S.order.length]; record(n.id, c.id, cb.dataset.card === 'got', total); S.fi += 1; S.flip = false; return paint(); }
            if (e.target.closest('[data-again]')) { S.qs = null; return paint(); }
            const q = S.qs && S.qs[S.qi];
            const opt = e.target.closest('[data-opt]');
            if (opt && q && !S.answered) {
                S.answered = true;
                const right = opt.dataset.opt === q.answer;
                if (right) S.score += 1;
                record(n.id, q.id, right, total);
                dlg.querySelectorAll('.st-opt').forEach(b => { b.disabled = true; if (b.dataset.opt === q.answer) b.classList.add('right'); });
                if (!right) opt.classList.add('wrong');
                dlg.querySelector('.st-feedback').textContent = right ? 'Correct!' : q.fix ? `Not quite — it’s: ${q.fix}` : `Not quite — the answer is: ${q.answer}`;
                dlg.querySelector('[data-next]').hidden = false;
            }
            if (e.target.closest('[data-check]')) { dlg.querySelector('.st-reveal').hidden = false; e.target.closest('[data-check]').hidden = true; }
            const self = e.target.closest('[data-self]');
            if (self && q && !S.answered) { S.answered = true; const right = self.dataset.self === '1'; if (right) S.score += 1; record(n.id, q.id, right, total); S.qi += 1; S.answered = false; return paint(); }
            if (e.target.closest('[data-next]')) { S.qi += 1; S.answered = false; return paint(); }
        });
        paint();
    }

    // ======================================================================
    // Playnote 2.0: the note as an interactive experience
    // ======================================================================
    function playnote(n) {
        const set = studySet(n);
        const P = set.P;
        const L = lookOf(n);
        if (!P.words) return toast('Write something first — then press play');
        const pages = [{ kind: 'cover' }];
        const sections = P.sections.length ? P.sections : [{ title: P.title, lines: plain(n).split('\n').filter(Boolean) }];
        sections.slice(0, 8).forEach((s, i) => {
            for (let k = 0; k < Math.max(1, Math.ceil(s.lines.length / 5)); k++) pages.push({ kind: 'section', s, lines: s.lines.slice(k * 5, k * 5 + 5) });
            if (i === 0 && set.questions.some(q => q.type === 'mcq')) pages.push({ kind: 'question' });
        });
        if (set.terms.length >= 3) pages.splice(Math.min(3, pages.length), 0, { kind: 'map' });
        if (set.questions.length >= 3) pages.push({ kind: 'quiz' });
        pages.push({ kind: 'end' });
        const quizQs = shuffle(set.questions.filter(q => q.type !== 'short')).slice(0, 3);
        const quick = set.questions.find(q => q.type === 'mcq');
        const S = { i: 0, quiz: 0, qi: 0, answered: false, tapped: null };
        const dlg = sheet('pn2', `Playnote: ${n.title || 'note'}`, `<div class="gm-card pn2-card th-${esc(L.theme)}">
            <div class="pn2-bar">${pages.map(() => '<i><b></b></i>').join('')}</div>
            <header class="pn2-head"><span>▶️ Playnote</span><button type="button" class="icon-btn" data-x aria-label="Close">${ic('i-close')}</button></header>
            <div class="pn2-page" aria-live="polite"></div>
            <div class="pn2-nav"><button type="button" class="icon-btn" data-prev aria-label="Previous page">${ic('i-back')}</button><span class="pn2-n"></span><button type="button" class="icon-btn" data-next aria-label="Next page">${ic('i-forward')}</button></div>
        </div>`);
        const page = dlg.querySelector('.pn2-page');
        const termRe = set.terms.length ? new RegExp(`\\b(${set.terms.map(t => t.term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).sort((a, b) => b.length - a.length).join('|')})\\b`, 'gi') : null;
        const withTerms = line => { const e = esc(line); return termRe ? e.replace(termRe, m => `<button type="button" class="pn2-term" data-term="${esc(m)}">${m}</button>`) : e; };
        const defOf = t => (set.terms.find(x => x.term.toLowerCase() === t.toLowerCase()) || {}).def || '';
        const qHTML = (q, label) => `<p class="pn2-kicker">${label}</p><p class="pn2-q">${esc(q.q)}</p><div class="st-opts">${(q.type === 'tf' ? ['True', 'False'] : q.options).map(o => `<button type="button" class="st-opt" data-pn-opt="${esc(o)}">${esc(o)}</button>`).join('')}</div><p class="st-feedback" aria-live="polite"></p>`;
        const paint = () => {
            const p = pages[S.i];
            dlg.querySelectorAll('.pn2-bar i b').forEach((b, k) => { b.style.transform = `scaleX(${k <= S.i ? 1 : 0})`; });
            dlg.querySelector('.pn2-n').textContent = `Page ${S.i + 1} of ${pages.length}`;
            dlg.querySelector('[data-prev]').disabled = S.i === 0;
            dlg.querySelector('[data-next]').disabled = S.i === pages.length - 1;
            S.answered = false;
            page.className = `pn2-page k-${p.kind}`;
            if (p.kind === 'cover') page.innerHTML = `<span class="pn2-emoji">${esc(L.emoji)}</span><p class="pn2-kicker">${esc(L.subject)}</p><h2>${esc(P.title)}</h2><p class="pn2-sub">${pages.length} pages · tap → to begin</p>`;
            else if (p.kind === 'section') page.innerHTML = `<p class="pn2-kicker">${esc(L.subject)}</p><h2>${esc(p.s.title || P.title)}</h2><ul>${p.lines.map(l => `<li>${withTerms(l)}</li>`).join('')}</ul>${termRe ? '<p class="pn2-hint">Tap a highlighted word to see what it means</p>' : ''}<div class="pn2-def" hidden></div>`;
            else if (p.kind === 'map') {
                const ts = set.terms.slice(0, 8);
                page.innerHTML = `<p class="pn2-kicker">Interactive diagram</p><h2>How it fits together</h2>
                    <div class="pn2-map"><span class="pn2-hub">${esc(L.emoji)} ${esc(P.title.slice(0, 28))}</span>${ts.map((t, k) => { const a = (k / ts.length) * Math.PI * 2 - Math.PI / 2; return `<button type="button" class="pn2-node" style="left:${50 + Math.cos(a) * 38}%;top:${50 + Math.sin(a) * 38}%;--a:${a}rad" data-term="${esc(t.term)}">${esc(t.term)}</button>`; }).join('')}
                    <svg class="pn2-lines" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">${ts.map((t, k) => { const a = (k / ts.length) * Math.PI * 2 - Math.PI / 2; return `<line x1="50" y1="50" x2="${50 + Math.cos(a) * 38}" y2="${50 + Math.sin(a) * 38}"/>`; }).join('')}</svg></div>
                    <div class="pn2-def" hidden></div>`;
            } else if (p.kind === 'question') page.innerHTML = qHTML(quick, 'Quick question');
            else if (p.kind === 'quiz') {
                if (S.qi >= quizQs.length) { page.innerHTML = `<span class="pn2-emoji">${S.quiz >= 2 ? '🏆' : '💪'}</span><h2>${S.quiz} / ${quizQs.length}</h2><p class="pn2-sub">${S.quiz >= 2 ? 'You nailed it!' : 'Keep going — Study mode will help.'}</p>`; if (S.quiz >= 2) confetti(page); }
                else page.innerHTML = qHTML(quizQs[S.qi], `Mini quiz · ${S.qi + 1} of ${quizQs.length}`);
            } else page.innerHTML = `<span class="pn2-emoji">🎉</span><h2>That’s the note!</h2><div class="st-row"><button type="button" class="primary-btn" data-study>Study it</button><button type="button" class="ghost-btn" data-replay>Play again</button></div>`;
        };
        const go = d => { const next = S.i + d; if (next < 0 || next >= pages.length) return; if (pages[S.i].kind === 'quiz' && d > 0 && S.qi < quizQs.length) return toast('Answer the quiz first'); S.i = next; paint(); };
        dlg.addEventListener('click', e => {
            if (e.target.closest('[data-x]')) return dlg.close();
            if (e.target.closest('[data-prev]')) return go(-1);
            if (e.target.closest('[data-next]')) return go(1);
            if (e.target.closest('[data-study]')) { dlg.close(); return openStudy(noteById(n.id) || n); }
            if (e.target.closest('[data-replay]')) { S.i = 0; S.qi = 0; S.quiz = 0; return paint(); }
            const term = e.target.closest('[data-term]');
            if (term) { const d = page.querySelector('.pn2-def'); d.hidden = false; d.innerHTML = `<strong>${esc(term.dataset.term)}</strong><span>${esc(defOf(term.dataset.term))}</span>`; page.querySelectorAll('[data-term]').forEach(x => x.classList.toggle('on', x === term)); return; }
            const opt = e.target.closest('[data-pn-opt]');
            if (opt && !S.answered) {
                const p = pages[S.i];
                const q = p.kind === 'quiz' ? quizQs[S.qi] : quick;
                S.answered = true;
                const right = opt.dataset.pnOpt === q.answer;
                record(n.id, q.id, right, set.cards.length);
                page.querySelectorAll('[data-pn-opt]').forEach(b => { b.disabled = true; if (b.dataset.pnOpt === q.answer) b.classList.add('right'); });
                if (!right) opt.classList.add('wrong');
                page.querySelector('.st-feedback').textContent = right ? 'Correct! 🎉' : `The answer is: ${q.answer}`;
                if (p.kind === 'quiz') { if (right) S.quiz += 1; setTimeout(() => { S.qi += 1; paint(); }, 1100); }
            }
        });
        dlg.addEventListener('keydown', e => { if (e.key === 'ArrowRight') go(1); if (e.key === 'ArrowLeft') go(-1); });
        let sx = null;
        page.addEventListener('pointerdown', e => { sx = e.clientX; });
        page.addEventListener('pointerup', e => { if (sx !== null && Math.abs(e.clientX - sx) > 50) go(e.clientX < sx ? 1 : -1); sx = null; });
        paint();
    }

    // ======================================================================
    // Create from Note
    // ======================================================================
    function createFrom(n) {
        const items = [
            ['post', '📝', 'Post', 'Share it on your Feed'], ['carousel', '🖼️', 'Carousel', 'Slides you can swipe'], ['story', '⭕', 'Story', 'For 24 hours'],
            ['quiz', '❓', 'Quiz', 'Test yourself or friends'], ['flash', '🃏', 'Flashcards', 'Flip and learn'], ['play', '▶️', 'Playnote', 'An interactive experience'],
            ['script', '🎬', 'Video script', 'Hook, scenes, outro'], ['thread', '🧵', 'Thread', 'Numbered posts'], ['video', '🎥', 'Video', 'An animated reel'], ['discover', '🌐', 'Discover', 'Publish to everyone']
        ];
        const dlg = sheet('st-create', 'Create from note', `<div class="gm-card">${head(`${ic('i-sparkle')}Create from note`, esc(n.title || 'Untitled note'))}
            <div class="gm-body st-body"><div class="st-grid">${items.map(([k, e, l, s]) => `<button type="button" class="st-tile" data-make="${k}"><span>${e}</span><strong>${l}</strong><small>${s}</small></button>`).join('')}</div></div></div>`);
        dlg.addEventListener('click', async e => {
            if (e.target.closest('[data-x]')) return dlg.close();
            const b = e.target.closest('[data-make]');
            if (!b) return;
            const k = b.dataset.make;
            const text = plain(n);
            dlg.close();
            if (k === 'post') return app.openShare(n.id);
            if (k === 'carousel') return window.diaryNoteSlides ? window.diaryNoteSlides.open({ title: n.title, text, color: n.color, createdAt: n.createdAt }) : toast('Slides aren’t available');
            if (k === 'story') return window.diaryStories && window.diaryStories.shareText ? window.diaryStories.shareText([n.title, text].filter(Boolean).join(' — ').slice(0, 500), n.color) : toast('Sign in to post a story');
            if (k === 'quiz') return openStudy(n, 'quiz');
            if (k === 'flash') return openStudy(n, 'flash');
            if (k === 'play') return playnote(n);
            if (k === 'video') return window.diaryNoteMedia ? window.diaryNoteMedia.open({ title: n.title, text, color: n.color, createdAt: n.createdAt }) : null;
            if (k === 'script') return videoScript(n);
            if (k === 'thread') return thread(n);
            if (k === 'discover') return publish(n);
        });
    }
    async function videoScript(n) {
        const P = parse(n);
        const secs = (P.sections.length ? P.sections : [{ title: P.title, lines: P.sentences.slice(0, 6) }]).slice(0, 5);
        const hook = P.terms[0] ? `Ever wondered what ${P.terms[0].term} really is?` : `Here’s everything you need to know about ${P.title} — in under a minute.`;
        const html = [`<h2>🎬 ${esc(P.title)}</h2>`, `<p><b>HOOK (0:00–0:05)</b><br>${esc(hook)}</p>`,
            ...secs.map((s, i) => `<p><b>SCENE ${i + 1}${s.title ? ` — ${esc(s.title)}` : ''}</b><br>🎙️ ${esc(s.lines.slice(0, 2).join(' '))}<br>🖼️ On screen: ${esc((P.terms.find(t => s.lines.join(' ').toLowerCase().includes(t.term.toLowerCase())) || {}).term || s.title || P.title)}</p>`),
            `<p><b>OUTRO</b><br>That’s ${esc(P.title)} in a nutshell. Follow for more, and save this for revision! ✨</p>`].join('');
        const made = await app.createEntry({ title: `Video script: ${P.title}`.slice(0, 120), html });
        app.updateNote(made.id, { look: { emoji: '🎬', subject: 'Video script', theme: 'rose' } });
        toast('Video script created — it’s in your notes');
        app.openNote(made.id);
    }
    function thread(n) {
        const P = parse(n);
        const pieces = [`${P.title} 🧵`];
        let buf = '';
        for (const s of plain(n).split(/\n+|(?<=[.!?])\s+/).map(x => x.trim()).filter(Boolean)) {
            if ((buf + ' ' + s).trim().length > 250) { if (buf) pieces.push(buf.trim()); buf = s; } else buf = `${buf} ${s}`;
        }
        if (buf.trim()) pieces.push(buf.trim());
        const parts = pieces.slice(0, 12).map((p, i, a) => `${i + 1}/${a.length} ${p}`);
        const dlg = sheet('st-thread', 'Thread', `<div class="gm-card">${head('🧵 Thread', `${parts.length} parts`)}
            <div class="gm-body st-body"><ol class="st-thread">${parts.map(p => `<li>${esc(p)}</li>`).join('')}</ol>
            <div class="st-row"><button type="button" class="ghost-btn" data-copy>Copy all</button><button type="button" class="primary-btn" data-post>Post to Feed</button></div></div></div>`);
        dlg.addEventListener('click', async e => {
            if (e.target.closest('[data-x]')) return dlg.close();
            if (e.target.closest('[data-copy]')) { try { await navigator.clipboard.writeText(parts.join('\n\n')); toast('Thread copied'); } catch (err) { toast('Couldn’t copy'); } }
            if (e.target.closest('[data-post]')) {
                if (!social || !social.isSignedIn || !social.isSignedIn()) return social && social.requireSignIn ? social.requireSignIn('Sign in to post a thread.') : null;
                await app.createEntry({ text: parts.join('\n\n'), shared: true, origin: 'post' });
                dlg.close();
                toast('Thread posted to your Feed 🧵');
            }
        });
    }

    // ======================================================================
    // CORDIAL Discover: a public library of great notes
    // ======================================================================
    const CATS = [['education', '📚', 'Education'], ['business', '💼', 'Business'], ['technology', '💻', 'Technology'], ['faith', '🙏', 'Faith'], ['creativity', '🎨', 'Creativity'], ['ideas', '💡', 'Ideas'], ['literature', '📖', 'Literature'], ['science', '🔬', 'Science']];
    function publish(n) {
        if (!social || !social.isSignedIn || !social.isSignedIn()) return social && social.requireSignIn ? social.requireSignIn('Sign in to publish on Discover.') : toast('Sign in to publish');
        if (n.private) return toast('This note is private — make it un-private first');
        const L = lookOf(n);
        const guess = (CATS.find(c => c[2].toLowerCase() === L.subject.toLowerCase()) || (/(biolog|chemi|physic)/i.test(L.subject) ? CATS[7] : /(maths|history)/i.test(L.subject) ? CATS[0] : CATS[0]))[0];
        const dlg = sheet('st-publish', 'Publish to Discover', `<div class="gm-card">${head('🌐 Publish to Discover', 'Everyone on Cordial can find it')}
            <div class="gm-body st-body">
                <div class="st-cover-preview th-${esc(L.theme)}"><span class="mcc-emoji">${esc(L.emoji)}</span><div><strong>${esc(n.title || 'Untitled note')}</strong><small>${pagesOf(n)} pages</small></div></div>
                <p class="st-label">Category</p><div class="st-cats">${CATS.map(([k, e, l]) => `<button type="button" data-cat="${k}" aria-pressed="${k === guess}">${e} ${l}</button>`).join('')}</div>
                <p class="st-tip">Publishing shares this note publicly on the Feed and in Discover, tagged #Discover and its category. You can stop sharing any time from the note’s Share menu.</p>
                <div class="st-row"><button type="button" class="primary-btn" data-pub>Publish</button></div></div></div>`);
        let cat = guess;
        dlg.addEventListener('click', e => {
            if (e.target.closest('[data-x]')) return dlg.close();
            const c = e.target.closest('[data-cat]'); if (c) { cat = c.dataset.cat; dlg.querySelectorAll('[data-cat]').forEach(b => b.setAttribute('aria-pressed', String(b === c))); }
            if (e.target.closest('[data-pub]')) {
                const label = CATS.find(x => x[0] === cat)[2];
                const tags = `#Discover #${label}`;
                const cur = noteById(n.id) || n;
                const clean = String(cur.html || '').replace(/<p>#Discover #\w+<\/p>/g, '');
                app.updateNote(n.id, { html: `${clean}<p>${tags}</p>`, text: `${plain(cur).replace(/\n?#Discover #\w+\s*$/, '')}\n${tags}`, shared: true, audience: 'public' });
                dlg.close();
                toast(`Published to Discover · ${label} 🌐`);
            }
        });
    }
    const D = { cat: 'all', list: null, loading: false };
    async function loadDiscover() {
        if (D.loading || !I) return;
        D.loading = true;
        try {
            const { data } = await I.client.from('diary_shared_entries').select(I.FEED_SELECT).eq('audience', 'public').ilike('body', '%#Discover%').order('shared_at', { ascending: false }).limit(80);
            D.list = data || [];
        } catch (e) { D.list = []; }
        D.loading = false;
        if (app.state.view === 'discover') app.render();
    }
    app.views.discover = () => {
        app.setTitle('Discover');
        if (!I) return '<div class="empty"><p class="empty-title">Discover needs an account</p></div>';
        if (D.list === null) { loadDiscover(); }
        const catOf = p => (CATS.find(c => new RegExp(`#${c[2]}\\b`, 'i').test(p.body || '')) || [])[0];
        const list = (D.list || []).filter(p => D.cat === 'all' || catOf(p) === D.cat);
        return `
            <div class="dsc">
                <header class="dsc-hero"><span aria-hidden="true">🌐</span><div><h2>CORDIAL Discover</h2><p>The best notes, shared by the community</p></div></header>
                <div class="ex-cats" role="tablist" aria-label="Categories"><button type="button" class="ex-cat" role="tab" aria-selected="${D.cat === 'all'}" data-dsc="all">All</button>${CATS.map(([k, e, l]) => `<button type="button" class="ex-cat" role="tab" aria-selected="${D.cat === k}" data-dsc="${k}">${e} ${l}</button>`).join('')}</div>
                ${D.list === null ? '<div class="dsc-grid">' + '<span class="dsc-card skel"></span>'.repeat(4) + '</div>'
                    : list.length ? `<div class="dsc-grid">${list.map(p => {
                        const c = CATS.find(x => x[0] === catOf(p)) || CATS[0];
                        const who = p.author_profile || {};
                        const body = String(p.body || '').replace(/#Discover #\w+/g, '').trim();
                        return `<button type="button" class="dsc-card" data-action="open-entry-id" data-id="${esc(p.id)}"><span class="dsc-cover th-${esc(['indigo', 'slate', 'cyan', 'violet', 'rose', 'yellow', 'amber', 'green'][CATS.indexOf(c)])}"><b>${c[1]}</b><small>${c[2]}</small></span>
                            <strong>${esc(p.title || body.split('\n')[0].slice(0, 70) || 'A note')}</strong><span class="dsc-snip">${esc(body.slice(0, 140))}</span><small class="dsc-by">by ${esc(who.display_name || 'someone')} · ${(p.likes || []).length} ♥</small></button>`;
                    }).join('')}</div>`
                    : `<div class="chat-onboard gx-empty"><span class="chat-onboard-ic" aria-hidden="true">📚</span><strong>Nothing here yet</strong><span>Be the first — open a note, tap Create → Discover.</span></div>`}
            </div>`;
    };
    app.actions['open-entry-id'] = el => I && I.openEntry && I.openEntry(el.dataset.id);
    document.addEventListener('click', e => {
        const c = e.target.closest('[data-dsc]');
        if (c) { D.cat = c.dataset.dsc; app.render(); }
    });

    // ======================================================================
    // Smart Notes: "What do you want to create?"
    // ======================================================================
    const TEMPLATES = {
        study: { title: 'Topic: ', html: '<h2>Overview</h2><p></p><h3>Key terms</h3><ul><li><b>Term</b>: what it means</li></ul><h3>Summary</h3><p></p>', look: null },
        journal: { title: '', html: '<p></p>', kind: 'evening' },
        idea: { title: '💡 ', html: '<h3>The idea</h3><p></p><h3>Why it matters</h3><p></p><h3>Next steps</h3><ul><li></li></ul>' },
        meeting: { title: `Meeting — ${new Date().toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}`, html: '<h3>Attendees</h3><p></p><h3>Agenda</h3><ul><li></li></ul><h3>Notes</h3><p></p><h3>Action items</h3><ul><li></li></ul>' }
    };
    function createSheet() {
        const dlg = sheet('st-new', 'What do you want to create?', `<div class="gm-card">${head('What do you want to create?', '')}
            <div class="gm-body st-body">
                <div class="st-grid">${[['note', '✍️', 'Note'], ['voice', '🎙️', 'Voice'], ['image', '📷', 'Image'], ['video', '🎥', 'Video'], ['checklist', '✅', 'Checklist'], ['document', '📄', 'Document']].map(([k, e, l]) => `<button type="button" class="st-tile big" data-new="${k}"><span>${e}</span><strong>${l}</strong></button>`).join('')}</div>
                <button type="button" class="st-scan" data-new="scan"><span>🖨️</span><div><strong>Scan → Note</strong><small>Handwriting, whiteboards, textbooks, receipts, documents</small></div>${ic('i-forward')}</button>
                <p class="st-label">Start from</p>
                <div class="st-grid four">${[['study', '📚', 'Study notes'], ['journal', '📓', 'Journal'], ['idea', '💡', 'Idea'], ['meeting', '🗓️', 'Meeting']].map(([k, e, l]) => `<button type="button" class="st-tile" data-new="${k}"><span>${e}</span><strong>${l}</strong></button>`).join('')}</div>
            </div></div>`);
        dlg.addEventListener('click', async e => {
            if (e.target.closest('[data-x]')) return dlg.close();
            const b = e.target.closest('[data-new]');
            if (!b) return;
            const k = b.dataset.new;
            dlg.close();
            if (k === 'note') return app.newNote({});
            if (k === 'voice') return window.diaryTranscribe ? window.diaryTranscribe.open() : (app.newNote({ ntype: 'voice' }), setTimeout(() => app.recordVoiceInEditor(), 350));
            if (k === 'checklist') return app.newNote({ ntype: 'checklist', showGoals: true, goals: [{ id: Math.random().toString(36).slice(2, 10), text: '', done: false }] });
            if (k === 'scan') return scan();
            if (TEMPLATES[k]) { const t = TEMPLATES[k]; return app.newNote({ title: t.title, html: t.html, kind: t.kind, ntype: k }); }
            const accept = { image: 'image/*', video: 'video/*', document: '.pdf,.doc,.docx,.txt,.ppt,.pptx,.xls,.xlsx,application/pdf' }[k];
            const files = await Media.pickFiles(accept, k !== 'video');
            if (!files.length) return;
            const made = await app.createEntry({ title: k === 'document' ? files[0].name.replace(/\.[^.]+$/, '') : '' }, files);
            app.updateNote(made.id, { ntype: k });
            app.openNote(made.id);
        });
    }

    // ======================================================================
    // Scan → Note
    // ======================================================================
    const SCAN_KINDS = [['handwritten', '✍️', 'Handwritten'], ['whiteboard', '🧑‍🏫', 'Whiteboard'], ['textbook', '📘', 'Textbook'], ['receipt', '🧾', 'Receipt'], ['document', '📄', 'Document']];
    const canRead = () => typeof window.diaryOCR === 'function' || 'TextDetector' in window;
    function scan({ into = false } = {}) {
        const S = { kind: 'document', pages: [] };
        const dlg = sheet('st-scan', 'Scan to note', `<div class="gm-card">${head('🖨️ Scan → Note', into ? 'Add a scanned page to this note' : 'Turn a photo into an editable note')}
            <div class="gm-body st-body">
                <p class="st-label">What are you scanning?</p>
                <div class="st-cats">${SCAN_KINDS.map(([k, e, l]) => `<button type="button" data-kind="${k}" aria-pressed="${k === S.kind}">${e} ${l}</button>`).join('')}</div>
                <div class="st-pages" data-pages></div>
                <div class="st-row"><button type="button" class="primary-btn" data-shot>${ic('i-camera')}Take a photo</button><button type="button" class="ghost-btn" data-pick>${ic('i-image')}From photos</button></div>
                ${canRead() ? '' : '<p class="st-tip">This browser can’t read text from photos yet, so your scans will be saved in the note as clean, enhanced pages you can read and type up. Text reading arrives on more devices soon.</p>'}
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
            if (e.target.closest('[data-shot]')) return add(await Media.pickFiles('image/*', false, 'environment'));
            if (e.target.closest('[data-pick]')) return add(await Media.pickFiles('image/*', true));
            const d = e.target.closest('[data-drop]'); if (d) { S.pages.splice(Number(d.dataset.drop), 1); return paintPages(); }
            const go = e.target.closest('[data-read]');
            if (!go) return;
            go.disabled = true;
            go.textContent = 'Reading…';
            const texts = [];
            for (const p of S.pages) texts.push(await readText(p.canvas));
            const text = texts.filter(Boolean).join('\n\n').trim();
            dlg.close();
            const kind = SCAN_KINDS.find(x => x[0] === S.kind);
            const body = S.kind === 'receipt' ? receiptHTML(text) : text.split(/\n{2,}/).map(par => `<p>${esc(par).replace(/\n/g, '<br>')}</p>`).join('');
            if (into) {
                const ed = document.getElementById('editor-body');
                if (!text) return toast('No text found on that page');
                if (ed) { ed.insertAdjacentHTML('beforeend', body); ed.dispatchEvent(new Event('input', { bubbles: true })); toast('Scanned text added'); }
                return;
            }
            const files = await Promise.all(S.pages.map((p, i) => new Promise(r => p.canvas.toBlob(b => r(new File([b], `scan-${i + 1}.jpg`, { type: 'image/jpeg' })), 'image/jpeg', 0.85))));
            const title = text ? text.split('\n').find(l => l.trim().length > 2)?.trim().slice(0, 80) || `${kind[2]} scan` : `${kind[2]} scan — ${new Date().toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}`;
            const made = await app.createEntry({ title, html: body || '<p></p>' }, files);
            app.updateNote(made.id, { ntype: 'scan', look: { emoji: kind[1], subject: `${kind[2]} scan`, theme: S.kind === 'receipt' ? 'amber' : 'slate' } });
            toast(text ? 'Scanned into a new note ✨ — check and edit the text' : 'Scan saved as a note');
            app.openNote(made.id);
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
        try {
            if (typeof window.diaryOCR === 'function') return String(await window.diaryOCR(canvas) || '');
            if ('TextDetector' in window) {
                const found = await new window.TextDetector().detect(canvas);
                const rows = found.map(t => ({ y: t.boundingBox.y, x: t.boundingBox.x, h: t.boundingBox.height, s: t.rawValue })).sort((a, b) => a.y - b.y || a.x - b.x);
                const lines = [];
                for (const r of rows) { const last = lines[lines.length - 1]; if (last && Math.abs(last.y - r.y) < r.h * 0.6) { last.parts.push(r); } else lines.push({ y: r.y, parts: [r] }); }
                return lines.map(l => l.parts.sort((a, b) => a.x - b.x).map(p => p.s).join(' ')).join('\n');
            }
        } catch (e) { /* fall back to saving the image */ }
        return '';
    }
    function receiptHTML(text) {
        if (!text) return '';
        const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
        const total = lines.slice().reverse().find(l => /\b(total|amount due|balance)\b/i.test(l));
        const items = lines.filter(l => /\d[.,]\d{2}\s*$/.test(l) && l !== total);
        return `${total ? `<h3>🧾 ${esc(total)}</h3>` : ''}${items.length ? `<ul>${items.map(l => `<li>${esc(l)}</li>`).join('')}</ul>` : ''}<p>${esc(lines.join('\n')).replace(/\n/g, '<br>')}</p>`;
    }

    // From the editor's More tools
    function fromEditor(what) {
        if (what === 'cover') {
            const n = app.editorNote() || { id: null, title: document.getElementById('editor-title')?.value || '', text: '', html: '', look: null };
            return coverPicker(n, true);
        }
        const n = app.editorNote();
        if (!n) return toast('Write something first');
        if (what === 'study') return openStudy(n);
        if (what === 'play') return playnote(n);
        if (what === 'create') return createFrom(n);
    }

    // Playnote page: your notes, ready to play
    function playRail() {
        const notes = app.getNotes().filter(n => !n.trashedAt && !n.archived && n.origin !== 'post' && !n.private && (n.text || '').split(/\s+/).length >= 30)
            .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)).slice(0, 10);
        if (!notes.length) return '';
        return `<section class="pn-sec" aria-labelledby="pn-notes-h"><header class="pn-sec-head"><h3 id="pn-notes-h">Play your notes</h3><p>Any note becomes an interactive Playnote</p></header>
            <div class="pn-rail" role="list">${notes.map(n => { const L = lookOf(n); const m = mastery(n); return `<button type="button" role="listitem" class="pn2-tile th-${esc(L.theme)}" data-pn2="${esc(n.id)}"><span>${esc(L.emoji)}</span><strong>${esc(n.title || firstLine(n.text))}</strong><small>${m ? `${m.pct}% mastered` : `${pagesOf(n)} pages · ▶️ Play`}</small></button>`; }).join('')}</div></section>`;
    }
    document.addEventListener('click', e => {
        const t = e.target.closest('[data-pn2]');
        if (t) { const n = noteById(t.dataset.pn2); if (n) playnote(n); }
    });

    // ======================================================================
    // What's new: an animated tour, shown once
    // ======================================================================
    const NEW_KEY = 'cordialWhatsNew';
    const NEW_VERSION = 'studio-2026-10';
    const NEW_SCENES = [
        { title: 'Smart Notes', say: 'Start anything in one tap: a note, a voice note, an image, a video, a checklist or a document — or begin from a study, journal, idea or meeting template.', dur: 7500, cta: ['Try it', () => createSheet()],
            html: () => `<p class="wn-q" style="--d:.2s">What do you want to create?</p><div class="wn-grid">${['✍️ Note', '🎙️ Voice', '📷 Image', '🎥 Video', '✅ Checklist', '📄 Document'].map((t, i) => `<span style="--d:${0.5 + i * 0.2}s">${t}</span>`).join('')}</div>` },
        { title: 'Scan → Note', say: 'Photograph handwriting, a whiteboard, a textbook, a receipt or a document. Cordial cleans it up and turns it into an editable note.', dur: 8000, cta: ['Scan something', () => scan()],
            html: () => `<div class="wn-scan"><div class="wn-paper" style="--d:.2s"><i></i><i></i><i></i><i></i><span class="wn-beam"></span></div><span class="wn-arrow" style="--d:1.6s">→</span><div class="wn-note" style="--d:2.2s"><b>Lecture 4</b><p>Cells are the basic unit of life…</p><p>Mitochondria: energy</p></div></div>` },
        { title: 'Note covers', say: 'Every note now has its own look: an emoji, a subject, how many pages, and when it was last updated. Pick your own from the note’s cover tool.', dur: 7000,
            html: () => `<div class="wn-covers">${[['🧬', 'Biology', 'Cell Division', 'green'], ['💼', 'Business', 'Q4 plan', 'slate'], ['🙏', 'Faith', 'Sunday notes', 'violet']].map(([e, s, t, th], i) => `<div class="wn-cover th-${th}" style="--d:${0.3 + i * 0.5}s"><span>${e}</span><b>${t}</b><small>${s} · ${14 - i * 5} pages · Updated ${i + 2}h ago</small></div>`).join('')}</div>` },
        { title: 'Smart Study Mode', say: 'Turn any note into flashcards, multiple choice, true or false and short-answer questions, with a revision summary and key terms — and watch your mastery grow.', dur: 8500,
            html: () => `<div class="wn-study"><div class="st-ring wn-ring" style="--p:72;--d:.3s"><div><strong>72%</strong><small>mastered</small></div></div><div class="wn-study-txt" style="--d:1s"><b>Biology Revision</b><span>18/25 concepts understood</span><div class="wn-chips"><span>🃏 Flashcards</span><span>❓ Quiz</span><span>✅ True/False</span><span>📝 Summary</span></div></div></div>` },
        { title: 'Playnote 2.0', say: 'Press play on a note. It becomes pages you swipe through — with an interactive diagram, a quick question and a mini quiz.', dur: 8000,
            html: () => `<div class="wn-pages">${[['Page 1', 'Cell Structure'], ['Page 2', 'Interactive diagram'], ['Page 3', 'Quick question'], ['Page 4', 'Mini quiz']].map(([p, t], i) => `<div class="wn-page" style="--d:${0.3 + i * 0.6}s"><small>${p}</small><b>${t}</b></div>`).join('')}</div>` },
        { title: 'Create from Note', say: 'One button turns a note into a post, a carousel, a story, a quiz, flashcards, a Playnote, a video script or a thread.', dur: 7500,
            html: () => `<div class="wn-from"><span class="wn-src" style="--d:.2s">📝 My Biology Notes</span><div class="wn-out">${['Post', 'Carousel', 'Story', 'Quiz', 'Flashcards', 'Playnote', 'Video script', 'Thread'].map((t, i) => `<span style="--d:${0.8 + i * 0.18}s">${t}</span>`).join('')}</div></div>` },
        { title: 'CORDIAL Discover', say: 'Publish your best notes for everyone, in Education, Business, Technology, Faith, Creativity, Ideas, Literature and Science.', dur: 7500, cta: ['Open Discover', () => app.setView('discover')],
            html: () => `<div class="wn-cats">${CATS.map(([k, e, l], i) => `<span style="--d:${0.2 + i * 0.2}s">${e} ${l}</span>`).join('')}</div>` }
    ];
    let T = null;
    function whatsNew() {
        try { localStorage.setItem(NEW_KEY, NEW_VERSION); } catch (e) { /* ignore */ }
        if (T) return;
        let sound = false;
        try { sound = localStorage.getItem('cordialTourVoice') === '1'; } catch (e) { /* ignore */ }
        const dlg = sheet('wn', 'What’s new in Cordial', `<div class="gm-card wn-card">
            <header class="gm-head"><button type="button" class="icon-btn" data-x aria-label="Close">${ic('i-close')}</button><div class="gm-title"><strong>✨ What’s new</strong><small>Your notes just got superpowers</small></div>${'speechSynthesis' in window ? `<button type="button" class="icon-btn" data-sound aria-pressed="${sound}" aria-label="Narration">${ic(sound ? 'i-volume' : 'i-volume-off')}</button>` : ''}</header>
            <div class="ht-bar" role="tablist" aria-label="Features">${NEW_SCENES.map((s, i) => `<button type="button" class="ht-seg" data-seg="${i}" role="tab" aria-label="${esc(s.title)}"><i></i></button>`).join('')}</div>
            <div class="wn-stage"></div>
            <div class="ht-cap"><div class="ht-cap-text" aria-live="polite"><small class="ht-n"></small><strong class="ht-title"></strong><p class="ht-say"></p></div></div>
            <div class="ht-ctl"><button type="button" class="icon-btn" data-prev aria-label="Previous">${ic('i-back')}</button><button type="button" class="ht-play" data-toggle aria-label="Pause">${ic('i-pause')}</button><button type="button" class="icon-btn" data-next aria-label="Next">${ic('i-forward')}</button></div>
            <button type="button" class="ghost-btn wn-try" data-try hidden></button>
        </div>`);
        T = { dlg, i: 0, t: 0, playing: true, raf: 0, sound };
        dlg.addEventListener('close', () => { cancelAnimationFrame(T && T.raf); T = null; });
        const say = text => { if (!T || !T.sound || !('speechSynthesis' in window)) return; try { speechSynthesis.cancel(); const u = new SpeechSynthesisUtterance(text); u.rate = 1.02; speechSynthesis.speak(u); } catch (e) { /* ignore */ } };
        const scene = i => {
            const sc = NEW_SCENES[i];
            T.i = i; T.t = 0; T.ended = false;
            const stage = dlg.querySelector('.wn-stage');
            stage.classList.remove('paused');
            stage.innerHTML = sc.html();
            dlg.querySelector('.ht-n').textContent = `New · ${i + 1} of ${NEW_SCENES.length}`;
            dlg.querySelector('.ht-title').textContent = sc.title;
            dlg.querySelector('.ht-say').textContent = sc.say;
            const tr = dlg.querySelector('[data-try]');
            tr.hidden = !sc.cta; tr.textContent = sc.cta ? `${sc.cta[0]} →` : '';
            dlg.querySelectorAll('.ht-seg').forEach((b, k) => { b.setAttribute('aria-selected', String(k === i)); b.querySelector('i').style.transform = `scaleX(${k < i ? 1 : 0})`; });
            if (!T.playing) setPlaying(true); else { say(sc.say); loop(); }
        };
        const setPlaying = on => {
            T.playing = on;
            const b = dlg.querySelector('[data-toggle]');
            b.innerHTML = ic(on ? 'i-pause' : 'i-play'); b.setAttribute('aria-label', on ? 'Pause' : 'Play');
            dlg.querySelector('.wn-stage').classList.toggle('paused', !on);
            try { if (on) { if (speechSynthesis.paused) speechSynthesis.resume(); else if (T.t < 300) say(NEW_SCENES[T.i].say); } else speechSynthesis.pause(); } catch (e) { /* ignore */ }
            if (on) loop(); else cancelAnimationFrame(T.raf);
        };
        const loop = () => {
            cancelAnimationFrame(T.raf);
            let last = performance.now();
            const tick = now => {
                if (!T || !T.playing) return;
                T.t += Math.min(100, now - last); last = now;
                const sc = NEW_SCENES[T.i];
                const seg = dlg.querySelectorAll('.ht-seg i')[T.i];
                if (seg) seg.style.transform = `scaleX(${Math.min(1, T.t / sc.dur)})`;
                if (T.t >= sc.dur) {
                    if (T.i < NEW_SCENES.length - 1) return scene(T.i + 1);
                    T.playing = false; T.ended = true;
                    const b = dlg.querySelector('[data-toggle]'); b.innerHTML = ic('i-play'); b.setAttribute('aria-label', 'Watch again');
                    const end = document.createElement('div');
                    end.className = 'ht-end';
                    end.innerHTML = '<strong>All yours ✨</strong><span>Open any note → More tools to try them</span><div><button type="button" class="primary-btn" data-start>Create something</button><button type="button" class="ghost-btn" data-replay>Watch again</button></div>';
                    dlg.querySelector('.wn-stage').append(end);
                    return;
                }
                T.raf = requestAnimationFrame(tick);
            };
            T.raf = requestAnimationFrame(tick);
        };
        dlg.addEventListener('click', e => {
            if (e.target.closest('[data-x]')) return dlg.close();
            const seg = e.target.closest('[data-seg]'); if (seg) return scene(Number(seg.dataset.seg));
            if (e.target.closest('[data-toggle]')) return T.ended ? scene(0) : setPlaying(!T.playing);
            if (e.target.closest('[data-prev]')) return scene(Math.max(0, T.t > 1500 ? T.i : T.i - 1));
            if (e.target.closest('[data-next]') && T.i < NEW_SCENES.length - 1) return scene(T.i + 1);
            if (e.target.closest('[data-replay]')) return scene(0);
            if (e.target.closest('[data-start]')) { dlg.close(); return createSheet(); }
            const tr = e.target.closest('[data-try]');
            if (tr) { const sc = NEW_SCENES[T.i]; dlg.close(); if (sc.cta) sc.cta[1](); return; }
            const snd = e.target.closest('[data-sound]');
            if (snd) { T.sound = !T.sound; try { localStorage.setItem('cordialTourVoice', T.sound ? '1' : '0'); } catch (e2) { /* ignore */ } snd.setAttribute('aria-pressed', String(T.sound)); snd.innerHTML = ic(T.sound ? 'i-volume' : 'i-volume-off'); if (T.sound && T.playing) say(NEW_SCENES[T.i].say); else speechSynthesis.cancel(); }
        });
        scene(0);
    }
    // Shown once, a moment after the app opens (never over another window)
    setTimeout(function offer() {
        let seen = null;
        try { seen = localStorage.getItem(NEW_KEY); } catch (e) { return; }
        if (seen === NEW_VERSION) return;
        if (document.querySelector('dialog[open]') || document.getElementById('splash') || [...document.querySelectorAll('.auth')].some(el => el.getClientRects().length > 0)) return setTimeout(offer, 4000);
        whatsNew();
    }, 3500);

    window.diaryStudio = { createSheet, scan, cardBits, coverPicker, openStudy, playnote, createFrom, publish, fromEditor, playRail, whatsNew, lookOf, _studySet: studySet, _parse: parse };
});
