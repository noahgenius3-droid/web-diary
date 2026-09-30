// Playnote (#/play): the daily habit page. Daily trivia, the weekly challenge, Bible and brain challenges,
// the question of the day, word of the day, daily thought and daily poll, practice by category, leaderboards
// and your trivia numbers. Answers and scores live on the server (the phone never gets an answer before you
// pick one), so leaderboards are fair. Results can be shared to the feed.
document.addEventListener('DOMContentLoaded', () => {
    const app = window.diaryApp;
    const social = window.diarySocial;
    if (!app || !social || !social.internals) return;
    const I = social.internals;
    const { client, state: s, esc, avatar, hydrateStorage } = I;
    const content = document.getElementById('content');
    const SECONDS = 30;

    // Topics and games each have a drawn icon; games also have a colour of their own (see .g-* in style.css)
    const CATS = {
        bible: ['i-book', 'Bible'], general: ['i-globe', 'General knowledge'], history: ['i-g-columns', 'History'], science: ['i-g-flask', 'Science & tech'],
        current: ['i-g-news', 'Current affairs'], sports: ['i-g-ball', 'Sports'], education: ['i-g-cap', 'Education'], brain: ['i-g-puzzle', 'Brain teasers'], random: ['i-g-dice', 'Random mix']
    };
    const KINDS = {
        daily: { title: 'Daily trivia', sub: 'Ten questions, the same for everyone. New every day.', icon: 'i-g-question', emoji: '🧠' },
        weekly: { title: 'Weekly challenge', sub: 'Twenty questions. New every Monday.', icon: 'i-trophy', emoji: '🏆' },
        bible: { title: 'Bible challenge', sub: 'Five questions from Scripture.', icon: 'i-book', emoji: '📖' },
        brain: { title: 'Brain challenge', sub: 'One puzzle. Think before you tap.', icon: 'i-g-puzzle', emoji: '🧩' },
        qotd: { title: 'Question of the day', sub: 'Then see how everyone answered.', icon: 'i-sparkle', emoji: '❓' },
        practice: { title: 'Practice', sub: '10 questions', icon: 'i-g-dice', emoji: '🎯' }
    };
    const ic = (id, cls = '') => `<svg class="i${cls ? ` ${cls}` : ''}" aria-hidden="true"><use href="#${id}"/></svg>`;

    const P = { today: null, stats: null, loading: false, board: { kind: 'trivia', period: 'week', scope: 'everyone', rows: null, loading: false }, badges: null, qotd: null };
    const me = () => s.profile && s.profile.id;
    const fmt = n => Number(n || 0).toLocaleString();

    async function load() {
        if (P.loading || !me()) return;
        P.loading = true;
        const [today, stats, badges] = await Promise.all([client.rpc('diary_daily_today'), client.rpc('diary_trivia_stats'), client.rpc('diary_badges_of')]);
        P.loading = false;
        P.today = today.data || {};
        P.stats = stats.data || {};
        P.badges = badges.data || null;
        if (P.stats.today && P.stats.today.qotd && P.stats.today.qotd.done) loadQotdResults();
        paint();
        loadBoard();
    }
    async function loadBoard() {
        const b = P.board;
        b.loading = true;
        const { data } = b.kind === 'trivia'
            ? await client.rpc('diary_trivia_leaderboard', { p_period: b.period, p_scope: b.scope, p_limit: 50 })
            : b.kind === 'posts'
                ? await client.rpc('diary_top_posts', { p_period: b.period, p_limit: 20 })
                : await client.rpc('diary_board', { p_board: b.kind, p_period: b.period, p_scope: b.scope, p_limit: 50 });
        b.loading = false;
        b.rows = data || [];
        paint();
    }
    async function loadQotdResults() {
        const { data } = await client.rpc('diary_trivia_qotd_results');
        P.qotdResults = data;
        paint();
    }
    const paint = () => { if (app.state.view === 'play') app.requestRender ? app.requestRender('play') : app.render(); };

    // ---------- The page ----------
    function statusOf(kind) {
        const t = P.stats && P.stats.today && P.stats.today[kind];
        if (!t) return { label: 'Play', done: false, started: false };
        if (t.done) return { label: `${t.correct}/${t.total} · ${fmt(t.score)} pts`, done: true, correct: t.correct, total: t.total };
        return { label: 'Continue', done: false, started: true };
    }

    // The lead tile: a small stack of question cards, drawn — no picture needed
    const LEAD_ART = `
        <svg class="g-art" viewBox="0 0 160 120" aria-hidden="true">
            <rect x="46" y="22" width="76" height="92" rx="12" transform="rotate(-10 84 68)" class="g-art-back"/>
            <rect x="40" y="16" width="76" height="92" rx="12" transform="rotate(6 78 62)" class="g-art-mid"/>
            <rect x="42" y="12" width="76" height="92" rx="12" class="g-art-front"/>
            <path d="M68 48a12 12 0 1 1 17 10.9c-3 1.4-5 3.9-5 7.1v3" class="g-art-mark"/>
            <circle cx="80" cy="80" r="3.4" class="g-art-dot"/>
        </svg>`;

    function gameTile(kind, lead = false) {
        const k = KINDS[kind];
        const st = statusOf(kind);
        const action = st.done ? (kind === 'qotd' ? 'See answers' : 'See result') : st.started ? 'Continue' : 'Play';
        return `
            <button type="button" class="g-tile g-${kind}${lead ? ' lead' : ''}${st.done ? ' done' : ''}" data-pl="start" data-kind="${kind}"
                aria-label="${esc(k.title)} — ${st.done ? `done, ${esc(st.label)}` : action}">
                <span class="g-field">${lead ? LEAD_ART : ic(k.icon, 'g-glyph')}</span>
                <span class="g-text">
                    <strong>${k.title}</strong>
                    <small>${k.sub}</small>
                    <span class="g-go${st.done ? ' ok' : ''}">${st.done ? `${ic('i-check')}${esc(st.label)}` : `${action}${ic('i-forward')}`}</span>
                </span>
            </button>`;
    }

    function wordPanel(w) {
        if (!w) return '';
        return `
            <section class="pl-panel pl-word" aria-labelledby="pl-word-h">
                <h3 id="pl-word-h" class="pl-panel-h">${ic('i-book')}Word of the day</h3>
                <p class="pl-word-main"><dfn>${esc(w.word)}</dfn><span class="pl-pos">${esc(w.part || '')}</span></p>
                <p class="pl-def">${esc(w.meaning)}</p>
                <p class="pl-example">${esc(w.example)}</p>
                <div class="pl-panel-foot">
                    ${'speechSynthesis' in window ? `<button type="button" class="chip" data-pl="say" data-word="${esc(w.word)}">${ic('i-volume')}Hear it</button>` : ''}
                    <button type="button" class="chip" data-pl="share-word">${ic('i-share')}Share</button>
                </div>
            </section>`;
    }
    function thoughtPanel(t) {
        if (!t) return '';
        return `
            <section class="pl-panel pl-thought" aria-labelledby="pl-thought-h">
                <h3 id="pl-thought-h" class="pl-panel-h">${ic('i-sparkle')}Thought for today</h3>
                <blockquote><p>${esc(t.text)}</p><footer>${esc(t.source)}</footer></blockquote>
                <div class="pl-panel-foot"><button type="button" class="chip" data-pl="share-thought">${ic('i-share')}Share</button></div>
            </section>`;
    }
    function pollPanel(p) {
        if (!p || !p.options) return '';
        const voted = p.mine !== null && p.mine !== undefined;
        const total = voted ? Object.values(p.counts || {}).reduce((a, b) => a + b, 0) : 0;
        const lead = voted ? Math.max(...p.options.map((_, i) => (p.counts || {})[String(i)] || 0)) : -1;
        return `
            <section class="pl-panel pl-poll" aria-labelledby="pl-poll-h">
                <h3 id="pl-poll-h" class="pl-panel-h">${ic('i-chart')}Today’s poll</h3>
                <p class="pl-poll-q">${esc(p.question)}</p>
                <div class="pl-poll-opts" role="group" aria-label="${esc(p.question)}">${p.options.map((o, i) => {
                    const n = voted ? (p.counts || {})[String(i)] || 0 : 0;
                    const pct = total ? Math.round(100 * n / total) : 0;
                    return `<button type="button" class="pl-opt${voted ? ' voted' : ''}${p.mine === i ? ' mine' : ''}${voted && n === lead && n > 0 ? ' top' : ''}" data-pl="vote" data-i="${i}" style="--pct:${pct}%" aria-pressed="${p.mine === i}">
                        <span>${esc(o)}${p.mine === i ? ` ${ic('i-check')}` : ''}</span>${voted ? `<b>${pct}%</b>` : ''}</button>`;
                }).join('')}</div>
                <p class="pl-note">${voted ? `${total} ${total === 1 ? 'vote' : 'votes'} so far · tap another answer to change yours` : 'Vote to see how everyone answered.'}</p>
            </section>`;
    }

    function boardHTML() {
        const b = P.board;
        const seg = (name, opts, cur) => `<div class="pl-seg" role="radiogroup" aria-label="${name === 'scope' ? 'Who' : 'When'}">${opts.map(([v, l]) =>
            `<button type="button" role="radio" aria-checked="${cur === v}" data-pl="${name}" data-v="${v}">${l}</button>`).join('')}</div>`;
        const person = r => ({ id: r.user_id, display_name: r.display_name, avatar_path: r.avatar_path });
        const detail = r => (r.detail !== undefined ? esc(r.detail || '') : `${r.rounds} ${r.rounds === 1 ? 'round' : 'rounds'} · ${r.accuracy || 0}% right`);
        const BOARDS = [['trivia', 'Trivia'], ['games', 'Games'], ['contributors', 'Contributors'], ['helpful', 'Most helpful'], ['active', 'Most active'], ['xp', 'Level'], ['posts', 'Top posts']];
        const picker = `<div class="pl-boards" role="tablist" aria-label="Leaderboard">${BOARDS.map(([k, l]) => `<button type="button" role="tab" class="pl-board-tab" aria-selected="${b.kind === k}" data-pl="board" data-v="${k}">${l}</button>`).join('')}</div>`;
        let body;
        if (b.rows === null || b.loading) body = '<div class="pl-board-skel" aria-busy="true"><i></i><i></i><i></i></div>';
        else if (b.kind === 'posts') body = b.rows.length ? `<ol class="pl-posts">${b.rows.map((p, i) => `
                <li><button type="button" class="pl-post" data-pl="open-post" data-id="${esc(p.id)}">
                    <span class="pl-rank">${i + 1}</span>
                    <span class="pl-post-text"><strong>${esc(p.title || (p.body || '').slice(0, 90) || 'Photo post')}</strong><small>${esc(p.display_name)} · ${fmt(p.reactions)} ${p.reactions === 1 ? 'reaction' : 'reactions'}</small></span>
                    ${ic('i-thumb')}</button></li>`).join('')}</ol>` : '<p class="pl-empty">No posts in this period yet.</p>';
        else if (!b.rows.length) body = `<p class="pl-empty">No scores ${b.period === 'today' ? 'today' : b.period === 'all' ? 'yet' : `this ${b.period}`}${b.scope === 'friends' ? ' among your friends' : ''}. Play today’s trivia to take first place.</p>`;
        else {
            const podium = b.rows.filter(r => Number(r.rank) <= 3).slice(0, 3);
            const rest = b.rows.filter(r => !podium.includes(r));
            const order = [podium[1], podium[0], podium[2]].filter(Boolean); // 2 · 1 · 3
            body = `
                ${podium.length ? `<ol class="pl-podium" aria-label="Top three">${order.map(r => `
                    <li class="pl-step p${r.rank}${r.is_me ? ' me' : ''}">
                        <button type="button" class="pl-step-who" data-profile="${esc(r.user_id)}" aria-label="${esc(r.display_name)}, place ${r.rank}, ${fmt(r.score)} points">
                            ${avatar(person(r), r.rank === 1 ? 'lg' : 'md')}
                            <strong>${esc(r.is_me ? 'You' : r.display_name.split(' ')[0])}</strong>
                            <span class="pl-step-score">${fmt(r.score)}</span>
                        </button>
                        <span class="pl-step-block"><b>${r.rank}</b></span>
                    </li>`).join('')}</ol>` : ''}
                ${rest.length ? `<ol class="pl-board" start="4">${rest.map(r => `
                    <li class="pl-row${r.is_me ? ' me' : ''}">
                        <span class="pl-rank">${r.rank}</span>
                        <button type="button" class="row-av" data-profile="${esc(r.user_id)}" aria-label="${esc(r.display_name)}’s profile">${avatar(person(r), 'sm')}</button>
                        <button type="button" class="pl-who" data-profile="${esc(r.user_id)}"><strong>${esc(r.is_me ? 'You' : r.display_name)}</strong><small>${detail(r)}</small></button>
                        <span class="pl-score">${fmt(r.score)}</span>
                    </li>`).join('')}</ol>` : ''}`;
        }
        return `
            <section class="pl-section pl-leader" aria-labelledby="pl-board-h">
                <header class="pl-sec-head">
                    <h3 id="pl-board-h">Leaderboard</h3>
                    ${seg('scope', [['everyone', 'Everyone'], ['friends', 'Friends']], b.scope)}
                </header>
                ${picker}
                ${seg('period', [['today', 'Today'], ['week', 'This week'], ['month', 'This month'], ['all', 'All time']], b.period)}
                ${body}
                <p class="pl-note">${{ trivia: 'Daily, weekly, Bible, brain and question-of-the-day scores count. Practice rounds don’t.', games: 'Your first go at each daily puzzle counts.', contributors: '5 points a post, 2 a comment.', helpful: 'Replies and comments on other people’s posts.', active: 'Posts, comments, reactions, trivia rounds and puzzles.', xp: 'XP from trivia, games, posts and comments.', posts: 'The posts with the most reactions that you can see.' }[b.kind]}</p>
            </section>`;
    }

    function topicsHTML() {
        const st = P.stats || {};
        const byCat = new Map((st.categories || []).map(c => [c.category, c]));
        return `
            <section class="pl-section" aria-labelledby="pl-practice-h">
                <header class="pl-sec-head"><h3 id="pl-practice-h">Practice any topic</h3><p class="pl-note">As many rounds as you like</p></header>
                <div class="pl-topics">${Object.entries(CATS).map(([k, [icon, l]]) => {
                    const c = byCat.get(k);
                    const pct = c && c.answered ? Math.round(100 * c.correct / c.answered) : null;
                    return `<button type="button" class="pl-topic" data-pl="practice" data-cat="${k}">
                        <span class="pl-topic-ic">${ic(icon)}</span>
                        <span class="pl-topic-text"><strong>${esc(l)}</strong><small>${pct === null ? (k === 'random' ? 'A bit of everything' : 'Not played yet') : `${pct}% right · ${c.answered} answered`}</small></span>
                        ${pct === null ? '' : `<span class="pl-meter" style="--pct:${pct}%" aria-hidden="true"></span>`}
                    </button>`;
                }).join('')}</div>
            </section>`;
    }

    function levelHTML() {
        const L = P.badges;
        if (!L) return '';
        const span = Math.max(1, L.level_next - L.level_floor);
        const pct = Math.min(100, Math.round(100 * (L.xp - L.level_floor) / span));
        return `<div class="pl-level" aria-label="Level ${L.level}, ${fmt(L.xp)} XP">
            <span class="pl-level-n">Level <b>${L.level}</b></span>
            <span class="pl-level-bar"><i style="width:${pct}%"></i></span>
            <span class="pl-level-xp">${fmt(L.xp)} / ${fmt(L.level_next)} XP</span></div>`;
    }
    function badgesHTML() {
        const L = P.badges;
        if (!L || !L.badges) return '';
        const earned = L.badges.filter(b => b.earned_at).length;
        return `
            <section class="pl-section" aria-labelledby="pl-badges-h">
                <header class="pl-sec-head"><h3 id="pl-badges-h">Badges</h3><p class="pl-note">${earned} of ${L.badges.length} earned</p></header>
                <ul class="badge-grid">${L.badges.map(b => `
                    <li class="bdg ${esc(b.tier)}${b.earned_at ? ' earned' : ''}" title="${esc(b.description)}">
                        <span class="badge-medal">${ic(b.icon)}</span>
                        <strong>${esc(b.name)}</strong>
                        <small>${b.earned_at ? `Earned ${new Date(b.earned_at).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}` : esc(b.description)}</small>
                    </li>`).join('')}</ul>
            </section>`;
    }

    function mastheadHTML() {
        const st = P.stats || {};
        const d = new Date();
        const date = d.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' });
        const first = esc((s.profile.display_name || '').split(' ')[0]);
        const facts = [];
        if (st.streak) facts.push(`<span class="pl-streak">${ic('i-flame')}${st.streak}-day streak</span>`);
        if (st.score) facts.push(`${fmt(st.score)} points`);
        if (st.accuracy !== null && st.accuracy !== undefined && st.answered) facts.push(`${st.accuracy}% of answers right`);
        const done = ['daily', 'bible', 'brain', 'qotd'].filter(k => statusOf(k).done).length;
        return `
            <header class="pl-mast">
                <h2 class="pl-date">${esc(date)}</h2>
                <p class="pl-lede">Good ${greeting()}, ${first}. ${done === 4 ? 'You’ve done all of today’s challenges — see you tomorrow.' : done ? `${done} of today’s 4 challenges done.` : 'Four short challenges are waiting for you.'}</p>
                ${facts.length ? `<p class="pl-facts">${facts.join('<span aria-hidden="true">·</span>')}</p>` : ''}
                ${levelHTML()}
            </header>`;
    }

    app.views.play = () => {
        app.setTitle('Playnote');
        const blocked = I.gate('Daily trivia, challenges and leaderboards — learn something every day.');
        if (blocked) return blocked;
        if (!P.today) { load(); return '<div class="pl"><div class="pl-board-skel" aria-busy="true"><i></i><i></i><i></i></div></div>'; }
        return `
            <div class="pl">
                ${mastheadHTML()}
                <section class="g-grid" aria-label="Today’s games">
                    ${gameTile('daily', true)}
                    ${gameTile('qotd')}
                    ${gameTile('bible')}
                    ${gameTile('brain')}
                    ${gameTile('weekly')}
                </section>
                <div class="pl-reading">
                    ${wordPanel(P.today.word)}
                    ${thoughtPanel(P.today.thought)}
                    ${pollPanel(P.today.poll)}
                </div>
                ${window.diaryGames ? `<section class="pl-section" aria-labelledby="pl-games-h">
                    <header class="pl-sec-head"><h3 id="pl-games-h">Puzzles & games</h3><p class="pl-note">A new puzzle in each every day</p></header>
                    <div class="gm-tiles">${window.diaryGames.tilesHTML()}</div>
                </section>` : ''}
                ${topicsHTML()}
                ${boardHTML()}
                ${badgesHTML()}
            </div>`;
    };
    const greeting = () => { const h = new Date().getHours(); return h < 12 ? 'morning' : h < 17 ? 'afternoon' : 'evening'; };

    // The Explore page's "Playnote" band: today's games plus the word of the day
    function exploreSection() {
        if (!me()) return '';
        if (!P.today) { if (!P.loading) load(); return ''; }
        const w = P.today.word;
        return `
            <section class="ex-sec pl-ex" aria-labelledby="pl-ex-h">
                <header class="ex-head"><h3 id="pl-ex-h"><span class="ex-ic">${ic('i-trophy')}</span>Playnote</h3>
                    <p>Trivia, a new word and a quick poll — a few minutes a day</p>
                    <button type="button" class="link-btn accent ex-more" data-action="go-play">Open</button></header>
                <div class="pl-ex-row">
                    ${gameTile('daily', true)}
                    ${gameTile('qotd')}
                    ${gameTile('bible')}
                    ${w ? `<button type="button" class="pl-ex-word" data-action="go-play" aria-label="Word of the day: ${esc(w.word)}">
                        <span class="pl-panel-h">${ic('i-book')}Word of the day</span>
                        <dfn>${esc(w.word)}</dfn>
                        <small>${esc(w.meaning)}</small></button>` : ''}
                </div>
            </section>`;
    }

    // ---------- The quiz ----------
    let Q = null; // { round, i, dlg, timer, startedAt, answering }
    async function start(kind, category) {
        if (!me()) return;
        const { data, error } = await client.rpc('diary_trivia_start', { p_kind: kind, p_category: category || null });
        if (error || !data) return app.showToast(error ? error.message : 'Couldn’t start the game');
        openQuiz(data);
    }
    function openQuiz(round) {
        closeQuiz();
        const dlg = document.createElement('dialog');
        dlg.className = 'quiz';
        dlg.setAttribute('aria-label', KINDS[round.kind].title);
        document.body.append(dlg);
        Q = { round, i: round.index, dlg, timer: null, results: round.answered || [] };
        dlg.addEventListener('close', () => { stopTimer(); dlg.remove(); if (Q && Q.dlg === dlg) Q = null; load(); });
        dlg.addEventListener('click', onQuizClick);
        dlg.addEventListener('cancel', e => { if (Q && !Q.round.finished && Q.i < Q.round.total) { e.preventDefault(); confirmLeave(); } });
        dlg.showModal();
        if (round.finished || round.index >= round.total) {
            if (round.kind === 'qotd') loadQotdResults().then(() => Q && showReview(0));
            else if (round.kind === 'brain') showReview(0);
            else showEnd();
        } else showQuestion();
    }
    function closeQuiz() { if (Q && Q.dlg.open) Q.dlg.close(); }
    async function confirmLeave() {
        const ok = await app.ask({ title: 'Leave this round?', text: 'You can come back and carry on where you stopped — but the clock is running on this question.', ok: 'Leave' });
        if (ok) closeQuiz();
    }
    const stopTimer = () => { if (Q && Q.timer) { clearInterval(Q.timer); Q.timer = null; } };
    const catHTML = c => { const [icon, l] = CATS[c] || ['i-sparkle', c]; return `${ic(icon)}${esc(l)}`; };

    function head(extra = '') {
        const r = Q.round;
        return `
            <header class="quiz-head">
                <button type="button" class="icon-btn" data-q="close" aria-label="Close"><svg class="i"><use href="#i-close"/></svg></button>
                <div class="quiz-title"><strong>${ic(KINDS[r.kind].icon)}${esc(r.kind === 'practice' ? `Practice · ${CATS[r.category] ? CATS[r.category][1] : 'Random'}` : KINDS[r.kind].title)}</strong>
                    ${r.total > 1 ? `<small>Question ${Math.min(Q.i + 1, r.total)} of ${r.total}</small>` : ''}</div>
                <span class="quiz-score" aria-label="Score">${fmt(r.score)} pts</span>
            </header>
            ${r.total > 1 ? `<div class="quiz-progress" aria-hidden="true"><i style="width:${Math.round(100 * Q.i / r.total)}%"></i></div>` : ''}
            ${extra}`;
    }

    function showQuestion() {
        const r = Q.round;
        const q = r.questions[Q.i];
        Q.answering = false;
        Q.dlg.innerHTML = `
            <div class="quiz-card">
                ${head()}
                <div class="quiz-body">
                    <div class="quiz-timer" role="timer" aria-live="off"><span class="quiz-ring" style="--left:1"><b id="quiz-secs">${SECONDS}</b></span></div>
                    <p class="quiz-cat">${catHTML(q.category)}</p>
                    <h2 class="quiz-q">${esc(q.question)}</h2>
                    <div class="quiz-choices">${q.choices.map((c, i) => `<button type="button" class="quiz-choice" data-q="pick" data-i="${i}"><span class="quiz-letter">${'ABCDE'[i]}</span><span>${esc(c)}</span></button>`).join('')}</div>
                    <div class="quiz-feedback" aria-live="polite"></div>
                </div>
            </div>`;
        client.rpc('diary_trivia_seen', { p_round: r.id }).then(() => {});
        Q.startedAt = performance.now();
        stopTimer();
        Q.timer = setInterval(() => {
            const left = Math.max(0, SECONDS - (performance.now() - Q.startedAt) / 1000);
            const el = Q.dlg.querySelector('#quiz-secs');
            if (el) el.textContent = String(Math.ceil(left));
            const ring = Q.dlg.querySelector('.quiz-ring');
            if (ring) { ring.style.setProperty('--left', String(left / SECONDS)); ring.classList.toggle('low', left <= 5); }
            if (left <= 0) answer(-1);
        }, 200);
        Q.dlg.querySelector('.quiz-choice')?.focus({ preventScroll: true });
    }

    async function answer(choice) {
        if (!Q || Q.answering) return;
        Q.answering = true;
        stopTimer();
        const ms = Math.round(performance.now() - Q.startedAt);
        const buttons = [...Q.dlg.querySelectorAll('.quiz-choice')];
        buttons.forEach(b => { b.disabled = true; });
        if (choice >= 0) buttons[choice]?.classList.add('picked');
        const { data, error } = await client.rpc('diary_trivia_answer', { p_round: Q.round.id, p_choice: choice, p_ms: ms });
        if (error || !data) {
            buttons.forEach(b => { b.disabled = false; });
            Q.answering = false;
            return app.showToast(error ? error.message : 'Couldn’t send your answer — check your connection');
        }
        Q.round.score = data.score;
        Q.round.correct = data.correct_count;
        Q.results[Q.i] = { choice, answer: data.answer, correct: data.correct, explanation: data.explanation };
        buttons.forEach((b, i) => {
            if (i === data.answer) b.classList.add('right');
            else if (i === choice) b.classList.add('wrong');
        });
        if (navigator.vibrate) navigator.vibrate(data.correct ? 12 : [20, 40, 20]);
        Q.i += 1;
        Q.round.finished = data.finished;
        const last = data.finished || Q.i >= Q.round.total;
        Q.dlg.querySelector('.quiz-score').textContent = `${fmt(data.score)} pts`;
        if (data.finished) client.rpc('diary_check_badges').then(({ data: got }) => { if (got && got.length) app.showToast(`New badge: ${got.map(x => x.name).join(', ')} 🏅`); });
        Q.dlg.querySelector('.quiz-feedback').innerHTML = `
            <p class="quiz-verdict ${data.correct ? 'ok' : 'no'}">${data.correct ? `Correct! +${data.points}` : choice < 0 ? 'Time’s up' : 'Not quite'}</p>
            ${data.explanation ? `<p class="quiz-expl">${esc(data.explanation)}</p>` : ''}
            <button type="button" class="primary-btn quiz-next" data-q="${last ? 'end' : 'next'}">${last ? 'See your result' : 'Next question'}</button>`;
        Q.dlg.querySelector('.quiz-next')?.focus({ preventScroll: true });
    }

    function showEnd() {
        stopTimer();
        const r = Q.round;
        const pct = r.total ? Math.round(100 * r.correct / r.total) : 0;
        const cheer = pct === 100 ? 'Perfect score! 🎉' : pct >= 80 ? 'Brilliant! 🌟' : pct >= 50 ? 'Nice work! 👏' : 'Keep going — you’ll get there 💪';
        Q.dlg.innerHTML = `
            <div class="quiz-card">
                ${head()}
                <div class="quiz-body quiz-end">
                    <p class="quiz-cheer">${cheer}</p>
                    <div class="quiz-big"><b>${r.correct}/${r.total}</b><span>${pct}% right</span></div>
                    <p class="quiz-points">${fmt(r.score)} points${r.kind === 'practice' ? ' · practice doesn’t count on leaderboards' : ''}</p>
                    <div class="quiz-dots" aria-label="Your answers">${Array.from({ length: r.total }, (_, i) => {
                        const x = Q.results[i];
                        return `<button type="button" class="quiz-dot ${x ? (x.correct ? 'ok' : 'no') : ''}" data-q="review" data-i="${i}" aria-label="Question ${i + 1}: ${x && x.correct ? 'right' : 'wrong'} — review">${i + 1}</button>`;
                    }).join('')}</div>
                    <div class="quiz-actions">
                        <button type="button" class="primary-btn" data-q="share"><svg class="i"><use href="#i-share"/></svg>Share to the feed</button>
                        ${r.kind === 'practice' ? '<button type="button" class="ghost-btn" data-q="again">Play again</button>' : ''}
                        <button type="button" class="ghost-btn" data-q="board">Leaderboard</button>
                        <button type="button" class="ghost-btn" data-q="close">Done</button>
                    </div>
                </div>
            </div>`;
        if (pct >= 80 && window.matchMedia && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) confetti(Q.dlg.querySelector('.quiz-big'));
    }

    // Look back over a question you've answered
    function showReview(i) {
        const r = Q.round;
        const q = r.questions[i];
        const x = Q.results[i] || {};
        const single = r.total === 1;
        const res = r.kind === 'qotd' ? P.qotdResults : null;
        const totalVotes = res ? res.total : 0;
        Q.dlg.innerHTML = `
            <div class="quiz-card">
                ${head()}
                <div class="quiz-body">
                    <p class="quiz-cat">${catHTML(q.category)}</p>
                    <h2 class="quiz-q">${esc(q.question)}</h2>
                    <div class="quiz-choices">${q.choices.map((c, j) => {
                        const n = res && res.counts ? res.counts[String(j)] || 0 : 0;
                        const pct = totalVotes ? Math.round(100 * n / totalVotes) : null;
                        return `<div class="quiz-choice static${j === x.answer ? ' right' : j === x.choice ? ' wrong' : ''}"${pct !== null ? ` style="--pct:${pct}%"` : ''}><span class="quiz-letter">${'ABCDE'[j]}</span><span>${esc(c)}</span>${pct !== null ? `<b class="quiz-pct">${pct}%</b>` : ''}</div>`;
                    }).join('')}</div>
                    ${x.explanation ? `<p class="quiz-expl">${esc(x.explanation)}</p>` : ''}
                    ${res ? `<p class="muted small">${totalVotes} ${totalVotes === 1 ? 'person' : 'people'} answered today.</p>` : ''}
                    <div class="quiz-actions">
                        ${single ? '<button type="button" class="primary-btn" data-q="share"><svg class="i"><use href="#i-share"/></svg>Share</button><button type="button" class="ghost-btn" data-q="close">Done</button>'
                            : '<button type="button" class="ghost-btn" data-q="end">Back to your result</button>'}
                    </div>
                </div>
            </div>`;
    }

    function shareText() {
        const r = Q.round;
        const pct = r.total ? Math.round(100 * r.correct / r.total) : 0;
        const what = r.kind === 'practice' ? `a ${CATS[r.category] ? CATS[r.category][1] : 'trivia'} practice round` : r.kind === 'daily' ? 'today’s Daily Trivia'
            : r.kind === 'weekly' ? 'this week’s Weekly Challenge' : r.kind === 'bible' ? 'today’s Bible Challenge' : r.kind === 'brain' ? 'today’s Brain Challenge' : 'the Question of the Day';
        if (r.total === 1) return `${r.correct ? '✅ I got' : '🤔 I missed'} ${what} on Cordial${r.correct ? '!' : ' — can you get it?'} ${KINDS[r.kind].emoji} #trivia`;
        return `${KINDS[r.kind].emoji} I scored ${r.correct}/${r.total} (${pct}%) in ${what} on Cordial — ${fmt(r.score)} points! Can you beat me? #trivia`;
    }

    // A small sheet to edit the words and choose who sees it, then post
    function openShare(text) {
        const dlg = document.createElement('dialog');
        dlg.className = 'sheet-dialog pl-share';
        dlg.setAttribute('aria-labelledby', 'pl-share-title');
        let audience = s.feedAudience || 'friends';
        const paint = () => {
            dlg.innerHTML = `
                <form class="rx-card sched-form" novalidate>
                    <header class="rx-head"><h2 id="pl-share-title">Share to the feed</h2><button type="button" class="icon-btn" data-x="close" aria-label="Close"><svg class="i"><use href="#i-close"/></svg></button></header>
                    <div class="sched-scroll">
                        <label class="field"><span>Your post</span><textarea name="body" rows="4" maxlength="2000">${esc(text)}</textarea></label>
                        <div class="field"><span>Who can see it</span><div class="sched-seg small" role="radiogroup" aria-label="Who can see it">
                            ${[['friends', 'i-lock', 'Friends'], ['public', 'i-globe', 'Everyone']].map(([v, icon, l]) => `<button type="button" role="radio" aria-checked="${audience === v}" data-x="aud" data-v="${v}"><svg class="i"><use href="#${icon}"/></svg>${l}</button>`).join('')}</div></div>
                    </div>
                    <footer class="sched-foot"><button type="button" class="ghost-btn" data-x="close">Cancel</button><button type="submit" class="primary-btn">Post</button></footer>
                </form>`;
        };
        paint();
        document.body.append(dlg);
        dlg.showModal();
        dlg.addEventListener('close', () => dlg.remove());
        dlg.addEventListener('click', e => {
            if (e.target === dlg) return dlg.close();
            const b = e.target.closest('[data-x]');
            if (!b) return;
            if (b.dataset.x === 'close') dlg.close();
            if (b.dataset.x === 'aud') { text = dlg.querySelector('textarea').value; audience = b.dataset.v; paint(); }
        });
        dlg.addEventListener('submit', async e => {
            e.preventDefault();
            const body = dlg.querySelector('textarea').value.trim();
            if (!body) return;
            const btn = dlg.querySelector('[type="submit"]');
            btn.disabled = true;
            btn.textContent = 'Posting…';
            const ok = I.quickPost ? await I.quickPost(body, audience) : false;
            if (!ok) { btn.disabled = false; btn.textContent = 'Post'; return app.showToast('Couldn’t post that — please try again'); }
            dlg.close();
            app.showToast('Shared to the feed 🎉');
        });
    }

    function onQuizClick(e) {
        const b = e.target.closest('[data-q]');
        if (!b || !Q) return;
        const act = b.dataset.q;
        if (act === 'pick') answer(Number(b.dataset.i));
        else if (act === 'next') showQuestion();
        else if (act === 'end') {
            const r = Q.round;
            if (r.total === 1) { if (r.kind === 'qotd') loadQotdResults().then(() => Q && showReview(0)); else showReview(0); } else showEnd();
        }
        else if (act === 'review') showReview(Number(b.dataset.i));
        else if (act === 'share') openShare(shareText());
        else if (act === 'again') start('practice', Q.round.category);
        else if (act === 'board') { closeQuiz(); app.setView('play'); setTimeout(() => document.querySelector('.pl-board, .pl-empty')?.scrollIntoView({ behavior: 'smooth', block: 'center' }), 400); }
        else if (act === 'close') {
            if (!Q.round.finished && Q.i < Q.round.total) confirmLeave();
            else closeQuiz();
        }
    }

    // A few pieces of confetti from the score (skipped when motion is reduced)
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

    // ---------- The page's buttons ----------
    content.addEventListener('click', async e => {
        const b = e.target.closest('[data-pl]');
        if (!b || app.state.view !== 'play') return;
        const act = b.dataset.pl;
        if (act === 'start') start(b.dataset.kind);
        else if (act === 'practice') start('practice', b.dataset.cat);
        else if (act === 'scope' || act === 'period' || act === 'board') { P.board[act === 'board' ? 'kind' : act] = b.dataset.v; P.board.rows = null; paint(); loadBoard(); }
        else if (act === 'open-post') { app.setView('feed'); I.openEntry(b.dataset.id); }
        else if (act === 'vote') {
            const { data, error } = await client.rpc('diary_daily_vote', { p_choice: Number(b.dataset.i) });
            if (error) return app.showToast(error.message || 'Couldn’t save your vote');
            P.today.poll = data;
            paint();
        } else if (act === 'say') {
            try { const u = new SpeechSynthesisUtterance(b.dataset.word); u.rate = 0.9; speechSynthesis.cancel(); speechSynthesis.speak(u); } catch (err) {}
        } else if (act === 'share-word') {
            const w = P.today.word;
            openShare(`📚 Word of the day: ${w.word} (${w.part}) — ${w.meaning}\n“${w.example}”`);
        } else if (act === 'share-thought') {
            const t = P.today.thought;
            openShare(`💭 “${t.text}” — ${t.source}`);
        }
    });

    // ---------- Around the app ----------
    // A slim "today" card at the top of the For you feed (until today's trivia is done)
    function feedCard() {
        if (!me()) return '';
        const done = P.stats && P.stats.today && P.stats.today.daily && P.stats.today.daily.done;
        let hidden = false;
        try { hidden = localStorage.getItem('diaryPlayCardHidden') === new Date().toISOString().slice(0, 10); } catch (e) {}
        if (done || hidden) return '';
        if (!P.today && !P.loading) load();
        const w = P.today && P.today.word;
        return `
            <section class="pl-feed-card" aria-label="Today on Cordial">
                <span class="pl-feed-ic">${ic('i-g-question')}</span>
                <span class="pl-feed-text"><strong>Daily trivia is ready</strong><small>10 questions${w ? ` · Word of the day: <b>${esc(w.word)}</b>` : ''}</small></span>
                <button type="button" class="chip accent" data-action="go-play">Play</button>
                <button type="button" class="icon-btn ghost" data-action="play-card-hide" aria-label="Hide for today"><svg class="i"><use href="#i-close"/></svg></button>
            </section>`;
    }
    Object.assign(app.actions, {
        'go-play': () => app.setView('play'),
        'play-card-hide': el => {
            try { localStorage.setItem('diaryPlayCardHidden', new Date().toISOString().slice(0, 10)); } catch (e) {}
            el.closest('.pl-feed-card')?.remove();
        }
    });
    app.onRefresh && app.onRefresh('play', () => { P.today = null; load(); });

    // Trivia numbers for a profile (null when they keep their numbers private)
    async function statsFor(userId) {
        const { data } = await client.rpc('diary_trivia_stats', { p_user: userId });
        return data || null;
    }

    window.diaryPlay = { open: () => app.setView('play'), start, feedCard, exploreSection, statsFor, CATS, refresh: load, share: text => openShare(text || ''), repaint: paint, badgesFor: async id => (await client.rpc('diary_badges_of', { p_user: id })).data || null };
});
