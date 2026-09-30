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
        slide: { title: 'Sliding puzzle', sub: 'Put the tiles back in order', icon: 'i-g-slide' }
    };
    const G = { today: null };

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
                <p class="gm-cheer">${W.game === 'maths' ? 'Time’s up!' : won ? 'Solved!' : 'Nice try'}</p>
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

    const BUILD = { five: buildFive, wordsearch: buildWordsearch, sudoku: buildSudoku, memory: buildMemory, maths: buildMaths, slide: buildSlide };

    // ---------- One click handler for every game ----------
    document.addEventListener('click', e => {
        if (!W || !W.dlg.contains(e.target)) return;
        const b = e.target.closest('[data-gm], [data-k], [data-i], [data-n], [data-c], [data-d], [data-t]');
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
        if (b.dataset.k) fiveKey(b.dataset.k);
        else if (b.dataset.i !== undefined && W.game === 'sudoku') { W.state.sel = Number(b.dataset.i); paintSudoku(); }
        else if (b.dataset.n !== undefined) sudokuPut(Number(b.dataset.n));
        else if (b.dataset.c !== undefined) memoryFlip(Number(b.dataset.c));
        else if (b.dataset.d) mathsKey(b.dataset.d);
        else if (b.dataset.t !== undefined) slideTap(Number(b.dataset.t));
    });

    // ---------- For the Playnote page ----------
    async function loadToday() {
        if (!s.profile) return;
        const { data } = await client.rpc('diary_games_today');
        G.today = data || {};
        if (window.diaryPlay && window.diaryPlay.repaint) window.diaryPlay.repaint();
    }
    function tilesHTML() {
        if (G.today === null) loadToday();
        return Object.entries(GAMES).map(([k, g]) => {
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

    window.diaryGames = { open, tilesHTML, GAMES, refresh: loadToday, current: () => W };
});
