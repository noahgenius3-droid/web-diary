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
        openReelComments
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
                if (st.reels !== null && app.state.view !== 'reels') st.reels = null;
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
            .select(`id, author, media_path, media_type, caption, duration, created_at, expires_at,
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
    // Reads a video's length (and, for reels, grabs a poster frame) without playing it
    function probeVideo(file, wantPoster) {
        return new Promise(resolve => {
            const url = URL.createObjectURL(file);
            const video = document.createElement('video');
            let done = false;
            const finish = result => {
                if (done) return;
                done = true;
                URL.revokeObjectURL(url);
                resolve(result);
            };
            video.muted = true;
            video.playsInline = true;
            video.preload = 'auto';
            video.src = url;
            video.addEventListener('error', () => finish(null));
            video.addEventListener('loadedmetadata', () => {
                const duration = video.duration;
                if (!wantPoster) return finish({ duration });
                video.currentTime = Math.min(0.5, duration / 2 || 0);
                video.addEventListener('seeked', () => {
                    try {
                        const scale = Math.min(1, 720 / Math.max(video.videoWidth, video.videoHeight));
                        const canvas = document.createElement('canvas');
                        canvas.width = Math.round(video.videoWidth * scale) || 360;
                        canvas.height = Math.round(video.videoHeight * scale) || 640;
                        canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
                        canvas.toBlob(blob => finish({ duration, poster: blob }), 'image/jpeg', 0.8);
                    } catch (e) {
                        finish({ duration, poster: null });
                    }
                }, { once: true });
            });
            setTimeout(() => finish(null), 15000);
        });
    }

    function videoType(file) {
        if (VIDEO_TYPES[file.type]) return file.type;
        const ext = (file.name || '').toLowerCase().split('.').pop();
        return { mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm' }[ext] || null;
    }

    // The compose sheet: preview, caption, Share. Resolves with the caption or null if cancelled.
    function compose({ title, file, isVideo, maxCaption, note }) {
        const dialog = $('media-compose');
        const preview = $('mc-preview');
        const caption = $('mc-caption');
        const url = URL.createObjectURL(file);
        $('mc-title').textContent = title;
        $('mc-share').disabled = false;
        $('mc-share').textContent = 'Share';
        caption.value = '';
        caption.maxLength = maxCaption;
        $('mc-note').lastChild.textContent = note;
        preview.innerHTML = isVideo
            ? `<video src="${url}" playsinline autoplay muted loop></video>`
            : `<img src="${url}" alt="">`;
        dialog.showModal();
        return new Promise(resolve => {
            const cleanup = value => {
                $('mc-form').onsubmit = null;
                $('mc-cancel').onclick = null;
                dialog.onclose = null;
                if (dialog.open) dialog.close();
                preview.innerHTML = '';
                URL.revokeObjectURL(url);
                resolve(value);
            };
            $('mc-form').onsubmit = e => {
                e.preventDefault();
                cleanup(caption.value.trim());
            };
            $('mc-cancel').onclick = () => cleanup(null);
            dialog.onclose = () => cleanup(null);
        });
    }

    async function uploadVideo(bucket, file, type) {
        const path = `${s.profile.id}/${randomId()}${VIDEO_TYPES[type]}`;
        const buf = await file.arrayBuffer();
        const { error } = await client.storage.from(bucket).upload(path, buf, { contentType: type, upsert: false });
        if (error) {
            console.warn('Video upload failed', error.message);
            return null;
        }
        return path;
    }

    async function addStory() {
        if (st.busy) return app.showToast('Still posting your last one…');
        const [file] = await Media.pickFiles('image/*,video/*', false);
        if (!file) return;
        const type = videoType(file);
        const isVideo = !!type || (file.type || '').startsWith('video/');
        let duration = null;
        if (isVideo) {
            if (!type) return app.showToast('That video format isn’t supported — try MP4 or MOV');
            if (file.size > MAX_BYTES) return app.showToast('Videos can be up to 50 MB');
            const info = await probeVideo(file, false);
            if (!info) return app.showToast('Couldn’t read that video');
            if (info.duration > MAX_STORY_VIDEO + 0.5) {
                return app.showToast(`Stories can be up to ${MAX_STORY_VIDEO} seconds — post longer videos as a reel`);
            }
            duration = Math.max(1, Math.round(info.duration * 10) / 10);
        } else if (!(file.type || '').startsWith('image/') && !/\.(heic|heif)$/i.test(file.name || '')) {
            return app.showToast('Pick a photo or a video');
        }

        const caption = await compose({ title: 'New story', file, isVideo, maxCaption: 300, note: 'Friends only · disappears after 24 hours' });
        if (caption === null) return;

        st.busy = true;
        paintStrip();
        app.showToast('Posting your story…');
        try {
            const path = isVideo
                ? await uploadVideo(STORY_BUCKET, file, type)
                : await uploadImage(STORY_BUCKET, `${s.profile.id}/${randomId()}`, file);
            if (!path) throw new Error('upload');
            const { error } = await client.from('diary_stories').insert({
                media_path: path, media_type: isVideo ? 'video' : 'image', caption, duration
            });
            if (error) {
                client.storage.from(STORY_BUCKET).remove([path]);
                throw error;
            }
            app.showToast('Added to your story ✨');
        } catch (e) {
            app.showToast('Couldn’t post your story — check your connection and try again');
        } finally {
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
        const group = view.groups[view.gi];
        const item = current();
        s.seenStories.add(item.id);
        try { localStorage.setItem('diarySeenStories', JSON.stringify([...s.seenStories].slice(-400))); } catch (e) {}

        const mine = group.author === s.profile.id;
        const seconds = item.media_type === 'video' ? (item.duration || 15) : IMAGE_SECONDS;
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
                ? `<video class="story-media" data-path="${esc(item.media_path)}" data-bucket="${STORY_BUCKET}" playsinline autoplay></video>`
                : `<img class="story-media" data-path="${esc(item.media_path)}" data-bucket="${STORY_BUCKET}" alt="">`}
            ${item.caption ? `<p class="story-caption">${esc(item.caption)}</p>` : ''}`;
        const media = card.querySelector('.story-media');
        hydrateStorage(card).then(() => {
            if (item.media_type === 'video' && current() === item) {
                media.play().catch(() => {
                    media.muted = true;
                    media.play().catch(() => {});
                });
            }
        });
        if (item.media_type === 'video') {
            media.addEventListener('ended', () => step(1));
            media.addEventListener('waiting', () => card.classList.add('buffering'));
            media.addEventListener('playing', () => card.classList.remove('buffering'));
        }
        view.paused = false;
        viewer.classList.remove('paused');
        run(seconds * 1000 + (item.media_type === 'video' ? 1500 : 0)); // videos end on 'ended'; the timer is a safety net
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
    }

    function resume() {
        if (!view || !view.paused) return;
        view.paused = false;
        viewer.classList.remove('paused');
        const video = viewer.querySelector('video.story-media');
        if (video) video.play().catch(() => {});
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
        client.storage.from(STORY_BUCKET).remove([item.media_path]);
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
    viewer.addEventListener('pointerdown', e => {
        if (e.target.closest('.story-head')) return;
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
        if (st.reelsLoading) return;
        st.reelsLoading = true;
        const { data, error } = await client.from('diary_reels')
            .select(`id, author, video_path, poster_path, caption, duration, created_at,
                author_profile:diary_profiles!diary_reels_author_fkey(${PROFILE}),
                likes:diary_reel_likes(user_id),
                comments:diary_comments(count)`)
            .order('created_at', { ascending: false })
            .limit(50);
        st.reelsLoading = false;
        st.reels = error ? [] : data;
        st.reelsError = !!error;
        if (app.state.view === 'reels') app.render();
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
        return `
            <article class="reel" data-reel="${esc(r.id)}">
                ${r.poster_path ? `<img class="reel-poster" data-path="${esc(r.poster_path)}" data-bucket="${REEL_BUCKET}" alt="">` : ''}
                <video class="reel-video" data-path="${esc(r.video_path)}" data-bucket="${REEL_BUCKET}" playsinline loop preload="metadata"${st.muted ? ' muted' : ''}></video>
                <button class="reel-tap" data-action="reel-toggle" aria-label="Play or pause"></button>
                <span class="reel-state" aria-hidden="true"><svg class="i"><use href="#i-play"/></svg></span>
                <span class="burst" aria-hidden="true"><svg class="i"><use href="#i-heart-fill"/></svg></span>
                <div class="reel-info">
                    <div class="reel-who">${avatar(person, 'sm')}<strong>${r.author === me ? 'You' : esc(p.display_name)}</strong><span>· ${timeAgo(r.created_at)}</span></div>
                    ${r.caption ? `<p class="reel-caption${long ? ' clamped' : ''}"${long ? ' data-action="reel-caption"' : ''}>${esc(r.caption)}</p>` : ''}
                </div>
                <div class="reel-side">
                    <button class="reel-act" data-action="reel-like" data-id="${esc(r.id)}" aria-pressed="${liked}" aria-label="${liked ? 'Unlike' : 'Like'}">
                        <svg class="i"><use href="#${liked ? 'i-heart-fill' : 'i-heart'}"/></svg><span data-count="likes">${compact(r.likes.length)}</span>
                    </button>
                    <button class="reel-act" data-action="reel-comments" data-id="${esc(r.id)}" aria-label="Comments">
                        <svg class="i"><use href="#i-chat"/></svg><span data-count="comments">${compact(count(r))}</span>
                    </button>
                    <button class="reel-act" data-action="reel-save" data-id="${esc(r.id)}" aria-pressed="${saved}" aria-label="${saved ? 'Remove from Saved' : 'Save reel'}">
                        <svg class="i"><use href="#${saved ? 'i-bookmark-fill' : 'i-bookmark'}"/></svg><span>${saved ? 'Saved' : 'Save'}</span>
                    </button>
                    <button class="reel-act" data-action="reel-mute" aria-label="${st.muted ? 'Turn sound on' : 'Mute'}">
                        <svg class="i"><use href="#${st.muted ? 'i-volume-off' : 'i-volume'}"/></svg>
                    </button>
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
        hydrateStorage(box);
        if (st.scrollTop && !app.state.reelId) box.scrollTop = st.scrollTop;
        box.addEventListener('scroll', () => { st.scrollTop = box.scrollTop; }, { passive: true });
        observer = new IntersectionObserver(entries => {
            entries.forEach(entry => {
                const video = entry.target.querySelector('.reel-video');
                if (!video) return;
                if (entry.isIntersecting && entry.intersectionRatio > 0.6) {
                    if (!video.dataset.hydrated) hydrateStorage(entry.target).then(() => playReel(entry.target));
                    else playReel(entry.target);
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

    function playReel(el) {
        const video = el.querySelector('.reel-video');
        if (!video || !video.src) return;
        video.muted = st.muted;
        video.play().then(() => el.classList.remove('paused')).catch(() => {
            video.muted = true;
            video.play().catch(() => el.classList.add('paused'));
        });
    }

    // Progress bar + hide the poster once frames are showing
    content.addEventListener('timeupdate', e => {
        const video = e.target;
        if (!video.classList || !video.classList.contains('reel-video')) return;
        const bar = video.closest('.reel').querySelector('.reel-progress i');
        if (bar && video.duration) bar.style.width = `${(video.currentTime / video.duration) * 100}%`;
    }, true);
    content.addEventListener('playing', e => {
        if (e.target.classList && e.target.classList.contains('reel-video')) e.target.closest('.reel').classList.add('started');
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

    async function addReel() {
        if (st.busy) return app.showToast('Still posting your last one…');
        const [file] = await Media.pickFiles('video/*', false);
        if (!file) return;
        const type = videoType(file);
        if (!type) return app.showToast('That video format isn’t supported — try MP4 or MOV');
        if (file.size > MAX_BYTES) return app.showToast('Reels can be up to 50 MB — try a shorter clip');
        const info = await probeVideo(file, true);
        if (!info) return app.showToast('Couldn’t read that video');
        if (info.duration > MAX_REEL + 0.5) return app.showToast('Reels can be up to 3 minutes');

        const caption = await compose({ title: 'New reel', file, isVideo: true, maxCaption: 2200, note: 'Friends only' });
        if (caption === null) return;

        st.busy = true;
        app.render();
        app.showToast('Uploading your reel…');
        let videoPath = null;
        let posterPath = null;
        try {
            videoPath = await uploadVideo(REEL_BUCKET, file, type);
            if (!videoPath) throw new Error('upload');
            if (info.poster) {
                const path = `${s.profile.id}/${randomId()}.jpg`;
                const { error } = await client.storage.from(REEL_BUCKET)
                    .upload(path, await info.poster.arrayBuffer(), { contentType: 'image/jpeg', upsert: false });
                if (!error) posterPath = path;
            }
            const { error } = await client.from('diary_reels').insert({
                video_path: videoPath, poster_path: posterPath, caption,
                duration: Math.max(1, Math.round(info.duration * 10) / 10)
            });
            if (error) throw error;
            app.showToast('Your reel is live 🎬');
            app.state.reelFilter = 'all';
        } catch (e) {
            const leftovers = [videoPath, posterPath].filter(Boolean);
            if (leftovers.length) client.storage.from(REEL_BUCKET).remove(leftovers);
            app.showToast('Couldn’t post your reel — check your connection and try again');
        } finally {
            st.busy = false;
            st.reels = null;
            if (app.state.view === 'reels') app.render();
        }
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
        $('reel-sheet-body').innerHTML = I.commentsBlock('reel', id, r ? count(r) : 0, true);
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
            content.querySelectorAll('.reel-video').forEach(v => { v.muted = st.muted; });
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
        if (viewName === 'reels') {
            watchReels();
        } else if (observer) {
            observer.disconnect();
            observer = null;
        }
    };
});
