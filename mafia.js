// Cordial Mafia: a social deduction game. Players get secret roles (Mafia, Citizen, Detective, Doctor);
// at night the Mafia pick someone to eliminate while the Detective investigates and the Doctor protects;
// by day everyone talks it through and votes someone out. DISCUSS → VOTE → REVEAL → NIGHT → …
//
// The host's phone runs the game. Each player's phone makes its own key pair when it joins, and every secret
// (your role, the Detective's findings, the Mafia's plans, night choices) is encrypted for that one phone, so
// other players can't read it off the live channel. Day chat, votes and announcements are public.
document.addEventListener('DOMContentLoaded', () => {
    const app = window.diaryApp;
    const social = window.diarySocial;
    if (!app || !social || !social.internals) return;
    const I = social.internals;
    const { client, state: s, esc } = I;
    const ic = (id, cls = '') => `<svg class="i${cls ? ` ${cls}` : ''}" aria-hidden="true"><use href="#${id}"/></svg>`;
    const me = () => (s.profile && s.profile.id) || null;
    const uid = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`);
    const wait = ms => new Promise(r => setTimeout(r, ms));
    const pickOne = a => a[Math.floor(Math.random() * a.length)];
    const shuffle = a => { const b = a.slice(); for (let i = b.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [b[i], b[j]] = [b[j], b[i]]; } return b; };

    const ROLES = {
        mafia: { name: 'Mafia', emoji: '🔴', team: 'mafia', blurb: 'Each night, choose someone to eliminate with your fellow Mafia. By day, blend in.' },
        citizen: { name: 'Citizen', emoji: '🔵', team: 'town', blurb: 'Listen, ask questions, and vote the Mafia out before they outnumber you.' },
        detective: { name: 'Detective', emoji: '🕵️', team: 'town', blurb: 'Each night, investigate one player to learn whether they’re Mafia.' },
        doctor: { name: 'Doctor', emoji: '❤️', team: 'town', blurb: 'Each night, protect one player from the Mafia — you can protect yourself.' }
    };
    const MIN = 4, MAX = 16;
    function deal(n) {
        const mafia = n >= 12 ? 3 : n >= 8 ? 2 : 1;
        const roles = [...Array(mafia).fill('mafia'), 'doctor', ...(n >= 5 ? ['detective'] : [])];
        while (roles.length < n) roles.push('citizen');
        return shuffle(roles);
    }
    const article = r => (r === 'mafia' ? 'in the' : /^[aeiou]/i.test(ROLES[r].name) ? 'an' : 'a');
    const roleLine = r => `${ROLES[r].emoji} ${r === 'mafia' ? 'MAFIA' : ROLES[r].name.toUpperCase()}`;

    // ======================================================================
    // Keys and sealed messages (ECDH P-256 → AES-GCM)
    // ======================================================================
    const b64 = buf => btoa(String.fromCharCode(...new Uint8Array(buf)));
    const unb64 = str => Uint8Array.from(atob(str), ch => ch.charCodeAt(0));
    const keyCache = new WeakMap(); // my private key → (their public key → shared AES key)
    async function loadKeys(room) {
        const k = `cordialMafiaKey:${room}:${me()}`;
        try {
            const saved = JSON.parse(localStorage.getItem(k) || 'null');
            if (saved) {
                const priv = await crypto.subtle.importKey('jwk', saved.priv, { name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveKey']);
                return { priv, pub: saved.pub };
            }
        } catch (e) { /* make new ones */ }
        const pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveKey']);
        const pub = await crypto.subtle.exportKey('jwk', pair.publicKey);
        const priv = await crypto.subtle.exportKey('jwk', pair.privateKey);
        try { localStorage.setItem(k, JSON.stringify({ pub, priv })); } catch (e) { /* private mode: keys last for this visit */ }
        return { priv: pair.privateKey, pub };
    }
    async function aesWith(priv, pubJwk) {
        const id = `${pubJwk.x}.${pubJwk.y}`;
        if (!keyCache.has(priv)) keyCache.set(priv, new Map());
        const mine = keyCache.get(priv);
        if (mine.has(id)) return mine.get(id);
        const pub = await crypto.subtle.importKey('jwk', { kty: pubJwk.kty, crv: pubJwk.crv, x: pubJwk.x, y: pubJwk.y }, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
        const key = await crypto.subtle.deriveKey({ name: 'ECDH', public: pub }, priv, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
        mine.set(id, key);
        return key;
    }
    async function seal(priv, pubJwk, obj) {
        const iv = crypto.getRandomValues(new Uint8Array(12));
        const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await aesWith(priv, pubJwk), new TextEncoder().encode(JSON.stringify(obj)));
        return { iv: b64(iv), ct: b64(ct) };
    }
    async function unseal(priv, pubJwk, box) {
        const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(box.iv) }, await aesWith(priv, pubJwk), unb64(box.ct));
        return JSON.parse(new TextDecoder().decode(pt));
    }

    // ======================================================================
    // The room on this phone
    // ======================================================================
    let R = null; // { id, host, isHost, keys, P, secret, chat, ch, present, dlg, H, timer, ticker, chatOpenAt }
    const secretKey = () => `cordialMafia:${R.id}:${me()}`;
    const saveSecret = () => { try { localStorage.setItem(secretKey(), JSON.stringify(R.secret)); } catch (e) { /* ignore */ } };
    const loadSecret = room => { try { return JSON.parse(localStorage.getItem(`cordialMafia:${room}:${me()}`) || 'null') || {}; } catch (e) { return {}; } };
    const hostKey = room => `cordialMafiaHost:${room}`;
    const person = id => (R && R.P && R.P.players.find(p => p.id === id)) || null;
    const nameOf = id => { const p = person(id); return p ? (p.id === me() ? 'You' : p.name) : 'Someone'; };
    const firstName = n => String(n || 'Someone').split(' ')[0];

    async function openRoom(room, host, { fresh = false } = {}) {
        if (!me()) return app.showToast('Sign in to play Cordial Mafia');
        if (!(window.crypto && crypto.subtle)) return app.showToast('This browser can’t keep roles secret — try an up-to-date one');
        if (R && R.id === room) { if (!R.dlg.open) R.dlg.showModal(); return; }
        closeRoom();
        const keys = await loadKeys(room);
        R = { id: room, host, isHost: host === me(), keys, P: null, secret: loadSecret(room), chat: [], present: new Set(), dlg: null, H: null, seen: new Set() };
        if (R.isHost) {
            let H = null;
            try { H = JSON.parse(localStorage.getItem(hostKey(room)) || 'null'); } catch (e) { H = null; }
            R.H = H && !fresh ? H : newHost(room);
            if (!R.H.players.some(p => p.id === me()) && !R.H.narrator && R.H.phase === 'lobby') R.H.players.push(selfEntry());
            publish();
        }
        buildDialog();
        joinChannel();
        if (R.isHost) R.timer = setInterval(hostTick, 400);
        R.ticker = setInterval(paintTimer, 500);
        if (!seenTutorial()) setTimeout(() => R && tutorial(), 700);
    }
    function closeRoom() {
        if (!R) return;
        clearInterval(R.timer); clearInterval(R.ticker);
        (R.botTimers || []).forEach(clearTimeout);
        if (R.ch) client.removeChannel(R.ch);
        const d = R.dlg;
        R = null;
        if (d && d.open) d.close();
        if (d) d.remove();
    }
    const selfEntry = () => ({ id: me(), name: s.profile.display_name || 'You', avatar_path: s.profile.avatar_path || null, pub: R.keys.pub });

    // ---------- Live channel ----------
    function joinChannel() {
        const ch = client.channel(`mafia-${R.id}`, { config: { broadcast: { self: false }, presence: { key: me() } } });
        R.ch = ch;
        const room = R.id;
        const on = (ev, fn) => ch.on('broadcast', { event: ev }, ({ payload }) => { if (R && R.id === room && payload) fn(payload); });
        on('state', p => { if (p.host === R.host && !R.isHost) takeState(p); });
        on('hello', p => { if (R.isHost) { publish(); resendSecrets(p.from); } });
        on('join', p => { if (R.isHost) hostJoin(p); });
        on('leave', p => { if (R.isHost) hostLeave(p.from); });
        on('secret', p => { if (p.to === me()) openSecret(p); });
        on('chat', p => chatIn(p));
        on('vote', p => { if (R.isHost) hostVote(p.from, p.target); });
        on('ready', p => { if (R.isHost) hostReady(p.from, p.on); });
        ch.on('presence', { event: 'sync' }, () => {
            if (!R || R.id !== room) return;
            R.present = new Set(Object.keys(ch.presenceState() || {}));
            paint();
        }).subscribe(status => {
            if (status !== 'SUBSCRIBED' || !R || R.id !== room) return;
            ch.track({ at: Date.now() }).catch(() => {});
            if (R.isHost) publish();
            else {
                send('join', { from: me(), name: s.profile.display_name || 'Player', avatar_path: s.profile.avatar_path || null, pub: R.keys.pub });
                send('hello', { from: me() });
            }
        });
    }
    function send(event, payload) { if (R && R.ch) R.ch.send({ type: 'broadcast', event, payload }).catch(() => {}); }

    // ======================================================================
    // The host's engine
    // ======================================================================
    function newHost(room) {
        return { room, host: me(), narrator: false, phase: 'lobby', round: 0, endsAt: 0, players: [], bots: 0, roles: {}, alive: {}, acts: { kill: {}, save: null, check: null }, votes: {}, ready: {}, checks: {}, announce: null, winner: null, log: [], settings: { day: 90, night: 35, vote: 35 }, group: null };
    }
    function saveHost() { try { localStorage.setItem(hostKey(R.id), JSON.stringify(R.H)); } catch (e) { /* ignore */ } }
    function publicState() {
        const H = R.H;
        const revealAll = H.phase === 'over';
        return {
            room: H.room, host: H.host, hostPub: R.keys.pub, narrator: H.narrator, phase: H.phase, round: H.round, endsAt: H.endsAt, settings: H.settings, group: H.group,
            players: H.players.map(p => ({
                id: p.id, name: p.name, avatar_path: p.avatar_path || null, pub: p.pub || null, bot: !!p.bot,
                alive: H.phase === 'lobby' ? true : !!H.alive[p.id],
                role: H.phase !== 'lobby' && (revealAll || !H.alive[p.id]) ? H.roles[p.id] : undefined
            })),
            votes: ['vote', 'reveal'].includes(H.phase) ? H.votes : {},
            ready: H.phase === 'day' ? Object.keys(H.ready).filter(id => H.ready[id]).length : 0,
            announce: H.announce, winner: H.winner, log: H.log.slice(-40)
        };
    }
    function publish() {
        if (!R || !R.isHost) return;
        saveHost();
        const P = publicState();
        takeState(P);
        send('state', P);
    }
    function say(text, emoji = '📣') {
        R.H.log.push({ id: uid(), sys: true, text, emoji, at: Date.now() });
        R.H.log = R.H.log.slice(-60);
    }
    function phase(name, secs) {
        const H = R.H;
        H.phase = name;
        H.endsAt = secs ? Date.now() + secs * 1000 : 0;
        if (name === 'night') { H.acts = { kill: {}, save: null, check: null }; }
        if (name === 'day') H.ready = {};
        if (name === 'vote') H.votes = {};
        publish();
        if (name === 'night' || name === 'vote' || name === 'day') botsAct(name);
    }
    function hostJoin(p) {
        const H = R.H;
        if (!p.from || !p.pub) return;
        const known = H.players.find(x => x.id === p.from);
        if (known) {
            known.pub = p.pub; known.name = p.name || known.name; known.avatar_path = p.avatar_path || null;
            publish();
            resendSecrets(p.from);
            return;
        }
        if (H.phase !== 'lobby') { publish(); return; } // watching, not playing
        if (H.players.length >= MAX) return;
        H.players.push({ id: p.from, name: String(p.name || 'Player').slice(0, 40), avatar_path: p.avatar_path || null, pub: p.pub });
        say(`${firstName(p.name)} joined the room`, '👋');
        publish();
    }
    function hostLeave(id) {
        const H = R.H;
        if (H.phase !== 'lobby') return;
        H.players = H.players.filter(p => p.id !== id);
        publish();
    }
    async function toPlayer(id, obj) {
        if (id === me()) return applySecret(obj);
        const p = R.H.players.find(x => x.id === id);
        if (!p || p.bot || !p.pub) return;
        const box = await seal(R.keys.priv, p.pub, obj);
        send('secret', { to: id, from: me(), box });
    }
    function resendSecrets(id) {
        const H = R.H;
        if (!id || H.phase === 'lobby' || !H.roles[id]) return;
        const role = H.roles[id];
        toPlayer(id, { t: 'role', role, mafia: role === 'mafia' ? Object.keys(H.roles).filter(x => H.roles[x] === 'mafia') : [] });
        (H.checks[id] || []).forEach(c => toPlayer(id, { t: 'check', ...c }));
        if (role === 'mafia' && H.phase === 'night') toPlayer(id, { t: 'team', picks: H.acts.kill });
    }
    function startGame() {
        const H = R.H;
        if (H.players.length < MIN) return app.showToast(`You need at least ${MIN} players — invite friends or add computer players`);
        const roles = deal(H.players.length);
        H.roles = Object.fromEntries(H.players.map((p, i) => [p.id, roles[i]]));
        H.alive = Object.fromEntries(H.players.map(p => [p.id, true]));
        H.checks = {}; H.winner = null; H.round = 1; H.log = [];
        const mafiaIds = H.players.filter(p => H.roles[p.id] === 'mafia').map(p => p.id);
        say(`The game begins with ${H.players.length} players: ${mafiaIds.length} Mafia, ${H.players.length >= 5 ? '1 Detective, ' : ''}1 Doctor and ${H.players.length - mafiaIds.length - 1 - (H.players.length >= 5 ? 1 : 0)} Citizens.`, '🎭');
        H.announce = { emoji: '🎭', title: 'Your secret role', text: 'Check your card — and don’t let anyone see it.' };
        H.players.forEach(p => toPlayer(p.id, { t: 'role', role: H.roles[p.id], mafia: H.roles[p.id] === 'mafia' ? mafiaIds : [] }));
        phase('roles', 9);
    }
    function hostTick() {
        if (!R || !R.isHost) return;
        const H = R.H;
        if (!H.endsAt || H.phase === 'lobby' || H.phase === 'over') return;
        const needNight = H.phase === 'night' && nightDone();
        const needVote = H.phase === 'vote' && aliveIds().every(id => H.votes[id] !== undefined);
        if (Date.now() < H.endsAt && !needNight && !needVote) return;
        if (needVote && Date.now() < H.endsAt) { if (!H.voteGrace) { H.voteGrace = Date.now() + 1500; return; } if (Date.now() < H.voteGrace) return; }
        H.voteGrace = 0;
        advance();
    }
    const aliveIds = () => Object.keys(R.H.alive).filter(id => R.H.alive[id]);
    const aliveWith = role => aliveIds().filter(id => R.H.roles[id] === role);
    function nightDone() {
        const H = R.H;
        const mafia = aliveWith('mafia');
        return mafia.every(id => H.acts.kill[id]) && (!aliveWith('doctor').length || H.acts.save) && (!aliveWith('detective').length || H.acts.check);
    }
    function advance() {
        const H = R.H;
        if (H.phase === 'roles') { H.announce = { emoji: '🌙', title: 'Night has fallen', text: 'Everyone close your eyes. The Mafia, the Detective and the Doctor are choosing…' }; say(`Night ${H.round} has fallen`, '🌙'); return phase('night', H.settings.night); }
        if (H.phase === 'night') return resolveNight();
        if (H.phase === 'dawn') return winCheck() || toDay();
        if (H.phase === 'day') return toVote();
        if (H.phase === 'vote') return resolveVote();
        if (H.phase === 'reveal') {
            if (winCheck()) return;
            H.round += 1;
            H.announce = { emoji: '🌙', title: 'Night has fallen', text: 'The town sleeps. Some of you are busy…' };
            say(`Night ${H.round} has fallen`, '🌙');
            return phase('night', H.settings.night);
        }
    }
    function resolveNight() {
        const H = R.H;
        const tally = {};
        aliveWith('mafia').forEach(id => { const t = H.acts.kill[id]; if (t && H.alive[t]) tally[t] = (tally[t] || 0) + 1; });
        const top = Math.max(0, ...Object.values(tally));
        const target = top ? pickOne(Object.keys(tally).filter(t => tally[t] === top)) : null;
        const saved = target && H.acts.save === target;
        if (target && !saved) {
            H.alive[target] = false;
            const p = H.players.find(x => x.id === target);
            H.announce = { emoji: '🩸', title: `${p.name} was eliminated last night`, text: `${firstName(p.name)} was ${article(H.roles[target])} ${roleLine(H.roles[target])}.`, who: target };
            say(`${p.name} was eliminated last night. They were ${article(H.roles[target])} ${roleLine(H.roles[target])}.`, '🩸');
        } else {
            H.announce = { emoji: '🌅', title: 'Nobody died last night', text: saved ? 'The Doctor got there just in time.' : 'The Mafia couldn’t agree on a target.' };
            say(saved ? 'Nobody died last night — the Doctor saved someone.' : 'Nobody died last night.', '🌅');
        }
        const det = aliveWith('detective')[0] || H.players.find(p => H.roles[p.id] === 'detective' && H.acts.check)?.id;
        if (det && H.acts.check) {
            const c = { target: H.acts.check, mafia: H.roles[H.acts.check] === 'mafia', round: H.round };
            (H.checks[det] = H.checks[det] || []).push(c);
            toPlayer(det, { t: 'check', ...c });
        }
        phase('dawn', 7);
    }
    function toDay() {
        const H = R.H;
        H.announce = { emoji: '☀️', title: `Day ${H.round} — discuss`, text: 'Who’s acting suspicious? Talk it through, then vote.' };
        say(`Day ${H.round}: discussion begins`, '☀️');
        phase('day', H.settings.day);
    }
    function toVote() {
        const H = R.H;
        H.announce = { emoji: '🗳️', title: 'Time to vote', text: 'Tap the player you think is Mafia — or skip.' };
        say('Voting is open', '🗳️');
        phase('vote', H.settings.vote);
    }
    function hostVote(from, target) {
        const H = R.H;
        if (H.phase !== 'vote' || !H.alive[from]) return;
        if (target !== 'skip' && !H.alive[target]) return;
        H.votes[from] = target;
        publish();
    }
    function hostReady(from, on) {
        const H = R.H;
        if (H.phase !== 'day' || !H.alive[from]) return;
        H.ready[from] = !!on;
        const n = aliveIds().length;
        publish();
        if (Object.values(H.ready).filter(Boolean).length > n / 2) toVote();
    }
    function resolveVote() {
        const H = R.H;
        const counts = {};
        Object.entries(H.votes).forEach(([by, t]) => { if (H.alive[by]) counts[t] = (counts[t] || 0) + 1; });
        const ranked = Object.entries(counts).sort((a, b) => b[1] - a[1]);
        const tie = ranked.length > 1 && ranked[0][1] === ranked[1][1];
        const out = ranked.length && !tie && ranked[0][0] !== 'skip' ? ranked[0][0] : null;
        const lines = ranked.filter(([t]) => t !== 'skip').map(([t, n]) => `${(H.players.find(p => p.id === t) || {}).name} — ${n}`).join(' · ');
        if (out) {
            H.alive[out] = false;
            const p = H.players.find(x => x.id === out);
            H.announce = { emoji: ROLES[H.roles[out]].team === 'mafia' ? '🎯' : '😬', title: `${p.name} was voted out`, text: `${firstName(p.name)} was ${article(H.roles[out])} ${roleLine(H.roles[out])}.`, who: out };
            say(`Votes: ${lines || 'none'}. ${p.name} is eliminated — they were ${article(H.roles[out])} ${roleLine(H.roles[out])}.`, '🗳️');
        } else {
            H.announce = { emoji: '🤷', title: ranked.length ? 'No one is eliminated' : 'Nobody voted', text: tie ? 'The vote was tied.' : ranked.length ? 'Most people chose to skip.' : 'The town couldn’t decide.' };
            say(`Votes: ${lines || 'none'}. No one is eliminated.`, '🗳️');
        }
        phase('reveal', 8);
    }
    function winCheck() {
        const H = R.H;
        const mafia = aliveIds().filter(id => H.roles[id] === 'mafia').length;
        const town = aliveIds().length - mafia;
        const winner = mafia === 0 ? 'town' : mafia >= town ? 'mafia' : null;
        if (!winner) return false;
        H.winner = winner;
        H.announce = winner === 'town'
            ? { emoji: '🏆', title: 'The Citizens win!', text: 'Every member of the Mafia has been found.' }
            : { emoji: '🔴', title: 'The Mafia win!', text: 'They now equal or outnumber the Citizens.' };
        say(H.announce.title, H.announce.emoji);
        phase('over', 0);
        return true;
    }

    // ---------- Computer players (practice) ----------
    const BOT_NAMES = ['Ada', 'Kofi', 'Mira', 'Tunde', 'Zoe', 'Leo', 'Nia', 'Sam', 'Ivy', 'Omar', 'Lena', 'Ben'];
    function addBot() {
        const H = R.H;
        if (H.phase !== 'lobby' || H.players.length >= MAX) return;
        const used = new Set(H.players.map(p => p.name));
        const name = `${BOT_NAMES.find(n => !used.has(`${n} (computer)`)) || 'Bot'} (computer)`;
        H.players.push({ id: `bot-${uid().slice(0, 8)}`, name, avatar_path: null, bot: true });
        publish();
    }
    const BOT_LINES = ['Hmm, {n} has been very quiet…', 'I’m just a Citizen, honestly.', 'I don’t trust {n}.', 'Let’s not rush this vote.', '{n}, where were you last night? 👀', 'Something feels off about {n}.', 'I think the Mafia is targeting the loud ones.', 'Can we hear from {n}?'];
    function botsAct(name) {
        const H = R.H;
        R.botTimers = R.botTimers || [];
        const bots = H.players.filter(p => p.bot && H.alive[p.id]);
        const later = (ms, fn) => R.botTimers.push(setTimeout(() => { if (R && R.H === H) fn(); }, ms));
        const others = id => aliveIds().filter(x => x !== id);
        bots.forEach(b => {
            const role = H.roles[b.id];
            if (name === 'night') {
                later(2500 + Math.random() * 7000, () => {
                    if (H.phase !== 'night') return;
                    if (role === 'mafia') {
                        const teamPick = Object.values(H.acts.kill).find(Boolean);
                        H.acts.kill[b.id] = teamPick || pickOne(others(b.id).filter(x => H.roles[x] !== 'mafia'));
                        aliveWith('mafia').forEach(m => toPlayer(m, { t: 'team', picks: H.acts.kill }));
                    } else if (role === 'doctor') H.acts.save = pickOne(aliveIds());
                    else if (role === 'detective') {
                        const done = new Set((H.checks[b.id] || []).map(c => c.target));
                        H.acts.check = pickOne(others(b.id).filter(x => !done.has(x))) || pickOne(others(b.id));
                    }
                    saveHost();
                });
            } else if (name === 'day') {
                const n = Math.random() < 0.7 ? 1 : 2;
                for (let k = 0; k < n; k++) later(3000 + Math.random() * (H.settings.day * 700), () => {
                    if (H.phase !== 'day' || !H.alive[b.id]) return;
                    const target = H.players.find(p => p.id === pickOne(others(b.id)));
                    const msg = { id: uid(), by: b.id, text: pickOne(BOT_LINES).replace('{n}', firstName(target && target.name)), at: Date.now() };
                    chatIn(msg); send('chat', msg);
                });
                later(H.settings.day * 600 + Math.random() * 5000, () => { if (H.phase === 'day') hostReady(b.id, true); });
            } else if (name === 'vote') {
                later(3000 + Math.random() * 9000, () => {
                    if (H.phase !== 'vote') return;
                    const known = (H.checks[b.id] || []).find(c => c.mafia && H.alive[c.target]);
                    const pool = others(b.id).filter(x => role !== 'mafia' || H.roles[x] !== 'mafia');
                    hostVote(b.id, known ? known.target : Math.random() < 0.12 ? 'skip' : pickOne(pool));
                });
            }
        });
    }

    // ======================================================================
    // Every player's side
    // ======================================================================
    function takeState(P) {
        const before = R.P;
        R.P = P;
        (P.log || []).forEach(l => { if (!R.seen.has(l.id)) { R.seen.add(l.id); R.chat.push(l); } });
        R.chat.sort((a, b) => a.at - b.at);
        if (R.chat.length > 200) R.chat = R.chat.slice(-200);
        if (!before || before.phase !== P.phase) { R.myPick = null; R.ready = false; if (P.phase === 'night' || P.phase === 'lobby') R.secret.picks = {}; }
        if (P.phase === 'lobby' && before && before.phase === 'over') { R.secret = {}; saveSecret(); }
        paint();
        if (before && before.phase !== P.phase && navigator.vibrate) { try { navigator.vibrate(30); } catch (e) { /* ignore */ } }
    }
    async function openSecret(p) {
        try {
            const pub = R.P && R.P.hostPub && p.from === R.host ? R.P.hostPub : (person(p.from) || {}).pub;
            if (!pub) return;
            const obj = await unseal(R.keys.priv, pub, p.box);
            if (obj.t === 'act' && R.isHost) return hostAct(p.from, obj);
            if (obj.t === 'whisper') return whisperIn(p.from, obj);
            if (p.from === R.host) applySecret(obj);
        } catch (e) { /* not for us, or tampered */ }
    }
    function applySecret(obj) {
        if (obj.t === 'role') { R.secret.role = obj.role; R.secret.mafia = obj.mafia || []; if (R.P && R.P.phase === 'roles') R.peek = true; }
        else if (obj.t === 'check') { R.secret.checks = [...(R.secret.checks || []).filter(c => !(c.target === obj.target && c.round === obj.round)), { target: obj.target, mafia: obj.mafia, round: obj.round }]; app.showToast(`🕵️ ${nameOf(obj.target)} is ${obj.mafia ? 'MAFIA!' : 'not Mafia'}`); }
        else if (obj.t === 'team') R.secret.picks = obj.picks || {};
        saveSecret();
        paint();
    }
    function hostAct(from, obj) {
        const H = R.H;
        if (H.phase !== 'night' || !H.alive[from] || !H.alive[obj.target]) return;
        const role = H.roles[from];
        if (obj.kind === 'kill' && role === 'mafia' && H.roles[obj.target] !== 'mafia') {
            H.acts.kill[from] = obj.target;
            aliveWith('mafia').forEach(m => toPlayer(m, { t: 'team', picks: H.acts.kill }));
        } else if (obj.kind === 'save' && role === 'doctor') H.acts.save = obj.target;
        else if (obj.kind === 'check' && role === 'detective' && obj.target !== from) H.acts.check = obj.target;
        saveHost();
    }
    async function act(target) {
        const role = R.secret.role;
        const kind = role === 'mafia' ? 'kill' : role === 'doctor' ? 'save' : role === 'detective' ? 'check' : null;
        if (!kind) return;
        R.myPick = target;
        if (R.isHost) hostAct(me(), { kind, target });
        else {
            const box = await seal(R.keys.priv, R.P.hostPub, { t: 'act', kind, target });
            send('secret', { to: R.host, from: me(), box });
        }
        paint();
    }
    function vote(target) {
        R.myPick = target;
        if (R.isHost) hostVote(me(), target); else send('vote', { from: me(), target });
        paint();
    }
    function chatIn(m) {
        if (!R || !m || !m.id || R.seen.has(m.id) || typeof m.text !== 'string') return;
        const p = person(m.by);
        if (!p) return;
        const P = R.P;
        if (P.phase !== 'lobby' && P.phase !== 'over' && !p.alive) return; // the dead don't talk
        if (P.phase === 'night' || P.phase === 'roles') return; // night is silent
        R.seen.add(m.id);
        R.chat.push({ id: m.id, by: m.by, text: m.text.slice(0, 300), at: Number(m.at) || Date.now() });
        paintChat();
    }
    function chatSend(text) {
        text = String(text || '').trim().slice(0, 300);
        if (!text || !R || !R.P) return;
        const P = R.P;
        const mine = person(me());
        if (P.phase === 'night') return whisperSend(text);
        if (P.phase !== 'lobby' && P.phase !== 'over' && (!mine || !mine.alive)) return app.showToast('You’re out — you can watch, but not talk');
        const msg = { id: uid(), by: me(), text, at: Date.now() };
        chatIn(msg);
        send('chat', msg);
    }
    // The Mafia whisper to each other at night (sealed for each teammate)
    async function whisperSend(text) {
        if (R.secret.role !== 'mafia') return app.showToast('Night is silent — only the Mafia can whisper');
        const msg = { t: 'whisper', id: uid(), text, at: Date.now() };
        whisperIn(me(), msg);
        for (const id of R.secret.mafia || []) {
            if (id === me()) continue;
            const p = person(id);
            if (!p || !p.pub || p.bot) continue;
            send('secret', { to: id, from: me(), box: await seal(R.keys.priv, p.pub, msg) });
        }
    }
    function whisperIn(from, m) {
        if (!R || R.seen.has(m.id) || R.secret.role !== 'mafia' || !(R.secret.mafia || []).includes(from)) return;
        R.seen.add(m.id);
        R.chat.push({ id: m.id, by: from, text: String(m.text).slice(0, 300), at: Number(m.at) || Date.now(), whisper: true });
        paintChat();
    }

    // ======================================================================
    // The room window
    // ======================================================================
    function buildDialog() {
        const dlg = document.createElement('dialog');
        dlg.className = 'gm mf';
        dlg.setAttribute('aria-label', 'Cordial Mafia');
        dlg.innerHTML = `
            <div class="gm-card mf-card">
                <header class="gm-head mf-head">
                    <button type="button" class="icon-btn" data-mf="close" aria-label="Leave the room">${ic('i-close')}</button>
                    <div class="gm-title"><strong>🎭 Cordial Mafia</strong><small class="mf-sub"></small></div>
                    <span class="mf-timer" aria-live="off"></span>
                    <button type="button" class="icon-btn" data-mf="menu" aria-label="Room options" aria-haspopup="menu">${ic('i-more')}</button>
                </header>
                <div class="mf-body"></div>
                <section class="mf-chat" aria-label="Room chat"><ol class="mf-log" aria-live="polite"></ol></section>
                <form class="mf-form">
                    <div class="mf-emo">${['😂', '👀', '🤔', '😱', '🙏', '🔥'].map(x => `<button type="button" data-mf-emoji="${x}" aria-label="Send ${x}">${x}</button>`).join('')}</div>
                    <div class="mf-row"><input type="text" maxlength="300" placeholder="Say something…" aria-label="Message" enterkeyhint="send" autocomplete="off"><button type="submit" class="mf-send" aria-label="Send">${ic('i-send')}</button></div>
                </form>
            </div>`;
        document.body.append(dlg);
        R.dlg = dlg;
        dlg.addEventListener('click', onClick);
        dlg.addEventListener('submit', e => {
            e.preventDefault();
            const input = dlg.querySelector('.mf-form input');
            chatSend(input.value);
            input.value = '';
        });
        dlg.addEventListener('cancel', e => { e.preventDefault(); leave(); });
        dlg.showModal();
        paint();
    }
    function timeLeft() { return R && R.P && R.P.endsAt ? Math.max(0, Math.ceil((R.P.endsAt - Date.now()) / 1000)) : null; }
    function paintTimer() {
        if (!R || !R.dlg) return;
        const t = timeLeft();
        const el = R.dlg.querySelector('.mf-timer');
        if (!el) return;
        el.hidden = t === null || !R.P || ['lobby', 'over'].includes(R.P.phase);
        el.textContent = t === null ? '' : `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
        el.classList.toggle('low', t !== null && t <= 10);
    }
    const PHASE_NAME = { lobby: 'Waiting room', roles: 'Roles dealt', night: 'Night', dawn: 'Morning', day: 'Day — discuss', vote: 'Voting', reveal: 'The reveal', over: 'Game over' };
    function avatarOf(p, size = 'md') {
        if (p.bot) return `<span class="avatar ${size} mf-bot" aria-hidden="true">${ic('i-sparkle')}</span>`;
        return I.avatar({ id: p.id, display_name: p.name, avatar_path: p.avatar_path }, size);
    }
    function paint() {
        if (!R || !R.dlg) return;
        const P = R.P;
        const dlg = R.dlg;
        dlg.dataset.phase = P ? P.phase : 'lobby';
        const sub = dlg.querySelector('.mf-sub');
        const body = dlg.querySelector('.mf-body');
        if (!P) {
            sub.textContent = 'Connecting…';
            body.innerHTML = '<div class="mf-wait"><span class="mf-spin" aria-hidden="true"></span><p>Joining the room…</p><small>If this takes a while, the host may have closed it.</small></div>';
            return;
        }
        const alive = P.players.filter(p => p.alive).length;
        sub.textContent = `${PHASE_NAME[P.phase]}${P.round && P.phase !== 'lobby' ? ` · round ${P.round}` : ''}${P.phase !== 'lobby' ? ` · ${alive} alive` : ` · ${P.players.length} joined`}`;
        body.innerHTML = P.phase === 'lobby' ? lobbyHTML() : gameHTML();
        I.hydrateStorage && I.hydrateStorage(body);
        paintTimer();
        paintChat();
        const mine = person(me());
        const input = dlg.querySelector('.mf-form input');
        const night = P.phase === 'night' || P.phase === 'roles';
        const canTalk = P.phase === 'lobby' || P.phase === 'over' || (mine && mine.alive && (!night || R.secret.role === 'mafia'));
        input.disabled = !canTalk;
        input.placeholder = !canTalk ? (mine && !mine.alive ? 'You’re out — watching quietly' : night ? 'Night is silent…' : 'Watching') : night ? 'Whisper to the Mafia…' : 'Say something…';
        dlg.querySelector('.mf-form').classList.toggle('whisper', night && canTalk);
        const hostHere = R.isHost || R.present.has(R.host);
        dlg.classList.toggle('no-host', !hostHere && P.phase !== 'over');
    }
    function lobbyHTML() {
        const P = R.P;
        const n = P.players.length;
        return `
            <div class="mf-lobby">
                <div class="mf-hero"><span class="mf-hero-art" aria-hidden="true">🎭</span><strong>Find the Mafia before they find you</strong><span>${n < MIN ? `Waiting for players — at least ${MIN} to start (${MIN - n} more)` : `${n} players ready${R.isHost ? ' — start when everyone’s in' : ' — waiting for the host to start'}`}</span></div>
                <ul class="mf-lobby-list">${P.players.map(p => `<li>${avatarOf(p, 'sm')}<span><strong>${esc(p.id === me() ? `${p.name} (you)` : p.name)}</strong>${p.id === P.host ? '<small>Host</small>' : p.bot ? '<small>Computer player</small>' : ''}</span>${p.id === me() || R.present.has(p.id) || p.bot ? '<i class="mf-on" title="Here"></i>' : ''}${R.isHost && p.id !== me() ? `<button type="button" class="icon-btn" data-mf="kick" data-id="${esc(p.id)}" aria-label="Remove ${esc(p.name)}">${ic('i-close')}</button>` : ''}</li>`).join('')}</ul>
                ${R.isHost ? `
                    <div class="mf-invite">
                        <button type="button" class="mf-btn" data-mf="invite-friends">${ic('i-user-plus')}Invite friends</button>
                        <button type="button" class="mf-btn" data-mf="invite-group">${ic('i-users')}Invite a group</button>
                        <button type="button" class="mf-btn" data-mf="add-bot">${ic('i-sparkle')}Add a computer player</button>
                    </div>
                    <label class="mf-set"><span>Discussion time</span><select data-mf-set="day">${[60, 90, 120, 180].map(v => `<option value="${v}"${P.settings.day === v ? ' selected' : ''}>${v / 60 >= 1 && v % 60 === 0 ? `${v / 60} min` : `${v}s`}</option>`).join('')}</select></label>
                    <label class="mf-set"><span>I’ll just narrate (don’t deal me a role)</span><input type="checkbox" data-mf-set="narrator"${P.narrator ? ' checked' : ''}></label>
                    <button type="button" class="primary-btn mf-start" data-mf="start"${n < MIN ? ' disabled' : ''}>Start the game</button>` : ''}
                <button type="button" class="mf-link" data-mf="tutorial">${ic('i-play')}How to play</button>
            </div>`;
    }
    function gameHTML() {
        const P = R.P;
        const role = R.secret.role;
        const mine = person(me());
        const meAlive = mine && mine.alive;
        const night = P.phase === 'night';
        const canAct = night && meAlive && ['mafia', 'doctor', 'detective'].includes(role);
        const voting = P.phase === 'vote' && meAlive;
        const counts = {};
        Object.values(P.votes || {}).forEach(t => { counts[t] = (counts[t] || 0) + 1; });
        const picks = R.secret.picks || {};
        const checks = Object.fromEntries((R.secret.checks || []).map(c => [c.target, c.mafia]));
        const prompt = canAct ? { mafia: 'Choose someone to eliminate', doctor: 'Choose someone to protect', detective: 'Choose someone to investigate' }[role] : voting ? (R.myPick ? `You voted for ${R.myPick === 'skip' ? 'nobody' : nameOf(R.myPick)} — tap to change` : 'Tap who you think is Mafia') : '';
        const a = P.announce || {};
        return `
            <div class="mf-banner"><span class="mf-banner-art" aria-hidden="true">${esc(a.emoji || '🎭')}</span><strong>${esc(a.title || PHASE_NAME[P.phase])}</strong><span>${esc(a.text || '')}</span></div>
            ${role ? `<button type="button" class="mf-role${R.peek ? ' open' : ''} r-${role}" data-mf="peek" aria-expanded="${!!R.peek}">
                ${R.peek ? `<span class="mf-role-art" aria-hidden="true">${ROLES[role].emoji}</span><span><small>Your role</small><strong>${ROLES[role].name}</strong><em>${ROLES[role].blurb}</em>${role === 'mafia' && (R.secret.mafia || []).length > 1 ? `<em class="mf-team">Your team: ${(R.secret.mafia || []).map(nameOf).join(', ')}</em>` : ''}</span>` : `<span class="mf-role-art" aria-hidden="true">🤫</span><span><small>Your secret role</small><strong>Tap to peek</strong></span>`}
            </button>` : P.narrator && R.isHost ? '<p class="mf-note">You’re narrating — no role for you this game.</p>' : '<p class="mf-note">You’re watching this game.</p>'}
            ${prompt ? `<p class="mf-prompt">${esc(prompt)}</p>` : ''}
            <ul class="mf-grid">${P.players.map(p => {
                const tappable = p.alive && ((canAct && !(role === 'mafia' && (R.secret.mafia || []).includes(p.id)) && !(role === 'detective' && p.id === me())) || (voting && p.id !== me()));
                const chosen = R.myPick === p.id;
                const teamPicks = role === 'mafia' && night ? Object.values(picks).filter(t => t === p.id).length : 0;
                const known = p.id in checks ? checks[p.id] : null;
                const mate = role === 'mafia' && (R.secret.mafia || []).includes(p.id) && p.id !== me();
                return `<li><button type="button" class="mf-p${p.alive ? '' : ' out'}${chosen ? ' chosen' : ''}${tappable ? ' can' : ''}${p.id === me() ? ' me' : ''}" ${tappable ? `data-mf="pick" data-id="${esc(p.id)}"` : 'tabindex="-1" aria-disabled="true"'} aria-label="${esc(p.name)}${p.alive ? '' : ', out'}${p.role ? `, ${ROLES[p.role].name}` : ''}${counts[p.id] ? `, ${counts[p.id]} votes` : ''}">
                    <span class="mf-p-av">${avatarOf(p)}${!p.alive ? '<i class="mf-x" aria-hidden="true">✕</i>' : ''}${counts[p.id] ? `<i class="mf-votes">${counts[p.id]}</i>` : ''}${teamPicks ? `<i class="mf-votes red">🎯${teamPicks > 1 ? teamPicks : ''}</i>` : ''}</span>
                    <strong>${esc(p.id === me() ? 'You' : firstName(p.name))}</strong>
                    <small>${p.role ? `${ROLES[p.role].emoji} ${ROLES[p.role].name}` : mate ? '🔴 Mafia (team)' : known === true ? '🕵️ Mafia!' : known === false ? '🕵️ Not Mafia' : p.alive ? (p.id === me() || R.present.has(p.id) || p.bot ? 'Here' : 'Away') : 'Out'}</small>
                </button></li>`;
            }).join('')}</ul>
            ${voting ? `<div class="mf-acts"><button type="button" class="mf-btn${R.myPick === 'skip' ? ' on' : ''}" data-mf="skip">Skip vote</button><span class="mf-count">${Object.keys(P.votes || {}).length} of ${P.players.filter(p => p.alive).length} voted</span></div>` : ''}
            ${P.phase === 'day' ? `<div class="mf-acts">${meAlive ? `<button type="button" class="mf-btn${R.ready ? ' on' : ''}" data-mf="ready">${R.ready ? '✓ Ready to vote' : 'Ready to vote'}</button>` : ''}<span class="mf-count">${P.ready} ready · vote starts when most are</span>${R.isHost ? '<button type="button" class="mf-btn" data-mf="vote-now">Vote now</button>' : ''}</div>` : ''}
            ${P.phase === 'over' ? `<div class="mf-acts">${R.isHost ? '<button type="button" class="primary-btn" data-mf="again">Play again</button>' : '<span class="mf-count">The host can start another round</span>'}</div>` : ''}`;
    }
    function paintChat() {
        if (!R || !R.dlg) return;
        const log = R.dlg.querySelector('.mf-log');
        const near = log.scrollHeight - log.scrollTop - log.clientHeight < 80;
        log.innerHTML = R.chat.slice(-120).map(m => m.sys
            ? `<li class="mf-sys"><span aria-hidden="true">${esc(m.emoji || '📣')}</span>${esc(m.text)}</li>`
            : `<li class="mf-msg${m.by === me() ? ' mine' : ''}${m.whisper ? ' whisper' : ''}"><b>${esc(m.by === me() ? 'You' : firstName(nameOf(m.by)))}${m.whisper ? ' · whisper' : ''}</b><span>${esc(m.text)}</span></li>`).join('')
            || '<li class="mf-sys">Say hi while everyone joins 👋</li>';
        if (near) log.scrollTop = log.scrollHeight;
    }

    async function onClick(e) {
        if (!R) return;
        const emo = e.target.closest('[data-mf-emoji]');
        if (emo) return chatSend(emo.dataset.mfEmoji);
        const b = e.target.closest('[data-mf]');
        if (!b) return;
        const a = b.dataset.mf;
        if (a === 'close') return leave();
        if (a === 'peek') { R.peek = !R.peek; return paint(); }
        if (a === 'pick') { const id = b.dataset.id; return R.P.phase === 'vote' ? vote(id) : act(id); }
        if (a === 'skip') return vote('skip');
        if (a === 'ready') { R.ready = !R.ready; if (R.isHost) hostReady(me(), R.ready); else send('ready', { from: me(), on: R.ready }); return paint(); }
        if (a === 'tutorial') return tutorial();
        if (a === 'menu') {
            return app.openPopover(b, [
                { label: 'How to play', icon: 'i-play', onClick: () => tutorial() },
                ...(R.isHost && R.P && R.P.phase === 'lobby' ? [{ label: 'Invite friends', icon: 'i-user-plus', onClick: () => inviteFriends() }, { label: 'Invite a group', icon: 'i-users', onClick: () => inviteGroup() }] : []),
                ...(R.isHost && R.P && !['lobby', 'over'].includes(R.P.phase) ? [{ label: 'End the game for everyone', icon: 'i-close', danger: true, onClick: () => { R.H.announce = { emoji: '🛑', title: 'The host ended the game', text: '' }; say('The host ended the game', '🛑'); R.H.phase = 'over'; publish(); } }] : []),
                { label: 'Leave the room', icon: 'i-logout', onClick: () => leave() }
            ]);
        }
        if (!R.isHost) return;
        if (a === 'start') return startGame();
        if (a === 'add-bot') return addBot();
        if (a === 'kick') { R.H.players = R.H.players.filter(p => p.id !== b.dataset.id); return publish(); }
        if (a === 'invite-friends') return inviteFriends();
        if (a === 'invite-group') return inviteGroup();
        if (a === 'vote-now' && R.H.phase === 'day') return toVote();
        if (a === 'again') {
            const keep = R.H.players.filter(p => p.bot || R.present.has(p.id) || p.id === me());
            Object.assign(R.H, newHost(R.id), { players: keep, settings: R.H.settings, narrator: R.H.narrator, group: R.H.group });
            say('New game — same room. The host can start when ready.', '🔁');
            return publish();
        }
    }
    {
        document.addEventListener('change', e => {
            const el = e.target.closest('[data-mf-set]');
            if (!el || !R || !R.isHost || R.H.phase !== 'lobby') return;
            if (el.dataset.mfSet === 'day') R.H.settings.day = Number(el.value) || 90;
            if (el.dataset.mfSet === 'narrator') {
                R.H.narrator = el.checked;
                R.H.players = el.checked ? R.H.players.filter(p => p.id !== me()) : (R.H.players.some(p => p.id === me()) ? R.H.players : [selfEntry(), ...R.H.players]);
            }
            publish();
        });
    }
    async function leave() {
        if (!R) return;
        const playing = R.P && !['lobby', 'over'].includes(R.P.phase);
        if (playing && !(await app.ask({ title: 'Leave the game?', text: R.isHost ? 'You’re the host — the game pauses for everyone until you come back to this room.' : 'You can come back from the invite while the game is on.', ok: 'Leave' }))) return;
        if (R.P && R.P.phase === 'lobby') { if (R.isHost) { /* the room stays; players see the host is away */ } else send('leave', { from: me() }); }
        closeRoom();
    }

    // ---------- Invites ----------
    const card = () => ({ kind: 'game', game: 'mafia', note: 'invite', room: R.id, host: R.host, hostName: s.profile.display_name || 'A friend', name: '🎭 Cordial Mafia — join the room' });
    async function inviteFriends(preset = null) {
        const ids = preset ? [preset] : await pickFriends();
        if (!ids || !ids.length) return;
        const res = await Promise.all(ids.map(id => client.from('diary_messages').insert({ recipient: id, body: '', attachments: [card()] }).then(r => !r.error)));
        app.showToast(res.every(Boolean) ? (ids.length === 1 ? 'Invite sent' : `${ids.length} invites sent`) : 'Some invites didn’t send — check your connection');
    }
    function pickFriends() {
        return new Promise(resolve => {
            const friends = (s.friends || []).slice().sort((a, b) => String(a.display_name).localeCompare(String(b.display_name)));
            if (!friends.length) { app.showToast('Add friends first — or invite a group'); return resolve(null); }
            const dlg = document.createElement('dialog');
            dlg.className = 'gm wpm-pick';
            dlg.setAttribute('aria-label', 'Invite friends');
            dlg.innerHTML = `
                <form class="gm-card" method="dialog">
                    <header class="gm-head"><button type="button" class="icon-btn" data-x aria-label="Close">${ic('i-close')}</button>
                        <div class="gm-title"><strong>🎭 Invite friends</strong><small>They get a card in your chat to join</small></div></header>
                    <div class="gm-body wpm-pick-body">
                        ${friends.length > 8 ? '<input type="search" class="wpm-find" placeholder="Search friends" aria-label="Search friends">' : ''}
                        <div class="wpm-friends">${friends.map(f => `<label class="wpm-friend" data-name="${esc(String(f.display_name || '').toLowerCase())} ${esc(String(f.username || '').toLowerCase())}"><input type="checkbox" value="${esc(f.id)}">${I.avatar(f, 'sm')}<span><strong>${esc(f.display_name || 'Friend')}</strong><small>@${esc(f.username || '')}</small></span><span class="wpm-check" aria-hidden="true">${ic('i-check')}</span></label>`).join('')}</div>
                    </div>
                    <footer class="wpm-pick-foot"><button type="submit" class="primary-btn" disabled>Send invites</button></footer>
                </form>`;
            document.body.append(dlg);
            I.hydrateStorage && I.hydrateStorage(dlg);
            const btn = dlg.querySelector('[type="submit"]');
            const picked = () => [...dlg.querySelectorAll('input[type="checkbox"]:checked')].map(i => i.value);
            let done = false;
            dlg.addEventListener('change', () => { const n = picked().length; btn.disabled = !n; btn.textContent = n ? `Invite ${n}` : 'Send invites'; });
            dlg.addEventListener('input', e => { if (!e.target.classList.contains('wpm-find')) return; const q = e.target.value.trim().toLowerCase(); dlg.querySelectorAll('.wpm-friend').forEach(l => { l.hidden = !!q && !l.dataset.name.includes(q); }); });
            dlg.addEventListener('click', e => { if (e.target.closest('[data-x]')) dlg.close(); });
            dlg.addEventListener('submit', e => { e.preventDefault(); done = true; const ids = picked(); dlg.close(); resolve(ids); });
            dlg.addEventListener('close', () => { dlg.remove(); if (!done) resolve(null); });
            dlg.showModal();
        });
    }
    async function inviteGroup(presetId = null) {
        let groups = [];
        try { groups = window.diaryCommunities && window.diaryCommunities.myGroups ? (await window.diaryCommunities.myGroups()) || [] : []; } catch (e) { groups = []; }
        if (!groups.length) return app.showToast('Join or create a group first');
        const post = async g => {
            const { error } = await client.from('diary_community_messages').insert({ community_id: g.id, body: '', attachments: [card()] });
            if (error) return app.showToast('Couldn’t post the invite in that group');
            if (R && R.isHost) { R.H.group = { id: g.id, name: g.name }; publish(); }
            app.showToast(`Invite posted in ${g.name}`);
        };
        if (presetId) { const g = groups.find(x => x.id === presetId); return g ? post(g) : null; }
        const anchor = R && R.dlg ? R.dlg.querySelector('[data-mf="invite-group"]') || R.dlg.querySelector('[data-mf="menu"]') : null;
        app.openPopover(anchor, [{ heading: 'Post the invite in…' }, ...groups.slice(0, 12).map(g => ({ label: `${g.emoji || '👥'} ${g.name}`, onClick: () => post(g) }))]);
    }
    function cardHTML(a) {
        const host = a.host === me();
        return `
            <div class="bgc bgc-mafia">
                <span class="bgc-art" aria-hidden="true">🎭</span>
                <span class="bgc-text"><small>${host ? 'You opened a room' : `${esc(firstName(a.hostName))} opened a room`}</small><strong>Cordial Mafia</strong><span>Secret roles · talk · vote</span></span>
                <button type="button" class="bgc-play" data-action="mafia-join" data-room="${esc(a.room)}" data-host="${esc(a.host)}">${host ? 'Open' : 'Join'}</button>
            </div>`;
    }
    app.actions['mafia-join'] = el => openRoom(el.dataset.room, el.dataset.host);
    function newRoom({ friend = null, group = null } = {}) {
        if (!me()) return app.showToast('Sign in to play Cordial Mafia');
        const room = uid();
        openRoom(room, me(), { fresh: true }).then(() => {
            if (friend) inviteFriends(friend);
            if (group) inviteGroup(group);
        });
    }

    // ======================================================================
    // How to play: a short narrated video
    // ======================================================================
    const TUT_KEY = 'cordialMafiaTutorial';
    const seenTutorial = () => { try { return localStorage.getItem(TUT_KEY) === '1'; } catch (e) { return true; } };
    const P8 = [['Daniel', '🔵'], ['Sarah', '🔵'], ['Joel', '🔴'], ['David', '🔵'], ['Ama', '🕵️'], ['Tobi', '❤️'], ['Kemi', '🔴'], ['You', '🔵']];
    const tile = ([n, r], i, extra = '') => `<span class="tt-p" style="--i:${i}"><span class="tt-av">${n[0]}</span><b>${n}</b>${extra}</span>`;
    const TUT = [
        { title: 'Everyone gets a secret role', say: 'When the game starts, everyone is secretly given a role. In a game of eight, there are two Mafia, four Citizens, one Detective and one Doctor. Only you can see your own card.', dur: 9000,
            html: () => `<div class="tt-grid">${P8.map((p, i) => tile(p, i, `<i class="tt-card" style="--d:${0.6 + i * 0.25}s">${i === 7 ? '🔵' : '🂠'}</i>`)).join('')}</div>
                <div class="tt-legend"><span>🔴 2 Mafia</span><span>🔵 4 Citizens</span><span>🕵️ 1 Detective</span><span>❤️ 1 Doctor</span></div>` },
        { title: 'Night falls', say: 'At night, the Mafia secretly choose someone to eliminate. The Detective investigates one player, and the Doctor protects one player. All of this happens privately.', dur: 9500, night: true,
            html: () => `<div class="tt-moon" aria-hidden="true">🌙</div><div class="tt-grid">${P8.map((p, i) => tile(p, i, i === 0 ? '<i class="tt-mark kill" style="--d:1.4s">🎯</i>' : i === 1 ? '<i class="tt-mark det" style="--d:3.2s">🔍</i>' : i === 3 ? '<i class="tt-mark doc" style="--d:5s">🛡️</i>' : '')).join('')}</div>
                <div class="tt-legend"><span style="--d:1.4s">🔴 Mafia: eliminate</span><span style="--d:3.2s">🕵️ Detective: investigate</span><span style="--d:5s">❤️ Doctor: protect</span></div>` },
        { title: 'Morning news', say: 'When the sun rises, Cordial announces what happened. Daniel was eliminated last night. He was a Citizen.', dur: 8000,
            html: () => `<div class="tt-sun" aria-hidden="true">☀️</div><div class="tt-news" style="--d:0.8s">🩸 <b>Daniel was eliminated last night</b><span>He was a 🔵 CITIZEN</span></div>
                <div class="tt-grid">${P8.map((p, i) => tile(p, i, i === 0 ? '<i class="tt-out" style="--d:2s">✕</i>' : '')).join('')}</div>` },
        { title: 'Discuss', say: 'Now everyone talks it through in the chat. Ask questions, defend yourself, and look for slips. The conversation is the game.', dur: 10000,
            html: () => `<div class="tt-chat">
                <p class="tt-b" style="--d:0.6s"><b>Tobi</b>I think Sarah is suspicious — she defended Joel yesterday.</p>
                <p class="tt-b me" style="--d:2.8s"><b>Sarah</b>No! Daniel was targeted because he was accusing ME.</p>
                <p class="tt-b" style="--d:5s"><b>Joel</b>Hmm, that’s exactly what the Mafia would say 👀</p>
                <p class="tt-b" style="--d:7s"><b>Ama</b>Let’s hear from David before we vote.</p></div>
                <div class="tt-timer"><span>🎙️ Discussion</span><b>0:60</b></div>` },
        { title: 'Vote', say: 'Then everyone votes for who they think is Mafia. The player with the most votes is eliminated. A tie means nobody goes.', dur: 8500,
            html: () => `<div class="tt-votes">
                <div class="tt-v"><b>Sarah</b><i style="--w:100%;--d:0.6s"></i><span>4</span></div>
                <div class="tt-v"><b>Joel</b><i style="--w:50%;--d:1.2s"></i><span>2</span></div>
                <div class="tt-v"><b>David</b><i style="--w:25%;--d:1.8s"></i><span>1</span></div></div>
                <p class="tt-cap" style="--d:3.4s">🗳️ Sarah is eliminated</p>` },
        { title: 'The reveal', say: 'Cordial reveals the eliminated player’s role. Sarah was a Citizen. Oops! The Mafia are still out there.', dur: 8000,
            html: () => `<div class="tt-reveal"><span class="tt-av big">S</span><b class="tt-stamp" style="--d:1s">🔵 CITIZEN</b><p style="--d:2.6s">😬 Wrong call… the Mafia are still out there.</p></div>
                <div class="tt-loop" style="--d:4.2s">DISCUSS → VOTE → REVEAL → NIGHT → …</div>` },
        { title: 'How to win', say: 'The Mafia win when they equal or outnumber the Citizens. The Citizens win when every member of the Mafia has been voted out.', dur: 9000,
            html: () => `<div class="tt-win"><div class="tt-w red" style="--d:0.5s"><span>🔴</span><b>Mafia win</b><p>when they equal or outnumber the Citizens</p></div>
                <div class="tt-w blue" style="--d:2.4s"><span>🔵</span><b>Citizens win</b><p>when every Mafia member is voted out</p></div></div>` },
        { title: 'Start a game', say: 'To play, open Cordial Mafia, invite friends or a whole group, and start when four to sixteen players have joined. You can also practise with computer players. Good luck!', dur: 9500,
            html: () => `<ol class="tt-steps"><li style="--d:0.4s"><span>1</span>Open <b>Cordial Mafia</b> from Playnote or a chat</li>
                <li style="--d:2s"><span>2</span><b>Invite friends</b> or post it in a <b>group</b></li>
                <li style="--d:3.6s"><span>3</span>Start with <b>4–16 players</b> — or practise with computer players</li>
                <li style="--d:5.2s"><span>4</span>Keep your role secret… and trust no one 🎭</li></ol>` }
    ];
    let T = null;
    function tutorial() {
        try { localStorage.setItem(TUT_KEY, '1'); } catch (e) { /* private mode */ }
        if (T && T.dlg.open) return;
        const dlg = document.createElement('dialog');
        dlg.className = 'gm tt';
        dlg.setAttribute('aria-label', 'How to play Cordial Mafia');
        let sound = false;
        try { sound = localStorage.getItem('cordialMafiaVoice') === '1'; } catch (e) { /* ignore */ }
        dlg.innerHTML = `
            <div class="gm-card tt-card">
                <header class="gm-head">
                    <button type="button" class="icon-btn" data-tt="close" aria-label="Close">${ic('i-close')}</button>
                    <div class="gm-title"><strong>🎭 How to play</strong><small>Cordial Mafia in two minutes</small></div>
                    ${'speechSynthesis' in window ? `<button type="button" class="icon-btn" data-tt="sound" aria-pressed="${sound}" aria-label="Narration">${ic(sound ? 'i-volume' : 'i-volume-off')}</button>` : ''}
                </header>
                <div class="ht-bar" role="tablist" aria-label="Scenes">${TUT.map((sc, i) => `<button type="button" class="ht-seg" data-tt-seg="${i}" role="tab" aria-label="${esc(sc.title)}"><i></i></button>`).join('')}</div>
                <div class="tt-stage"></div>
                <div class="ht-cap"><div class="ht-cap-text" aria-live="polite"><small class="ht-n"></small><strong class="ht-title"></strong><p class="ht-say"></p></div></div>
                <div class="ht-ctl">
                    <button type="button" class="icon-btn" data-tt="prev" aria-label="Previous scene">${ic('i-back')}</button>
                    <button type="button" class="ht-play" data-tt="toggle" aria-label="Pause">${ic('i-pause')}</button>
                    <button type="button" class="icon-btn" data-tt="next" aria-label="Next scene">${ic('i-forward')}</button>
                </div>
            </div>`;
        document.body.append(dlg);
        T = { dlg, i: 0, t: 0, playing: true, raf: 0, sound };
        dlg.addEventListener('close', () => { cancelAnimationFrame(T && T.raf); try { speechSynthesis.cancel(); } catch (e) { /* ignore */ } dlg.remove(); T = null; });
        dlg.addEventListener('click', e => {
            const seg = e.target.closest('[data-tt-seg]');
            if (seg) return ttScene(Number(seg.dataset.ttSeg));
            const b = e.target.closest('[data-tt]');
            if (!b) return;
            const a = b.dataset.tt;
            if (a === 'close') dlg.close();
            else if (a === 'toggle') { if (T.ended) ttScene(0); else ttPlay(!T.playing); }
            else if (a === 'prev') ttScene(Math.max(0, T.t > 1500 ? T.i : T.i - 1));
            else if (a === 'next' && T.i < TUT.length - 1) ttScene(T.i + 1);
            else if (a === 'replay') ttScene(0);
            else if (a === 'play-now') { dlg.close(); if (!R) newRoom(); }
            else if (a === 'sound') {
                T.sound = !T.sound;
                try { localStorage.setItem('cordialMafiaVoice', T.sound ? '1' : '0'); } catch (e2) { /* ignore */ }
                b.setAttribute('aria-pressed', String(T.sound));
                b.innerHTML = ic(T.sound ? 'i-volume' : 'i-volume-off');
                if (T.sound && T.playing) ttSay(TUT[T.i].say); else speechSynthesis.cancel();
            }
        });
        dlg.addEventListener('keydown', e => {
            if (e.key === ' ') { e.preventDefault(); ttPlay(!T.playing); }
            else if (e.key === 'ArrowRight' && T.i < TUT.length - 1) ttScene(T.i + 1);
            else if (e.key === 'ArrowLeft') ttScene(Math.max(0, T.i - 1));
        });
        dlg.showModal();
        ttScene(0);
    }
    function ttSay(text) {
        if (!T || !T.sound || !('speechSynthesis' in window)) return;
        try { speechSynthesis.cancel(); const u = new SpeechSynthesisUtterance(text); u.rate = 1.02; speechSynthesis.speak(u); } catch (e) { /* no voice */ }
    }
    function ttScene(i) {
        if (!T) return;
        const sc = TUT[i];
        T.i = i; T.t = 0; T.ended = false;
        const stage = T.dlg.querySelector('.tt-stage');
        stage.className = `tt-stage${sc.night ? ' night' : ''}`;
        stage.innerHTML = sc.html();
        T.dlg.querySelector('.ht-n').textContent = `${i + 1} of ${TUT.length}`;
        T.dlg.querySelector('.ht-title').textContent = sc.title;
        T.dlg.querySelector('.ht-say').textContent = sc.say;
        T.dlg.querySelectorAll('.ht-seg').forEach((b, k) => { b.classList.toggle('on', k === i); b.setAttribute('aria-selected', String(k === i)); b.querySelector('i').style.transform = `scaleX(${k < i ? 1 : 0})`; });
        if (!T.playing) ttPlay(true); else { ttSay(sc.say); ttLoop(); }
    }
    function ttPlay(on) {
        T.playing = on;
        const b = T.dlg.querySelector('.ht-play');
        b.innerHTML = ic(on ? 'i-pause' : 'i-play');
        b.setAttribute('aria-label', on ? 'Pause' : 'Play');
        T.dlg.querySelector('.tt-stage').classList.toggle('paused', !on);
        try { if (on) { if (speechSynthesis.paused) speechSynthesis.resume(); else if (T.t < 300) ttSay(TUT[T.i].say); } else speechSynthesis.pause(); } catch (e) { /* ignore */ }
        if (on) ttLoop(); else cancelAnimationFrame(T.raf);
    }
    function ttLoop() {
        cancelAnimationFrame(T.raf);
        let last = performance.now();
        const tick = now => {
            if (!T || !T.playing) return;
            T.t += Math.min(100, now - last);
            last = now;
            const sc = TUT[T.i];
            const seg = T.dlg.querySelectorAll('.ht-seg i')[T.i];
            if (seg) seg.style.transform = `scaleX(${Math.min(1, T.t / sc.dur)})`;
            if (T.t >= sc.dur) {
                if (T.i < TUT.length - 1) return ttScene(T.i + 1);
                T.playing = false; T.ended = true;
                const b = T.dlg.querySelector('.ht-play');
                b.innerHTML = ic('i-play'); b.setAttribute('aria-label', 'Watch again');
                const end = document.createElement('div');
                end.className = 'ht-end';
                end.innerHTML = '<strong>Ready to play?</strong><span>Trust no one 🎭</span><div><button type="button" class="primary-btn" data-tt="play-now">Open a room</button><button type="button" class="ghost-btn" data-tt="replay">Watch again</button></div>';
                T.dlg.querySelector('.tt-stage').append(end);
                return;
            }
            T.raf = requestAnimationFrame(tick);
        };
        T.raf = requestAnimationFrame(tick);
    }

    document.addEventListener('click', e => { if (e.target.closest('[data-mafia-new]')) newRoom(); });

    window.diaryMafia = { newRoom, openRoom, tutorial, cardHTML, preview: () => '🎭 Cordial Mafia — join the room', _deal: deal, _crypto: { seal, unseal, loadKeys }, _room: () => R, _advance: () => R && R.isHost && advance() };
});
