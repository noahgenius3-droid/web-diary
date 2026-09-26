// Voice calls: community group calls and one-to-one calls (WebRTC audio, mesh for small groups).
// Signalling runs over Supabase Realtime *private* channels, authorised by RLS on realtime.messages:
//   diary_call:c:<community id>   group call room (members only)
//   diary_call:d:<a>:<b>          one-to-one room (those two only)
//   diary_ring:<user id>          incoming-call rings (only that user listens)
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

    let call = null;        // the active call
    let ringChannel = null; // listens for incoming calls
    let incoming = null;    // an unanswered incoming call
    const watchers = new Map(); // topic -> { channel, listeners:Set }

    const me = () => s.profile && s.profile.id;
    const myMeta = () => ({ name: s.profile.display_name, avatar_path: s.profile.avatar_path || null, muted: call ? call.muted : false });
    const dmTopic = otherId => `diary_call:d:${[me(), otherId].sort().join(':')}`;

    // ---------- Public API ----------
    window.diaryCalls = {
        joinCommunity(cm) {
            join(`diary_call:c:${cm.id}`, { title: cm.name, subtitle: 'Community call', emoji: cm.emoji });
        },
        callUser(person) {
            startDirect(person);
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
        activeTopic: () => (call ? call.topic : null)
    };

    // ---------- Ringing ----------
    // (Re)subscribe to our ring channel whenever someone signs in
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
                if (incoming && incoming.from === payload.from) dismissIncoming('Missed call');
            })
            .on('broadcast', { event: 'decline' }, ({ payload }) => {
                if (call && call.ringing === payload.from) {
                    app.showToast(`${call.title} declined the call`);
                    leave(false);
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
            // Busy: politely decline
            ring(p.from, 'decline', { from: me() });
            return;
        }
        incoming = { ...p, timer: setTimeout(() => dismissIncoming('Missed call'), RING_TIMEOUT) };
        const box = $('call-incoming');
        $('incoming-avatar').innerHTML = avatar({ id: p.from, display_name: p.name, avatar_path: p.avatar_path }, 'xl');
        $('incoming-name').textContent = p.name || 'Someone';
        $('incoming-sub').textContent = 'Cordial voice call…';
        box.hidden = false;
        startRingtone();
        if (navigator.vibrate) navigator.vibrate([400, 200, 400]);
    }

    function dismissIncoming(message) {
        if (!incoming) return;
        clearTimeout(incoming.timer);
        if (message) app.showToast(`${message} from ${incoming.name}`);
        incoming = null;
        $('call-incoming').hidden = true;
        stopRingtone();
    }

    $('incoming-accept').addEventListener('click', () => {
        if (!incoming) return;
        const p = incoming;
        dismissIncoming();
        join(p.topic, { title: p.name, subtitle: 'Voice call', person: { id: p.from, display_name: p.name, avatar_path: p.avatar_path } });
    });
    $('incoming-decline').addEventListener('click', () => {
        if (!incoming) return;
        ring(incoming.from, 'decline', { from: me() });
        dismissIncoming();
    });

    async function startDirect(person) {
        if (!me()) return;
        const ok = await join(dmTopic(person.id), { title: person.display_name, subtitle: 'Calling…', person });
        if (!ok) return;
        call.ringing = person.id;
        call.ringTimer = setTimeout(() => {
            if (call && call.ringing === person.id) {
                app.showToast(`${person.display_name} didn’t answer`);
                leave(true);
            }
        }, RING_TIMEOUT);
        try {
            await ring(person.id, 'ring', { from: me(), name: s.profile.display_name, avatar_path: s.profile.avatar_path || null, topic: call.topic });
        } catch (e) {
            app.showToast('Couldn’t reach them right now');
            leave(false);
        }
    }

    // ---------- Joining a room ----------
    async function join(topic, info) {
        if (call) {
            if (call.topic === topic) return expand();
            await leave(true);
        }
        let local;
        try {
            local = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
        } catch (e) {
            app.showToast('Allow microphone access to join calls');
            return false;
        }

        call = {
            topic, ...info, local, muted: false, speaker: true,
            peers: new Map(),      // user id -> { pc, audio, pending ICE, meta }
            people: new Map(),     // user id -> presence meta
            started: null, ringing: null, ringTimer: null, tick: null,
            audioCtx: null, meters: new Map()
        };
        setupMeter(me(), local);

        const channel = client.channel(topic, { config: { private: true, presence: { key: me() }, broadcast: { self: false } } });
        call.channel = channel;
        channel
            .on('presence', { event: 'sync' }, syncPeers)
            .on('broadcast', { event: 'signal' }, ({ payload }) => onSignal(payload))
            .subscribe(async status => {
                if (!call || call.channel !== channel) return;
                if (status === 'SUBSCRIBED') {
                    await channel.track(myMeta());
                } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
                    app.showToast('Couldn’t connect to the call');
                    leave(false);
                }
            });

        showPanel();
        call.tick = setInterval(paintPanel, 500);
        app.render(); // e.g. the community header switches to "You’re in the call"
        return true;
    }

    function syncPeers() {
        if (!call) return;
        const state = call.channel.presenceState();
        call.people = new Map(Object.entries(state)
            .filter(([key]) => !key.startsWith('watch-'))
            .map(([key, metas]) => [key, metas[0] || {}]));

        for (const [id] of call.people) {
            if (id === me() || call.peers.has(id)) continue;
            // The lower id makes the offer so two people never both call each other
            const peer = makePeer(id);
            if (me() < id) makeOffer(id, peer);
        }
        for (const [id] of call.peers) {
            if (!call.people.has(id)) closePeer(id);
        }
        if (call.people.size > 1 && call.ringing) {
            call.ringing = null;
            clearTimeout(call.ringTimer);
        }
        if (call.people.size > 1 && !call.started) call.started = Date.now();
        paintPanel();
    }

    function makePeer(id) {
        const pc = new RTCPeerConnection({ iceServers: ICE });
        const peer = { pc, audio: null, queue: [], remoteSet: false };
        call.peers.set(id, peer);
        call.local.getTracks().forEach(t => pc.addTrack(t, call.local));

        pc.onicecandidate = e => {
            if (e.candidate) send({ type: 'ice', to: id, candidate: e.candidate.toJSON() });
        };
        pc.ontrack = e => {
            const stream = e.streams[0];
            if (!peer.audio) {
                peer.audio = document.createElement('audio');
                peer.audio.autoplay = true;
                peer.audio.setAttribute('playsinline', '');
                $('call-audio').append(peer.audio);
            }
            peer.audio.srcObject = stream;
            peer.audio.play().catch(() => {});
            setupMeter(id, stream);
        };
        pc.onconnectionstatechange = () => {
            if (pc.connectionState === 'failed') {
                // Networks change (Wi-Fi ↔ mobile); try once to recover, then report
                if (!peer.restarted && me() < id) {
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
        if (!call || !msg || msg.to !== me() || !msg.from) return;
        let peer = call.peers.get(msg.from);
        try {
            if (msg.type === 'offer') {
                if (!peer) peer = makePeer(msg.from);
                await peer.pc.setRemoteDescription(msg.sdp);
                peer.remoteSet = true;
                await flushIce(peer);
                const answer = await peer.pc.createAnswer();
                await peer.pc.setLocalDescription(answer);
                send({ type: 'answer', to: msg.from, sdp: peer.pc.localDescription.toJSON() });
            } else if (msg.type === 'answer' && peer) {
                await peer.pc.setRemoteDescription(msg.sdp);
                peer.remoteSet = true;
                await flushIce(peer);
            } else if (msg.type === 'ice') {
                if (!peer) peer = makePeer(msg.from);
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

    function send(payload) {
        if (!call) return;
        call.channel.send({ type: 'broadcast', event: 'signal', payload: { ...payload, from: me() } });
    }

    function closePeer(id) {
        const peer = call.peers.get(id);
        if (!peer) return;
        peer.pc.close();
        if (peer.audio) peer.audio.remove();
        call.peers.delete(id);
        call.meters.delete(id);
    }

    async function leave(notify) {
        if (!call) return;
        const c = call;
        call = null;
        clearInterval(c.tick);
        clearTimeout(c.ringTimer);
        if (notify && c.ringing) ring(c.ringing, 'cancel', { from: me() }).catch(() => {});
        c.peers.forEach(p => { p.pc.close(); if (p.audio) p.audio.remove(); });
        c.local.getTracks().forEach(t => t.stop());
        if (c.audioCtx) c.audioCtx.close().catch(() => {});
        try { await c.channel.untrack(); } catch (e) {}
        client.removeChannel(c.channel);
        $('call-panel').hidden = true;
        document.body.classList.remove('in-call');
        app.render();
    }

    window.addEventListener('pagehide', () => { if (call) leave(true); });

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
        if (!call || $('call-panel').hidden) return;
        $('call-people').querySelectorAll('[data-person]').forEach(el => {
            const id = el.dataset.person;
            const muted = id === me() ? call.muted : (call.people.get(id) || {}).muted;
            el.classList.toggle('speaking', !muted && speaking(id));
        });
    }, 150);

    // ---------- Panel ----------
    const panel = $('call-panel');

    function showPanel() {
        panel.hidden = false;
        panel.classList.remove('min');
        document.body.classList.add('in-call');
        paintPanel();
    }

    function expand() {
        panel.classList.remove('min');
    }

    function nameOf(id) {
        if (id === me()) return 'You';
        const meta = call && call.people.get(id);
        return (meta && meta.name) || 'Someone';
    }

    function paintPanel(note) {
        if (!call) return;
        const others = [...call.people.keys()].filter(id => id !== me());
        const connected = others.filter(id => {
            const p = call.peers.get(id);
            return p && ['connected', 'completed'].includes(p.pc.connectionState || p.pc.iceConnectionState);
        }).length;

        let status;
        if (call.ringing) status = 'Ringing…';
        else if (!others.length) status = call.person ? 'Waiting for them to join…' : 'Waiting for others to join…';
        else if (connected < others.length) status = 'Connecting…';
        else status = `${others.length + 1} in call · ${duration()}`;
        if (typeof note === 'string') status = note;

        $('call-title').textContent = call.title;
        $('call-status').textContent = status;
        $('call-mini-text').textContent = `${call.title} · ${call.started ? duration() : status}`;

        const ids = [me(), ...others];
        const want = ids.join(',');
        const grid = $('call-people');
        if (grid.dataset.ids !== want || grid.dataset.muted !== muteKey()) {
            grid.dataset.ids = want;
            grid.dataset.muted = muteKey();
            grid.innerHTML = ids.map(id => {
                const meta = id === me() ? myMeta() : (call.people.get(id) || {});
                const person = { id, display_name: meta.name || 'Someone', avatar_path: meta.avatar_path };
                const muted = id === me() ? call.muted : meta.muted;
                return `
                    <div class="call-person" data-person="${esc(id)}">
                        <span class="call-ring">${avatar(person, 'xl')}</span>
                        <span class="call-name">${esc(nameOf(id))}${muted ? ' <svg class="i"><use href="#i-mic-off"/></svg>' : ''}</span>
                    </div>`;
            }).join('');
        }
        $('call-mute').setAttribute('aria-pressed', String(call.muted));
        $('call-mute').innerHTML = `<svg class="i"><use href="#${call.muted ? 'i-mic-off' : 'i-mic'}"/></svg><span>${call.muted ? 'Unmute' : 'Mute'}</span>`;
        $('call-speaker').setAttribute('aria-pressed', String(!call.speaker));
    }

    function muteKey() {
        return [...call.people.entries()].map(([id, m]) => `${id}:${m.muted ? 1 : 0}`).join('|') + `|me:${call.muted ? 1 : 0}`;
    }

    function duration() {
        if (!call || !call.started) return '0:00';
        return Media.formatDuration((Date.now() - call.started) / 1000);
    }

    $('call-mute').addEventListener('click', async () => {
        if (!call) return;
        call.muted = !call.muted;
        call.local.getAudioTracks().forEach(t => { t.enabled = !call.muted; });
        try { await call.channel.track(myMeta()); } catch (e) {}
        paintPanel();
    });

    $('call-speaker').addEventListener('click', () => {
        if (!call) return;
        call.speaker = !call.speaker;
        call.peers.forEach(p => { if (p.audio) p.audio.muted = !call.speaker; });
        app.showToast(call.speaker ? 'Sound on' : 'Call sound muted');
        paintPanel();
    });

    $('call-leave').addEventListener('click', () => leave(true));
    $('call-minimize').addEventListener('click', () => panel.classList.add('min'));
    $('call-mini').addEventListener('click', expand);

    // ---------- Ringtone (generated, no audio file needed) ----------
    let ringCtx = null;
    let ringTimer = null;

    function startRingtone() {
        stopRingtone();
        try {
            ringCtx = new (window.AudioContext || window.webkitAudioContext)();
            const beep = () => {
                [0, 0.25].forEach(offset => {
                    const osc = ringCtx.createOscillator();
                    const gain = ringCtx.createGain();
                    osc.frequency.value = 880;
                    gain.gain.setValueAtTime(0.0001, ringCtx.currentTime + offset);
                    gain.gain.exponentialRampToValueAtTime(0.25, ringCtx.currentTime + offset + 0.02);
                    gain.gain.exponentialRampToValueAtTime(0.0001, ringCtx.currentTime + offset + 0.2);
                    osc.connect(gain).connect(ringCtx.destination);
                    osc.start(ringCtx.currentTime + offset);
                    osc.stop(ringCtx.currentTime + offset + 0.22);
                });
            };
            beep();
            ringTimer = setInterval(beep, 1800);
        } catch (e) { /* silent ring is fine */ }
    }

    function stopRingtone() {
        clearInterval(ringTimer);
        if (ringCtx) ringCtx.close().catch(() => {});
        ringCtx = null;
    }
});
