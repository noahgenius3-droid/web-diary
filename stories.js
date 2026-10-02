// Stories (photos and videos that last 24 hours) and Reels (short vertical videos). Friends only.
// Builds on social.js (auth, storage URLs, comments and saved items).
document.addEventListener('DOMContentLoaded', () => {
    const app = window.diaryApp;
    const social = window.diarySocial;
    const I = social && social.internals;
    if (!I) return;
    const { client, state: s, esc, avatar, timeAgo, gate, randomId, uploadImage, hydrateStorage } = I;
    const $ = id => document.getElementById(id);
    const content = $('content');

    const STORY_BUCKET = 'diary-stories';
    const REEL_BUCKET = 'diary-reels';
    const VIDEO_TYPES = { 'video/mp4': '.mp4', 'video/quicktime': '.mov', 'video/webm': '.webm' };
    const IMAGE_SECONDS = 6;
    const MAX_STORY_VIDEO = 60;
    const MAX_REEL = 180;
    const MAX_BYTES = 50 * 1048576;
    const PROFILE = 'username, display_name, avatar_path';
    const STORY_AUDIO_MAX = 30; // a photo story with music stays up as long as the song plays, up to this

    const st = {
        userId: null,
        stories: null,       // live stories you can see, oldest first
        storiesLoading: false,
        reels: null,
        reelsLoading: false,
        muted: true,         // reels start muted, like everywhere else
        channel: null,
        busy: false          // an upload is running
    };

    window.diaryStories = {
        strip,
        reels: () => st.reels || [],
        paintCounts,
        openReelComments,
        feedReels,
        feedCard,
        addStory: fileArg => addStory(fileArg),
        addReel: (fileArg, opts) => addReel(fileArg, opts),
        shareEntry: (localId, text, post) => shareEntry(localId, text, post),
        // A note from the Notes page → your story as a coloured text card (it doesn't need to be on the Feed)
        shareText: async (text, color) => {
            try {
                const card = await textCard(text, color);
                const path = await uploadImage(STORY_BUCKET, `${s.profile.id}/${randomId()}`, card);
                if (!path) throw new Error('upload');
                await shareToStory({ bucket: STORY_BUCKET, path, type: 'image' });
                app.showToast('Added to your story ✨');
            } catch (e) {
                app.showToast('Couldn’t add that to your story');
                return false;
            }
            await loadStories();
            paintStrip();
            return true;
        },
        // From a "reacted to your story" notification: your own stories, if any are still up
        openMine: async () => {
            if (!st.stories) await loadStories();
            if (groups().some(g => g.author === s.profile.id)) openStories(s.profile.id);
            else app.showToast('That story has expired');
        }
    };

    // ---------- Lifecycle ----------
    setInterval(() => {
        const id = s.profile && s.profile.id;
        if (id && st.userId !== id) start(id);
        if (!id && st.userId) stop();
    }, 1000);

    function start(id) {
        stop();
        st.userId = id;
        loadStories();
        st.channel = client.channel(`diary-media-${id}`)
            .on('postgres_changes', { event: '*', schema: 'public', table: 'diary_stories' }, () => loadStories())
            .on('postgres_changes', { event: '*', schema: 'public', table: 'diary_reels' }, () => {
                if (st.reels !== null && app.state.view !== 'reels') {
                    st.reels = null;
                    if (app.state.view === 'feed') loadReels();
                }
            })
            .subscribe();
    }

    function stop() {
        if (st.channel) client.removeChannel(st.channel);
        Object.assign(st, { userId: null, stories: null, reels: null, channel: null });
    }

    // ---------- Stories ----------
    async function loadStories() {
        if (st.storiesLoading) return;
        st.storiesLoading = true;
        const { data } = await client.from('diary_stories')
            .select(`id, author, media_path, media_type, bucket, caption, duration, created_at, expires_at,
                audio_path, audio_duration, audio_name,
                author_profile:diary_profiles!diary_stories_author_fkey(${PROFILE})`)
            .order('created_at')
            .limit(200);
        st.storiesLoading = false;
        st.stories = data || [];
        if (app.state.view === 'feed') paintStrip();
    }

    // One group per person, you first, then unseen stories before ones you've watched
    function groups() {
        const me = s.profile.id;
        const byAuthor = new Map();
        (st.stories || []).forEach(x => {
            if (Date.parse(x.expires_at) < Date.now()) return;
            if (!byAuthor.has(x.author)) {
                const p = x.author_profile || { display_name: 'Someone', username: '' };
                byAuthor.set(x.author, { author: x.author, person: { id: x.author, ...p }, items: [] });
            }
            byAuthor.get(x.author).items.push(x);
        });
        const seenAll = g => g.items.every(x => s.seenStories.has(x.id));
        const latest = g => Date.parse(g.items[g.items.length - 1].created_at);
        return [...byAuthor.values()].sort((a, b) =>
            (b.author === me) - (a.author === me) || seenAll(a) - seenAll(b) || latest(b) - latest(a));
    }

    function strip() {
        if (st.stories === null) loadStories();
        const me = s.profile.id;
        const list = groups();
        const mine = list.find(g => g.author === me);
        return `
            <section class="stories-bar" id="stories-bar" aria-label="Stories">
                <div class="stories">
                    <button class="story" data-action="story-add" aria-label="Add to your story">
                        <span class="story-ring add-own">${avatar(s.profile, 'lg')}<span class="story-plus"><svg class="i"><use href="#i-plus"/></svg></span></span>
                        <span>${st.busy ? 'Posting…' : 'Add story'}</span>
                    </button>
                    ${window.diaryLive ? `<button class="story story-live" data-action="live-start" aria-label="Go live — start a live video">
                        <span class="story-ring go-live"><span class="go-live-ic"><svg class="i"><use href="#i-live"/></svg></span></span>
                        <span>Go live</span>
                    </button>` : ''}
                    ${list.map(g => `
                        <button class="story" data-action="story-open" data-id="${esc(g.author)}">
                            <span class="story-ring${g.items.every(x => s.seenStories.has(x.id)) ? ' seen' : ''}">${avatar(g.person, 'lg')}</span>
                            <span>${g === mine ? 'Your story' : esc((g.person.display_name || 'Friend').split(' ')[0])}</span>
                        </button>`).join('')}
                    ${!list.length && st.stories !== null ? '<p class="stories-empty muted small">Share a photo or video that disappears after 24 hours.</p>' : ''}
                </div>
            </section>`;
    }

    function paintStrip() {
        const bar = $('stories-bar');
        if (bar) bar.outerHTML = strip();
    }

    // ---------- Adding a story or a reel ----------
    // Reads a video's length and (for reels) a poster frame. iPhones only load a video that's on the page
    // and has been asked to play, so the element is attached off-screen and nudged if it stalls.
    // Never fails outright: if the browser can't decode the format, it says so and the upload still goes ahead.
    function probeVideo(file, wantPoster) {
        return new Promise(resolve => {
            const url = URL.createObjectURL(file);
            const video = document.createElement('video');
            let done = false;
            let duration = null;
            let nudge = null;
            let giveUp = null;
            const finish = result => {
                if (done) return;
                done = true;
                clearTimeout(nudge);
                clearTimeout(giveUp);
                try { video.pause(); } catch (e) {}
                video.removeAttribute('src');
                video.remove();
                URL.revokeObjectURL(url);
                resolve({ duration, poster: null, width: video.videoWidth || 0, height: video.videoHeight || 0, ...result });
            };
            const readDuration = () => {
                const d = video.duration;
                if (Number.isFinite(d) && d > 0) duration = d;
            };
            const grab = () => {
                try {
                    if (!video.videoWidth) return finish({});
                    const scale = Math.min(1, 720 / Math.max(video.videoWidth, video.videoHeight));
                    const canvas = document.createElement('canvas');
                    canvas.width = Math.round(video.videoWidth * scale);
                    canvas.height = Math.round(video.videoHeight * scale);
                    canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
                    canvas.toBlob(blob => finish({ poster: blob }), 'image/jpeg', 0.8);
                } catch (e) {
                    finish({});
                }
            };
            video.muted = true;
            video.playsInline = true;
            video.setAttribute('playsinline', '');
            video.setAttribute('muted', '');
            video.preload = 'auto';
            video.style.cssText = 'position:fixed;left:-10000px;top:0;width:4px;height:4px;opacity:0;pointer-events:none';
            video.addEventListener('loadedmetadata', () => {
                readDuration();
                if (!wantPoster) finish({});
            });
            video.addEventListener('durationchange', readDuration);
            video.addEventListener('loadeddata', () => {
                readDuration();
                if (!wantPoster) return finish({});
                if (duration && duration > 1 && video.currentTime < 0.2) video.currentTime = Math.min(0.5, duration / 2);
                else grab();
            });
            video.addEventListener('seeked', () => { if (wantPoster) grab(); });
            video.addEventListener('error', () => finish({ unreadable: true }));
            document.body.append(video);
            video.src = url;
            video.load();
            nudge = setTimeout(() => {
                const p = video.play();
                if (p && p.then) p.then(() => video.pause()).catch(() => {});
            }, 1200);
            giveUp = setTimeout(() => finish({}), 9000);
        });
    }

    // Big phone videos (4K, high frame rate) are re-recorded at 720p so they fit under the 50 MB limit.
    // Runs in real time while the video plays silently off-screen. Returns a File, or null if the browser can't.
    // Decode the music chosen for a video: a rendered clip (file) or a licensed track's URL (streamed, from its start)
    async function musicBuffer(audioCtx, pick) {
        let bytes;
        if (pick.file) bytes = await pick.file.arrayBuffer();
        else if (pick.music && pick.music.src) bytes = window.diaryAudioLib ? await window.diaryAudioLib.fetchAudio(pick.music) : await (await fetch(pick.music.src)).arrayBuffer();
        if (!bytes) return null;
        return new Promise((resolve, reject) => audioCtx.decodeAudioData(bytes, resolve, reject));
    }

    async function shrinkVideo(file, { maxSeconds, onProgress, music = null }) {
        const mime = window.MediaRecorder && ['video/mp4;codecs=avc1.42E01E,mp4a.40.2', 'video/mp4', 'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm']
            .find(t => MediaRecorder.isTypeSupported(t));
        if (!mime || !HTMLCanvasElement.prototype.captureStream) return null;
        const url = URL.createObjectURL(file);
        const video = document.createElement('video');
        video.playsInline = true;
        video.setAttribute('playsinline', '');
        video.style.cssText = 'position:fixed;left:-10000px;top:0;width:4px;height:4px;opacity:0;pointer-events:none';
        document.body.append(video);
        let audioCtx = null;
        try {
            await new Promise((resolve, reject) => {
                video.onloadedmetadata = resolve;
                video.onerror = reject;
                setTimeout(reject, 12000);
                video.src = url;
                video.load();
            });
            const scale = Math.min(1, 1280 / Math.max(video.videoWidth, video.videoHeight));
            const canvas = document.createElement('canvas');
            canvas.width = Math.round(video.videoWidth * scale / 2) * 2;
            canvas.height = Math.round(video.videoHeight * scale / 2) * 2;
            const ctx = canvas.getContext('2d');
            const stream = canvas.captureStream(30);
            // Route the sound into the recording only — nothing plays out loud
            let musicSrc = null;
            try {
                audioCtx = new (window.AudioContext || window.webkitAudioContext)();
                const source = audioCtx.createMediaElementSource(video);
                const dest = audioCtx.createMediaStreamDestination();
                const own = audioCtx.createGain();
                own.gain.value = music ? 0.35 : 1; // the video's own sound sits under the music
                source.connect(own);
                own.connect(dest);
                if (music) {
                    const buf = await musicBuffer(audioCtx, music);
                    if (!buf) throw new Error('music');
                    const m = music.music || {};
                    musicSrc = audioCtx.createBufferSource();
                    musicSrc.buffer = buf;
                    musicSrc.loop = true;
                    if (!music.file && m.start) { musicSrc.loopStart = m.start; musicSrc.loopEnd = Math.min(buf.duration, m.start + (m.length || 30)); }
                    const mg = audioCtx.createGain();
                    mg.gain.value = music.file ? 1 : (m.volume || 0.8); // a rendered clip already carries its volume
                    musicSrc.connect(mg);
                    mg.connect(dest);
                }
                dest.stream.getAudioTracks().forEach(t => stream.addTrack(t));
            } catch (e) {
                if (music) throw e; // the music was the point: report it
            }
            const recorder = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 2200000, audioBitsPerSecond: 96000 });
            const chunks = [];
            recorder.ondataavailable = e => { if (e.data && e.data.size) chunks.push(e.data); };
            const stopped = new Promise(resolve => { recorder.onstop = resolve; });
            const limit = Math.min(video.duration || maxSeconds, maxSeconds);
            let finished = false;
            const stop = () => {
                if (finished) return;
                finished = true;
                video.pause();
                if (recorder.state !== 'inactive') recorder.stop();
            };
            const draw = () => {
                if (finished) return;
                ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
                if (onProgress) onProgress(Math.min(1, video.currentTime / limit));
                if (video.currentTime >= limit) stop();
                else requestAnimationFrame(draw);
            };
            video.onended = stop;
            recorder.start(1000);
            if (musicSrc) musicSrc.start(0, (!music.file && music.music && music.music.start) || 0);
            try {
                await video.play();
            } catch (e) {
                video.muted = true; // sound not allowed without a tap — keep the picture at least
                await video.play();
            }
            draw();
            await stopped;
            const type = mime.split(';')[0];
            const out = new File(chunks, `video${VIDEO_TYPES[type] || '.mp4'}`, { type });
            return out.size ? out : null;
        } catch (e) {
            if (music) throw e;
            return null;
        } finally {
            if (audioCtx) audioCtx.close().catch(() => {});
            video.remove();
            URL.revokeObjectURL(url);
        }
    }

    // Upload a picked video, shrinking it first if it's over the limit. Updates the Share button as it goes.
    async function prepareVideo(file, maxSeconds, onStep = null) {
        const hevc = await isHevc(file);
        if (file.size <= MAX_BYTES && !hevc) return file;
        const btn = onStep ? null : $('mc-share');
        app.showToast(hevc
            ? 'Converting your video so everyone can watch it — keep Cordial open…'
            : 'Making your video smaller so it can upload — keep Cordial open…');
        const out = await shrinkVideo(file, {
            maxSeconds,
            onProgress: p => { if (onStep) onStep(p, hevc ? 'Converting your video' : 'Compressing your video'); else if (btn) btn.textContent = `${hevc ? 'Converting' : 'Compressing'} ${Math.round(p * 100)}%`; }
        });
        if (out && out.size <= MAX_BYTES) return out;
        // Couldn't convert here: the original still plays on Apple devices, so send it if it fits
        return file.size <= MAX_BYTES ? file : null;
    }

    // iPhones record HEVC by default ("High Efficiency"), which many Android and Windows browsers can't play.
    // The codec name sits in the file's sample description ("stsd" box) as hvc1 / hev1 / dvh1 / dvhe.
    async function isHevc(file) {
        if (videoType(file) !== 'video/quicktime' && videoType(file) !== 'video/mp4') return false;
        const scan = async blob => {
            const bytes = new Uint8Array(await blob.arrayBuffer());
            for (let i = 0; i < bytes.length - 12; i++) {
                if (bytes[i] === 0x73 && bytes[i + 1] === 0x74 && bytes[i + 2] === 0x73 && bytes[i + 3] === 0x64) { // "stsd"
                    const tag = String.fromCharCode(...bytes.slice(i + 16, i + 20));
                    if (['hvc1', 'hev1', 'dvh1', 'dvhe'].includes(tag)) return true;
                    if (['avc1', 'avc3'].includes(tag)) return false;
                }
            }
            return null;
        };
        try {
            // The index ("moov") is at the start or the end of the file
            const head = await scan(file.slice(0, 4 * 1048576));
            if (head !== null) return head;
            const tail = await scan(file.slice(Math.max(0, file.size - 8 * 1048576)));
            return tail === true;
        } catch (e) {
            return false;
        }
    }

    function videoType(file) {
        const base = (file.type || '').split(';')[0];
        if (VIDEO_TYPES[base]) return base;
        const ext = (file.name || '').toLowerCase().split('.').pop();
        return { mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm' }[ext] || null;
    }

    // The compose sheet: preview, caption, Share. Resolves with { caption, alsoStory } or null if cancelled.
    // allowAudio: offer "Add music" (photo stories). Photos can always be edited with filters first.
    function compose({ title, file, isVideo, maxCaption, note, offerStory = false, storyDefault = false, allowAudio = false, videoAudio = false }) {
        const dialog = $('media-compose');
        const preview = $('mc-preview');
        const caption = $('mc-caption');
        let url = URL.createObjectURL(file);
        let current = file;
        let audio = null;
        const canEdit = !isVideo && window.PhotoEditor && file.type !== 'image/gif';
        $('mc-edit').hidden = !canEdit;
        $('mc-audio').hidden = !(allowAudio && (!isVideo || videoAudio) && I.pickAudio);
        // Hear it before sharing: the music plays with the photo, or with the video from the start (its own sound under the music)
        let hearing = null;
        const stopHearing = () => {
            if (hearing) { hearing.stop(); hearing = null; }
            const v = preview.querySelector('video');
            if (v) { v.muted = true; v.volume = 1; }
            const b = $('mc-audio-chip').querySelector('.mc-hear');
            if (b) { b.setAttribute('aria-pressed', 'false'); b.innerHTML = '<svg class="i"><use href="#i-play"/></svg>Preview'; }
        };
        const hear = () => {
            if (!audio || !I.soundPlayer) return;
            stopHearing();
            const m = audio.music ? I.soundRecord(audio.music) : { volume: 1 };
            if (audio.file && !audio.url) audio.url = URL.createObjectURL(audio.file);
            hearing = I.soundPlayer(m, audio.file ? audio.url : m.src);
            const v = preview.querySelector('video');
            if (v) { v.currentTime = 0; v.muted = false; v.volume = 0.35; v.play().catch(() => { v.muted = true; v.play().catch(() => {}); }); }
            hearing.play().catch(() => { stopHearing(); app.showToast('Couldn’t play that sound'); });
            const b = $('mc-audio-chip').querySelector('.mc-hear');
            if (b) { b.setAttribute('aria-pressed', 'true'); b.innerHTML = '<svg class="i"><use href="#i-pause"/></svg>Stop'; }
        };
        const paintAudio = () => {
            stopHearing();
            const chip = $('mc-audio-chip');
            const m = audio && audio.music;
            chip.hidden = !audio;
            chip.innerHTML = audio ? `${m && window.diaryAudioLib ? window.diaryAudioLib.coverHTML({ cover: m.cover, style: m.style }) : '<svg class="i"><use href="#i-music"/></svg>'}<span class="mc-audio-text"><strong>${esc(m ? m.title : audio.name)}</strong><small>${m ? `${esc(m.artist)} · ` : ''}${Media.formatDuration(isVideo ? audio.duration : Math.min(audio.duration, STORY_AUDIO_MAX))}</small></span><button type="button" class="chip mc-hear" aria-pressed="false"><svg class="i"><use href="#i-play"/></svg>Preview</button><button type="button" class="mc-audio-x" aria-label="Remove sound"><svg class="i"><use href="#i-close"/></svg></button>` : '';
            $('mc-audio').innerHTML = `<svg class="i"><use href="#i-music"/></svg>${audio ? 'Change sound' : 'Add sound'}`;
        };
        paintAudio();
        $('mc-edit').onclick = async () => {
            const edited = await window.PhotoEditor.open(current, { title: 'Edit photo', done: 'Use photo' });
            if (!edited) return;
            current = edited;
            URL.revokeObjectURL(url);
            url = URL.createObjectURL(edited);
            preview.innerHTML = `<img src="${url}" alt="">`;
        };
        $('mc-audio').onclick = async e => {
            const picked = await I.pickAudio(e.currentTarget);
            if (picked) { if (audio && audio.url) URL.revokeObjectURL(audio.url); audio = picked; paintAudio(); hear(); }
        };
        $('mc-audio-chip').onclick = e => {
            if (e.target.closest('.mc-audio-x')) { if (audio && audio.url) URL.revokeObjectURL(audio.url); audio = null; paintAudio(); }
            else if (e.target.closest('.mc-hear')) { if (hearing) stopHearing(); else hear(); }
        };
        $('mc-title').textContent = title;
        $('mc-share').disabled = false;
        $('mc-share').textContent = 'Share';
        caption.value = '';
        caption.maxLength = maxCaption;
        $('mc-note').lastChild.textContent = note;
        $('mc-also').hidden = !offerStory;
        $('mc-story').checked = storyDefault;
        preview.innerHTML = isVideo
            ? `<video src="${url}" playsinline autoplay muted loop></video>`
            : `<img src="${url}" alt="">`;
        dialog.showModal();
        return new Promise(resolve => {
            const cleanup = value => {
                stopHearing();
                if (audio && audio.url) { URL.revokeObjectURL(audio.url); audio.url = null; }
                $('mc-form').onsubmit = null;
                $('mc-cancel').onclick = null;
                dialog.onclose = null;
                if (dialog.open) dialog.close();
                preview.innerHTML = '';
                URL.revokeObjectURL(url);
                $('mc-edit').onclick = $('mc-audio').onclick = $('mc-audio-chip').onclick = null;
                resolve(value);
            };
            $('mc-form').onsubmit = e => {
                e.preventDefault();
                stopHearing();
                $('mc-share').disabled = true;
                $('mc-share').textContent = 'Sharing…';
                // Keep the sheet up (showing progress) until the caller is done
                resolve({ caption: caption.value.trim(), alsoStory: offerStory && $('mc-story').checked, file: current, audio, done: () => cleanup(undefined) });
            };
            $('mc-cancel').onclick = () => cleanup(null);
            dialog.onclose = () => cleanup(null);
        });
    }

    // Put something you already posted on your story — the file stays where it is
    async function shareToStory({ bucket, path, type, caption = '', duration = null }) {
        const { error } = await client.from('diary_stories').insert({
            media_path: path, media_type: type, bucket, caption: caption.slice(0, 300),
            duration: duration ? Math.min(180, Math.max(1, Math.round(duration * 10) / 10)) : null
        });
        if (error) throw error;
    }

    // A text-only post becomes a coloured card, like Instagram's "Create" stories
    function textCard(text, color) {
        const palette = {
            yellow: ['#f7d774', '#f59e0b'], pink: ['#f9a8d4', '#db2777'], blue: ['#93c5fd', '#2563eb'],
            green: ['#86efac', '#059669'], purple: ['#c4b5fd', '#7c3aed'], orange: ['#fdba74', '#ea580c'], coral: ['#fca5a5', '#dc2626'],
            teal: ['#5eead4', '#0d9488'], sky: ['#7dd3fc', '#0284c7'], lime: ['#bef264', '#65a30d'], gray: ['#d4d4d8', '#52525b']
        }[color] || ['#a5b4fc', '#6366f1'];
        const canvas = document.createElement('canvas');
        canvas.width = 1080;
        canvas.height = 1920;
        const ctx = canvas.getContext('2d');
        const g = ctx.createLinearGradient(0, 0, 1080, 1920);
        g.addColorStop(0, palette[0]);
        g.addColorStop(1, palette[1]);
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, 1080, 1920);
        const words = String(text).replace(/\s+/g, ' ').trim().slice(0, 400).split(' ');
        const size = words.length > 60 ? 54 : words.length > 25 ? 66 : 84;
        ctx.font = `700 ${size}px "Inter", system-ui, sans-serif`;
        ctx.fillStyle = '#fff';
        ctx.textAlign = 'center';
        ctx.shadowColor = 'rgba(0,0,0,0.18)';
        ctx.shadowBlur = 12;
        const lines = [];
        let line = '';
        words.forEach(w => {
            const next = line ? `${line} ${w}` : w;
            if (ctx.measureText(next).width > 900 && line) {
                lines.push(line);
                line = w;
            } else {
                line = next;
            }
        });
        if (line) lines.push(line);
        const shown = lines.slice(0, 16);
        const height = shown.length * size * 1.3;
        shown.forEach((l, i) => ctx.fillText(i === 15 && lines.length > 16 ? `${l}…` : l, 540, 960 - height / 2 + i * size * 1.3 + size));
        ctx.shadowBlur = 0;
        ctx.font = '600 40px "Inter", system-ui, sans-serif';
        ctx.fillStyle = 'rgba(255,255,255,0.85)';
        ctx.fillText(`Cordial · @${s.profile.username}`, 540, 1800);
        return new Promise(resolve => canvas.toBlob(b => resolve(new File([b], 'story.jpg', { type: 'image/jpeg' })), 'image/jpeg', 0.9));
    }

    // A feed post → your story: its photos (up to 5) if it has any, otherwise a text card
    async function shareEntry(localId, text, post) {
        try {
            let row = post;
            if (!row || !row.photos) {
                const { data } = await client.from('diary_shared_entries')
                    .select('photos, color, title, body').eq('author', s.profile.id).eq('local_id', localId).maybeSingle();
                row = data;
            }
            if (!row) throw new Error('missing');
            const photos = (row.photos || []).filter(p => p && p.path).slice(0, 5);
            const caption = String(text || row.title || row.body || '').replace(/\s+/g, ' ').trim().slice(0, 140);
            if (photos.length) {
                for (const p of photos) await shareToStory({ bucket: 'diary-feed', path: p.path, type: 'image', caption });
            } else {
                const card = await textCard(text || row.body || row.title, row.color);
                const path = await uploadImage(STORY_BUCKET, `${s.profile.id}/${randomId()}`, card);
                if (!path) throw new Error('upload');
                await shareToStory({ bucket: STORY_BUCKET, path, type: 'image' });
            }
            app.showToast('Added to your story ✨');
        } catch (e) {
            app.showToast('Couldn’t add that to your story');
        }
        await loadStories();
        paintStrip();
    }

    async function uploadVideo(bucket, file, type, onProgress = null) {
        const path = `${s.profile.id}/${randomId()}${VIDEO_TYPES[type]}`;
        const buf = await file.arrayBuffer();
        const { error } = I.uploadWithProgress
            ? await I.uploadWithProgress(bucket, path, buf, type, onProgress)
            : await client.storage.from(bucket).upload(path, buf, { contentType: type, upsert: false });
        if (error) {
            console.warn('Video upload failed', error.message);
            return null;
        }
        return path;
    }

    async function addStory(picked) {
        if (st.busy) return app.showToast('Still posting your last one…');
        const file = picked || (await Media.pickFiles('image/*,video/*', false))[0];
        if (!file) return;
        const type = videoType(file);
        const isVideo = !!type || (file.type || '').startsWith('video/');
        let info = null;
        if (isVideo) {
            if (!type) return app.showToast('That video format isn’t supported — try MP4 or MOV');
            info = await probeVideo(file, false);
            if (info.duration && info.duration > MAX_STORY_VIDEO + 0.5) {
                return app.showToast(`Stories can be up to ${MAX_STORY_VIDEO} seconds — post longer videos as a reel`);
            }
        } else if (!(file.type || '').startsWith('image/') && !/\.(heic|heif)$/i.test(file.name || '')) {
            return app.showToast('Pick a photo or a video');
        }

        const result = await compose({ title: 'New story', file, isVideo, maxCaption: 300, note: 'Friends only · disappears after 24 hours', allowAudio: true });
        if (!result) return;

        st.busy = true;
        paintStrip();
        let audioPath = null;
        try {
            let path;
            let upload = result.file || file;
            if (isVideo) {
                upload = await prepareVideo(file, MAX_STORY_VIDEO);
                if (!upload) throw new Error('too big');
                path = await uploadVideo(STORY_BUCKET, upload, videoType(upload) || type);
            } else {
                path = await uploadImage(STORY_BUCKET, `${s.profile.id}/${randomId()}`, upload);
            }
            if (!path) throw new Error('upload');
            if (result.audio && !result.audio.file) app.showToast('Licensed music can’t go on stories yet — posting the story without it');
            else if (result.audio) {
                audioPath = await I.uploadAudio('stories', result.audio.file);
                if (!audioPath) app.showToast('Couldn’t add the music — posting the story without it');
            }
            const { error } = await client.from('diary_stories').insert({
                media_path: path, media_type: isVideo ? 'video' : 'image', caption: result.caption,
                duration: info && info.duration ? Math.min(60, Math.max(1, Math.round(info.duration * 10) / 10)) : null,
                ...(audioPath ? { audio_path: audioPath, audio_duration: Math.min(600, Math.max(1, result.audio.duration)), audio_name: result.audio.name.slice(0, 120) } : {})
            });
            if (error) {
                client.storage.from(STORY_BUCKET).remove([path]);
                if (audioPath) client.storage.from(I.POST_AUDIO).remove([audioPath]);
                throw error;
            }
            app.showToast('Added to your story ✨');
        } catch (e) {
            app.showToast(e.message === 'too big'
                ? 'That video is too large to upload — try a shorter clip, or record at 1080p'
                : 'Couldn’t post your story — check your connection and try again');
        } finally {
            result.done();
            st.busy = false;
            await loadStories();
            paintStrip();
        }
    }

    // ---------- Story viewer ----------
    const viewer = $('story');
    let view = null; // { groups, gi, ii, timer, deadline, remaining, paused }

    function openStories(author) {
        const list = groups();
        if (!list.length) return;
        let gi = author ? list.findIndex(g => g.author === author) : list.findIndex(g => g.items.some(x => !s.seenStories.has(x.id)));
        if (gi < 0) gi = 0;
        const firstUnseen = list[gi].items.findIndex(x => !s.seenStories.has(x.id));
        view = { groups: list, gi, ii: firstUnseen > 0 ? firstUnseen : 0, timer: null, deadline: 0, remaining: 0, paused: false };
        viewer.showModal();
        show();
    }

    function current() {
        return view && view.groups[view.gi] && view.groups[view.gi].items[view.ii];
    }

    function show() {
        clearTimeout(view.timer);
        viewer.querySelectorAll('.story-audio').forEach(a => a.pause()); // the last story's song stops here
        const group = view.groups[view.gi];
        const item = current();
        s.seenStories.add(item.id);
        try { localStorage.setItem('diarySeenStories', JSON.stringify([...s.seenStories].slice(-400))); } catch (e) {}

        const mine = group.author === s.profile.id;
        const withMusic = item.media_type !== 'video' && !!item.audio_path;
        const seconds = item.media_type === 'video' ? Math.min(item.duration || 15, MAX_STORY_VIDEO)
            : withMusic ? Math.min(STORY_AUDIO_MAX, Math.max(IMAGE_SECONDS, item.audio_duration || IMAGE_SECONDS)) : IMAGE_SECONDS;
        $('story-bars').innerHTML = group.items.map((x, i) =>
            `<span class="${i < view.ii ? 'done' : i === view.ii ? 'active' : ''}"><i style="animation-duration:${seconds}s"></i></span>`).join('');
        $('story-avatar').outerHTML = avatar(group.person, 'sm').replace('<span class="avatar', '<span id="story-avatar" class="avatar');
        $('story-name').textContent = mine ? 'Your story' : group.person.display_name;
        $('story-time').textContent = timeAgo(item.created_at);

        let del = $('story-delete');
        if (!del) {
            del = document.createElement('button');
            del.type = 'button';
            del.id = 'story-delete';
            del.className = 'icon-btn';
            del.setAttribute('aria-label', 'Delete this story');
            del.innerHTML = '<svg class="i"><use href="#i-trash"/></svg>';
            $('story-close').before(del);
            del.addEventListener('click', deleteCurrent);
        }
        del.hidden = !mine;

        const card = $('story-card');
        card.className = 'story-card media';
        card.innerHTML = `
            ${item.media_type === 'video'
                ? `<video class="story-media" data-path="${esc(item.media_path)}" data-bucket="${esc(item.bucket || STORY_BUCKET)}" playsinline autoplay></video>`
                : `<img class="story-media" data-path="${esc(item.media_path)}" data-bucket="${esc(item.bucket || STORY_BUCKET)}" alt="">`}
            ${item.caption ? `<p class="story-caption">${esc(item.caption)}</p>` : ''}
            ${withMusic ? `
                <div class="story-music" aria-label="Music: ${esc(item.audio_name || 'Audio')}">
                    <span class="sm-bars" aria-hidden="true"><i></i><i></i><i></i><i></i></span>
                    <span class="sm-name">${esc(item.audio_name || 'Audio')}</span>
                    <audio class="story-audio" data-path="${esc(item.audio_path)}" data-bucket="${I.POST_AUDIO}" preload="auto"></audio>
                </div>` : ''}
            ${mine ? `<button type="button" class="story-seen" id="story-seen" data-id="${esc(item.id)}"><svg class="i"><use href="#i-eye"/></svg><span>Seen by …</span></button>` : ''}`;
        if (mine) paintSeen(item.id);
        else recordView(item.id);
        paintReactBar(item, mine);
        const media = card.querySelector('.story-media');
        hydrateStorage(card).then(() => {
            if (item.media_type === 'video' && current() === item) {
                media.play().catch(() => {
                    media.muted = true;
                    media.play().catch(() => {});
                });
            }
            const music = card.querySelector('.story-audio');
            if (music && current() === item && !view.paused) {
                music.play().catch(() => card.querySelector('.story-music').classList.add('blocked'));
            }
        });
        if (item.media_type === 'video') {
            media.addEventListener('ended', () => step(1));
            media.addEventListener('waiting', () => card.classList.add('buffering'));
            media.addEventListener('playing', () => card.classList.remove('buffering'));
        }
        view.paused = false;
        viewer.classList.remove('paused');
        $('story-viewers').hidden = true;
        // Videos end on 'ended' (or after a minute for a shared reel); the timer is the backstop
        run(seconds * 1000 + (item.media_type === 'video' && (item.duration || 0) <= MAX_STORY_VIDEO ? 1500 : 0));
    }

    // ---------- Who viewed your story ----------
    const viewed = new Set(); // views already recorded this session
    function recordView(id) {
        if (viewed.has(id)) return;
        viewed.add(id);
        client.from('diary_story_views')
            .upsert({ story_id: id }, { onConflict: 'story_id,viewer', ignoreDuplicates: true })
            .then(() => {});
    }

    async function loadViews(id) {
        const { data } = await client.from('diary_story_views')
            .select(`viewer, viewed_at, profile:diary_profiles!diary_story_views_viewer_fkey(id, ${PROFILE})`)
            .eq('story_id', id)
            .order('viewed_at', { ascending: false });
        return data || [];
    }

    // ---------- Story reactions ----------
    // Friends tap an emoji along the bottom (Instagram style); it floats up and lands with you. You see who
    // reacted with what in "Seen by". Tap a lit emoji again to take it back.
    const REACTS = I.POST_REACTIONS || ['❤️', '😂', '😮', '😢', '🔥', '👏', '🙏', '😍'];
    const myStoryReacts = new Map(); // story id -> Set of emojis you sent

    async function loadReactions(id, mineOnly) {
        let q = client.from('diary_story_reactions').select('user_id, emoji, created_at').eq('story_id', id);
        if (mineOnly) q = q.eq('user_id', s.profile.id);
        const { data } = await q;
        return data || [];
    }

    async function paintReactBar(item, mine) {
        const bar = $('story-react');
        bar.hidden = mine;
        if (mine) return;
        const draw = () => {
            const sent = myStoryReacts.get(item.id) || new Set();
            bar.innerHTML = REACTS.map((e, i) => `<button type="button" data-story-react="${e}" style="--i:${i}" class="${sent.has(e) ? 'on' : ''}" aria-pressed="${sent.has(e)}" aria-label="React ${e}">${e}</button>`).join('');
        };
        draw();
        if (!myStoryReacts.has(item.id)) {
            const rows = await loadReactions(item.id, true);
            myStoryReacts.set(item.id, new Set(rows.map(r => r.emoji)));
            if (current() === item) draw();
        }
    }

    async function reactToStory(emoji, btn) {
        const item = current();
        if (!item || !REACTS.includes(emoji)) return;
        const sent = myStoryReacts.get(item.id) || new Set();
        myStoryReacts.set(item.id, sent);
        const had = sent.has(emoji);
        if (had) sent.delete(emoji); else sent.add(emoji);
        btn.classList.toggle('on', !had);
        btn.setAttribute('aria-pressed', String(!had));
        if (!had) {
            floatEmoji(emoji, btn);
            if (navigator.vibrate) navigator.vibrate(10);
        }
        const { error } = had
            ? await client.from('diary_story_reactions').delete().eq('story_id', item.id).eq('user_id', s.profile.id).eq('emoji', emoji)
            : await client.from('diary_story_reactions').upsert({ story_id: item.id, emoji }, { onConflict: 'story_id,user_id,emoji', ignoreDuplicates: true });
        if (error) {
            if (had) sent.add(emoji); else sent.delete(emoji);
            btn.classList.toggle('on', had);
            btn.setAttribute('aria-pressed', String(had));
            return app.showToast('Couldn’t send that reaction');
        }
        const group = view && view.groups[view.gi];
        if (!had) app.showToast(`Sent ${emoji} to ${group ? group.person.display_name.split(' ')[0] : 'your friend'}`);
    }

    // A little burst: the emoji rises from the button and fades
    function floatEmoji(emoji, from) {
        if (document.documentElement.dataset.motion === 'reduce' || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
        const r = from.getBoundingClientRect();
        for (let k = 0; k < 5; k++) {
            const el = document.createElement('span');
            el.className = 'story-float';
            el.textContent = emoji;
            el.style.left = `${r.left + r.width / 2}px`;
            el.style.top = `${r.top}px`;
            el.style.setProperty('--dx', `${(Math.random() - 0.5) * 90}px`);
            el.style.setProperty('--delay', `${k * 70}ms`);
            el.style.setProperty('--s', (0.9 + Math.random() * 0.6).toFixed(2));
            viewer.append(el);
            setTimeout(() => el.remove(), 1400 + k * 70);
        }
    }

    $('story-react').addEventListener('click', e => {
        const b = e.target.closest('[data-story-react]');
        if (!b) return;
        e.stopPropagation();
        reactToStory(b.dataset.storyReact, b);
    });

    async function paintSeen(id) {
        const [views, reacts] = await Promise.all([loadViews(id), loadReactions(id)]);
        const btn = $('story-seen');
        if (!btn || btn.dataset.id !== id) return;
        const faces = [...new Set(reacts.map(r => r.emoji))].slice(0, 3).join('');
        btn.querySelector('span').textContent = views.length
            ? `Seen by ${views.length}${reacts.length ? ` · ${faces} ${reacts.length}` : ''}`
            : 'No views yet';
    }

    async function openSeen(id) {
        pause();
        const panel = $('story-viewers');
        panel.hidden = false;
        panel.innerHTML = '<p class="muted small">Loading…</p>';
        const [views, reacts] = await Promise.all([loadViews(id), loadReactions(id)]);
        const byUser = new Map();
        reacts.forEach(r => byUser.set(r.user_id, (byUser.get(r.user_id) || '') + r.emoji));
        // People who reacted come first
        views.sort((a, b) => (byUser.has(b.viewer) ? 1 : 0) - (byUser.has(a.viewer) ? 1 : 0));
        panel.innerHTML = `
            <header><strong>${views.length ? `Seen by ${views.length}` : 'No one has seen this yet'}${reacts.length ? ` · ${reacts.length} ${reacts.length === 1 ? 'reaction' : 'reactions'}` : ''}</strong>
                <button type="button" class="icon-btn" data-sv="close" aria-label="Close"><svg class="i"><use href="#i-close"/></svg></button></header>
            <div class="sv-list">
                ${views.map(v => {
                    const p = v.profile || { id: v.viewer, display_name: 'Someone', username: '' };
                    const em = byUser.get(v.viewer);
                    return `<div class="sv-row">${avatar(p, 'md')}<span><strong>${esc(p.display_name)}</strong><small>${timeAgo(v.viewed_at)}</small></span>${em ? `<span class="sv-reacts" aria-label="Reacted ${esc(em)}">${esc(em)}</span>` : ''}</div>`;
                }).join('') || '<p class="sv-empty">When friends watch your story, they’ll show up here.</p>'}
            </div>`;
    }

    function closeSeen() {
        const panel = $('story-viewers');
        if (panel.hidden) return;
        panel.hidden = true;
        resume();
    }

    function run(ms) {
        clearTimeout(view.timer);
        view.deadline = Date.now() + ms;
        view.timer = setTimeout(() => step(1), ms);
    }

    function pause() {
        if (!view || view.paused) return;
        view.paused = true;
        view.remaining = Math.max(300, view.deadline - Date.now());
        clearTimeout(view.timer);
        viewer.classList.add('paused');
        const video = viewer.querySelector('video.story-media');
        if (video) video.pause();
        const music = viewer.querySelector('.story-audio');
        if (music) music.pause();
    }

    function resume() {
        if (!view || !view.paused) return;
        view.paused = false;
        viewer.classList.remove('paused');
        const video = viewer.querySelector('video.story-media');
        if (video) video.play().catch(() => {});
        const music = viewer.querySelector('.story-audio');
        if (music) music.play().catch(() => {});
        run(view.remaining);
    }

    function step(dir) {
        if (!view) return;
        const group = view.groups[view.gi];
        view.ii += dir;
        if (view.ii >= group.items.length) {
            view.gi++;
            view.ii = 0;
        } else if (view.ii < 0) {
            view.gi = Math.max(0, view.gi - 1);
            view.ii = 0;
        }
        if (view.gi >= view.groups.length) return viewer.close();
        show();
    }

    async function deleteCurrent() {
        const item = current();
        if (!item) return;
        pause();
        const ok = await app.ask({ title: 'Delete this story?', text: 'It disappears for everyone right away.', ok: 'Delete', danger: true });
        if (!ok) return resume();
        const { error } = await client.from('diary_stories').delete().eq('id', item.id);
        if (error) {
            app.showToast('Couldn’t delete that story');
            return resume();
        }
        // Only files made for the story are deleted — a shared post or reel keeps its media
        if ((item.bucket || STORY_BUCKET) === STORY_BUCKET) client.storage.from(STORY_BUCKET).remove([item.media_path]);
        if (item.audio_path) client.storage.from(I.POST_AUDIO).remove([item.audio_path]);
        st.stories = (st.stories || []).filter(x => x.id !== item.id);
        const group = view.groups[view.gi];
        group.items = group.items.filter(x => x.id !== item.id);
        app.showToast('Story deleted');
        if (!group.items.length) {
            view.groups.splice(view.gi, 1);
            view.ii = 0;
            if (view.gi >= view.groups.length) return viewer.close();
        } else if (view.ii >= group.items.length) {
            view.ii = group.items.length - 1;
        }
        show();
    }

    $('story-next').addEventListener('click', () => step(1));
    $('story-prev').addEventListener('click', () => step(-1));
    $('story-close').addEventListener('click', () => viewer.close());
    // Press and hold to pause, like Instagram
    let holdTimer = null;
    let held = false;
    viewer.addEventListener('click', e => {
        const seen = e.target.closest('#story-seen');
        if (seen) {
            e.stopPropagation();
            openSeen(seen.dataset.id);
            return;
        }
        if (e.target.closest('[data-sv="close"]')) closeSeen();
    });
    viewer.addEventListener('pointerdown', e => {
        if (e.target.closest('.story-head, #story-seen, .story-viewers, .story-react')) return;
        held = false;
        holdTimer = setTimeout(() => { held = true; pause(); }, 220);
    });
    viewer.addEventListener('pointerup', () => {
        clearTimeout(holdTimer);
        if (held) resume();
    });
    viewer.addEventListener('pointercancel', () => { clearTimeout(holdTimer); if (held) resume(); });
    viewer.addEventListener('click', e => {
        if (held && e.target.closest('.story-nav')) {
            e.stopPropagation();
            held = false;
        }
    }, true);
    viewer.addEventListener('close', () => {
        if (view) clearTimeout(view.timer);
        const video = viewer.querySelector('video');
        if (video) video.pause();
        viewer.querySelectorAll('audio').forEach(a => a.pause());
        $('story-card').innerHTML = '';
        view = null;
        paintStrip();
    });
    viewer.addEventListener('keydown', e => {
        if (e.key === 'ArrowRight') step(1);
        if (e.key === 'ArrowLeft') step(-1);
        if (e.key === ' ') {
            e.preventDefault();
            view && view.paused ? resume() : pause();
        }
    });
    document.addEventListener('visibilitychange', () => { if (document.hidden) pause(); });

    // ---------- Reels ----------
    async function loadReels() {
        if (st.reelsLoading) { st.reelsAgain = true; return; }
        st.reelsLoading = true;
        st.reelsAgain = false;
        const { data, error } = await client.from('diary_reels')
            .select(`id, author, video_path, poster_path, caption, duration, created_at, music,
                author_profile:diary_profiles!diary_reels_author_fkey(${PROFILE}),
                likes:diary_reel_likes(user_id),
                reshares:diary_reel_reshares(user_id, created_at),
                comments:diary_comments(count)`)
            .order('created_at', { ascending: false })
            .limit(50);
        st.reelsLoading = false;
        if (st.reelsAgain) { st.reelsAgain = false; return loadReels(); }
        st.reels = error ? [] : data;
        st.reelsError = !!error;
        app.requestRender(['reels', 'feed', 'explore']);
    }

    // ---------- Reels in the feed ----------
    function feedReels({ author = null, mine = false, saved = false, skip = false } = {}) {
        if (st.reels === null) {
            loadReels();
            return [];
        }
        if (skip) return [];
        return st.reels.filter(r =>
            (!author || r.author === author) && (!mine || r.author === s.profile.id) && (!saved || s.savedReels.has(r.id)));
    }

    // The sound record a reel keeps (the music itself is mixed into the video)
    function soundMeta(m) {
        if (!m) return null;
        const r = I.soundRecord ? I.soundRecord(m) : m;
        const keep = ['audioId', 'id', 'title', 'artist', 'cover', 'coverArt', 'audioUrl', 'src', 'genre', 'category', 'source', 'style', 'start', 'length',
            'startTime', 'endTime', 'duration', 'trackDuration', 'volume', 'licenseUrl', 'licenseName', 'shareurl', 'provider', 'createdAt'];
        const out = {};
        keep.forEach(k => { if (r[k] != null && r[k] !== '') out[k] = r[k]; });
        return JSON.stringify(out).length <= 2000 ? out : null;
    }
    const reelSound = r => (r.music && I.soundOf ? I.soundOf({ music: r.music, path: null }) : null);

    function feedCard(r) {
        const me = s.profile.id;
        const p = r.author_profile || { display_name: 'Someone', username: '' };
        const person = { id: r.author, ...p };
        const liked = r.likes.some(l => l.user_id === me);
        const saved = s.savedReels.has(r.id);
        const reshares = r.reshares || [];
        const reshared = reshares.some(x => x.user_id === me);
        const via = r.author === me || (s.friends || []).some(f => f.id === r.author) ? null
            : reshares.map(x => (s.friends || []).find(f => f.id === x.user_id)).find(Boolean);
        return `
            <article class="post ig reel-post" data-reel="${esc(r.id)}" data-search="${esc(`${p.display_name} ${p.username} ${r.caption || ''}`.toLowerCase())}">
                ${reshared || via ? `<p class="repost-line"><svg class="i"><use href="#i-repost"/></svg>${reshared ? 'You reshared this' : `${esc(String(via.display_name || '').split(' ')[0])} reshared this`}</p>` : ''}
                <header class="post-head">
                    ${avatar(person, 'md')}
                    <div class="post-who">
                        <strong>${r.author === me ? 'You' : esc(p.display_name)} <span class="post-badge reel-badge"><svg class="i"><use href="#i-reel"/></svg>Reel</span></strong>
                        <span class="muted post-sub">${reelSound(r) ? I.soundLineHTML(reelSound(r)) : `@${esc(p.username)}`}</span>
                    </div>
                </header>
                <div class="reel-post-media">
                    ${r.poster_path ? `<img class="reel-poster" data-path="${esc(r.poster_path)}" data-bucket="${REEL_BUCKET}" alt="">` : ''}
                    <video class="feed-reel-video" data-path="${esc(r.video_path)}" data-bucket="${REEL_BUCKET}" playsinline muted loop preload="metadata"></video>
                    <button type="button" class="reel-post-open" data-action="reel-open" data-id="${esc(r.id)}" aria-label="Watch in Reels"></button>
                    <span class="reel-spinner" aria-hidden="true"></span>
                    <p class="reel-failed">This video can’t play in this browser.</p>
                    <button type="button" class="reel-post-mute" data-action="reel-mute" aria-label="${st.muted ? 'Turn sound on' : 'Mute'}"><svg class="i"><use href="#${st.muted ? 'i-volume-off' : 'i-volume'}"/></svg></button>
                </div>
                <div class="post-actions">
                    <button class="act like-btn" data-action="reel-like" data-id="${esc(r.id)}" aria-pressed="${liked}" aria-label="${liked ? 'Unlike' : 'Like'}">
                        <svg class="i"><use href="#${liked ? 'i-heart-fill' : 'i-heart'}"/></svg><span class="act-count" data-count="likes">${r.likes.length || ''}</span>
                    </button>
                    <button class="act" data-action="reel-comments" data-id="${esc(r.id)}" aria-label="Comments"><svg class="i"><use href="#i-chat"/></svg><span class="act-count" data-count="comments">${count(r) || ''}</span></button>
                    <button class="act reshare-btn" data-action="reel-reshare" data-id="${esc(r.id)}" aria-pressed="${reshared}" aria-label="${reshared ? 'Undo reshare' : 'Reshare to your friends'}" title="Reshare"><svg class="i"><use href="#i-repost"/></svg><span class="act-count">${reshares.length ? compact(reshares.length) : ''}</span></button>
                    <button class="act story-btn" data-action="reel-story" data-id="${esc(r.id)}" aria-label="Add to your story" title="Add to your story"><svg class="i"><use href="#i-story-add"/></svg></button>
                    <button class="act save-btn" data-action="reel-save" data-id="${esc(r.id)}" aria-pressed="${saved}" aria-label="${saved ? 'Remove from Saved' : 'Save reel'}">
                        <svg class="i"><use href="#${saved ? 'i-bookmark-fill' : 'i-bookmark'}"/></svg><span class="sr-only">${saved ? 'Saved' : 'Save'}</span>
                    </button>
                </div>
                ${r.caption ? `<div class="post-caption"><strong class="cap-name">${r.author === me ? 'You' : esc(p.display_name)}</strong> <span class="post-text">${I.linkTags(esc(r.caption))}</span></div>` : ''}
                <p class="post-when"><span class="post-time">${timeAgo(r.created_at)}</span></p>
            </article>`;
    }

    // Feed reels play muted while mostly on screen, like Instagram
    let feedObserver = null;
    function watchFeedReels() {
        if (feedObserver) feedObserver.disconnect();
        const cards = [...content.querySelectorAll('.reel-post')];
        if (!cards.length) return;
        const ready = hydrateStorage(content);
        feedObserver = new IntersectionObserver(entries => {
            entries.forEach(entry => {
                const video = entry.target.querySelector('.feed-reel-video');
                const visible = entry.isIntersecting && entry.intersectionRatio > 0.6;
                entry.target.dataset.visible = visible ? '1' : '';
                if (!visible) return video.pause();
                ready.then(() => {
                    if (!entry.target.dataset.visible || !video.src || entry.target.classList.contains('failed')) return;
                    video.muted = st.muted;
                    video.play().catch(err => {
                        if (err && err.name === 'AbortError') return;
                        video.muted = true;
                        video.play().catch(() => {});
                    });
                });
            });
        }, { threshold: [0, 0.6, 1] });
        cards.forEach(card => {
            const video = card.querySelector('.feed-reel-video');
            if (!video.dataset.watched) {
                video.dataset.watched = '1';
                video.defaultMuted = true;
                video.addEventListener('waiting', () => card.classList.add('buffering'));
                video.addEventListener('playing', () => card.classList.remove('buffering'));
                video.addEventListener('playing', () => card.classList.add('started'));
                video.addEventListener('error', () => { if (video.getAttribute('src')) card.classList.add('failed'); });
            }
            feedObserver.observe(card);
        });
    }

    const count = r => (Array.isArray(r.comments) && r.comments[0] ? r.comments[0].count : 0);
    const compact = n => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : String(n));

    app.views.reels = () => {
        app.setTitle('Reels');
        const blocked = gate('Watch and share short videos with your friends.');
        if (blocked) return blocked;
        if (st.reels === null) {
            loadReels();
            return '<p class="muted">Loading reels…</p>';
        }
        const list = app.state.reelFilter === 'saved' ? st.reels.filter(r => s.savedReels.has(r.id)) : st.reels;
        return `
            <div class="reels-page">
                <header class="reels-head">
                    <button class="icon-btn ghost" data-action="reels-back" aria-label="Back to the feed"><svg class="i"><use href="#i-back"/></svg></button>
                    <div class="feed-sort" role="group" aria-label="Which reels">
                        <button data-action="reels-filter" data-filter="all" aria-pressed="${app.state.reelFilter !== 'saved'}">For you</button>
                        <button data-action="reels-filter" data-filter="saved" aria-pressed="${app.state.reelFilter === 'saved'}">Saved</button>
                    </div>
                    <button class="create-post" data-action="reel-add"><svg class="i"><use href="#i-plus"/></svg><span>${st.busy ? 'Posting…' : 'New reel'}</span></button>
                </header>
                <div class="reels" id="reels">
                    ${list.map(reelCard).join('') || `
                        <div class="reel empty-reel">
                            <div class="empty">
                                <p class="empty-title">${app.state.reelFilter === 'saved' ? 'No saved reels yet' : st.reelsError ? 'Couldn’t load reels' : 'No reels yet'}</p>
                                <p>${app.state.reelFilter === 'saved' ? 'Tap the bookmark on a reel to keep it here.' : 'Post a short video — up to 3 minutes — for your friends to watch.'}</p>
                                ${app.state.reelFilter === 'saved' ? '' : '<button class="primary-btn" style="margin-top:16px" data-action="reel-add">Post your first reel</button>'}
                            </div>
                        </div>`}
                </div>
            </div>`;
    };

    function reelCard(r) {
        const me = s.profile.id;
        const p = r.author_profile || { display_name: 'Someone', username: '' };
        const person = { id: r.author, ...p };
        const liked = r.likes.some(l => l.user_id === me);
        const saved = s.savedReels.has(r.id);
        const long = (r.caption || '').length > 90;
        const reshares = r.reshares || [];
        const reshared = reshares.some(x => x.user_id === me);
        // Seeing it because a friend reshared it: say who
        const via = r.author === me || (s.friends || []).some(f => f.id === r.author) ? null
            : reshares.map(x => (s.friends || []).find(f => f.id === x.user_id)).find(Boolean);
        return `
            <article class="reel" data-reel="${esc(r.id)}">
                ${r.poster_path ? `<img class="reel-poster" data-path="${esc(r.poster_path)}" data-bucket="${REEL_BUCKET}" alt="">` : ''}
                <video class="reel-video" data-path="${esc(r.video_path)}" data-bucket="${REEL_BUCKET}" playsinline loop preload="metadata"${st.muted ? ' muted' : ''}></video>
                <button class="reel-tap" data-action="reel-toggle" aria-label="Play or pause"></button>
                <span class="reel-state" aria-hidden="true"><svg class="i"><use href="#i-play"/></svg></span>
                <span class="reel-spinner" aria-hidden="true"></span>
                <p class="reel-failed">This video can’t play in this browser — it was recorded in a format only some devices support.</p>
                <span class="burst" aria-hidden="true"><svg class="i"><use href="#i-heart-fill"/></svg></span>
                <div class="reel-info">
                    ${reshared || via ? `<p class="reel-via"><svg class="i"><use href="#i-repost"/></svg>${reshared ? 'You reshared this' : `Reshared by ${esc(String(via.display_name || '').split(' ')[0])}`}</p>` : ''}
                    <div class="reel-who">${avatar(person, 'sm')}<strong>${r.author === me ? 'You' : esc(p.display_name)}</strong><span>· ${timeAgo(r.created_at)}</span></div>
                    ${r.caption ? `<p class="reel-caption${long ? ' clamped' : ''}"${long ? ' data-action="reel-caption"' : ''}>${I.linkTags(esc(r.caption))}</p>` : ''}
                    ${reelSound(r) ? `<p class="reel-sound">${I.soundLineHTML(reelSound(r))}</p>` : ''}
                </div>
                <div class="reel-side">
                    <button class="reel-act" data-action="reel-like" data-id="${esc(r.id)}" aria-pressed="${liked}" aria-label="${liked ? 'Unlike' : 'Like'}">
                        <svg class="i"><use href="#${liked ? 'i-heart-fill' : 'i-heart'}"/></svg><span data-count="likes">${compact(r.likes.length)}</span>
                    </button>
                    <button class="reel-act" data-action="reel-comments" data-id="${esc(r.id)}" aria-label="Comments">
                        <svg class="i"><use href="#i-chat"/></svg><span data-count="comments">${compact(count(r))}</span>
                    </button>
                    ${`<button class="reel-act" data-action="reel-reshare" data-id="${esc(r.id)}" aria-pressed="${reshared}" aria-label="${reshared ? 'Undo reshare' : 'Reshare to your friends'}"><svg class="i"><use href="#i-repost"/></svg><span>${reshares.length ? compact(reshares.length) : 'Reshare'}</span></button>`}
                    <button class="reel-act" data-action="reel-save" data-id="${esc(r.id)}" aria-pressed="${saved}" aria-label="${saved ? 'Remove from Saved' : 'Save reel'}">
                        <svg class="i"><use href="#${saved ? 'i-bookmark-fill' : 'i-bookmark'}"/></svg><span>${saved ? 'Saved' : 'Save'}</span>
                    </button>
                    <button class="reel-act" data-action="reel-mute" aria-label="${st.muted ? 'Turn sound on' : 'Mute'}">
                        <svg class="i"><use href="#${st.muted ? 'i-volume-off' : 'i-volume'}"/></svg>
                    </button>
                    ${r.author === me && /\.mov$/i.test(r.video_path) ? `<button class="reel-act" data-action="reel-convert" data-id="${esc(r.id)}" aria-label="Convert so every device can play it"><svg class="i"><use href="#i-refresh"/></svg><span>Fix</span></button>` : ''}
                    <button class="reel-act" data-action="reel-story" data-id="${esc(r.id)}" aria-label="Add to your story"><svg class="i"><use href="#i-plus"/></svg><span>Story</span></button>
                    ${r.author === me ? `<button class="reel-act" data-action="reel-delete" data-id="${esc(r.id)}" aria-label="Delete reel"><svg class="i"><use href="#i-trash"/></svg></button>` : ''}
                </div>
                <div class="reel-progress"><i></i></div>
            </article>`;
    }

    // Play whichever reel is on screen; pause the rest
    let observer = null;
    function watchReels() {
        if (observer) observer.disconnect();
        const box = $('reels');
        if (!box) return;
        const ready = hydrateStorage(box);
        box.querySelectorAll('.reel-video').forEach(watchVideo);
        if (st.scrollTop && !app.state.reelId) box.scrollTop = st.scrollTop;
        box.addEventListener('scroll', () => { st.scrollTop = box.scrollTop; }, { passive: true });
        observer = new IntersectionObserver(entries => {
            entries.forEach(entry => {
                const video = entry.target.querySelector('.reel-video');
                if (!video) return;
                entry.target.dataset.visible = entry.isIntersecting && entry.intersectionRatio > 0.6 ? '1' : '';
                if (entry.target.dataset.visible) {
                    ready.then(() => { if (entry.target.dataset.visible) playReel(entry.target); });
                } else {
                    video.pause();
                }
            });
        }, { root: box, threshold: [0, 0.6, 1] });
        box.querySelectorAll('.reel[data-reel]').forEach(el => observer.observe(el));
        if (app.state.reelId) {
            const target = box.querySelector(`[data-reel="${CSS.escape(app.state.reelId)}"]`);
            app.state.reelId = null;
            if (target) target.scrollIntoView({ block: 'start' });
        }
    }

    // Autoplay is only allowed muted, so every reel starts muted; sound comes on once you tap the speaker
    function playReel(el) {
        const video = el.querySelector('.reel-video');
        if (!video || !video.src || el.classList.contains('failed')) return;
        video.muted = st.muted;
        const attempt = video.play();
        if (!attempt || !attempt.then) return;
        attempt.then(() => el.classList.remove('paused')).catch(err => {
            if (err && err.name === 'AbortError') return; // a newer play() or load took over
            if (!video.muted) {
                video.muted = true;
                video.play().then(() => el.classList.remove('paused')).catch(() => el.classList.add('paused'));
            } else {
                el.classList.add('paused'); // tap to play
            }
        });
    }

    // Loading spinner, and a clear message if this browser can't decode the file
    function watchVideo(video) {
        if (video.dataset.watched) return;
        video.dataset.watched = '1';
        video.muted = true;
        video.defaultMuted = true;
        video.setAttribute('muted', '');
        const reel = video.closest('.reel');
        video.addEventListener('waiting', () => reel.classList.add('buffering'));
        video.addEventListener('playing', () => reel.classList.remove('buffering', 'paused'));
        video.addEventListener('canplay', () => reel.classList.remove('buffering'));
        video.addEventListener('error', () => {
            if (!video.getAttribute('src')) return;
            reel.classList.remove('buffering');
            reel.classList.add('failed');
        });
    }

    // Progress bar + hide the poster once frames are showing
    content.addEventListener('timeupdate', e => {
        const video = e.target;
        if (!video.classList || !video.classList.contains('reel-video')) return;
        const reel = video.closest('.reel');
        const bar = reel && reel.querySelector('.reel-progress i');
        if (bar && video.duration) bar.style.width = `${(video.currentTime / video.duration) * 100}%`;
    }, true);
    content.addEventListener('playing', e => {
        if (e.target.classList && e.target.classList.contains('reel-video') && e.target.closest('.reel')) e.target.closest('.reel').classList.add('started');
    }, true);

    // Double-tap a reel to like it
    content.addEventListener('dblclick', e => {
        const tap = e.target.closest('.reel-tap');
        if (!tap) return;
        const reel = tap.closest('.reel');
        const burst = reel.querySelector('.burst');
        burst.classList.remove('pop');
        void burst.offsetWidth;
        burst.classList.add('pop');
        const btn = reel.querySelector('[data-action="reel-like"]');
        if (btn && btn.getAttribute('aria-pressed') !== 'true') btn.click();
    });

    function paintCounts(id) {
        const r = (st.reels || []).find(x => x.id === id);
        const el = content.querySelector(`[data-reel="${CSS.escape(id)}"]`);
        if (!r || !el) return;
        el.querySelector('[data-count="likes"]').textContent = compact(r.likes.length);
        el.querySelector('[data-count="comments"]').textContent = compact(count(r));
    }

    async function toggleReelLike(id, btn) {
        const r = (st.reels || []).find(x => x.id === id);
        if (!r) return;
        const me = s.profile.id;
        const liked = r.likes.some(l => l.user_id === me);
        r.likes = liked ? r.likes.filter(l => l.user_id !== me) : [...r.likes, { user_id: me }];
        const paint = on => {
            btn.setAttribute('aria-pressed', String(on));
            btn.querySelector('use').setAttribute('href', on ? '#i-heart-fill' : '#i-heart');
            paintCounts(id);
        };
        paint(!liked);
        const { error } = liked
            ? await client.from('diary_reel_likes').delete().eq('reel_id', id).eq('user_id', me)
            : await client.from('diary_reel_likes').insert({ reel_id: id });
        if (error) {
            r.likes = liked ? [...r.likes, { user_id: me }] : r.likes.filter(l => l.user_id !== me);
            paint(liked);
            app.showToast('Couldn’t update like');
        }
    }

    async function addReel(picked, opts = {}) {
        if (st.busy) return app.showToast('Still posting your last one…');
        const file = picked || (await Media.pickFiles('video/*', false))[0];
        if (!file) return;
        const type = videoType(file);
        if (!type) return app.showToast('That video format isn’t supported — try MP4 or MOV');
        const info = await probeVideo(file, true);
        if (info.duration && info.duration > MAX_REEL + 0.5) return app.showToast('Reels can be up to 3 minutes');

        const result = await compose({
            title: 'New reel', file, isVideo: true, maxCaption: 2200, note: 'Friends only',
            offerStory: true, storyDefault: !!opts.alsoStory, allowAudio: true, videoAudio: true
        });
        if (!result) return;
        result.done(); // the sheet closes; the posting strip on the Feed takes over

        st.busy = true;
        const thumb = info.poster ? URL.createObjectURL(info.poster) : null;
        const strip = I.startProgress ? I.startProgress({ thumb, kind: 'video', label: result.audio ? 'Adding your music…' : 'Preparing your reel…' }) : null;
        const prog = (f, label) => { if (strip) strip.update(f, label); };
        const duration = info.duration ? Math.max(1, Math.round(info.duration * 10) / 10) : null;
        let upload = null, videoPath = null, posterPath = null, saved = false;

        const run = async () => {
            try {
                if (!upload) {
                    if (result.audio) {
                        upload = await shrinkVideo(file, { maxSeconds: MAX_REEL, music: result.audio, onProgress: f => prog(0.03 + 0.37 * f, `Adding your music… ${Math.round(f * 100)}%`) });
                        if (!upload) throw new Error('music');
                    } else {
                        upload = await prepareVideo(file, MAX_REEL, (f, what) => prog(0.03 + 0.37 * f, `${what}… ${Math.round(f * 100)}%`));
                    }
                    if (!upload || upload.size > MAX_BYTES) { upload = null; throw new Error('too big'); }
                }
                if (!videoPath) {
                    prog(0.4, 'Uploading your reel…');
                    videoPath = await uploadVideo(REEL_BUCKET, upload, videoType(upload) || type, f => prog(0.4 + 0.52 * f, `Uploading your reel… ${Math.round(f * 100)}%`));
                    if (!videoPath) throw new Error('upload');
                }
                if (info.poster && !posterPath) {
                    const path = `${s.profile.id}/${randomId()}.jpg`;
                    const { error } = await client.storage.from(REEL_BUCKET).upload(path, await info.poster.arrayBuffer(), { contentType: 'image/jpeg', upsert: false });
                    if (!error) posterPath = path;
                }
                if (!saved) {
                    prog(0.95, 'Publishing…');
                    const music = soundMeta(result.audio && result.audio.music);
                    const { error } = await client.from('diary_reels').insert({ video_path: videoPath, poster_path: posterPath, caption: result.caption, duration, ...(music ? { music } : {}) });
                    if (error) throw error;
                    saved = true;
                    // It's saved. Read it back (a failure here is harmless: the reload below fetches it anyway)
                    const { data: made } = await client.from('diary_reels').select('id, author, video_path, poster_path, caption, duration, created_at, music')
                        .eq('video_path', videoPath).maybeSingle().then(r => r, () => ({ data: null }));
                    if (made) {
                        const mine = { ...made, author_profile: { username: s.profile.username, display_name: s.profile.display_name, avatar_path: s.profile.avatar_path }, likes: [], reshares: [], comments: [{ count: 0 }] };
                        st.reels = [mine, ...(st.reels || []).filter(r => r.id !== mine.id)];
                        app.requestRender(['reels', 'feed', 'explore', 'profile']);
                    }
                    if (result.alsoStory) {
                        await shareToStory({ bucket: REEL_BUCKET, path: videoPath, type: 'video', caption: result.caption, duration }).catch(() => {});
                        loadStories();
                    }
                }
                app.state.reelFilter = 'all';
                st.busy = false;
                if (strip) strip.done(result.alsoStory ? 'Reel posted — and on your story' : 'Reel posted');
                else app.showToast('Your reel is live 🎬');
                if (app.state.view === 'reels') app.render();
                loadReels();
            } catch (e) {
                st.busy = false;
                const message = e.message === 'too big' ? 'That video is too large to upload — try a shorter clip'
                    : e.message === 'music' ? 'Couldn’t add the music on this device — try again, or post without it'
                    : 'Couldn’t post your reel — check your connection';
                if (!strip) return app.showToast(message);
                strip.fail(message, () => {
                    if (st.busy) return;
                    st.busy = true;
                    if (s.upload) { s.upload.state = 'active'; s.upload.label = 'Trying again…'; }
                    strip.update(0.03);
                    run();
                }, () => {
                    // Discard: tidy away anything uploaded for a reel that never got saved
                    if (!saved) {
                        const leftovers = [videoPath, posterPath].filter(Boolean);
                        if (leftovers.length) client.storage.from(REEL_BUCKET).remove(leftovers);
                    }
                    strip.remove();
                });
            }
        };
        if (app.state.view === 'reels') app.render();
        run();
    }

    // Older iPhone reels (.mov, often HEVC) don't play on many Android and Windows browsers.
    // The author's own device can decode them, so it re-records the reel as MP4 and swaps the file.
    async function convertReel(id, btn) {
        const r = (st.reels || []).find(x => x.id === id);
        if (!r || st.busy) return;
        const label = btn && btn.querySelector('span');
        st.busy = true;
        try {
            if (label) label.textContent = 'Loading';
            let url = (s.urls.get(`${REEL_BUCKET}:${r.video_path}`) || {}).url;
            if (!url) {
                const { data } = await client.storage.from(REEL_BUCKET).createSignedUrl(r.video_path, 900);
                url = data && data.signedUrl;
            }
            if (!url) throw new Error('download');
            const blob = await (await fetch(url)).blob();
            const original = new File([blob], 'reel.mov', { type: 'video/quicktime' });
            if (label) label.textContent = 'Fix';
            // Ask after downloading, so the tap that confirms also lets the sound be recorded
            const ok = await app.ask({
                title: 'Make this reel play on every device?',
                text: 'Cordial converts it to MP4 right here. It takes about as long as the video — keep Cordial open until it’s done.',
                ok: 'Convert'
            });
            if (!ok) return;
            const out = await shrinkVideo(original, {
                maxSeconds: MAX_REEL,
                onProgress: p => { if (label) label.textContent = `${Math.round(p * 100)}%`; }
            });
            if (!out || out.size > MAX_BYTES) throw new Error('convert');
            if (label) label.textContent = 'Saving';
            const path = await uploadVideo(REEL_BUCKET, out, videoType(out));
            if (!path) throw new Error('upload');
            const { error } = await client.from('diary_reels').update({ video_path: path }).eq('id', id);
            if (error) {
                client.storage.from(REEL_BUCKET).remove([path]);
                throw error;
            }
            client.storage.from(REEL_BUCKET).remove([r.video_path]);
            r.video_path = path;
            app.showToast('Done — this reel now plays on every device ✅');
        } catch (e) {
            app.showToast(e.message === 'convert'
                ? 'This browser couldn’t convert the video — try from Safari or Chrome on your iPhone'
                : 'Couldn’t convert the reel — check your connection and try again');
        } finally {
            st.busy = false;
            if (app.state.view === 'reels' || app.state.view === 'feed') app.render();
        }
    }

    async function reelToStory(id) {
        const r = (st.reels || []).find(x => x.id === id);
        if (!r) return;
        try {
            if (r.author === s.profile.id) {
                await shareToStory({ bucket: REEL_BUCKET, path: r.video_path, type: 'video', caption: (r.caption || '').slice(0, 140), duration: r.duration });
            } else {
                app.showToast('Adding it to your story…');
                const { data } = await client.storage.from(REEL_BUCKET).createSignedUrl(r.video_path, 600);
                if (!data || !data.signedUrl) throw new Error('url');
                const blob = await (await fetch(data.signedUrl)).blob();
                const ext = (r.video_path.match(/\.(mp4|mov|webm)$/i) || [])[1] || 'mp4';
                const type = { mp4: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm' }[ext.toLowerCase()];
                const path = await uploadVideo(STORY_BUCKET, new File([blob], `reel.${ext}`, { type }), type);
                if (!path) throw new Error('upload');
                const who = r.author_profile && r.author_profile.username ? `@${r.author_profile.username}` : 'a friend';
                await shareToStory({ bucket: STORY_BUCKET, path, type: 'video', caption: `🔁 Reel by ${who}${r.caption ? ` — ${r.caption}` : ''}`.slice(0, 140), duration: r.duration });
            }
            app.showToast('Added to your story ✨');
            loadStories();
        } catch (e) {
            app.showToast('Couldn’t add that to your story');
        }
    }

    // Reshare: your friends see the reel too (and who reshared it). Tap again to undo.
    async function reshareReel(id, btn) {
        const r = (st.reels || []).find(x => x.id === id);
        if (!r) return;
        if (I.isGuest && I.isGuest()) return I.openUpgrade && I.openUpgrade();
        r.reshares = r.reshares || [];
        const on = !r.reshares.some(x => x.user_id === s.profile.id);
        r.reshares = on ? [...r.reshares, { user_id: s.profile.id, created_at: new Date().toISOString() }] : r.reshares.filter(x => x.user_id !== s.profile.id);
        const paint = () => {
            if (!btn) return;
            const mine = r.reshares.some(x => x.user_id === s.profile.id);
            btn.setAttribute('aria-pressed', String(mine));
            btn.setAttribute('aria-label', mine ? 'Undo reshare' : 'Reshare to your friends');
            // Feed cards show just the count; the full-screen Reels page shows a label when there's none
            btn.querySelector('span').textContent = r.reshares.length ? compact(r.reshares.length) : (btn.classList.contains('act') ? '' : 'Reshare');
        };
        paint();
        const { error } = on
            ? await client.from('diary_reel_reshares').insert({ reel_id: id })
            : await client.from('diary_reel_reshares').delete().eq('reel_id', id).eq('user_id', s.profile.id);
        if (error) {
            r.reshares = on ? r.reshares.filter(x => x.user_id !== s.profile.id) : [...r.reshares, { user_id: s.profile.id }];
            paint();
            return app.showToast('Couldn’t reshare that reel');
        }
        app.showToast(on ? 'Reshared — your friends will see it 🔁' : 'Reshare removed');
    }

    async function deleteReel(id) {
        const r = (st.reels || []).find(x => x.id === id);
        if (!r) return;
        const ok = await app.ask({ title: 'Delete this reel?', text: 'It’s removed for everyone, with its likes and comments.', ok: 'Delete', danger: true });
        if (!ok) return;
        const { error } = await client.from('diary_reels').delete().eq('id', id);
        if (error) return app.showToast('Couldn’t delete that reel');
        client.storage.from(REEL_BUCKET).remove([r.video_path, r.poster_path].filter(Boolean));
        st.reels = st.reels.filter(x => x.id !== id);
        app.showToast('Reel deleted');
        app.render();
    }

    // ---------- Reel comments (a bottom sheet over the video) ----------
    const sheet = $('reel-sheet');
    let sheetKey = null;

    function openReelComments(id) {
        sheetKey = `reel:${id}`;
        const r = (st.reels || []).find(x => x.id === id);
        $('reel-sheet-body').innerHTML = I.commentsBlock('reel', id, r ? count(r) : 0, true, 'sheet');
        if (!sheet.open) sheet.showModal();
        I.openComments(sheetKey);
    }

    $('reel-sheet-close').addEventListener('click', () => sheet.close());
    sheet.addEventListener('click', e => {
        if (e.target === sheet) return sheet.close();
        const del = e.target.closest('[data-action="comment-delete"]');
        if (del) I.deleteComment(del.dataset.key, del.dataset.id);
        const more = e.target.closest('[data-action="comments-open"]');
        if (more) I.openComments(more.dataset.key);
        // Voice comments and their players work here too
        const act = e.target.closest('[data-action]');
        if (act && !del && !more && app.actions[act.dataset.action]) app.actions[act.dataset.action](act, e);
    });
    sheet.addEventListener('submit', async e => {
        const form = e.target.closest('[data-form="comment"]');
        if (!form) return;
        e.preventDefault();
        const input = form.querySelector('input[name="body"]');
        const body = input.value.trim();
        if (!body) return;
        input.value = '';
        if (!(await I.addComment(form.dataset.key, body))) input.value = body;
        const fresh = sheet.querySelector('input[name="body"]');
        if (fresh) fresh.focus();
    });
    sheet.addEventListener('close', () => { sheetKey = null; });

    // ---------- Actions and render hooks ----------
    Object.assign(app.actions, {
        'story-add': () => addStory(),
        'story-open': el => openStories(el.dataset.id || null),
        'reel-add': () => addReel(),
        'reel-open': el => app.setView('reels', { reelId: el.dataset.id, reelFilter: 'all' }),
        'reel-story': el => reelToStory(el.dataset.id),
        'reel-reshare': el => reshareReel(el.dataset.id, el),
        'reel-convert': el => convertReel(el.dataset.id, el),
        'reels-back': () => app.setView('feed'),
        'reels-filter': el => { app.state.reelFilter = el.dataset.filter; st.scrollTop = 0; app.render(); },
        'reel-toggle': el => {
            const reel = el.closest('.reel');
            const video = reel.querySelector('.reel-video');
            if (!video.src) return;
            if (video.paused) {
                playReel(reel);
            } else {
                video.pause();
                reel.classList.add('paused');
            }
        },
        'reel-like': el => toggleReelLike(el.dataset.id, el),
        'reel-comments': el => openReelComments(el.dataset.id),
        'reel-save': async el => {
            const id = el.dataset.id;
            const paint = () => {
                const on = s.savedReels.has(id);
                el.setAttribute('aria-pressed', String(on));
                el.setAttribute('aria-label', on ? 'Remove from Saved' : 'Save reel');
                el.querySelector('use').setAttribute('href', on ? '#i-bookmark-fill' : '#i-bookmark');
                el.querySelector('span').textContent = on ? 'Saved' : 'Save';
            };
            const done = I.toggleSaved('reel', id);
            paint();
            await done;
            paint();
        },
        'reel-delete': el => deleteReel(el.dataset.id),
        'reel-caption': el => el.classList.toggle('clamped'),
        'reel-mute': () => {
            st.muted = !st.muted;
            content.querySelectorAll('.reel-video, .feed-reel-video').forEach(v => { v.muted = st.muted; });
            content.querySelectorAll('[data-action="reel-mute"]').forEach(b => {
                b.setAttribute('aria-label', st.muted ? 'Turn sound on' : 'Mute');
                b.querySelector('use').setAttribute('href', st.muted ? '#i-volume-off' : '#i-volume');
            });
        }
    });

    const previousAfter = app.hooks.afterRender;
    app.hooks.afterRender = viewName => {
        if (previousAfter) previousAfter(viewName);
        document.body.classList.toggle('reels-mode', viewName === 'reels');
        if (viewName === 'feed') watchFeedReels();
        else if (feedObserver) {
            feedObserver.disconnect();
            feedObserver = null;
        }
        if (viewName === 'reels') {
            watchReels();
        } else if (observer) {
            observer.disconnect();
            observer = null;
        }
    };
});
