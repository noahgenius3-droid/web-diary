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
    let ringChannel = null; // listens for incoming calls
    let incoming = null;    // an unanswered incoming call
    const watchers = new Map(); // topic -> { channel, listeners:Set, people }

    const me = () => s.profile && s.profile.id;
    const myMeta = () => ({
        name: s.profile.display_name,
        avatar_path: s.profile.avatar_path || null,
        muted: call ? call.muted : false,
        hand: call ? call.hand : false,
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
                const channel = client.channel(topic, { config: { private: true, presence: { key: `watch-${me()}-${Math.random().toString(36).slice(2, 6)}` } } });
                w = { channel, listeners: new Set(), people: [] };
                watchers.set(topic, w);
                channel.on('presence', { event: 'sync' }, () => {
                    w.people = Object.entries(channel.presenceState())
                        .filter(([key]) => !key.startsWith('watch-'))
                        .map(([key, metas]) => ({ id: key, ...(metas[0] || {}) }));
                    w.listeners.forEach(fn => fn(w.people));
                }).subscribe();
            }
            w.listeners.add(listener);
            listener(w.people);
            return () => {
                w.listeners.delete(listener);
                if (!w.listeners.size) {
                    client.removeChannel(w.channel);
                    watchers.delete(topic);
                }
            };
        },
        topicFor: cm => `diary_call:c:${cm.id}`,
        activeTopic: () => (call ? call.topic : null),
        inCall: () => !!call
    };

    // ---------- Ringing ----------
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
                    paintPanel(payload.busy ? `${call.title} is on another call` : `${call.title} declined`);
                    setTimeout(() => leave(false), 1400);
                }
            })
            .subscribe();
    }

    // Send to someone else's ring channel without listening on it (HTTP broadcast)
    async function ring(userId, event, payload) {
        const channel = client.channel(`diary_ring:${userId}`, { config: { private: true } });
        try {
            await channel.send({ type: 'broadcast', event, payload });
        } finally {
            client.removeChannel(channel);
        }
    }

    function onRing(p) {
        if (!p || !p.topic || !p.from) return;
        if (call) {
            if (call.topic === p.topic) return; // already in that call
            ring(p.from, 'decline', { from: me(), busy: true });
            app.showToast(`${p.name || 'Someone'} tried to call you`);
            return;
        }
        incoming = { ...p, timer: setTimeout(() => dismissIncoming(true), RING_TIMEOUT) };
        $('incoming-avatar').innerHTML = avatar({ id: p.from, display_name: p.name, avatar_path: p.avatar_path }, 'xl');
        $('incoming-name').textContent = p.group ? `${p.emoji || '📞'} ${p.group}` : (p.name || 'Someone');
        $('incoming-sub').textContent = p.group
            ? `${p.name} is inviting you to the group ${p.video ? 'video ' : ''}call`
            : p.video ? 'Cordial video call…' : 'Cordial voice call…';
        $('incoming-video').hidden = !p.video;
        $('incoming-accept').setAttribute('aria-label', p.video ? 'Answer with voice only' : 'Answer');
        $('call-incoming').hidden = false;
        startRingtone();
        if (navigator.vibrate) navigator.vibrate([400, 200, 400]);
    }

    function dismissIncoming(missed) {
        if (!incoming) return;
        clearTimeout(incoming.timer);
        if (missed) {
            app.showToast(`Missed ${incoming.group ? `${incoming.group} call` : incoming.video ? 'video call' : 'call'} from ${incoming.name}`);
            if (!incoming.group && window.diaryNotify) window.diaryNotify.logMissedCall(incoming.from);
        }
        incoming = null;
        $('call-incoming').hidden = true;
        stopRingtone();
    }

    function answer(withVideo) {
        if (!incoming) return;
        const p = incoming;
        dismissIncoming(false);
        join(p.topic, p.group
            ? { title: p.group, subtitle: 'Group call', emoji: p.emoji, communityId: communityOf(p.topic) }
            : { title: p.name, subtitle: p.video ? 'Video call' : 'Voice call', person: { id: p.from, display_name: p.name, avatar_path: p.avatar_path } },
        { video: withVideo });
    }
    $('incoming-accept').addEventListener('click', () => answer(false));
    $('incoming-video').addEventListener('click', () => answer(true));
    $('incoming-decline').addEventListener('click', () => {
        if (!incoming) return;
        if (!incoming.group) ring(incoming.from, 'decline', { from: me() });
        dismissIncoming(false);
    });

    async function startDirect(person, opts = {}) {
        if (!me()) return;
        const ok = await join(dmTopic(person.id), { title: person.display_name, subtitle: opts.video ? 'Video call' : 'Voice call', person }, opts);
        if (!ok) return;
        call.ringing = person.id;
        paintPanel();
        call.ringTimer = setTimeout(() => {
            if (call && call.ringing === person.id) {
                paintPanel(`${person.display_name} didn’t answer`);
                setTimeout(() => leave(true), 1400);
            }
        }, RING_TIMEOUT);
        try {
            await ring(person.id, 'ring', { from: me(), name: s.profile.display_name, avatar_path: s.profile.avatar_path || null, topic: call.topic, video: !!opts.video });
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
        return (await navigator.mediaDevices.getUserMedia({
            video: { facingMode: facing, width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 24, max: 30 } }
        })).getVideoTracks()[0];
    }

    // ---------- Joining a room ----------
    async function join(topic, info, opts = {}) {
        if (call) {
            if (call.topic === topic) return expand();
            await leave(true);
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
            reconnects: 0, channelReady: false, amModerator: false, wake: null, focus: null
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

    function openChannel() {
        const c = call;
        const channel = client.channel(c.topic, { config: { private: true, presence: { key: me() }, broadcast: { self: false } } });
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
                            if (call !== c) return;
                            client.removeChannel(channel);
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
                client.rpc('diary_notify_call', { p_community: call.communityId }).then(() => {});
            }
            const limit = call.cam ? VIDEO_COMFORTABLE : COMFORTABLE_SIZE;
            if (call.people.size > limit) app.showToast(`${call.cam ? 'Video' : 'Group'} calls work best with up to ${limit} people — it may be choppy`);
        } else if (call.synced && before && call.people.size !== before) {
            chime(call.people.size > before ? 'join' : 'leave');
        }

        if (call.people.size > 1 && call.ringing) {
            call.ringing = null;
            clearTimeout(call.ringTimer);
        }
        if (call.people.size > 1 && !call.started) call.started = Date.now();
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
        call.meters.delete(id);
        if (call.focus === id) call.focus = null;
    }

    function leave(notify) {
        if (!call) return;
        const c = call;
        call = null;
        clearInterval(c.tick);
        clearInterval(c.stats);
        clearTimeout(c.ringTimer);
        if (notify && c.ringing) ring(c.ringing, 'cancel', { from: me() }).catch(() => {});
        c.peers.forEach(p => { p.pc.close(); if (p.audio) p.audio.remove(); });
        c.local.getTracks().forEach(t => t.stop());
        if (c.cam) c.cam.stop();
        if (c.screen) c.screen.stop();
        if (c.audioCtx) c.audioCtx.close().catch(() => {});
        if (c.wake) c.wake.release().catch(() => {});
        if (document.pictureInPictureElement) document.exitPictureInPicture().catch(() => {});
        // Leave the room in the background: the screen never waits on the network
        Promise.race([c.channel.untrack(), new Promise(r => setTimeout(r, 1500))]).catch(() => {}).finally(() => client.removeChannel(c.channel));
        clearMediaSession();
        $('call-reactions').hidden = true;
        chime('leave');
        // "Call ended" stays up for a moment, then the panel goes
        const lasted = c.started ? Media.formatDuration((Date.now() - c.started) / 1000) : '';
        panel.classList.remove('min', 'video', 'sharing');
        panel.classList.add('ended');
        $('call-status').textContent = lasted ? `Call ended · ${lasted}` : 'Call ended';
        $('call-stage').innerHTML = `<div class="call-ended-card">${c.person ? avatar(c.person, 'xl') : `<span class="call-ended-emoji">${esc(c.emoji || '📞')}</span>`}<strong>Call ended</strong>${lasted ? `<small>${lasted}</small>` : ''}</div>`;
        $('call-float').hidden = true;
        setTimeout(() => {
            if (call) return;
            panel.hidden = true;
            panel.classList.remove('ended');
            document.body.classList.remove('in-call');
        }, 1600);
        app.requestRender ? app.requestRender() : app.render();
    }

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
            const stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: 12, max: 15 } }, audio: false });
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
        $('call-stage').querySelectorAll('[data-person]').forEach(el => {
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
        return { text: `${others.length > 1 ? `${others.length + 1} people · ` : ''}${duration()}`, state: 'connected' };
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
        stage.classList.toggle('has-feature', !!feat);
        stage.dataset.count = String(tiles.length);
        if (stage.dataset.key !== key) {
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
        setBtn('call-speaker', !call.speaker, call.speaker ? 'i-speaker' : 'i-volume-off', call.speaker ? 'Speaker' : 'Sound off');
        setBtn('call-share', !!call.screen, 'i-screen', call.screen ? 'Sharing' : 'Share');
        $('call-share').hidden = !canShare;
        $('call-flip').hidden = !call.cam || !('ontouchstart' in window);
        $('call-share-pause').hidden = !call.screen;
        $('call-share-pause').textContent = call.screenPaused ? 'Resume sharing' : 'Pause sharing';
        $('call-share-stop').hidden = !call.screen;
        $('call-add').hidden = false;
        $('call-pip').hidden = !canPip || !featuredVideo();
        $('call-float-mute').setAttribute('aria-pressed', String(call.muted));
        $('call-float-mute').innerHTML = `<svg class="i"><use href="#${call.muted ? 'i-mic-off' : 'i-mic'}"/></svg>`;
    }

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
            ...(HTMLMediaElement.prototype.setSinkId ? [{ label: 'Audio output', icon: 'i-speaker', onClick: () => pickOutput(anchor) }] : []),
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
    $('call-speaker').addEventListener('click', () => { if (call) setSpeaker(!call.speaker); });
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
