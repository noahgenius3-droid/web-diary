// Calls: one-to-one and group (community) calls with voice, video and screen sharing. WebRTC mesh —
// everyone connects to everyone, which suits small groups.
// Signalling runs over Supabase Realtime *private* channels, authorised by RLS on realtime.messages:
//   diary_call:c:<community id>   group call room (members only)
//   diary_call:d:<a>:<b>          one-to-one room (those two only)
//   diary_ring:<user id>          incoming-call rings (only that user listens)
//
// Every connection carries three tracks from the start — microphone, camera and screen — so turning the
// camera or a screen share on and off just swaps a track (no renegotiation, nothing to drop).
// The call lives outside the page, so it keeps going while you move around the app; minimised, it
// becomes a small floating window you can drag, and a video can pop out into the system's
// picture-in-picture window to stay on top of other apps where the device allows it.
document.addEventListener('DOMContentLoaded', () => {
    const app = window.diaryApp;
    const social = window.diarySocial;
    const I = social && social.internals;
    if (!I || !window.RTCPeerConnection) return;
    const { client, state: s, esc, avatar } = I;
    const $ = id => document.getElementById(id);
    const cfg = window.DIARY_CONFIG || {};
    const ICE = cfg.iceServers || [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }];
    const RING_TIMEOUT = 45000;
    const COMFORTABLE_SIZE = 12;   // mesh calls get heavy beyond this
    const VIDEO_COMFORTABLE = 6;   // …and much sooner with video
    const REACTIONS = ['👏', '❤️', '😂', '👍', '🎉', '😮'];
    const canShare = !!(navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia);
    const canPip = !!document.pictureInPictureEnabled;

    let call = null;        // the active call
    let held = null;        // a call on hold while you take another
    let ringChannel = null; // listens for incoming calls
    let incoming = null;    // an unanswered incoming call
    const watchers = new Map(); // topic -> { channel, listeners:Set, people }
    const closing = new Map();  // topic -> promise that settles once the old channel is gone

    // Supabase hands back the *existing* channel when a topic is already open, and forgets channels by
    // topic when they close — so a topic must never have two channels. Close the old one and wait for it.
    function dropChannel(channel) {
        if (!channel) return Promise.resolve();
        const topic = channel.topic.replace(/^realtime:/, '');
        const done = client.removeChannel(channel).catch(() => {}).then(() => {
            if (closing.get(topic) === done) closing.delete(topic);
        });
        closing.set(topic, done);
        return done;
    }
    async function freeTopic(topic) {
        const w = watchers.get(topic);
        if (w && w.channel) {
            const ch = w.channel;
            w.channel = null;
            dropChannel(ch);
        }
        const until = Date.now() + 2000;
        while (Date.now() < until) {
            if (closing.has(topic)) await Promise.race([closing.get(topic), new Promise(r => setTimeout(r, 300))]);
            else if (client.getChannels().some(c => c.topic === `realtime:${topic}`)) await new Promise(r => setTimeout(r, 100));
            else break;
        }
        // The server never confirmed the close (a flaky connection): forget the old channel ourselves
        client.getChannels().filter(c => c.topic === `realtime:${topic}`).forEach(forget);
        closing.delete(topic);
    }
    function forget(ch) {
        try { if (ch.teardown) ch.teardown(); } catch (e) { /* already gone */ }
        const rt = client.realtime;
        if (rt && typeof rt._remove === 'function') rt._remove(ch);
        else if (rt && Array.isArray(rt.channels)) rt.channels = rt.channels.filter(c => c !== ch);
    }
    // A brand-new channel with our own presence key — never someone else's leftover
    function newChannel(topic, config) {
        let ch = client.channel(topic, { config });
        const keyOf = c => c && c.params && c.params.config && c.params.config.presence ? c.params.config.presence.key : undefined;
        if (config.presence && keyOf(ch) !== config.presence.key) {
            forget(ch);
            ch = client.channel(topic, { config });
        }
        return ch;
    }
    const roomOn = topic => [call, held].find(c => c && c.topic === topic) || null;
    function openWatch(topic, w) {
        if (w.channel || roomOn(topic) || closing.has(topic)) return;
        const channel = newChannel(topic, { private: true, presence: { key: `watch-${me()}-${Math.random().toString(36).slice(2, 6)}` } });
        w.channel = channel;
        channel.on('presence', { event: 'sync' }, () => {
            if (w.channel !== channel) return;
            feedWatchers(topic, Object.entries(channel.presenceState()));
        }).subscribe();
    }
    function feedWatchers(topic, entries) {
        const w = watchers.get(topic);
        if (!w) return;
        w.people = entries.filter(([key]) => !key.startsWith('watch-')).map(([key, meta]) => ({ id: key, ...((Array.isArray(meta) ? meta[0] : meta) || {}) }));
        w.listeners.forEach(fn => fn(w.people));
    }

    const me = () => s.profile && s.profile.id;
    const myMeta = () => ({
        name: s.profile.display_name,
        avatar_path: s.profile.avatar_path || null,
        muted: call ? call.muted : false,
        hand: call ? call.hand : false,
        rec: !!(call && call.recorder),
        held: false,
        cam: !!(call && call.cam),
        screen: call && call.screen ? (call.screenPaused ? 'paused' : 'on') : false
    });
    const dmTopic = otherId => `diary_call:d:${[me(), otherId].sort().join(':')}`;
    const communityOf = topic => (topic && topic.startsWith('diary_call:c:') ? topic.split(':')[2] : null);

    // ---------- Public API ----------
    window.diaryCalls = {
        joinCommunity(cm, opts = {}) {
            join(`diary_call:c:${cm.id}`, { title: cm.name, subtitle: 'Group call', emoji: cm.emoji, communityId: cm.id }, opts);
        },
        callUser(person, opts = {}) {
            startDirect(person, opts);
        },
        // Observe who's in a community call without joining (for the "Join call · 3" button)
        watch(topic, listener) {
            let w = watchers.get(topic);
            if (!w) {
                w = { channel: null, listeners: new Set(), people: [] };
                watchers.set(topic, w);
                // While you're in this call, its own room tells us who's there
                const room = roomOn(topic);
                if (room && room.people) feedWatchers(topic, [...room.people.entries()]);
                else openWatch(topic, w);
            }
            w.listeners.add(listener);
            listener(w.people);
            return () => {
                w.listeners.delete(listener);
                if (!w.listeners.size && watchers.get(topic) === w) {
                    watchers.delete(topic);
                    dropChannel(w.channel);
                    w.channel = null;
                }
            };
        },
        // Someone started a call in one of your groups: ring like a normal incoming call
        ringGroup(item) {
            const d = (item && item.data) || {};
            if (!d.community_id || !item.actor || item.actor === me()) return false;
            if (Date.now() - new Date(item.created_at || Date.now()).getTime() > 90000) return false; // old news
            const topic = `diary_call:c:${d.community_id}`;
            if ((call && call.topic === topic) || (held && held.topic === topic) || incoming) return false;
            const who = item.actor_profile || {};
            onRing({ from: item.actor, name: who.display_name || 'Someone', avatar_path: who.avatar_path || null, topic, group: d.community_name || 'your group', emoji: d.emoji, video: !!d.video });
            return !!incoming;
        },
        topicFor: cm => `diary_call:c:${cm.id}`,
        historyHTML, refreshHistory: () => { history.list = null; loadHistory(); },
        activeTopic: () => (call ? call.topic : null),
        inCall: () => !!call
    };

    // ---------- Call history ----------
    function logCall(entry) {
        if (!me()) return;
        client.from('diary_call_log').insert({
            direction: entry.direction, status: entry.status, video: !!entry.video,
            peer: entry.peer || null, community_id: entry.communityId || null,
            title: (entry.title || '').slice(0, 120), participants: entry.participants || 2,
            started_at: entry.started_at || new Date().toISOString(), duration: Math.max(0, Math.round(entry.duration || 0))
        }).then(() => { history.list = null; }, () => {});
    }

    const history = { list: null, recordings: null, loading: false, people: new Map() };
    async function loadHistory() {
        if (history.loading) return;
        history.loading = true;
        const [log, recs] = await Promise.all([
            client.from('diary_call_log').select('*').order('started_at', { ascending: false }).limit(100),
            client.from('diary_call_recordings').select('*').order('created_at', { ascending: false }).limit(50)
        ]);
        history.loading = false;
        history.list = log.data || [];
        history.recordings = recs.data || [];
        const ids = [...new Set(history.list.map(x => x.peer).filter(Boolean))];
        if (ids.length) {
            const { data } = await client.from('diary_profiles').select('id, username, display_name, avatar_path').in('id', ids);
            history.people = new Map((data || []).map(p => [p.id, p]));
        } else history.people = new Map();
        if (app.state.view === 'messages') app.requestRender('messages');
    }

    const STATUS_TEXT = { answered: '', missed: 'Missed', declined: 'Declined', cancelled: 'Cancelled', no_answer: 'No answer', busy: 'Busy' };
    function historyHTML() {
        if (history.list === null) { loadHistory(); return '<p class="inbox-empty">Loading your calls…</p>'; }
        const rows = history.list.map(x => {
            const person = x.peer ? (history.people.get(x.peer) || { id: x.peer, display_name: x.title || 'Someone' }) : null;
            const name = person ? person.display_name : `${x.title || 'Group call'}`;
            const missed = ['missed', 'no_answer'].includes(x.status) && x.direction === 'in';
            const when = new Date(x.started_at);
            const dur = x.duration ? Media.formatDuration(x.duration) : '';
            const back = x.peer ? `<button type="button" class="convo-call" data-action="call-back" data-id="${esc(x.peer)}" aria-label="Voice call ${esc(name)}"><svg class="i"><use href="#i-phone"/></svg></button><button type="button" class="convo-call" data-action="call-back" data-video="1" data-id="${esc(x.peer)}" aria-label="Video call ${esc(name)}"><svg class="i"><use href="#i-video"/></svg></button>`
                : x.community_id ? `<button type="button" class="convo-call" data-action="call-group" data-id="${esc(x.community_id)}" data-name="${esc(x.title || '')}" aria-label="Join ${esc(name)} call"><svg class="i"><use href="#i-phone"/></svg></button>` : '';
            return `
                <div class="call-row${missed ? ' missed' : ''}">
                    ${person ? `<button type="button" class="chat-who" data-profile="${esc(person.id)}">${avatar(person, 'md')}</button>` : '<span class="call-row-group"><svg class="i"><use href="#i-users"/></svg></span>'}
                    <span class="call-row-text">
                        <strong>${esc(name)}</strong>
                        <small><svg class="i dir"><use href="#${x.direction === 'in' ? 'i-down' : 'i-send'}"/></svg>${x.video ? 'Video' : 'Voice'} · ${esc(STATUS_TEXT[x.status] || (x.direction === 'in' ? 'Incoming' : 'Outgoing'))}${dur ? ` · ${dur}` : ''}${x.participants > 2 ? ` · ${x.participants} people` : ''}</small>
                        <time>${esc(when.toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }))}</time>
                    </span>
                    ${back}
                </div>`;
        }).join('');
        const recs = (history.recordings || []).map(r => `
            <div class="call-row rec">
                <span class="call-row-group rec"><svg class="i"><use href="#i-record"/></svg></span>
                <span class="call-row-text"><strong>${esc(r.title || 'Call recording')}</strong><small>${r.duration ? Media.formatDuration(r.duration) : ''} · ${esc(Media.formatSize(r.size || 0))}</small><time>${esc(new Date(r.created_at).toLocaleString())}</time></span>
                <button type="button" class="convo-call" data-action="rec-play" data-path="${esc(r.path)}" aria-label="Play recording"><svg class="i"><use href="#i-play"/></svg></button>
                <button type="button" class="convo-call" data-action="rec-download" data-path="${esc(r.path)}" data-name="${esc((r.title || 'call') + (r.mime && r.mime.startsWith('video') ? '.webm' : '.webm'))}" aria-label="Download recording"><svg class="i"><use href="#i-download"/></svg></button>
                <button type="button" class="convo-call danger" data-action="rec-delete" data-id="${esc(r.id)}" data-path="${esc(r.path)}" aria-label="Delete recording"><svg class="i"><use href="#i-trash"/></svg></button>
            </div>`).join('');
        return `${rows || '<p class="inbox-empty">No calls yet. Call a friend from their chat.</p>'}${recs ? `<h4 class="info-label call-rec-label">Recordings</h4>${recs}` : ''}`;
    }

    // ---------- Ringing ----------
    // The ring as Cordial's alert server signed it: { i: ring id, c: caller, e: callee, t: topic, v: video, x: rings until }
    function readRing(token) {
        try {
            const r = JSON.parse(decodeURIComponent(escape(atob(token.split('.')[0].replace(/-/g, '+').replace(/_/g, '/')))));
            return r && r.c && r.t ? r : null;
        } catch (e) { return null; }
    }

    // Opened from a call alert (/?ring=<signed ring>, with &answer=1 from the Answer button): ring here if it still is
    async function openFromAlert(token, answerNow) {
        const r = readRing(token);
        if (!r) return;
        for (let i = 0; i < 40 && !me(); i++) await new Promise(res => setTimeout(res, 250)); // wait for sign-in
        if (!me() || me() !== r.e) return;
        const known = (s.friends || []).find(f => f.id === r.c);
        const who = known || (await client.from('diary_profiles').select('id, display_name, avatar_path').eq('id', r.c).maybeSingle()).data || {};
        if (Date.now() > r.x) return app.showToast(`Missed call from ${who.display_name || 'someone'}`);
        if (call && call.topic === r.t) return;
        onRing({ from: r.c, name: who.display_name || 'Someone', avatar_path: who.avatar_path || null, topic: r.t, video: !!r.v, srv: true });
        if (answerNow) answer(false);
    }
    function ringFromUrl(href) {
        const url = new URL(href, location.origin);
        const token = url.searchParams.get('ring');
        if (!token || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)) return false;
        openFromAlert(token, url.searchParams.get('answer') === '1');
        return true;
    }
    if (ringFromUrl(location.href)) history.replaceState(history.state, '', location.pathname + location.hash);
    // Cordial already open: the service worker asks it to go to the alert's address
    if ('serviceWorker' in navigator) navigator.serviceWorker.addEventListener('message', e => {
        const d = e.data || {};
        if (d.type === 'open-url' && d.url && ringFromUrl(d.url) && e.ports && e.ports[0]) e.ports[0].postMessage('ok');
    });

    setInterval(() => {
        const id = me();
        if (id && (!ringChannel || ringChannel.topic !== `realtime:diary_ring:${id}`)) listenForRings(id);
        if (!id && ringChannel) {
            client.removeChannel(ringChannel);
            ringChannel = null;
        }
    }, 1500);

    function listenForRings(id) {
        if (ringChannel) client.removeChannel(ringChannel);
        ringChannel = client.channel(`diary_ring:${id}`, { config: { private: true } })
            .on('broadcast', { event: 'ring' }, ({ payload }) => onRing(payload))
            .on('broadcast', { event: 'cancel' }, ({ payload }) => {
                if (incoming && incoming.from === payload.from) dismissIncoming(true);
            })
            .on('broadcast', { event: 'decline' }, ({ payload }) => {
                if (call && call.ringing === payload.from) {
                    call.endStatus = payload.busy ? 'busy' : 'declined';
                    paintPanel(payload.busy ? `${call.title} is on another call` : `${call.title} declined`);
                    setTimeout(() => leave(false), 1400);
                }
            })
            .subscribe();
    }

    // Send to someone else's ring channel without listening on it (HTTP broadcast)
    // Always a brand-new channel: calling the same person again straight away must never reuse the last one
    // (Supabase hands back an existing channel with the same name, even one that's already closing)
    async function ring(userId, event, payload) {
        const topic = `diary_ring:${userId}`;
        client.getChannels().filter(c => c.topic === `realtime:${topic}`).forEach(forget);
        const channel = client.channel(topic, { config: { private: true } });
        try {
            await channel.send({ type: 'broadcast', event, payload });
        } finally {
            forget(channel);
            client.removeChannel(channel).catch(() => {});
        }
    }

    function onRing(p) {
        if (!p || !p.topic || !p.from) return;
        if (call && call.topic === p.topic) return; // already in that call
        if (incoming && incoming.from === p.from && !p.group) dismissIncoming(true); // they called again: the new ring replaces the old one
        if (incoming) { // already ringing with someone else: they get "busy"
            if (p.group) return; // a group call carries on without us; the banner still shows it
            ring(p.from, 'decline', { from: me(), busy: true });
            logCall({ direction: 'in', status: 'busy', peer: p.group ? null : p.from, communityId: communityOf(p.topic), title: p.group || p.name, video: p.video });
            return;
        }
        incoming = { ...p, waiting: !!call, timer: setTimeout(() => dismissIncoming(true), RING_TIMEOUT) };
        $('incoming-avatar').innerHTML = avatar({ id: p.from, display_name: p.name, avatar_path: p.avatar_path }, 'xl');
        $('incoming-name').textContent = p.group ? `${p.emoji || '📞'} ${p.group}` : (p.name || 'Someone');
        $('incoming-sub').textContent = p.group
            ? `${p.name} is inviting you to the group ${p.video ? 'video ' : ''}call`
            : p.video ? 'Cordial video call…' : 'Cordial voice call…';
        $('incoming-video').hidden = !p.video || !!call;
        // Already on a call: answer by ending it, or put it on hold
        $('incoming-hold').hidden = !call;
        $('incoming-accept').setAttribute('title', call ? 'End current call & answer' : 'Answer');
        $('incoming-waiting').hidden = !call;
        if (call) $('incoming-waiting').textContent = `You’re on a call with ${call.title}`;
        $('incoming-accept').setAttribute('aria-label', p.video ? 'Answer with voice only' : 'Answer');
        $('call-incoming').hidden = false;
        // Do not disturb: the call shows, quietly
        const dnd = I.statusOf && s.myStatus === 'dnd';
        if (call) tone([880, 660], 0.2, 0.15, 0.1);
        else if (!dnd) {
            startRingtone();
            if (navigator.vibrate) navigator.vibrate([400, 200, 400]);
        }
    }

    function dismissIncoming(missed) {
        if (!incoming) return;
        clearTimeout(incoming.timer);
        if (missed) {
            const from = incoming.group ? null : incoming.from;
            if (!incoming.srv && from && window.diaryNotify) window.diaryNotify.logMissedCall(from);
            app.showToast(`Missed ${incoming.group ? `${incoming.group} call` : incoming.video ? 'video call' : 'call'} from ${incoming.name}`);
            logCall({ direction: 'in', status: 'missed', peer: incoming.group ? null : incoming.from, communityId: communityOf(incoming.topic), title: incoming.group || incoming.name, video: incoming.video });
        }
        incoming = null;
        $('call-incoming').hidden = true;
        stopRingtone();
    }

    async function answer(withVideo, holdCurrent = false) {
        if (!incoming) return;
        const p = incoming;
        dismissIncoming(false);
        if (call) {
            if (holdCurrent) hold();
            else leave(true);
        }
        join(p.topic, p.group
            ? { title: p.group, subtitle: 'Group call', emoji: p.emoji, communityId: communityOf(p.topic) }
            : { title: p.name, subtitle: p.video ? 'Video call' : 'Voice call', person: { id: p.from, display_name: p.name, avatar_path: p.avatar_path } },
        { video: withVideo, log: { direction: 'in', peer: p.group ? null : p.from, video: withVideo || p.video } });
    }
    $('incoming-accept').addEventListener('click', () => answer(false));
    $('incoming-video').addEventListener('click', () => answer(true));
    $('incoming-hold').addEventListener('click', () => answer(false, true));
    $('incoming-decline').addEventListener('click', () => {
        if (!incoming) return;
        if (!incoming.group) ring(incoming.from, 'decline', { from: me() });
        logCall({ direction: 'in', status: 'declined', peer: incoming.group ? null : incoming.from, communityId: communityOf(incoming.topic), title: incoming.group || incoming.name, video: incoming.video });
        dismissIncoming(false);
    });

    async function startDirect(person, opts = {}) {
        if (!me()) return;
        unlockSound(); // iPhones only allow sound that starts from a tap: wake the sound engine now, before any waiting
        const ok = await join(dmTopic(person.id), { title: person.display_name, subtitle: opts.video ? 'Video call' : 'Voice call', person }, { ...opts, log: { direction: 'out', peer: person.id, video: !!opts.video } });
        if (!ok) return;
        call.ringing = person.id;
        startRingback();
        paintPanel();
        call.ringTimer = setTimeout(() => {
            if (call && call.ringing === person.id) {
                call.endStatus = 'no_answer';
                stopRingback();
                paintPanel(`${person.display_name} didn’t answer`);
                setTimeout(() => leave(true), 1400);
            }
        }, RING_TIMEOUT);
        // The server-side ring: reaches their phone as an alert even when Cordial is closed there
        const placed = call;
        const server = I && I.alertServer
            ? await Promise.race([I.alertServer('ring', { callee: person.id, topic: call.topic, video: !!opts.video }), new Promise(r => setTimeout(() => r(null), 2500))])
            : null;
        if (call !== placed) return; // hung up while we were reaching the server
        if (server && server.ok) call.serverRing = server.ring;
        try {
            await ring(person.id, 'ring', { from: me(), name: s.profile.display_name, avatar_path: s.profile.avatar_path || null, topic: call.topic, video: !!opts.video, srv: !!call.serverRing });
        } catch (e) {
            app.showToast('Couldn’t reach them right now');
            leave(false);
        }
    }

    // ---------- Permissions ----------
    // Friendly words for the browser's permission errors
    function mediaError(e, what) {
        const name = e && e.name;
        if (name === 'NotAllowedError' || name === 'SecurityError') return `Allow ${what} access for Cordial in your browser’s site settings, then try again`;
        if (name === 'NotFoundError' || name === 'OverconstrainedError') return `No ${what} found on this device`;
        if (name === 'NotReadableError') return `Your ${what} is being used by another app`;
        return `Couldn’t start your ${what}`;
    }

    async function getCamera(facing = 'user') {
        const track = (await navigator.mediaDevices.getUserMedia({
            video: { facingMode: facing, width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30, max: 30 } }
        })).getVideoTracks()[0];
        if (track && 'contentHint' in track) track.contentHint = 'motion';
        return track;
    }

    // ---------- Picture quality ----------
    // Everyone sends to everyone, so each camera's upload is shared across the call: one-to-one gets HD at a
    // generous bitrate, bigger calls scale each copy down a little instead of freezing. A shared screen keeps
    // its sharpness (text must stay readable) and gives up smoothness first.
    function tuneSenders() {
        if (!call) return;
        const n = Math.max(1, call.peers.size);
        const camBitrate = n <= 1 ? 2500000 : n === 2 ? 1500000 : Math.max(350000, Math.round(4000000 / n));
        const camScale = n <= 2 ? 1 : n <= 4 ? 1.5 : 2;
        const tune = (sender, enc, pref) => {
            if (!sender || !sender.getParameters || !sender.setParameters) return;
            try {
                const params = sender.getParameters();
                if (!params.encodings || !params.encodings.length) params.encodings = [{}];
                Object.assign(params.encodings[0], enc);
                params.degradationPreference = pref;
                sender.setParameters(params).catch(() => {});
            } catch (e) { /* older browsers keep their defaults */ }
        };
        call.peers.forEach(peer => {
            const tr = peer.pc.getTransceivers();
            if (tr[1]) tune(tr[1].sender, { maxBitrate: camBitrate, maxFramerate: 30, scaleResolutionDownBy: camScale }, 'balanced');
            if (tr[2]) tune(tr[2].sender, { maxBitrate: 1500000, maxFramerate: 15 }, 'maintain-resolution');
        });
    }

    // ---------- Joining a room ----------
    async function join(topic, info, opts = {}) {
        if (held && held.topic === topic) return switchCalls();
        if (call) {
            if (call.topic === topic) return expand();
            leave(true);
        }
        let local;
        try {
            local = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
        } catch (e) {
            app.showToast(mediaError(e, 'microphone'));
            return false;
        }
        let cam = null;
        if (opts.video) {
            try { cam = await getCamera('user'); } catch (e) { app.showToast(`${mediaError(e, 'camera')} — joining with voice only`); }
        }

        call = {
            topic, ...info, local, cam, facing: 'user', screen: null, screenPaused: false,
            muted: false, hand: false, speaker: true, sinkId: '',
            peers: new Map(),      // user id -> { pc, audio, camVideo, screenVideo, queue, remoteSet, quality }
            people: new Map(),     // user id -> presence meta
            started: null, ringing: null, ringTimer: null, tick: null, stats: null,
            audioCtx: null, meters: new Map(), synced: false, notified: false,
            reconnects: 0, channelReady: false, amModerator: false, wake: null, focus: null,
            log: opts.log || { direction: 'out', communityId: info.communityId || null, video: !!opts.video }, maxPeople: 1, endStatus: null, recorder: null
        };
        setupMeter(me(), local);
        openChannel();
        keepAwake();
        mediaSession();
        if (call.communityId) isModerator(call.communityId, me()).then(v => { if (call) call.amModerator = v; });

        showPanel();
        call.tick = setInterval(() => paintPanel(), 1000);
        call.stats = setInterval(checkQuality, 3000);
        app.requestRender ? app.requestRender() : app.render(); // e.g. the community header switches to "You’re in the call"
        return true;
    }

    async function openChannel() {
        const c = call;
        c.channel = null;
        c.channelReady = false;
        // The community page may be watching this room, or we may have just left it: clear the topic first
        await freeTopic(c.topic);
        if (call !== c && held !== c) return;
        const channel = newChannel(c.topic, { private: true, presence: { key: me() }, broadcast: { self: false } });
        c.channel = channel;
        c.channelReady = false;
        channel
            .on('presence', { event: 'sync' }, () => { if (call === c && c.channel === channel) syncPeers(); })
            .on('broadcast', { event: 'signal' }, ({ payload }) => { if (call === c) onSignal(payload); })
            .on('broadcast', { event: 'react' }, ({ payload }) => { if (call === c) showReaction(payload.from, payload.emoji); })
            .on('broadcast', { event: 'control' }, ({ payload }) => { if (call === c) onControl(payload); })
            .subscribe(async status => {
                if (call !== c || c.channel !== channel) return;
                if (status === 'SUBSCRIBED') {
                    c.channelReady = true;
                    c.reconnects = 0;
                    await channel.track(myMeta());
                } else if (['CHANNEL_ERROR', 'TIMED_OUT', 'CLOSED'].includes(status)) {
                    c.channelReady = false;
                    // Media keeps flowing peer-to-peer; only signalling is down. Try to reconnect.
                    if (c.reconnects < 4) {
                        c.reconnects++;
                        paintPanel('Reconnecting…');
                        setTimeout(() => {
                            if (call !== c || c.channel !== channel) return;
                            dropChannel(channel);
                            openChannel();
                        }, 1500 * c.reconnects);
                    } else {
                        app.showToast('Lost connection to the call');
                        leave(false);
                    }
                }
            });
    }

    const publish = () => { if (call && call.channelReady) call.channel.track(myMeta()).catch(() => {}); };

    function syncPeers() {
        const state = call.channel.presenceState();
        const before = call.people.size;
        call.people = new Map(Object.entries(state)
            .filter(([key]) => !key.startsWith('watch-'))
            .map(([key, metas]) => [key, metas[0] || {}]));
        feedWatchers(call.topic, [...call.people.entries()]);

        for (const [id] of call.people) {
            if (id === me() || call.peers.has(id)) continue;
            // The lower id makes the offer so two people never both call each other
            const offerer = me() < id;
            const peer = makePeer(id, offerer);
            if (offerer) makeOffer(id, peer);
        }
        // Only drop peers when signalling is healthy — a reconnect briefly empties presence
        if (call.channelReady) {
            for (const [id] of call.peers) {
                if (!call.people.has(id)) closePeer(id);
            }
        }

        if (!call.synced && call.people.has(me())) {
            call.synced = true;
            // First one in a group call: let the other members know
            if (call.communityId && call.people.size === 1 && !call.notified) {
                call.notified = true;
                client.rpc('diary_notify_call', { p_community: call.communityId, p_video: !!call.cam }).then(() => {});
            }
            const limit = call.cam ? VIDEO_COMFORTABLE : COMFORTABLE_SIZE;
            if (call.people.size > limit) app.showToast(`${call.cam ? 'Video' : 'Group'} calls work best with up to ${limit} people — it may be choppy`);
        } else if (call.synced && before && call.people.size !== before) {
            chime(call.people.size > before ? 'join' : 'leave');
        }

        if (call.people.size > 1 && call.ringing) {
            call.ringing = null;
            stopRingback();
            clearTimeout(call.ringTimer);
        }
        if (call.people.size > 1 && !call.started) call.started = Date.now();
        call.maxPeople = Math.max(call.maxPeople || 1, call.people.size);
        // Someone in the call is recording: everyone sees it
        const recording = [...call.people.entries()].filter(([id, m]) => id !== me() && m.rec).map(([id]) => nameOf(id));
        const rb = $('call-rec-banner');
        if (rb) {
            const mine = !!call.recorder;
            rb.hidden = !recording.length && !mine;
            rb.innerHTML = `<svg class="i"><use href="#i-record"/></svg><span>${mine ? 'You are recording this call' : `${esc(recording.join(', '))} ${recording.length > 1 ? 'are' : 'is'} recording this call`}</span>`;
        }
        paintPanel();
    }

    // Transceiver order is the same on both sides: 0 = microphone, 1 = camera, 2 = screen
    function makePeer(id, offerer) {
        const pc = new RTCPeerConnection({ iceServers: ICE });
        const peer = { pc, audio: null, camVideo: null, screenVideo: null, queue: [], remoteSet: false, quality: 'good', offerer, configured: false };
        call.peers.set(id, peer);
        call.local.getAudioTracks().forEach(t => pc.addTrack(t, call.local));
        if (offerer) {
            pc.addTransceiver('video', { direction: 'sendrecv' });
            pc.addTransceiver('video', { direction: 'sendrecv' });
            applyTracks(peer);
        }

        pc.onicecandidate = e => {
            if (e.candidate) send({ type: 'ice', to: id, candidate: e.candidate.toJSON() });
        };
        pc.ontrack = e => {
            const index = pc.getTransceivers().indexOf(e.transceiver);
            const track = e.track;
            if (track.kind === 'audio') {
                if (!peer.audio) {
                    peer.audio = document.createElement('audio');
                    peer.audio.autoplay = true;
                    peer.audio.setAttribute('playsinline', '');
                    peer.audio.muted = !call.speaker;
                    if (call.sinkId && peer.audio.setSinkId) peer.audio.setSinkId(call.sinkId).catch(() => {});
                    $('call-audio').append(peer.audio);
                }
                const stream = e.streams[0] || new MediaStream([track]);
                peer.audio.srcObject = stream;
                peer.audio.play().catch(() => {});
                setupMeter(id, stream);
                if (call && call.recorder) call.recorder.addStream(stream);
            } else {
                const key = index === 2 ? 'screenVideo' : 'camVideo';
                if (!peer[key]) {
                    const v = document.createElement('video');
                    v.autoplay = true;
                    v.muted = true; // sound comes through the audio element
                    v.setAttribute('playsinline', '');
                    peer[key] = v;
                }
                peer[key].srcObject = new MediaStream([track]);
                peer[key].play().catch(() => {});
                paintPanel();
            }
        };
        pc.onconnectionstatechange = () => {
            if (pc.connectionState === 'connected') tuneSenders();
            if (pc.connectionState === 'failed') {
                // Networks change (Wi-Fi ↔ mobile); try once to recover, then report
                if (!peer.restarted && offerer) {
                    peer.restarted = true;
                    makeOffer(id, peer, true);
                } else {
                    paintPanel(`Couldn’t connect to ${nameOf(id)} — their network may block calls`);
                }
            }
            paintPanel();
        };
        return peer;
    }

    // Put the current camera / screen tracks on a connection's senders
    function applyTracks(peer) {
        const tr = peer.pc.getTransceivers();
        if (tr[1]) tr[1].sender.replaceTrack(call.cam || null).catch(() => {});
        if (tr[2]) tr[2].sender.replaceTrack(call.screen || null).catch(() => {});
        tuneSenders();
    }
    const eachPeer = fn => call && call.peers.forEach(fn);

    async function makeOffer(id, peer, iceRestart = false) {
        try {
            const offer = await peer.pc.createOffer({ iceRestart });
            await peer.pc.setLocalDescription(offer);
            send({ type: 'offer', to: id, sdp: peer.pc.localDescription.toJSON() });
        } catch (e) {
            console.warn('offer failed', e);
        }
    }

    async function onSignal(msg) {
        if (!msg || msg.to !== me() || !msg.from) return;
        let peer = call.peers.get(msg.from);
        try {
            if (msg.type === 'offer') {
                if (!peer) peer = makePeer(msg.from, false);
                await peer.pc.setRemoteDescription(msg.sdp);
                peer.remoteSet = true;
                // The offer created the camera and screen transceivers: send on them too
                if (!peer.configured) {
                    peer.configured = true;
                    peer.pc.getTransceivers().slice(1, 3).forEach(t => { try { t.direction = 'sendrecv'; } catch (e) {} });
                }
                applyTracks(peer);
                await flushIce(peer);
                const answerSdp = await peer.pc.createAnswer();
                await peer.pc.setLocalDescription(answerSdp);
                send({ type: 'answer', to: msg.from, sdp: peer.pc.localDescription.toJSON() });
            } else if (msg.type === 'answer' && peer) {
                await peer.pc.setRemoteDescription(msg.sdp);
                peer.remoteSet = true;
                await flushIce(peer);
            } else if (msg.type === 'ice') {
                if (!peer) peer = makePeer(msg.from, me() < msg.from);
                if (peer.remoteSet) await peer.pc.addIceCandidate(msg.candidate);
                else peer.queue.push(msg.candidate);
            }
        } catch (e) {
            console.warn('signal failed', msg.type, e);
        }
    }

    async function flushIce(peer) {
        while (peer.queue.length) {
            try { await peer.pc.addIceCandidate(peer.queue.shift()); } catch (e) { /* stale candidate */ }
        }
    }

    function send(payload, event = 'signal') {
        if (!call || !call.channel) return;
        call.channel.send({ type: 'broadcast', event, payload: { ...payload, from: me() } });
    }

    function closePeer(id) {
        const peer = call.peers.get(id);
        if (!peer) return;
        peer.pc.close();
        if (peer.audio) peer.audio.remove();
        call.peers.delete(id);
        tuneSenders();
        call.meters.delete(id);
        if (call.focus === id) call.focus = null;
    }

    function leave(notify, target = call) {
        const earBox = document.getElementById('call-ear');
        if (earBox) earBox.hidden = true;
        if (!target) return;
        const c = target;
        const wasActive = c === call;
        if (wasActive) call = null;
        else if (c === held) held = null;
        if (c.recorder) stopRecording(c);
        logCall({ ...c.log, status: c.started ? 'answered' : (c.endStatus || (c.log.direction === 'out' && c.person ? 'cancelled' : 'answered')), title: c.title, communityId: c.communityId || c.log.communityId, started_at: new Date(c.started || Date.now()).toISOString(), duration: c.started ? (Date.now() - c.started) / 1000 : 0, participants: c.maxPeople || 2 });
        clearInterval(c.tick);
        clearInterval(c.stats);
        clearTimeout(c.ringTimer);
        stopRingback();
        if (notify && c.ringing) ring(c.ringing, 'cancel', { from: me() }).catch(() => {});
        // Nobody answered (or we gave up): the server records the missed call and swaps their ringing alert for it
        if (c.ringing && !c.started && c.serverRing && !['declined', 'busy'].includes(c.endStatus) && I.alertServer) I.alertServer('missed', { ring: c.serverRing });
        c.peers.forEach(p => { p.pc.close(); if (p.audio) p.audio.remove(); });
        c.local.getTracks().forEach(t => t.stop());
        if (c.cam) c.cam.stop();
        if (c.screen) c.screen.stop();
        if (c.audioCtx) c.audioCtx.close().catch(() => {});
        if (c.wake) c.wake.release().catch(() => {});
        if (document.pictureInPictureElement) document.exitPictureInPicture().catch(() => {});
        // Leave the room in the background: the screen never waits on the network
        const ch = c.channel;
        c.channel = null;
        if (ch) {
            const gone = Promise.race([ch.untrack(), new Promise(r => setTimeout(r, 1500))]).catch(() => {}).then(() => dropChannel(ch));
            closing.set(c.topic, gone);
            gone.then(() => {
                if (closing.get(c.topic) === gone) closing.delete(c.topic);
                // Anyone watching this room (the community page's "Join call" button) picks back up
                const w = watchers.get(c.topic);
                if (w) openWatch(c.topic, w);
            });
        }
        if (!wasActive) { paintHeld(); return; }
        clearMediaSession();
        $('call-reactions').hidden = true;
        chime('leave');
        // "Call ended" stays up for a moment, then the panel goes
        const lasted = c.started ? Media.formatDuration((Date.now() - c.started) / 1000) : '';
        panel.classList.remove('min', 'video', 'sharing');
        panel.classList.add('ended');
        $('call-status').textContent = lasted ? `Call ended · ${lasted}` : 'Call ended';
        const unanswered = !c.started && !!c.person && !!c.log && c.log.direction === 'out';
        const why = c.endStatus === 'no_answer' ? 'No answer' : c.endStatus === 'declined' ? 'Declined' : c.endStatus === 'busy' ? 'On another call' : 'Call ended';
        $('call-stage').innerHTML = `<div class="call-ended-card">${c.person ? avatar(c.person, 'xl') : `<span class="call-ended-emoji">${esc(c.emoji || '📞')}</span>`}<strong>${unanswered ? why : 'Call ended'}</strong>${lasted ? `<small>${lasted}</small>` : ''}
            ${unanswered ? `<div class="call-again"><button type="button" class="call-again-btn" data-again="call"><svg class="i"><use href="#${c.log.video ? 'i-video' : 'i-phone'}"/></svg>Call again</button><button type="button" class="call-again-close" data-again="close">Close</button></div>` : ''}</div>`;
        $('call-stage').dataset.key = '';
        lastEnded = unanswered ? { person: c.person, video: !!c.log.video } : null;
        $('call-float').hidden = true;
        // A call on hold comes back when this one ends
        if (held) { setTimeout(() => { if (!call && held) switchCalls(); }, 900); }
        clearTimeout(endedTimer);
        endedTimer = setTimeout(() => {
            if (call) return;
            lastEnded = null;
            panel.hidden = true;
            panel.classList.remove('ended');
            document.body.classList.remove('in-call');
        }, unanswered ? 15000 : 1600);
        app.requestRender ? app.requestRender() : app.render();
    }
    let lastEnded = null, endedTimer = null;
    $('call-stage').addEventListener('click', e => {
        const b = e.target.closest('[data-again]');
        if (!b || call) return;
        e.stopPropagation();
        const again = lastEnded;
        clearTimeout(endedTimer);
        lastEnded = null;
        if (b.dataset.again === 'call' && again) {
            panel.classList.remove('ended');
            startDirect(again.person, { video: again.video });
        } else {
            panel.hidden = true;
            panel.classList.remove('ended');
            document.body.classList.remove('in-call');
        }
    }, true);

    window.addEventListener('pagehide', () => { if (call) leave(true); });

    // ---------- Keep the phone awake; controls on the lock screen / PiP window ----------
    async function keepAwake() {
        if (!call || !navigator.wakeLock) return;
        try { call.wake = await navigator.wakeLock.request('screen'); } catch (e) { /* not allowed right now */ }
    }

    function mediaSession() {
        const ms = navigator.mediaSession;
        if (!ms || !call) return;
        try {
            ms.metadata = new MediaMetadata({ title: call.title, artist: 'Cordial call', artwork: [{ src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' }] });
            ms.setActionHandler('hangup', () => leave(true));
            ms.setActionHandler('togglemicrophone', () => call && setMuted(!call.muted));
            ms.setActionHandler('togglecamera', () => toggleCamera());
        } catch (e) { /* not every action exists everywhere */ }
    }
    function clearMediaSession() {
        const ms = navigator.mediaSession;
        if (!ms) return;
        ['hangup', 'togglemicrophone', 'togglecamera'].forEach(a => { try { ms.setActionHandler(a, null); } catch (e) {} });
        try { ms.metadata = null; } catch (e) {}
    }

    document.addEventListener('visibilitychange', () => {
        if (!call) return;
        if (document.visibilityState === 'visible') {
            if (!call.wake || call.wake.released) keepAwake();
            publish(); // coming back from the background: make sure presence is still published
        } else if (canPip && !document.pictureInPictureElement) {
            // Switching to another app during a video call: keep it on top where the browser allows it
            const v = featuredVideo();
            if (v && v.requestPictureInPicture) v.requestPictureInPicture().catch(() => {});
        }
    });

    // ---------- Hold & switch ----------
    // Holding a call keeps its connections but stops your microphone, camera and their sound
    function hold() {
        if (!call) return;
        const c = call;
        c.local.getAudioTracks().forEach(t => { t.enabled = false; });
        if (c.cam) c.cam.enabled = false;
        c.peers.forEach(p => { if (p.audio) p.audio.muted = true; });
        if (c.channelReady) c.channel.track({ ...myMeta(), muted: true, held: true }).catch(() => {});
        held = c;
        call = null;
        paintHeld();
    }

    function resume(c) {
        call = c;
        held = null;
        c.local.getAudioTracks().forEach(t => { t.enabled = !c.muted; });
        if (c.cam) c.cam.enabled = true;
        c.peers.forEach(p => { if (p.audio) p.audio.muted = !c.speaker; });
        publish();
        if (c.channel) syncPeers();
        showPanel();
        paintHeld();
    }

    function switchCalls() {
        const back = held;
        if (!back) return;
        if (call) hold(); // the current call goes on hold…
        resume(back);     // …and the held one comes back
    }

    function paintHeld() {
        const bar = $('call-held');
        if (!bar) return;
        bar.hidden = !held;
        if (held) bar.innerHTML = `<svg class="i"><use href="#i-clock"/></svg><span>On hold: <strong>${esc(held.title)}</strong></span><button type="button" class="chip" data-held="switch">Switch</button><button type="button" class="chip danger" data-held="end">End</button>`;
    }
    $('call-held').addEventListener('click', e => {
        const b = e.target.closest('[data-held]');
        if (!b) return;
        if (b.dataset.held === 'switch') switchCalls();
        else if (held) leave(true, held);
    });

    // ---------- Recording ----------
    // Mixes everyone's audio (and the main video, if any) and saves it privately to your account.
    // Everyone in the call sees that it's being recorded, for as long as it is.
    async function startRecording() {
        if (!call || call.recorder || !window.MediaRecorder) return app.showToast('Recording isn’t supported on this device');
        const ok = await app.ask({
            title: 'Record this call?',
            text: 'Everyone in the call will see that you’re recording. Only record with their agreement and where the law allows. The recording is saved privately to your account.',
            ok: 'Start recording'
        });
        if (!ok || !call) return;
        const c = call;
        try {
            const ctx = new (window.AudioContext || window.webkitAudioContext)();
            const dest = ctx.createMediaStreamDestination();
            const add = stream => { try { ctx.createMediaStreamSource(stream).connect(dest); } catch (e) {} };
            add(c.local);
            c.peers.forEach(p => { if (p.audio && p.audio.srcObject) add(p.audio.srcObject); });
            const v = featuredVideo() || (c.cam ? localVideo('cam') : null);
            const vt = v && v.srcObject ? v.srcObject.getVideoTracks()[0] : null;
            const tracks = [...dest.stream.getAudioTracks(), ...(vt ? [vt] : [])];
            const types = vt ? ['video/webm;codecs=vp8,opus', 'video/webm', 'video/mp4'] : ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'];
            const mime = types.find(t => MediaRecorder.isTypeSupported(t)) || '';
            const rec = new MediaRecorder(new MediaStream(tracks), mime ? { mimeType: mime } : undefined);
            const chunks = [];
            rec.ondataavailable = e => { if (e.data && e.data.size) chunks.push(e.data); };
            c.recorder = { rec, ctx, dest, chunks, started: Date.now(), mime: rec.mimeType || mime || (vt ? 'video/webm' : 'audio/webm'), addStream: add };
            rec.start(1000);
            publish();
            syncPeers();
            app.showToast('Recording — everyone in the call can see it');
        } catch (e) {
            app.showToast('Couldn’t start recording');
        }
    }

    function stopRecording(c = call) {
        if (!c || !c.recorder) return;
        const r = c.recorder;
        c.recorder = null;
        r.rec.onstop = async () => {
            try { r.ctx.close(); } catch (e) {}
            const blob = new Blob(r.chunks, { type: r.mime.split(';')[0] });
            const secs = Math.round((Date.now() - r.started) / 1000);
            if (!blob.size) return;
            const ext = blob.type.includes('mp4') ? '.mp4' : '.webm';
            const path = `${me()}/${I.randomId()}${ext}`;
            app.showToast('Saving the recording…');
            const { error } = await client.storage.from('diary-recordings').upload(path, blob, { contentType: blob.type, upsert: false });
            if (error) {
                // Couldn't upload: at least keep it on this device
                const a = document.createElement('a');
                a.href = URL.createObjectURL(blob);
                a.download = `call-recording${ext}`;
                a.click();
                return app.showToast('Couldn’t save it online — it was downloaded instead');
            }
            await client.from('diary_call_recordings').insert({ title: `${c.title} · ${new Date().toLocaleDateString()}`, path, mime: blob.type, duration: secs, size: blob.size });
            history.list = null;
            app.showToast('Recording saved — find it under Chats → Calls');
        };
        try { r.rec.stop(); } catch (e) {}
        if (c === call) { publish(); syncPeers(); }
    }

    // ---------- Camera, screen share, speaker ----------
    async function toggleCamera() {
        if (!call) return;
        if (call.cam) {
            call.cam.stop();
            call.cam = null;
        } else {
            try {
                call.cam = await getCamera(call.facing);
                if (call.people.size > VIDEO_COMFORTABLE) app.showToast(`Video works best with up to ${VIDEO_COMFORTABLE} people`);
            } catch (e) {
                return app.showToast(mediaError(e, 'camera'));
            }
        }
        eachPeer(applyTracks);
        publish();
        paintPanel();
    }

    async function flipCamera() {
        if (!call || !call.cam) return;
        const next = call.facing === 'user' ? 'environment' : 'user';
        try {
            const track = await getCamera(next);
            call.cam.stop();
            call.cam = track;
            call.facing = next;
            eachPeer(applyTracks);
            paintPanel();
        } catch (e) {
            app.showToast('Couldn’t switch camera');
        }
    }

    // The browser's own picker offers the whole screen, a window or a tab (whichever it supports)
    async function startShare() {
        if (!call || !canShare) return;
        let track;
        try {
            const stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: 15, max: 15 } }, audio: false });
            stream.getVideoTracks().forEach(t => { if ('contentHint' in t) t.contentHint = 'detail'; });
            track = stream.getVideoTracks()[0];
        } catch (e) {
            if (e && e.name !== 'NotAllowedError' && e.name !== 'AbortError') app.showToast('Couldn’t share your screen');
            return;
        }
        if (!call) return track.stop();
        try { track.contentHint = 'detail'; } catch (e) {}
        track.addEventListener('ended', () => stopShare()); // the browser's own "Stop sharing" button
        call.screen = track;
        call.screenPaused = false;
        eachPeer(applyTracks);
        publish();
        paintPanel();
        app.showToast('You’re sharing your screen — everyone in the call can see it');
    }

    function pauseShare() {
        if (!call || !call.screen) return;
        call.screenPaused = !call.screenPaused;
        call.screen.enabled = !call.screenPaused; // paused → others see a still, blank frame
        publish();
        paintPanel();
    }

    function stopShare() {
        if (!call || !call.screen) return;
        call.screen.stop();
        call.screen = null;
        call.screenPaused = false;
        eachPeer(applyTracks);
        publish();
        paintPanel();
    }

    function setSpeaker(on) {
        call.speaker = on;
        call.peers.forEach(p => { if (p.audio) p.audio.muted = !call.speaker; });
        paintPanel();
    }

    // ---------- Where the sound goes ----------
    // Chrome (Android and desktop) can send the call to a chosen output: the loudspeaker, the earpiece when the
    // phone exposes one, or wired / Bluetooth earphones. iPhone Safari doesn't let websites choose, so there we
    // explain the Control Centre route picker instead.
    const canRoute = !!(window.HTMLMediaElement && HTMLMediaElement.prototype.setSinkId);
    const EAR_RE = /earpiece|receiver|handset|phone speaker/i;
    const HEAD_RE = /head|ear(buds|phones)|airpods|buds|bluetooth|bt |wired|jabra|bose|sony|beats/i;
    let outputs = [];
    async function refreshOutputs() {
        if (!canRoute || !navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return outputs = [];
        try { outputs = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === 'audiooutput' && d.deviceId !== 'communications'); } catch (e) { outputs = []; }
        return outputs;
    }
    if (navigator.mediaDevices && navigator.mediaDevices.addEventListener) {
        navigator.mediaDevices.addEventListener('devicechange', async () => {
            const before = outputs.map(d => d.deviceId).join();
            await refreshOutputs();
            if (call && before && outputs.map(d => d.deviceId).join() !== before) {
                const head = outputs.find(d => HEAD_RE.test(d.label));
                if (head) app.showToast(`${head.label} connected`);
                paintPanel();
            }
        });
    }
    const routeKind = d => (!d ? 'speaker' : EAR_RE.test(d.label) ? 'ear' : HEAD_RE.test(d.label) ? 'head' : 'speaker');
    function currentRoute() {
        const d = outputs.find(x => x.deviceId === call.sinkId) || (call.sinkId ? null : outputs.find(x => x.deviceId === 'default'));
        const kind = routeKind(d);
        const label = kind === 'ear' ? 'Phone' : kind === 'head' ? (d.label.replace(/\s*\(.*\)$/, '').replace(/^Default - /, '').slice(0, 14) || 'Earphones') : 'Speaker';
        return { kind, label, icon: kind === 'ear' ? 'i-phone' : kind === 'head' ? 'i-headphones' : 'i-speaker' };
    }
    function setSink(id) {
        call.sinkId = id;
        call.peers.forEach(p => { if (p.audio && p.audio.setSinkId) p.audio.setSinkId(id).catch(() => {}); });
        paintPanel();
    }
    async function routeMenu(anchor) {
        if (!call) return;
        await refreshOutputs();
        const items = [];
        if (canRoute && outputs.length) {
            const seen = new Set();
            outputs.forEach((d, i) => {
                const kind = routeKind(d);
                const name = (d.label || `Speaker ${i + 1}`).replace(/^Default - /, '');
                if (seen.has(name)) return;
                seen.add(name);
                const on = call.sinkId ? call.sinkId === d.deviceId : d.deviceId === 'default';
                items.push({ label: kind === 'ear' ? 'Phone (earpiece)' : name, icon: on ? 'i-check' : kind === 'ear' ? 'i-phone' : kind === 'head' ? 'i-headphones' : 'i-speaker', onClick: () => setSink(d.deviceId) });
            });
        } else {
            items.push({ label: 'Speaker, iPhone or AirPods…', icon: 'i-speaker', onClick: () => app.showToast('On iPhone, open Control Centre and tap the audio button (next to the volume) to switch between Speaker, iPhone and AirPods', null, 7000) });
        }
        items.push({ label: 'Hold to my ear', icon: 'i-ear', onClick: () => earMode(true) });
        items.push({ label: call.speaker ? 'Mute call sound' : 'Turn call sound back on', icon: call.speaker ? 'i-volume-off' : 'i-speaker', onClick: () => setSpeaker(!call.speaker) });
        app.openPopover(anchor, items);
    }
    // Hold-to-ear: a dark screen (no accidental cheek taps) and, where the phone offers it, the earpiece
    let earBefore = null;
    function earMode(on) {
        if (!call) return;
        const box = $('call-ear');
        if (on) {
            earBefore = call.sinkId || null;
            const ear = outputs.find(d => EAR_RE.test(d.label));
            if (ear) setSink(ear.deviceId);
            box.hidden = false;
            $('call-ear-status').textContent = statusText().text;
        } else {
            box.hidden = true;
            if (earBefore !== null || call.sinkId) setSink(earBefore || 'default');
            earBefore = null;
        }
    }
    (() => {
        const box = $('call-ear');
        let last = 0;
        box.addEventListener('pointerup', () => { const now = Date.now(); if (now - last < 350) earMode(false); last = now; });
        box.addEventListener('dblclick', () => earMode(false));
    })();

    // Desktop browsers can route the call to a chosen speaker or headset
    async function pickOutput(anchor) {
        if (!call || !HTMLMediaElement.prototype.setSinkId) return;
        let devices = [];
        try { devices = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === 'audiooutput'); } catch (e) {}
        if (!devices.length) return app.showToast('No other speakers found');
        app.openPopover(anchor, devices.map((d, i) => ({
            label: `${call.sinkId === d.deviceId ? '✓ ' : ''}${d.label || `Speaker ${i + 1}`}`,
            icon: 'i-speaker',
            onClick: () => {
                call.sinkId = d.deviceId;
                call.peers.forEach(p => { if (p.audio && p.audio.setSinkId) p.audio.setSinkId(d.deviceId).catch(() => {}); });
            }
        })));
    }

    // ---------- Moderation (group calls) ----------
    async function isModerator(communityId, userId) {
        const { data } = await client.from('diary_community_members')
            .select('role').eq('community_id', communityId).eq('user_id', userId).maybeSingle();
        return !!data && ['owner', 'admin', 'moderator'].includes(data.role);
    }

    async function onControl(msg) {
        if (!msg || msg.to !== me() || !call.communityId) return;
        // Only act on requests from the community's staff — checked against the database
        if (!(await isModerator(call.communityId, msg.from))) return;
        if (msg.action === 'mute' && !call.muted) {
            setMuted(true);
            app.showToast(`${nameOf(msg.from)} muted you`);
        } else if (msg.action === 'camera-off' && call.cam) {
            toggleCamera();
            app.showToast(`${nameOf(msg.from)} turned your camera off`);
        } else if (msg.action === 'stop-share' && call.screen) {
            stopShare();
            app.showToast(`${nameOf(msg.from)} stopped your screen share`);
        } else if (msg.action === 'remove') {
            app.showToast(`${nameOf(msg.from)} removed you from the call`);
            leave(false);
        } else if (msg.action === 'lower-hand' && call.hand) {
            toggleHand(false);
        }
    }

    function personMenu(anchor, id) {
        if (!call) return;
        const items = [];
        const meta = id === me() ? myMeta() : (call.people.get(id) || {});
        const peer = call.peers.get(id);
        if ((meta.cam || meta.screen) && id !== call.focus) items.push({ label: 'Show large', icon: 'i-expand', onClick: () => { call.focus = id; paintPanel(); } });
        if (call.focus === id) items.push({ label: 'Back to grid', icon: 'i-grid', onClick: () => { call.focus = null; paintPanel(); } });
        if (id !== me() && window.diaryProfile) items.push({ label: 'View profile', icon: 'i-user', onClick: () => window.diaryProfile.open(id) });
        if (id !== me() && call.amModerator) {
            if (!meta.muted) items.push({ label: 'Mute for everyone', icon: 'i-mic-off', onClick: () => send({ to: id, action: 'mute' }, 'control') });
            if (meta.cam) items.push({ label: 'Turn their camera off', icon: 'i-video-off', onClick: () => send({ to: id, action: 'camera-off' }, 'control') });
            if (meta.screen) items.push({ label: 'Stop their screen share', icon: 'i-screen', onClick: () => send({ to: id, action: 'stop-share' }, 'control') });
            if (meta.hand) items.push({ label: 'Lower their hand', icon: 'i-down', onClick: () => send({ to: id, action: 'lower-hand' }, 'control') });
            items.push({ label: 'Remove from call', icon: 'i-close', danger: true, onClick: () => send({ to: id, action: 'remove' }, 'control') });
        }
        if (peer && peer.audio) {
            items.push({
                label: peer.audio.muted ? 'Unmute for me' : 'Mute for me only',
                icon: 'i-speaker',
                onClick: () => { peer.audio.muted = !peer.audio.muted; }
            });
        }
        if (items.length) app.openPopover(anchor, items);
    }

    // ---------- Inviting more people ----------
    async function addPeople(anchor) {
        if (!call) return;
        let people = [];
        if (call.communityId) {
            const { data } = await client.from('diary_community_members')
                .select('user_id, profile:diary_profiles!diary_community_members_user_id_fkey(id, display_name, avatar_path)')
                .eq('community_id', call.communityId);
            people = (data || []).map(m => m.profile).filter(Boolean);
        } else {
            people = s.friends.map(f => ({ id: f.id, display_name: f.display_name, avatar_path: f.avatar_path }));
        }
        const others = people.filter(p => p.id !== me() && !call.people.has(p.id));
        if (!others.length) return app.showToast(call.communityId ? 'Everyone in the group is already here' : 'All your friends are already here');
        app.openPopover(anchor, others.slice(0, 20).map(p => ({
            label: `Ring ${p.display_name}`,
            icon: 'i-phone',
            onClick: async () => {
                try {
                    await ring(p.id, 'ring', {
                        from: me(), name: s.profile.display_name, avatar_path: s.profile.avatar_path || null,
                        topic: call.topic, group: call.communityId ? call.title : `${call.title} +`, emoji: call.emoji || '📞', video: !!call.cam
                    });
                    app.showToast(`Ringing ${p.display_name}…`);
                } catch (e) {
                    app.showToast('Couldn’t ring them right now');
                }
            }
        })));
    }

    // ---------- Hand & reactions ----------
    function toggleHand(force) {
        if (!call) return;
        call.hand = typeof force === 'boolean' ? force : !call.hand;
        publish();
        paintPanel();
    }

    function react(emoji) {
        if (!call) return;
        send({ emoji }, 'react');
        showReaction(me(), emoji);
        $('call-reactions').hidden = true;
    }

    function showReaction(from, emoji) {
        if (!REACTIONS.includes(emoji)) return;
        const tile = $('call-stage').querySelector(`[data-person="${CSS.escape(from)}"]`);
        if (!tile) return;
        const bubble = document.createElement('span');
        bubble.className = 'float-emoji';
        bubble.textContent = emoji;
        tile.append(bubble);
        setTimeout(() => bubble.remove(), 2200);
    }

    // ---------- Connection quality ----------
    async function checkQuality() {
        if (!call) return;
        for (const [, peer] of call.peers) {
            try {
                const stats = await peer.pc.getStats();
                let rtt = 0;
                let lost = 0;
                let received = 0;
                stats.forEach(r => {
                    if (r.type === 'candidate-pair' && r.nominated && r.currentRoundTripTime) rtt = r.currentRoundTripTime;
                    if (r.type === 'inbound-rtp' && r.kind === 'audio') {
                        lost += r.packetsLost || 0;
                        received += r.packetsReceived || 0;
                    }
                });
                const lossRate = received + lost ? lost / (received + lost) : 0;
                const st = peer.pc.connectionState;
                peer.quality = ['disconnected', 'failed'].includes(st) ? 'lost'
                    : rtt > 0.6 || lossRate > 0.08 ? 'poor'
                    : rtt > 0.3 || lossRate > 0.03 ? 'fair' : 'good';
            } catch (e) { /* stats unavailable */ }
        }
        paintPanel();
    }

    // ---------- Speaking indicators ----------
    function setupMeter(id, stream) {
        try {
            if (!call.audioCtx) call.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
            const analyser = call.audioCtx.createAnalyser();
            analyser.fftSize = 256;
            call.audioCtx.createMediaStreamSource(stream).connect(analyser);
            call.meters.set(id, { analyser, buf: new Uint8Array(analyser.fftSize) });
        } catch (e) { /* meters are optional */ }
    }

    function speaking(id) {
        const m = call && call.meters.get(id);
        if (!m) return false;
        m.analyser.getByteTimeDomainData(m.buf);
        let sum = 0;
        for (const v of m.buf) sum += ((v - 128) / 128) ** 2;
        return Math.sqrt(sum / m.buf.length) > 0.04;
    }

    setInterval(() => {
        if (!call || panel.hidden) return;
        const talking = [];
        panel.querySelectorAll('#call-stage [data-person], #call-people-sheet [data-person]').forEach(el => {
            const id = el.dataset.person;
            const muted = id === me() ? call.muted : (call.people.get(id) || {}).muted;
            const on = !muted && speaking(id);
            el.classList.toggle('speaking', on);
            if (on && id !== me()) talking.push(nameOf(id));
        });
        $('call-speaking').textContent = talking.length
            ? `${talking.slice(0, 2).join(' and ')} ${talking.length === 1 ? 'is' : 'are'} speaking`
            : '';
    }, 200);

    // ---------- Panel ----------
    const panel = $('call-panel');

    function showPanel() {
        panel.hidden = false;
        panel.classList.remove('min', 'ended');
        $('call-float').hidden = true;
        document.body.classList.add('in-call');
        paintPanel();
    }

    function expand() {
        panel.classList.remove('min');
        $('call-float').hidden = true;
        paintPanel();
    }

    function minimise() {
        panel.classList.add('min');
        $('call-float').hidden = false;
        paintPanel();
    }

    function nameOf(id) {
        if (id === me()) return 'You';
        const meta = call && call.people.get(id);
        return (meta && meta.name) || (call && call.person && call.person.id === id ? call.person.display_name : 'Someone');
    }

    // The status line: ringing → connecting → connected (with the timer)
    function statusText() {
        const others = [...call.people.keys()].filter(id => id !== me());
        const connected = others.filter(id => {
            const p = call.peers.get(id);
            return p && ['connected', 'completed'].includes(p.pc.connectionState || p.pc.iceConnectionState);
        }).length;
        if (!call.channelReady && call.synced) return { text: 'Reconnecting…', state: 'connecting' };
        if (call.ringing) return { text: 'Ringing…', state: 'ringing' };
        if (!others.length) return { text: call.person ? 'Calling…' : 'Waiting for others to join…', state: 'waiting' };
        if (connected < others.length) return { text: 'Connecting…', state: 'connecting' };
        const names = others.map(id => nameOf(id).split(' ')[0]);
        const with_ = others.length > 1 ? `With ${names.length > 2 ? `${names.slice(0, 2).join(', ')} +${names.length - 2}` : names.join(' and ')} · ` : '';
        return { text: `${with_}${duration()}`, state: 'connected' };
    }

    // Whose screen or video is shown big: someone sharing their screen, else the pinned person
    function featured() {
        if (!call) return null;
        if (call.focus) return { id: call.focus, kind: (call.focus === me() ? call.screen : (call.people.get(call.focus) || {}).screen) ? 'screen' : 'cam' };
        for (const [id, meta] of call.people) if (id !== me() && meta.screen) return { id, kind: 'screen' };
        if (call.screen) return { id: me(), kind: 'screen' };
        return null;
    }

    function featuredVideo() {
        if (!call) return null;
        const f = featured();
        if (f && f.id !== me()) {
            const p = call.peers.get(f.id);
            return p && (f.kind === 'screen' ? p.screenVideo : p.camVideo);
        }
        for (const [id, p] of call.peers) if ((call.people.get(id) || {}).cam && p.camVideo) return p.camVideo;
        return null;
    }

    function localVideo(kind) {
        const key = kind === 'screen' ? 'localScreenVideo' : 'localCamVideo';
        const track = kind === 'screen' ? call.screen : call.cam;
        if (!track) return null;
        let v = call[key];
        if (!v) {
            v = call[key] = document.createElement('video');
            v.autoplay = true;
            v.muted = true;
            v.setAttribute('playsinline', '');
        }
        if (!v.srcObject || v.srcObject.getVideoTracks()[0] !== track) {
            v.srcObject = new MediaStream([track]);
            v.play().catch(() => {});
        }
        return v;
    }

    function videoFor(id, kind) {
        if (id === me()) return localVideo(kind);
        const p = call.peers.get(id);
        return p ? (kind === 'screen' ? p.screenVideo : p.camVideo) : null;
    }

    function tileHTML(id, kind, big) {
        const meta = id === me() ? myMeta() : (call.people.get(id) || {});
        const person = { id, display_name: meta.name || nameOf(id), avatar_path: meta.avatar_path };
        const quality = id === me() ? 'good' : ((call.peers.get(id) || {}).quality || 'good');
        const showVideo = kind === 'screen' ? !!meta.screen : !!meta.cam;
        const label = kind === 'screen' ? `${id === me() ? 'Your' : `${nameOf(id)}’s`} screen${meta.screen === 'paused' ? ' · paused' : ''}` : nameOf(id);
        return `
            <div class="call-tile${big ? ' big' : ''}${showVideo ? ' has-video' : ''}${kind === 'screen' ? ' screen' : ''}${id === me() && kind === 'cam' ? ' self' : ''}" data-person="${esc(id)}" data-kind="${kind}" tabindex="0" role="button" aria-label="${esc(label)}">
                <span class="call-video-slot" aria-hidden="true"></span>
                ${showVideo ? '' : `<span class="call-ring">${avatar(person, 'xl')}</span>`}
                <span class="call-tag">
                    ${meta.muted && kind === 'cam' ? '<svg class="i"><use href="#i-mic-off"/></svg>' : ''}${meta.hand && kind === 'cam' ? '<span aria-label="Hand raised">✋</span>' : ''}
                    <span class="call-tag-name">${esc(label)}</span>
                    ${quality !== 'good' ? `<span class="call-quality q-${quality}" title="${quality === 'lost' ? 'Reconnecting' : 'Weak connection'}"><i></i><i></i><i></i></span>` : ''}
                </span>
            </div>`;
    }

    function paintPanel(note) {
        if (!call) return;
        const { text, state } = statusText();
        const status = typeof note === 'string' ? note : text;
        const others = [...call.people.keys()].filter(id => id !== me());
        const ids = [me(), ...others].sort((a, b) => {
            const ha = a === me() ? call.hand : (call.people.get(a) || {}).hand;
            const hb = b === me() ? call.hand : (call.people.get(b) || {}).hand;
            return (hb ? 1 : 0) - (ha ? 1 : 0);
        });
        // Before anyone else joins a one-to-one call, show who you're calling
        if (call.person && !others.length && !ids.includes(call.person.id)) ids.push(call.person.id);
        const anyVideo = ids.some(id => { const m = id === me() ? myMeta() : (call.people.get(id) || {}); return m.cam || m.screen; });
        const feat = featured();

        panel.classList.toggle('video', anyVideo);
        panel.classList.toggle('sharing', !!feat && feat.kind === 'screen');
        panel.dataset.state = state;
        $('call-title').textContent = `${call.emoji ? `${call.emoji} ` : ''}${call.title}`;
        $('call-status').textContent = status;
        $('call-float-name').textContent = call.title;
        $('call-float-status').textContent = status;

        // Who is sharing a screen, for everyone to see
        const sharers = ids.filter(id => (id === me() ? myMeta() : (call.people.get(id) || {})).screen);
        const banner = $('call-share-banner');
        banner.hidden = !sharers.length;
        if (sharers.length) {
            const paused = sharers.every(id => (id === me() ? myMeta() : call.people.get(id) || {}).screen === 'paused');
            banner.innerHTML = `<svg class="i"><use href="#i-screen"/></svg><span>${sharers.map(id => (id === me() ? 'You are' : `${esc(nameOf(id))} is`)).join(', ')} sharing ${sharers.length > 1 ? 'screens' : 'the screen'}${paused ? ' (paused)' : ''}</span>`;
        }

        // Rebuild the tiles only when who/what changed; videos are moved in, never recreated
        const tiles = [];
        if (feat) tiles.push([feat.id, feat.kind, true]);
        ids.forEach(id => {
            if (!(feat && feat.id === id && feat.kind === 'cam')) tiles.push([id, 'cam', false]);
            const meta = id === me() ? myMeta() : (call.people.get(id) || {});
            if (meta.screen && !(feat && feat.id === id && feat.kind === 'screen')) tiles.push([id, 'screen', false]);
        });
        const key = tiles.map(([id, kind, big]) => {
            const m = id === me() ? myMeta() : (call.people.get(id) || {});
            const q = id === me() ? 'good' : ((call.peers.get(id) || {}).quality || 'good');
            return `${id}:${kind}:${big ? 1 : 0}:${m.muted ? 1 : 0}:${m.hand ? 1 : 0}:${m.cam ? 1 : 0}:${m.screen || 0}:${q}:${m.name || ''}`;
        }).join('|');
        const stage = $('call-stage');
        const voice = !anyVideo && !feat && others.length <= 1;
        panel.classList.toggle('voice', voice);
        if (voice) {
            const who = call.person || (others[0] ? { id: others[0], display_name: nameOf(others[0]), avatar_path: (call.people.get(others[0]) || {}).avatar_path } : { id: me(), display_name: call.title });
            const vkey = `voice:${who.id}:${who.avatar_path || ''}:${call.title}`;
            stage.classList.remove('has-feature');
            stage.dataset.count = '1';
            if (stage.dataset.key !== vkey) {
                stage.dataset.key = vkey;
                stage.innerHTML = `<div class="call-voice" data-person="${esc(who.id)}"><span class="call-voice-ring">${avatar(who, 'xl')}</span><strong class="call-voice-name">${esc(call.title)}</strong><span class="call-voice-status" id="call-voice-status"></span></div>`;
            }
            $('call-voice-status').textContent = status;
        }
        stage.classList.toggle('has-feature', !!feat);
        stage.dataset.count = String(tiles.length);
        if (!voice && stage.dataset.key !== key) {
            stage.dataset.key = key;
            stage.innerHTML = tiles.map(([id, kind, big]) => tileHTML(id, kind, big)).join('');
        }
        stage.querySelectorAll('.call-tile.has-video').forEach(tile => {
            const v = videoFor(tile.dataset.person, tile.dataset.kind);
            const slot = tile.querySelector('.call-video-slot');
            if (v && v.parentElement !== slot) slot.replaceChildren(v);
        });

        // Floating mini window shows the most interesting video, or the other person's picture
        const fv = featuredVideo() || (call.cam ? localVideo('cam') : null);
        const fslot = $('call-float-video');
        if (fv && !panel.classList.contains('min')) fslot.replaceChildren(); // the video lives in the main panel while it's open
        else if (fv && fv.parentElement !== fslot) fslot.replaceChildren(fv);
        else if (!fv) {
            const who = call.person || (others[0] ? { id: others[0], display_name: nameOf(others[0]), avatar_path: (call.people.get(others[0]) || {}).avatar_path } : { id: me(), display_name: call.title });
            const html = avatar(who, 'lg');
            if (fslot.dataset.html !== html) { fslot.dataset.html = html; fslot.innerHTML = html; }
        }
        if (panel.classList.contains('min')) stage.querySelectorAll('video').forEach(v => { if (v !== fv) v.pause(); });

        const setBtn = (id, pressed, icon, label) => {
            const b = $(id);
            if (!b) return;
            b.setAttribute('aria-pressed', String(pressed));
            b.innerHTML = `<svg class="i"><use href="#${icon}"/></svg><span>${label}</span>`;
        };
        setBtn('call-mute', call.muted, call.muted ? 'i-mic-off' : 'i-mic', call.muted ? 'Unmute' : 'Mute');
        setBtn('call-cam', !!call.cam, call.cam ? 'i-video' : 'i-video-off', call.cam ? 'Camera' : 'Camera off');
        const route = currentRoute();
        setBtn('call-speaker', !call.speaker || route.kind !== 'speaker', call.speaker ? route.icon : 'i-volume-off', call.speaker ? route.label : 'Sound off');
        if (!$('call-ear').hidden) $('call-ear-status').textContent = status;
        setBtn('call-share', !!call.screen, 'i-screen', call.screen ? 'Sharing' : 'Share');
        $('call-share').hidden = !canShare;
        $('call-flip').hidden = !call.cam || !('ontouchstart' in window);
        $('call-share-pause').hidden = !call.screen;
        $('call-share-pause').textContent = call.screenPaused ? 'Resume sharing' : 'Pause sharing';
        $('call-share-stop').hidden = !call.screen;
        $('call-add').hidden = false;
        $('call-pip').hidden = !canPip || !featuredVideo();
        const recOn = !!call.recorder;
        const recBtn = $('call-rec');
        recBtn.setAttribute('aria-pressed', String(recOn));
        recBtn.classList.toggle('on', recOn);
        recBtn.hidden = !window.MediaRecorder;
        recBtn.innerHTML = `<svg class="i"><use href="#i-record"/></svg><span>${recOn ? Media.formatDuration((Date.now() - call.recorder.started) / 1000) : 'Record'}</span>`;
        const count = [me(), ...others].length;
        $('call-people').innerHTML = `<svg class="i"><use href="#i-users"/></svg><span>People · ${count}</span>`;
        paintPeople();
        $('call-float-mute').setAttribute('aria-pressed', String(call.muted));
        $('call-float-mute').innerHTML = `<svg class="i"><use href="#${call.muted ? 'i-mic-off' : 'i-mic'}"/></svg>`;
    }

    function paintPeople() {
        const sheet = $('call-people-sheet');
        const open = !sheet.hidden;
        $('call-people').setAttribute('aria-expanded', String(open));
        if (!open || !call) return;
        const others = [...call.people.keys()].filter(id => id !== me());
        const rows = [me(), ...others];
        if (call.person && !others.length) rows.push(call.person.id); // ringing: show who you're calling
        const key = rows.map(id => {
            const m = id === me() ? myMeta() : (call.people.get(id) || {});
            return `${id}:${m.muted ? 1 : 0}${m.cam ? 1 : 0}${m.hand ? 1 : 0}${m.rec ? 1 : 0}${m.screen ? 1 : 0}:${(call.peers.get(id) || {}).quality || ''}:${m.name || ''}`;
        }).join('|') + (call.ringing ? ':ringing' : '');
        if (sheet.dataset.key === key) return;
        sheet.dataset.key = key;
        const flag = (icon, label, cls = '') => `<span class="cp-flag ${cls}" title="${label}" aria-label="${label}"><svg class="i"><use href="#${icon}"/></svg></span>`;
        sheet.innerHTML = `
            <header class="cp-head"><strong>In this call · ${others.length + 1}</strong>
                <button type="button" class="icon-btn" data-cp="close" aria-label="Close the list"><svg class="i"><use href="#i-close"/></svg></button></header>
            <ul class="cp-list">${rows.map(id => {
                const mine = id === me();
                const m = mine ? myMeta() : (call.people.get(id) || {});
                const joined = mine || call.people.has(id);
                const person = { id, display_name: mine ? s.profile.display_name : (m.name || nameOf(id)), avatar_path: mine ? s.profile.avatar_path : m.avatar_path };
                const q = mine ? 'good' : ((call.peers.get(id) || {}).quality || 'good');
                return `
                    <li class="cp-row${joined ? '' : ' waiting'}" data-person="${esc(id)}">
                        <span class="cp-av">${avatar(person, 'md')}</span>
                        <span class="cp-name"><strong>${esc(person.display_name)}${mine ? ' <small>(you)</small>' : ''}</strong>
                            <small>${!joined ? (call.ringing ? 'Ringing…' : 'Not joined yet') : m.rec ? 'Recording' : m.screen ? 'Sharing their screen' : m.hand ? 'Hand raised' : m.muted ? 'Muted' : 'Connected'}</small></span>
                        <span class="cp-flags">
                            ${m.rec ? flag('i-record', 'Recording', 'rec') : ''}${m.hand ? flag('i-hand', 'Hand raised', 'hand') : ''}${m.cam ? flag('i-video', 'Camera on') : ''}${m.screen ? flag('i-screen', 'Sharing screen') : ''}
                            ${joined ? (m.muted ? flag('i-mic-off', 'Muted', 'muted') : flag('i-mic', 'Microphone on', 'mic')) : ''}
                            ${q !== 'good' ? flag('i-wifi-off', q === 'lost' ? 'Reconnecting' : 'Weak connection', 'weak') : ''}
                        </span>
                    </li>`;
            }).join('')}</ul>
            <button type="button" class="cp-add" data-cp="add"><svg class="i"><use href="#i-user-plus"/></svg>Add people</button>`;
    }
    $('call-people').addEventListener('click', () => {
        const sheet = $('call-people-sheet');
        sheet.hidden = !sheet.hidden;
        sheet.dataset.key = '';
        paintPeople();
    });
    $('call-people-sheet').addEventListener('click', e => {
        const b = e.target.closest('[data-cp]');
        if (b && b.dataset.cp === 'close') { $('call-people-sheet').hidden = true; paintPeople(); return; }
        if (b && b.dataset.cp === 'add') return addPeople(b);
        const row = e.target.closest('.cp-row[data-person]');
        if (row && row.dataset.person !== me() && !row.classList.contains('waiting')) personMenu(row, row.dataset.person);
    });
    $('call-rec').addEventListener('click', () => { if (!call) return; call.recorder ? stopRecording() : startRecording(); });

    function duration() {
        if (!call || !call.started) return '0:00';
        return Media.formatDuration((Date.now() - call.started) / 1000);
    }

    function setMuted(muted) {
        call.muted = muted;
        call.local.getAudioTracks().forEach(t => { t.enabled = !muted; });
        publish();
        paintPanel();
    }

    function morePopover(anchor) {
        if (!call) return;
        app.openPopover(anchor, [
            { label: call.hand ? 'Lower hand' : 'Raise hand', icon: 'i-hand', onClick: () => toggleHand() },
            { label: 'React', icon: 'i-smile', onClick: () => { $('call-reactions').hidden = false; } },
            ...(canPip && featuredVideo() ? [{ label: 'Pop out video', icon: 'i-expand', onClick: popOut }] : []),
            { label: 'Add people', icon: 'i-user-plus', onClick: () => addPeople(anchor) }
        ]);
    }

    function popOut() {
        const v = featuredVideo();
        if (!v || !v.requestPictureInPicture) return app.showToast('Picture-in-picture isn’t available here');
        v.requestPictureInPicture().catch(() => app.showToast('Couldn’t pop the video out'));
    }

    $('call-mute').addEventListener('click', () => { if (call) setMuted(!call.muted); });
    $('call-cam').addEventListener('click', () => toggleCamera());
    $('call-flip').addEventListener('click', () => flipCamera());
    $('call-share').addEventListener('click', () => { if (!call) return; call.screen ? stopShare() : startShare(); });
    $('call-share-pause').addEventListener('click', () => pauseShare());
    $('call-share-stop').addEventListener('click', () => stopShare());
    $('call-speaker').addEventListener('click', e => routeMenu(e.currentTarget));
    refreshOutputs();
    $('call-more').addEventListener('click', e => morePopover(e.currentTarget));
    $('call-pip').addEventListener('click', popOut);
    $('call-reactions').innerHTML = REACTIONS.map(e => `<button type="button" data-react="${e}" aria-label="React ${e}">${e}</button>`).join('');
    $('call-reactions').addEventListener('click', e => {
        const b = e.target.closest('[data-react]');
        if (b) react(b.dataset.react);
    });
    $('call-add').addEventListener('click', e => addPeople(e.currentTarget));
    $('call-stage').addEventListener('click', e => {
        const tile = e.target.closest('[data-person]');
        if (tile) personMenu(tile, tile.dataset.person);
    });
    $('call-stage').addEventListener('keydown', e => {
        const tile = e.target.closest('[data-person]');
        if (tile && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); personMenu(tile, tile.dataset.person); }
    });
    $('call-leave').addEventListener('click', () => leave(true));

    Object.assign(app.actions, {
        'call-back': el => {
            const person = (history.people && history.people.get(el.dataset.id)) || s.friends.find(f => f.id === el.dataset.id);
            if (!person) return app.showToast('You can only call friends');
            startDirect(person, { video: el.dataset.video === '1' });
        },
        'call-group': el => join(`diary_call:c:${el.dataset.id}`, { title: el.dataset.name || 'Group call', subtitle: 'Group call', communityId: el.dataset.id }),
        'rec-play': async el => {
            const { data } = await client.storage.from('diary-recordings').createSignedUrl(el.dataset.path, 3600);
            if (!data) return app.showToast('Couldn’t open the recording');
            const box = el.closest('.call-row');
            let player = box.nextElementSibling && box.nextElementSibling.classList.contains('rec-player') ? box.nextElementSibling : null;
            if (!player) {
                player = document.createElement(/.(mp4|webm)$/.test(el.dataset.path) && !/audio/.test(el.dataset.path) ? 'video' : 'audio');
                player.className = 'rec-player';
                player.controls = true;
                player.setAttribute('playsinline', '');
                box.after(player);
            }
            player.src = data.signedUrl;
            player.play().catch(() => {});
        },
        'rec-download': async el => {
            if (window.diaryChatTools) window.diaryChatTools.download('diary-recordings', el.dataset.path, el.dataset.name);
        },
        'rec-delete': async el => {
            const ok = await app.ask({ title: 'Delete this recording?', text: 'It’s removed from your account for good.', ok: 'Delete', danger: true });
            if (!ok) return;
            await client.storage.from('diary-recordings').remove([el.dataset.path]);
            const { error } = await client.from('diary_call_recordings').delete().eq('id', el.dataset.id);
            if (error) return app.showToast('Couldn’t delete it');
            history.list = null;
            app.requestRender('messages');
        }
    });
    $('call-minimize').addEventListener('click', minimise);
    $('call-float-open').addEventListener('click', expand);
    $('call-float-mute').addEventListener('click', () => { if (call) setMuted(!call.muted); });
    $('call-float-end').addEventListener('click', () => leave(true));

    // The floating window can be dragged anywhere and settles against the nearest side
    (() => {
        const box = $('call-float');
        let drag = null;
        box.addEventListener('pointerdown', e => {
            if (e.target.closest('button')) return;
            const r = box.getBoundingClientRect();
            drag = { dx: e.clientX - r.left, dy: e.clientY - r.top, moved: false };
            box.setPointerCapture(e.pointerId);
        });
        box.addEventListener('pointermove', e => {
            if (!drag) return;
            const x = Math.min(window.innerWidth - box.offsetWidth - 8, Math.max(8, e.clientX - drag.dx));
            const y = Math.min(window.innerHeight - box.offsetHeight - 8, Math.max(8, e.clientY - drag.dy));
            drag.moved = true;
            box.style.left = `${x}px`;
            box.style.top = `${y}px`;
            box.style.right = 'auto';
            box.style.bottom = 'auto';
        });
        const end = () => {
            if (!drag) return;
            const moved = drag.moved;
            drag = null;
            if (!moved) return expand();
            const r = box.getBoundingClientRect();
            const left = r.left + r.width / 2 < window.innerWidth / 2;
            box.style.left = left ? '8px' : `${window.innerWidth - r.width - 8}px`;
        };
        box.addEventListener('pointerup', end);
        box.addEventListener('pointercancel', end);
    })();

    // ---------- Sounds (generated, no audio files needed) ----------
    let chimeCtx = null;

    function tone(freqs, gap = 0.12, length = 0.16, volume = 0.12) {
        try {
            chimeCtx = chimeCtx || new (window.AudioContext || window.webkitAudioContext)();
            freqs.forEach((f, i) => {
                const at = chimeCtx.currentTime + i * gap;
                const osc = chimeCtx.createOscillator();
                const gain = chimeCtx.createGain();
                osc.frequency.value = f;
                gain.gain.setValueAtTime(0.0001, at);
                gain.gain.exponentialRampToValueAtTime(volume, at + 0.02);
                gain.gain.exponentialRampToValueAtTime(0.0001, at + length);
                osc.connect(gain).connect(chimeCtx.destination);
                osc.start(at);
                osc.stop(at + length + 0.02);
            });
        } catch (e) { /* sound is optional */ }
    }

    function chime(kind) {
        if (kind === 'join') tone([660, 880]);
        else tone([660, 440]);
    }

    let ringTimer = null;

    function unlockSound() {
        try {
            chimeCtx = chimeCtx || new (window.AudioContext || window.webkitAudioContext)();
            if (chimeCtx.state === 'suspended') chimeCtx.resume();
        } catch (e) { /* sound is optional */ }
    }

    // Ringback: what the caller hears while the other phone rings — the classic double ring
    // (two short bursts of 400 + 450 Hz, then a pause), repeating until they answer
    let ringback = null;
    function ringbackBurst(at, length) {
        const gain = chimeCtx.createGain();
        gain.gain.setValueAtTime(0.0001, at);
        gain.gain.exponentialRampToValueAtTime(0.09, at + 0.03);
        gain.gain.setValueAtTime(0.09, at + length - 0.04);
        gain.gain.exponentialRampToValueAtTime(0.0001, at + length);
        gain.connect(chimeCtx.destination);
        [400, 450].forEach(f => {
            const osc = chimeCtx.createOscillator();
            osc.frequency.value = f;
            osc.connect(gain);
            osc.start(at);
            osc.stop(at + length + 0.02);
        });
    }
    function startRingback() {
        stopRingback();
        unlockSound();
        if (!chimeCtx) return;
        const cycle = () => {
            try {
                const t = chimeCtx.currentTime + 0.05;
                ringbackBurst(t, 0.4);
                ringbackBurst(t + 0.6, 0.4);
            } catch (e) { /* sound is optional */ }
        };
        cycle();
        ringback = setInterval(cycle, 3000);
    }
    function stopRingback() {
        clearInterval(ringback);
        ringback = null;
    }

    function startRingtone() {
        stopRingtone();
        const beep = () => tone([880, 880], 0.25, 0.2, 0.25);
        beep();
        ringTimer = setInterval(beep, 1800);
    }

    function stopRingtone() {
        clearInterval(ringTimer);
    }
});
