// Safety: block / unblock people, report messages, posts, listings and accounts, and — for app admins — a
// moderation dashboard (reports queue, suspended accounts, audit log, activity). Group staff see reports
// from their own groups. Everything is enforced in the database; this is the interface to it.
document.addEventListener('DOMContentLoaded', () => {
    const app = window.diaryApp;
    const social = window.diarySocial;
    if (!app || !social || !social.internals) return;
    const I = social.internals;
    const { client, state: s, esc, avatar, timeAgo } = I;
    const $ = id => document.getElementById(id);
    const content = $('content');

    const S = { blocked: new Set(), admin: false, suspended: null, userId: null, dash: { tab: 'reports', reports: null, suspended: null, audit: null, stats: null } };
    const me = () => s.profile && s.profile.id;

    // ---------- Start / stop with the account ----------
    setInterval(async () => {
        const id = me();
        if (id && S.userId !== id) {
            S.userId = id;
            await Promise.all([loadBlocks(), checkAdmin(), checkSuspended()]);
        }
        if (!id && S.userId) Object.assign(S, { userId: null, blocked: new Set(), admin: false, suspended: null });
    }, 1000);

    async function loadBlocks() {
        const { data } = await client.from('diary_blocks').select('blocked');
        S.blocked = new Set((data || []).map(r => r.blocked));
    }
    async function checkAdmin() {
        const { data } = await client.rpc('diary_am_admin');
        S.admin = !!data;
        paintAdminNav();
    }
    async function checkSuspended() {
        const { data } = await client.from('diary_suspensions').select('until, reason').eq('user_id', me()).maybeSingle();
        S.suspended = data && (!data.until || Date.parse(data.until) > Date.now()) ? data : null;
        paintSuspended();
    }

    function paintAdminNav() {
        let btn = document.querySelector('.nav-item[data-view="admin"]');
        if (S.admin && !btn) {
            const settings = document.querySelector('.nav-item[data-view="settings"]');
            if (!settings) return;
            btn = document.createElement('button');
            btn.className = 'nav-item';
            btn.dataset.view = 'admin';
            btn.innerHTML = '<svg class="i"><use href="#i-shield"/></svg>Moderation';
            btn.addEventListener('click', () => app.setView('admin'));
            settings.before(btn);
        } else if (!S.admin && btn) btn.remove();
    }

    // A clear notice when your account is suspended (you can still read)
    function paintSuspended() {
        let bar = $('suspended-bar');
        if (!S.suspended) { if (bar) bar.remove(); return; }
        if (!bar) {
            bar = document.createElement('div');
            bar.id = 'suspended-bar';
            bar.className = 'suspended-bar';
            bar.setAttribute('role', 'status');
            const col = document.querySelector('.main-col');
            if (col) col.insertBefore(bar, $('content'));
        }
        const until = S.suspended.until ? `until ${new Date(S.suspended.until).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}` : 'until a moderator lifts it';
        bar.innerHTML = `<svg class="i"><use href="#i-shield"/></svg><span><strong>Your account is limited ${esc(until)}.</strong> You can read, but not post or message. Reason: ${esc(S.suspended.reason || 'a breach of the community rules')}.</span>`;
    }

    // ---------- Block ----------
    const isBlocked = id => S.blocked.has(id);

    async function block(person) {
        const name = person.display_name || 'this person';
        const ok = await app.ask({
            title: `Block ${name}?`,
            text: 'They won’t be able to message you, call you, send you friend requests or find you in search. They won’t be told. You can unblock them any time in Settings → Privacy.',
            ok: 'Block', danger: true
        });
        if (!ok) return false;
        const { error } = await client.from('diary_blocks').insert({ blocked: person.id });
        if (error && error.code !== '23505') { app.showToast('Couldn’t block them'); return false; }
        S.blocked.add(person.id);
        app.showToast(`${name} is blocked`);
        app.requestRender();
        return true;
    }

    async function unblock(person) {
        const { error } = await client.from('diary_blocks').delete().eq('blocked', person.id);
        if (error) { app.showToast('Couldn’t unblock them'); return false; }
        S.blocked.delete(person.id);
        app.showToast(`${person.display_name || 'They'} ${person.display_name ? 'is' : 'are'} unblocked`);
        app.requestRender();
        return true;
    }

    async function blockedList() {
        const ids = [...S.blocked];
        if (!ids.length) return [];
        const { data } = await client.from('diary_profiles').select('id, username, display_name, avatar_path').in('id', ids);
        return data || [];
    }

    // ---------- Report ----------
    const REASONS = [
        ['spam', 'Spam or unwanted ads'], ['harassment', 'Harassment or bullying'], ['hate', 'Hate speech'],
        ['violence', 'Violence or threats'], ['sexual', 'Sexual content'], ['self_harm', 'Self-harm or suicide'],
        ['scam', 'Scam or fraud'], ['impersonation', 'Pretending to be someone else'], ['other', 'Something else']
    ];
    let reportDlg = null;
    // kind: user | dm | gc | post | entry | comment | listing
    function report(kind, targetId, { who = '', offerBlock = null } = {}) {
        if (!reportDlg) {
            reportDlg = document.createElement('dialog');
            reportDlg.className = 'ct-sheet report-sheet';
            document.body.append(reportDlg);
            reportDlg.addEventListener('click', e => { if (e.target === reportDlg || e.target.closest('[data-ct-close]')) reportDlg.close(); });
        }
        const what = { user: 'account', dm: 'message', gc: 'message', post: 'post', entry: 'post', comment: 'comment', listing: 'listing' }[kind] || 'content';
        reportDlg.innerHTML = `
            <form class="ct-card" id="report-form">
                <header class="ct-head"><strong>Report this ${what}</strong><button type="button" class="icon-btn" data-ct-close aria-label="Close"><svg class="i"><use href="#i-close"/></svg></button></header>
                <p class="muted small">${who ? `About ${esc(who)}. ` : ''}Your report is private — ${kind === 'gc' || kind === 'post' ? 'the group’s moderators and ' : ''}Cordial’s moderators will see it, not the person you report.</p>
                <fieldset class="report-reasons"><legend class="sr-only">Why are you reporting it?</legend>
                    ${REASONS.map(([k, l], i) => `<label class="report-reason"><input type="radio" name="reason" value="${k}"${i === 0 ? ' required' : ''}><span>${l}</span></label>`).join('')}
                </fieldset>
                <label class="mk-field"><span>Anything else we should know? (optional)</span><textarea name="details" rows="2" maxlength="1000"></textarea></label>
                ${offerBlock ? '<label class="report-block"><input type="checkbox" name="block" checked> Also block them</label>' : ''}
                <p class="muted small">If someone is in immediate danger, contact your local emergency services.</p>
                <footer class="ct-foot"><button type="submit" class="primary-btn block">Send report</button></footer>
            </form>`;
        reportDlg.querySelector('#report-form').onsubmit = async e => {
            e.preventDefault();
            const f = e.currentTarget;
            const reason = f.reason.value;
            if (!reason) return;
            const btn = f.querySelector('[type="submit"]');
            btn.disabled = true;
            const { error } = await client.rpc('diary_report', { p_kind: kind, p_target: String(targetId), p_reason: reason, p_details: f.details.value.trim() || null });
            btn.disabled = false;
            if (error) return app.showToast(error.message || 'Couldn’t send the report');
            reportDlg.close();
            app.showToast('Thanks — your report was sent to the moderators');
            if (offerBlock && f.block && f.block.checked) block(offerBlock);
        };
        if (!reportDlg.open) reportDlg.showModal();
    }

    // ---------- Moderation dashboard (app admins) ----------
    const REASON_LABEL = Object.fromEntries(REASONS);
    const KIND_LABEL = { user: 'Account', dm: 'Direct message', gc: 'Group message', post: 'Group post', entry: 'Feed post', comment: 'Comment', listing: 'Marketplace listing' };

    async function loadDash() {
        const d = S.dash;
        const [stats, reports, suspended, audit] = await Promise.all([
            client.rpc('diary_admin_stats'),
            client.from('diary_reports').select('*').order('created_at', { ascending: false }).limit(200),
            client.from('diary_suspensions').select('*').order('created_at', { ascending: false }),
            client.from('diary_audit_log').select('*').order('created_at', { ascending: false }).limit(200)
        ]);
        d.stats = stats.data || {};
        d.reports = reports.data || [];
        d.suspended = suspended.data || [];
        d.audit = audit.data || [];
        const ids = [...new Set([...d.reports.flatMap(r => [r.reporter, r.target_user]), ...d.suspended.map(x => x.user_id), ...d.audit.flatMap(a => [a.actor, a.target_user])].filter(Boolean))];
        const { data: people } = ids.length ? await client.from('diary_profiles').select('id, username, display_name, avatar_path').in('id', ids) : { data: [] };
        d.people = new Map((people || []).map(p => [p.id, p]));
        app.requestRender('admin');
    }
    const verifiedTick = (id, kind) => (I.tick ? I.tick(id, kind) : '');
    const loadVerified = () => { if (I.loadVerified) I.loadVerified(); };
    // ---------- More admin tools: accounts, verification, questions, games, scheduled posts, announcements ----------
    const VKINDS = { person: 'Public figure', organisation: 'Organisation', minister: 'Minister', educator: 'Educator', administrator: 'Administrator' };
    const QCATS = ['general', 'bible', 'history', 'science', 'current', 'sports', 'education', 'brain'];
    const QLABEL = { general: 'General knowledge', bible: 'Bible', history: 'History', science: 'Science & tech', current: 'Current affairs', sports: 'Sports', education: 'Education', brain: 'Brain teasers' };
    const GLABEL = { five: 'Five', wordsearch: 'Word search', sudoku: 'Sudoku', memory: 'Memory', maths: 'Maths sprint', slide: 'Sliding puzzle' };
    const X = { users: null, userQ: '', requests: null, questions: null, qCat: '', qSearch: '', games: null, scheduled: null, announcements: null, badges: null };

    async function loadExtra(tab) {
        if (tab === 'accounts') {
            const { data } = await client.rpc('diary_admin_users', { p_search: X.userQ || null, p_limit: 100 });
            X.users = data || [];
        } else if (tab === 'verify') {
            const { data } = await client.from('diary_verification_requests').select('*').order('created_at', { ascending: false }).limit(100);
            X.requests = data || [];
            const ids = [...new Set(X.requests.map(r => r.user_id))];
            const { data: people } = ids.length ? await client.from('diary_profiles').select('id, username, display_name, avatar_path').in('id', ids) : { data: [] };
            (people || []).forEach(p => S.dash.people.set(p.id, p));
        } else if (tab === 'questions') {
            const { data } = await client.rpc('diary_admin_questions', { p_category: X.qCat || null, p_search: X.qSearch || null, p_limit: 200 });
            X.questions = data || [];
        } else if (tab === 'games') {
            const { data } = await client.from('diary_game_settings').select('game, enabled');
            X.games = Object.fromEntries(Object.keys(GLABEL).map(g => [g, true]));
            (data || []).forEach(r => { X.games[r.game] = r.enabled; });
        } else if (tab === 'scheduled') {
            const { data } = await client.rpc('diary_admin_scheduled', { p_limit: 200 });
            X.scheduled = data || [];
        } else if (tab === 'announce') {
            const { data } = await client.from('diary_announcements').select('*').order('created_at', { ascending: false }).limit(30);
            X.announcements = data || [];
        }
        if (!X.badges) { const { data } = await client.from('diary_badges').select('id, name, tier').order('sort'); X.badges = data || []; }
        app.requestRender('admin');
    }

    function extraBody(tab) {
        const loading = '<p class="muted">Loading…</p>';
        if (tab === 'accounts') {
            if (X.users === null) { loadExtra(tab); return loading; }
            return `
                <label class="search adm-search"><svg class="i"><use href="#i-search"/></svg><input type="search" id="adm-user-q" placeholder="Search by name or @username" value="${esc(X.userQ)}" enterkeyhint="search"></label>
                ${X.users.map(u => `
                    <div class="adm-row adm-user">
                        <button type="button" class="row-av" data-profile="${esc(u.id)}" aria-label="${esc(u.display_name)}’s profile">${avatar(u, 'md')}</button>
                        <span><strong>${esc(u.display_name)}${u.verified ? ` ${verifiedTick(u.id, u.verified)}` : ''}</strong>
                            <small>@${esc(u.username)} · joined ${esc(new Date(u.created_at).toLocaleDateString())} · ${u.posts} posts · ${Number(u.xp).toLocaleString()} XP${u.reports ? ` · <b class="adm-warn">${u.reports} ${u.reports === 1 ? 'report' : 'reports'}</b>` : ''}</small>
                            <span class="adm-flags">${u.suspended ? `<span class="adm-flag danger">Suspended${u.suspended_until ? ` until ${esc(new Date(u.suspended_until).toLocaleDateString())}` : ''}</span>` : ''}${u.board_hidden ? '<span class="adm-flag">Hidden from leaderboards</span>' : ''}${u.verified ? `<span class="adm-flag ok">${esc(VKINDS[u.verified])}</span>` : ''}</span></span>
                        <button type="button" class="chip" data-action="adm-user-menu" data-id="${esc(u.id)}" aria-haspopup="menu">Manage</button>
                    </div>`).join('') || '<p class="muted">No accounts match.</p>'}`;
        }
        if (tab === 'verify') {
            if (X.requests === null) { loadExtra(tab); return loading; }
            const pending = X.requests.filter(r => r.status === 'pending');
            const done = X.requests.filter(r => r.status !== 'pending').slice(0, 20);
            return `
                ${pending.map(r => `
                    <article class="adm-report">
                        <header><span class="adm-kind">${esc(VKINDS[r.kind])}</span><strong>${esc(personName(r.user_id))}</strong><time>${esc(timeAgo(r.created_at))}</time></header>
                        ${r.note ? `<p class="adm-details">“${esc(r.note)}”</p>` : ''}
                        ${r.link ? `<p class="adm-meta">Link: <a href="${esc(/^https?:\/\//i.test(r.link) ? r.link : `https://${r.link}`)}" target="_blank" rel="noopener noreferrer">${esc(r.link)}</a></p>` : ''}
                        <div class="adm-actions">
                            <button type="button" class="chip accent" data-action="adm-verify" data-id="${r.id}" data-ok="1">Approve</button>
                            <button type="button" class="chip danger" data-action="adm-verify" data-id="${r.id}" data-ok="0">Decline</button>
                            <button type="button" class="chip" data-profile="${esc(r.user_id)}">View profile</button>
                        </div>
                    </article>`).join('') || '<p class="muted">No one is waiting to be verified.</p>'}
                ${done.length ? `<h3 class="adm-sub">Recently handled</h3>${done.map(r => `<div class="adm-row"><span><strong>${esc(personName(r.user_id))}</strong><small>${esc(VKINDS[r.kind])} · ${r.status === 'approved' ? 'Approved' : 'Declined'} ${esc(timeAgo(r.handled_at))}${r.response ? ` · “${esc(r.response)}”` : ''}</small></span></div>`).join('')}` : ''}`;
        }
        if (tab === 'questions') {
            if (X.questions === null) { loadExtra(tab); return loading; }
            return `
                <div class="adm-toolbar">
                    <select id="adm-q-cat" aria-label="Category"><option value="">All categories</option>${QCATS.map(c => `<option value="${c}"${X.qCat === c ? ' selected' : ''}>${QLABEL[c]}</option>`).join('')}</select>
                    <label class="search adm-search"><svg class="i"><use href="#i-search"/></svg><input type="search" id="adm-q-search" placeholder="Search questions" value="${esc(X.qSearch)}" enterkeyhint="search"></label>
                    <button type="button" class="primary-btn" data-action="adm-q-edit"><svg class="i"><use href="#i-plus"/></svg>New question</button>
                </div>
                <p class="muted small">${X.questions.length} shown · questions you switch off stop appearing in new rounds straight away.</p>
                ${X.questions.map(q => `
                    <article class="adm-q${q.active ? '' : ' off'}">
                        <header><span class="adm-kind">${esc(QLABEL[q.category])}</span><span class="adm-kind">${'●'.repeat(q.difficulty)}${'○'.repeat(3 - q.difficulty)}</span>${q.active ? '' : '<span class="adm-flag">Off</span>'}</header>
                        <p class="adm-q-text">${esc(q.question)}</p>
                        <ol class="adm-q-choices">${q.choices.map((c, i) => `<li${i === q.answer ? ' class="right"' : ''}>${esc(c)}</li>`).join('')}</ol>
                        ${q.explanation ? `<p class="muted small">${esc(q.explanation)}</p>` : ''}
                        <div class="adm-actions">
                            <button type="button" class="chip" data-action="adm-q-edit" data-id="${q.id}">Edit</button>
                            <button type="button" class="chip" data-action="adm-q-toggle" data-id="${q.id}">${q.active ? 'Switch off' : 'Switch on'}</button>
                        </div>
                    </article>`).join('') || '<p class="muted">No questions match.</p>'}`;
        }
        if (tab === 'games') {
            if (X.games === null) { loadExtra(tab); return loading; }
            return `<p class="muted small">A paused game disappears from Playnote and can’t be scored until you switch it back on.</p>
                ${Object.entries(GLABEL).map(([g, l]) => `
                <div class="adm-row"><span><strong>${esc(l)}</strong><small>${X.games[g] ? 'On — daily puzzle and practice' : 'Paused'}</small></span>
                    <label class="st-switch share-toggle" aria-label="${esc(l)}"><input type="checkbox" data-adm-game="${g}"${X.games[g] ? ' checked' : ''}><span class="switch" aria-hidden="true"></span></label></div>`).join('')}`;
        }
        if (tab === 'scheduled') {
            if (X.scheduled === null) { loadExtra(tab); return loading; }
            return X.scheduled.map(x => `
                <article class="adm-report">
                    <header><span class="adm-kind">${esc({ feed: 'Feed post', group: 'Group post', message: 'Message' }[x.target])}</span><strong>${esc(x.display_name)} (@${esc(x.username)})</strong><time>${x.publish_at ? esc(new Date(x.publish_at).toLocaleString()) : ''}</time></header>
                    ${x.title ? `<p class="adm-q-text">${esc(x.title)}</p>` : ''}
                    <blockquote>${esc(x.body || '')}</blockquote>
                    <div class="adm-actions">${x.status === 'failed' ? '<span class="adm-flag danger">Failed</span>' : ''}<button type="button" class="chip danger" data-action="adm-sched-cancel" data-id="${x.id}">Cancel it</button></div>
                </article>`).join('') || '<p class="muted">Nothing is waiting to be posted.</p>';
        }
        if (tab === 'announce') {
            if (X.announcements === null) { loadExtra(tab); return loading; }
            const live = a => a.active && (!a.expires_at || Date.parse(a.expires_at) > Date.now());
            return `
                <form class="adm-announce" data-adm-form="announce">
                    <label class="field"><span>Headline</span><input name="title" maxlength="120" required placeholder="e.g. New: daily puzzles on Playnote"></label>
                    <label class="field"><span>Message</span><textarea name="body" maxlength="1000" rows="3" placeholder="A sentence or two"></textarea></label>
                    <label class="field"><span>Link <small class="muted">optional</small></span><input name="link" maxlength="300" placeholder="#/play or https://…"></label>
                    <div class="adm-announce-row">
                        <label class="field"><span>Show for</span><select name="days"><option value="1">1 day</option><option value="3">3 days</option><option value="7" selected>7 days</option><option value="30">30 days</option><option value="0">Until I end it</option></select></label>
                        <label class="sched-check"><input type="checkbox" name="notify" checked><span><strong>Also notify everyone</strong><small>A notification to every account</small></span></label>
                    </div>
                    <button type="submit" class="primary-btn">Publish announcement</button>
                </form>
                ${X.announcements.map(a => `
                    <div class="adm-row"><span><strong>${esc(a.title)}</strong><small>${esc(timeAgo(a.created_at))} · ${live(a) ? (a.expires_at ? `until ${esc(new Date(a.expires_at).toLocaleDateString())}` : 'until ended') : 'ended'}</small></span>
                        ${live(a) ? `<button type="button" class="chip" data-action="adm-announce-end" data-id="${a.id}">End</button>` : ''}</div>`).join('')}`;
        }
        return '';
    }

    function questionDialog(q) {
        const dlg = document.createElement('dialog');
        dlg.className = 'sheet-dialog';
        const choices = q ? q.choices.concat(['', '', '', '']).slice(0, 4) : ['', '', '', ''];
        dlg.innerHTML = `
            <form class="rx-card sched-form" novalidate>
                <header class="rx-head"><h2>${q ? 'Edit question' : 'New question'}</h2><button type="button" class="icon-btn" data-x="close" aria-label="Close"><svg class="i"><use href="#i-close"/></svg></button></header>
                <div class="sched-scroll">
                    <label class="field"><span>Category</span><select name="category">${QCATS.map(c => `<option value="${c}"${(q ? q.category : X.qCat || 'general') === c ? ' selected' : ''}>${QLABEL[c]}</option>`).join('')}</select></label>
                    <label class="field"><span>Difficulty</span><select name="difficulty">${[[1, 'Easy'], [2, 'Medium'], [3, 'Hard']].map(([v, l]) => `<option value="${v}"${(q ? q.difficulty : 2) === v ? ' selected' : ''}>${l}</option>`).join('')}</select></label>
                    <label class="field"><span>Question</span><textarea name="question" rows="2" maxlength="400" required>${esc(q ? q.question : '')}</textarea></label>
                    <fieldset class="adm-choices"><legend>Answers — tick the right one</legend>${choices.map((c, i) => `
                        <label class="adm-choice"><input type="radio" name="answer" value="${i}"${(q ? q.answer : 0) === i ? ' checked' : ''} aria-label="Answer ${i + 1} is right"><input name="c${i}" maxlength="120" value="${esc(c)}" placeholder="Answer ${i + 1}${i > 1 ? ' (optional)' : ''}"></label>`).join('')}</fieldset>
                    <label class="field"><span>Why it’s right <small class="muted">optional</small></span><input name="explanation" maxlength="400" value="${esc(q ? q.explanation : '')}"></label>
                    <label class="sched-check"><input type="checkbox" name="active"${!q || q.active ? ' checked' : ''}><span><strong>In play</strong><small>Can appear in new rounds</small></span></label>
                </div>
                <footer class="sched-foot"><button type="button" class="ghost-btn" data-x="close">Cancel</button><button type="submit" class="primary-btn">Save</button></footer>
            </form>`;
        document.body.append(dlg);
        dlg.showModal();
        dlg.addEventListener('close', () => dlg.remove());
        dlg.addEventListener('click', e => { if (e.target === dlg || e.target.closest('[data-x="close"]')) dlg.close(); });
        dlg.addEventListener('submit', async e => {
            e.preventDefault();
            const f = dlg.querySelector('form');
            const raw = [0, 1, 2, 3].map(i => f[`c${i}`].value.trim());
            let answer = Number(f.answer.value);
            // Blank answers drop out; keep the ticked one pointing at the same text
            const right = raw[answer];
            const list = raw.filter(Boolean);
            if (!f.question.value.trim()) return app.showToast('Write the question');
            if (list.length < 2) return app.showToast('Give at least two answers');
            if (!right) return app.showToast('Tick an answer that isn’t blank');
            answer = list.indexOf(right);
            const { error } = await client.rpc('diary_admin_save_question', { p_id: q ? q.id : null, p_category: f.category.value, p_difficulty: Number(f.difficulty.value),
                p_question: f.question.value.trim(), p_choices: list, p_answer: answer, p_explanation: f.explanation.value.trim(), p_active: f.active.checked });
            if (error) return app.showToast(error.message || 'Couldn’t save that question');
            dlg.close();
            app.showToast(q ? 'Question updated' : 'Question added');
            X.questions = null;
            app.render();
        });
    }

    function userMenu(anchor, u) {
        const ask = (title, placeholder) => app.ask({ title, text: 'Add a short reason for the audit log (optional).', value: '', placeholder, allowEmpty: true, ok: 'Confirm', danger: true });
        const run = async (fn, args, done) => {
            const { error } = await client.rpc(fn, args);
            if (error) return app.showToast(error.message || 'Couldn’t do that');
            app.showToast(done);
            X.users = null;
            app.render();
        };
        const items = [
            { label: 'View profile', icon: 'i-user', onClick: () => window.diaryProfile && window.diaryProfile.open(u.id) },
            ...(u.verified
                ? [{ label: 'Remove verification', icon: 'i-close', onClick: () => run('diary_admin_set_verified', { p_user: u.id, p_kind: null }, 'Verification removed') }]
                : Object.entries(VKINDS).map(([k, l]) => ({ label: `Verify as ${l.toLowerCase()}`, icon: 'i-verified', onClick: () => run('diary_admin_set_verified', { p_user: u.id, p_kind: k }, 'Verified ✓') }))),
            u.board_hidden
                ? { label: 'Show on leaderboards again', icon: 'i-trophy', onClick: () => run('diary_admin_board_ban', { p_user: u.id, p_ban: false, p_reason: '' }, 'Back on the leaderboards') }
                : { label: 'Hide from leaderboards', icon: 'i-trophy', onClick: async () => { const r = await ask('Hide from all leaderboards?', 'e.g. Suspicious scores'); if (r) run('diary_admin_board_ban', { p_user: u.id, p_ban: true, p_reason: (r.value || '').trim() }, 'Hidden from leaderboards'); } },
            { label: 'Void this week’s scores', icon: 'i-trash', danger: true, onClick: async () => { const r = await ask('Delete this week’s trivia and game scores?', 'Reason'); if (r) { const d = new Date(); d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7)); d.setUTCHours(0, 0, 0, 0); run('diary_admin_void_scores', { p_user: u.id, p_since: d.toISOString() }, 'Scores voided'); } } },
            { label: 'Award a badge…', icon: 'i-trophy', onClick: () => app.openPopover(anchor, (X.badges || []).map(b => ({ label: b.name, onClick: () => run('diary_admin_badge', { p_user: u.id, p_badge: b.id, p_award: true }, `${b.name} awarded`) }))) },
            { label: 'Take a badge away…', icon: 'i-close', onClick: () => app.openPopover(anchor, (X.badges || []).map(b => ({ label: b.name, onClick: () => run('diary_admin_badge', { p_user: u.id, p_badge: b.id, p_award: false }, `${b.name} removed`) }))) },
            ...(u.suspended
                ? [{ label: 'Lift suspension', icon: 'i-check', onClick: () => run('diary_lift_suspension', { p_user: u.id }, 'Suspension lifted') }]
                : [[7, 'Suspend for 7 days'], [30, 'Suspend for 30 days'], [0, 'Suspend until lifted']].map(([days, label]) => ({ label, icon: 'i-block', danger: true, onClick: async () => { const r = await ask(`${label}?`, 'Reason'); if (r) run('diary_admin_suspend', { p_user: u.id, p_days: days, p_reason: (r.value || '').trim() }, 'Suspended'); } })))
        ];
        app.openPopover(anchor, items);
    }

    Object.assign(app.actions, {
        'adm-user-menu': el => { const u = (X.users || []).find(x => x.id === el.dataset.id); if (u) userMenu(el, u); },
        'adm-verify': async el => {
            const ok = el.dataset.ok === '1';
            const r = await app.ask({ title: ok ? 'Approve and verify?' : 'Decline this request?', text: 'A short note for them (optional).', value: '', placeholder: ok ? 'Welcome!' : 'What’s missing', allowEmpty: true, ok: ok ? 'Approve' : 'Decline', danger: !ok });
            if (!r) return;
            const { error } = await client.rpc('diary_admin_verify', { p_request: el.dataset.id, p_approve: ok, p_note: (r.value || '').trim() || null });
            if (error) return app.showToast(error.message || 'Couldn’t do that');
            app.showToast(ok ? 'Verified ✓ — they’ve been told' : 'Declined — they’ve been told');
            X.requests = null;
            loadVerified();
            app.render();
        },
        'adm-q-edit': el => questionDialog(el.dataset.id ? (X.questions || []).find(q => q.id === el.dataset.id) : null),
        'adm-q-toggle': async el => {
            const q = (X.questions || []).find(x => x.id === el.dataset.id);
            if (!q) return;
            const { error } = await client.rpc('diary_admin_save_question', { p_id: q.id, p_category: q.category, p_difficulty: q.difficulty, p_question: q.question, p_choices: q.choices, p_answer: q.answer, p_explanation: q.explanation, p_active: !q.active });
            if (error) return app.showToast(error.message || 'Couldn’t change it');
            q.active = !q.active;
            app.render();
        },
        'adm-sched-cancel': async el => {
            const r = await app.ask({ title: 'Cancel this scheduled post?', text: 'Its author will see it was cancelled by a moderator. Add a reason (optional).', value: '', allowEmpty: true, ok: 'Cancel it', danger: true });
            if (!r) return;
            const { error } = await client.rpc('diary_admin_cancel_scheduled', { p_id: el.dataset.id, p_reason: (r.value || '').trim() });
            if (error) return app.showToast(error.message || 'Couldn’t cancel it');
            X.scheduled = null;
            app.render();
        },
        'adm-announce-end': async el => {
            const { error } = await client.rpc('diary_admin_end_announcement', { p_id: el.dataset.id });
            if (error) return app.showToast('Couldn’t end it');
            X.announcements = null;
            app.render();
        }
    });
    content.addEventListener('change', async e => {
        const g = e.target.dataset && e.target.dataset.admGame;
        if (g) {
            const { error } = await client.rpc('diary_admin_set_game', { p_game: g, p_enabled: e.target.checked });
            if (error) { e.target.checked = !e.target.checked; return app.showToast('Couldn’t change that'); }
            X.games[g] = e.target.checked;
            app.showToast(`${GLABEL[g]} ${e.target.checked ? 'is back on' : 'is paused'}`);
            if (window.diaryGames) window.diaryGames.refresh();
            app.render();
        }
        if (e.target.id === 'adm-q-cat') { X.qCat = e.target.value; X.questions = null; app.render(); }
    });
    content.addEventListener('keydown', e => {
        if (e.key !== 'Enter') return;
        if (e.target.id === 'adm-user-q') { X.userQ = e.target.value.trim(); X.users = null; app.render(); }
        if (e.target.id === 'adm-q-search') { X.qSearch = e.target.value.trim(); X.questions = null; app.render(); }
    });
    content.addEventListener('submit', async e => {
        const f = e.target.closest('[data-adm-form="announce"]');
        if (!f) return;
        e.preventDefault();
        if (!f.title.value.trim()) return f.title.focus();
        const ok = await app.ask({ title: 'Publish this announcement?', text: f.notify.checked ? 'Everyone on Cordial will get a notification.' : 'It shows as a banner on the feed.', ok: 'Publish' });
        if (!ok) return;
        const { error } = await client.rpc('diary_admin_announce', { p_title: f.title.value.trim(), p_body: f.body.value.trim(), p_link: f.link.value.trim(), p_days: Number(f.days.value), p_notify: f.notify.checked });
        if (error) return app.showToast(error.message || 'Couldn’t publish it');
        app.showToast('Announcement published');
        X.announcements = null;
        if (window.diaryAnnounce) window.diaryAnnounce.refresh();
        app.render();
    });


    const personName = id => { const p = S.dash.people && S.dash.people.get(id); return p ? `${p.display_name} (@${p.username})` : 'Deleted account'; };

    app.views.admin = () => {
        app.setTitle('Moderation');
        if (!S.admin) return '<div class="empty"><strong>Moderation</strong><p class="muted">Only Cordial’s moderators can open this page.</p></div>';
        const d = S.dash;
        if (d.reports !== null && X.requests === null && d.tab !== 'verify') loadExtra('verify');
        if (d.reports === null) { loadDash(); return '<div class="adm"><p class="muted">Loading the dashboard…</p></div>'; }
        const open = d.reports.filter(r => r.status === 'open');
        const tab = (k, l, n) => `<button type="button" class="tab" role="tab" aria-selected="${d.tab === k}" data-action="adm-tab" data-tab="${k}">${l}${n ? `<span class="badge">${n}</span>` : ''}</button>`;
        const st = d.stats || {};
        const card = (label, value) => `<div class="adm-stat"><strong>${Number(value || 0).toLocaleString()}</strong><span>${label}</span></div>`;
        let body = '';
        if (d.tab === 'reports' || d.tab === 'closed') {
            const list = d.tab === 'reports' ? open : d.reports.filter(r => r.status !== 'open');
            body = list.length ? list.map(r => `
                <article class="adm-report">
                    <header><span class="adm-kind">${esc(KIND_LABEL[r.kind] || r.kind)}</span><strong>${esc(REASON_LABEL[r.reason] || r.reason)}</strong><time>${esc(timeAgo(r.created_at))}</time></header>
                    <p class="adm-meta">Reported: <b>${esc(personName(r.target_user))}</b> · by ${esc(personName(r.reporter))}</p>
                    ${r.snapshot ? `<blockquote>${esc(r.kind === 'dm' ? Rich.toText(r.snapshot) : r.snapshot)}</blockquote>` : ''}
                    ${r.details ? `<p class="adm-details">“${esc(r.details)}”</p>` : ''}
                    ${r.status === 'open' ? `<div class="adm-actions">
                        <button type="button" class="chip" data-action="adm-act" data-id="${r.id}" data-act="dismiss">Dismiss</button>
                        <button type="button" class="chip" data-action="adm-act" data-id="${r.id}" data-act="warn">Mark reviewed</button>
                        ${r.kind !== 'user' ? `<button type="button" class="chip danger" data-action="adm-act" data-id="${r.id}" data-act="remove">Remove content</button>` : ''}
                        ${r.target_user ? `<button type="button" class="chip danger" data-action="adm-act" data-id="${r.id}" data-act="suspend_7d">Suspend 7 days</button>
                        <button type="button" class="chip danger" data-action="adm-act" data-id="${r.id}" data-act="suspend_30d">30 days</button>
                        <button type="button" class="chip danger" data-action="adm-act" data-id="${r.id}" data-act="suspend">Indefinitely</button>` : ''}
                    </div>` : `<p class="adm-meta">${esc(r.status === 'dismissed' ? 'Dismissed' : 'Actioned')} · ${esc(r.resolution || '')} · ${esc(timeAgo(r.handled_at))}</p>`}
                </article>`).join('') : `<p class="muted">${d.tab === 'reports' ? 'No open reports. 🎉' : 'Nothing handled yet.'}</p>`;
        } else if (d.tab === 'suspended') {
            const active = d.suspended.filter(x => !x.until || Date.parse(x.until) > Date.now());
            body = active.length ? active.map(x => `
                <div class="adm-row">${avatar(d.people.get(x.user_id) || { id: x.user_id, display_name: '?' }, 'sm')}
                    <span><strong>${esc(personName(x.user_id))}</strong><small>${esc(x.until ? `Until ${new Date(x.until).toLocaleString()}` : 'Indefinitely')} · ${esc(x.reason || '')}</small></span>
                    <button type="button" class="chip" data-action="adm-lift" data-id="${x.user_id}">Lift</button></div>`).join('') : '<p class="muted">No suspended accounts.</p>';
        } else if (['accounts', 'verify', 'questions', 'games', 'scheduled', 'announce'].includes(d.tab)) {
            body = extraBody(d.tab);
        } else if (d.tab === 'audit') {
            body = d.audit.length ? `<ol class="adm-audit">${d.audit.map(a => `<li><time>${esc(new Date(a.created_at).toLocaleString())}</time><span><b>${esc(personName(a.actor))}</b> ${esc(a.action.replace(/_/g, ' '))}${a.target_user ? ` → ${esc(personName(a.target_user))}` : ''}</span></li>`).join('')}</ol>` : '<p class="muted">No moderation actions yet.</p>';
        }
        return `
            <div class="adm">
                <header class="adm-head"><div><h2>Moderation</h2><p class="muted">Reports, suspended accounts and everything moderators have done.</p></div>
                    <button type="button" class="chip" data-action="adm-refresh"><svg class="i"><use href="#i-refresh"/></svg>Refresh</button></header>
                <div class="adm-stats">${card('Accounts', st.users)}${card('Active today', st.active_today)}${card('Messages today', st.messages_today)}${card('Open reports', st.open_reports)}${card('Suspended', st.suspended)}${card('Blocks', st.blocks)}${card('Communities', st.communities)}</div>
                <div class="tabs adm-tabs" role="tablist">${tab('reports', 'Reports', open.length)}${tab('closed', 'Handled')}${tab('accounts', 'Accounts')}${tab('verify', 'Verification', X.requests ? X.requests.filter(r => r.status === 'pending').length : 0)}${tab('questions', 'Questions')}${tab('games', 'Games')}${tab('scheduled', 'Scheduled')}${tab('announce', 'Announcements')}${tab('suspended', 'Suspended')}${tab('audit', 'Audit log')}</div>
                <div class="adm-body">${body}</div>
            </div>`;
    };
    app.onRefresh('admin', async () => { S.dash.reports = null; await loadDash(); });

    Object.assign(app.actions, {
        'adm-tab': el => { S.dash.tab = el.dataset.tab; app.render(); },
        'adm-refresh': () => { S.dash.reports = null; Object.assign(X, { users: null, requests: null, questions: null, games: null, scheduled: null, announcements: null }); app.render(); },
        'adm-act': async el => {
            const act = el.dataset.act;
            const label = { dismiss: 'Dismiss this report?', warn: 'Mark as reviewed?', remove: 'Remove the reported content?', suspend_7d: 'Suspend this account for 7 days?', suspend_30d: 'Suspend this account for 30 days?', suspend: 'Suspend this account until you lift it?' }[act];
            const res = await app.ask({ title: label, text: 'Add a short note for the audit log (optional).', value: '', placeholder: 'Note', allowEmpty: true, ok: 'Confirm', danger: act !== 'dismiss' && act !== 'warn' });
            if (!res) return;
            const { error } = await client.rpc('diary_resolve_report', { p_id: el.dataset.id, p_action: act, p_note: (res.value || '').trim() || null });
            if (error) return app.showToast(error.message || 'Couldn’t do that');
            app.showToast('Done — logged in the audit log');
            S.dash.reports = null;
            app.render();
        },
        'adm-lift': async el => {
            const { error } = await client.rpc('diary_lift_suspension', { p_user: el.dataset.id });
            if (error) return app.showToast('Couldn’t lift it');
            app.showToast('Suspension lifted');
            S.dash.reports = null;
            app.render();
        }
    });

    // Phones: Moderation lives in the More menu for admins
    const previousMenu = app.hooks.menuItems;
    app.hooks.menuItems = () => [
        ...(previousMenu ? previousMenu() : []),
        ...(S.admin ? [{ label: 'Moderation', icon: 'i-shield', onClick: () => app.setView('admin') }] : [])
    ];

    window.diarySafety = { isBlocked, block, unblock, report, blockedList, isAdmin: () => S.admin, refreshBlocks: loadBlocks };
});
