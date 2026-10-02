// Sound pages (#/sound/<audioId>): tap "♪ Artist · Title" on a post or reel to see the song — artwork, title,
// artist, genre and licence — hear the part people use, start a post with it, and browse every post and reel
// that uses it. Sounds are found by the audioId each post / reel stores with its music (older posts: id).
document.addEventListener('DOMContentLoaded', () => {
    const app = window.diaryApp;
    const social = window.diarySocial;
    if (!app || !social || !social.internals) return;
    const I = social.internals;
    const { client, state: s, esc } = I;
    const lib = () => window.diaryAudioLib;

    const S = { id: null, music: null, posts: null, reels: null, error: false, token: 0, player: null };
    const fmt = n => (n >= 10000 ? `${Math.round(n / 1000)}k` : n >= 1000 ? `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k` : String(n || 0));
    const quoted = v => `"${String(v).replace(/(["\\])/g, '\\$1')}"`;

    async function load(id) {
        const token = ++S.token;
        stop();
        Object.assign(S, { id, posts: null, reels: null, error: false, music: (s.sounds && s.sounds.get(id)) || null });
        const [posts, reels] = await Promise.all([
            client.from('diary_shared_entries').select(I.FEED_SELECT)
                .or(`audio->music->>audioId.eq.${quoted(id)},audio->music->>id.eq.${quoted(id)}`)
                .order('shared_at', { ascending: false }).limit(60),
            client.from('diary_reels').select('id, author, video_path, poster_path, caption, duration, created_at, music')
                .eq('music->>audioId', id).order('created_at', { ascending: false }).limit(60)
        ]);
        if (token !== S.token) return;
        S.error = !!posts.error;
        S.posts = posts.data || [];
        S.reels = reels.error ? [] : reels.data || [];
        if (!S.music) {
            const withAudio = S.posts.find(p => p.audio && p.audio.music);
            const fromReel = S.reels.find(r => r.music);
            const m = withAudio ? { ...withAudio.audio.music, path: withAudio.audio.path || null } : fromReel ? fromReel.music : null;
            if (m) S.music = I.soundRecord(m);
            else if (lib()) {
                const own = lib().trackFromMusic({ id });
                if (own) S.music = I.soundRecord({ id: own.id, title: own.title, artist: own.artist, cover: null, style: own.style, category: null, source: 'cordial', start: 0, length: 30 });
            }
        }
        // A playable copy: the licensed stream, or a post's rendered clip
        if (S.music && !S.music.src && !S.music.path) {
            const p = S.posts.find(x => x.audio && x.audio.path);
            if (p) S.music = { ...S.music, path: p.audio.path };
        }
        paint();
    }

    function paint() {
        if (app.state.view !== 'sound') return;
        app.requestRender ? app.requestRender('sound') : app.render();
    }

    // ---------- Listening ----------
    function stop() {
        if (S.player) { S.player.stop(); S.player = null; }
        const b = document.querySelector('.snd-play');
        if (b) { b.setAttribute('aria-pressed', 'false'); b.innerHTML = playLabel(false); }
    }
    const playLabel = on => `<svg class="i"><use href="#${on ? 'i-pause' : 'i-play'}"/></svg><span>${on ? 'Pause' : 'Play'}</span>`;
    async function play(btn) {
        if (S.player) return stop();
        const m = S.music;
        if (!m) return;
        if (lib()) lib().stop();
        let url = m.src || null;
        if (!url && m.path) {
            const { data } = await client.storage.from(I.POST_AUDIO).createSignedUrl(m.path, 3600);
            url = data && data.signedUrl;
        }
        if (!url && m.source === 'cordial' && lib()) {
            const track = lib().trackFromMusic(m);
            if (track) {
                const buf = await lib().renderCordial(track, m.start || 0, Math.min(m.length || 30, 30), m.volume || 0.8);
                url = URL.createObjectURL(new Blob([lib().wavFrom(buf)], { type: 'audio/wav' }));
            }
        }
        if (!url) return app.showToast('This sound can’t play right now');
        S.player = I.soundPlayer(m, url);
        S.player.audio.addEventListener('pause', () => { if (S.player && S.player.audio.paused) stop(); });
        btn.setAttribute('aria-pressed', 'true');
        btn.innerHTML = playLabel(true);
        S.player.play().catch(() => { stop(); app.showToast('Couldn’t play that sound'); });
    }

    // ---------- The page ----------
    app.views.sound = () => {
        const id = app.state.soundId;
        app.setTitle('Sound');
        const blocked = I.gate('See the posts and reels that use a sound.');
        if (blocked) return blocked;
        if (id !== S.id) { load(id); return skeleton(); }
        const m = S.music;
        if (!m && S.posts === null) return skeleton();
        if (!m) {
            return `<div class="snd-page">${topHTML()}<div class="empty"><p class="empty-title">${S.error ? 'Couldn’t load this sound' : 'This sound isn’t available'}</p>
                <p>${S.error ? 'Check your connection and try again.' : 'The posts that used it may have been removed.'}</p>
                ${S.error ? '<button class="primary-btn" style="margin-top:14px" data-snd="retry">Try again</button>' : ''}</div></div>`;
        }
        const posts = S.posts || [];
        const reels = S.reels || [];
        const total = posts.length + reels.length;
        const cover = lib() ? lib().coverHTML({ cover: m.cover, style: m.style }, true) : '';
        const genre = m.genre || m.category;
        return `
            <div class="snd-page">
                ${topHTML()}
                <section class="snd-hero" aria-labelledby="snd-title">
                    <div class="snd-cover">${cover}</div>
                    <div class="snd-info">
                        <p class="snd-kicker"><svg class="i"><use href="#i-music"/></svg>Sound</p>
                        <h1 id="snd-title">${esc(m.title)}</h1>
                        <p class="snd-artist">${esc(m.artist)}</p>
                        <p class="snd-meta">${[genre ? esc(genre) : '', S.posts === null ? '' : `${fmt(total)} ${total === 1 ? 'post' : 'posts'}`, m.source === 'cordial' ? 'Cordial Sounds' : ''].filter(Boolean).join(' · ')}</p>
                        ${m.licenseUrl ? `<p class="snd-lic"><a href="${esc(m.licenseUrl)}" target="_blank" rel="noopener noreferrer">${esc(m.licenseName || 'Creative Commons')}</a>${m.provider ? ` · ${esc(m.provider)}` : ''}${m.shareurl ? ` · <a href="${esc(m.shareurl)}" target="_blank" rel="noopener noreferrer">Full song</a>` : ''}</p>` : ''}
                        <div class="snd-actions">
                            <button type="button" class="snd-play" data-snd="play" aria-pressed="${!!S.player}">${playLabel(!!S.player)}</button>
                            <button type="button" class="primary-btn snd-use" data-snd="use"><svg class="i"><use href="#i-plus"/></svg>Use this sound</button>
                        </div>
                    </div>
                </section>
                <h2 class="snd-sub">Posts with this sound</h2>
                ${S.posts === null ? `<div class="snd-grid">${'<span class="snd-tile skel"></span>'.repeat(6)}</div>`
                    : total ? `<div class="snd-grid">${[...reels.map(reelTile), ...posts.map(postTile)].join('')}</div>`
                    : '<div class="empty small"><p class="empty-title">No posts you can see yet</p><p>Be the first — tap “Use this sound”.</p></div>'}
            </div>`;
    };

    function topHTML() {
        return ''; // the top bar already has Back
    }
    function skeleton() {
        return `<div class="snd-page" aria-busy="true">${topHTML()}<section class="snd-hero"><div class="snd-cover"><span class="al-cover big skel"></span></div><div class="snd-info"><i class="sk-line w40"></i><i class="sk-line w70"></i><i class="sk-line w40"></i></div></section></div>`;
    }
    function postTile(p) {
        const ph = (p.photos || []).find(x => x && typeof x.path === 'string' && !/\.(mp4|mov|webm)$/i.test(x.path));
        const who = (p.author_profile && p.author_profile.display_name) || 'Someone';
        const n = (p.likes || []).length;
        return `<button type="button" class="snd-tile${ph ? '' : ' text'}" data-snd="post" data-id="${esc(p.id)}" aria-label="Post by ${esc(who)}">
            ${ph ? `<img data-path="${esc(ph.path)}" data-bucket="${esc(ph.bucket || 'diary-feed')}" alt="" loading="lazy">` : `<span class="snd-tile-text">${esc(String(p.title || p.body || '').slice(0, 120))}</span>`}
            ${n ? `<span class="snd-tile-n"><svg class="i"><use href="#i-thumb"/></svg>${fmt(n)}</span>` : ''}
        </button>`;
    }
    function reelTile(r) {
        return `<button type="button" class="snd-tile reel" data-action="reel-open" data-id="${esc(r.id)}" aria-label="Reel">
            ${r.poster_path ? `<img data-path="${esc(r.poster_path)}" data-bucket="diary-reels" alt="" loading="lazy">` : ''}
            <span class="snd-tile-n"><svg class="i"><use href="#i-reel"/></svg>Reel</span>
        </button>`;
    }

    document.addEventListener('click', e => {
        const el = e.target.closest('[data-snd]');
        if (!el || app.state.view !== 'sound') return;
        const what = el.dataset.snd;
        if (what === 'back') { stop(); history.length > 1 ? history.back() : app.setView('feed'); }
        else if (what === 'retry') { S.id = null; app.render(); }
        else if (what === 'play') play(el);
        else if (what === 'use') { stop(); if (S.music) I.useSound(S.music); }
        else if (what === 'post') { stop(); I.openEntry(el.dataset.id); }
    });

    const previousAfter = app.hooks.afterRender;
    app.hooks.afterRender = (view, how) => {
        if (previousAfter) previousAfter(view, how);
        if (view !== 'sound') stop();
        else I.hydrateStorage(document.getElementById('content'));
    };
});
