// Live video to friends. The host's camera goes straight to each viewer over WebRTC (one connection per viewer),
// with Supabase Realtime carrying the signalling, live chat and hearts on a private "diary_live:<id>" channel
// that only the host and their friends may join. A stream row in diary_live_streams lists who's live; the host's
// heartbeat keeps it fresh, so a stream whose phone died simply drops off the list.
document.addEventListener('DOMContentLoaded', () => {
    const app = window.diaryApp;
    const social = window.diarySocial;
    if (!app || !social || !social.available) return;
    const I = social.internals;
    const { client, esc, avatar, timeAgo } = I;
    const s = I.state;
    const cfg = window.DIARY_CONFIG || {};
    const $ = id => document.getElementById(id);
    const ICE = cfg.iceServers || [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }];
    const MAX_VIEWERS = 15;        // one upload per viewer — phones get warm beyond this
    const HEARTBEAT = 30000;
    const FRESH = 90000;           // a stream without a heartbeat for this long is over
    const PROFILE = 'username, display_name, avatar_path';

    const dialog = $('live');
    const video = $('lv-video');

    const L = {
        list: null,          // friends live right now
        listSub: null,
        loading: false,
        mode: null,          // 'setup' | 'live' | 'watch' | 'ended'
        stream: null,        // the diary_live_streams row
        media: null,         // host camera + mic
        facing: 'user',
        channel: null,
        selfId: null,        // this device in this stream (a user may watch on two devices)
        peers: new Map(),    // host: viewerId -> { pc, queue, remoteSet }
        pc: null,            // viewer: the connection to the host
        queue: [],
        remoteSet: false,
        viewers: 0,
        beat: null,
        clock: null
    };

    const me = () => s.profile && s.profile.id;
    const cameraFor = facing => {
        const upright = window.innerHeight > window.innerWidth && window.matchMedia('(pointer: coarse)').matches;
        return upright
            ? { facingMode: facing, width: { ideal: 720 }, height: { ideal: 1280 } }
            : { facingMode: facing, width: { ideal: 1280 }, height: { ideal: 720 } };
    };
    const reduced = () => document.documentElement.dataset.motion === 'reduce' || window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    window.diaryLive = {
        start: goLive,
        watch: id => watch(id),
        strip: liveStrip,
        list: () => L.list || [],
        ensure: () => { if (L.list === null) loadLive(); },
        refresh: () => loadLive()
    };

    // ---------- Who's live ----------
    async function loadLive() {
        if (!me() || L.loading) return;
        L.loading = true;
        const { data, error } = await client.from('diary_live_streams')
            .select(`id, host, title, audience, started_at, last_seen, host_profile:diary_profiles!diary_live_streams_host_fkey(${PROFILE})`)
            .is('ended_at', null)
            .gt('last_seen', new Date(Date.now() - FRESH).toISOString())
            .order('started_at', { ascending: false })
            .limit(40);
        L.loading = false;
        const before = (L.list || []).map(x => x.id).join();
        L.list = error ? [] : data;
        paintStrips();
        if (L.mode === 'watch') paintHop();
        if (before !== L.list.map(x => x.id).join() && !document.getElementById('ex-search')?.value) app.requestRender('explore');
        if (!L.listSub) {
            L.listSub = client.channel(`diary-live-list-${me()}`)
                .on('postgres_changes', { event: '*', schema: 'public', table: 'diary_live_streams' }, () => {
                    clearTimeout(L.reload);
                    L.reload = setTimeout(loadLive, 400);
                })
                .subscribe();
        }
    }

    // Streams go stale when a heartbeat stops; re-check now and then while the list is on screen
    setInterval(() => {
        if (me() && ['feed', 'explore'].includes(app.state.view)) loadLive();
        if (!me() && L.list) {
            L.list = null;
            if (L.listSub) client.removeChannel(L.listSub);
            L.listSub = null;
        }
    }, 45000);

    function liveStrip() {
        if (!me()) return '';
        if (L.list === null) {
            loadLive();
            return '<div class="live-strip" id="live-strip" hidden></div>';
        }
        return `<div class="live-strip" id="live-strip"${L.list.length ? '' : ' hidden'}>${stripInner()}</div>`;
    }

    function stripInner() {
        return (L.list || []).map(x => {
            const p = x.host_profile || { display_name: 'Someone' };
            const mine = x.host === me();
            return `
                <button type="button" class="live-card" data-action="live-watch" data-id="${esc(x.id)}">
                    <span class="lc-av">${avatar({ id: x.host, ...p }, 'md')}<span class="live-badge">LIVE</span></span>
                    <span class="lc-text">
                        <strong>${mine ? 'You’re live' : esc(p.display_name)}</strong>
                        <small>${esc(x.title || 'Live now')} · ${timeAgo(x.started_at)}</small>
                    </span>
                </button>`;
        }).join('');
    }

    function paintStrips() {
        document.querySelectorAll('#live-strip').forEach(el => {
            el.innerHTML = stripInner();
            el.hidden = !(L.list && L.list.length);
            I.hydrateStorage(el);
        });
    }

    // ---------- Screen ----------
    function setMode(mode) {
        L.mode = mode;
        dialog.dataset.mode = mode;
        $('lv-setup').hidden = mode !== 'setup';
        $('lv-badge').hidden = !(mode === 'live' || mode === 'watch');
        $('lv-viewers').hidden = !(mode === 'live' || mode === 'watch');
        $('lv-bar').hidden = mode === 'setup' || mode === 'ended';
    }

    function status(html) {
        $('lv-status').innerHTML = html || '';
        $('lv-status').hidden = !html;
    }

    function paintHost(profile, title) {
        const p = profile || s.profile;
        // Watching someone you're not friends with: follow them to hear next time they go live
        const follow = p.id && p.id !== me() && I.followButton ? I.followButton(p, 'lv-follow') : '';
        $('lv-host').innerHTML = `${avatar({ id: p.id, ...p }, 'sm')}<span><strong>${esc(p.display_name)}</strong><small id="lv-sub">${esc(title || '')}</small></span>${follow}`;
        I.hydrateStorage($('lv-host'));
    }

    function paintTitle() {
        const line = $('lv-title-line');
        const t = L.stream && L.stream.title;
        line.textContent = t || '';
        line.hidden = !t || !(L.mode === 'live' || L.mode === 'watch');
    }

    function paintViewers() {
        $('lv-viewers').querySelector('b').textContent = String(L.viewers);
    }

    function startClock() {
        clearInterval(L.clock);
        const started = L.stream ? Date.parse(L.stream.started_at) : Date.now();
        const tick = () => {
            const secs = Math.max(0, Math.floor((Date.now() - started) / 1000));
            $('lv-badge').textContent = `LIVE · ${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`;
        };
        tick();
        L.clock = setInterval(tick, 1000);
    }

    function addChat(name, text, cls = '', who = null) {
        const box = $('lv-chat');
        const row = document.createElement('div');
        row.className = `lv-msg ${cls}`;
        const face = who ? avatar({ id: who.id, display_name: who.name || name, avatar_path: who.av || null }, 'sm') : '';
        row.innerHTML = cls === 'lv-join' || cls === 'lv-love'
            ? `${face}<span class="lv-event"><strong>${esc(name)}</strong> ${esc(text)}</span>`
            : `${face}<span class="lv-bubble"><strong>${esc(name)}</strong><span>${esc(text)}</span></span>`;
        if (face) I.hydrateStorage(row);
        box.append(row);
        while (box.children.length > 40) box.firstChild.remove();
        box.scrollTop = box.scrollHeight;
    }

    function floatHeart() {
        if (reduced()) return;
        const h = document.createElement('span');
        h.className = 'lv-heart';
        h.textContent = ['❤️', '💜', '💖', '🔥', '👏'][Math.floor(Math.random() * 5)];
        h.style.setProperty('--x', `${Math.round((Math.random() - 0.5) * 60)}px`);
        $('lv-hearts').append(h);
        setTimeout(() => h.remove(), 2200);
    }

    // ---------- Hosting ----------
    async function goLive() {
        if (!social.requireSignIn('Sign in to go live with your friends.')) return;
        if (L.mode) return app.showToast('You’re already in a live video');
        if (!navigator.mediaDevices || !window.RTCPeerConnection) return app.showToast('Live video isn’t supported in this browser');
        try {
            L.media = await navigator.mediaDevices.getUserMedia({
                video: cameraFor(L.facing),
                audio: { echoCancellation: true, noiseSuppression: true }
            });
        } catch (e) {
            return app.showToast('Allow camera and microphone access to go live');
        }
        video.srcObject = L.media;
        video.muted = true;
        video.classList.toggle('mirror', L.facing === 'user');
        video.play().catch(() => {});
        $('lv-chat').innerHTML = '';
        $('lv-title').value = '';
        setAudience(L.audience || 'public');
        const fans = s.followerCount || 0;
        const people = s.friends.length + fans;
        L.reachText = `Your ${s.friends.length} ${s.friends.length === 1 ? 'friend' : 'friends'}${fans ? ` and ${fans} ${fans === 1 ? 'follower' : 'followers'}` : ''} ${people === 1 ? 'gets' : 'get'} a notification`;
        paintReach();
        paintHost(s.profile, 'Preview — only you can see this');
        dialog.classList.add('hosting');
        setMode('setup');
        status('');
        dialog.showModal();
        setTimeout(() => $('lv-title').focus(), 200);
    }

    function setAudience(a) {
        L.audience = a;
        document.querySelectorAll('.lv-aud [data-aud]').forEach(b => b.setAttribute('aria-checked', String(b.dataset.aud === a)));
        paintReach();
    }
    function paintReach() {
        if (!L.reachText) return;
        $('lv-reach').textContent = L.audience === 'public'
            ? `${L.reachText}, and anyone on Cordial can find and join your live. Best with up to ${MAX_VIEWERS} people watching.`
            : `${L.reachText} and only they can watch. Best with up to ${MAX_VIEWERS} people watching.`;
    }

    async function startBroadcast() {
        const title = $('lv-title').value.trim().slice(0, 120);
        $('lv-go').disabled = true;
        const { data, error } = await client.from('diary_live_streams').insert({ title, audience: L.audience }).select('id, host, title, audience, started_at').single();
        $('lv-go').disabled = false;
        if (error) {
            app.showToast(/duplicate|unique/i.test(error.message) ? 'You already have a live video going on another device — end it there first, or try again in 2 minutes'
                : /permission|policy|42501/i.test(`${error.message} ${error.code}`) ? 'Couldn’t start your live video — your account isn’t allowed to go live right now'
                : !navigator.onLine ? 'You’re offline — connect to go live' : `Couldn’t start your live video — ${error.message || 'try again'}`);
            return;
        }
        L.stream = data;
        L.selfId = `${me()}:host`;
        paintHost(s.profile, title || 'Live now');
        setMode('live');
        startClock();
        L.viewers = 0;
        paintViewers();
        status(`<span class="lv-wait">You’re live${L.stream.audience === 'public' ? ' to everyone' : ''}. Waiting for someone to join…</span>`);
        paintTitle();
        joinChannel(true);
        L.beat = setInterval(() => {
            client.from('diary_live_streams').update({ last_seen: new Date().toISOString() }).eq('id', L.stream.id).then(() => {});
        }, HEARTBEAT);
        if (navigator.vibrate) navigator.vibrate(20);
        loadLive();
    }

    function hostOffer(viewerId) {
        if (L.peers.has(viewerId)) closePeer(viewerId);
        if (L.peers.size >= MAX_VIEWERS) {
            send('full', { to: viewerId });
            return;
        }
        const pc = new RTCPeerConnection({ iceServers: ICE });
        const peer = { pc, queue: [], remoteSet: false };
        L.peers.set(viewerId, peer);
        L.media.getTracks().forEach(t => pc.addTrack(t, L.media));
        pc.onicecandidate = e => { if (e.candidate) send('ice', { to: viewerId, candidate: e.candidate.toJSON() }); };
        pc.onconnectionstatechange = () => {
            if (['failed', 'closed'].includes(pc.connectionState)) closePeer(viewerId);
        };
        pc.createOffer()
            .then(offer => pc.setLocalDescription(offer))
            .then(() => send('offer', { to: viewerId, sdp: pc.localDescription.toJSON() }))
            .catch(() => closePeer(viewerId));
    }

    function closePeer(id) {
        const peer = L.peers.get(id);
        if (!peer) return;
        L.peers.delete(id);
        try { peer.pc.close(); } catch (e) {}
    }

    async function flipCamera() {
        if (!L.media) return;
        const next = L.facing === 'user' ? 'environment' : 'user';
        try {
            const fresh = await navigator.mediaDevices.getUserMedia({ video: cameraFor(next) });
            const track = fresh.getVideoTracks()[0];
            const old = L.media.getVideoTracks()[0];
            L.peers.forEach(p => p.pc.getSenders().filter(x => x.track && x.track.kind === 'video').forEach(x => x.replaceTrack(track)));
            L.media.removeTrack(old);
            old.stop();
            L.media.addTrack(track);
            L.facing = next;
            // A fresh stream object makes the phone re-measure the picture — reusing the old one kept the
            // previous camera's size, so the back camera showed shrunk instead of filling the screen
            video.srcObject = new MediaStream(L.media.getTracks());
            video.play().catch(() => {});
            video.classList.toggle('mirror', next === 'user');
        } catch (e) {
            app.showToast('This device has only one camera');
        }
    }

    function toggleMute() {
        if (!L.media) return;
        const track = L.media.getAudioTracks()[0];
        if (!track) return;
        track.enabled = !track.enabled;
        $('lv-mute').setAttribute('aria-pressed', String(!track.enabled));
        $('lv-mute').setAttribute('aria-label', track.enabled ? 'Mute microphone' : 'Unmute microphone');
        $('lv-mute').innerHTML = `<svg class="i"><use href="#${track.enabled ? 'i-mic' : 'i-mic-off'}"/></svg>`;
    }

    async function endBroadcast(silent = false) {
        if (!L.stream) return cleanup();
        const id = L.stream.id;
        send('end', {});
        await client.from('diary_live_streams').update({ ended_at: new Date().toISOString() }).eq('id', id);
        const secs = Math.floor((Date.now() - Date.parse(L.stream.started_at)) / 1000);
        cleanup();
        if (!silent) app.showToast(`Live video ended · ${Math.floor(secs / 60)}m ${secs % 60}s`);
        loadLive();
    }

    // ---------- Watching ----------
    async function watch(id) {
        if (!social.requireSignIn('Sign in to watch your friends live.')) return;
        if (L.mode === 'live') return app.showToast('End your own live video first');
        if (L.mode) cleanup(true);
        const { data } = await client.from('diary_live_streams')
            .select(`id, host, title, audience, started_at, last_seen, ended_at, host_profile:diary_profiles!diary_live_streams_host_fkey(${PROFILE})`)
            .eq('id', id).maybeSingle();
        if (!data) return app.showToast('That live video isn’t available');
        if (data.host === me()) return app.showToast('That’s your own live video');
        L.stream = data;
        L.fit = null;
        L.selfId = `${me()}:${Math.random().toString(36).slice(2, 8)}`;
        dialog.classList.remove('hosting');
        $('lv-chat').innerHTML = '';
        video.srcObject = null;
        video.muted = true;
        video.classList.remove('mirror');
        paintHost({ id: data.host, ...(data.host_profile || { display_name: 'A friend' }) }, data.title || 'Live now');
        if (data.ended_at || Date.now() - Date.parse(data.last_seen) > FRESH) {
            setMode('ended');
            status(`<strong>This live video has ended</strong><span>${esc((data.host_profile && data.host_profile.display_name) || 'They')} went live ${timeAgo(data.started_at)}.</span>`);
            dialog.showModal();
            return;
        }
        setMode('watch');
        paintTitle();
        paintHop();
        startClock();
        L.viewers = 0;
        paintViewers();
        status('<span class="lv-spinner" aria-hidden="true"></span><span>Connecting…</span>');
        dialog.showModal();
        joinChannel(false);
    }

    function viewerAnswer(sdp) {
        if (L.pc) try { L.pc.close(); } catch (e) {}
        const pc = L.pc = new RTCPeerConnection({ iceServers: ICE });
        L.queue = [];
        L.remoteSet = false;
        pc.ontrack = e => {
            if (video.srcObject !== e.streams[0]) {
                video.srcObject = e.streams[0];
                video.play().then(() => {
                    status(video.muted ? '<button type="button" class="lv-unmute" id="lv-unmute"><svg class="i"><use href="#i-volume-off"/></svg>Tap for sound</button>' : '');
                }).catch(() => status('<button type="button" class="lv-unmute" id="lv-unmute"><svg class="i"><use href="#i-play"/></svg>Tap to watch</button>'));
            }
        };
        pc.onicecandidate = e => { if (e.candidate) send('ice', { to: `${L.stream.host}:host`, candidate: e.candidate.toJSON() }); };
        pc.onconnectionstatechange = () => {
            if (pc.connectionState === 'failed') status('<span>The connection dropped.</span><button type="button" class="lv-retry" id="lv-retry">Reconnect</button>');
        };
        pc.setRemoteDescription(sdp)
            .then(() => {
                L.remoteSet = true;
                L.queue.splice(0).forEach(c => pc.addIceCandidate(c).catch(() => {}));
                return pc.createAnswer();
            })
            .then(answer => pc.setLocalDescription(answer))
            .then(() => send('answer', { to: `${L.stream.host}:host`, sdp: pc.localDescription.toJSON() }))
            .catch(() => status('<span>Couldn’t connect to this live video.</span><button type="button" class="lv-retry" id="lv-retry">Try again</button>'));
    }

    // ---------- Channel ----------
    function joinChannel(isHost) {
        const channel = client.channel(`diary_live:${L.stream.id}`, {
            config: { private: true, broadcast: { self: false }, presence: { key: L.selfId } }
        });
        L.channel = channel;
        const forMe = p => p && p.to === L.selfId;
        channel
            .on('broadcast', { event: 'join' }, ({ payload }) => { if (isHost && payload.from) hostOffer(payload.from); })
            .on('broadcast', { event: 'hello' }, () => { if (!isHost) send('join', {}); })
            .on('broadcast', { event: 'offer' }, ({ payload }) => { if (!isHost && forMe(payload)) viewerAnswer(payload.sdp); })
            .on('broadcast', { event: 'answer' }, ({ payload }) => {
                if (!isHost || !forMe(payload)) return;
                const peer = L.peers.get(payload.from);
                if (!peer) return;
                peer.pc.setRemoteDescription(payload.sdp).then(() => {
                    peer.remoteSet = true;
                    peer.queue.splice(0).forEach(c => peer.pc.addIceCandidate(c).catch(() => {}));
                }).catch(() => closePeer(payload.from));
            })
            .on('broadcast', { event: 'ice' }, ({ payload }) => {
                if (!forMe(payload)) return;
                if (isHost) {
                    const peer = L.peers.get(payload.from);
                    if (!peer) return;
                    if (peer.remoteSet) peer.pc.addIceCandidate(payload.candidate).catch(() => {});
                    else peer.queue.push(payload.candidate);
                } else if (L.pc && L.remoteSet) {
                    L.pc.addIceCandidate(payload.candidate).catch(() => {});
                } else {
                    L.queue.push(payload.candidate);
                }
            })
            .on('broadcast', { event: 'leave' }, ({ payload }) => { if (isHost) closePeer(payload.from); })
            .on('broadcast', { event: 'full' }, ({ payload }) => {
                if (!isHost && forMe(payload)) status('<strong>This live video is full</strong><span>Too many friends are watching right now — try again in a bit.</span>');
            })
            .on('broadcast', { event: 'end' }, () => {
                if (isHost) return;
                setMode('ended');
                video.srcObject = null;
                status('<strong>The live video has ended</strong><span>Thanks for watching 💜</span>');
                if (L.pc) try { L.pc.close(); } catch (e) {}
                L.pc = null;
            })
            .on('broadcast', { event: 'chat' }, ({ payload }) => addChat(payload.name || 'Someone', String(payload.text || '').slice(0, 200), '', { id: String(payload.from || '').split(':')[0], name: payload.name, av: payload.av }))
            .on('broadcast', { event: 'heart' }, ({ payload }) => {
                floatHeart();
                // "sent ❤️" once in a while per person, so the chat isn't flooded
                const uid = String((payload && payload.from) || '').split(':')[0];
                const now = Date.now();
                L.lovedAt = L.lovedAt || new Map();
                if (payload && payload.name && now - (L.lovedAt.get(uid) || 0) > 20000) {
                    L.lovedAt.set(uid, now);
                    addChat(String(payload.name).split(' ')[0], 'sent ❤️', 'lv-love', { id: uid, name: payload.name, av: payload.av });
                }
            })
            .on('presence', { event: 'sync' }, () => {
                const keys = Object.keys(channel.presenceState());
                L.viewers = keys.filter(k => !k.endsWith(':host')).length;
                paintViewers();
                if (isHost && L.viewers > 0) status('');
                if (isHost) {
                    // Someone who vanished without saying goodbye
                    [...L.peers.keys()].forEach(id => { if (!keys.includes(id)) closePeer(id); });
                }
            })
            .on('presence', { event: 'join' }, ({ key, newPresences }) => {
                if (key.endsWith(':host') || key === L.selfId) return;
                const meta = (newPresences && newPresences[0]) || {};
                const uid = key.split(':')[0];
                const name = uid === me() ? 'You' : meta.name || ((s.friends.find(f => f.id === uid) || {}).display_name) || 'Someone';
                addChat(String(name).split(' ')[0], 'joined 👋', 'lv-join', { id: uid, name, av: meta.av });
            })
            .subscribe(async state => {
                if (state !== 'SUBSCRIBED') {
                    if (state === 'CHANNEL_ERROR' && !isHost) status('<span>You can’t watch this live video.</span>');
                    return;
                }
                await channel.track({ at: Date.now(), name: s.profile.display_name, av: s.profile.avatar_path || null });
                if (isHost) send('hello', {});
                else send('join', {});
            });
    }

    function send(event, payload) {
        if (!L.channel) return;
        L.channel.send({ type: 'broadcast', event, payload: { ...payload, from: L.selfId } });
    }

    // ---------- Leaving ----------
    function cleanup(keepOpen = false) {
        clearInterval(L.beat);
        clearInterval(L.clock);
        if (L.mode === 'watch') send('leave', {});
        L.peers.forEach((_, id) => closePeer(id));
        if (L.pc) try { L.pc.close(); } catch (e) {}
        L.pc = null;
        if (L.media) L.media.getTracks().forEach(t => t.stop());
        L.media = null;
        if (L.channel) client.removeChannel(L.channel);
        L.channel = null;
        L.stream = null;
        L.mode = null;
        video.srcObject = null;
        dialog.classList.remove('hosting');
        $('lv-title-line').hidden = true;
        $('lv-hop').hidden = true;
        if (dialog.open && !keepOpen) dialog.close();
    }

    // ---------- Fit the device ----------
    // Wide stream on a computer: a wide stage. Tall stream: a tall stage. On a phone the stage is the whole
    // screen; a stream whose shape doesn't match the screen is shown whole (fit) unless you choose fill.
    function adapt() {
        const vw = video.videoWidth, vh = video.videoHeight;
        if (!vw || !vh) return;
        const wideVideo = vw > vh * 1.1;
        dialog.dataset.video = wideVideo ? 'wide' : 'tall';
        const screenTall = window.innerHeight >= window.innerWidth;
        const desk = window.matchMedia('(min-width: 900px) and (min-height: 600px) and (hover: hover)').matches;
        const mismatch = !desk && wideVideo === screenTall;
        const fit = L.fit || (mismatch && L.mode === 'watch' ? 'contain' : 'cover');
        video.style.objectFit = fit;
        const btn = $('lv-fit');
        btn.hidden = !(L.mode === 'watch') || desk;
        btn.setAttribute('aria-pressed', String(fit === 'contain'));
        btn.setAttribute('aria-label', fit === 'contain' ? 'Fill the screen' : 'Show the whole picture');
    }
    video.addEventListener('loadedmetadata', adapt);
    video.addEventListener('resize', adapt);
    window.addEventListener('resize', () => { if (L.mode) adapt(); });
    $('lv-fit').addEventListener('click', () => {
        L.fit = video.style.objectFit === 'contain' ? 'cover' : 'contain';
        adapt();
    });

    // ---------- Many lives at once: hop between them ----------
    function others() { return (L.list || []).filter(x => x.host !== me()); }
    function paintHop() {
        const list = others();
        const i = list.findIndex(x => L.stream && x.id === L.stream.id);
        $('lv-hop').hidden = !(L.mode === 'watch' && list.length > 1);
        $('lv-hop-n').textContent = list.length > 1 ? `${Math.max(1, i + 1)}/${list.length}` : '';
    }
    async function hop(step) {
        if (L.mode !== 'watch' && L.mode !== 'ended') return;
        await loadLive();
        const list = others();
        if (list.length < 2) return app.showToast('No other lives right now');
        const i = list.findIndex(x => L.stream && x.id === L.stream.id);
        const next = list[(i + step + list.length) % list.length];
        if (next) watch(next.id);
    }
    // Swipe up / down on the video to change live (phones)
    let touchY = null;
    dialog.addEventListener('touchstart', e => { if (L.mode === 'watch' || L.mode === 'ended') touchY = e.touches[0].clientY; }, { passive: true });
    dialog.addEventListener('touchend', e => {
        if (touchY === null) return;
        const dy = e.changedTouches[0].clientY - touchY;
        touchY = null;
        if (Math.abs(dy) > 90 && !e.target.closest('.lv-bar, .lv-chat')) hop(dy < 0 ? 1 : -1);
    }, { passive: true });

    async function shareLive() {
        if (!L.stream) return;
        const link = `${location.origin}${location.pathname}?live=${encodeURIComponent(L.stream.id)}`;
        const title = L.stream.title || 'Live on Cordial';
        if (navigator.share) {
            try { await navigator.share({ title, text: `Watch “${title}” live on Cordial`, url: link }); return; }
            catch (e) { if (e && e.name === 'AbortError') return; }
        }
        try { await navigator.clipboard.writeText(link); app.showToast('Live link copied'); }
        catch (e) { app.ask({ title: 'Live link', text: 'Copy this link to share the live:', value: link, ok: 'Done' }); }
    }

    // A shared link: ?live=<id>
    (() => {
        const id = new URLSearchParams(location.search).get('live');
        if (!id || !/^[0-9a-f-]{36}$/i.test(id)) return;
        const url = new URL(location.href);
        url.searchParams.delete('live');
        history.replaceState(history.state, '', url.pathname + url.search + url.hash);
        let tries = 0;
        const wait = setInterval(() => {
            if (me()) { clearInterval(wait); watch(id); }
            else if (++tries > 40) clearInterval(wait);
        }, 500);
    })();

    async function leave() {
        if (L.mode === 'live') {
            const ok = await app.ask({ title: 'End your live video?', text: 'Everyone watching will see that it has ended.', ok: 'End live video', danger: true });
            if (ok) endBroadcast();
            return;
        }
        cleanup();
    }

    // ---------- Controls ----------
    $('lv-go').addEventListener('click', startBroadcast);
    document.querySelectorAll('.lv-aud [data-aud]').forEach(b => b.addEventListener('click', () => setAudience(b.dataset.aud)));
    $('lv-share').addEventListener('click', shareLive);
    $('lv-hop').addEventListener('click', e => { const b = e.target.closest('[data-hop]'); if (b) hop(Number(b.dataset.hop)); });
    $('lv-title').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); startBroadcast(); } });
    $('lv-close').addEventListener('click', leave);
    $('lv-end').addEventListener('click', leave);
    $('lv-flip').addEventListener('click', flipCamera);
    $('lv-mute').addEventListener('click', toggleMute);
    $('lv-heart').addEventListener('click', () => {
        floatHeart();
        send('heart', { name: s.profile.display_name, av: s.profile.avatar_path || null });
        if (navigator.vibrate) navigator.vibrate(8);
    });
    $('lv-say').addEventListener('submit', e => {
        e.preventDefault();
        const input = $('lv-say-input');
        const text = input.value.trim().slice(0, 200);
        if (!text || !L.channel) return;
        input.value = '';
        addChat('You', text, 'mine', { id: me(), name: s.profile.display_name, av: s.profile.avatar_path });
        send('chat', { name: s.profile.display_name.split(' ')[0], text, av: s.profile.avatar_path || null });
    });
    $('lv-host').addEventListener('click', e => {
        const b = e.target.closest('[data-action="follow"]');
        if (b) I.toggleFollow(b.dataset.id, b.dataset.name);
    });
    $('lv-status').addEventListener('click', e => {
        if (e.target.closest('#lv-unmute')) {
            video.muted = false;
            video.play().catch(() => {});
            status('');
        }
        if (e.target.closest('#lv-retry') && L.stream) {
            status('<span class="lv-spinner" aria-hidden="true"></span><span>Reconnecting…</span>');
            send('join', {});
        }
    });
    dialog.addEventListener('cancel', e => {
        e.preventDefault();
        leave();
    });
    // Closing the tab mid-stream: say goodbye; the heartbeat takes care of the rest
    window.addEventListener('pagehide', () => {
        if (L.mode === 'live' && L.stream) {
            send('end', {});
            client.from('diary_live_streams').update({ ended_at: new Date().toISOString() }).eq('id', L.stream.id).then(() => {});
        } else if (L.mode === 'watch') {
            send('leave', {});
        }
    });

    Object.assign(app.actions, {
        'live-start': () => goLive(),
        'live-watch': el => watch(el.dataset.id)
    });
});
