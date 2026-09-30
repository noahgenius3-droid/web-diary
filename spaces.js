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
        if (['spaces', 'explore'].includes(app.state.view)) app.render();
    }
    setInterval(() => { if (!document.hidden && ['spaces', 'explore'].includes(app.state.view)) load(); }, 30000);

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
            ping: null, audioCtx: null, meters: new Map(), speaking: new Set(), minimised: false, reconnects: 0, meterTimer: null
        };
        openChannel();
        R.ping = setInterval(heartbeat, 20000);
        heartbeat();
        R.meterTimer = setInterval(measure, 250);
        expand();
        if (['spaces', 'explore'].includes(app.state.view)) app.render();
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
        return { name: p.display_name || 'Someone', username: p.username || '', avatar_path: p.avatar_path || null, hand: R.hand, muted: R.muted || !R.mic, sess: R.sess };
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
            .subscribe(async st => {
                if (R !== c || c.channel !== channel) return;
                if (st === 'SUBSCRIBED') {
                    c.ready = true;
                    c.reconnects = 0;
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
        if (changed) room.querySelectorAll('.sp-person').forEach(el => el.classList.toggle('talking', next.has(el.dataset.id)));
    }

    // ---------- Host tools ----------
    async function setRole(id, role, done) {
        const { error } = await client.rpc('diary_space_set_role', { p_id: R.id, p_user: id, p_role: role });
        if (error) return app.showToast(error.message);
        send('roles', {});
        if (id !== me()) send('control', { to: id, action: 'hand-down' });
        await heartbeat();
        if (done) app.showToast(done);
    }

    function onControl(msg) {
        if (msg.action === 'mute' && R.mic && !R.muted) {
            R.muted = true;
            R.mic.getAudioTracks().forEach(t => { t.enabled = false; });
            publish();
            paint();
            app.showToast('A host muted you');
        } else if (msg.action === 'hand-down' && R.hand) {
            R.hand = false;
            publish();
            paint();
        } else if (msg.action === 'remove') {
            app.showToast('You were removed from the room');
            leave(false);
        }
    }

    function personMenu(anchor, id) {
        const meta = R.people.get(id) || {};
        const role = roleOf(id);
        const mineRole = roleOf(me());
        const name = String(meta.name || 'them').split(' ')[0];
        const items = [{ label: 'View profile', icon: 'i-user', onClick: () => { minimise(); window.diaryProfile ? window.diaryProfile.open(id) : app.setView('profile', { profileId: id }); } }];
        if (id === me()) {
            if (role === 'speaker' || role === 'cohost') items.push({ label: 'Move to the audience', icon: 'i-users', onClick: () => setRole(me(), null) });
            return app.openPopover(anchor, items);
        }
        if (['host', 'cohost'].includes(mineRole) && role !== 'host') {
            if (role === 'listener') items.push({ label: `Invite ${name} to speak`, icon: 'i-mic', onClick: () => setRole(id, 'speaker', `${name} is on stage`) });
            if (role === 'speaker' || (role === 'cohost' && mineRole === 'host')) items.push({ label: 'Move to the audience', icon: 'i-users', onClick: () => setRole(id, null) });
            if (mineRole === 'host' && role !== 'cohost') items.push({ label: `Make ${name} a co-host`, icon: 'i-shield', onClick: () => setRole(id, 'cohost', `${name} is a co-host`) });
            if (mineRole === 'host' && role === 'cohost') items.push({ label: 'Make a speaker instead', icon: 'i-mic', onClick: () => setRole(id, 'speaker') });
            if (role !== 'listener' && !meta.muted) items.push({ label: `Mute ${name}`, icon: 'i-mic-off', onClick: () => send('control', { to: id, action: 'mute' }) });
            if (mineRole === 'host' || role !== 'cohost') items.push({ label: `Remove ${name} from the room`, icon: 'i-trash', danger: true, onClick: async () => {
                if (!(await app.ask({ title: `Remove ${name}?`, text: `${name} leaves the room and can’t come back into it.`, ok: 'Remove', danger: true }))) return;
                const { error } = await client.rpc('diary_space_remove', { p_id: R.id, p_user: id });
                if (error) return app.showToast(error.message);
                send('control', { to: id, action: 'remove' });
                heartbeat();
            } });
        }
        app.openPopover(anchor, items);
    }

    function roomMenu(anchor) {
        const items = [{ label: 'Share room link', icon: 'i-share', onClick: () => share(R.id) }];
        if (roleOf(me()) === 'host') items.push({ label: 'Edit room', icon: 'i-pencil', onClick: async () => { if (await editor(R.info)) heartbeat(); } });
        if (onStage(me()) && roleOf(me()) !== 'host') items.push({ label: 'Move to the audience', icon: 'i-users', onClick: () => setRole(me(), null) });
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
    function react(emoji) {
        send('react', { from: me(), emoji });
        floatReaction(me(), emoji);
    }
    function floatReaction(from, emoji) {
        if (!REACTIONS.includes(emoji)) return;
        const tile = room.querySelector(`.sp-person[data-id="${CSS.escape(from)}"] .sp-av`);
        if (!tile) return;
        const e = document.createElement('span');
        e.className = 'sp-float';
        e.textContent = emoji;
        tile.append(e);
        setTimeout(() => e.remove(), 1800);
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
        room.hidden = true;
        mini.hidden = true;
        document.body.classList.remove('sp-open', 'sp-mini-on');
        if (!quiet) app.render();
    }

    async function leaveClicked() {
        if (roleOf(me()) === 'host' && R.people.size > 1) {
            const cohost = [...R.people.keys()].some(id => roleOf(id) === 'cohost');
            const end = await app.ask({
                title: 'Leave the room?',
                text: cohost ? 'Your co-host keeps it going while you’re away. Or end it for everyone.' : 'The room stays open for a few minutes so you can come back. Or end it for everyone now.',
                ok: 'End for everyone', danger: true
            });
            if (end) return endRoom();
            if (!R) return;
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
        const badge = role === 'host' ? '<span class="sp-badge host" title="Host">★</span>' : role === 'cohost' ? '<span class="sp-badge host" title="Co-host">★</span>' : '';
        const muted = role !== 'listener' && meta.muted ? `<span class="sp-muted" aria-label="Muted">${ic('i-mic-off')}</span>` : '';
        const hand = role === 'listener' && meta.hand ? '<span class="sp-hand" aria-label="Hand raised">✋</span>' : '';
        return `
            <button type="button" class="sp-person${R.speaking.has(id) ? ' talking' : ''}" data-id="${esc(id)}" aria-label="${esc(meta.name || 'Someone')}${role !== 'listener' ? `, ${role}` : ''}">
                <span class="sp-av">${avatar(p, 'lg')}${muted}${hand}</span>
                <span class="sp-name">${badge}${id === me() ? 'You' : first(meta.name)}</span>
            </button>`;
    }

    function paint(note) {
        if (!R) return;
        const x = R.info;
        const mineRole = roleOf(me());
        const ids = [...R.people.keys()];
        if (!ids.includes(me())) ids.push(me()); // show yourself before presence catches up
        if (!R.people.has(me())) R.people.set(me(), myMeta());
        const order = { host: 0, cohost: 1, speaker: 2 };
        const stage = ids.filter(onStage).sort((a, b) => order[roleOf(a)] - order[roleOf(b)]);
        const audience = ids.filter(id => !onStage(id)).sort((a, b) => (R.people.get(b)?.hand ? 1 : 0) - (R.people.get(a)?.hand ? 1 : 0));
        const hands = audience.filter(id => (R.people.get(id) || {}).hand);
        const speaker = onStage(me());

        mini.className = `sp-mini theme-${esc(x.theme || 'violet')}`;
        mini.innerHTML = `
            <button type="button" class="sp-mini-open" aria-label="Open the room">
                <span class="sp-live"><i aria-hidden="true"></i>LIVE</span>
                <span class="sp-mini-text"><strong>${esc(x.title)}</strong><small>${stage.length} on stage · ${ids.length} in the room</small></span>
            </button>
            ${speaker ? `<button type="button" class="sp-round${R.muted ? '' : ' on'}" data-sp="mic" aria-label="${R.muted ? 'Unmute' : 'Mute'}">${ic(R.muted ? 'i-mic-off' : 'i-mic')}</button>` : ''}
            <button type="button" class="sp-round leave" data-sp="leave" aria-label="Leave the room">${ic('i-close')}</button>`;

        if (room.hidden) return;
        room.className = `sp-room theme-${esc(x.theme || 'violet')}`;
        room.innerHTML = `
            <div class="sp-sheet">
                <header class="sp-room-head">
                    <button type="button" class="sp-icon sp-room-close" data-sp="minimise" aria-label="Minimise — keep listening">${ic('i-chevron-down')}</button>
                    <span class="sp-live"><i aria-hidden="true"></i>LIVE</span>
                    <span class="sp-head-count">${ids.length} in the room</span>
                    <button type="button" class="sp-icon" data-sp="menu" aria-label="Room options">${ic('i-more')}</button>
                </header>
                <div class="sp-room-body">
                    <div class="sp-room-title">
                        ${x.topic ? `<span class="sp-topic">${esc(x.topic)}</span>` : ''}
                        <h2>${esc(x.title)}</h2>
                        ${x.about ? `<p>${esc(x.about)}</p>` : ''}
                    </div>
                    ${note ? `<p class="sp-note" role="status">${esc(note)}</p>` : ''}
                    ${isHost() && hands.length ? `
                        <section class="sp-hands" aria-label="Raised hands">
                            <h4>✋ ${hands.length} ${hands.length === 1 ? 'hand' : 'hands'} raised</h4>
                            ${hands.map(id => `<div class="sp-hand-row">${avatar({ id, display_name: R.people.get(id).name, avatar_path: R.people.get(id).avatar_path }, 'sm')}
                                <span>${esc(R.people.get(id).name || 'Someone')}</span>
                                <button type="button" class="sp-invite" data-sp="invite" data-id="${esc(id)}">Invite to speak</button></div>`).join('')}
                        </section>` : ''}
                    <h4 class="sp-sec-h">On stage · ${stage.length}</h4>
                    <div class="sp-people stage">${stage.map(tile).join('')}</div>
                    <h4 class="sp-sec-h">Listening · ${audience.length}</h4>
                    ${audience.length ? `<div class="sp-people">${audience.map(tile).join('')}</div>` : `<p class="muted sp-empty-aud">No listeners yet. ${mineRole === 'host' ? 'Share the link to bring people in.' : ''}</p>`}
                </div>
                <footer class="sp-room-foot">
                    <button type="button" class="sp-leave" data-sp="leave">✌️ Leave quietly</button>
                    <div class="sp-react" role="group" aria-label="React">${REACTIONS.slice(0, 3).map(e => `<button type="button" class="sp-emoji" data-sp="react" data-emoji="${e}" aria-label="React ${e}">${e}</button>`).join('')}</div>
                    ${speaker
                        ? `<button type="button" class="sp-round big${R.muted ? '' : ' on'}" data-sp="mic" aria-label="${R.muted ? 'Unmute' : 'Mute'}" aria-pressed="${!R.muted}">${ic(R.muted ? 'i-mic-off' : 'i-mic')}</button>`
                        : `<button type="button" class="sp-round big${R.hand ? ' on' : ''}" data-sp="hand" aria-label="${R.hand ? 'Lower your hand' : 'Raise your hand to speak'}" aria-pressed="${R.hand}"><span aria-hidden="true">✋</span></button>`}
                </footer>
            </div>`;
    }

    const onRoomClick = async e => {
        if (!R) return;
        const person = e.target.closest('.sp-person');
        if (person) return personMenu(person, person.dataset.id);
        if (e.target.closest('.sp-mini-open')) return expand();
        const el = e.target.closest('[data-sp]');
        if (!el) {
            if (e.target === room) minimise();
            return;
        }
        const what = el.dataset.sp;
        if (what === 'minimise') minimise();
        else if (what === 'menu') roomMenu(el);
        else if (what === 'leave') leaveClicked();
        else if (what === 'mic') toggleMic();
        else if (what === 'react') react(el.dataset.emoji);
        else if (what === 'invite') setRole(el.dataset.id, 'speaker', `${String((R.people.get(el.dataset.id) || {}).name || 'They').split(' ')[0]} is on stage`);
        else if (what === 'hand') {
            R.hand = !R.hand;
            publish();
            paint();
            app.showToast(R.hand ? 'Hand raised — the hosts can invite you up' : 'Hand lowered');
        }
    };
    room.addEventListener('click', onRoomClick);
    mini.addEventListener('click', onRoomClick);
    document.addEventListener('keydown', e => { if (e.key === 'Escape' && R && !room.hidden && !document.querySelector('dialog[open]')) minimise(); });
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

    window.diarySpaces = { exploreSection, open: enter, refresh: load, current: () => (R ? R.id : null) };
});
