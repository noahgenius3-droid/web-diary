// Board games with friends: Chess (two players) and Ludo (two to four). Play a friend or the computer.
// While everyone is in the game, moves travel live over a realtime channel. When it's someone's turn and they
// aren't there, they get one "Your move" card in their chat that carries the whole game, so it can be picked up
// later from either phone. Every phone also keeps its own copy, and the newest copy (highest move number) wins.
document.addEventListener('DOMContentLoaded', () => {
    const app = window.diaryApp;
    const social = window.diarySocial;
    if (!app || !social || !social.internals) return;
    const I = social.internals;
    const { client, state: s, esc } = I;
    const ic = (id, cls = '') => `<svg class="i${cls ? ` ${cls}` : ''}" aria-hidden="true"><use href="#${id}"/></svg>`;
    const me = () => (s.profile && s.profile.id) || null;
    const uid = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`);

    const KINDS = {
        chess: { title: 'Chess', sub: 'Two players · classic rules', icon: 'i-g-chess', art: '♞', min: 1, max: 1 },
        ludo: { title: 'Ludo', sub: 'Two to four players · race home', icon: 'i-g-ludo', art: '🎲', min: 1, max: 3 }
    };

    // ======================================================================
    // Chess rules. Squares 0..63: 0 is a8, 63 is h1. Upper case is white.
    // ======================================================================
    const CH = (() => {
        const START = 'rnbqkbnrpppppppp' + '.'.repeat(32) + 'PPPPPPPPRNBQKBNR';
        const KN = [[-2, -1], [-2, 1], [-1, -2], [-1, 2], [1, -2], [1, 2], [2, -1], [2, 1]];
        const KG = [[-1, -1], [-1, 0], [-1, 1], [0, -1], [0, 1], [1, -1], [1, 0], [1, 1]];
        const ORTH = [[1, 0], [-1, 0], [0, 1], [0, -1]];
        const DIAG = [[1, 1], [1, -1], [-1, 1], [-1, -1]];
        const on = (r, c) => r >= 0 && r < 8 && c >= 0 && c < 8;
        const at = (r, c) => r * 8 + c;
        const colorOf = p => (p === '.' ? null : p === p.toUpperCase() ? 'w' : 'b');
        const opp = c => (c === 'w' ? 'b' : 'w');
        const sqName = i => `${'abcdefgh'[i & 7]}${8 - (i >> 3)}`;

        function init() {
            return { b: START, turn: 'w', castle: 'KQkq', ep: -1, half: 0, full: 1, hist: [], last: null, status: 'active', winner: null, reason: '', reps: {} };
        }
        function attacked(b, sq, by) {
            const r = sq >> 3, c = sq & 7;
            const up = by === 'w' ? 1 : -1; // a white pawn one row below attacks diagonally up
            for (const dc of [-1, 1]) if (on(r + up, c + dc) && b[at(r + up, c + dc)] === (by === 'w' ? 'P' : 'p')) return true;
            for (const [dr, dc] of KN) if (on(r + dr, c + dc) && b[at(r + dr, c + dc)] === (by === 'w' ? 'N' : 'n')) return true;
            for (const [dr, dc] of KG) if (on(r + dr, c + dc) && b[at(r + dr, c + dc)] === (by === 'w' ? 'K' : 'k')) return true;
            const ray = (dirs, kinds) => dirs.some(([dr, dc]) => {
                let rr = r + dr, cc = c + dc;
                while (on(rr, cc)) {
                    const p = b[at(rr, cc)];
                    if (p !== '.') return colorOf(p) === by && kinds.includes(p.toUpperCase());
                    rr += dr; cc += dc;
                }
                return false;
            });
            return ray(ORTH, 'RQ') || ray(DIAG, 'BQ');
        }
        const kingSq = (b, col) => b.indexOf(col === 'w' ? 'K' : 'k');
        const inCheck = (st, col = st.turn) => attacked(st.b, kingSq(st.b, col), opp(col));

        function pseudo(st) {
            const b = st.b, col = st.turn, out = [];
            for (let i = 0; i < 64; i++) {
                const p = b[i];
                if (colorOf(p) !== col) continue;
                const r = i >> 3, c = i & 7, P = p.toUpperCase();
                const add = (t, extra = {}) => out.push({ f: i, t, ...extra });
                if (P === 'P') {
                    const dir = col === 'w' ? -1 : 1, startRow = col === 'w' ? 6 : 1, lastRow = col === 'w' ? 0 : 7;
                    const push = (t, extra = {}) => ((t >> 3) === lastRow ? 'qrbn'.split('').forEach(q => add(t, { ...extra, promo: q })) : add(t, extra));
                    if (on(r + dir, c) && b[at(r + dir, c)] === '.') {
                        push(at(r + dir, c));
                        if (r === startRow && b[at(r + 2 * dir, c)] === '.') add(at(r + 2 * dir, c), { dbl: true });
                    }
                    for (const dc of [-1, 1]) {
                        if (!on(r + dir, c + dc)) continue;
                        const t = at(r + dir, c + dc);
                        if (colorOf(b[t]) === opp(col)) push(t);
                        else if (t === st.ep) add(t, { ep: true });
                    }
                } else if (P === 'N' || P === 'K') {
                    for (const [dr, dc] of P === 'N' ? KN : KG) {
                        if (!on(r + dr, c + dc)) continue;
                        const t = at(r + dr, c + dc);
                        if (colorOf(b[t]) !== col) add(t);
                    }
                    if (P === 'K' && !inCheck(st, col)) {
                        const home = col === 'w' ? 60 : 4;
                        if (i === home) {
                            const k = col === 'w' ? 'K' : 'k', q = col === 'w' ? 'Q' : 'q', rook = col === 'w' ? 'R' : 'r';
                            if (st.castle.includes(k) && b[home + 1] === '.' && b[home + 2] === '.' && b[home + 3] === rook
                                && !attacked(b, home + 1, opp(col)) && !attacked(b, home + 2, opp(col))) add(home + 2, { castle: 'k' });
                            if (st.castle.includes(q) && b[home - 1] === '.' && b[home - 2] === '.' && b[home - 3] === '.' && b[home - 4] === rook
                                && !attacked(b, home - 1, opp(col)) && !attacked(b, home - 2, opp(col))) add(home - 2, { castle: 'q' });
                        }
                    }
                } else {
                    const dirs = P === 'R' ? ORTH : P === 'B' ? DIAG : [...ORTH, ...DIAG];
                    for (const [dr, dc] of dirs) {
                        let rr = r + dr, cc = c + dc;
                        while (on(rr, cc)) {
                            const t = at(rr, cc);
                            if (b[t] === '.') add(t);
                            else { if (colorOf(b[t]) !== col) add(t); break; }
                            rr += dr; cc += dc;
                        }
                    }
                }
            }
            return out;
        }
        function apply(st, m) {
            const b = st.b.split('');
            const piece = b[m.f], col = st.turn;
            const captured = m.ep ? (col === 'w' ? 'p' : 'P') : b[m.t];
            if (m.ep) b[at(m.f >> 3, m.t & 7)] = '.';
            b[m.t] = m.promo ? (col === 'w' ? m.promo.toUpperCase() : m.promo) : piece;
            b[m.f] = '.';
            if (m.castle) {
                const home = col === 'w' ? 60 : 4;
                if (m.castle === 'k') { b[home + 1] = b[home + 3]; b[home + 3] = '.'; }
                else { b[home - 1] = b[home - 4]; b[home - 4] = '.'; }
            }
            let castle = st.castle;
            const drop = chars => { for (const ch of chars) castle = castle.replace(ch, ''); };
            if (piece === 'K') drop('KQ');
            if (piece === 'k') drop('kq');
            [[63, 'K'], [56, 'Q'], [7, 'k'], [0, 'q']].forEach(([sq, ch]) => { if (m.f === sq || m.t === sq) drop(ch); });
            return {
                ...st, b: b.join(''), turn: opp(col), castle,
                ep: m.dbl ? (m.f + m.t) / 2 : -1,
                half: piece.toUpperCase() === 'P' || captured !== '.' ? 0 : st.half + 1,
                full: st.full + (col === 'b' ? 1 : 0),
                _captured: captured
            };
        }
        function legal(st) {
            return pseudo(st).filter(m => { const n = apply(st, m); return !attacked(n.b, kingSq(n.b, st.turn), n.turn); });
        }
        function insufficient(b) {
            const rest = b.replace(/[Kk.]/g, '');
            return rest === '' || rest === 'N' || rest === 'n' || rest === 'B' || rest === 'b';
        }
        function move(st, m) {
            const n = apply(st, m);
            delete n._captured;
            const capt = st.b[m.t] !== '.' || m.ep;
            const P = st.b[m.f].toUpperCase();
            const replies = legal(n);
            const check = attacked(n.b, kingSq(n.b, n.turn), st.turn);
            let label = m.castle ? (m.castle === 'k' ? 'O-O' : 'O-O-O') : `${P === 'P' ? (capt ? 'abcdefgh'[m.f & 7] : '') : P}${capt ? 'x' : ''}${sqName(m.t)}${m.promo ? `=${m.promo.toUpperCase()}` : ''}`;
            label += !replies.length && check ? '#' : check ? '+' : '';
            n.hist = [...st.hist, label];
            n.last = [m.f, m.t];
            const key = `${n.b}${n.turn}${n.castle}${n.ep}`;
            n.reps = { ...st.reps, [key]: (st.reps[key] || 0) + 1 };
            if (!replies.length) {
                n.status = 'over';
                n.winner = check ? st.turn : null;
                n.reason = check ? 'checkmate' : 'stalemate';
            } else if (n.half >= 100) { n.status = 'over'; n.reason = 'the 50-move rule'; }
            else if (n.reps[key] >= 3) { n.status = 'over'; n.reason = 'repetition'; }
            else if (insufficient(n.b)) { n.status = 'over'; n.reason = 'not enough pieces to mate'; }
            return n;
        }

        // The computer: a short look-ahead on material and a little position sense
        const VAL = { P: 100, N: 320, B: 330, R: 500, Q: 900, K: 0 };
        const CENTER = [0, 1, 2, 3, 3, 2, 1, 0];
        function evaluate(b) {
            let sc = 0;
            for (let i = 0; i < 64; i++) {
                const p = b[i];
                if (p === '.') continue;
                const P = p.toUpperCase(), r = i >> 3, c = i & 7;
                let v = VAL[P];
                if (P === 'N' || P === 'B') v += 4 * (CENTER[r] + CENTER[c]);
                if (P === 'P') v += (p === 'P' ? 6 - r : r - 1) * 6 + (c >= 2 && c <= 5 ? 4 : 0);
                sc += p === P ? v : -v;
            }
            return sc;
        }
        function order(st, ms) {
            return ms.map(m => ({ m, k: (st.b[m.t] !== '.' ? VAL[st.b[m.t].toUpperCase()] * 10 - VAL[st.b[m.f].toUpperCase()] : 0) + (m.promo === 'q' ? 800 : 0) }))
                .sort((a, b) => b.k - a.k).map(x => x.m);
        }
        function search(st, depth, alpha, beta) {
            const ms = legal(st);
            if (!ms.length) return inCheck(st) ? -100000 - depth : 0;
            if (depth === 0) return (st.turn === 'w' ? 1 : -1) * evaluate(st.b);
            for (const m of order(st, ms)) {
                const v = -search(apply(st, m), depth - 1, -beta, -alpha);
                if (v >= beta) return beta;
                if (v > alpha) alpha = v;
            }
            return alpha;
        }
        function best(st) {
            const ms = order(st, legal(st));
            const pieces = st.b.replace(/\./g, '').length;
            const depth = pieces <= 10 ? 3 : 2;
            let top = -Infinity, picks = [];
            for (const m of ms) {
                const v = -search(apply(st, m), depth - 1, -Infinity, Infinity) + Math.random() * 8; // a little variety
                if (v > top + 0.5) { top = v; picks = [m]; } else if (Math.abs(v - top) <= 0.5) picks.push(m);
            }
            return picks[0] || ms[0];
        }
        return { init, legal, move, best, inCheck, kingSq, colorOf, sqName };
    })();

    // ======================================================================
    // Ludo rules. 52 squares around, 5 in each home column, then home.
    // A token's progress: -1 in the yard, 0..50 on the track, 51..55 home column, 56 home.
    // ======================================================================
    const LU = (() => {
        const segs = [[[6, 1], [6, 5]], [[5, 6], [0, 6]], [[0, 7], [0, 7]], [[0, 8], [5, 8]], [[6, 9], [6, 14]], [[7, 14], [7, 14]], [[8, 14], [8, 9]],
            [[9, 8], [14, 8]], [[14, 7], [14, 7]], [[14, 6], [9, 6]], [[8, 5], [8, 0]], [[7, 0], [7, 0]], [[6, 0], [6, 0]]];
        const PATH = [];
        for (const [[r1, c1], [r2, c2]] of segs) {
            const dr = Math.sign(r2 - r1), dc = Math.sign(c2 - c1);
            for (let r = r1, c = c1; ; r += dr, c += dc) { PATH.push([r, c]); if (r === r2 && c === c2) break; }
        }
        const START = { red: 0, green: 13, yellow: 26, blue: 39 };
        const HOME = {
            red: [1, 2, 3, 4, 5].map(c => [7, c]), green: [1, 2, 3, 4, 5].map(r => [r, 7]),
            yellow: [13, 12, 11, 10, 9].map(c => [7, c]), blue: [13, 12, 11, 10, 9].map(r => [r, 7])
        };
        const YARD = { red: [0, 0], green: [0, 9], yellow: [9, 9], blue: [9, 0] };
        const SAFE = new Set([0, 8, 13, 21, 26, 34, 39, 47]);
        const SETS = { 2: ['red', 'yellow'], 3: ['red', 'green', 'yellow'], 4: ['red', 'green', 'yellow', 'blue'] };
        const abs = (col, p) => (START[col] + p) % 52;

        function init(n) {
            const colors = SETS[n];
            return { colors, turn: 0, dice: null, sixes: 0, tokens: Object.fromEntries(colors.map(c => [c, [-1, -1, -1, -1]])), status: 'active', winner: null, last: null, note: '' };
        }
        const clone = st => ({ ...st, tokens: Object.fromEntries(Object.entries(st.tokens).map(([k, v]) => [k, v.slice()])) });
        function movable(st) {
            if (st.dice == null) return [];
            const col = st.colors[st.turn];
            return st.tokens[col].map((p, i) => ((p === -1 ? st.dice === 6 : p < 56 && p + st.dice <= 56) ? i : -1)).filter(i => i >= 0);
        }
        function next(st) { st.turn = (st.turn + 1) % st.colors.length; st.dice = null; st.sixes = 0; }
        function roll(st, value) {
            const n = clone(st);
            n.dice = value;
            n.note = '';
            n.last = null;
            if (value === 6) n.sixes += 1;
            if (n.sixes >= 3) { n.note = `${cap(n.colors[n.turn])} rolled three sixes — turn over`; next(n); }
            return n;
        }
        function pass(st) { const n = clone(st); n.note = ''; next(n); return n; }
        function moveToken(st, i) {
            const n = clone(st);
            const col = n.colors[n.turn], d = n.dice;
            const from = n.tokens[col][i];
            const to = from === -1 ? 0 : from + d;
            n.tokens[col][i] = to;
            let again = d === 6;
            n.note = '';
            if (to <= 50) {
                const a = abs(col, to);
                if (!SAFE.has(a)) {
                    for (const other of n.colors) {
                        if (other === col) continue;
                        n.tokens[other] = n.tokens[other].map(p => {
                            if (p >= 0 && p <= 50 && abs(other, p) === a) { again = true; n.note = `${cap(col)} sent ${other} home`; return -1; }
                            return p;
                        });
                    }
                }
            }
            if (to === 56) { again = true; n.note = `${cap(col)} got a token home`; }
            n.last = { col, i, from, to };
            if (n.tokens[col].every(p => p === 56)) { n.status = 'over'; n.winner = col; n.dice = null; return n; }
            if (again) { n.dice = null; if (d !== 6) n.sixes = 0; } else next(n);
            return n;
        }
        // The computer's choice: get home, capture, come out, stay safe, then move the furthest token on
        function pick(st) {
            const ms = movable(st);
            const col = st.colors[st.turn];
            let top = -Infinity, choice = ms[0];
            for (const i of ms) {
                const p = st.tokens[col][i], to = p === -1 ? 0 : p + st.dice;
                let v = to / 10;
                if (to === 56) v += 100;
                if (p === -1) v += 60;
                if (to <= 50) {
                    const a = abs(col, to);
                    if (SAFE.has(a)) v += 20;
                    else if (st.colors.some(o => o !== col && st.tokens[o].some(q => q >= 0 && q <= 50 && abs(o, q) === a))) v += 80;
                } else v += 30; // in the home column nobody can touch it
                if (v > top) { top = v; choice = i; }
            }
            return choice;
        }
        // Where a token sits on the 15×15 board (in cells, centre of the square)
        function spot(col, p, i) {
            if (p === -1) { const [r, c] = YARD[col]; return [r + 1.75 + (i >> 1) * 2.5, c + 1.75 + (i & 1) * 2.5]; }
            if (p === 56) { const off = { red: [7.5, 6.6], green: [6.6, 7.5], yellow: [7.5, 8.4], blue: [8.4, 7.5] }[col]; return [off[0] + ((i & 1) - 0.5) * 0.45, off[1] + ((i >> 1) - 0.5) * 0.45]; }
            const [r, c] = p <= 50 ? PATH[abs(col, p)] : HOME[col][p - 51];
            return [r + 0.5, c + 0.5];
        }
        const cap = c => c[0].toUpperCase() + c.slice(1);
        return { init, roll, pass, moveToken, movable, pick, spot, PATH, HOME, START, SAFE, YARD, abs };
    })();

    // ======================================================================
    // Games on this phone
    // ======================================================================
    const KEY = () => `cordialBG:${me()}`;
    function all() { try { return JSON.parse(localStorage.getItem(KEY()) || '{}') || {}; } catch (e) { return {}; } }
    function getRec(id) { return all()[id] || null; }
    function saveRec(rec) {
        const list = all();
        list[rec.id] = rec;
        const ids = Object.keys(list).sort((a, b) => (list[b].updated || 0) - (list[a].updated || 0));
        ids.slice(40).forEach(id => delete list[id]);
        try { localStorage.setItem(KEY(), JSON.stringify(list)); } catch (e) { /* storage full — the game still plays */ }
    }
    function dropRec(id) { const list = all(); delete list[id]; try { localStorage.setItem(KEY(), JSON.stringify(list)); } catch (e) { /* ignore */ } }

    // People
    const people = new Map();
    function who(id) {
        if (!id) return { display_name: 'Someone' };
        if (String(id).startsWith('cpu')) return { id, display_name: 'Computer', username: 'computer' };
        if (id === me()) return s.profile;
        return people.get(id) || (s.friends || []).find(f => f.id === id) || { id, display_name: 'Someone' };
    }
    const first = id => (id === me() ? 'You' : String(who(id).display_name || 'Someone').split(' ')[0]);
    async function loadPeople(ids) {
        const need = ids.filter(id => id && !String(id).startsWith('cpu') && id !== me() && !people.has(id) && !(s.friends || []).some(f => f.id === id));
        if (!need.length) return;
        const { data } = await client.from('diary_profiles').select('id, username, display_name, avatar_path').in('id', need);
        (data || []).forEach(p => people.set(p.id, p));
    }

    // Whose turn, as a person
    function turnId(rec) {
        const st = rec.state;
        if (st.status !== 'active') return null;
        return rec.kind === 'chess' ? rec.players[st.turn === 'w' ? 0 : 1] : rec.players[st.turn];
    }
    const myTurn = rec => turnId(rec) === me();
    function statusLine(rec) {
        const st = rec.state;
        if (st.status === 'active') {
            const t = turnId(rec);
            return t === me() ? 'Your move' : `${first(t)}’s move`;
        }
        if (st.status === 'resigned') return st.winner === me() || rec.players[st.winnerIdx] === me() ? 'You won' : `${first(rec.players[st.winnerIdx])} won`;
        if (rec.kind === 'chess') {
            if (!st.winner) return `Draw · ${st.reason}`;
            const w = rec.players[st.winner === 'w' ? 0 : 1];
            return w === me() ? `You won · ${st.reason}` : `${first(w)} won · ${st.reason}`;
        }
        const w = rec.players[st.colors.indexOf(st.winner)];
        return w === me() ? 'You won' : `${first(w)} won`;
    }

    // ======================================================================
    // Live play: a channel per game, presence says who's in
    // ======================================================================
    const live = new Map(); // id -> { ch, present:Set }
    function join(rec) {
        if (rec.mode !== 'friends' || live.has(rec.id)) return;
        const entry = { ch: null, present: new Set() };
        live.set(rec.id, entry);
        const ch = client.channel(`bg-${rec.id}`, { config: { broadcast: { self: false }, presence: { key: me() } } });
        entry.ch = ch;
        ch.on('broadcast', { event: 'state' }, ({ payload }) => adopt(payload, true))
            .on('broadcast', { event: 'chat' }, ({ payload }) => chatIn(rec.id, payload && payload.msg))
            .on('broadcast', { event: 'hello' }, ({ payload }) => {
                const r = getRec(rec.id);
                if (r && r.seq > Number(payload && payload.seq || 0)) send(r);
            })
            .on('presence', { event: 'sync' }, () => {
                entry.present = new Set(Object.keys(ch.presenceState() || {}));
                if (V && V.id === rec.id) paintPlayers();
            })
            .subscribe(status => {
                if (status !== 'SUBSCRIBED') return;
                ch.track({ at: Date.now() }).catch(() => {});
                const r = getRec(rec.id);
                ch.send({ type: 'broadcast', event: 'hello', payload: { seq: r ? r.seq : 0 } }).catch(() => {});
            });
    }
    function leave(id) {
        const e = live.get(id);
        if (e && e.ch) client.removeChannel(e.ch);
        live.delete(id);
    }
    function send(rec) {
        const e = live.get(rec.id);
        if (e && e.ch) e.ch.send({ type: 'broadcast', event: 'state', payload: wire(rec) }).catch(() => {});
    }
    const wire = rec => ({ id: rec.id, kind: rec.kind, mode: rec.mode, players: rec.players, seq: rec.seq, state: rec.state, created: rec.created, chat: (rec.chat || []).slice(-40) });
    // A newer copy of a game (from a peer or a chat card) replaces ours
    function adopt(p, fromLive = false) {
        if (!p || !p.id || !KINDS[p.kind] || !Array.isArray(p.players) || !p.players.includes(me())) return null;
        const mine = cur(p.id);
        if (mine && mine.seq >= Number(p.seq || 0)) {
            // Same or older moves, but maybe new chat
            const n = mergeChat(mine, p.chat);
            if (n) { saveRec(mine); if (V && V.id === mine.id) { if (V.chatOpen) paintChat(); else { V.unread += n; paintChatBtn(); } } }
            return mine;
        }
        const rec = { ...(mine || {}), id: p.id, kind: p.kind, mode: 'friends', players: p.players, seq: Number(p.seq || 0), state: p.state, created: p.created || Date.now(), updated: Date.now() };
        const fresh = mergeChat(rec, p.chat);
        saveRec(rec);
        if (V && V.id === rec.id) { V.rec = rec; V.sel = null; if (fresh && !V.chatOpen) V.unread += fresh; paint(); if (V.chatOpen) paintChat(); if (rec.state.status !== 'active') celebrate(rec); }
        else if (fromLive && myTurn(rec)) app.showToast(`${KINDS[rec.kind].title}: your move`);
        repaintLists();
        return rec;
    }

    // A card in someone's chat: the invite, "your move", or the result
    async function postCard(rec, to, note) {
        const att = {
            kind: 'game', game: rec.kind, note, id: rec.id, players: rec.players, seq: rec.seq, state: rec.state, created: rec.created, chat: (rec.chat || []).slice(-30),
            name: `${KINDS[rec.kind].art} ${KINDS[rec.kind].title} — ${note === 'invite' ? 'you’re invited' : note === 'over' ? 'game over' : 'your move'}`
        };
        const { error } = await client.from('diary_messages').insert({ recipient: to, body: '', attachments: [att] });
        return !error;
    }
    // After a move: tell whoever is next (if they're not here), or everyone not here when it's over
    function afterMove(rec) {
        rec.seq += 1;
        rec.updated = Date.now();
        saveRec(rec);
        if (rec.mode !== 'friends') return;
        send(rec);
        const present = (live.get(rec.id) || {}).present || new Set();
        if (rec.state.status !== 'active') {
            rec.players.filter(p => p !== me() && !present.has(p)).forEach(p => postCard(rec, p, 'over'));
            return;
        }
        const next = turnId(rec);
        if (next && next !== me() && !present.has(next)) postCard(rec, next, 'turn');
    }

    // ======================================================================
    // The game window
    // ======================================================================
    let V = null; // { id, rec, dlg, sel, targets, promo, busy }
    async function openGame(id) {
        const rec = getRec(id);
        if (!rec) return app.showToast('That game isn’t on this phone — open it from the chat card');
        await loadPeople(rec.players);
        closeGame();
        const dlg = document.createElement('dialog');
        dlg.className = 'gm bg';
        dlg.setAttribute('aria-label', KINDS[rec.kind].title);
        document.body.append(dlg);
        V = { id, rec, dlg, sel: null, targets: [], busy: false, chatOpen: false, unread: 0, chatEl: rec.mode === 'friends' ? chatPanel() : null };
        dlg.addEventListener('close', () => { if (V && V.dlg === dlg) { leave(V.id); V = null; } dlg.remove(); repaintLists(); });
        dlg.addEventListener('click', onClick);
        dlg.addEventListener('submit', e => {
            const form = e.target.closest('.bg-chat-form');
            if (!form) return;
            e.preventDefault();
            const input = form.querySelector('input');
            chatSend(input.value);
            input.value = '';
            input.focus();
        });
        dlg.showModal();
        join(rec);
        paint();
        botTurn();
    }
    function closeGame() { if (V && V.dlg.open) V.dlg.close(); }

    function paint() {
        if (!V) return;
        const rec = V.rec;
        const k = KINDS[rec.kind];
        V.dlg.innerHTML = `
            <div class="gm-card bg-card bg-${rec.kind}">
                <header class="gm-head">
                    <button type="button" class="icon-btn" data-bg="close" aria-label="Close">${ic('i-close')}</button>
                    <div class="gm-title"><strong>${ic(k.icon)}${esc(k.title)}</strong><small>${rec.mode === 'computer' ? 'Against the computer' : 'With friends'}</small></div>
                    ${V.chatEl ? `<button type="button" class="icon-btn bg-chat-btn" data-bg="chat" aria-label="Chat" aria-expanded="${V.chatOpen}">${ic('i-chat')}<span class="bg-unread" hidden></span></button>` : ''}
                    <button type="button" class="icon-btn" data-bg="menu" aria-label="Game options" aria-haspopup="menu">${ic('i-more')}</button>
                </header>
                <div class="bg-players" data-bg-players></div>
                <p class="bg-status" role="status" aria-live="polite"></p>
                <div class="bg-stage">${rec.kind === 'chess' ? chessHTML() : ludoHTML()}</div>
                <div class="bg-under">${rec.kind === 'chess' ? chessUnder() : ludoUnder()}</div>
            </div>`;
        if (V.chatEl) { V.dlg.querySelector('.bg-card').append(V.chatEl); paintChatBtn(); }
        paintPlayers();
        paintStatus();
        I.hydrateStorage && I.hydrateStorage(V.dlg);
    }

    // ---------- The chat room inside a game ----------
    const cur = id => (V && V.id === id ? V.rec : getRec(id));
    function mergeChat(rec, list) {
        if (!rec || !Array.isArray(list) || !list.length) return 0;
        const have = new Set((rec.chat || []).map(m => m.id));
        const add = list.filter(m => m && m.id && !have.has(String(m.id)) && typeof m.text === 'string' && rec.players.includes(m.by))
            .map(m => ({ id: String(m.id), by: m.by, text: String(m.text).slice(0, 300), at: Number(m.at) || Date.now() }));
        if (!add.length) return 0;
        rec.chat = [...(rec.chat || []), ...add].sort((a, b) => a.at - b.at).slice(-60);
        return add.filter(m => m.by !== me()).length;
    }
    function chatIn(id, msg) {
        const rec = cur(id);
        const n = mergeChat(rec, msg ? [msg] : []);
        if (!n) return;
        saveRec(rec);
        if (V && V.id === id) {
            if (V.chatOpen) paintChat();
            else { V.unread += n; paintChatBtn(); app.showToast(`${first(msg.by)}: ${String(msg.text).slice(0, 60)}`); }
        }
    }
    function chatSend(text) {
        text = String(text || '').trim().slice(0, 300);
        if (!text || !V) return;
        const rec = V.rec;
        const msg = { id: uid(), by: me(), text, at: Date.now() };
        rec.chat = [...(rec.chat || []), msg].slice(-60);
        saveRec(rec);
        const e = live.get(rec.id);
        if (e && e.ch) e.ch.send({ type: 'broadcast', event: 'chat', payload: { msg } }).catch(() => {});
        paintChat();
    }
    const CHAT_EMOJI = ['😂', '👏', '🔥', '😮', '😅', '🎉', '😤', '🤝'];
    function chatPanel() {
        const el = document.createElement('section');
        el.className = 'bg-chat';
        el.hidden = true;
        el.setAttribute('aria-label', 'Game chat');
        el.innerHTML = `
            <header class="bg-chat-head"><strong>${ic('i-chat')}Game chat</strong><button type="button" class="icon-btn" data-bg="chat" aria-label="Close chat">${ic('i-close')}</button></header>
            <ol class="bg-chat-list" aria-live="polite"></ol>
            <div class="bg-chat-emo" role="group" aria-label="Quick emoji">${CHAT_EMOJI.map(x => `<button type="button" data-bg-emoji="${x}" aria-label="Send ${x}">${x}</button>`).join('')}</div>
            <form class="bg-chat-form"><input type="text" maxlength="300" placeholder="Say something…" aria-label="Message" enterkeyhint="send" autocomplete="off"><button type="submit" class="bg-chat-send" aria-label="Send">${ic('i-send')}</button></form>`;
        return el;
    }
    function paintChat() {
        if (!V || !V.chatEl) return;
        const list = V.chatEl.querySelector('.bg-chat-list');
        const msgs = V.rec.chat || [];
        list.innerHTML = msgs.length ? msgs.map((m, i) => {
            const mine = m.by === me();
            const cont = i > 0 && msgs[i - 1].by === m.by;
            const big = /^(\p{Extended_Pictographic}|\u200d|\ufe0f){1,8}$/u.test(m.text);
            return `<li class="bg-msg${mine ? ' mine' : ''}${cont ? ' cont' : ''}">${!mine && !cont ? `<span class="bg-msg-who">${esc(first(m.by))}</span>` : ''}<span class="bg-msg-text${big ? ' big' : ''}">${esc(m.text)}</span></li>`;
        }).join('') : '<li class="bg-chat-empty">Say hi! Friends who aren’t in the game see your messages next time they open it.</li>';
        list.scrollTop = list.scrollHeight;
    }
    function paintChatBtn() {
        if (!V) return;
        const b = V.dlg.querySelector('.bg-chat-btn .bg-unread');
        if (!b) return;
        b.hidden = !V.unread;
        b.textContent = V.unread > 9 ? '9+' : String(V.unread);
    }
    function toggleChat(open = !V.chatOpen) {
        if (!V || !V.chatEl) return;
        V.chatOpen = open;
        V.chatEl.hidden = !open;
        V.dlg.querySelector('.bg-chat-btn')?.setAttribute('aria-expanded', String(open));
        if (open) { V.unread = 0; paintChatBtn(); paintChat(); setTimeout(() => V && V.chatEl && V.chatEl.querySelector('input').focus({ preventScroll: true }), 60); }
    }
    function paintPlayers() {
        if (!V) return;
        const el = V.dlg.querySelector('[data-bg-players]');
        if (!el) return;
        const rec = V.rec, st = rec.state;
        const present = (live.get(rec.id) || {}).present || new Set();
        const turn = turnId(rec);
        el.innerHTML = rec.players.map((p, i) => {
            const side = rec.kind === 'chess' ? (i === 0 ? 'White' : 'Black') : cap(st.colors[i]);
            const here = rec.mode === 'computer' || p === me() || present.has(p);
            return `<div class="bg-p${p === turn ? ' turn' : ''}${rec.kind === 'ludo' ? ` lc-${st.colors[i]}` : ` side-${i === 0 ? 'w' : 'b'}`}">
                <span class="bg-p-av">${String(p).startsWith('cpu') ? `<span class="avatar sm bg-cpu" aria-hidden="true">${ic('i-sparkle')}</span>` : I.avatar(who(p), 'sm')}<i class="bg-dot${here ? ' on' : ''}" title="${here ? 'Here now' : 'Not in the game right now'}"></i></span>
                <span class="bg-p-text"><strong>${esc(first(p))}</strong><small>${side}</small></span>
            </div>`;
        }).join('');
        I.hydrateStorage && I.hydrateStorage(el);
    }
    function paintStatus() {
        if (!V) return;
        const el = V.dlg.querySelector('.bg-status');
        const rec = V.rec, st = rec.state;
        let text = statusLine(rec);
        if (rec.kind === 'chess' && st.status === 'active' && CH.inCheck(st)) text += ' · check!';
        if (rec.kind === 'ludo' && st.note) text = `${st.note} · ${text}`;
        el.textContent = text;
        el.classList.toggle('mine', st.status === 'active' && myTurn(rec));
    }
    const cap = c => c[0].toUpperCase() + c.slice(1);

    // ---------- Chess board ----------
    const GLYPH = { k: '♚', q: '♛', r: '♜', b: '♝', n: '♞', p: '♟' };
    const NAME = { k: 'king', q: 'queen', r: 'rook', b: 'bishop', n: 'knight', p: 'pawn' };
    function myColor(rec) { return rec.players[0] === me() ? 'w' : rec.players[1] === me() ? 'b' : null; }
    function chessHTML() {
        const rec = V.rec, st = rec.state;
        const flip = myColor(rec) === 'b';
        const order = [...Array(64).keys()];
        if (flip) order.reverse();
        const check = st.status === 'active' && CH.inCheck(st) ? CH.kingSq(st.b, st.turn) : -1;
        const tg = new Set(V.targets.map(m => m.t));
        return `<div class="cb" role="grid" aria-label="Chess board">${order.map(i => {
            const p = st.b[i], r = i >> 3, c = i & 7;
            const dark = (r + c) % 2 === 1;
            const cls = ['cb-sq', dark ? 'dk' : 'lt', st.last && st.last.includes(i) ? 'last' : '', V.sel === i ? 'sel' : '', tg.has(i) ? (p !== '.' ? 'hit' : 'to') : '', i === check ? 'chk' : ''].filter(Boolean).join(' ');
            const pc = p === '.' ? '' : `<span class="cb-pc ${p === p.toUpperCase() ? 'w' : 'b'}" aria-hidden="true">${GLYPH[p.toLowerCase()]}&#xFE0E;</span>`;
            const label = `${CH.sqName(i)}${p === '.' ? '' : `, ${p === p.toUpperCase() ? 'white' : 'black'} ${NAME[p.toLowerCase()]}`}`;
            const edgeR = flip ? r === 0 : r === 7, edgeC = flip ? c === 7 : c === 0;
            return `<button type="button" class="${cls}" data-sq="${i}" aria-label="${label}">${pc}${edgeR ? `<i class="cb-f">${'abcdefgh'[c]}</i>` : ''}${edgeC ? `<i class="cb-r">${8 - r}</i>` : ''}</button>`;
        }).join('')}</div>`;
    }
    function chessUnder() {
        const st = V.rec.state;
        const moves = st.hist;
        const pairs = [];
        for (let i = 0; i < moves.length; i += 2) pairs.push(`<span><b>${i / 2 + 1}.</b> ${esc(moves[i])}${moves[i + 1] ? ` ${esc(moves[i + 1])}` : ''}</span>`);
        return `<div class="cb-moves" aria-label="Moves">${pairs.length ? pairs.slice(-12).join('') : '<span class="muted">White moves first.</span>'}</div>
            ${V.promo ? `<div class="cb-promo" role="group" aria-label="Promote to">${'qrbn'.split('').map(q => `<button type="button" data-promo="${q}" aria-label="${NAME[q]}"><span class="cb-pc ${myColor(V.rec)}">${GLYPH[q]}&#xFE0E;</span></button>`).join('')}</div>` : ''}`;
    }
    function chessTap(i) {
        const rec = V.rec, st = rec.state;
        if (st.status !== 'active' || !myTurn(rec) || V.busy) return;
        const mine = CH.colorOf(st.b[i]) === st.turn;
        const pick = V.targets.filter(m => m.t === i);
        if (V.sel !== null && pick.length) {
            if (pick.length > 1) { V.promo = pick; paint(); return; } // promotion: choose the piece
            return chessPlay(pick[0]);
        }
        if (mine) { V.sel = i; V.targets = CH.legal(st).filter(m => m.f === i); }
        else { V.sel = null; V.targets = []; }
        V.promo = null;
        paint();
    }
    function chessPlay(m) {
        const rec = V.rec;
        rec.state = CH.move(rec.state, m);
        V.sel = null; V.targets = []; V.promo = null;
        afterMove(rec);
        paint();
        if (rec.state.status !== 'active') celebrate(rec);
        else botTurn();
    }

    // ---------- Ludo board ----------
    function ludoHTML() {
        const rec = V.rec, st = rec.state;
        return ludoBoard(st, new Set(myTurn(rec) && st.status === 'active' ? LU.movable(st) : []));
    }
    // The board itself (the game and the how-to-play video both draw it). The centre carries the Cordial mark.
    function ludoBoard(st, mov = new Set(), extra = '') {
        const cells = [];
        const pathIdx = new Map(LU.PATH.map(([r, c], i) => [`${r},${c}`, i]));
        const homeOf = new Map();
        Object.entries(LU.HOME).forEach(([col, list]) => list.forEach(([r, c]) => homeOf.set(`${r},${c}`, col)));
        const startOf = new Map(Object.entries(LU.START).map(([col, i]) => [i, col]));
        for (let r = 0; r < 15; r++) for (let c = 0; c < 15; c++) {
            const k = `${r},${c}`;
            if (pathIdx.has(k)) {
                const i = pathIdx.get(k);
                const sc = startOf.get(i);
                cells.push(`<i class="lb-c tr${sc ? ` lc-${sc} st` : ''}" style="grid-area:${r + 1}/${c + 1}">${LU.SAFE.has(i) && !sc ? '★' : ''}</i>`);
            } else if (homeOf.has(k)) cells.push(`<i class="lb-c hm lc-${homeOf.get(k)}" style="grid-area:${r + 1}/${c + 1}"></i>`);
        }
        const yards = Object.entries(LU.YARD).map(([col, [r, c]]) => `<i class="lb-yard lc-${col}${st.colors.includes(col) ? '' : ' off'}" style="grid-area:${r + 1}/${c + 1}/span 6/span 6"><b></b></i>`).join('');
        const center = `<i class="lb-center" style="grid-area:7/7/span 3/span 3"><span class="lb-brand" aria-hidden="true"><span class="lb-brand-mark">${ic('i-book')}</span><b>Cordial</b></span></i>`;
        const turnCol = st.colors[st.turn];
        // Tokens sharing a square fan out a little
        const seen = new Map();
        const toks = [];
        st.colors.forEach(col => st.tokens[col].forEach((p, i) => {
            const [y, x] = LU.spot(col, p, i);
            const key = p === -1 || p === 56 ? `${col}${i}${p}` : `${y},${x}`;
            const n = seen.get(key) || 0;
            seen.set(key, n + 1);
            const can = col === turnCol && mov.has(i);
            const moved = st.last && st.last.col === col && st.last.i === i;
            toks.push(`<button type="button" class="lb-tok lc-${col}${can ? ' can' : ''}${moved ? ' moved' : ''}" data-tok="${i}" data-tk="${col}${i}" ${can ? '' : 'tabindex="-1" aria-disabled="true"'} style="top:${(y / 15) * 100}%;left:${(x / 15) * 100}%;--n:${n}" aria-label="${cap(col)} token ${i + 1}${p === -1 ? ', in the yard' : p === 56 ? ', home' : ''}${can ? ' — tap to move' : ''}"></button>`);
        }));
        return `<div class="lb" aria-label="Ludo board">${yards}${cells.join('')}${center}<div class="lb-toks">${toks.join('')}</div>${extra}</div>`;
    }
    const PIPS = { 1: [4], 2: [0, 8], 3: [0, 4, 8], 4: [0, 2, 6, 8], 5: [0, 2, 4, 6, 8], 6: [0, 2, 3, 5, 6, 8] };
    function dieHTML(n, rolling = false) {
        return `<span class="die${rolling ? ' rolling' : ''}" aria-hidden="true">${[...Array(9).keys()].map(i => `<i${n && PIPS[n].includes(i) ? ' class="on"' : ''}></i>`).join('')}</span>`;
    }
    function ludoUnder() {
        const rec = V.rec, st = rec.state;
        const mine = myTurn(rec) && st.status === 'active';
        const col = st.colors[st.turn];
        const stuck = mine && st.dice != null && !LU.movable(st).length;
        return `<div class="lu-ctl lc-${col}">
            <button type="button" class="lu-roll" data-bg="roll" ${mine && st.dice == null && !V.busy ? '' : 'disabled'} aria-label="${st.dice ? `Rolled ${st.dice}` : 'Roll the dice'}">${dieHTML(st.dice, V.rolling)}</button>
            <button type="button" class="lu-howto" data-bg="howto">${ic('i-play')}How to play</button>
            <p class="lu-hint">${st.status !== 'active' ? '' : !mine ? `Waiting for ${esc(first(turnId(rec)))}…` : st.dice == null ? 'Tap the dice to roll' : stuck ? 'No moves this time' : 'Tap a glowing token'}</p>
        </div>`;
    }
    async function ludoRoll() {
        const rec = V.rec;
        if (!myTurn(rec) || rec.state.dice != null || V.busy) return;
        V.busy = true; V.rolling = true;
        paint();
        await wait(520);
        const value = 1 + Math.floor((crypto.getRandomValues ? crypto.getRandomValues(new Uint32Array(1))[0] : Math.random() * 2 ** 32) % 6);
        V.rolling = false;
        rec.state = LU.roll(rec.state, value);
        afterMove(rec);
        V.busy = false;
        paint();
        const ms = LU.movable(rec.state);
        if (rec.state.dice != null && !ms.length) { await wait(1100); if (V && V.rec === rec) { rec.state = LU.pass(rec.state); afterMove(rec); paint(); botTurn(); } }
        else if (ms.length === 1 && rec.state.tokens[rec.state.colors[rec.state.turn]].filter(p => p === -1).length === 4) { await wait(450); ludoMove(ms[0]); }
        else if (rec.state.dice == null) botTurn();
    }
    function ludoMove(i) {
        const rec = V.rec;
        if (!myTurn(rec) || !LU.movable(rec.state).includes(i)) return;
        rec.state = LU.moveToken(rec.state, i);
        afterMove(rec);
        paint();
        if (rec.state.status !== 'active') celebrate(rec);
        else botTurn();
    }

    // ---------- The computer's turns ----------
    const wait = ms => new Promise(r => setTimeout(r, ms));
    async function botTurn() {
        if (!V || V.rec.mode !== 'computer' || V.botRunning) return;
        V.botRunning = true;
        try {
            while (V && V.rec.state.status === 'active' && String(turnId(V.rec)).startsWith('cpu')) {
                const rec = V.rec;
                if (rec.kind === 'chess') {
                    await wait(350);
                    const m = CH.best(rec.state);
                    if (!V || V.rec !== rec) return;
                    rec.state = CH.move(rec.state, m);
                } else {
                    await wait(500);
                    if (rec.state.dice == null) {
                        rec.state = LU.roll(rec.state, 1 + Math.floor(Math.random() * 6));
                        afterMove(rec); paint();
                        await wait(650);
                        if (!V || V.rec !== rec) return;
                        if (rec.state.dice == null) continue; // three sixes
                    }
                    const ms = LU.movable(rec.state);
                    rec.state = ms.length ? LU.moveToken(rec.state, LU.pick(rec.state)) : LU.pass(rec.state);
                }
                afterMove(rec);
                paint();
            }
            if (V && V.rec.state.status !== 'active') celebrate(V.rec);
        } finally { if (V) V.botRunning = false; }
    }

    // ---------- Winning ----------
    function celebrate(rec) {
        if (!V || V.celebrated === rec.seq) return;
        V.celebrated = rec.seq;
        const line = statusLine(rec);
        const won = /^You won/.test(line);
        const box = document.createElement('div');
        box.className = 'bg-win';
        box.innerHTML = `<div class="bg-win-card"><span class="bg-win-art" aria-hidden="true">${won ? '🏆' : rec.state.winner || rec.state.status === 'resigned' ? KINDS[rec.kind].art : '🤝'}</span><strong>${esc(line)}</strong>
            <div class="bg-win-acts"><button type="button" class="primary-btn" data-bg="rematch">Play again</button><button type="button" class="ghost-btn" data-bg="dismiss">See the board</button></div></div>`;
        V.dlg.querySelector('.bg-card').append(box);
        if (won && window.diaryGamesFx && window.diaryGamesFx.confetti) window.diaryGamesFx.confetti(box);
    }

    // ---------- Clicks inside the game ----------
    async function onClick(e) {
        if (!V) return;
        const sq = e.target.closest('[data-sq]');
        if (sq) return chessTap(Number(sq.dataset.sq));
        const pr = e.target.closest('[data-promo]');
        if (pr && V.promo) { const m = V.promo.find(x => x.promo === pr.dataset.promo); if (m) chessPlay(m); return; }
        const tok = e.target.closest('[data-tok]');
        if (tok) return ludoMove(Number(tok.dataset.tok));
        const emo = e.target.closest('[data-bg-emoji]');
        if (emo) return chatSend(emo.dataset.bgEmoji);
        const b = e.target.closest('[data-bg]');
        if (!b) return;
        const act = b.dataset.bg;
        if (act === 'close') closeGame();
        else if (act === 'chat') toggleChat();
        else if (act === 'howto') howTo();
        else if (act === 'roll') ludoRoll();
        else if (act === 'dismiss') b.closest('.bg-win')?.remove();
        else if (act === 'rematch') rematch(V.rec);
        else if (act === 'menu') {
            const rec = V.rec;
            const active = rec.state.status === 'active';
            app.openPopover(b, [
                ...(rec.kind === 'ludo' ? [{ label: 'How to play', icon: 'i-play', onClick: () => howTo() }] : []),
                ...(rec.mode === 'friends' ? [{ label: 'Game chat', icon: 'i-chat', onClick: () => toggleChat(true) }] : []),
                ...(active ? [{ label: 'Resign', icon: 'i-flag', danger: true, onClick: () => resign(rec) }] : []),
                ...(rec.mode === 'friends' ? [{ label: 'Refresh from friends', icon: 'i-refresh', onClick: () => { const e2 = live.get(rec.id); if (e2 && e2.ch) e2.ch.send({ type: 'broadcast', event: 'hello', payload: { seq: rec.seq } }).catch(() => {}); app.showToast('Asked for the latest moves'); } }] : []),
                { label: 'Remove from this phone', icon: 'i-trash', onClick: async () => {
                    if (active && rec.mode === 'friends' && !(await app.ask({ title: 'Remove this game?', text: 'It disappears from this phone. Your friends keep their copy, and the chat card can bring it back.', ok: 'Remove' }))) return;
                    dropRec(rec.id); closeGame();
                } }
            ]);
        }
    }
    async function resign(rec) {
        if (!(await app.ask({ title: 'Resign this game?', text: 'The game ends and the win goes to the other side.', ok: 'Resign' }))) return;
        const idx = rec.players.indexOf(me());
        const winnerIdx = rec.kind === 'chess' ? 1 - idx : rec.players.findIndex((p, i) => i !== idx);
        rec.state = { ...rec.state, status: 'resigned', winnerIdx, winner: rec.kind === 'chess' ? (winnerIdx === 0 ? 'w' : 'b') : rec.state.colors[winnerIdx], reason: 'resignation' };
        afterMove(rec);
        paint();
        celebrate(rec);
    }

    // ======================================================================
    // Starting games
    // ======================================================================
    function create(kind, mode, players) {
        const rec = {
            id: uid(), kind, mode, players, seq: 0, created: Date.now(), updated: Date.now(),
            state: kind === 'chess' ? CH.init() : LU.init(players.length)
        };
        saveRec(rec);
        return rec;
    }
    async function rematch(rec) {
        const players = rec.kind === 'chess' ? [rec.players[1], rec.players[0]] : rec.players.slice(1).concat(rec.players[0]); // swap who starts
        const n = create(rec.kind, rec.mode, players);
        if (n.mode === 'friends') {
            const sent = await Promise.all(n.players.filter(p => p !== me()).map(p => postCard(n, p, 'invite')));
            if (sent.some(x => !x)) app.showToast('Couldn’t send the invite to everyone — check your connection');
        }
        openGame(n.id);
    }
    // Pick: friend(s) or the computer
    function newGame(kind, preset = null) {
        if (!me()) return app.showToast('Sign in to play with friends');
        const k = KINDS[kind];
        if (preset) return startWith(kind, [preset]);
        const friends = (s.friends || []).slice().sort((a, b) => String(a.display_name).localeCompare(String(b.display_name)));
        const dlg = document.createElement('dialog');
        dlg.className = 'gm wpm-pick bg-pick';
        dlg.setAttribute('aria-label', `New ${k.title} game`);
        dlg.innerHTML = `
            <form class="gm-card" method="dialog">
                <header class="gm-head">
                    <button type="button" class="icon-btn" data-x aria-label="Close">${ic('i-close')}</button>
                    <div class="gm-title"><strong>${ic(k.icon)}New ${esc(k.title)} game</strong><small>${kind === 'chess' ? 'Pick a friend, or play the computer' : 'Pick one to three friends, or play the computer'}</small></div>
                </header>
                <div class="gm-body wpm-pick-body">
                    <div class="bg-cpu-row">
                        <button type="button" class="bg-cpu-btn" data-cpu="1">${ic('i-sparkle')}<span><strong>Play the computer</strong><small>${kind === 'chess' ? 'You’re white' : 'You and one computer player'}</small></span></button>
                        ${kind === 'ludo' ? `<button type="button" class="bg-cpu-btn ht-open" data-howto>${ic('i-play')}<span><strong>Watch how to play</strong><small>A one-minute video</small></span></button>` : ''}
                        ${kind === 'ludo' ? '<button type="button" class="bg-cpu-btn" data-cpu="3"><span class="bg-cpu-n">4</span><span><strong>Four-player game</strong><small>You and three computer players</small></span></button>' : ''}
                    </div>
                    ${friends.length ? `<p class="wpm-sub">Or a friend${kind === 'ludo' ? ' (up to three)' : ''}</p>
                    ${friends.length > 8 ? '<input type="search" class="wpm-find" placeholder="Search friends" aria-label="Search friends">' : ''}
                    <div class="wpm-friends">${friends.map(f => `
                        <label class="wpm-friend" data-name="${esc(String(f.display_name || '').toLowerCase())} ${esc(String(f.username || '').toLowerCase())}">
                            <input type="checkbox" value="${esc(f.id)}">
                            ${I.avatar(f, 'sm')}
                            <span><strong>${esc(f.display_name || 'Friend')}</strong><small>@${esc(f.username || '')}</small></span>
                            <span class="wpm-check" aria-hidden="true">${ic('i-check')}</span>
                        </label>`).join('')}</div>` : '<p class="muted">Add friends to challenge them — or play the computer now.</p>'}
                </div>
                ${friends.length ? '<footer class="wpm-pick-foot"><button type="submit" class="primary-btn" disabled>Send the invite</button></footer>' : ''}
            </form>`;
        document.body.append(dlg);
        I.hydrateStorage && I.hydrateStorage(dlg);
        const btn = dlg.querySelector('[type="submit"]');
        const picked = () => [...dlg.querySelectorAll('input[type="checkbox"]:checked')].map(i => i.value);
        dlg.addEventListener('change', () => {
            const ids = picked();
            dlg.querySelectorAll('input[type="checkbox"]').forEach(i => { i.disabled = !i.checked && ids.length >= k.max; });
            if (btn) { btn.disabled = !ids.length; btn.textContent = ids.length ? (kind === 'chess' ? 'Send the challenge' : `Start a ${ids.length + 1}-player game`) : 'Send the invite'; }
        });
        dlg.addEventListener('input', e => {
            if (!e.target.classList.contains('wpm-find')) return;
            const q = e.target.value.trim().toLowerCase();
            dlg.querySelectorAll('.wpm-friend').forEach(l => { l.hidden = !!q && !l.dataset.name.includes(q); });
        });
        dlg.addEventListener('click', e => {
            if (e.target.closest('[data-x]')) return dlg.close();
            if (e.target.closest('[data-howto]')) { dlg.close(); return howTo(); }
            const cpu = e.target.closest('[data-cpu]');
            if (cpu) {
                dlg.close();
                const n = Number(cpu.dataset.cpu);
                const rec = create(kind, 'computer', [me(), ...Array.from({ length: n }, (_, i) => `cpu${i + 1}`)]);
                openGame(rec.id);
            }
        });
        dlg.addEventListener('close', () => dlg.remove());
        dlg.addEventListener('submit', async e => {
            e.preventDefault();
            btn.disabled = true;
            btn.textContent = 'Sending…';
            const ok = await startWith(kind, picked());
            if (ok) dlg.close(); else { btn.disabled = false; btn.textContent = 'Send the invite'; }
        });
        dlg.showModal();
    }
    async function startWith(kind, ids) {
        const rec = create(kind, 'friends', [me(), ...ids]);
        const sent = await Promise.all(ids.map(p => postCard(rec, p, 'invite')));
        if (sent.every(x => !x)) { dropRec(rec.id); app.showToast('Couldn’t send the invite — check your connection'); return false; }
        if (sent.some(x => !x)) app.showToast('Some invites didn’t send — the others can play');
        app.showToast(ids.length === 1 ? `Invite sent to ${first(ids[0])} — you can move first` : 'Invites sent — you go first');
        repaintLists();
        openGame(rec.id);
        return true;
    }

    // ======================================================================
    // Chat cards
    // ======================================================================
    function cardHTML(a, { mine } = {}) {
        if (a.game === 'mafia') return '<p class="muted">🎭 This game is no longer available</p>'; // invites from the removed Cordial Mafia
        const k = KINDS[a.game];
        if (!k) return '';
        const rec = getRec(a.id);
        const newest = rec && rec.seq > Number(a.seq || 0) ? rec : null;
        const cur = newest || { kind: a.game, players: a.players || [], state: a.state || {}, seq: a.seq };
        let line;
        try { line = cur.state && cur.state.status ? statusLine(cur) : ''; } catch (e) { line = ''; }
        const head = a.note === 'invite' ? (mine ? 'You sent an invite' : 'You’re invited to play') : a.note === 'over' ? 'Game over' : (mine ? 'Your move was sent' : 'It’s your move');
        const payload = esc(JSON.stringify({ id: a.id, kind: a.game, players: a.players, seq: a.seq, state: a.state, created: a.created, chat: a.chat || [] }));
        return `
            <div class="bgc bgc-${esc(a.game)}">
                <span class="bgc-art" aria-hidden="true">${k.art}</span>
                <span class="bgc-text"><small>${esc(head)}</small><strong>${esc(k.title)}</strong><span>${esc(line)}</span></span>
                <button type="button" class="bgc-play" data-action="bg-open" data-bg-card="${payload}">${cur.state && cur.state.status === 'active' ? 'Play' : 'Open'}</button>
            </div>`;
    }
    app.actions['bg-open'] = el => {
        let p = null;
        try { p = JSON.parse(el.dataset.bgCard || 'null'); } catch (e) { p = null; }
        if (!p) return;
        const rec = adopt(p) || getRec(p.id);
        if (!rec) return app.showToast('This game isn’t for you');
        openGame(rec.id);
    };

    // ======================================================================
    // On the Playnote page
    // ======================================================================
    function listHTML() {
        if (!me()) return '';
        const games = Object.values(all()).sort((a, b) => (myTurn(b) - myTurn(a)) || (b.updated - a.updated));
        const active = games.filter(g => g.state && g.state.status === 'active').slice(0, 8);
        return `
            <div class="pn-rail matches bg-rail" role="list">
                <button type="button" role="listitem" class="pn-match new bg-new" data-bg-new="chess"><span class="pn-new-ic bg-art">♞</span><strong>Chess</strong><small>A friend or the computer</small></button>
                <button type="button" role="listitem" class="pn-match new bg-new" data-bg-new="ludo"><span class="pn-new-ic bg-art">🎲</span><strong>Ludo</strong><small>Two to four players</small></button>
                ${active.map(g => {
                    const others = g.players.filter(p => p !== me());
                    return `<button type="button" role="listitem" class="pn-match${myTurn(g) ? ' mine' : ''}" data-bg-game="${esc(g.id)}" aria-label="${esc(KINDS[g.kind].title)} with ${esc(others.map(p => who(p).display_name || 'Someone').join(', '))} — ${esc(statusLine(g))}">
                        <span class="pn-avs">${others.slice(0, 3).map(p => (String(p).startsWith('cpu') ? `<span class="avatar sm bg-cpu" aria-hidden="true">${ic('i-sparkle')}</span>` : I.avatar(who(p), 'sm'))).join('')}</span>
                        <strong>${KINDS[g.kind].art} ${esc(KINDS[g.kind].title)}</strong>
                        <small>${esc(others.map(first).join(', '))}</small>
                        <span class="pn-match-status">${esc(statusLine(g))}</span>
                    </button>`;
                }).join('')}
            </div>`;
    }
    function waiting() { return Object.values(all()).filter(g => g.state && g.state.status === 'active' && myTurn(g)).length; }
    function repaintLists() { if (window.diaryPlay && window.diaryPlay.repaint) window.diaryPlay.repaint(); }
    document.addEventListener('click', e => {
        const n = e.target.closest('[data-bg-new]');
        if (n) { newGame(n.dataset.bgNew); return; }
        const g = e.target.closest('[data-bg-game]');
        if (g) openGame(g.dataset.bgGame);
    });

    // A little confetti helper the winner pop-up can use (no dependency on games.js internals)
    window.diaryGamesFx = window.diaryGamesFx || {
        confetti(host) {
            if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
            const colors = ['#f43f5e', '#f59e0b', '#10b981', '#3b82f6', '#a855f7'];
            for (let i = 0; i < 70; i++) {
                const p = document.createElement('i');
                p.className = 'bg-confetti';
                p.style.cssText = `left:${Math.random() * 100}%;background:${colors[i % colors.length]};animation-delay:${Math.random() * 0.4}s;--dx:${(Math.random() - 0.5) * 140}px;--r:${Math.random() * 720}deg`;
                host.append(p);
                setTimeout(() => p.remove(), 2600);
            }
        }
    };


    // ======================================================================
    // How to play Ludo: a short video, played on the real board — scenes with captions,
    // a progress bar, pause, skip, replay, and an optional narrator voice
    // ======================================================================
    const HT_SCENES = (() => {
        const base = () => LU.init(4);
        const put = (st, col, i, p) => { const n = { ...st, tokens: { ...st.tokens, [col]: st.tokens[col].slice() } }; n.tokens[col][i] = p; return n; };
        const at = (st, list) => list.reduce((x, [col, i, p]) => put(x, col, i, p), st);
        const walk = (col, i, from, to, start, gap = 260) => Array.from({ length: to - from }, (_, k) => ({ at: start + k * gap, fn: st => put(st, col, i, from + k + 1) }));
        const yardMid = col => { const [r, c] = LU.YARD[col]; return [r + 3, c + 3]; };
        const sq = (col, p) => LU.spot(col, p, 0);
        return [
            { title: 'Four tokens each', say: 'Each player has four tokens waiting in their yard. Two to four people can play, or you can play the computer.', dur: 6200,
                start: base, steps: [
                    { at: 400, ring: yardMid('red'), big: true }, { at: 1700, ring: yardMid('green'), big: true },
                    { at: 3000, ring: yardMid('yellow'), big: true }, { at: 4300, ring: yardMid('blue'), big: true }] },
            { title: 'Roll a 6 to come out', say: 'You need a six to bring a token out of the yard onto your start square.', dur: 7000,
                start: base, steps: [
                    { at: 500, dice: 3 }, { at: 1500, pop: 'No 6 — stay in the yard' },
                    { at: 3000, dice: 6, pop: '' }, { at: 3700, glow: ['red', 0] },
                    { at: 4500, fn: st => put(st, 'red', 0, 0), glow: null, ring: sq('red', 0) }, { at: 5600, pop: 'Out onto the start square!' }] },
            { title: 'Move by the dice', say: 'Tap a glowing token to move it as many squares as the dice shows. Everyone moves clockwise around the board.', dur: 7000,
                start: () => at(base(), [['red', 0, 0]]), steps: [
                    { at: 500, dice: 4 }, { at: 1200, glow: ['red', 0] },
                    ...walk('red', 0, 0, 4, 2000), { at: 3100, glow: null, ring: sq('red', 4) }] },
            { title: 'A 6 means roll again', say: 'Roll a six and you get another turn. But three sixes in a row ends your turn.', dur: 7200,
                start: () => at(base(), [['red', 0, 4]]), steps: [
                    { at: 500, dice: 6 }, { at: 1100, glow: ['red', 0] },
                    ...walk('red', 0, 4, 10, 1700, 230), { at: 3200, glow: null, dice: null, pop: 'Roll again!' }] },
            { title: 'Capture', say: 'Land on another player’s token to send it back to their yard. Capturing earns you an extra turn.', dur: 7600,
                start: () => at(base(), [['red', 0, 10], ['yellow', 0, 38]]), steps: [
                    { at: 500, ring: sq('yellow', 38) }, { at: 1400, dice: 2 }, { at: 2000, glow: ['red', 0] },
                    ...walk('red', 0, 10, 12, 2700, 320), { at: 3500, glow: null, fn: st => put(st, 'yellow', 0, -1), pop: 'Captured! Back to the yard' },
                    { at: 4300, ring: yardMid('yellow'), big: true }] },
            { title: 'Stars are safe', say: 'Stars and start squares are safe. A token standing there can’t be captured.', dur: 7600,
                start: () => at(base(), [['red', 0, 16], ['yellow', 0, 47]]), steps: [
                    { at: 400, ring: sq('yellow', 47) }, { at: 1300, dice: 5 }, { at: 1900, glow: ['red', 0] },
                    ...walk('red', 0, 16, 21, 2600, 260), { at: 4000, glow: null, pop: 'Both safe on the star ★' }] },
            { title: 'Head for home', say: 'After one lap, turn into your coloured lane. You need the exact number to reach home.', dur: 10500,
                start: () => at(base(), [['red', 0, 47]]), steps: [
                    { at: 500, dice: 6 }, { at: 1100, glow: ['red', 0] }, ...walk('red', 0, 47, 53, 1700, 250),
                    { at: 3300, glow: null, ring: sq('red', 53), pop: 'Into your lane' },
                    { at: 4800, dice: 5, pop: '' }, { at: 5600, pop: 'Too far — needs exactly 3' },
                    { at: 7000, dice: 3, pop: '' }, { at: 7500, glow: ['red', 0] }, ...walk('red', 0, 53, 56, 8100, 300),
                    { at: 9200, glow: null, pop: 'Home!' }] },
            { title: 'Win the game', say: 'Get all four of your tokens home first, and you win. Have fun!', dur: 6500,
                start: () => at(base(), [['red', 0, 56], ['red', 1, 56], ['red', 2, 56], ['red', 3, 55], ['green', 0, 30], ['yellow', 1, 12], ['blue', 2, 40]]), steps: [
                    { at: 600, dice: 1 }, { at: 1200, glow: ['red', 3] }, { at: 2000, glow: null, fn: st => put(st, 'red', 3, 56) },
                    { at: 2600, pop: 'Red wins! 🏆', confetti: true }] }
        ];
    })();

    let HT = null; // { dlg, i, t, playing, applied, st, raf, last, sound }
    function howTo() {
        htClose();
        const dlg = document.createElement('dialog');
        dlg.className = 'gm bg howto';
        dlg.setAttribute('aria-label', 'How to play Ludo');
        let sound = false;
        try { sound = localStorage.getItem('cordialLudoVoice') === '1'; } catch (e) { /* private mode */ }
        dlg.innerHTML = `
            <div class="gm-card bg-card bg-ludo ht-card">
                <header class="gm-head">
                    <button type="button" class="icon-btn" data-ht="close" aria-label="Close">${ic('i-close')}</button>
                    <div class="gm-title"><strong>${ic('i-play')}How to play Ludo</strong><small>A one-minute video</small></div>
                    ${'speechSynthesis' in window ? `<button type="button" class="icon-btn ht-sound" data-ht="sound" aria-pressed="${sound}" aria-label="Narration">${ic(sound ? 'i-volume' : 'i-volume-off')}</button>` : ''}
                </header>
                <div class="ht-bar" role="tablist" aria-label="Scenes">${HT_SCENES.map((sc, i) => `<button type="button" class="ht-seg" data-ht-seg="${i}" role="tab" aria-label="${esc(sc.title)}"><i></i></button>`).join('')}</div>
                <div class="bg-stage ht-stage"></div>
                <div class="ht-cap"><div class="ht-cap-text" aria-live="polite"><small class="ht-n"></small><span class="ht-pop" hidden></span><strong class="ht-title"></strong><p class="ht-say"></p></div><div class="ht-dice" aria-hidden="true"></div></div>
                <div class="ht-ctl">
                    <button type="button" class="icon-btn" data-ht="prev" aria-label="Previous scene">${ic('i-back')}</button>
                    <button type="button" class="ht-play" data-ht="toggle" aria-label="Pause">${ic('i-pause')}</button>
                    <button type="button" class="icon-btn" data-ht="next" aria-label="Next scene">${ic('i-forward')}</button>
                </div>
            </div>`;
        document.body.append(dlg);
        HT = { dlg, i: 0, t: 0, playing: true, applied: 0, st: null, raf: 0, last: 0, sound };
        dlg.addEventListener('close', () => { htStop(); dlg.remove(); if (HT && HT.dlg === dlg) HT = null; });
        dlg.addEventListener('click', e => {
            const seg = e.target.closest('[data-ht-seg]');
            if (seg) return htScene(Number(seg.dataset.htSeg));
            const b = e.target.closest('[data-ht]');
            if (!b) return;
            const a = b.dataset.ht;
            if (a === 'close') dlg.close();
            else if (a === 'toggle') htToggle();
            else if (a === 'prev') htScene(Math.max(0, HT.t > 1500 ? HT.i : HT.i - 1));
            else if (a === 'next') { if (HT.i < HT_SCENES.length - 1) htScene(HT.i + 1); }
            else if (a === 'replay') htScene(0);
            else if (a === 'play-now') { dlg.close(); newGame('ludo'); }
            else if (a === 'sound') {
                HT.sound = !HT.sound;
                try { localStorage.setItem('cordialLudoVoice', HT.sound ? '1' : '0'); } catch (e2) { /* private mode */ }
                b.setAttribute('aria-pressed', String(HT.sound));
                b.innerHTML = ic(HT.sound ? 'i-volume' : 'i-volume-off');
                if (HT.sound && HT.playing) htSay(HT_SCENES[HT.i].say); else speechSynthesis.cancel();
            }
        });
        dlg.addEventListener('keydown', e => {
            if (e.target.closest('input, textarea')) return;
            if (e.key === ' ' || e.key === 'k') { e.preventDefault(); htToggle(); }
            else if (e.key === 'ArrowRight' && HT.i < HT_SCENES.length - 1) htScene(HT.i + 1);
            else if (e.key === 'ArrowLeft') htScene(Math.max(0, HT.i - 1));
        });
        dlg.showModal();
        if (matchMedia('(prefers-reduced-motion: reduce)').matches) dlg.classList.add('calm');
        htScene(0);
    }
    function htClose() { if (HT && HT.dlg.open) HT.dlg.close(); }
    function htStop() { if (HT) cancelAnimationFrame(HT.raf); try { speechSynthesis.cancel(); } catch (e) { /* not supported */ } }
    function htSay(text) {
        if (!HT || !HT.sound || !('speechSynthesis' in window)) return;
        try {
            speechSynthesis.cancel();
            const u = new SpeechSynthesisUtterance(text);
            u.rate = 1.02;
            speechSynthesis.speak(u);
        } catch (e) { /* no voice */ }
    }
    function htScene(i) {
        if (!HT) return;
        const sc = HT_SCENES[i];
        HT.i = i; HT.t = 0; HT.applied = 0; HT.st = sc.start(); HT.ended = false;
        const stage = HT.dlg.querySelector('.ht-stage');
        stage.innerHTML = ludoBoard(HT.st, new Set(), '<i class="ht-ring" hidden></i>');
        const pop0 = HT.dlg.querySelector('.ht-pop'); pop0.hidden = true; pop0.textContent = '';
        HT.dlg.querySelector('.ht-dice').innerHTML = dieHTML(null);
        HT.dlg.querySelector('.ht-n').textContent = `${i + 1} of ${HT_SCENES.length}`;
        HT.dlg.querySelector('.ht-title').textContent = sc.title;
        HT.dlg.querySelector('.ht-say').textContent = sc.say;
        HT.dlg.querySelectorAll('.ht-seg').forEach((b, k) => {
            b.classList.toggle('done', k < i);
            b.classList.toggle('on', k === i);
            b.setAttribute('aria-selected', String(k === i));
            b.querySelector('i').style.transform = `scaleX(${k < i ? 1 : 0})`;
        });
        if (!HT.playing) htSetPlaying(true);
        else { htSay(sc.say); htLoop(); }
    }
    function htSetPlaying(on) {
        HT.playing = on;
        const b = HT.dlg.querySelector('.ht-play');
        b.innerHTML = ic(on ? 'i-pause' : 'i-play');
        b.setAttribute('aria-label', on ? 'Pause' : 'Play');
        try {
            if (on) { if (speechSynthesis.paused) speechSynthesis.resume(); else if (HT.t < 300) htSay(HT_SCENES[HT.i].say); }
            else speechSynthesis.pause();
        } catch (e) { /* not supported */ }
        if (on) htLoop(); else cancelAnimationFrame(HT.raf);
    }
    function htToggle() {
        if (!HT) return;
        if (HT.ended) return htScene(0);
        htSetPlaying(!HT.playing);
    }
    function htLoop() {
        cancelAnimationFrame(HT.raf);
        HT.last = performance.now();
        const tick = now => {
            if (!HT || !HT.playing) return;
            HT.t += Math.min(100, now - HT.last);
            HT.last = now;
            const sc = HT_SCENES[HT.i];
            while (HT.applied < sc.steps.length && sc.steps[HT.applied].at <= HT.t) htStep(sc.steps[HT.applied++]);
            const seg = HT.dlg.querySelectorAll('.ht-seg i')[HT.i];
            if (seg) seg.style.transform = `scaleX(${Math.min(1, HT.t / sc.dur)})`;
            if (HT.t >= sc.dur) {
                if (HT.i < HT_SCENES.length - 1) return htScene(HT.i + 1);
                return htEnd();
            }
            HT.raf = requestAnimationFrame(tick);
        };
        HT.raf = requestAnimationFrame(tick);
    }
    function htStep(step) {
        const stage = HT.dlg.querySelector('.ht-stage');
        if (step.fn) { HT.st = step.fn(HT.st); htTokens(stage); }
        if ('dice' in step) HT.dlg.querySelector('.ht-dice').innerHTML = dieHTML(step.dice, step.dice != null && !HT.dlg.classList.contains('calm'));
        if ('glow' in step) stage.querySelectorAll('.lb-tok').forEach(t => t.classList.toggle('can', !!step.glow && t.dataset.tk === step.glow[0] + step.glow[1]));
        if (step.ring) {
            const ring = stage.querySelector('.ht-ring');
            ring.hidden = false;
            ring.classList.toggle('big', !!step.big);
            ring.style.top = `${(step.ring[0] / 15) * 100}%`;
            ring.style.left = `${(step.ring[1] / 15) * 100}%`;
            ring.classList.remove('go'); void ring.offsetWidth; ring.classList.add('go');
        }
        if ('pop' in step) {
            const pop = HT.dlg.querySelector('.ht-pop');
            pop.hidden = !step.pop;
            pop.textContent = step.pop || '';
            pop.classList.remove('go'); void pop.offsetWidth; pop.classList.add('go');
        }
        if (step.confetti && window.diaryGamesFx) window.diaryGamesFx.confetti(stage);
    }
    // Move the existing token buttons (so they glide) instead of redrawing the board
    function htTokens(stage) {
        const seen = new Map();
        HT.st.colors.forEach(col => HT.st.tokens[col].forEach((p, i) => {
            const el = stage.querySelector(`[data-tk="${col}${i}"]`);
            if (!el) return;
            const [y, x] = LU.spot(col, p, i);
            const key = p === -1 || p === 56 ? `${col}${i}${p}` : `${y},${x}`;
            const n = seen.get(key) || 0;
            seen.set(key, n + 1);
            el.style.top = `${(y / 15) * 100}%`;
            el.style.left = `${(x / 15) * 100}%`;
            el.style.setProperty('--n', n);
        }));
    }
    function htEnd() {
        HT.playing = false;
        HT.ended = true;
        const b = HT.dlg.querySelector('.ht-play');
        b.innerHTML = ic('i-play');
        b.setAttribute('aria-label', 'Watch again');
        const end = document.createElement('div');
        end.className = 'ht-end';
        end.innerHTML = '<strong>That’s Ludo!</strong><span>Ready for a game?</span><div><button type="button" class="primary-btn" data-ht="play-now">Play now</button><button type="button" class="ghost-btn" data-ht="replay">Watch again</button></div>';
        HT.dlg.querySelector('.ht-stage').append(end);
    }

    window.diaryBoardGames = { KINDS, newGame, openGame, howTo, cardHTML, listHTML, waiting, preview: a => a.game === 'mafia' ? '🎭 Game no longer available' : `${(KINDS[a.game] || {}).art || '🎲'} ${(KINDS[a.game] || {}).title || 'Game'}${a.note === 'invite' ? ' — invite' : a.note === 'over' ? ' — game over' : ' — your move'}`, _engines: { CH, LU } };
});
