// Play & learn (#/play): the daily habit page. Daily trivia, the weekly challenge, Bible and brain challenges,
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

    const CATS = {
        bible: ['📖', 'Bible'], general: ['🌍', 'General knowledge'], history: ['🏛️', 'History'], science: ['🔬', 'Science & tech'],
        current: ['📰', 'Current affairs'], sports: ['⚽', 'Sports'], education: ['🎓', 'Education'], brain: ['🧩', 'Brain teasers'], random: ['🎲', 'Random mix']
    };
    const KINDS = {
        daily: { title: 'Daily trivia', sub: '10 questions · new every day', emoji: '🧠' },
        weekly: { title: 'Weekly challenge', sub: '20 questions · new every Monday', emoji: '🏆' },
        bible: { title: 'Bible challenge', sub: '5 questions · daily', emoji: '📖' },
        brain: { title: 'Brain challenge', sub: '1 puzzle · daily', emoji: '🧩' },
        qotd: { title: 'Question of the day', sub: 'See how everyone answered', emoji: '❓' },
        practice: { title: 'Practice', sub: '10 questions', emoji: '🎯' }
    };

    const P = { today: null, stats: null, loading: false, board: { period: 'week', scope: 'everyone', rows: null, loading: false }, qotd: null };
    const me = () => s.profile && s.profile.id;
    const fmt = n => Number(n || 0).toLocaleString();

    async function load() {
        if (P.loading || !me()) return;
        P.loading = true;
        const [today, stats] = await Promise.all([client.rpc('diary_daily_today'), client.rpc('diary_trivia_stats')]);
        P.loading = false;
        P.today = today.data || {};
        P.stats = stats.data || {};
        if (P.stats.today && P.stats.today.qotd && P.stats.today.qotd.done) loadQotdResults();
        paint();
        loadBoard();
    }
    async function loadBoard() {
        const b = P.board;
        b.loading = true;
        const { data } = await client.rpc('diary_trivia_leaderboard', { p_period: b.period, p_scope: b.scope, p_limit: 50 });
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
        if (!t) return { label: 'Play', done: false };
        if (t.done) return { label: `${t.correct}/${t.total} · ${fmt(t.score)} pts`, done: true };
        return { label: 'Continue', done: false };
    }
    function challengeCard(kind) {
        const k = KINDS[kind];
        const st = statusOf(kind);
        return `
            <button type="button" class="pl-card pl-${kind}${st.done ? ' done' : ''}" data-pl="start" data-kind="${kind}">
                <span class="pl-emoji" aria-hidden="true">${k.emoji}</span>
                <span class="pl-card-text"><strong>${k.title}</strong><small>${k.sub}</small></span>
                <span class="pl-status${st.done ? ' ok' : ''}">${st.done ? `<svg class="i"><use href="#i-check"/></svg>${esc(st.label)}` : esc(st.label)}</span>
            </button>`;
    }
    function wordCard(w) {
        if (!w) return '';
        return `
            <section class="pl-daily pl-word">
                <p class="pl-kicker">Word of the day</p>
                <h3>${esc(w.word)} <small>${esc(w.part || '')}</small></h3>
                <p>${esc(w.meaning)}</p>
                <p class="pl-example">“${esc(w.example)}”</p>
                <div class="pl-daily-foot">
                    ${'speechSynthesis' in window ? `<button type="button" class="chip" data-pl="say" data-word="${esc(w.word)}"><svg class="i"><use href="#i-volume"/></svg>Hear it</button>` : ''}
                    <button type="button" class="chip" data-pl="share-word"><svg class="i"><use href="#i-share"/></svg>Share</button>
                </div>
            </section>`;
    }
    function thoughtCard(t) {
        if (!t) return '';
        return `
            <section class="pl-daily pl-thought">
                <p class="pl-kicker">Daily thought</p>
                <blockquote>${esc(t.text)}</blockquote>
                <p class="pl-source">— ${esc(t.source)}</p>
                <div class="pl-daily-foot"><button type="button" class="chip" data-pl="share-thought"><svg class="i"><use href="#i-share"/></svg>Share</button></div>
            </section>`;
    }
    function pollCard(p) {
        if (!p || !p.options) return '';
        const voted = p.mine !== null && p.mine !== undefined;
        const total = voted ? Object.values(p.counts || {}).reduce((a, b) => a + b, 0) : 0;
        return `
            <section class="pl-daily pl-poll">
                <p class="pl-kicker">Daily poll</p>
                <h3>${esc(p.question)}</h3>
                <div class="pl-poll-opts" role="group" aria-label="${esc(p.question)}">${p.options.map((o, i) => {
                    const n = voted ? (p.counts || {})[String(i)] || 0 : 0;
                    const pct = total ? Math.round(100 * n / total) : 0;
                    return `<button type="button" class="pl-opt${voted ? ' voted' : ''}${p.mine === i ? ' mine' : ''}" data-pl="vote" data-i="${i}" style="--pct:${pct}%" aria-pressed="${p.mine === i}">
                        <span>${esc(o)}</span>${voted ? `<b>${pct}%</b>` : ''}</button>`;
                }).join('')}</div>
                <p class="muted small">${voted ? `${total} ${total === 1 ? 'vote' : 'votes'} today · tap another option to change yours` : 'Vote to see what everyone thinks'}</p>
            </section>`;
    }
    function qotdCard() {
        const st = statusOf('qotd');
        const r = P.qotdResults;
        return `
            <section class="pl-daily pl-qotd">
                <p class="pl-kicker">Question of the day</p>
                ${st.done ? `<h3>${st.label.startsWith('1/') ? 'You got it right ✅' : 'Not this time ❌'}</h3>
                    <p class="muted small">${r ? `${r.total} ${r.total === 1 ? 'person has' : 'people have'} answered today.` : ''}</p>
                    <button type="button" class="chip" data-pl="start" data-kind="qotd">See the question</button>`
                : `<h3>One question. How will you do?</h3><p class="muted small">30 seconds. Then see how everyone else answered.</p>
                    <button type="button" class="primary-btn" data-pl="start" data-kind="qotd">Answer now</button>`}
            </section>`;
    }
    function boardHTML() {
        const b = P.board;
        const seg = (name, opts, cur) => `<div class="pl-seg" role="radiogroup" aria-label="${name}">${opts.map(([v, l]) =>
            `<button type="button" role="radio" aria-checked="${cur === v}" data-pl="${name}" data-v="${v}">${l}</button>`).join('')}</div>`;
        const rows = b.rows === null || b.loading ? '<div class="post-skel"><i class="sk-line"></i><i class="sk-line w70"></i></div>'
            : b.rows.length ? `<ol class="pl-board">${b.rows.map(r => `
                <li class="pl-row${r.is_me ? ' me' : ''}">
                    <span class="pl-rank${r.rank <= 3 ? ` top r${r.rank}` : ''}">${r.rank <= 3 ? ['🥇', '🥈', '🥉'][r.rank - 1] : r.rank}</span>
                    <button type="button" class="row-av" data-profile="${esc(r.user_id)}" aria-label="${esc(r.display_name)}’s profile">${avatar({ id: r.user_id, display_name: r.display_name, avatar_path: r.avatar_path }, 'sm')}</button>
                    <button type="button" class="pl-who" data-profile="${esc(r.user_id)}"><strong>${esc(r.is_me ? 'You' : r.display_name)}</strong><small>${r.rounds} ${r.rounds === 1 ? 'round' : 'rounds'} · ${r.accuracy || 0}% right</small></button>
                    <span class="pl-score">${fmt(r.score)}</span>
                </li>`).join('')}</ol>`
            : `<p class="muted small pl-empty">No scores ${b.period === 'today' ? 'today' : b.period === 'all' ? 'yet' : `this ${b.period}`}${b.scope === 'friends' ? ' among your friends' : ''} — play to take first place.</p>`;
        return `
            <section class="pl-section">
                <header class="pl-sec-head"><h3>Leaderboard</h3>${seg('scope', [['everyone', 'Everyone'], ['friends', 'Friends']], b.scope)}</header>
                ${seg('period', [['today', 'Today'], ['week', 'This week'], ['month', 'This month'], ['all', 'All time']], b.period)}
                ${rows}
                <p class="muted small">Daily, weekly, Bible, brain and question-of-the-day scores count. Practice doesn’t.</p>
            </section>`;
    }
    function statsHTML() {
        const st = P.stats || {};
        if (!st.answered) return '';
        return `
            <section class="pl-section">
                <header class="pl-sec-head"><h3>Your trivia</h3></header>
                <div class="pl-cats">${(st.categories || []).map(c => {
                    const pct = c.answered ? Math.round(100 * c.correct / c.answered) : 0;
                    const [e, l] = CATS[c.category] || ['❓', c.category];
                    return `<div class="pl-cat-stat"><span>${e} ${esc(l)}</span><span class="pl-bar" style="--pct:${pct}%"><i></i></span><b>${pct}%</b></div>`;
                }).join('')}</div>
            </section>`;
    }

    app.views.play = () => {
        app.setTitle('Play');
        const blocked = I.gate('Daily trivia, challenges and leaderboards — learn something every day.');
        if (blocked) return blocked;
        if (!P.today) { load(); return '<div class="pl"><div class="post-skel"><i class="sk-line w40"></i><i class="sk-line"></i><i class="sk-line w70"></i></div></div>'; }
        const st = P.stats || {};
        return `
            <div class="pl">
                <header class="pl-hero">
                    <div>
                        <p class="pl-kicker">Play & learn</p>
                        <h2>Good ${greeting()}, ${esc((s.profile.display_name || '').split(' ')[0])}</h2>
                        <p class="muted">A few minutes a day: trivia, a new word, a thought and a quick poll.</p>
                    </div>
                    <div class="pl-hero-stats">
                        <div><b>🔥 ${st.streak || 0}</b><span>day streak</span></div>
                        <div><b>${fmt(st.score)}</b><span>points</span></div>
                        <div><b>${st.accuracy === null || st.accuracy === undefined ? '—' : `${st.accuracy}%`}</b><span>accuracy</span></div>
                    </div>
                </header>
                <section class="pl-section">
                    <header class="pl-sec-head"><h3>Today’s challenges</h3><small class="muted">New challenges at midnight UTC</small></header>
                    <div class="pl-cards">${['daily', 'bible', 'brain', 'weekly'].map(challengeCard).join('')}</div>
                </section>
                <div class="pl-dailies">
                    ${qotdCard()}
                    ${wordCard(P.today.word)}
                    ${pollCard(P.today.poll)}
                    ${thoughtCard(P.today.thought)}
                </div>
                <section class="pl-section">
                    <header class="pl-sec-head"><h3>Practice</h3><small class="muted">As many rounds as you like</small></header>
                    <div class="pl-practice">${Object.entries(CATS).map(([k, [e, l]]) =>
                        `<button type="button" class="pl-topic" data-pl="practice" data-cat="${k}"><span aria-hidden="true">${e}</span>${esc(l)}</button>`).join('')}</div>
                </section>
                ${boardHTML()}
                ${statsHTML()}
            </div>`;
    };
    const greeting = () => { const h = new Date().getHours(); return h < 12 ? 'morning' : h < 17 ? 'afternoon' : 'evening'; };

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
    const catLabel = c => { const [e, l] = CATS[c] || ['❓', c]; return `${e} ${l}`; };

    function head(extra = '') {
        const r = Q.round;
        return `
            <header class="quiz-head">
                <button type="button" class="icon-btn" data-q="close" aria-label="Close"><svg class="i"><use href="#i-close"/></svg></button>
                <div class="quiz-title"><strong>${KINDS[r.kind].emoji} ${esc(r.kind === 'practice' ? `Practice · ${CATS[r.category] ? CATS[r.category][1] : 'Random'}` : KINDS[r.kind].title)}</strong>
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
                    <p class="quiz-cat">${esc(catLabel(q.category))}</p>
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
                    <p class="quiz-cat">${esc(catLabel(q.category))}</p>
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
        else if (act === 'scope' || act === 'period') { P.board[act] = b.dataset.v; P.board.rows = null; paint(); loadBoard(); }
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
                <span class="pl-feed-emoji" aria-hidden="true">🧠</span>
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
    const previousMenu = app.hooks.menuItems;
    app.hooks.menuItems = () => [
        ...(previousMenu ? previousMenu() : []),
        ...(me() ? [{ label: 'Play & learn', icon: 'i-trophy', onClick: () => app.setView('play') }] : [])
    ];
    app.onRefresh && app.onRefresh('play', () => { P.today = null; load(); });

    // Trivia numbers for a profile (null when they keep their numbers private)
    async function statsFor(userId) {
        const { data } = await client.rpc('diary_trivia_stats', { p_user: userId });
        return data || null;
    }

    window.diaryPlay = { open: () => app.setView('play'), start, feedCard, statsFor, CATS, refresh: load };
});
