// Spaces: live audio rooms, like Clubhouse. Anyone can host rooms (up to 20 each) and open any of them live.
// A room has a stage (host, co-hosts, speakers) and an audience. Listeners never need a microphone: they
// only receive audio. Speakers send their voice to everyone in the room, directly browser-to-browser
// (the database — diary_space_* functions — decides who is allowed on stage).
document.addEventListener('DOMContentLoaded', () => {
    const app = window.diaryApp;
    const social = window.diarySocial;
    if (!app || !social || !social.internals) return;
    const I = social.internals;
    const { client, state: s, esc, avatar } = I;
    if (!client) return;
    const cfg = window.DIARY_CONFIG || {};
    const ICE = cfg.iceServers || [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }];
    const content = document.getElementById('content');
    const ic = id => `<svg class="i"><use href="#${id}"/></svg>`;
    const me = () => (s.profile && s.profile.id) || null;
    const first = name => esc(String(name || 'Someone').split(' ')[0]);

    const THEMES = [['violet', 'Violet'], ['sunset', 'Sunset'], ['ocean', 'Ocean'], ['forest', 'Forest'], ['night', 'Night']];
    // Categories for rooms: the chips along the top of Spaces filter by them
    const CATS = [['entertainment', '🎬'], ['sports', '⚽'], ['politics', '🏛️'], ['tech', '💻'], ['music', '🎵'], ['faith', '🙏'],
        ['business', '💼'], ['lifestyle', '🌿'], ['education', '📚'], ['comedy', '😂']];
    const L = { live: [], upcoming: [], mine: [], loaded: false, loading: false, tab: 'foryou' };

    // ---------- Lists ----------
    async function load() {
        if (L.loading || !me()) return;
        L.loading = true;
        const { data, error } = await client.rpc('diary_spaces_list');
        L.loading = false;
        if (error) return;
        L.live = data.live || [];
        L.upcoming = data.upcoming || [];
        L.mine = data.mine || [];
        L.loaded = true;
        if (['spaces', 'explore', 'feed'].includes(app.state.view)) app.render();
    }
    setInterval(() => { if (!document.hidden && ['spaces', 'explore', 'feed'].includes(app.state.view)) load(); }, 30000);

    function whenText(iso) {
        const d = new Date(iso);
        const today = new Date();
        const tomorrow = new Date(Date.now() + 86400000);
        const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
        if (d.toDateString() === today.toDateString()) return `today, ${time}`;
        if (d.toDateString() === tomorrow.toDateString()) return `tomorrow, ${time}`;
        return `${d.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' }).toLowerCase()}, ${time}`;
    }

    const catOf = x => {
        const t = String(x.topic || '').toLowerCase().trim();
        return t ? CATS.find(([k]) => t === k || t.includes(k)) || null : null;
    };

    // The cluster of faces on a card: the host big in the middle, the stage around it, "+N" for everyone else
    function cluster(x) {
        const people = [{ id: x.host, ...(x.host_profile || {}) }, ...(x.stage || []).filter(p => p.id !== x.host)];
        const shown = people.slice(0, 5);
        const extra = Math.max(Number(x.listening || 0), people.length) - shown.length;
        return `<span class="cl-faces n${shown.length}" aria-hidden="true">${shown.map((p, i) => `<span class="cl-face f${i}">${avatar(p, 'lg')}</span>`).join('')}${extra > 0 ? `<span class="cl-more">+${extra}</span>` : ''}</span>`;
    }

    function card(x, opts = {}) {
        const p = x.host_profile || {};
        const cat = catOf(x);
        const here = R && R.id === x.id;
        const id = esc(x.id);
        const who = x.mine ? 'You' : esc(p.display_name || 'Someone');
        const club = `${who}${cat ? ` · ${cat[0]}` : x.topic ? ` · ${esc(String(x.topic).toLowerCase())}` : ''}`;
        const inRoom = here ? R.people.size : 0;
        return `
            <article class="cl-card${here ? ' here' : ''}${x.live ? '' : ' off'}">
                <button type="button" class="cl-hit" data-action="space-open" data-id="${id}" aria-label="${esc(x.title)}${x.live ? ' — join' : ''}"></button>
                <div class="cl-main">
                    <div class="cl-club">
                        <span class="cl-club-ic" aria-hidden="true">${cat ? cat[1] : avatar({ id: x.host, ...p }, 'sm')}</span>
                        <span class="cl-club-name">${club}</span>
                        ${x.visibility === 'circle' ? `<span class="cl-lock" title="Friends and followers only">${ic('i-lock')}</span>` : ''}
                    </div>
                    <strong class="cl-title">${esc(x.title)}</strong>
                    ${!x.live ? `<span class="cl-when">${ic('i-calendar')}${x.scheduled_for ? esc(whenText(x.scheduled_for)) : 'not live right now'}</span>` : ''}
                    ${here ? `<div class="cl-speaking">${avatar({ id: me(), ...s.profile }, 'sm')}<span>You’re in this room · ${inRoom} ${inRoom === 1 ? 'person' : 'people'} here</span></div>` : ''}
                </div>
                ${here ? `
                    <div class="cl-now">
                        <button type="button" class="cl-pill" data-action="space-mute" aria-pressed="${!!R.deaf}">${R.deaf ? 'unmute' : 'mute'}${ic(R.deaf ? 'i-volume-off' : 'i-volume')}</button>
                        <button type="button" class="cl-pill join" data-action="space-open" data-id="${id}">open${ic('i-arrow-right')}</button>
                    </div>` : cluster(x)}
                ${opts.manage ? `
                    <div class="cl-manage">
                        <button type="button" class="cl-pill join" data-action="space-open" data-id="${id}">${ic('i-mic')}${x.live ? 'rejoin' : 'go live'}</button>
                        <button type="button" class="cl-pill" data-action="space-edit" data-id="${id}">${ic('i-pencil')}edit</button>
                        <button type="button" class="cl-pill" data-action="space-share" data-id="${id}">${ic('i-share')}share</button>
                        <button type="button" class="cl-pill danger" data-action="space-delete" data-id="${id}" aria-label="Delete room">${ic('i-trash')}</button>
                    </div>` : ''}
            </article>`;
    }

    // The room you're in always comes first
    const hereFirst = list => (R ? [...list].sort((a, b) => (b.id === R.id) - (a.id === R.id)) : list);

    // ---------- Explore ----------
    function exploreSection() {
        if (!me()) return '';
        if (!L.loaded) load();
        const list = hereFirst(L.live).slice(0, 3);
        const soon = list.length ? [] : L.upcoming.slice(0, 2);
        return `
            <section class="ex-sec" aria-labelledby="sp-ex-h">
                <header class="ex-head"><h3 id="sp-ex-h"><span class="ex-ic">${ic('i-headphones')}</span>Spaces</h3>
                    <p>${L.live.length ? `${L.live.length} live audio ${L.live.length === 1 ? 'room' : 'rooms'} right now` : 'Live audio rooms — drop in and listen, or host your own'}</p>
                    <button type="button" class="link-btn accent ex-more" data-action="go-spaces">See all</button></header>
                <div class="cl-list">
                    ${[...list, ...soon].map(x => card(x)).join('')}
                    <button type="button" class="cl-host inline" data-action="space-new">${ic('i-plus')}host a room</button>
                </div>
            </section>`;
    }

    // ---------- The Feed: live audio rooms as a row of bubbles (only when some are live) ----------
    function feedStrip() {
        if (!me()) return '';
        if (!L.loaded) { load(); return ''; }
        const live = hereFirst(L.live).slice(0, 12);
        if (!live.length) return '';
        return `
            <section class="sp-feed" aria-label="Live audio rooms">
                <p class="sp-feed-h"><span class="sp-live"><i aria-hidden="true"></i>LIVE</span>Join a live audio room</p>
                <div class="sp-feed-row">
                    ${live.map(x => {
                        const p = { id: x.host, ...(x.host_profile || {}) };
                        const n = Math.max(Number(x.listening || 0), 1);
                        return `
                        <button type="button" class="sp-bubble theme-${esc(x.theme || 'violet')}${R && R.id === x.id ? ' here' : ''}" data-action="space-open" data-id="${esc(x.id)}" aria-label="${esc(x.title)} — ${n} listening">
                            <span class="sp-bubble-ring">${avatar(p, 'lg')}<span class="sp-bubble-n">${n > 999 ? `${(n / 1000).toFixed(1)}K` : n}</span></span>
                            <span class="sp-bubble-t">${esc(x.title)}</span>
                        </button>`;
                    }).join('')}
                </div>
            </section>`;
    }

    // ---------- The Spaces page ----------
    app.views.spaces = () => {
        app.setTitle('Spaces');
        const blocked = I.gate('Host live audio rooms and listen in on conversations from your circle.');
        if (blocked) return blocked;
        if (!L.loaded) load();
        const chips = [['foryou', `${ic('i-sparkle')}for you`], ...CATS.map(([k]) => [k, k]), ['upcoming', `${ic('i-calendar')}upcoming`], ['mine', 'my rooms']];
        const tab = L.tab;
        const inCat = x => { const c = catOf(x); return !!c && c[0] === tab; };
        const list = tab === 'foryou' ? hereFirst(L.live)
            : tab === 'upcoming' ? L.upcoming
            : tab === 'mine' ? L.mine
            : [...hereFirst(L.live.filter(inCat)), ...L.upcoming.filter(inCat)];
        const empty = tab === 'foryou' ? ['Nobody’s live right now', 'Host a room and your friends and followers get a heads-up.']
            : tab === 'upcoming' ? ['Nothing scheduled', 'Hosts can schedule a room so people know when to tune in.']
            : tab === 'mine' ? ['You haven’t made a room yet', 'Make as many as you like — a weekly show, a study room, a late-night chat.']
            : [`No ${tab} rooms right now`, `Start one and pick “${tab}” as its topic.`];
        return `
            <div class="spaces cl">
                <nav class="cl-chips" aria-label="Topics">
                    ${chips.map(([k, l]) => `<button type="button" class="cl-chip" aria-pressed="${tab === k}" data-action="space-tab" data-tab="${k}">${l}</button>`).join('')}
                </nav>
                ${!L.loaded ? '<p class="muted sp-loading">Loading rooms…</p>'
                    : list.length ? `<div class="cl-list">${list.map(x => card(x, { manage: tab === 'mine' })).join('')}</div>`
                    : `<div class="cl-empty"><span class="cl-empty-ic">${ic('i-headphones')}</span><strong>${empty[0]}</strong><span>${empty[1]}</span></div>`}
                ${tab === 'foryou' && L.loaded && L.upcoming.length ? `<h3 class="cl-sub">coming up</h3><div class="cl-list">${L.upcoming.slice(0, 4).map(x => card(x)).join('')}</div>` : ''}
                <button type="button" class="cl-host" data-action="space-new">${ic('i-plus')}host a room</button>
            </div>`;
    };

    // ---------- Create / edit a room ----------
    let editDlg = null;
    function editor(x) {
        if (!editDlg) {
            editDlg = document.createElement('dialog');
            editDlg.className = 'ask sp-edit';
            editDlg.setAttribute('aria-labelledby', 'sp-edit-h');
            document.body.append(editDlg);
        }
        const local = iso => { if (!iso) return ''; const d = new Date(iso); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 16); };
        const v = x || { theme: 'violet', visibility: 'public' };
        editDlg.innerHTML = `
            <form method="dialog" class="sp-edit-form" novalidate>
                <h3 id="sp-edit-h">${x ? 'Edit room' : 'Start a space'}</h3>
                <div class="sp-edit-preview theme-${esc(v.theme)}" aria-hidden="true">${ic('i-headphones')}</div>
                <label class="field"><span>Room name</span><input name="title" maxlength="80" required autocomplete="off" placeholder="e.g. Sunday night vibes" value="${esc(v.title || '')}"></label>
                <label class="field"><span>What’s it about? <small>(optional)</small></span><textarea name="about" maxlength="300" rows="2" placeholder="Tell people what you’ll talk about">${esc(v.about || '')}</textarea></label>
                <label class="field"><span>Topic <small>(helps people find it)</small></span><input name="topic" maxlength="30" autocomplete="off" list="sp-cats" placeholder="e.g. music, sports, tech" value="${esc(v.topic || '')}"></label>
                <datalist id="sp-cats">${CATS.map(([k]) => `<option value="${k}">`).join('')}</datalist>
                <div class="field"><span>Look</span>
                    <div class="sp-themes" role="radiogroup" aria-label="Colour">${THEMES.map(([k, l]) => `
                        <label class="sp-theme theme-${k}"><input type="radio" name="theme" value="${k}"${v.theme === k ? ' checked' : ''}><span class="sr-only">${l}</span></label>`).join('')}
                    </div>
                </div>
                <div class="vis-choice" role="radiogroup" aria-label="Who can join">
                    <label><input type="radio" name="visibility" value="public"${v.visibility !== 'circle' ? ' checked' : ''}><span><strong>🌐 Everyone</strong><small>Anyone on Cordial can find and join</small></span></label>
                    <label><input type="radio" name="visibility" value="circle"${v.visibility === 'circle' ? ' checked' : ''}><span><strong>🔒 My circle</strong><small>Only friends and followers</small></span></label>
                </div>
                <label class="field"><span>Schedule it <small>(optional)</small></span><input type="datetime-local" name="when" value="${local(v.scheduled_for)}"></label>
                <p class="auth-message error sp-edit-err" hidden></p>
                <div class="ask-actions">
                    <button type="button" class="ghost-btn" value="cancel">Cancel</button>
                    ${x ? '' : '<button type="button" class="ghost-btn" value="save">Save for later</button>'}
                    <button type="button" class="primary-btn" value="${x ? 'save' : 'live'}">${x ? 'Save' : 'Go live now'}</button>
                </div>
            </form>`;
        const form = editDlg.querySelector('form');
        form.addEventListener('change', e => {
            if (e.target.name === 'theme') editDlg.querySelector('.sp-edit-preview').className = `sp-edit-preview theme-${e.target.value}`;
        });
        return new Promise(resolve => {
            let busy = false;
            form.querySelectorAll('.ask-actions button').forEach(b => b.addEventListener('click', async () => {
                if (b.value === 'cancel') { editDlg.close(); return resolve(null); }
                if (busy) return;
                const fd = new FormData(form);
                const title = String(fd.get('title') || '').trim();
                const err = form.querySelector('.sp-edit-err');
                if (!title) { err.textContent = 'Give your room a name.'; err.hidden = false; form.elements.title.focus(); return; }
                const when = fd.get('when') ? new Date(fd.get('when')).toISOString() : null;
                busy = true;
                const { data, error } = await client.rpc('diary_space_save', {
                    p_id: x ? x.id : null, p_title: title, p_about: fd.get('about') || '', p_topic: fd.get('topic') || '',
                    p_visibility: fd.get('visibility'), p_theme: fd.get('theme'), p_scheduled_for: when
                });
                busy = false;
                if (error) { err.textContent = error.message || 'Couldn’t save the room'; err.hidden = false; return; }
                editDlg.close();
                resolve({ id: data, live: b.value === 'live' });
            }));
            editDlg.addEventListener('cancel', () => resolve(null), { once: true });
            editDlg.showModal();
            setTimeout(() => form.elements.title.focus(), 50);
        });
    }

    const findRoom = id => [...L.live, ...L.upcoming, ...L.mine].find(x => x.id === id);
    const roomLink = id => `${location.origin}${location.pathname}?space=${encodeURIComponent(id)}`;

    Object.assign(app.actions, {
        'go-spaces': () => app.setView('spaces'),
        'space-tab': el => { L.tab = el.dataset.tab; app.render(); },
        'space-new': async () => {
            if (I.isGuest && I.isGuest()) return I.openUpgrade && I.openUpgrade();
            const r = await editor(null);
            if (!r) return;
            await load();
            if (r.live) enter(r.id);
            else { L.tab = 'mine'; app.setView('spaces'); app.showToast('Room saved — open it whenever you’re ready'); }
        },
        'space-edit': async el => {
            const x = findRoom(el.dataset.id);
            if (!x) return;
            if (await editor(x)) { await load(); app.showToast('Room updated'); }
        },
        'space-delete': async el => {
            const x = findRoom(el.dataset.id);
            if (!x) return;
            if (!(await app.ask({ title: `Delete “${x.title}”?`, text: 'The room and its settings are removed for good.', ok: 'Delete', danger: true }))) return;
            if (R && R.id === x.id) await leave(true);
            const { error } = await client.rpc('diary_space_delete', { p_id: x.id });
            if (error) return app.showToast(error.message);
            await load();
            app.showToast('Room deleted');
        },
        'space-share': el => share(el.dataset.id),
        'space-open': el => enter(el.dataset.id),
        'space-mute': () => {
            if (!R) return;
            R.deaf = !R.deaf;
            for (const [, p] of R.peers) if (p.audio) p.audio.muted = R.deaf;
            app.showToast(R.deaf ? 'Room sound off' : 'Room sound on');
            app.render();
        }
    });

    async function share(id) {
        const x = findRoom(id) || (R && R.id === id ? R.info : null);
        const link = roomLink(id);
        if (navigator.share) {
            try { await navigator.share({ title: x ? x.title : 'Join my space on Cordial', text: x ? `Join “${x.title}” on Cordial` : 'Join me on Cordial', url: link }); return; }
            catch (e) { if (e && e.name === 'AbortError') return; }
        }
        try { await navigator.clipboard.writeText(link); app.showToast('Room link copied'); }
        catch (e) { app.ask({ title: 'Room link', text: 'Copy this link and share it:', value: link, ok: 'Done' }); }
    }

    // ---------- The room ----------
    let R = null; // { id, info, role, roles, channel, ready, sess, people, peers, mic, muted, hand, ping, audioCtx, meters, speaking, minimised }
    const room = document.createElement('section');
    room.className = 'sp-room';
    room.id = 'sp-room';
    room.hidden = true;
    room.setAttribute('role', 'dialog');
    room.setAttribute('aria-label', 'Space');
    const mini = document.createElement('div');
    mini.className = 'sp-mini';
    mini.hidden = true;
    document.body.append(room, mini);

    const roleOf = id => !R ? 'listener' : id === R.info.host ? 'host' : (R.roles[id] || 'listener');
    const onStage = id => roleOf(id) !== 'listener';
    const isHost = () => ['host', 'cohost'].includes(roleOf(me()));

    async function fetchState(id, ping) {
        const { data, error } = await client.rpc('diary_space_state', { p_id: id, p_ping: !!ping });
        if (error) throw error;
        return data;
    }

    async function enter(id) {
        if (!me()) return I.openAuth && I.openAuth('Sign in to join live audio rooms.', 'signin');
        if (R && R.id === id) return expand();
        if (R) await leave(true);
        let st;
        try { st = await fetchState(id, false); } catch (e) { return app.showToast('Couldn’t open that room — check your connection'); }
        if (st.banned) return app.showToast('You were removed from this room');
        if (st.gone) return app.showToast('That room isn’t available any more');
        if (!st.live) {
            if (!st.mine) return app.showToast(st.scheduled_for ? `This room starts ${whenText(st.scheduled_for).toLowerCase()}` : 'This room isn’t live right now');
            const { data, error } = await client.rpc('diary_space_open', { p_id: id });
            if (error) return app.showToast(error.message);
            st = { ...st, ...data, live: true };
        }
        R = {
            id, info: st, roles: st.roles || {}, sess: Math.random().toString(36).slice(2, 10),
            channel: null, ready: false, people: new Map(), peers: new Map(), mic: null, muted: true, hand: false,
            ping: null, audioCtx: null, meters: new Map(), speaking: new Set(), minimised: false, reconnects: 0, meterTimer: null,
            handAt: 0, joinedAt: 0, invite: null, chat: [], unread: 0, chatOpen: false, reply: null, snap: 'collapsed', reactsOpen: false, psheet: null
        };
        openChannel();
        R.ping = setInterval(heartbeat, 20000);
        heartbeat();
        R.meterTimer = setInterval(measure, 250);
        expand();
        if (['spaces', 'explore', 'feed'].includes(app.state.view)) app.render();
        if (roleOf(me()) === 'host') app.showToast('You’re live — tap the mic to talk');
        load();
    }

    async function heartbeat() {
        const c = R;
        if (!c) return;
        let st;
        try { st = await fetchState(c.id, true); } catch (e) { return; }
        if (R !== c) return;
        if (st.banned) { app.showToast('You were removed from the room'); return leave(false); }
        if (st.gone || !st.live) { app.showToast('The room has ended'); return leave(false); }
        const wasSpeaker = onStage(me());
        c.info = st;
        c.roles = st.roles || {};
        const nowSpeaker = onStage(me());
        if (wasSpeaker && !nowSpeaker) demoted();
        if (!wasSpeaker && nowSpeaker) promoted();
        syncPeers();
        paint();
    }

    function myMeta() {
        const p = s.profile || {};
        return { name: p.display_name || 'Someone', username: p.username || '', avatar_path: p.avatar_path || null, hand: R.hand, handAt: R.hand ? R.handAt : 0, muted: R.muted || !R.mic, sess: R.sess };
    }
    const publish = () => { if (R && R.ready) R.channel.track(myMeta()).catch(() => {}); };

    function openChannel() {
        const c = R;
        const channel = client.channel(`diary_space:${c.id}`, { config: { private: true, presence: { key: me() }, broadcast: { self: false } } });
        c.channel = channel;
        c.ready = false;
        channel
            .on('presence', { event: 'sync' }, () => { if (R === c && c.channel === channel) onPresence(); })
            .on('broadcast', { event: 'signal' }, ({ payload }) => { if (R === c && payload && payload.to === me()) onSignal(payload); })
            .on('broadcast', { event: 'roles' }, () => { if (R === c) heartbeat(); })
            .on('broadcast', { event: 'react' }, ({ payload }) => { if (R === c && payload) floatReaction(payload.from, payload.emoji); })
            .on('broadcast', { event: 'control' }, ({ payload }) => { if (R === c && payload && payload.to === me()) onControl(payload); })
            .on('broadcast', { event: 'ended' }, () => { if (R === c) { app.showToast('The host ended the room'); leave(false); } })
            .on('broadcast', { event: 'chat' }, ({ payload }) => { if (R === c && payload) onChat(payload); })
            .on('broadcast', { event: 'chat-del' }, ({ payload }) => { if (R === c && payload) dropChat(payload.id, payload.from); })
            .subscribe(async st => {
                if (R !== c || c.channel !== channel) return;
                if (st === 'SUBSCRIBED') {
                    c.ready = true;
                    c.reconnects = 0;
                    if (!c.joinedAt) c.joinedAt = Date.now();
                    await channel.track(myMeta());
                } else if (['CHANNEL_ERROR', 'TIMED_OUT', 'CLOSED'].includes(st)) {
                    c.ready = false;
                    if (c.reconnects < 5) {
                        c.reconnects++;
                        paint('Reconnecting…');
                        setTimeout(() => {
                            if (R !== c || c.channel !== channel) return;
                            client.removeChannel(channel);
                            openChannel();
                        }, 1500 * c.reconnects);
                    } else {
                        app.showToast('Lost connection to the room');
                        leave(false);
                    }
                }
            });
    }

    function send(event, payload) {
        if (R && R.ready) R.channel.send({ type: 'broadcast', event, payload }).catch(() => {});
    }

    function onPresence() {
        const state = R.channel.presenceState();
        const before = new Map(R.people);
        R.people = new Map(Object.entries(state).map(([k, metas]) => [k, metas[metas.length - 1] || {}]));
        // Someone rejoined (new session): start their connection afresh
        for (const [id, meta] of R.people) {
            const old = before.get(id);
            if (old && old.sess && meta.sess && old.sess !== meta.sess && R.peers.has(id)) closePeer(id);
        }
        // Light, passing notes about who came and went (not while the first sync fills the room in)
        if (R.ready && R.joinedAt && Date.now() - R.joinedAt > 3000) {
            const short = meta => String(meta.name || 'Someone').split(' ')[0];
            for (const [id, meta] of R.people) {
                if (id === me()) continue;
                const old = before.get(id);
                if (!old) activity(`${short(meta)} joined`);
                else if (isHost() && meta.hand && !old.hand) { activity(`✋ ${short(meta)} asked to speak`, 'hand'); buzz(15); }
            }
            for (const [id, meta] of before) if (id !== me() && !R.people.has(id)) activity(`${short(meta)} left`, 'quiet');
        }
        syncPeers();
        paint();
    }

    // A connection is needed between two people when at least one of them is on stage
    function syncPeers() {
        if (!R) return;
        const mine = me();
        for (const [id] of R.people) {
            if (id === mine) continue;
            const need = onStage(mine) || onStage(id);
            if (need && !R.peers.has(id)) {
                const offerer = mine < id;
                const peer = makePeer(id, offerer);
                if (offerer) makeOffer(id, peer);
            }
        }
        if (!R.ready) return; // presence briefly empties while reconnecting
        for (const [id] of R.peers) {
            if (!R.people.has(id) || !(onStage(mine) || onStage(id))) closePeer(id);
        }
    }

    const micTrack = () => (R && R.mic && onStage(me()) ? R.mic.getAudioTracks()[0] || null : null);

    function makePeer(id, offerer) {
        const pc = new RTCPeerConnection({ iceServers: ICE });
        const peer = { pc, offerer, queue: [], remoteSet: false, audio: null, sess: (R.people.get(id) || {}).sess };
        R.peers.set(id, peer);
        if (offerer) {
            const tr = pc.addTransceiver('audio', { direction: 'sendrecv' });
            tr.sender.replaceTrack(micTrack()).catch(() => {});
        }
        pc.onicecandidate = e => { if (e.candidate) send('signal', { to: id, from: me(), sess: R.sess, ice: e.candidate.toJSON() }); };
        pc.ontrack = e => {
            if (!peer.audio) {
                peer.audio = new Audio();
                peer.audio.autoplay = true;
                peer.audio.playsInline = true;
            }
            const stream = e.streams[0] || new MediaStream([e.track]);
            peer.audio.srcObject = stream;
            peer.audio.muted = !!R.deaf;
            peer.audio.play().catch(() => paint('Tap anywhere to hear the room'));
            meter(id, stream);
        };
        pc.onconnectionstatechange = () => {
            if (!R || R.peers.get(id) !== peer) return;
            if (pc.connectionState === 'failed') {
                if (offerer) makeOffer(id, peer, true);
                else setTimeout(() => { if (R && R.peers.get(id) === peer && pc.connectionState === 'failed') { closePeer(id); syncPeers(); } }, 6000);
            }
        };
        return peer;
    }

    async function makeOffer(id, peer, iceRestart = false) {
        try {
            const offer = await peer.pc.createOffer(iceRestart ? { iceRestart: true } : undefined);
            await peer.pc.setLocalDescription(offer);
            send('signal', { to: id, from: me(), sess: R.sess, sdp: peer.pc.localDescription.toJSON() });
        } catch (e) { /* the next sync retries */ }
    }

    async function onSignal(msg) {
        const id = msg.from;
        if (!id || id === me()) return;
        let peer = R.peers.get(id);
        try {
            if (msg.sdp && msg.sdp.type === 'offer') {
                if (peer && peer.offerer) {
                    // Both sides offered (roles changed at the same moment): the lower id wins
                    if (me() < id) return;
                    closePeer(id);
                    peer = null;
                }
                if (peer && peer.sess && msg.sess && peer.sess !== msg.sess) { closePeer(id); peer = null; }
                if (!peer) peer = makePeer(id, false);
                peer.sess = msg.sess;
                await peer.pc.setRemoteDescription(msg.sdp);
                peer.remoteSet = true;
                const tr = peer.pc.getTransceivers()[0];
                if (tr) {
                    tr.direction = 'sendrecv';
                    await tr.sender.replaceTrack(micTrack());
                }
                const answer = await peer.pc.createAnswer();
                await peer.pc.setLocalDescription(answer);
                send('signal', { to: id, from: me(), sess: R.sess, sdp: peer.pc.localDescription.toJSON() });
                flushIce(peer);
            } else if (msg.sdp && msg.sdp.type === 'answer') {
                if (!peer || peer.pc.signalingState !== 'have-local-offer') return;
                await peer.pc.setRemoteDescription(msg.sdp);
                peer.remoteSet = true;
                flushIce(peer);
            } else if (msg.ice) {
                if (!peer) return;
                if (peer.remoteSet) await peer.pc.addIceCandidate(msg.ice).catch(() => {});
                else peer.queue.push(msg.ice);
            }
        } catch (e) { /* a bad message shouldn't break the room */ }
    }

    async function flushIce(peer) {
        const q = peer.queue.splice(0);
        for (const c of q) await peer.pc.addIceCandidate(c).catch(() => {});
    }

    function closePeer(id) {
        const peer = R && R.peers.get(id);
        if (!peer) return;
        R.peers.delete(id);
        try { peer.pc.close(); } catch (e) { /* already closed */ }
        if (peer.audio) { peer.audio.srcObject = null; }
        R.meters.delete(id);
        R.speaking.delete(id);
    }

    // ---------- Your microphone ----------
    async function ensureMic() {
        if (R.mic) return true;
        try {
            R.mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
        } catch (e) {
            app.showToast(e && e.name === 'NotAllowedError' ? 'Allow the microphone for Cordial to speak' : 'Couldn’t use your microphone');
            return false;
        }
        meter(me(), R.mic);
        for (const [, peer] of R.peers) {
            const tr = peer.pc.getTransceivers()[0];
            if (tr) tr.sender.replaceTrack(micTrack()).catch(() => {});
        }
        return true;
    }

    async function toggleMic() {
        if (!R || !onStage(me())) return;
        if (R.muted) {
            if (!(await ensureMic())) return;
            R.muted = false;
        } else {
            R.muted = true;
        }
        R.mic.getAudioTracks().forEach(t => { t.enabled = !R.muted; });
        publish();
        paint();
    }

    function promoted() {
        R.hand = false;
        R.invite = null;
        R.muted = true;
        publish();
        app.showToast(roleOf(me()) === 'cohost' ? 'You’re a co-host now — tap the mic to talk' : 'You’re on stage — tap the mic to talk');
    }

    function demoted() {
        R.muted = true;
        if (R.mic) { R.mic.getTracks().forEach(t => t.stop()); R.mic = null; }
        for (const [, peer] of R.peers) {
            const tr = peer.pc.getTransceivers()[0];
            if (tr) tr.sender.replaceTrack(null).catch(() => {});
        }
        R.meters.delete(me());
        publish();
        app.showToast('You’re back in the audience');
    }

    // ---------- Who's talking ----------
    function meter(id, stream) {
        try {
            if (!R.audioCtx) R.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
            if (R.audioCtx.state === 'suspended') R.audioCtx.resume().catch(() => {});
            const src = R.audioCtx.createMediaStreamSource(stream);
            const an = R.audioCtx.createAnalyser();
            an.fftSize = 512;
            src.connect(an);
            R.meters.set(id, { an, buf: new Uint8Array(an.fftSize) });
        } catch (e) { /* no meter, no ring */ }
    }

    function measure() {
        if (!R || room.hidden && mini.hidden) return;
        const next = new Set();
        for (const [id, m] of R.meters) {
            if (id === me() && (R.muted || !R.mic)) continue;
            m.an.getByteTimeDomainData(m.buf);
            let peak = 0;
            for (let i = 0; i < m.buf.length; i += 4) peak = Math.max(peak, Math.abs(m.buf[i] - 128));
            if (peak > 10) next.add(id);
        }
        const changed = next.size !== R.speaking.size || [...next].some(id => !R.speaking.has(id));
        R.speaking = next;
        if (changed) {
            room.querySelectorAll('.sp-person').forEach(el => el.classList.toggle('talking', next.has(el.dataset.id)));
            paintTalking();
        }
    }

    // ---------- Host tools ----------
    const ctl = (to, action, extra = {}) => send('control', { to, from: me(), name: (s.profile && s.profile.display_name) || 'Someone', action, ...extra });
    const buzz = ms => { try { if (navigator.vibrate) navigator.vibrate(ms || 10); } catch (e) { /* no haptics */ } };
    const short = id => String((R && R.people.get(id) || {}).name || 'Someone').split(' ')[0];

    async function setRole(id, role, done) {
        const { error } = await client.rpc('diary_space_set_role', { p_id: R.id, p_user: id, p_role: role });
        if (error) return app.showToast(error.message);
        send('roles', {});
        if (id !== me()) ctl(id, 'hand-down');
        await heartbeat();
        if (done) activity(done);
    }

    function onControl(msg) {
        const who = String(msg.name || 'A host').split(' ')[0];
        if (msg.action === 'mute' && R.mic && !R.muted) {
            R.muted = true;
            R.mic.getAudioTracks().forEach(t => { t.enabled = false; });
            publish();
            paint();
            app.showToast(`${who} muted you — unmute whenever you’re ready`);
        } else if (msg.action === 'hand-down' && R.hand) {
            R.hand = false;
            publish();
            paint();
            if (msg.declined) app.showToast('Your request to speak wasn’t accepted this time');
        } else if (msg.action === 'remove') {
            app.showToast('You were removed from the room');
            leave(false);
        } else if (msg.action === 'invite' && !onStage(me())) {
            // A host asked you up: you choose (nobody is put on stage without saying yes)
            R.invite = { from: msg.from, name: who };
            buzz(20);
            if (R.minimised) app.showToast(`${who} invited you to speak — open the room to answer`);
            paint();
        } else if (msg.action === 'accept' && isHost() && R.people.has(msg.from)) {
            setRole(msg.from, 'speaker', `${who} joined the stage`);
        } else if (msg.action === 'decline' && isHost()) {
            activity(`${who} said not now`, 'quiet');
        }
    }

    function inviteToStage(id) {
        const meta = R.people.get(id) || {};
        if (meta.hand) return setRole(id, 'speaker', `${short(id)} is on stage`); // they asked — approving is enough
        ctl(id, 'invite');
        activity(`Invite sent to ${short(id)}`, 'quiet');
        buzz();
    }

    // Tap anyone: a compact sheet with who they are and only the actions you're allowed to take
    function personSheet(id) {
        const wrap = room.querySelector('.sp-psheet-wrap');
        if (!wrap || !R) return;
        const meta = R.people.get(id) || {};
        const role = roleOf(id);
        const mineRole = roleOf(me());
        const mine = id === me();
        const full = String(meta.name || 'Someone');
        const fn = esc(full.split(' ')[0]);
        const roleLabel = { host: 'Host', cohost: 'Co-host', speaker: 'Speaker', listener: 'Listening' }[role];
        const state = role !== 'listener' ? (meta.muted ? 'mic off' : 'mic on') : meta.hand ? 'asked to speak' : '';
        const acts = [];
        const add = (act, icon, label, danger) => acts.push(`<button type="button" class="sp-pact${danger ? ' danger' : ''}" data-sp="p-${act}" data-id="${esc(id)}">${ic(icon)}<span>${label}</span></button>`);
        add('profile', 'i-user', 'View profile');
        if (!mine) {
            if ((s.friends || []).some(f => f.id === id)) add('message', 'i-chat', `Message ${fn}`);
            else if (s.following) add('follow', 'i-user-plus', s.following.has(id) ? 'Following ✓' : `Follow ${fn}`);
        }
        if (mine && (role === 'speaker' || role === 'cohost')) add('down', 'i-users', 'Leave the stage');
        if (!mine && ['host', 'cohost'].includes(mineRole) && role !== 'host') {
            if (role === 'listener') add('invite', 'i-mic', meta.hand ? `Bring ${fn} on stage` : `Invite ${fn} to speak`);
            if (role !== 'listener' && !meta.muted) add('mute', 'i-mic-off', `Mute ${fn}`);
            if (role === 'speaker' || (role === 'cohost' && mineRole === 'host')) add('down', 'i-users', 'Move to the audience');
            if (mineRole === 'host' && role !== 'cohost') add('cohost', 'i-shield', `Make ${fn} a co-host`);
            if (mineRole === 'host' && role === 'cohost') add('speaker', 'i-mic', 'Make a speaker instead');
            if (mineRole === 'host' || role !== 'cohost') add('remove', 'i-trash', `Remove ${fn} from the room`, true);
        }
        if (!mine && window.diarySafety) {
            add('report', 'i-flag', `Report ${fn}`);
            add('block', 'i-block', `Block ${fn}`, true);
        }
        wrap.innerHTML = `
            <div class="sp-pback" data-sp="p-close"></div>
            <div class="sp-psheet" role="dialog" aria-modal="true" aria-label="${esc(full)}">
                <div class="sp-grab" aria-hidden="true"><i></i></div>
                <div class="sp-phead">
                    ${avatar({ id, display_name: meta.name, avatar_path: meta.avatar_path }, 'xl')}
                    <div class="sp-pwho">
                        <strong>${esc(full)}${I.tick ? I.tick(id) : ''}${mine ? ' <small>(you)</small>' : ''}</strong>
                        ${meta.username ? `<small>@${esc(meta.username)}</small>` : ''}
                        <span class="sp-role ${role}">${roleLabel}${state ? ` · ${state}` : ''}</span>
                    </div>
                </div>
                <p class="sp-pbio" hidden></p>
                <div class="sp-pacts">${acts.join('')}</div>
            </div>`;
        wrap.hidden = false;
        R.psheet = id;
        dragToClose(wrap.querySelector('.sp-psheet'), closePerson);
        wrap.querySelector('.sp-pact')?.focus({ preventScroll: true });
        client.rpc('diary_profile_full', { p_id: id }).then(({ data }) => {
            const b = wrap.querySelector('.sp-pbio');
            if (R && R.psheet === id && b && data && data.bio) { b.textContent = data.bio; b.hidden = false; }
        }).catch(() => {});
    }

    function closePerson() {
        const wrap = room.querySelector('.sp-psheet-wrap');
        if (!wrap || wrap.hidden || wrap.classList.contains('closing')) return;
        wrap.classList.add('closing');
        setTimeout(() => { wrap.hidden = true; wrap.classList.remove('closing'); wrap.innerHTML = ''; }, 200);
        if (R) R.psheet = null;
    }

    async function personAction(act, id) {
        const meta = R.people.get(id) || {};
        const fn = short(id);
        const p = { id, display_name: meta.name, avatar_path: meta.avatar_path, username: meta.username };
        if (act === 'follow') { await I.toggleFollow(id, fn); return personSheet(id); }
        closePerson();
        if (act === 'profile') { minimise(); window.diaryProfile ? window.diaryProfile.open(id) : app.setView('profile', { profileId: id }); }
        else if (act === 'message') { minimise(); app.setView('messages'); I.openChat(id); }
        else if (act === 'invite') inviteToStage(id);
        else if (act === 'mute') { ctl(id, 'mute'); activity(`You muted ${fn}`, 'quiet'); }
        else if (act === 'down') setRole(id, null, id === me() ? null : `${fn} moved to the audience`);
        else if (act === 'cohost') setRole(id, 'cohost', `${fn} is a co-host`);
        else if (act === 'speaker') setRole(id, 'speaker');
        else if (act === 'remove') {
            if (!(await app.ask({ title: `Remove ${fn}?`, text: `${fn} leaves the room and can’t come back into it.`, ok: 'Remove', danger: true }))) return;
            const { error } = await client.rpc('diary_space_remove', { p_id: R.id, p_user: id });
            if (error) return app.showToast(error.message);
            ctl(id, 'remove');
            activity(`${fn} was removed`, 'quiet');
            heartbeat();
        } else if (act === 'report') window.diarySafety.report('user', id, { who: meta.name, offerBlock: p });
        else if (act === 'block') { if (await window.diarySafety.block(p)) paint(); }
    }

    function roomMenu(anchor) {
        const notesOpen = !(room.querySelector('.sp-notes') || {}).hidden;
        const items = [
            { label: 'Share room', icon: 'i-share', onClick: () => share(R.id) },
            { label: notesOpen ? 'Hide my notes' : 'Take notes', icon: 'i-pencil', onClick: toggleNotes }
        ];
        if (roleOf(me()) === 'host') items.push({ label: 'Edit room', icon: 'i-pencil', onClick: async () => { if (await editor(R.info)) heartbeat(); } });
        if (isHost()) items.push({ label: 'Manage people', icon: 'i-users', onClick: () => setSnap('expanded') });
        if (onStage(me()) && roleOf(me()) !== 'host') items.push({ label: 'Leave the stage', icon: 'i-users', onClick: () => setRole(me(), null) });
        if (!isHost() && window.diarySafety && R.info.host) items.push({ label: 'Report the host', icon: 'i-flag', onClick: () => window.diarySafety.report('user', R.info.host, { who: (R.info.host_profile || {}).display_name || '' }) });
        items.push({ label: 'Leave quietly', icon: 'i-close', onClick: leaveClicked });
        if (isHost()) items.push({ label: 'End room for everyone', icon: 'i-close', danger: true, onClick: endRoom });
        app.openPopover(anchor, items);
    }

    async function endRoom() {
        if (!(await app.ask({ title: 'End this room?', text: 'Everyone leaves and the room goes offline. You can open it again any time.', ok: 'End room', danger: true }))) return;
        const id = R.id;
        const { error } = await client.rpc('diary_space_end', { p_id: id });
        if (error) return app.showToast(error.message);
        send('ended', {});
        await leave(false);
        app.showToast('Room ended');
    }

    // ---------- Reactions ----------
    const REACTIONS = ['👏', '❤️', '😂', '🔥', '💯'];
    let floating = 0;
    function react(emoji) {
        send('react', { from: me(), emoji });
        floatReaction(me(), emoji);
        buzz(8);
    }
    // From the person's photo when they're on stage, otherwise up the right-hand side (capped, so a crowd never buries the room)
    function floatReaction(from, emoji) {
        if (!REACTIONS.includes(emoji) || room.hidden || floating >= 14) return;
        const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        const at = room.querySelector(`.sp-people.stage .sp-person[data-id="${CSS.escape(from)}"] .sp-av`);
        const fx = room.querySelector('.sp-fx');
        const e = document.createElement('span');
        e.textContent = emoji;
        e.setAttribute('aria-hidden', 'true');
        if (at) { e.className = 'sp-float'; at.append(e); }
        else if (fx) { e.className = 'sp-bubble'; e.style.setProperty('--x', `${Math.round(Math.random() * 40 - 20)}px`); fx.append(e); }
        else return;
        floating++;
        setTimeout(() => { e.remove(); floating--; }, reduce ? 900 : 2200);
    }

    // ---------- Leaving ----------
    async function leave(quiet) {
        const c = R;
        if (!c) return;
        R = null;
        clearInterval(c.ping);
        clearInterval(c.meterTimer);
        for (const [id] of c.peers) {
            const peer = c.peers.get(id);
            try { peer.pc.close(); } catch (e) { /* closed */ }
            if (peer.audio) peer.audio.srcObject = null;
        }
        if (c.mic) c.mic.getTracks().forEach(t => t.stop());
        if (c.audioCtx) c.audioCtx.close().catch(() => {});
        if (c.channel) { c.channel.untrack().catch(() => {}); client.removeChannel(c.channel); }
        client.rpc('diary_space_leave', { p_id: c.id }).then(() => load());
        room.dataset.for = '';
        room.hidden = true;
        mini.hidden = true;
        document.body.classList.remove('sp-open', 'sp-mini-on');
        if (!quiet) app.render();
    }

    // Leaving quietly never ends the room — hosts end it with the "End room" button
    function leaveClicked() {
        if (roleOf(me()) === 'host' && R.people.size > 1) {
            const cohost = [...R.people.keys()].some(id => roleOf(id) === 'cohost');
            app.showToast(cohost ? 'You left — your co-host keeps the room going' : 'You left — the room stays open a few minutes if you want to come back');
        }
        leave(false);
    }

    // ---------- Drawing it ----------
    function expand() {
        if (!R) return;
        R.minimised = false;
        room.hidden = false;
        mini.hidden = true;
        document.body.classList.add('sp-open');
        document.body.classList.remove('sp-mini-on');
        paint();
        room.querySelector('.sp-room-close')?.focus({ preventScroll: true });
    }
    function minimise() {
        if (!R) return;
        R.minimised = true;
        room.hidden = true;
        mini.hidden = false;
        document.body.classList.remove('sp-open');
        document.body.classList.add('sp-mini-on');
        paint();
    }

    function tile(id) {
        const meta = R.people.get(id) || {};
        const role = roleOf(id);
        const p = { id, display_name: meta.name, avatar_path: meta.avatar_path };
        const badge = role === 'host' ? '<span class="sp-badge host" aria-hidden="true">★</span>' : role === 'cohost' ? '<span class="sp-badge host" aria-hidden="true">☆</span>' : '';
        const muted = role !== 'listener' && meta.muted ? `<span class="sp-muted" aria-hidden="true">${ic('i-mic-off')}</span>` : '';
        const hand = role === 'listener' && meta.hand ? '<span class="sp-hand" aria-hidden="true">✋</span>' : '';
        const label = [meta.name || 'Someone', id === me() ? 'you' : '', role !== 'listener' ? ({ host: 'host', cohost: 'co-host', speaker: 'speaker' }[role]) : '',
            role !== 'listener' ? (meta.muted ? 'muted' : 'mic on') : meta.hand ? 'asked to speak' : ''].filter(Boolean).join(', ');
        return `
            <button type="button" class="sp-person${R.speaking.has(id) ? ' talking' : ''}${id === me() ? ' me' : ''}" data-id="${esc(id)}" aria-label="${esc(label)}">
                <span class="sp-av">${avatar(p, 'lg')}${muted}${hand}</span>
                <span class="sp-name">${badge}<span>${id === me() ? 'You' : first(meta.name)}</span>${I.tick ? I.tick(id) : ''}</span>
            </button>`;
    }

    function liveFor(since) {
        const t = Date.parse(since || '');
        if (!t) return 'Live now';
        const mins = Math.max(0, Math.round((Date.now() - t) / 60000));
        if (mins < 1) return 'Just started';
        if (mins < 60) return `${mins} min live`;
        return `${Math.floor(mins / 60)} h ${mins % 60} min live`;
    }

    function talkingName() {
        const id = [...R.speaking].find(x => x !== me()) || [...R.speaking][0];
        return id ? (id === me() ? 'You' : String((R.people.get(id) || {}).name || 'Someone').split(' ')[0]) : '';
    }
    // Who's speaking changes many times a second: only the two small lines that say so are touched
    function paintTalking() {
        if (!R) return;
        const who = talkingName();
        const stageCount = [...R.people.keys()].filter(onStage).length;
        const line = who ? `🔊 ${esc(who)} ${who === 'You' ? 'are' : 'is'} speaking` : `${stageCount} on stage`;
        const a = room.querySelector('.sp-talkline');
        if (a) a.innerHTML = who ? line : '';
        const b = mini.querySelector('.sp-mini-text small');
        if (b) b.innerHTML = who ? line : `${stageCount} on stage · ${R.people.size} here`;
    }

    function paint(note) {
        if (!R) return;
        const x = R.info;
        const ids = [...R.people.keys()];
        if (!ids.includes(me())) ids.push(me()); // show yourself before presence catches up
        if (!R.people.has(me())) R.people.set(me(), myMeta());
        const order = { host: 0, cohost: 1, speaker: 2 };
        const stage = ids.filter(onStage).sort((a, b) => order[roleOf(a)] - order[roleOf(b)]);
        const audience = ids.filter(id => !onStage(id)).sort((a, b) => ((R.people.get(b) || {}).hand ? 1 : 0) - ((R.people.get(a) || {}).hand ? 1 : 0));
        // Requests to speak, first come first served
        const hands = audience.filter(id => (R.people.get(id) || {}).hand).sort((a, b) => ((R.people.get(a) || {}).handAt || 0) - ((R.people.get(b) || {}).handAt || 0));
        const speaker = onStage(me());
        const host = x.host_profile || {};
        const who = talkingName();
        if (!note && !R.ready) note = 'Joining the room…';

        mini.className = `sp-mini theme-${esc(x.theme || 'violet')}`;
        mini.innerHTML = `
            <button type="button" class="sp-mini-open" aria-label="Open the room ${esc(x.title)}">
                <span class="sp-live"><i aria-hidden="true"></i>LIVE</span>
                <span class="sp-mini-text"><strong>${esc(x.title)}</strong><small>${who ? `🔊 ${esc(who)} ${who === 'You' ? 'are' : 'is'} speaking` : `${stage.length} on stage · ${ids.length} here`}</small></span>
            </button>
            ${speaker ? `<button type="button" class="sp-round${R.muted ? '' : ' on'}" data-sp="mic" aria-label="${R.muted ? 'Unmute your microphone' : 'Mute your microphone'}">${ic(R.muted ? 'i-mic-off' : 'i-mic')}</button>` : ''}
            <button type="button" class="sp-round leave" data-sp="leave" aria-label="Leave the room">${ic('i-close')}</button>`;

        if (room.hidden) return;
        room.className = `sp-room theme-${esc(x.theme || 'violet')}`;
        // Built once per room; after that only its parts are redrawn, so notes and chat you're typing are never disturbed
        if (room.dataset.for !== R.id || !room.querySelector('.sp-sheet')) buildRoom();
        const sheet = room.querySelector('.sp-sheet');

        sheet.querySelector('.sp-room-head').innerHTML = `
            <button type="button" class="sp-icon sp-room-close" data-sp="minimise" aria-label="Minimise — keep listening">${ic('i-chevron-down')}</button>
            <span class="sp-live"><i aria-hidden="true"></i>LIVE</span>
            <span class="sp-head-count">${ids.length} here</span>
            <button type="button" class="sp-icon" data-sp="share" aria-label="Share room">${ic('i-share')}</button>
            <button type="button" class="sp-leave-pill" data-sp="leave"><span aria-hidden="true">✌️</span> Leave</button>
            <button type="button" class="sp-icon" data-sp="menu" aria-label="Room options" aria-haspopup="menu">${ic('i-more')}</button>`;

        const invite = R.invite && !speaker ? `
            <div class="sp-invite-card" role="alertdialog" aria-label="Invitation to speak">
                <span class="sp-invite-ic" aria-hidden="true">🎙️</span>
                <div><strong>${esc(R.invite.name)} invited you to speak</strong><small>You’ll join the stage with your mic off.</small></div>
                <div class="sp-invite-acts">
                    <button type="button" class="sp-pill ghost" data-sp="invite-no">Not now</button>
                    <button type="button" class="sp-pill primary" data-sp="invite-yes">Join stage</button>
                </div>
            </div>` : '';
        sheet.querySelector('.sp-stage').innerHTML = `
            <div class="sp-room-title">
                ${x.topic ? `<span class="sp-topic">${esc(x.topic)}</span>` : ''}
                <h2>${esc(x.title)}</h2>
                <p class="sp-meta">${host.display_name ? `Hosted by ${esc(host.display_name)} · ` : ''}${liveFor(x.live_since)}</p>
                <p class="sp-talkline" aria-live="off">${who ? `🔊 ${esc(who)} ${who === 'You' ? 'are' : 'is'} speaking` : ''}</p>
            </div>
            ${note ? `<p class="sp-note" role="status">${esc(note)}</p>` : ''}
            ${invite}
            <h3 class="sp-sec-h">On stage · ${stage.length}</h3>
            ${stage.length
                ? `<div class="sp-people stage" data-n="${Math.min(stage.length, 5)}">${stage.map(tile).join('')}</div>`
                : `<div class="sp-emptycard"><strong>No one is speaking yet</strong><span>${isHost() ? 'Tap someone listening to invite them up.' : 'Ask to speak, or wait for the hosts to invite someone up.'}</span></div>`}
            ${isHost() && hands.length ? `
                <button type="button" class="sp-req-banner" data-sp="requests">
                    <span class="sp-stack" aria-hidden="true">${hands.slice(0, 3).map(id => { const m = R.people.get(id) || {}; return avatar({ id, display_name: m.name, avatar_path: m.avatar_path }, 'sm'); }).join('')}</span>
                    <span><strong>${hands.length === 1 ? `${esc(short(hands[0]))} asked to speak` : `${hands.length} people asked to speak`}</strong><small>Review requests</small></span>
                    <span class="sp-chev" aria-hidden="true">›</span>
                </button>` : ''}
            <h3 class="sp-sec-h">Listening · ${audience.length}</h3>
            ${audience.length ? `<div class="sp-people aud">${audience.map(tile).join('')}</div>` : `
                <div class="sp-emptycard"><strong>No one else is here yet</strong><span>Invite people to join your room.</span>
                <button type="button" class="sp-pill primary" data-sp="share">${ic('i-share')}<span>Share room</span></button></div>`}`;

        const last = R.chat[R.chat.length - 1];
        sheet.querySelector('.sp-summary').innerHTML = last ? `
            <button type="button" class="sp-ticker" data-sp="chat" aria-label="Open room chat. Latest: ${esc(last.from === me() ? 'You' : last.name)}: ${esc(last.text)}">
                ${avatar({ id: last.from, display_name: last.name, avatar_path: last.avatar_path }, 'sm')}
                <span><b>${last.from === me() ? 'You' : esc(last.name.split(' ')[0])}</b> ${esc(last.text)}</span>
            </button>` : `
            <button type="button" class="sp-ticker empty" data-sp="chat">
                <span class="sp-ticker-ic" aria-hidden="true">${ic('i-chat')}</span>
                <span>Say something to the room…</span>
            </button>`;

        const reactBtn = `<button type="button" class="sp-ctl icon${R.reactsOpen ? ' on' : ''}" data-sp="reacts" aria-label="Reactions" aria-expanded="${R.reactsOpen}"><span aria-hidden="true">👏</span></button>`;
        const chatBtn = `<button type="button" class="sp-ctl icon" data-sp="chat" aria-label="Room chat${R.unread ? `, ${R.unread} new` : ''}">${ic('i-chat')}${R.unread ? `<b class="sp-dot" aria-hidden="true">${R.unread > 9 ? '9+' : R.unread}</b>` : ''}</button>`;
        const micBtn = `<button type="button" class="sp-ctl mic${R.muted ? '' : ' live'}" data-sp="mic" aria-pressed="${!R.muted}" aria-label="${R.muted ? 'Unmute your microphone' : 'Mute your microphone'}">${ic(R.muted ? 'i-mic-off' : 'i-mic')}<span>${R.muted ? 'Unmute' : 'Mute'}</span></button>`;
        let controls;
        if (isHost()) {
            controls = micBtn + `<button type="button" class="sp-ctl${hands.length ? ' alert' : ''}" data-sp="requests" aria-label="Requests to speak${hands.length ? `, ${hands.length} waiting` : ''}"><span aria-hidden="true">✋</span><span>Requests</span>${hands.length ? `<b class="sp-dot" aria-hidden="true">${hands.length > 9 ? '9+' : hands.length}</b>` : ''}</button>` + reactBtn + chatBtn;
        } else if (speaker) {
            controls = micBtn + reactBtn + chatBtn + `<button type="button" class="sp-ctl" data-sp="stage-leave">${ic('i-users')}<span>Leave stage</span></button>`;
        } else {
            controls = `<button type="button" class="sp-ctl ask${R.hand ? ' sent' : ''}" data-sp="hand" aria-pressed="${R.hand}"><span aria-hidden="true">${R.hand ? '✓' : '✋'}</span><span>${R.hand ? 'Request sent · Cancel' : 'Ask to speak'}</span></button>` + reactBtn + chatBtn;
        }
        sheet.querySelector('.sp-controls').innerHTML = controls;
        const reacts = sheet.querySelector('.sp-reacts');
        reacts.hidden = !R.reactsOpen;

        const req = !isHost() ? '' : `
            <section class="sp-block" id="sp-req" aria-label="Requests to speak">
                <h3 class="sp-sec-h">Requests to speak${hands.length ? ` · ${hands.length}` : ''}</h3>
                ${hands.length ? hands.map(id => { const m = R.people.get(id) || {}; return `
                    <div class="sp-req-row">
                        ${avatar({ id, display_name: m.name, avatar_path: m.avatar_path }, 'sm')}
                        <span class="sp-req-name">${esc(m.name || 'Someone')}</span>
                        <button type="button" class="sp-req-btn ghost" data-sp="req-no" data-id="${esc(id)}" aria-label="Decline ${esc(m.name || 'them')}">${ic('i-close')}</button>
                        <button type="button" class="sp-req-btn" data-sp="req-yes" data-id="${esc(id)}">Approve</button>
                    </div>`; }).join('') : '<p class="sp-empty">No requests right now. Tap anyone listening to invite them up.</p>'}
            </section>`;
        const about = `
            <section class="sp-block" aria-label="About this room">
                <h3 class="sp-sec-h">About this room</h3>
                <div class="sp-about">
                    <strong>${esc(x.title)}</strong>
                    ${host.display_name ? `<span>Hosted by ${esc(host.display_name)}</span>` : ''}
                    ${x.about ? `<p>${esc(x.about)}</p>` : ''}
                    <dl>
                        <div><dt>Live</dt><dd>${liveFor(x.live_since).replace(' live', '')}</dd></div>
                        <div><dt>On stage</dt><dd>${stage.length}</dd></div>
                        <div><dt>Listening</dt><dd>${audience.length}</dd></div>
                        ${x.topic ? `<div><dt>Topic</dt><dd>${esc(x.topic)}</dd></div>` : ''}
                    </dl>
                    <div class="sp-about-acts">
                        <button type="button" class="sp-pill" data-sp="share">${ic('i-share')}<span>Share room</span></button>
                        <button type="button" class="sp-pill" data-sp="notes">${ic('i-pencil')}<span>Take notes</span></button>
                    </div>
                </div>
            </section>`;
        sheet.querySelector('.sp-panel-body').innerHTML = req + about;
        const panel = sheet.querySelector('.sp-panel');
        if (!panel.dataset.dragging) setSnap(R.snap, true);
    }

    function buildRoom() {
        room.dataset.for = R.id;
        room.innerHTML = `
            <div class="sp-sheet">
                <header class="sp-room-head"></header>
                <div class="sp-activity" aria-live="polite"></div>
                <div class="sp-stage"></div>
                <div class="sp-fx" aria-hidden="true"></div>
                <section class="sp-panel" data-snap="collapsed" aria-label="Room panel">
                    <div class="sp-panel-top">
                        <button type="button" class="sp-handle" data-sp="handle" aria-label="Show more of the room" aria-expanded="false"><i aria-hidden="true"></i></button>
                        <div class="sp-summary"></div>
                        <div class="sp-controls" role="toolbar" aria-label="Room controls"></div>
                        <div class="sp-reacts" role="group" aria-label="Send a reaction" hidden>${REACTIONS.map(e => `<button type="button" class="sp-emoji" data-sp="react" data-emoji="${e}" aria-label="React ${e}">${e}</button>`).join('')}</div>
                    </div>
                    <div class="sp-panel-body"></div>
                    <div class="sp-chat" hidden>
                        <header class="sp-chat-head">
                            <button type="button" class="sp-icon flat" data-sp="chat-back" aria-label="Back to the room">${ic('i-chevron-left')}</button>
                            <span><strong>Room chat</strong><small>Not saved after the room ends</small></span>
                        </header>
                        <div class="sp-chat-list" role="log" aria-live="polite" aria-label="Room chat"></div>
                        <form class="sp-chat-form">
                            <div class="sp-reply" hidden><span></span><button type="button" class="sp-icon flat" data-sp="reply-x" aria-label="Cancel reply">${ic('i-close')}</button></div>
                            <div class="sp-chat-row">
                                <input class="sp-chat-input" maxlength="500" placeholder="Say something to the room…" aria-label="Message the room" autocomplete="off" enterkeyhint="send">
                                <button type="submit" class="sp-send" aria-label="Send">${ic('i-send')}</button>
                            </div>
                        </form>
                    </div>
                    <span class="sp-sab" aria-hidden="true"></span>
                </section>
                <section class="sp-notes" aria-label="Your notes" hidden>
                    <header class="sp-notes-head">
                        <strong>📝 Your notes</strong>
                        <span class="sp-notes-saved" aria-live="polite">Kept on this device</span>
                        <button type="button" class="sp-icon" data-sp="notes" aria-label="Hide notes">${ic('i-chevron-down')}</button>
                    </header>
                    <textarea class="sp-notes-text" aria-label="Your notes" placeholder="Jot down ideas, quotes, names, links… They stay here while you listen."></textarea>
                    <div class="sp-notes-actions">
                        <button type="button" class="sp-notes-btn" data-sp="notes-stamp">⏱ Add time & speaker</button>
                        <button type="button" class="sp-notes-btn primary" data-sp="notes-save">Save to my diary</button>
                    </div>
                </section>
                <div class="sp-psheet-wrap" hidden></div>
            </div>`;
        const ta = room.querySelector('.sp-notes-text');
        try { ta.value = localStorage.getItem(`cordialSpaceNotes:${R.id}`) || ''; } catch (e) { /* private mode */ }
        let saveTimer = null;
        ta.addEventListener('input', () => {
            clearTimeout(saveTimer);
            const id = R && R.id;
            saveTimer = setTimeout(() => {
                try { localStorage.setItem(`cordialSpaceNotes:${id}`, ta.value); } catch (e) { /* private mode */ }
                const saved = room.querySelector('.sp-notes-saved');
                if (saved) saved.textContent = 'Kept on this device ✓';
            }, 400);
        });
        room.querySelector('.sp-chat-form').addEventListener('submit', e => {
            e.preventDefault();
            const input = room.querySelector('.sp-chat-input');
            sendChat(input.value);
            input.value = '';
        });
        const panel = room.querySelector('.sp-panel');
        wirePanelDrag(panel);
        panel.style.transition = 'none';
        requestAnimationFrame(() => { if (R) setSnap(R.snap, false); });
        renderChat(true);
    }

    // ---------- Passing notes: joins, leaves, requests (never a modal) ----------
    function activity(text, kind = '') {
        const box = room.querySelector('.sp-activity');
        if (!box || room.hidden) return;
        const el = document.createElement('div');
        el.className = `sp-act${kind ? ` ${kind}` : ''}`;
        el.textContent = text;
        box.append(el);
        while (box.children.length > 3) box.firstElementChild.remove();
        setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 220); }, 2800);
    }

    // ---------- The panel: collapsed · half · full, moved like an iOS sheet ----------
    const SNAPS = ['collapsed', 'half', 'expanded'];
    const project = (v, rate = 0.998) => (v / 1000) * rate / (1 - rate);
    const rubber = (over, dim, c = 0.55) => (over * dim * c) / (dim + c * Math.abs(over));
    function snapOffsets(panel) {
        const h = panel.offsetHeight;
        const peek = panel.querySelector('.sp-panel-top').offsetHeight + panel.querySelector('.sp-sab').offsetHeight;
        const collapsed = Math.max(0, h - peek);
        return { expanded: 0, half: Math.min(Math.round(h * 0.45), Math.max(0, collapsed - 120)), collapsed };
    }
    function setSnap(name, animate = true) {
        const panel = room.querySelector('.sp-panel');
        if (!panel || !R) return;
        if (R.chatOpen && name !== 'expanded') { R.chatOpen = false; showChat(false); }
        R.snap = name;
        const o = snapOffsets(panel);
        if (!animate) panel.style.transition = 'none';
        panel.style.transform = `translateY(${o[name]}px)`;
        panel.dataset.snap = name;
        const handle = panel.querySelector('.sp-handle');
        handle.setAttribute('aria-label', name === 'expanded' ? 'Show less' : 'Show more of the room');
        handle.setAttribute('aria-expanded', String(name !== 'collapsed'));
        panel.querySelector('.sp-panel-body').inert = name === 'collapsed';
        room.querySelector('.sp-sheet').style.setProperty('--sp-peek', `${panel.offsetHeight - o.collapsed}px`);
        if (!animate) requestAnimationFrame(() => requestAnimationFrame(() => { panel.style.transition = ''; }));
    }
    function wirePanelDrag(panel) {
        const top = panel.querySelector('.sp-panel-top');
        let drag = null;
        top.addEventListener('pointerdown', e => {
            if (e.pointerType === 'mouse' && e.button !== 0) return;
            if (e.target.closest('button:not(.sp-handle), input, textarea, a')) return;
            const o = snapOffsets(panel);
            drag = { y0: e.clientY, start: o[R.snap] || 0, y: o[R.snap] || 0, o, moved: false, id: e.pointerId, hist: [[e.timeStamp, e.clientY]], from: R.snap };
        });
        top.addEventListener('pointermove', e => {
            if (!drag || e.pointerId !== drag.id) return;
            const dy = e.clientY - drag.y0;
            if (!drag.moved) {
                if (Math.abs(dy) < 8) return; // a tap stays a tap
                drag.moved = true;
                top.setPointerCapture(e.pointerId);
                panel.style.transition = 'none';
                panel.dataset.dragging = '1';
            }
            let y = drag.start + dy;
            if (y < 0) y = -rubber(-y, panel.offsetHeight);
            else if (y > drag.o.collapsed) y = drag.o.collapsed + rubber(y - drag.o.collapsed, 320);
            drag.y = y;
            panel.style.transform = `translateY(${y}px)`;
            drag.hist.push([e.timeStamp, e.clientY]);
            if (drag.hist.length > 6) drag.hist.shift();
        });
        const end = e => {
            if (!drag || e.pointerId !== drag.id) return;
            const d = drag;
            drag = null;
            if (!d.moved) return;
            delete panel.dataset.dragging;
            panel.dataset.dragged = '1';
            setTimeout(() => { delete panel.dataset.dragged; }, 0);
            panel.style.transition = '';
            const [t0, y0] = d.hist[0];
            const [t1, y1] = d.hist[d.hist.length - 1];
            const v = t1 > t0 ? ((y1 - y0) / (t1 - t0)) * 1000 : 0; // px/s, positive = down
            // Pulled well past the bottom (or flicked down from the bottom): keep listening in the mini player
            if (d.from === 'collapsed' && (d.y > d.o.collapsed + 70 || v > 1200)) { setSnap('collapsed'); return minimise(); }
            const aim = d.y + project(v);
            const name = SNAPS.reduce((a, b) => (Math.abs(d.o[b] - aim) < Math.abs(d.o[a] - aim) ? b : a));
            if (name !== d.from) buzz(6);
            setSnap(name);
        };
        top.addEventListener('pointerup', end);
        top.addEventListener('pointercancel', end);
    }
    // Swipe a small sheet down to dismiss it
    function dragToClose(card, close) {
        if (!card) return;
        let d = null;
        card.addEventListener('pointerdown', e => {
            if (e.target.closest('button, a') || card.scrollTop > 0) return;
            d = { y0: e.clientY, t0: e.timeStamp, id: e.pointerId, y: 0, moved: false };
        });
        card.addEventListener('pointermove', e => {
            if (!d || e.pointerId !== d.id) return;
            const dy = e.clientY - d.y0;
            if (!d.moved) { if (Math.abs(dy) < 8) return; d.moved = true; card.setPointerCapture(e.pointerId); card.style.transition = 'none'; }
            d.y = dy > 0 ? dy : -rubber(-dy, 200);
            card.style.transform = `translateY(${d.y}px)`;
        });
        const end = e => {
            if (!d || e.pointerId !== d.id) return;
            const g = d;
            d = null;
            card.style.transition = '';
            const v = (g.y / Math.max(1, e.timeStamp - g.t0)) * 1000;
            if (g.moved && (g.y > 90 || v > 900)) { card.style.transform = 'translateY(100%)'; close(); }
            else card.style.transform = '';
        };
        card.addEventListener('pointerup', end);
        card.addEventListener('pointercancel', end);
    }

    // ---------- Room chat: sent over the room's live channel, gone when the room ends ----------
    function onChat(m) {
        if (!R || !m || !m.id || typeof m.text !== 'string' || !m.text.trim()) return;
        if (window.diarySafety && window.diarySafety.isBlocked && window.diarySafety.isBlocked(m.from)) return;
        if (R.chat.some(x => x.id === m.id)) return;
        R.chat.push({
            id: String(m.id).slice(0, 24), from: m.from, name: String(m.name || 'Someone').slice(0, 60), avatar_path: m.avatar_path || null,
            text: m.text.slice(0, 500), reply: m.reply ? { name: String(m.reply.name || '').slice(0, 60), text: String(m.reply.text || '').slice(0, 120) } : null, at: Date.now()
        });
        if (R.chat.length > 200) R.chat.shift();
        if (m.from !== me()) {
            if (!R.chatOpen || room.hidden) R.unread++;
            const handle = s.profile && s.profile.username;
            if (handle && new RegExp(`(^|\\s)@${handle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(m.text)) activity(`💬 ${String(m.name || 'Someone').split(' ')[0]} mentioned you`, 'hand');
        }
        renderChat();
        if (!R.chatOpen) paint();
    }
    function dropChat(id, from) {
        if (!R) return;
        const i = R.chat.findIndex(x => x.id === id && x.from === from);
        if (i < 0) return;
        R.chat.splice(i, 1);
        renderChat();
    }
    function sendChat(text) {
        if (!R || !text || !text.trim()) return;
        if (!R.ready) return app.showToast('Still connecting — try again in a moment');
        const p = s.profile || {};
        const msg = { id: Math.random().toString(36).slice(2, 12), from: me(), name: p.display_name || 'Someone', avatar_path: p.avatar_path || null, text: text.trim().slice(0, 500), reply: R.reply };
        send('chat', msg);
        R.reply = null;
        paintReply();
        onChat(msg);
    }
    function chatHTML(m) {
        const mine = m.from === me();
        const text = esc(m.text).replace(/(^|\s)@([\w.]{2,30})/g, '$1<b class="sp-at">@$2</b>');
        const time = new Date(m.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
        return `
            <div class="sp-msg${mine ? ' mine' : ''}" data-sp="msg" data-mid="${esc(m.id)}" role="button" tabindex="0" aria-label="${esc(mine ? 'You' : m.name)}: ${esc(m.text)}">
                ${avatar({ id: m.from, display_name: m.name, avatar_path: m.avatar_path }, 'sm')}
                <div class="sp-msg-body">
                    <span class="sp-msg-who"><b>${mine ? 'You' : esc(m.name)}</b><time>${time}</time></span>
                    ${m.reply ? `<span class="sp-msg-reply">↩ ${esc(m.reply.name)}: ${esc(m.reply.text)}</span>` : ''}
                    <p>${text}</p>
                </div>
            </div>`;
    }
    function renderChat(force) {
        const list = room.querySelector('.sp-chat-list');
        if (!list || !R || (!R.chatOpen && !force)) return;
        const near = list.scrollHeight - list.scrollTop - list.clientHeight < 90;
        list.innerHTML = R.chat.length ? R.chat.map(chatHTML).join('')
            : '<div class="sp-emptycard"><strong>Say hi 👋</strong><span>Chat with everyone in the room. Messages disappear when the room ends.</span></div>';
        if (near || force) list.scrollTop = list.scrollHeight;
    }
    function paintReply() {
        const box = room.querySelector('.sp-reply');
        if (!box) return;
        box.hidden = !(R && R.reply);
        if (R && R.reply) box.querySelector('span').textContent = `Replying to ${R.reply.name}: ${R.reply.text}`;
    }
    function showChat(open) {
        const panel = room.querySelector('.sp-panel');
        if (!panel) return;
        panel.classList.toggle('chat-open', open);
        panel.querySelector('.sp-chat').hidden = !open;
        panel.querySelector('.sp-panel-body').hidden = open;
    }
    function openChat(open) {
        if (!R) return;
        R.chatOpen = open;
        showChat(open);
        if (open) {
            R.unread = 0;
            R.reactsOpen = false;
            R.snap = 'expanded';
            paint();
            setSnap('expanded');
            renderChat(true);
            if (window.matchMedia('(pointer: fine)').matches) setTimeout(() => room.querySelector('.sp-chat-input')?.focus({ preventScroll: true }), 300);
        } else {
            room.querySelector('.sp-chat-input')?.blur();
            setSnap('half');
            paint();
        }
    }
    function msgMenu(el) {
        const m = R.chat.find(x => x.id === el.dataset.mid);
        if (!m) return;
        const mine = m.from === me();
        const items = [{ label: 'Reply', icon: 'i-chat', onClick: () => { R.reply = { name: m.name, text: m.text.slice(0, 120) }; paintReply(); room.querySelector('.sp-chat-input')?.focus(); } }];
        if (!mine) items.push({ label: `View ${String(m.name).split(' ')[0]}`, icon: 'i-user', onClick: () => personSheet(m.from) });
        if (mine) items.push({ label: 'Delete message', icon: 'i-trash', danger: true, onClick: () => { send('chat-del', { id: m.id, from: me() }); dropChat(m.id, me()); } });
        else if (window.diarySafety) items.push({ label: 'Report message', icon: 'i-flag', onClick: () => window.diarySafety.report('user', m.from, { who: m.name }) });
        app.openPopover(el, items);
    }

    // ---------- Notes while you listen ----------
    function toggleNotes() {
        const panel = room.querySelector('.sp-notes');
        if (!panel) return;
        panel.hidden = !panel.hidden;
        paint();
        if (!panel.hidden) setTimeout(() => room.querySelector('.sp-notes-text')?.focus(), 50);
    }

    // "[7:42 pm · Bolu, Ada] " at the cursor: who was talking when you wrote it
    function stampNote() {
        const ta = room.querySelector('.sp-notes-text');
        if (!ta || !R) return;
        const talking = [...R.speaking].filter(id => id !== me()).map(id => String((R.people.get(id) || {}).name || '').split(' ')[0]).filter(Boolean);
        const time = new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }).toLowerCase();
        const stamp = `[${time}${talking.length ? ` · ${talking.join(', ')}` : ''}] `;
        const at = ta.selectionStart ?? ta.value.length;
        const before = ta.value.slice(0, at);
        const lead = before && !before.endsWith('\n') ? '\n' : '';
        ta.value = before + lead + stamp + ta.value.slice(ta.selectionEnd ?? at);
        const pos = (before + lead + stamp).length;
        ta.focus();
        ta.setSelectionRange(pos, pos);
        ta.dispatchEvent(new Event('input'));
    }

    async function saveNotes(btn) {
        const ta = room.querySelector('.sp-notes-text');
        const text = ta ? ta.value.trim() : '';
        if (!text) return app.showToast('Write something first');
        btn.disabled = true;
        try {
            await app.createEntry({ title: `🎙️ Notes · ${R.info.title}`, text, shared: false });
            app.showToast('Saved to your diary 📝 — only you can see it');
            const saved = room.querySelector('.sp-notes-saved');
            if (saved) saved.textContent = 'Saved to your diary ✓';
        } catch (e) {
            app.showToast('Couldn’t save your notes — try again');
        } finally {
            btn.disabled = false;
        }
    }

    const onRoomClick = async e => {
        if (!R) return;
        const panel = room.querySelector('.sp-panel');
        if (panel && panel.dataset.dragged) return;
        if (e.target.closest('.sp-mini-open')) return expand();
        const person = e.target.closest('.sp-person');
        if (person) return personSheet(person.dataset.id);
        const el = e.target.closest('[data-sp]');
        if (!el) {
            if (e.target === room) minimise();
            return;
        }
        const what = el.dataset.sp;
        const id = el.dataset.id;
        if (what.startsWith('p-')) return what === 'p-close' ? closePerson() : personAction(what.slice(2), id);
        if (what === 'minimise') minimise();
        else if (what === 'menu') roomMenu(el);
        else if (what === 'leave') leaveClicked();
        else if (what === 'end') endRoom();
        else if (what === 'notes') toggleNotes();
        else if (what === 'notes-stamp') stampNote();
        else if (what === 'notes-save') saveNotes(el);
        else if (what === 'mic') { await toggleMic(); buzz(8); }
        else if (what === 'react') react(el.dataset.emoji);
        else if (what === 'reacts') { R.reactsOpen = !R.reactsOpen; paint(); }
        else if (what === 'handle') setSnap(R.snap === 'collapsed' ? 'half' : R.snap === 'half' ? 'expanded' : 'collapsed');
        else if (what === 'share') share(R.id);
        else if (what === 'chat') openChat(true);
        else if (what === 'chat-back') openChat(false);
        else if (what === 'msg') msgMenu(el);
        else if (what === 'reply-x') { R.reply = null; paintReply(); }
        else if (what === 'requests') {
            setSnap('expanded');
            setTimeout(() => room.querySelector('#sp-req')?.scrollIntoView({ block: 'start', behavior: 'smooth' }), 120);
        }
        else if (what === 'stage-leave') setRole(me(), null);
        else if (what === 'req-yes') setRole(id, 'speaker', `${short(id)} is on stage`);
        else if (what === 'req-no') { ctl(id, 'hand-down', { declined: true }); activity(`Declined ${short(id)}’s request`, 'quiet'); }
        else if (what === 'invite-yes' && R.invite) { const inv = R.invite; R.invite = null; ctl(inv.from, 'accept'); paint('Joining the stage…'); buzz(12); }
        else if (what === 'invite-no' && R.invite) { const inv = R.invite; R.invite = null; ctl(inv.from, 'decline'); paint(); }
        else if (what === 'hand') {
            R.hand = !R.hand;
            R.handAt = R.hand ? Date.now() : 0;
            publish();
            paint();
            buzz(10);
            activity(R.hand ? 'Request sent — the hosts can bring you up' : 'Request cancelled', 'quiet');
        }
    };
    room.addEventListener('click', onRoomClick);
    mini.addEventListener('click', onRoomClick);
    room.addEventListener('keydown', e => {
        if ((e.key === 'Enter' || e.key === ' ') && e.target.matches && e.target.matches('.sp-msg')) { e.preventDefault(); msgMenu(e.target); }
    });
    document.addEventListener('keydown', e => {
        if (e.key !== 'Escape' || !R || room.hidden || document.querySelector('dialog[open]')) return;
        const wrap = room.querySelector('.sp-psheet-wrap');
        if (wrap && !wrap.hidden) return closePerson();
        if (R.chatOpen) return openChat(false);
        minimise();
    });
    window.addEventListener('resize', () => { if (R && !room.hidden) setSnap(R.snap, false); });
    // Browsers only play sound after a tap: the first tap anywhere unlocks the room's audio
    document.addEventListener('pointerdown', () => {
        if (!R) return;
        if (R.audioCtx && R.audioCtx.state === 'suspended') R.audioCtx.resume().catch(() => {});
        for (const [, p] of R.peers) if (p.audio && p.audio.paused && p.audio.srcObject) p.audio.play().catch(() => {});
    }, { capture: true });
    window.addEventListener('pagehide', () => { if (R) client.rpc('diary_space_leave', { p_id: R.id }); });

    // ---------- Links: ?space=<id> ----------
    (() => {
        const id = new URLSearchParams(location.search).get('space');
        if (!id || !/^[0-9a-f-]{36}$/i.test(id)) return;
        const url = new URL(location.href);
        url.searchParams.delete('space');
        history.replaceState(history.state, '', url.pathname + url.search + url.hash);
        let tries = 0;
        const wait = setInterval(() => {
            if (me()) { clearInterval(wait); enter(id); }
            else if (++tries > 40) { clearInterval(wait); if (I.openAuth) I.openAuth('Sign in to join this live audio room.', 'signin'); }
        }, 500);
    })();

    // ---------- Menu ----------
    const previousMenu = app.hooks.menuItems;
    app.hooks.menuItems = () => {
        const before = previousMenu ? previousMenu() : [];
        if (!R) return before;
        return [{ label: 'Back to your space', icon: 'i-headphones', onClick: expand }, ...before];
    };

    window.diarySpaces = { exploreSection, feedStrip, liveCount: () => { if (!L.loaded) load(); return L.live.length; }, open: enter, refresh: load, current: () => (R ? R.id : null) };
});
