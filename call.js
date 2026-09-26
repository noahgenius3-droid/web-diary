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
    const COMFORTABLE_SIZE = 12; // mesh calls get heavy beyond this
    const REACTIONS = ['👏', '❤️', '😂', '👍', '🎉', '😮'];

    let call = null;        // the active call
    let ringChannel = null; // listens for incoming calls
    let incoming = null;    // an unanswered incoming call
    const watchers = new Map(); // topic -> { channel, listeners:Set, people }

    const me = () => s.profile && s.profile.id;
    const myMeta = () => ({
        name: s.profile.display_name,
        avatar_path: s.profile.avatar_path || null,
        muted: call ? call.muted : false,
        hand: call ? call.hand : false
    });
    const dmTopic = otherId => `diary_call:d:${[me(), otherId].sort().join(':')}`;
    const communityOf = topic => (topic && topic.startsWith('diary_call:c:') ? topic.split(':')[2] : null);

    // ---------- Public API ----------
    window.diaryCalls = {
        joinCommunity(cm) {
            join(`diary_call:c:${cm.id}`, { title: cm.name, subtitle: 'Group call', emoji: cm.emoji, communityId: cm.id });
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
            if (call.topic === p.topic) return; // already in that call
            ring(p.from, 'decline', { from: me() });
            return;
        }
        incoming = { ...p, timer: setTimeout(() => dismissIncoming(true), RING_TIMEOUT) };
        $('incoming-avatar').innerHTML = avatar({ id: p.from, display_name: p.name, avatar_path: p.avatar_path }, 'xl');
        $('incoming-name').textContent = p.group ? `${p.emoji || '📞'} ${p.group}` : (p.name || 'Someone');
        $('incoming-sub').textContent = p.group ? `${p.name} is inviting you to the group call` : 'Cordial voice call…';
        $('call-incoming').hidden = false;
        startRingtone();
        if (navigator.vibrate) navigator.vibrate([400, 200, 400]);
    }

    function dismissIncoming(missed) {
        if (!incoming) return;
        clearTimeout(incoming.timer);
        if (missed) {
            app.showToast(`Missed ${incoming.group ? `${incoming.group} call` : 'call'} from ${incoming.name}`);
            if (!incoming.group && window.diaryNotify) window.diaryNotify.logMissedCall(incoming.from);
        }
        incoming = null;
        $('call-incoming').hidden = true;
        stopRingtone();
    }

    $('incoming-accept').addEventListener('click', () => {
        if (!incoming) return;
        const p = incoming;
        dismissIncoming(false);
        join(p.topic, p.group
            ? { title: p.group, subtitle: 'Group call', emoji: p.emoji, communityId: communityOf(p.topic) }
            : { title: p.name, subtitle: 'Voice call', person: { id: p.from, display_name: p.name, avatar_path: p.avatar_path } });
    });
    $('incoming-decline').addEventListener('click', () => {
        if (!incoming) return;
        if (!incoming.group) ring(incoming.from, 'decline', { from: me() });
        dismissIncoming(false);
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
            topic, ...info, local, muted: false, hand: false, speaker: true,
            peers: new Map(),      // user id -> { pc, audio, queue, remoteSet, quality }
            people: new Map(),     // user id -> presence meta
            started: null, ringing: null, ringTimer: null, tick: null, stats: null,
            audioCtx: null, meters: new Map(), synced: false, notified: false,
            reconnects: 0, channelReady: false, amModerator: false, wake: null
        };
        setupMeter(me(), local);
        openChannel();
        keepAwake();
        if (call.communityId) isModerator(call.communityId, me()).then(v => { if (call) call.amModerator = v; });

        showPanel();
        call.tick = setInterval(paintPanel, 500);
        call.stats = setInterval(checkQuality, 3000);
        app.render(); // e.g. the community header switches to "You’re in the call"
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
                    // Audio keeps flowing peer-to-peer; only signalling is down. Try to reconnect.
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

    function syncPeers() {
        const state = call.channel.presenceState();
        const before = call.people.size;
        call.people = new Map(Object.entries(state)
            .filter(([key]) => !key.startsWith('watch-'))
            .map(([key, metas]) => [key, metas[0] || {}]));

        for (const [id] of call.people) {
            if (id === me() || call.peers.has(id)) continue;
            // The lower id makes the offer so two people never both call each other
            const peer = makePeer(id);
            if (me() < id) makeOffer(id, peer);
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
            if (call.people.size > COMFORTABLE_SIZE) {
                app.showToast(`Group calls work best with up to ${COMFORTABLE_SIZE} people — audio may be choppy`);
            }
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

    function makePeer(id) {
        const pc = new RTCPeerConnection({ iceServers: ICE });
        const peer = { pc, audio: null, queue: [], remoteSet: false, quality: 'good' };
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
                peer.audio.muted = !call.speaker;
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
        if (!msg || msg.to !== me() || !msg.from) return;
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
    }

    async function leave(notify) {
        if (!call) return;
        const c = call;
        call = null;
        clearInterval(c.tick);
        clearInterval(c.stats);
        clearTimeout(c.ringTimer);
        if (notify && c.ringing) ring(c.ringing, 'cancel', { from: me() }).catch(() => {});
        c.peers.forEach(p => { p.pc.close(); if (p.audio) p.audio.remove(); });
        c.local.getTracks().forEach(t => t.stop());
        if (c.audioCtx) c.audioCtx.close().catch(() => {});
        if (c.wake) c.wake.release().catch(() => {});
        try { await c.channel.untrack(); } catch (e) {}
        client.removeChannel(c.channel);
        $('call-panel').hidden = true;
        $('call-reactions').hidden = true;
        document.body.classList.remove('in-call');
        chime('leave');
        app.render();
    }

    window.addEventListener('pagehide', () => { if (call) leave(true); });

    // ---------- Keep the phone awake during a call ----------
    async function keepAwake() {
        if (!call || !navigator.wakeLock) return;
        try { call.wake = await navigator.wakeLock.request('screen'); } catch (e) { /* not allowed right now */ }
    }

    document.addEventListener('visibilitychange', () => {
        if (!call || document.visibilityState !== 'visible') return;
        if (!call.wake || call.wake.released) keepAwake();
        // Coming back from the background: make sure presence is still published
        if (call.channelReady) call.channel.track(myMeta()).catch(() => {});
    });

    // ---------- Moderation (group calls) ----------
    async function isModerator(communityId, userId) {
        const { data } = await client.from('diary_community_members')
            .select('role').eq('community_id', communityId).eq('user_id', userId).maybeSingle();
        return !!data && ['owner', 'admin'].includes(data.role);
    }

    async function onControl(msg) {
        if (!msg || msg.to !== me() || !call.communityId) return;
        // Only act on requests from the community's owner/admins — checked against the database
        if (!(await isModerator(call.communityId, msg.from))) return;
        if (msg.action === 'mute' && !call.muted) {
            setMuted(true);
            app.showToast(`${nameOf(msg.from)} muted you`);
        } else if (msg.action === 'remove') {
            app.showToast(`${nameOf(msg.from)} removed you from the call`);
            leave(false);
        } else if (msg.action === 'lower-hand' && call.hand) {
            toggleHand(false);
        }
    }

    function personMenu(anchor, id) {
        if (!call || id === me()) return;
        const items = [];
        const meta = call.people.get(id) || {};
        if (call.amModerator) {
            if (!meta.muted) items.push({ label: 'Mute for everyone', icon: 'i-mic-off', onClick: () => send({ to: id, action: 'mute' }, 'control') });
            if (meta.hand) items.push({ label: 'Lower their hand', icon: 'i-down', onClick: () => send({ to: id, action: 'lower-hand' }, 'control') });
            items.push({ label: 'Remove from call', icon: 'i-close', danger: true, onClick: () => send({ to: id, action: 'remove' }, 'control') });
        }
        const peer = call.peers.get(id);
        if (peer && peer.audio) {
            items.push({
                label: peer.audio.muted ? 'Unmute for me' : 'Mute for me only',
                icon: 'i-speaker',
                onClick: () => { peer.audio.muted = !peer.audio.muted; }
            });
        }
        if (items.length) app.openPopover(anchor, items);
    }

    // ---------- Inviting more people (group calls) ----------
    async function addPeople(anchor) {
        if (!call || !call.communityId) return;
        const { data } = await client.from('diary_community_members')
            .select('user_id, profile:diary_profiles!diary_community_members_user_id_fkey(id, display_name, avatar_path)')
            .eq('community_id', call.communityId);
        const others = (data || []).filter(m => m.user_id !== me() && !call.people.has(m.user_id));
        if (!others.length) return app.showToast('Everyone in the group is already here');
        app.openPopover(anchor, others.slice(0, 20).map(m => ({
            label: `Ring ${m.profile ? m.profile.display_name : 'member'}`,
            icon: 'i-phone',
            onClick: async () => {
                try {
                    await ring(m.user_id, 'ring', {
                        from: me(), name: s.profile.display_name, avatar_path: s.profile.avatar_path || null,
                        topic: call.topic, group: call.title, emoji: call.emoji || '📞'
                    });
                    app.showToast(`Ringing ${m.profile ? m.profile.display_name : 'them'}…`);
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
        if (call.channelReady) call.channel.track(myMeta()).catch(() => {});
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
        const tile = $('call-people').querySelector(`[data-person="${CSS.escape(from)}"] .call-ring`);
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
        for (const [id, peer] of call.peers) {
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
                const state = peer.pc.connectionState;
                peer.quality = ['disconnected', 'failed'].includes(state) ? 'lost'
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
        if (!call || $('call-panel').hidden) return;
        const talking = [];
        $('call-people').querySelectorAll('[data-person]').forEach(el => {
            const id = el.dataset.person;
            const muted = id === me() ? call.muted : (call.people.get(id) || {}).muted;
            const on = !muted && speaking(id);
            el.classList.toggle('speaking', on);
            if (on && id !== me()) talking.push(nameOf(id));
        });
        $('call-speaking').textContent = talking.length
            ? `🔊 ${talking.slice(0, 2).join(' and ')} ${talking.length === 1 ? 'is' : 'are'} speaking`
            : '';
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
        if (!call.channelReady && call.synced) status = 'Reconnecting…';
        else if (call.ringing) status = 'Ringing…';
        else if (!others.length) status = call.person ? 'Waiting for them to join…' : 'Waiting for others to join…';
        else if (connected < others.length) status = 'Connecting…';
        else status = `${others.length + 1} in call · ${duration()}`;
        if (typeof note === 'string') status = note;

        $('call-title').textContent = `${call.emoji ? `${call.emoji} ` : ''}${call.title}`;
        $('call-status').textContent = status;
        $('call-mini-text').textContent = `${call.title} · ${call.started ? duration() : status}`;
        $('call-add').hidden = !call.communityId;

        // Raised hands first, then everyone else in join order
        const ids = [me(), ...others].sort((a, b) => {
            const ha = a === me() ? call.hand : (call.people.get(a) || {}).hand;
            const hb = b === me() ? call.hand : (call.people.get(b) || {}).hand;
            return (hb ? 1 : 0) - (ha ? 1 : 0);
        });
        const key = ids.map(id => {
            const meta = id === me() ? myMeta() : (call.people.get(id) || {});
            const q = id === me() ? 'good' : ((call.peers.get(id) || {}).quality || 'good');
            return `${id}:${meta.muted ? 1 : 0}:${meta.hand ? 1 : 0}:${q}`;
        }).join('|');

        const grid = $('call-people');
        if (grid.dataset.key !== key) {
            grid.dataset.key = key;
            grid.innerHTML = ids.map(id => {
                const meta = id === me() ? myMeta() : (call.people.get(id) || {});
                const person = { id, display_name: meta.name || 'Someone', avatar_path: meta.avatar_path };
                const quality = id === me() ? 'good' : ((call.peers.get(id) || {}).quality || 'good');
                return `
                    <button class="call-person" data-person="${esc(id)}" ${id === me() ? 'disabled' : ''} aria-label="${esc(nameOf(id))}">
                        <span class="call-ring">
                            ${avatar(person, 'xl')}
                            ${meta.hand ? '<span class="call-hand" title="Hand raised">✋</span>' : ''}
                            ${quality !== 'good' ? `<span class="call-quality q-${quality}" title="${quality === 'lost' ? 'Reconnecting' : 'Weak connection'}"><i></i><i></i><i></i></span>` : ''}
                        </span>
                        <span class="call-name">${esc(nameOf(id))}${meta.muted ? ' <svg class="i"><use href="#i-mic-off"/></svg>' : ''}</span>
                    </button>`;
            }).join('');
        }
        $('call-mute').setAttribute('aria-pressed', String(call.muted));
        $('call-mute').innerHTML = `<svg class="i"><use href="#${call.muted ? 'i-mic-off' : 'i-mic'}"/></svg><span>${call.muted ? 'Unmute' : 'Mute'}</span>`;
        $('call-hand').setAttribute('aria-pressed', String(call.hand));
        $('call-speaker').setAttribute('aria-pressed', String(!call.speaker));
    }

    function duration() {
        if (!call || !call.started) return '0:00';
        return Media.formatDuration((Date.now() - call.started) / 1000);
    }

    function setMuted(muted) {
        call.muted = muted;
        call.local.getAudioTracks().forEach(t => { t.enabled = !muted; });
        if (call.channelReady) call.channel.track(myMeta()).catch(() => {});
        paintPanel();
    }

    $('call-mute').addEventListener('click', () => { if (call) setMuted(!call.muted); });
    $('call-hand').addEventListener('click', () => toggleHand());
    $('call-react').addEventListener('click', () => {
        const bar = $('call-reactions');
        bar.hidden = !bar.hidden;
    });
    $('call-reactions').innerHTML = REACTIONS.map(e => `<button type="button" data-react="${e}" aria-label="React ${e}">${e}</button>`).join('');
    $('call-reactions').addEventListener('click', e => {
        const b = e.target.closest('[data-react]');
        if (b) react(b.dataset.react);
    });
    $('call-add').addEventListener('click', e => addPeople(e.currentTarget));
    $('call-people').addEventListener('click', e => {
        const tile = e.target.closest('[data-person]');
        if (tile) personMenu(tile, tile.dataset.person);
    });

    $('call-speaker').addEventListener('click', () => {
        if (!call) return;
        call.speaker = !call.speaker;
        call.peers.forEach(p => { if (p.audio) p.audio.muted = !call.speaker; });
        app.showToast(call.speaker ? 'Call sound on' : 'Call sound off');
        paintPanel();
    });

    $('call-leave').addEventListener('click', () => leave(true));
    $('call-minimize').addEventListener('click', () => panel.classList.add('min'));
    $('call-mini').addEventListener('click', expand);

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
