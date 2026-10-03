// Games on Playnote: Five (guess the word), Word search, Sudoku, Memory, Maths sprint and the Sliding puzzle.
// Each has a daily puzzle that's the same for everyone (built from the date), plus unlimited practice. The
// first daily play is ranked; the server turns what you did (guesses, time, moves) into points, so a tampered
// phone can't post a silly score.
document.addEventListener('DOMContentLoaded', () => {
    const app = window.diaryApp;
    const social = window.diarySocial;
    if (!app || !social || !social.internals) return;
    const I = social.internals;
    const { client, state: s, esc } = I;
    const ic = (id, cls = '') => `<svg class="i${cls ? ` ${cls}` : ''}" aria-hidden="true"><use href="#${id}"/></svg>`;
    const utcDay = () => new Date().toISOString().slice(0, 10);

    const GAMES = {
        five: { title: 'Five', sub: 'Guess the word in six tries', icon: 'i-g-five' },
        wordsearch: { title: 'Word search', sub: 'Find every hidden word', icon: 'i-search' },
        sudoku: { title: 'Sudoku', sub: 'Fill the grid, 1 to 9', icon: 'i-g-sudoku' },
        memory: { title: 'Memory', sub: 'Match all eight pairs', icon: 'i-g-cards' },
        maths: { title: 'Maths sprint', sub: 'As many as you can in 60 seconds', icon: 'i-g-plus' },
        slide: { title: 'Sliding puzzle', sub: 'Put the tiles back in order', icon: 'i-g-slide' },
        wordplay: { title: 'Wordplay', sub: 'Build words on the board for points', icon: 'i-g-tiles' }
    };
    const G = { today: null, off: new Set() };

    // ---------- A seeded random number generator: the same day gives everyone the same puzzle ----------
    function seeded(str) {
        let h = 1779033703 ^ str.length;
        for (let i = 0; i < str.length; i++) { h = Math.imul(h ^ str.charCodeAt(i), 3432918353); h = (h << 13) | (h >>> 19); }
        let a = h >>> 0;
        return () => {
            a = (a + 0x6D2B79F5) >>> 0;
            let t = a;
            t = Math.imul(t ^ (t >>> 15), t | 1);
            t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
            return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
        };
    }
    const shuffle = (arr, rnd) => { const a = arr.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
    const pick = (arr, rnd) => arr[Math.floor(rnd() * arr.length)];

    // ---------- Word lists ----------
    const FIVE = ('about above actor adapt admit adopt adult after again agent agree ahead alarm album alert alike alive allow alone along ' +
        'amaze amber angel anger angle apple apply arise array aside audio avoid awake award aware badge baker basic beach beard beast begin ' +
        'being below bench berry birth black blade blame blank blaze bless blind block bloom board boost brain brave bread break brick bride ' +
        'brief bring broad brown brush build bunch cabin candy carry catch cause chain chair charm chart chase cheap check chest chief child ' +
        'choir civil claim class clean clear clerk climb clock close cloud coach coast color count court cover craft crane cream crowd crown ' +
        'dance delay depth diary dream dress drink drive eager early earth elder empty enjoy enter equal event every faith fancy feast field ' +
        'final flame flash fleet float flock floor flour focus force forth frame fresh front frost fruit giant glass globe glory grace grade ' +
        'grain grand grant grape grass great green greet guard guest guide happy heart heavy honey honor horse hotel house human humor ideal ' +
        'image input judge juice kneel knife known label large laugh layer learn lemon level light limit lodge loyal lucky lunch magic major ' +
        'mango maple march match mayor medal mercy metal model money month moral mouse mouth movie music night noble noise north novel ocean ' +
        'offer olive onion order other paint panel paper party peace pearl piano pilot place plain plane plant plate point power pride prime ' +
        'print prize proof proud psalm queen quick quiet quite radio raise range reach ready relax reply right river robin round royal ruler ' +
        'salad scale scene scope score sense serve seven shade shape share sharp sheep shelf shine shirt shore short sight skill sleep slice ' +
        'smile smoke snake solid solve sound south space spark speak spice spoon sport staff stage stair stamp stand start steam stone storm ' +
        'story sugar sunny sweet table taste teach thank theme thick thing think throw tiger title toast today tower trade trail train trust ' +
        'truth uncle under unity upper urban usual value visit voice waste watch water whale wheat wheel white whole woman world worth write ' +
        'young youth zebra').split(' ');
    const THEMES = [
        ['Books of the Bible', ['GENESIS', 'EXODUS', 'PSALMS', 'PROVERBS', 'ISAIAH', 'MATTHEW', 'ROMANS', 'ACTS', 'JAMES', 'JUDE']],
        ['Fruit', ['MANGO', 'BANANA', 'ORANGE', 'PAWPAW', 'GUAVA', 'LEMON', 'CHERRY', 'GRAPE', 'MELON', 'APPLE']],
        ['Countries', ['NIGERIA', 'GHANA', 'KENYA', 'EGYPT', 'BRAZIL', 'CANADA', 'FRANCE', 'JAPAN', 'INDIA', 'PERU']],
        ['Virtues', ['LOVE', 'JOY', 'PEACE', 'PATIENCE', 'KINDNESS', 'FAITH', 'HOPE', 'MERCY', 'GRACE', 'HUMILITY']],
        ['Animals', ['LION', 'ZEBRA', 'GIRAFFE', 'EAGLE', 'TURTLE', 'RABBIT', 'MONKEY', 'HIPPO', 'CAMEL', 'TIGER']],
        ['In the kitchen', ['SPOON', 'KNIFE', 'PLATE', 'OVEN', 'KETTLE', 'BOWL', 'FORK', 'PAN', 'CUP', 'GRATER']],
        ['Weather', ['RAIN', 'THUNDER', 'CLOUD', 'SUNNY', 'STORM', 'WIND', 'FOG', 'FROST', 'SNOW', 'BREEZE']],
        ['Music', ['PIANO', 'GUITAR', 'DRUM', 'CHOIR', 'VIOLIN', 'TRUMPET', 'MELODY', 'RHYTHM', 'SONG', 'FLUTE']],
        ['Sports', ['FOOTBALL', 'TENNIS', 'BOXING', 'CRICKET', 'RUGBY', 'GOLF', 'HOCKEY', 'CYCLING', 'SWIMMING', 'CHESS']],
        ['School', ['PENCIL', 'RULER', 'ERASER', 'TEACHER', 'LESSON', 'CLASS', 'BOOK', 'EXAM', 'DESK', 'CHALK']]
    ];

    // ---------- The game window ----------
    let W = null; // { game, dlg, daily, seed, started, timer, done }
    function open(game, practice = false) {
        if (!GAMES[game]) return;
        if (G.off.has(game)) return app.showToast(`${GAMES[game].title} is paused for now — try another game`);
        const daily = !practice;
        const seed = daily ? `${game}:${utcDay()}` : `${game}:practice:${Date.now()}:${Math.random()}`;
        closeWin();
        const dlg = document.createElement('dialog');
        dlg.className = 'gm';
        dlg.setAttribute('aria-label', GAMES[game].title);
        document.body.append(dlg);
        W = { game, dlg, daily, seed, rnd: seeded(seed), started: 0, timer: null, done: false, state: {} };
        dlg.addEventListener('close', () => { stopClock(); dlg.remove(); if (W && W.dlg === dlg) W = null; loadToday(); });
        dlg.addEventListener('cancel', e => { if (W && W.started && !W.done) { e.preventDefault(); confirmLeave(); } });
        dlg.showModal();
        const played = daily && G.today && G.today[game];
        if (played) return showPlayed(G.today[game]);
        BUILD[game]();
    }
    function closeWin() { if (W && W.dlg.open) W.dlg.close(); }
    async function confirmLeave() {
        const ok = await app.ask({ title: 'Leave this game?', text: W.daily ? 'Today’s puzzle stays unsolved — you can come back to it before midnight UTC.' : 'This practice round will be lost.', ok: 'Leave' });
        if (ok) closeWin();
    }
    const startClock = () => {
        if (W.started) return;
        W.started = performance.now();
        W.timer = setInterval(paintClock, 500);
    };
    const stopClock = () => { if (W && W.timer) { clearInterval(W.timer); W.timer = null; } };
    const elapsed = () => (W.started ? performance.now() - W.started : 0);
    const clockText = ms => { const t = Math.floor(ms / 1000); return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`; };
    function paintClock() {
        const el = W && W.dlg.querySelector('.gm-clock');
        if (!el) return;
        if (W.game === 'maths') { const left = Math.max(0, 60000 - elapsed()); el.textContent = `0:${String(Math.ceil(left / 1000)).padStart(2, '0')}`; el.classList.toggle('low', left < 10000); if (!left && !W.done) finishMaths(); }
        else el.textContent = clockText(elapsed());
    }
    function frame(body, extra = '') {
        const g = GAMES[W.game];
        W.dlg.innerHTML = `
            <div class="gm-card gm-${W.game}">
                <header class="gm-head">
                    <button type="button" class="icon-btn" data-gm="close" aria-label="Close">${ic('i-close')}</button>
                    <div class="gm-title"><strong>${ic(g.icon)}${esc(g.title)}</strong><small>${W.daily ? 'Today’s puzzle' : 'Practice'}${extra}</small></div>
                    <span class="gm-clock" aria-label="Time">${W.game === 'maths' ? '1:00' : '0:00'}</span>
                </header>
                <div class="gm-body">${body}</div>
            </div>`;
    }

    // ---------- Finishing ----------
    async function finish({ won, moves, share, summary }) {
        if (W.done) return;
        W.done = true;
        stopClock();
        const time = Math.round(elapsed());
        const g = GAMES[W.game];
        W.dlg.querySelector('.gm-body').insertAdjacentHTML('beforeend', '<div class="gm-saving" aria-live="polite">Saving your result…</div>');
        const { data, error } = await client.rpc('diary_game_submit', { p_game: W.game, p_won: !!won, p_moves: moves, p_time_ms: time, p_day: utcDay() });
        if (!W) return;
        const score = data ? data.score : 0;
        W.share = share;
        W.dlg.querySelector('.gm-body').innerHTML = `
            <div class="gm-end">
                <p class="gm-cheer">${W.game === 'maths' ? 'Time’s up!' : W.game === 'wordplay' ? 'Well played!' : won ? 'Solved!' : 'Nice try'}</p>
                <p class="gm-summary">${esc(summary)} · ${clockText(time)}</p>
                <div class="gm-points"><b>${error ? '—' : score.toLocaleString()}</b><span>${error ? esc(error.message || 'Couldn’t save your score') : data.ranked ? 'points · counts on today’s leaderboard' : 'points · practice'}</span></div>
                ${data && data.badges && data.badges.length ? `<div class="gm-badges">${data.badges.map(b => `<span class="badge-chip ${esc(b.tier)}">${ic(b.icon)}${esc(b.name)}</span>`).join('')}<small>New badge${data.badges.length > 1 ? 's' : ''}!</small></div>` : ''}
                <div class="quiz-actions">
                    <button type="button" class="primary-btn" data-gm="share">${ic('i-share')}Share to the feed</button>
                    <button type="button" class="ghost-btn" data-gm="again">Play a practice round</button>
                    <button type="button" class="ghost-btn" data-gm="close">Done</button>
                </div>
            </div>`;
        if (data && data.badges && data.badges.length && window.diaryPlay) window.diaryPlay.refresh();
        if (!error && won && window.matchMedia && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) confetti(W.dlg.querySelector('.gm-points'));
        G.today = null;
    }
    function showPlayed(r) {
        const g = GAMES[W.game];
        frame(`
            <div class="gm-end">
                <p class="gm-cheer">You’ve played today’s ${esc(g.title)}</p>
                <div class="gm-points"><b>${Number(r.score || 0).toLocaleString()}</b><span>points · ${r.won ? 'solved' : 'played'} in ${clockText(r.time_ms || 0)}</span></div>
                <p class="gm-summary">A new puzzle arrives at midnight UTC. Practice as much as you like until then.</p>
                <div class="quiz-actions">
                    <button type="button" class="primary-btn" data-gm="again">Play a practice round</button>
                    <button type="button" class="ghost-btn" data-gm="close">Done</button>
                </div>
            </div>`);
        W.done = true;
    }
    function confetti(el) {
        if (!el) return;
        const colors = ['#f59e0b', '#10b981', '#6366f1', '#ec4899', '#3b82f6'];
        for (let i = 0; i < 22; i++) {
            const bit = document.createElement('i');
            bit.className = 'quiz-confetti';
            bit.style.setProperty('--x', `${(Math.random() - 0.5) * 320}px`);
            bit.style.setProperty('--y', `${-60 - Math.random() * 180}px`);
            bit.style.setProperty('--r', `${Math.random() * 720 - 360}deg`);
            bit.style.background = colors[i % colors.length];
            el.append(bit);
            setTimeout(() => bit.remove(), 1400);
        }
    }

    // =====================================================================
    // Five: guess the five-letter word
    // =====================================================================
    const KEYS = ['QWERTYUIOP', 'ASDFGHJKL', 'ZXCVBNM'];
    function buildFive() {
        const answer = pick(FIVE, W.rnd).toUpperCase();
        W.state = { answer, rows: [], cur: '', keys: {} };
        frame('<div class="five-board" role="grid" aria-label="Guesses"></div><p class="gm-hint" aria-live="polite">Type any five-letter word.</p><div class="five-keys"></div>');
        paintFive();
        W.onKey = e => {
            if (W.done || W.game !== 'five') return;
            if (e.metaKey || e.ctrlKey || e.altKey) return;
            if (/^[a-z]$/i.test(e.key)) fiveKey(e.key.toUpperCase());
            else if (e.key === 'Backspace') fiveKey('⌫');
            else if (e.key === 'Enter') fiveKey('↵');
            else return;
            e.preventDefault();
        };
        W.dlg.addEventListener('keydown', W.onKey);
    }
    function scoreGuess(guess, answer) {
        const res = Array(5).fill('absent');
        const left = {};
        for (let i = 0; i < 5; i++) { if (guess[i] === answer[i]) res[i] = 'right'; else left[answer[i]] = (left[answer[i]] || 0) + 1; }
        for (let i = 0; i < 5; i++) if (res[i] !== 'right' && left[guess[i]]) { res[i] = 'near'; left[guess[i]]--; }
        return res;
    }
    function paintFive(shake = false) {
        const st = W.state;
        const rows = [];
        for (let r = 0; r < 6; r++) {
            const done = st.rows[r];
            const letters = done ? done.word : r === st.rows.length ? st.cur.padEnd(5) : '     ';
            rows.push(`<div class="five-row${shake && r === st.rows.length ? ' shake' : ''}" role="row">${[...letters].map((ch, i) =>
                `<span class="five-cell${done ? ` ${done.res[i]}` : ch.trim() ? ' filled' : ''}" role="gridcell" style="--i:${i}">${esc(ch.trim())}</span>`).join('')}</div>`);
        }
        W.dlg.querySelector('.five-board').innerHTML = rows.join('');
        W.dlg.querySelector('.five-keys').innerHTML = KEYS.map((row, ri) => `<div class="five-krow">${ri === 2 ? '<button type="button" class="five-key wide" data-k="↵" aria-label="Enter">Enter</button>' : ''}${[...row].map(k =>
            `<button type="button" class="five-key ${st.keys[k] || ''}" data-k="${k}">${k}</button>`).join('')}${ri === 2 ? `<button type="button" class="five-key wide" data-k="⌫" aria-label="Delete">${ic('i-back')}</button>` : ''}</div>`).join('');
    }
    function fiveKey(k) {
        const st = W.state;
        startClock();
        if (k === '⌫') st.cur = st.cur.slice(0, -1);
        else if (k === '↵') {
            if (st.cur.length < 5) { hint('Not enough letters'); return paintFive(true); }
            const res = scoreGuess(st.cur, st.answer);
            st.rows.push({ word: st.cur, res });
            [...st.cur].forEach((ch, i) => {
                const rank = { right: 3, near: 2, absent: 1 };
                if (!st.keys[ch] || rank[res[i]] > rank[st.keys[ch]]) st.keys[ch] = res[i];
            });
            const won = st.cur === st.answer;
            st.cur = '';
            paintFive();
            if (won || st.rows.length === 6) {
                const grid = st.rows.map(r => r.res.map(x => (x === 'right' ? '🟩' : x === 'near' ? '🟨' : '⬛')).join('')).join('\n');
                setTimeout(() => finish({
                    won, moves: st.rows.length,
                    summary: won ? `Got it in ${st.rows.length} ${st.rows.length === 1 ? 'guess' : 'guesses'}` : `The word was ${st.answer}`,
                    share: `Five ${won ? st.rows.length : 'X'}/6 on Cordial${W.daily ? ` · ${utcDay()}` : ''}\n${grid}\n#playnote`
                }), 900);
            } else hint(['Keep going', 'Getting warmer', 'Think again', 'So close', 'Last chance!'][st.rows.length - 1] || '');
            return;
        } else if (st.cur.length < 5) st.cur += k;
        paintFive();
    }
    const hint = text => { const el = W.dlg.querySelector('.gm-hint'); if (el) el.textContent = text; };

    // =====================================================================
    // Word search
    // =====================================================================
    function buildWordsearch() {
        const [theme, pool] = pick(THEMES, W.rnd);
        const words = shuffle(pool, W.rnd).slice(0, 8);
        const N = 10;
        const grid = Array.from({ length: N }, () => Array(N).fill(''));
        const dirs = [[0, 1], [1, 0], [1, 1], [-1, 1], [0, -1], [1, -1]];
        const placed = [];
        for (const word of words) {
            let ok = false;
            for (let tries = 0; tries < 300 && !ok; tries++) {
                const [dr, dc] = pick(dirs, W.rnd);
                const r0 = Math.floor(W.rnd() * N), c0 = Math.floor(W.rnd() * N);
                const r1 = r0 + dr * (word.length - 1), c1 = c0 + dc * (word.length - 1);
                if (r1 < 0 || r1 >= N || c1 < 0 || c1 >= N) continue;
                if ([...word].every((ch, i) => { const g = grid[r0 + dr * i][c0 + dc * i]; return !g || g === ch; })) {
                    [...word].forEach((ch, i) => { grid[r0 + dr * i][c0 + dc * i] = ch; });
                    placed.push({ word, cells: [...word].map((_, i) => `${r0 + dr * i},${c0 + dc * i}`) });
                    ok = true;
                }
            }
        }
        const A = 'ABCDEFGHIJKLMNOPRSTUWY';
        for (let r = 0; r < N; r++) for (let c = 0; c < N; c++) if (!grid[r][c]) grid[r][c] = A[Math.floor(W.rnd() * A.length)];
        W.state = { theme, grid, placed, found: new Set(), sel: null };
        frame(`
            <p class="ws-theme">Theme: <strong>${esc(theme)}</strong></p>
            <div class="ws-grid" style="--n:${N}" role="grid" aria-label="Letter grid — drag across a word">${grid.map((row, r) => row.map((ch, c) =>
                `<span class="ws-cell" data-rc="${r},${c}">${ch}</span>`).join('')).join('')}</div>
            <ul class="ws-words">${placed.map(p => `<li data-w="${p.word}">${p.word}</li>`).join('')}</ul>
            <div class="gm-foot"><button type="button" class="ghost-btn" data-gm="give-up">I’m done</button></div>`);
        const gridEl = W.dlg.querySelector('.ws-grid');
        const cellAt = e => { const el = document.elementFromPoint(e.clientX, e.clientY); return el && el.closest && el.closest('.ws-cell'); };
        const line = (a, b) => {
            const [r0, c0] = a.split(',').map(Number), [r1, c1] = b.split(',').map(Number);
            const dr = Math.sign(r1 - r0), dc = Math.sign(c1 - c0);
            const len = Math.max(Math.abs(r1 - r0), Math.abs(c1 - c0));
            if (!(r0 === r1 || c0 === c1 || Math.abs(r1 - r0) === Math.abs(c1 - c0))) return [a];
            return Array.from({ length: len + 1 }, (_, i) => `${r0 + dr * i},${c0 + dc * i}`);
        };
        const paintSel = cells => gridEl.querySelectorAll('.ws-cell').forEach(el => el.classList.toggle('sel', cells.includes(el.dataset.rc)));
        gridEl.addEventListener('pointerdown', e => {
            const cell = e.target.closest('.ws-cell');
            if (!cell || W.done) return;
            e.preventDefault();
            startClock();
            gridEl.setPointerCapture(e.pointerId);
            W.state.sel = { from: cell.dataset.rc, cells: [cell.dataset.rc] };
            paintSel(W.state.sel.cells);
        });
        gridEl.addEventListener('pointermove', e => {
            if (!W.state.sel) return;
            const cell = cellAt(e);
            if (!cell) return;
            W.state.sel.cells = line(W.state.sel.from, cell.dataset.rc);
            paintSel(W.state.sel.cells);
        });
        const end = () => {
            const sel = W.state.sel;
            W.state.sel = null;
            paintSel([]);
            if (!sel) return;
            const key = sel.cells.join('|');
            const hit = W.state.placed.find(p => !W.state.found.has(p.word) && (p.cells.join('|') === key || [...p.cells].reverse().join('|') === key));
            if (!hit) return;
            W.state.found.add(hit.word);
            hit.cells.forEach(rc => gridEl.querySelector(`[data-rc="${rc}"]`)?.classList.add('found'));
            W.dlg.querySelector(`[data-w="${hit.word}"]`)?.classList.add('found');
            if (navigator.vibrate) navigator.vibrate(10);
            if (W.state.found.size === W.state.placed.length) setTimeout(() => finishWordsearch(), 400);
        };
        gridEl.addEventListener('pointerup', end);
        gridEl.addEventListener('pointercancel', end);
    }
    function finishWordsearch() {
        const n = W.state.found.size, total = W.state.placed.length;
        finish({ won: n === total, moves: n, summary: `Found ${n} of ${total} words · ${W.state.theme}`,
            share: `🔎 I found ${n}/${total} words in ${W.daily ? 'today’s' : 'a'} Word search (${W.state.theme}) on Cordial in ${clockText(elapsed())}! #playnote` });
    }

    // =====================================================================
    // Sudoku
    // =====================================================================
    function sudokuSolve(b, count = false, rnd = null) {
        // b: 81 numbers (0 = empty). Returns a solved board, or the number of solutions (up to 2) when count
        let solutions = 0;
        let out = null;
        const ok = (i, v) => {
            const r = Math.floor(i / 9), c = i % 9, br = r - r % 3, bc = c - c % 3;
            for (let k = 0; k < 9; k++) if (b[r * 9 + k] === v || b[k * 9 + c] === v || b[(br + Math.floor(k / 3)) * 9 + bc + k % 3] === v) return false;
            return true;
        };
        const go = () => {
            const i = b.indexOf(0);
            if (i < 0) { solutions++; if (!out) out = b.slice(); return count ? solutions >= 2 : true; }
            const vals = rnd ? shuffle([1, 2, 3, 4, 5, 6, 7, 8, 9], rnd) : [1, 2, 3, 4, 5, 6, 7, 8, 9];
            for (const v of vals) {
                if (!ok(i, v)) continue;
                b[i] = v;
                if (go()) { b[i] = 0; return true; }
                b[i] = 0;
            }
            return false;
        };
        go();
        return count ? solutions : out;
    }
    function buildSudoku() {
        const solution = sudokuSolve(Array(81).fill(0), false, W.rnd);
        const puzzle = solution.slice();
        const order = shuffle([...Array(81).keys()], W.rnd);
        let givens = 81;
        for (const i of order) {
            if (givens <= 34) break;
            const keep = puzzle[i];
            puzzle[i] = 0;
            if (sudokuSolve(puzzle.slice(), true) !== 1) puzzle[i] = keep;
            else givens--;
        }
        W.state = { solution, puzzle, board: puzzle.slice(), sel: puzzle.indexOf(0), mistakes: 0 };
        frame(`
            <div class="sd-grid" role="grid" aria-label="Sudoku"></div>
            <p class="gm-hint" aria-live="polite">Pick a square, then a number.</p>
            <div class="sd-pad">${[1, 2, 3, 4, 5, 6, 7, 8, 9].map(n => `<button type="button" class="sd-num" data-n="${n}">${n}</button>`).join('')}
                <button type="button" class="sd-num erase" data-n="0" aria-label="Erase">${ic('i-close')}</button></div>`);
        paintSudoku();
        W.onKey = e => {
            if (W.done || W.game !== 'sudoku') return;
            const st = W.state;
            if (/^[1-9]$/.test(e.key)) sudokuPut(Number(e.key));
            else if (e.key === 'Backspace' || e.key === 'Delete' || e.key === '0') sudokuPut(0);
            else if (e.key.startsWith('Arrow')) {
                const d = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -9, ArrowDown: 9 }[e.key];
                st.sel = Math.min(80, Math.max(0, st.sel + d));
                paintSudoku();
            } else return;
            e.preventDefault();
        };
        W.dlg.addEventListener('keydown', W.onKey);
    }
    function paintSudoku() {
        const st = W.state;
        const selV = st.board[st.sel];
        const r0 = Math.floor(st.sel / 9), c0 = st.sel % 9;
        W.dlg.querySelector('.sd-grid').innerHTML = st.board.map((v, i) => {
            const r = Math.floor(i / 9), c = i % 9;
            const given = st.puzzle[i] !== 0;
            const wrong = v && !given && v !== st.solution[i];
            const peer = r === r0 || c === c0 || (Math.floor(r / 3) === Math.floor(r0 / 3) && Math.floor(c / 3) === Math.floor(c0 / 3));
            return `<button type="button" class="sd-cell${given ? ' given' : ''}${wrong ? ' wrong' : ''}${i === st.sel ? ' sel' : peer ? ' peer' : ''}${v && v === selV ? ' same' : ''}${c % 3 === 2 && c < 8 ? ' br' : ''}${r % 3 === 2 && r < 8 ? ' bb' : ''}" data-i="${i}" role="gridcell" aria-label="Row ${r + 1}, column ${c + 1}${v ? `: ${v}` : ', empty'}">${v || ''}</button>`;
        }).join('');
        hint(st.mistakes ? `${st.mistakes} ${st.mistakes === 1 ? 'mistake' : 'mistakes'}` : 'Pick a square, then a number.');
    }
    function sudokuPut(n) {
        const st = W.state;
        if (st.puzzle[st.sel] !== 0) return;
        startClock();
        st.board[st.sel] = n;
        if (n && n !== st.solution[st.sel]) { st.mistakes++; if (navigator.vibrate) navigator.vibrate([15, 30, 15]); }
        paintSudoku();
        if (st.board.every((v, i) => v === st.solution[i])) {
            setTimeout(() => finish({ won: true, moves: st.mistakes, summary: `Solved with ${st.mistakes} ${st.mistakes === 1 ? 'mistake' : 'mistakes'}`,
                share: `🔢 I solved ${W.daily ? 'today’s' : 'a'} Sudoku on Cordial in ${clockText(elapsed())}${st.mistakes ? '' : ' with no mistakes'}! #playnote` }), 300);
        }
    }

    // =====================================================================
    // Memory
    // =====================================================================
    const MEM_ICONS = ['i-book', 'i-globe', 'i-g-flask', 'i-g-ball', 'i-g-cap', 'i-trophy', 'i-flame', 'i-g-puzzle', 'i-music', 'i-camera', 'i-heart', 'i-sparkle'];
    function buildMemory() {
        const icons = shuffle(MEM_ICONS, W.rnd).slice(0, 8);
        const cards = shuffle([...icons, ...icons], W.rnd).map((icon, i) => ({ i, icon, open: false, done: false }));
        W.state = { cards, first: null, busy: false, turns: 0, pairs: 0 };
        frame('<div class="mm-grid" role="grid" aria-label="Cards"></div><p class="gm-hint" aria-live="polite">Turn over two cards to find a pair.</p>');
        paintMemory();
    }
    function paintMemory() {
        W.dlg.querySelector('.mm-grid').innerHTML = W.state.cards.map(c =>
            `<button type="button" class="mm-card${c.open || c.done ? ' open' : ''}${c.done ? ' done' : ''}" data-c="${c.i}" aria-label="${c.open || c.done ? 'Card showing a picture' : 'Face-down card'}"${c.done ? ' disabled' : ''}>
                <span class="mm-back" aria-hidden="true"></span><span class="mm-face">${ic(c.icon)}</span></button>`).join('');
        hint(`${W.state.turns} ${W.state.turns === 1 ? 'turn' : 'turns'} · ${W.state.pairs} of 8 pairs`);
    }
    function memoryFlip(i) {
        const st = W.state;
        const c = st.cards[i];
        if (st.busy || c.open || c.done) return;
        startClock();
        c.open = true;
        if (st.first === null) { st.first = i; paintMemory(); return; }
        const a = st.cards[st.first];
        st.turns++;
        st.first = null;
        if (a.icon === c.icon) {
            a.done = c.done = true;
            st.pairs++;
            if (navigator.vibrate) navigator.vibrate(10);
            paintMemory();
            if (st.pairs === 8) setTimeout(() => finish({ won: true, moves: st.turns, summary: `All pairs in ${st.turns} turns`,
                share: `🃏 I matched every pair in ${W.daily ? 'today’s' : 'a'} Memory game on Cordial — ${st.turns} turns, ${clockText(elapsed())}! #playnote` }), 400);
            return;
        }
        st.busy = true;
        paintMemory();
        setTimeout(() => { a.open = c.open = false; st.busy = false; if (W) paintMemory(); }, 850);
    }

    // =====================================================================
    // Maths sprint
    // =====================================================================
    function mathsQuestion() {
        const st = W.state;
        const level = Math.min(4, Math.floor(st.right / 5));
        const r = W.rnd;
        const n = (a, b) => a + Math.floor(r() * (b - a + 1));
        const op = pick(level < 1 ? ['+', '−'] : level < 3 ? ['+', '−', '×'] : ['+', '−', '×', '÷'], r);
        let a, b, ans;
        if (op === '+') { a = n(2, 12 + level * 15); b = n(2, 12 + level * 15); ans = a + b; }
        else if (op === '−') { a = n(5, 20 + level * 15); b = n(1, a); ans = a - b; }
        else if (op === '×') { a = n(2, 6 + level * 2); b = n(2, 9 + level); ans = a * b; }
        else { b = n(2, 9 + level); ans = n(2, 9 + level); a = b * ans; }
        st.q = { text: `${a} ${op} ${b}`, ans };
        st.input = '';
    }
    function buildMaths() {
        W.state = { right: 0, wrong: 0, input: '', q: null };
        mathsQuestion();
        frame(`
            <div class="mx-q" aria-live="polite"></div>
            <div class="mx-input" aria-label="Your answer"></div>
            <div class="mx-pad">${[7, 8, 9, 4, 5, 6, 1, 2, 3].map(d => `<button type="button" class="mx-key" data-d="${d}">${d}</button>`).join('')}
                <button type="button" class="mx-key" data-d="⌫" aria-label="Delete">${ic('i-back')}</button><button type="button" class="mx-key" data-d="0">0</button><button type="button" class="mx-key go" data-d="↵" aria-label="Enter">${ic('i-check')}</button></div>
            <p class="gm-hint" aria-live="polite">The clock starts with your first answer.</p>`);
        paintMaths();
        W.onKey = e => {
            if (W.done || W.game !== 'maths') return;
            if (/^[0-9]$/.test(e.key)) mathsKey(e.key);
            else if (e.key === 'Backspace') mathsKey('⌫');
            else if (e.key === 'Enter') mathsKey('↵');
            else return;
            e.preventDefault();
        };
        W.dlg.addEventListener('keydown', W.onKey);
    }
    function paintMaths(flash = '') {
        const st = W.state;
        W.dlg.querySelector('.mx-q').textContent = `${st.q.text} =`;
        const inp = W.dlg.querySelector('.mx-input');
        inp.textContent = st.input || '?';
        inp.className = `mx-input${flash ? ` ${flash}` : ''}`;
        hint(`${st.right} right${st.wrong ? ` · ${st.wrong} wrong` : ''}`);
    }
    function mathsKey(k) {
        const st = W.state;
        startClock();
        if (k === '⌫') st.input = st.input.slice(0, -1);
        else if (k === '↵') {
            if (!st.input) return;
            const ok = Number(st.input) === st.q.ans;
            if (ok) st.right++; else st.wrong++;
            mathsQuestion();
            return paintMaths(ok ? 'ok' : 'no');
        } else if (st.input.length < 4) st.input += k;
        paintMaths();
        // Answers that are already right go through without Enter
        if (Number(st.input) === st.q.ans && String(st.q.ans).length === st.input.length) setTimeout(() => { if (W && W.state.input === st.input) mathsKey('↵'); }, 120);
    }
    function finishMaths() {
        const st = W.state;
        finish({ won: st.right > 0, moves: st.right, summary: `${st.right} right${st.wrong ? `, ${st.wrong} wrong` : ''} in 60 seconds`,
            share: `➗ ${st.right} sums right in 60 seconds in ${W.daily ? 'today’s' : 'a'} Maths sprint on Cordial! Can you beat it? #playnote` });
    }

    // =====================================================================
    // Sliding puzzle
    // =====================================================================
    function buildSlide() {
        const N = 4;
        const tiles = [...Array(N * N).keys()].map(i => (i + 1) % (N * N)); // 1..15, then 0 (the gap)
        let gap = N * N - 1, last = -1;
        for (let k = 0; k < 160; k++) {
            const r = Math.floor(gap / N), c = gap % N;
            const nb = [[r - 1, c], [r + 1, c], [r, c - 1], [r, c + 1]].filter(([a, b]) => a >= 0 && a < N && b >= 0 && b < N).map(([a, b]) => a * N + b).filter(x => x !== last);
            const nxt = pick(nb, W.rnd);
            [tiles[gap], tiles[nxt]] = [tiles[nxt], tiles[gap]];
            last = gap;
            gap = nxt;
        }
        W.state = { N, tiles, moves: 0 };
        frame('<div class="sl-grid" role="grid" aria-label="Sliding puzzle" style="--n:4"></div><p class="gm-hint" aria-live="polite">Tap a tile next to the gap to slide it.</p>');
        paintSlide();
    }
    function paintSlide() {
        const st = W.state;
        W.dlg.querySelector('.sl-grid').innerHTML = st.tiles.map((t, i) => (t
            ? `<button type="button" class="sl-tile${t === i + 1 ? ' home' : ''}" data-t="${i}" aria-label="Tile ${t}">${t}</button>`
            : '<span class="sl-gap" aria-hidden="true"></span>')).join('');
        hint(`${st.moves} ${st.moves === 1 ? 'move' : 'moves'}`);
    }
    function slideTap(i) {
        const st = W.state, N = st.N;
        const gap = st.tiles.indexOf(0);
        const r = Math.floor(i / N), c = i % N, gr = Math.floor(gap / N), gc = gap % N;
        if (!(r === gr || c === gc)) return;
        startClock();
        // Slide a whole row or column of tiles towards the gap, like the real thing
        const step = r === gr ? (c < gc ? -1 : 1) : (r < gr ? -N : N);
        let g = gap;
        while (g !== i) { const nxt = g + step; [st.tiles[g], st.tiles[nxt]] = [st.tiles[nxt], st.tiles[g]]; g = nxt; st.moves++; }
        paintSlide();
        if (st.tiles.every((t, k) => t === (k + 1) % (N * N))) {
            setTimeout(() => finish({ won: true, moves: st.moves, summary: `Solved in ${st.moves} moves`,
                share: `🧩 I solved ${W.daily ? 'today’s' : 'a'} Sliding puzzle on Cordial in ${st.moves} moves and ${clockText(elapsed())}! #playnote` }), 300);
        }
    }

    // =====================================================================
    // Wordplay: a Scrabble-style board. Seven letters, six turns, bonus squares
    // =====================================================================
    const WP_N = 9, WP_TURNS = 6;
    const WP_VAL = { A: 1, B: 3, C: 3, D: 2, E: 1, F: 4, G: 2, H: 4, I: 1, J: 8, K: 5, L: 1, M: 3, N: 1, O: 1, P: 3, Q: 10, R: 1, S: 1, T: 1, U: 1, V: 4, W: 4, X: 8, Y: 4, Z: 10 };
    const WP_BAG = { A: 9, B: 2, C: 2, D: 4, E: 12, F: 2, G: 3, H: 2, I: 9, J: 1, K: 1, L: 4, M: 2, N: 6, O: 8, P: 2, Q: 1, R: 6, S: 4, T: 6, U: 4, V: 2, W: 2, X: 1, Y: 2, Z: 1 };
    // Bonus squares: triple word, double word, triple letter, double letter (the centre row holds the starting word)
    const WP_BONUS = (() => {
        const b = {};
        const put = (kind, list) => list.forEach(([r, c]) => { b[`${r},${c}`] = kind; });
        put('tw', [[0, 0], [0, 8], [8, 0], [8, 8]]);
        put('dw', [[1, 1], [2, 2], [6, 6], [7, 7], [1, 7], [2, 6], [6, 2], [7, 1]]);
        put('tl', [[1, 4], [4, 1], [4, 7], [7, 4]]);
        put('dl', [[0, 2], [0, 6], [2, 0], [6, 0], [8, 2], [8, 6], [2, 8], [6, 8], [3, 3], [3, 5], [5, 3], [5, 5]]);
        return b;
    })();
    const WP_BONUS_LABEL = { tw: '3W', dw: '2W', tl: '3L', dl: '2L' };
    // The dictionary (the public-domain ENABLE list, ~105,000 words) lives in Supabase; answers are remembered for the session
    const WP_LOOKED = new Map(); // WORD -> true / false
    async function wpUnknown(words) {
        const ask = [...new Set(words)].filter(w => !WP_LOOKED.has(w));
        if (ask.length) {
            const { data, error } = await client.rpc('diary_words_check', { p_words: ask });
            if (error) throw error;
            const bad = new Set((data || []).map(w => w.toUpperCase()));
            ask.forEach(w => WP_LOOKED.set(w, !bad.has(w)));
        }
        return words.filter(w => !WP_LOOKED.get(w));
    }
    function buildWordplay() {
        const rnd = W.rnd;
        const start = pick(FIVE, rnd).toUpperCase();
        const board = Array.from({ length: WP_N }, () => Array(WP_N).fill(''));
        [...start].forEach((ch, i) => { board[4][2 + i] = ch; });
        const bag = [];
        Object.entries(WP_BAG).forEach(([ch, n]) => { for (let i = 0; i < n; i++) bag.push(ch); });
        [...start].forEach(ch => bag.splice(bag.indexOf(ch), 1));
        const shuffled = shuffle(bag, rnd);
        W.state = { board, bag: shuffled, rack: shuffled.splice(0, 7), pending: [], sel: null, turn: 1, score: 0, best: null, log: [], busy: false };
        frame(`<div class="wp-top"><span class="wp-score" aria-live="polite"></span><span class="wp-turn"></span></div>
            <div class="wp-board" role="grid" aria-label="Board"></div>
            <p class="gm-hint" aria-live="polite">Tap a letter, then a square. Build off ${esc(start)}.</p>
            <div class="wp-rack" aria-label="Your letters"></div>
            <div class="wp-actions">
                <button type="button" class="ghost-btn" data-wp="shuffle">${ic('i-refresh')}Shuffle</button>
                <button type="button" class="ghost-btn" data-wp="recall">Recall</button>
                <button type="button" class="ghost-btn" data-wp="swap">Swap</button>
                <button type="button" class="primary-btn" data-wp="play">Play</button>
            </div>
            <button type="button" class="link-btn wp-end" data-wp="end">End game</button>`);
        paintWordplay();
    }
    const wpAt = (r, c) => {
        const st = W.state;
        if (r < 0 || c < 0 || r >= WP_N || c >= WP_N) return '';
        const p = st.pending.find(x => x.r === r && x.c === c);
        return p ? p.ch : st.board[r][c];
    };
    // Every word the pending tiles make, with its score; or an explanation of why the move doesn't work
    function wpMove() {
        const st = W.state, P = st.pending;
        if (!P.length) return { error: 'Place some letters first' };
        const sameRow = P.every(p => p.r === P[0].r), sameCol = P.every(p => p.c === P[0].c);
        if (!sameRow && !sameCol) return { error: 'Letters must go in one straight line' };
        const across = P.length > 1 ? sameRow : (wpAt(P[0].r, P[0].c - 1) || wpAt(P[0].r, P[0].c + 1));
        const [dr, dc] = across ? [0, 1] : [1, 0];
        // No gaps along the line
        const idx = P.map(p => (across ? p.c : p.r));
        for (let k = Math.min(...idx); k <= Math.max(...idx); k++) {
            if (!wpAt(across ? P[0].r : k, across ? k : P[0].c)) return { error: 'No gaps between your letters' };
        }
        const isNew = (r, c) => P.some(p => p.r === r && p.c === c);
        const wordFrom = (r, c, dr2, dc2) => {
            while (wpAt(r - dr2, c - dc2)) { r -= dr2; c -= dc2; }
            const cells = [];
            while (wpAt(r, c)) { cells.push([r, c]); r += dr2; c += dc2; }
            return cells;
        };
        const words = [];
        const main = wordFrom(P[0].r, P[0].c, dr, dc);
        if (main.length > 1) words.push(main);
        P.forEach(p => { const cross = wordFrom(p.r, p.c, dc, dr); if (cross.length > 1) words.push(cross); });
        if (!words.length) return { error: 'Make a word of two letters or more' };
        if (!words.some(w => w.some(([r, c]) => !isNew(r, c)))) return { error: 'Join onto a word already on the board' };
        let total = 0;
        const scored = words.map(cells => {
            let sum = 0, mult = 1;
            cells.forEach(([r, c]) => {
                let v = WP_VAL[wpAt(r, c)] || 0;
                if (isNew(r, c)) {
                    const b = WP_BONUS[`${r},${c}`];
                    if (b === 'dl') v *= 2; else if (b === 'tl') v *= 3; else if (b === 'dw') mult *= 2; else if (b === 'tw') mult *= 3;
                }
                sum += v;
            });
            const word = cells.map(([r, c]) => wpAt(r, c)).join('');
            total += sum * mult;
            return { word, points: sum * mult };
        });
        const bingo = P.length === 7 ? 50 : 0;
        return { words: scored, total: total + bingo, bingo };
    }
    function wpPaintTiles() {
        const st = W.state;
        const last = st.last || new Set();
        W.dlg.querySelector('.wp-board').innerHTML = st.board.map((row, r) => row.map((ch, c) => {
            const p = st.pending.find(x => x.r === r && x.c === c);
            const letter = p ? p.ch : ch;
            const b = WP_BONUS[`${r},${c}`];
            if (letter) return `<button type="button" class="wp-cell tile${p ? ' new' : ''}${!p && last.has(`${r},${c}`) ? ' last' : ''}" data-wc="${r},${c}" aria-label="${letter}${p ? ', tap to take back' : ''}"${p ? '' : ' tabindex="-1"'}>${letter}<sub>${WP_VAL[letter]}</sub></button>`;
            return `<button type="button" class="wp-cell${b ? ` ${b}` : ''}" data-wc="${r},${c}" aria-label="Empty${b ? `, ${WP_BONUS_LABEL[b]}` : ''}">${b ? WP_BONUS_LABEL[b] : ''}</button>`;
        }).join('')).join('');
        W.dlg.querySelector('.wp-rack').innerHTML = st.rack.map((ch, i) => (ch
            ? `<button type="button" class="wp-tile${st.sel === i ? ' sel' : ''}" data-wr="${i}" aria-label="${ch}, ${WP_VAL[ch]} points" aria-pressed="${st.sel === i}">${ch}<sub>${WP_VAL[ch]}</sub></button>`
            : '<span class="wp-tile empty" aria-hidden="true"></span>')).join('');
    }
    function paintWordplay() {
        if (W.match) return paintMatch();
        const st = W.state;
        const move = st.pending.length ? wpMove() : null;
        wpPaintTiles();
        W.dlg.querySelector('.wp-score').innerHTML = `<b>${st.score}</b> points`;
        W.dlg.querySelector('.wp-turn').textContent = `Turn ${Math.min(st.turn, WP_TURNS)} of ${WP_TURNS} · ${st.bag.length} in the bag`;
        const playBtn = W.dlg.querySelector('[data-wp="play"]');
        playBtn.disabled = !move || !!move.error || st.busy;
        playBtn.textContent = move && !move.error ? `Play · ${move.total}` : 'Play';
        if (move) hint(move.error || move.words.map(w => `${w.word} ${w.points}`).join(' + ') + (move.bingo ? ' + 50 for all seven!' : ''));
    }
    function wpDraw() {
        const st = W.state;
        st.rack = st.rack.map(ch => ch || st.bag.shift() || '');
    }
    function wpRecall() {
        const st = W.state;
        st.pending.forEach(p => { const k = st.rack.indexOf(''); if (k >= 0) st.rack[k] = p.ch; else st.rack.push(p.ch); });
        st.pending = [];
        st.sel = null;
    }
    function wpNextTurn() {
        const st = W.state;
        st.turn++;
        if (st.turn > WP_TURNS || !st.rack.some(Boolean)) return finishWordplay();
        paintWordplay();
    }
    async function wpAction(act) {
        if (W.match) return matchAction(act);
        const st = W.state;
        if (st.busy) return;
        startClock();
        if (act === 'shuffle') { wpRecall(); st.rack = shuffle(st.rack, Math.random); }
        else if (act === 'recall') wpRecall();
        else if (act === 'swap') {
            if (!st.bag.length) return hint('The bag is empty — nothing to swap');
            const ok = await app.ask({ title: 'Swap all your letters?', text: 'You get seven new letters, but it uses up this turn.', ok: 'Swap' });
            if (!ok || !W || W.done) return;
            wpRecall();
            const old = st.rack.filter(Boolean);
            st.rack = st.bag.splice(0, old.length);
            st.bag.push(...old);
            st.bag = shuffle(st.bag, W.rnd);
            st.log.push('⬜');
            hint('New letters');
            return wpNextTurn();
        } else if (act === 'end') {
            const ok = await app.ask({ title: 'End the game now?', text: `You’ll finish on ${st.score} points.`, ok: 'End game' });
            if (ok && W && !W.done) { wpRecall(); finishWordplay(); }
            return;
        } else if (act === 'play') {
            const move = wpMove();
            if (move.error) return hint(move.error);
            st.busy = true;
            paintWordplay();
            hint('Checking…');
            let bad = null;
            try {
                bad = (await wpUnknown(move.words.map(w => w.word)))[0] || null;
            } catch (e) {
                st.busy = false;
                paintWordplay();
                return hint('Couldn’t check the words — are you online?');
            }
            st.busy = false;
            if (!W || W.done) return;
            if (bad) {
                paintWordplay();
                W.dlg.querySelector('.wp-board').classList.add('shake');
                setTimeout(() => W && W.dlg.querySelector('.wp-board')?.classList.remove('shake'), 400);
                return hint(`${bad} isn’t in our dictionary`);
            }
            st.pending.forEach(p => { st.board[p.r][p.c] = p.ch; });
            st.pending = [];
            st.score += move.total;
            const top = move.words.reduce((a, b) => (b.points > a.points ? b : a));
            if (!st.best || top.points > st.best.points) st.best = top;
            st.log.push(move.total >= 30 ? '🟩' : move.total >= 15 ? '🟨' : '🟧');
            wpDraw();
            if (navigator.vibrate) navigator.vibrate(12);
            hint(`${move.words.map(w => w.word).join(', ')} · +${move.total}${move.bingo ? ' (all seven!)' : ''}`);
            return wpNextTurn();
        }
        paintWordplay();
    }
    function wordplayTapRack(i) {
        const st = W.state;
        if (st.busy || !st.rack[i]) return;
        if (W.match && st.locked) return hint('Wait for your turn');
        st.sel = st.sel === i ? null : i;
        paintWordplay();
    }
    function wordplayTapCell(r, c) {
        const st = W.state;
        if (st.busy) return;
        if (W.match && st.locked) return hint(st.m && st.m.status === 'active' ? 'Wait for your turn' : 'This match is over');
        const k = st.pending.findIndex(p => p.r === r && p.c === c);
        if (k >= 0) { // take a letter back
            const [p] = st.pending.splice(k, 1);
            const slot = st.rack.indexOf('');
            if (slot >= 0) st.rack[slot] = p.ch; else st.rack.push(p.ch);
            return paintWordplay();
        }
        if (st.board[r][c]) return;
        const i = st.sel;
        if (i === null || !st.rack[i]) return hint('Tap one of your letters first');
        if (!W.match) startClock();
        st.pending.push({ r, c, ch: st.rack[i] });
        st.rack[i] = '';
        st.sel = null;
        paintWordplay();
    }
    function finishWordplay() {
        const st = W.state;
        const best = st.best ? ` · best word ${st.best.word} (${st.best.points})` : '';
        finish({ won: st.score > 0, moves: st.score, summary: `${st.score} points in ${st.log.length} ${st.log.length === 1 ? 'turn' : 'turns'}${best}`,
            share: `🔤 Wordplay on Cordial${W.daily ? ` · ${utcDay()}` : ''}: ${st.score} points${best}\n${st.log.join('')}\n#playnote` });
    }

    // =====================================================================
    // Wordplay with friends: 2 to 4 players take turns on one board. The server deals, checks and scores every move.
    // =====================================================================
    const MX = { list: null, people: {}, loading: false, channel: null, t: 0 };
    const myId = () => s.profile && s.profile.id;
    const who = id => MX.people[id] || { id, display_name: 'Someone', username: '' };
    const firstName = id => (id === myId() ? 'You' : String(who(id).display_name || 'Someone').split(' ')[0]);
    async function loadPeople(ids) {
        (s.friends || []).forEach(f => { MX.people[f.id] = f; });
        if (s.profile) MX.people[s.profile.id] = s.profile;
        const need = [...new Set(ids)].filter(id => id && !MX.people[id]);
        if (!need.length) return;
        const { data } = await client.from('diary_profiles').select('id, username, display_name, avatar_path').in('id', need);
        (data || []).forEach(p => { MX.people[p.id] = p; });
    }
    async function loadMatches() {
        if (!myId() || MX.loading) return;
        MX.loading = true;
        const { data } = await client.from('diary_wp_matches').select('id, players, out_players, status, turn, scores, bag_count, winner, last_move, updated_at')
            .order('updated_at', { ascending: false }).limit(30);
        MX.list = data || [];
        await loadPeople(MX.list.flatMap(m => m.players));
        MX.loading = false;
        subscribeMatches();
        if (window.diaryPlay && window.diaryPlay.repaint && app.state.view === 'play') window.diaryPlay.repaint();
    }
    // Live: a move by anyone in your matches updates the list and the open board
    function subscribeMatches() {
        if (MX.channel || !myId()) return;
        const ch = MX.channel = client.channel(`wp-matches-${myId()}-${Date.now()}`)
            .on('postgres_changes', { event: '*', schema: 'public', table: 'diary_wp_matches' }, payload => {
                const m = payload.new || {};
                clearTimeout(MX.t);
                MX.t = setTimeout(loadMatches, 250);
                if (W && W.match && W.match === m.id) refreshMatch();
            })
            .subscribe(status => {
                if (MX.channel !== ch) return;
                if (status === 'SUBSCRIBED') {
                    MX.retry = 0;
                    if (MX.lost) { MX.lost = false; resync(); } // catch up on anything missed while we were away
                } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
                    MX.lost = true;
                    MX.channel = null;
                    client.removeChannel(ch).catch(() => {});
                    clearTimeout(MX.rt);
                    MX.rt = setTimeout(subscribeMatches, Math.min(30000, 1000 * 2 ** (MX.retry = (MX.retry || 0) + 1)));
                }
            });
    }
    // Back from the background, the lock screen or a dead zone: fetch the latest board and scores at once
    function resync() {
        if (!myId()) return;
        loadMatches();
        if (W && W.match) refreshMatch();
        if (!MX.channel && MX.list !== null) subscribeMatches();
    }
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') resync(); });
    window.addEventListener('online', () => { resync(); if (W && W.match && W.state.m) paintMatch(); });
    window.addEventListener('offline', () => { if (W && W.match && W.state.m) paintMatch(); });
    window.addEventListener('pageshow', e => { if (e.persisted) resync(); });
    // Safety net while a match is open: check every 10 seconds in case a live update was missed
    setInterval(() => {
        if (W && W.match && W.state && W.state.m && !W.state.busy && document.visibilityState === 'visible' && navigator.onLine) refreshMatch();
    }, 10000);
    const isMyTurn = m => m.status === 'active' && m.players[m.turn] === myId() && !m.out_players.includes(myId());
    function statusText(m) {
        if (m.status === 'active') return isMyTurn(m) ? 'Your turn' : `${firstName(m.players[m.turn])}’s turn`;
        return m.winner === myId() ? 'You won' : m.winner ? `${firstName(m.winner)} won` : 'Draw';
    }
    function matchRow(m) {
        const others = m.players.filter(p => p !== myId());
        const mine = isMyTurn(m);
        return `
            <button type="button" class="wpm-row${mine ? ' mine' : ''}${m.status !== 'active' ? ' over' : ''}" data-wpm="open" data-id="${esc(m.id)}">
                <span class="wpm-avs">${others.slice(0, 3).map(p => I.avatar(who(p), 'sm')).join('')}</span>
                <span class="wpm-text"><strong>${esc(others.map(p => who(p).display_name || 'Someone').join(', '))}</strong>
                    <small>${m.players.map(p => `${esc(firstName(p))} ${Number(m.scores[p] || 0)}`).join(' · ')}</small></span>
                <span class="wpm-status">${esc(statusText(m))}</span>
            </button>`;
    }
    function matchesHTML() {
        if (!myId() || G.off.has('wordplay')) return '';
        if (MX.list === null) loadMatches();
        const list = MX.list || [];
        const active = list.filter(m => m.status === 'active').sort((a, b) => isMyTurn(b) - isMyTurn(a));
        const done = list.filter(m => m.status !== 'active').slice(0, 4);
        return `
            <section class="pl-section wpm" aria-labelledby="wpm-h">
                <header class="pl-sec-head"><h3 id="wpm-h">Wordplay with friends</h3><p class="pl-note">One board, up to four players — take your turn whenever you like</p></header>
                <div class="wpm-list">
                    <button type="button" class="wpm-new" data-wpm="new">
                        <span class="wpm-new-ic">${ic('i-plus')}</span>
                        <span class="wpm-text"><strong>New match</strong><small>Challenge one, two or three friends</small></span>
                    </button>
                    ${MX.list === null ? '<div class="wpm-skel" aria-busy="true"></div>' : active.map(matchRow).join('')}
                    ${done.length ? `<p class="wpm-sub">Finished</p>${done.map(matchRow).join('')}` : ''}
                </div>
            </section>`;
    }

    // ---------- Starting a match ----------
    function newMatchDialog() {
        const friends = (s.friends || []).slice().sort((a, b) => String(a.display_name).localeCompare(String(b.display_name)));
        if (!friends.length) return app.showToast('Add some friends first — then you can challenge them');
        const dlg = document.createElement('dialog');
        dlg.className = 'gm wpm-pick';
        dlg.setAttribute('aria-label', 'New Wordplay match');
        dlg.innerHTML = `
            <form class="gm-card" method="dialog">
                <header class="gm-head">
                    <button type="button" class="icon-btn" data-x aria-label="Close">${ic('i-close')}</button>
                    <div class="gm-title"><strong>${ic('i-g-tiles')}New match</strong><small>Pick one, two or three friends</small></div>
                </header>
                <div class="gm-body wpm-pick-body">
                    ${friends.length > 8 ? '<input type="search" class="wpm-find" placeholder="Search friends" aria-label="Search friends">' : ''}
                    <div class="wpm-friends">${friends.map(f => `
                        <label class="wpm-friend" data-name="${esc(String(f.display_name || '').toLowerCase())} ${esc(String(f.username || '').toLowerCase())}">
                            <input type="checkbox" value="${esc(f.id)}">
                            ${I.avatar(f, 'sm')}
                            <span><strong>${esc(f.display_name || 'Friend')}</strong><small>@${esc(f.username || '')}</small></span>
                            <span class="wpm-check" aria-hidden="true">${ic('i-check')}</span>
                        </label>`).join('')}</div>
                </div>
                <footer class="wpm-pick-foot"><button type="submit" class="primary-btn" disabled>Start match</button></footer>
            </form>`;
        document.body.append(dlg);
        const btn = dlg.querySelector('[type="submit"]');
        const picked = () => [...dlg.querySelectorAll('input[type="checkbox"]:checked')].map(i => i.value);
        dlg.addEventListener('change', () => {
            const ids = picked();
            dlg.querySelectorAll('input[type="checkbox"]').forEach(i => { i.disabled = !i.checked && ids.length >= 3; });
            btn.disabled = !ids.length;
            btn.textContent = ids.length ? `Start a ${ids.length + 1}-player match` : 'Start match';
        });
        dlg.addEventListener('input', e => {
            if (!e.target.classList.contains('wpm-find')) return;
            const q = e.target.value.trim().toLowerCase();
            dlg.querySelectorAll('.wpm-friend').forEach(l => { l.hidden = !!q && !l.dataset.name.includes(q); });
        });
        dlg.addEventListener('click', e => { if (e.target.closest('[data-x]')) dlg.close(); });
        dlg.addEventListener('close', () => dlg.remove());
        dlg.addEventListener('submit', async e => {
            e.preventDefault();
            btn.disabled = true;
            btn.textContent = 'Dealing the letters…';
            const ok = await startMatch(picked());
            if (ok) dlg.close(); else { btn.disabled = false; btn.textContent = 'Start match'; }
        });
        dlg.showModal();
    }
    async function startMatch(ids) {
        for (let tries = 0; tries < 3; tries++) {
            const { data, error } = await client.rpc('diary_wp_new', { p_opponents: ids, p_start: pick(FIVE, Math.random).toUpperCase() });
            if (!error) { loadMatches(); openMatch(data); return true; }
            if (!/starting word/i.test(error.message || '')) { app.showToast(error.message || 'Couldn’t start the match'); return false; }
        }
        app.showToast('Couldn’t start the match — try again');
        return false;
    }

    // ---------- Playing a match ----------
    async function openMatch(id) {
        if (!id) return;
        if (!myId()) { // opened from a link before sign-in finished: try again shortly
            let n = 0;
            const again = setInterval(() => { if (myId() || ++n > 40) { clearInterval(again); if (myId()) openMatch(id); } }, 250);
            return;
        }
        closeWin();
        const dlg = document.createElement('dialog');
        dlg.className = 'gm';
        dlg.setAttribute('aria-label', 'Wordplay match');
        document.body.append(dlg);
        W = { game: 'wordplay', match: id, dlg, daily: false, started: 0, timer: null, done: false, state: { board: [], rack: [], pending: [], sel: null, busy: false, last: new Set() } };
        W.chat = { list: [], unread: 0, open: false, ch: null, off: false, ready: false };
        const chat = W.chat;
        dlg.addEventListener('close', () => { chatStop(chat); dlg.remove(); if (W && W.dlg === dlg) W = null; loadMatches(); });
        dlg.addEventListener('click', onChatClick);
        dlg.addEventListener('submit', onChatSubmit);
        dlg.innerHTML = '<div class="gm-card"><div class="gm-body"><p class="gm-hint">Opening the board…</p></div></div>';
        dlg.showModal();
        await refreshMatch(true);
        chatStart(id);
    }
    const sortedLetters = arr => arr.filter(Boolean).sort().join('');
    // Give up waiting after ms (the request may still finish; we check the board afterwards)
    const withTimeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(Object.assign(new Error('timed out'), { timeout: true })), ms))]);
    async function refreshMatch(first = false) {
        if (!W || !W.match) return;
        const id = W.match;
        let m = null, error = null, rk = null;
        try {
            const [a, b] = await Promise.all([
                withTimeout(client.from('diary_wp_matches').select('*').eq('id', id).maybeSingle(), 12000),
                withTimeout(client.from('diary_wp_racks').select('rack').eq('match_id', id).eq('user_id', myId()).maybeSingle(), 12000)
            ]);
            m = a.data; error = a.error || b.error; rk = b.data;
        } catch (e) { error = e; }
        if (!W || W.match !== id) return;
        if (error && W.state.m) { paintMatch(); return; } // offline or slow: keep the board you have, try again soon
        if (error || !m) { W.dlg.querySelector('.gm-body').innerHTML = '<p class="gm-hint">This match isn’t available any more.</p><button type="button" class="ghost-btn" data-gm="close">Close</button>'; return; }
        await loadPeople(m.players);
        if (!W || W.match !== id) return;
        const st = W.state;
        const moved = !st.m || st.m.board !== m.board || st.m.turn !== m.turn;
        if (st.m && !first) {
            const gains = {};
            m.players.forEach(p => { const d = Number(m.scores[p] || 0) - Number(st.m.scores[p] || 0); if (d > 0) gains[p] = d; });
            if (Object.keys(gains).length) { st.gains = gains; st.gainAt = Date.now(); }
        }
        st.m = m;
        st.board = Array.from({ length: WP_N }, (_, r) => [...m.board.slice(r * WP_N, r * WP_N + WP_N)].map(ch => (ch === '.' ? '' : ch)));
        const letters = (rk && rk.rack) || '';
        // Keep the letters you're arranging unless the board moved on or your rack changed
        const mine = sortedLetters([...st.rack, ...st.pending.map(p => p.ch)]);
        if (first || moved || mine !== sortedLetters([...letters])) { st.rack = [...letters]; st.pending = []; st.sel = null; }
        st.last = new Set(((m.last_move && m.last_move.cells) || []).map(x => `${Math.floor(x / WP_N)},${x % WP_N}`));
        if (!W.dlg.querySelector('.wpm-game')) matchFrame();
        paintMatch();
        if (m.status === 'finished' && !st.celebrated) { st.celebrated = true; celebrate(m); }
    }
    function matchFrame() {
        W.dlg.innerHTML = `
            <div class="gm-card gm-wordplay wpm-game">
                <header class="gm-head">
                    <button type="button" class="icon-btn" data-gm="close" aria-label="Close">${ic('i-close')}</button>
                    <div class="gm-title"><strong>${ic('i-g-tiles')}Wordplay</strong><small class="wpm-bag"></small></div>
                    <button type="button" class="icon-btn wpc-btn" data-wpc="open" aria-label="Match chat" hidden>${ic('i-chat')}<b class="wpc-dot" hidden></b></button>
                </header>
                <div class="gm-body">
                    <div class="wpm-players" role="list" aria-label="Players"></div>
                    <button type="button" class="wpc-ticker" data-wpc="open" hidden></button>
                    <div class="wp-board" role="grid" aria-label="Board"></div>
                    <p class="gm-hint" aria-live="polite"></p>
                    <div class="wp-rack" aria-label="Your letters"></div>
                    <div class="wp-actions wpm-actions">
                        <button type="button" class="ghost-btn" data-wp="shuffle">Shuffle</button>
                        <button type="button" class="ghost-btn" data-wp="swap">Swap</button>
                        <button type="button" class="ghost-btn" data-wp="pass">Pass</button>
                        <button type="button" class="primary-btn" data-wp="play">Play</button>
                    </div>
                    <div class="wpc-react" role="group" aria-label="React" hidden>${CHAT_EMOJI.map(e => `<button type="button" data-wpc="react" data-emoji="${e}" aria-label="React ${e}">${e}</button>`).join('')}</div>
                    <div class="wpm-foot"></div>
                </div>
                <div class="wpc-fx" aria-hidden="true"></div>
                <div class="wpc-sheet" role="dialog" aria-label="Match chat" hidden>
                    <header class="wpc-head"><strong>Match chat</strong><small>Only the players see this</small><button type="button" class="icon-btn" data-wpc="close" aria-label="Back to the board">${ic('i-close')}</button></header>
                    <div class="wpc-list" role="log" aria-live="polite"></div>
                    <form class="wpc-form">
                        <input class="wpc-input" maxlength="300" placeholder="Say something to the table…" aria-label="Message the other players" autocomplete="off" enterkeyhint="send">
                        <button type="submit" class="wpc-send" aria-label="Send">${ic('i-send')}</button>
                    </form>
                </div>
            </div>`;
        if (W.chat) paintChat();
    }

    // ---------- Talking while you play: comments and quick reactions in a match ----------
    // Saved for the match's players only (the database checks that), and live while the board is open.
    // Until the match chat is switched on on the server, none of this shows.
    const CHAT_EMOJI = ['👏', '🔥', '😂', '😮', '😅', '🤝', '💯', '🎉'];
    async function chatStart(id) {
        const chat = W && W.chat;
        if (!chat || W.match !== id) return;
        const { data, error } = await client.from('diary_wp_chat').select('*').eq('match_id', id).order('created_at', { ascending: true }).limit(150);
        if (!W || W.chat !== chat) return;
        if (error) {
            // Saved chat isn't switched on on the server yet: talk live instead, between the players who have
            // this board open (nothing is stored; messages from anyone who isn't in this match are ignored)
            if (!navigator.onLine) { chat.off = true; paintChat(); return; }
            chat.live = true;
            chat.ready = true;
            chat.ch = client.channel(`wp-live-${id}`, { config: { broadcast: { self: false } } })
                .on('broadcast', { event: 'chat' }, ({ payload }) => { if (W && W.chat === chat) chatIn(chat, checkLive(payload)); })
                .on('broadcast', { event: 'unsay' }, ({ payload }) => {
                    if (!payload || !W || W.chat !== chat) return;
                    chat.list = chat.list.filter(x => !(x.id === payload.id && x.user_id === payload.user_id));
                    paintChat();
                })
                .subscribe(st => { chat.joined = st === 'SUBSCRIBED'; });
            paintChat();
            return;
        }
        chat.list = data || [];
        chat.ready = true;
        chat.ch = client.channel(`wp-chat-${id}-${Date.now()}`)
            .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'diary_wp_chat', filter: `match_id=eq.${id}` }, p => chatIn(chat, p.new))
            .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'diary_wp_chat' }, p => { if (p.old && p.old.id) { chat.list = chat.list.filter(x => x.id !== p.old.id); if (W && W.chat === chat) paintChat(); } })
            .subscribe();
        paintChat();
    }
    // A live message is only shown if it's well-formed and from one of this match's players
    function checkLive(p) {
        const m = W && W.state && W.state.m;
        if (!p || !m || !m.players.includes(p.user_id) || typeof p.id !== 'string' || p.id.length > 40) return null;
        if (p.kind === 'reaction' && CHAT_EMOJI.includes(p.emoji)) return { id: p.id, match_id: m.id, user_id: p.user_id, kind: 'reaction', emoji: p.emoji, created_at: new Date().toISOString() };
        if (p.kind === 'comment' && typeof p.body === 'string' && p.body.trim()) return { id: p.id, match_id: m.id, user_id: p.user_id, kind: 'comment', body: p.body.trim().slice(0, 300), created_at: new Date().toISOString() };
        return null;
    }
    function chatStop(chat) { if (chat && chat.ch) { client.removeChannel(chat.ch); chat.ch = null; } }
    function chatIn(chat, row) {
        if (!row || chat.list.some(x => x.id === row.id)) return;
        chat.list.push(row);
        if (chat.list.length > 200) chat.list.shift();
        if (!W || W.chat !== chat) return;
        if (row.kind === 'reaction') floatReaction(row);
        else if (!chat.open && row.user_id !== myId()) chat.unread++;
        paintChat();
    }
    function floatReaction(row) {
        const fx = W && W.dlg.querySelector('.wpc-fx');
        if (!fx || fx.childElementCount > 8) return;
        const el = document.createElement('span');
        el.className = 'wpc-bubble';
        el.style.setProperty('--x', `${Math.round(10 + Math.random() * 70)}%`);
        el.innerHTML = `<b></b><small></small>`;
        el.querySelector('b').textContent = row.emoji;
        el.querySelector('small').textContent = firstName(row.user_id);
        fx.append(el);
        setTimeout(() => el.remove(), window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 1400 : 2400);
    }
    function paintChat() {
        const chat = W && W.chat;
        if (!chat || !W.dlg.querySelector('.wpm-game')) return;
        const d = W.dlg;
        const on = chat.ready && !chat.off;
        const m = W.state.m;
        const canTalk = on && m && !m.out_players.includes(myId());
        d.querySelector('.wpc-btn').hidden = !on;
        d.querySelector('.wpc-react').hidden = !canTalk;
        const dot = d.querySelector('.wpc-dot');
        dot.hidden = !chat.unread;
        dot.textContent = chat.unread > 9 ? '9+' : String(chat.unread);
        d.querySelector('.wpc-btn').setAttribute('aria-label', `Match chat${chat.unread ? `, ${chat.unread} new` : ''}`);
        // The latest comment, one line, under the scores
        const last = [...chat.list].reverse().find(x => x.kind === 'comment');
        const ticker = d.querySelector('.wpc-ticker');
        ticker.hidden = !on || !last;
        if (last) { ticker.innerHTML = `${ic('i-chat')}<span><b></b> </span>`; ticker.querySelector('b').textContent = `${firstName(last.user_id)}:`; ticker.querySelector('span').append(last.body); }
        const note = d.querySelector('.wpc-head small');
        if (note) note.textContent = chat.live ? 'Live — seen by players who have the board open' : 'Only the players see this';
        if (!chat.open) return;
        const list = d.querySelector('.wpc-list');
        const near = list.scrollHeight - list.scrollTop - list.clientHeight < 80;
        const items = chat.list;
        list.innerHTML = items.length ? items.map(x => {
            const mine = x.user_id === myId();
            const time = new Date(x.created_at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
            return x.kind === 'reaction'
                ? `<p class="wpc-rx">${esc(firstName(x.user_id))} reacted ${esc(x.emoji)} <time>${time}</time></p>`
                : `<div class="wpc-msg${mine ? ' mine' : ''}" data-wpc="msg" data-id="${esc(x.id)}" ${mine ? 'role="button" tabindex="0" aria-label="Your message — tap to delete"' : ''}>
                        ${I.avatar(who(x.user_id), 'sm')}<div><span class="wpc-who">${esc(firstName(x.user_id))} <time>${time}</time></span><p></p></div></div>`;
        }).join('') : `<p class="wpc-empty">Say hi, cheer a good move, or call a bluff — only the players see this.${chat.live ? ' Messages go to whoever has the board open right now.' : ''}</p>`;
        list.querySelectorAll('.wpc-msg p').forEach((p, i) => { const msgs = items.filter(x => x.kind === 'comment'); if (msgs[i]) p.textContent = msgs[i].body; });
        if (near || chat.justOpened) { list.scrollTop = list.scrollHeight; chat.justOpened = false; }
        const form = d.querySelector('.wpc-form');
        form.hidden = !canTalk;
    }
    async function chatSend(fields) {
        const chat = W && W.chat;
        if (!chat || chat.off) return;
        if (chat.live) {
            if (!chat.joined) return app.showToast('Connecting to the match… try again in a moment');
            // Easy does it: at most 20 a minute, like saved chat
            chat.sent = (chat.sent || []).filter(t => Date.now() - t < 60000);
            if (chat.sent.length >= 20) return app.showToast('Slow down a little — try again in a moment');
            chat.sent.push(Date.now());
            const row = { id: Math.random().toString(36).slice(2, 14), match_id: W.match, user_id: myId(), created_at: new Date().toISOString(), ...fields };
            chat.ch.send({ type: 'broadcast', event: 'chat', payload: { id: row.id, user_id: row.user_id, kind: row.kind, body: row.body, emoji: row.emoji } }).catch(() => {});
            return chatIn(chat, row);
        }
        const { data, error } = await client.from('diary_wp_chat').insert({ match_id: W.match, ...fields }).select('*').single();
        if (error) return app.showToast(/guest|anonymous|account/i.test(error.message || '') ? 'Create a free account to chat in games' : (error.message && error.message.length < 80 ? error.message : 'Couldn’t send that — try again'));
        chatIn(chat, data);
    }
    async function onChatClick(e) {
        const el = e.target.closest('[data-wpc]');
        if (!el || !W || !W.chat) return;
        const chat = W.chat, what = el.dataset.wpc;
        if (what === 'open') {
            chat.open = true; chat.unread = 0; chat.justOpened = true;
            W.dlg.querySelector('.wpc-sheet').hidden = false;
            paintChat();
            if (window.matchMedia('(pointer: fine)').matches) setTimeout(() => W && W.dlg.querySelector('.wpc-input')?.focus(), 120);
        } else if (what === 'close') {
            chat.open = false;
            W.dlg.querySelector('.wpc-sheet').hidden = true;
            paintChat();
        } else if (what === 'react') {
            const emoji = el.dataset.emoji;
            if (!CHAT_EMOJI.includes(emoji)) return;
            try { if (navigator.vibrate) navigator.vibrate(8); } catch (err) { /* no haptics */ }
            chatSend({ kind: 'reaction', emoji });
        } else if (what === 'msg' && el.classList.contains('mine')) {
            if (!(await app.ask({ title: 'Delete this message?', text: 'It disappears for everyone in the match.', ok: 'Delete', danger: true }))) return;
            const id = el.dataset.id;
            if (chat.live) chat.ch.send({ type: 'broadcast', event: 'unsay', payload: { id, user_id: myId() } }).catch(() => {});
            else {
                const { error } = await client.from('diary_wp_chat').delete().eq('id', id);
                if (error) return app.showToast('Couldn’t delete it — try again');
            }
            chat.list = chat.list.filter(x => x.id !== id);
            paintChat();
        }
    }
    function onChatSubmit(e) {
        if (!e.target.classList.contains('wpc-form')) return;
        e.preventDefault();
        const input = e.target.querySelector('.wpc-input');
        const text = input.value.trim();
        if (!text) return;
        input.value = '';
        chatSend({ kind: 'comment', body: text.slice(0, 300) });
    }
    // ---------- The winner's moment: a pop-up with confetti ----------
    const SEEN_KEY = 'cordialWpCelebrated';
    function celebrated(id) { try { return (JSON.parse(localStorage.getItem(SEEN_KEY) || '[]')).includes(id); } catch (e) { return false; } }
    function markCelebrated(id) {
        try { const all = JSON.parse(localStorage.getItem(SEEN_KEY) || '[]').filter(x => x !== id); all.push(id); localStorage.setItem(SEEN_KEY, JSON.stringify(all.slice(-100))); } catch (e) { /* private mode */ }
    }
    function celebrate(m) {
        if (!W || celebrated(m.id)) return;
        markCelebrated(m.id);
        const host = W.dlg.querySelector('.wpm-game');
        if (!host) return;
        const me = myId();
        const iWon = m.winner === me;
        const score = p => Number(m.scores[p] || 0);
        const ranked = [...m.players].sort((a, b) => (b === m.winner) - (a === m.winner) || score(b) - score(a));
        const resigned = m.last_move && m.last_move.kind === 'resign';
        const title = !m.winner ? 'It’s a draw!' : iWon ? 'You won! 🎉' : `Congratulations, ${esc(firstName(m.winner))}!`;
        const sub = !m.winner ? 'Well played, everyone — evenly matched to the last tile.'
            : resigned && m.players.length - m.out_players.length <= 1 ? `${iWon ? 'You’re' : `${esc(firstName(m.winner))} is`} the last one standing with ${score(m.winner)} points.`
            : iWon ? `${score(me)} points — what a game.` : `${esc(firstName(m.winner))} won with ${score(m.winner)} points. Good game!`;
        const box = document.createElement('div');
        box.className = 'wpw';
        box.setAttribute('role', 'alertdialog');
        box.setAttribute('aria-labelledby', 'wpw-title');
        box.innerHTML = `
            <div class="wpw-card">
                <div class="wpw-trophy" aria-hidden="true">${m.winner ? '🏆' : '🤝'}</div>
                <h3 id="wpw-title">${title}</h3>
                <p class="wpw-sub">${sub}</p>
                <ol class="wpw-standings">${ranked.map((p, i) => `
                    <li class="${p === m.winner ? 'win' : ''}${m.out_players.includes(p) ? ' out' : ''}">
                        <span class="wpw-place">${p === m.winner ? '🥇' : i + 1}</span>
                        ${I.avatar(who(p), 'sm')}
                        <span class="wpw-name">${esc(firstName(p))}${m.out_players.includes(p) ? ' <small>left</small>' : ''}</span>
                        <b>${score(p)}</b>
                    </li>`).join('')}</ol>
                <div class="wpw-acts">
                    <button type="button" class="primary-btn" data-wp="rematch">${ic('i-refresh')}Rematch</button>
                    <button type="button" class="ghost-btn" data-wpw="close">See the board</button>
                </div>
            </div>`;
        host.append(box);
        box.addEventListener('click', e => {
            if (e.target === box || e.target.closest('[data-wpw="close"]')) { box.classList.add('out'); setTimeout(() => box.remove(), 220); }
            else if (e.target.closest('[data-wp="rematch"]')) box.remove();
        });
        box.querySelector('[data-wpw="close"]').focus({ preventScroll: true });
        try { if (navigator.vibrate) navigator.vibrate(iWon ? [20, 60, 30] : 15); } catch (e) { /* no haptics */ }
        if (m.winner && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) confettiRain(host, iWon ? 160 : 110);
    }
    // A burst of confetti over the match: drawn on a canvas, gone in a few seconds
    function confettiRain(host, count) {
        const c = document.createElement('canvas');
        c.className = 'wpw-confetti';
        c.setAttribute('aria-hidden', 'true');
        host.append(c);
        const dpr = Math.min(2, window.devicePixelRatio || 1);
        const w = host.clientWidth, h = host.clientHeight;
        c.width = w * dpr; c.height = h * dpr;
        const ctx = c.getContext('2d');
        ctx.scale(dpr, dpr);
        const colors = ['#8b8cf8', '#f59e0b', '#10b981', '#ec4899', '#38bdf8', '#facc15', '#f43f5e'];
        const bits = Array.from({ length: count }, (_, i) => ({
            x: w / 2 + (Math.random() - 0.5) * w * 0.3, y: h * 0.32,
            vx: (Math.random() - 0.5) * 13, vy: -6 - Math.random() * 11,
            r: Math.random() * Math.PI, vr: (Math.random() - 0.5) * 0.35,
            s: 5 + Math.random() * 6, c: colors[i % colors.length], round: Math.random() < 0.3
        }));
        const t0 = performance.now();
        const frame = now => {
            const t = now - t0;
            ctx.clearRect(0, 0, w, h);
            ctx.globalAlpha = t > 2600 ? Math.max(0, 1 - (t - 2600) / 900) : 1;
            for (const b of bits) {
                b.vy += 0.32; b.vx *= 0.99; b.vy *= 0.99;
                b.x += b.vx; b.y += b.vy; b.r += b.vr;
                ctx.save();
                ctx.translate(b.x, b.y);
                ctx.rotate(b.r);
                ctx.fillStyle = b.c;
                if (b.round) { ctx.beginPath(); ctx.arc(0, 0, b.s / 2.2, 0, Math.PI * 2); ctx.fill(); }
                else ctx.fillRect(-b.s / 2, -b.s / 4, b.s, b.s / 2 * (0.4 + Math.abs(Math.sin(b.r * 2))));
                ctx.restore();
            }
            if (t < 3500 && c.isConnected) requestAnimationFrame(frame);
            else c.remove();
        };
        requestAnimationFrame(frame);
    }

    function lastText(m) {
        const lm = m.last_move;
        if (!lm) return '';
        const n = firstName(lm.user);
        if (lm.kind === 'play') return `${n} played ${(lm.words || []).map(w => w.word).join(', ')} for ${lm.points}${lm.bingo ? ' (all seven!)' : ''}.`;
        if (lm.kind === 'pass') return `${n} passed.`;
        if (lm.kind === 'swap') return `${n} swapped letters.`;
        if (lm.kind === 'resign') return `${n} left the match.`;
        return '';
    }
    function paintMatch() {
        const st = W.state, m = st.m, me = myId();
        const active = m.status === 'active';
        const out = m.out_players.includes(me);
        const mine = isMyTurn(m);
        st.locked = !mine;
        wpPaintTiles();
        W.dlg.querySelector('.wp-board').classList.toggle('locked', !mine);
        W.dlg.querySelector('.wpm-players').innerHTML = m.players.map((p, i) => `
            <span class="wpm-p${active && i === m.turn ? ' turn' : ''}${m.out_players.includes(p) ? ' out' : ''}${!active && m.winner === p ? ' won' : ''}" role="listitem"
                aria-label="${esc(who(p).display_name || 'Player')}: ${Number(m.scores[p] || 0)} points${active && i === m.turn ? ', playing now' : ''}">
                ${I.avatar(who(p), 'sm')}<span><strong>${esc(firstName(p))}</strong><b>${Number(m.scores[p] || 0)}</b></span>
                ${st.gains && st.gains[p] && Date.now() - st.gainAt < 3500 ? `<em class="wpm-gain" aria-hidden="true">+${st.gains[p]}</em>` : ''}
                ${!active && m.winner === p ? ic('i-trophy', 'wpm-crown') : ''}
            </span>`).join('');
        W.dlg.querySelector('.wpm-bag').textContent = !navigator.onLine ? 'Offline — your letters stay put' : active ? `${m.bag_count} ${m.bag_count === 1 ? 'letter' : 'letters'} left in the bag` : 'Match over';
        W.dlg.querySelector('.wpm-game')?.classList.toggle('offline', !navigator.onLine);
        const move = mine && st.pending.length ? wpMove() : null;
        const play = W.dlg.querySelector('[data-wp="play"]');
        play.disabled = !mine || !move || !!move.error || st.busy;
        play.textContent = move && !move.error ? `Play · ${move.total}` : 'Play';
        W.dlg.querySelector('[data-wp="swap"]').disabled = !mine || st.busy || m.bag_count < 1;
        W.dlg.querySelector('[data-wp="pass"]').disabled = !mine || st.busy;
        W.dlg.querySelector('.wpm-actions').hidden = !active || out;
        W.dlg.querySelector('.wp-rack').hidden = !active || out;
        W.dlg.querySelector('.wpm-foot').innerHTML = !active
            ? `<button type="button" class="primary-btn" data-wp="rematch">${ic('i-refresh')}Rematch</button><button type="button" class="ghost-btn" data-wp="share">${ic('i-share')}Share</button>`
            : out ? '<small class="muted">You left this match — the others play on</small>'
            : '<button type="button" class="link-btn" data-wp="resign">Resign</button>';
        const last = lastText(m);
        paintChat();
        if (st.busy) return;
        if (move) hint(move.error || move.words.map(w => `${w.word} ${w.points}`).join(' + ') + (move.bingo ? ' + 50 for all seven!' : ''));
        else if (!active) hint(m.winner === me ? `You won with ${Number(m.scores[me] || 0)} points!` : m.winner ? `${who(m.winner).display_name || 'Someone'} won this one.` : 'It’s a draw!');
        else if (out) hint(last);
        else if (mine) hint(last ? `${last} Your turn.` : 'Your turn — build off the word in the middle.');
        else hint(`${last ? `${last} ` : ''}Waiting for ${firstName(m.players[m.turn])}…`);
    }
    async function matchCall(name, args, done) {
        const st = W.state, id = W.match;
        st.busy = true;
        paintMatch();
        hint(name === 'diary_wp_play' ? 'Checking your words…' : 'One moment…');
        if (!navigator.onLine) {
            st.busy = false;
            paintMatch();
            return hint('You’re offline. Your letters stay on the board — tap again when you’re back online.');
        }
        const movesBefore = st.m ? st.m.moves : 0;
        let data = null, error = null;
        try { ({ data, error } = await withTimeout(client.rpc(name, args), 15000)); } catch (e) { error = e; }
        if (!W || W.match !== id) return;
        st.busy = false;
        // No answer (a timeout or a dropped connection): the move may still have landed, so look before saying anything
        if (error && (error.timeout || /fetch|network|timed? ?out|load failed/i.test(error.message || ''))) {
            hint('The connection is slow — checking whether that went through…');
            await refreshMatch();
            if (!W || W.match !== id) return;
            if (W.state.m && W.state.m.moves > movesBefore) { if (navigator.vibrate) navigator.vibrate(12); return; }
            return hint('That didn’t go through — check your connection and try again. Your letters are still on the board.');
        }
        if (error) {
            paintMatch();
            if (name === 'diary_wp_play') {
                const b = W.dlg.querySelector('.wp-board');
                b.classList.add('shake');
                setTimeout(() => b.classList.remove('shake'), 400);
            }
            return hint(error.message || 'That didn’t work — try again');
        }
        if (navigator.vibrate) navigator.vibrate(12);
        st.pending = [];
        await refreshMatch(true);
        if (done) done(data);
    }
    async function matchAction(act) {
        const st = W.state, m = st.m, id = W.match;
        if (!m || st.busy) return;
        if (act === 'shuffle') { wpRecall(); st.rack = shuffle(st.rack, Math.random); return paintMatch(); }
        if (act === 'recall') { wpRecall(); return paintMatch(); }
        if (act === 'share') {
            const line = m.players.map(p => `${who(p).display_name || 'Someone'} ${Number(m.scores[p] || 0)}`).join(' · ');
            if (window.diaryPlay && window.diaryPlay.share) window.diaryPlay.share(`🔤 A game of Wordplay on Cordial: ${line}${m.winner ? ` — ${m.winner === myId() ? 'I' : (who(m.winner).display_name || 'they')} won!` : ''} #playnote`);
            return;
        }
        if (act === 'rematch') { const others = m.players.filter(p => p !== myId() && !m.out_players.includes(p)); return others.length ? startMatch(others) : newMatchDialog(); }
        if (act === 'resign') {
            const left = m.players.length - m.out_players.length;
            const ok = await app.ask({ title: 'Resign from this match?', text: left <= 2 ? 'Your opponent wins the match.' : 'The others carry on without you.', ok: 'Resign' });
            if (ok && W && W.match === id) matchCall('diary_wp_resign', { p_match: id });
            return;
        }
        if (!isMyTurn(m)) return hint('Wait for your turn');
        if (act === 'pass') {
            const ok = await app.ask({ title: 'Pass this turn?', text: 'If every player passes twice in a row, the match ends.', ok: 'Pass' });
            if (ok && W && W.match === id) { wpRecall(); matchCall('diary_wp_pass', { p_match: id }); }
            return;
        }
        if (act === 'swap') {
            const ok = await app.ask({ title: 'Swap your letters?', text: 'You get new letters from the bag, but it uses up your turn.', ok: 'Swap' });
            if (!ok || !W || W.match !== id) return;
            wpRecall();
            const letters = st.rack.filter(Boolean).slice(0, Math.min(7, m.bag_count)).join('');
            return matchCall('diary_wp_swap', { p_match: id, p_letters: letters });
        }
        if (act === 'play') {
            const move = wpMove();
            if (move.error) return hint(move.error);
            return matchCall('diary_wp_play', { p_match: id, p_tiles: st.pending.map(p => ({ r: p.r, c: p.c, ch: p.ch })) });
        }
    }

    // Entry points: the Playnote list, and links from notifications (#/play/m/<match>)
    document.addEventListener('click', e => {
        const b = e.target.closest('[data-wpm]');
        if (!b || !document.getElementById('content').contains(b)) return;
        if (b.dataset.wpm === 'new') newMatchDialog();
        else if (b.dataset.wpm === 'open') openMatch(b.dataset.id);
    });
    if (app.onRoute) app.onRoute(r => { if (r.view === 'play' && r.msg) openMatch(r.msg); });

    const BUILD = { wordplay: buildWordplay, five: buildFive, wordsearch: buildWordsearch, sudoku: buildSudoku, memory: buildMemory, maths: buildMaths, slide: buildSlide };

    // ---------- One click handler for every game ----------
    document.addEventListener('click', e => {
        if (!W || !W.dlg.contains(e.target)) return;
        const b = e.target.closest('[data-gm], [data-k], [data-i], [data-n], [data-c], [data-d], [data-t], [data-wp], [data-wc], [data-wr]');
        if (!b) return;
        if (b.dataset.gm) {
            const act = b.dataset.gm;
            if (act === 'close') { if (W.started && !W.done) confirmLeave(); else closeWin(); }
            else if (act === 'again') open(W.game, true);
            else if (act === 'share') { if (window.diaryPlay && window.diaryPlay.share) window.diaryPlay.share(W.share); }
            else if (act === 'give-up') finishWordsearch();
            return;
        }
        if (W.done) return;
        if (b.dataset.wp) wpAction(b.dataset.wp);
        else if (b.dataset.wc) { const [r, c] = b.dataset.wc.split(',').map(Number); wordplayTapCell(r, c); }
        else if (b.dataset.wr !== undefined) wordplayTapRack(Number(b.dataset.wr));
        else if (b.dataset.k) fiveKey(b.dataset.k);
        else if (b.dataset.i !== undefined && W.game === 'sudoku') { W.state.sel = Number(b.dataset.i); paintSudoku(); }
        else if (b.dataset.n !== undefined) sudokuPut(Number(b.dataset.n));
        else if (b.dataset.c !== undefined) memoryFlip(Number(b.dataset.c));
        else if (b.dataset.d) mathsKey(b.dataset.d);
        else if (b.dataset.t !== undefined) slideTap(Number(b.dataset.t));
    });

    // ---------- For the Playnote page ----------
    async function loadToday() {
        if (!s.profile) return;
        const [{ data }, flags] = await Promise.all([client.rpc('diary_games_today'), client.from('diary_game_settings').select('game, enabled')]);
        G.today = data || {};
        G.off = new Set((flags.data || []).filter(r => !r.enabled).map(r => r.game));
        if (window.diaryPlay && window.diaryPlay.repaint) window.diaryPlay.repaint();
    }
    function tilesHTML() {
        if (G.today === null) loadToday();
        return Object.entries(GAMES).filter(([k]) => !G.off.has(k)).map(([k, g]) => {
            const t = G.today && G.today[k];
            return `
                <button type="button" class="gm-tile gm-t-${k}${t ? ' done' : ''}" data-game="${k}" aria-label="${esc(g.title)} — ${t ? `played, ${t.score} points` : 'play today’s puzzle'}">
                    <span class="gm-t-ic">${ic(g.icon)}</span>
                    <span class="gm-t-text"><strong>${esc(g.title)}</strong><small>${t ? `${ic('i-check')}${Number(t.score).toLocaleString()} pts today` : esc(g.sub)}</small></span>
                </button>`;
        }).join('');
    }
    document.addEventListener('click', e => {
        const t = e.target.closest('[data-game]');
        if (t && document.getElementById('content').contains(t)) open(t.dataset.game);
    });

    // For Playnote's home: the games (with today's result) and compact cards for your active matches
    function list() {
        if (G.today === null) loadToday();
        return Object.entries(GAMES).filter(([k]) => !G.off.has(k)).map(([k, g]) => {
            const t = G.today && G.today[k];
            return { key: k, ...g, done: !!t, score: t ? Number(t.score) : null };
        });
    }
    function matchCards() {
        if (!myId() || G.off.has('wordplay')) return null;
        if (MX.list === null) loadMatches();
        const all = MX.list || [];
        const active = all.filter(m => m.status === 'active').sort((a, b) => isMyTurn(b) - isMyTurn(a));
        return {
            loading: MX.list === null,
            total: all.length,
            yourTurn: active.filter(isMyTurn).length,
            html: active.slice(0, 8).map(m => {
                const others = m.players.filter(p => p !== myId());
                const mine = isMyTurn(m);
                return `
                    <button type="button" class="pn-match${mine ? ' mine' : ''}" data-wpm="open" data-id="${esc(m.id)}" aria-label="Wordplay with ${esc(others.map(p => who(p).display_name || 'Someone').join(', '))} — ${esc(statusText(m))}">
                        <span class="pn-avs">${others.slice(0, 3).map(p => I.avatar(who(p), 'sm')).join('')}</span>
                        <strong>${esc(others.map(firstName).join(', '))}</strong>
                        <small>${m.players.map(p => `${esc(p === myId() ? 'You' : firstName(p))} ${Number(m.scores[p] || 0)}`).join(' · ')}</small>
                        <span class="pn-match-status">${esc(statusText(m))}</span>
                    </button>`;
            }).join('')
        };
    }

    window.diaryGames = { open, tilesHTML, GAMES, refresh: loadToday, current: () => W, matchesHTML, openMatch, newMatch: newMatchDialog, loadMatches, list, matchCards };
});
