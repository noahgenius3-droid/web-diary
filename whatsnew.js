// What's new: a short animated tour of the latest updates, shown once (a few seconds after the app opens, never
// over another window or the sign-in screen) and any time from More → What's new.
// Each scene is a small animated mock-up of the feature, with a caption, optional narration and a "Try it" button.
document.addEventListener('DOMContentLoaded', () => {
    const app = window.diaryApp;
    if (!app) return;
    const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const ic = id => `<svg class="i" aria-hidden="true"><use href="#${id}"/></svg>`;
    const VERSION = '2026-10-podcast';
    const KEY = 'cordialWhatsNew';
    const latestNote = () => app.getNotes().filter(n => !n.trashedAt && !n.archived && n.origin !== 'post' && String(n.text || '').trim()).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))[0];

    const SCENES = [
        { title: 'Turn a note into a podcast', say: 'Any note can now become a podcast episode. Record it in your own voice with a scrolling teleprompter, or let two AI hosts talk it through — then add podcast equipment: a broadcast microphone, a compressor, a room sound and intro music.', dur: 9500,
            cta: ['Make a podcast', () => { const n = latestNote(); if (n && window.diaryPodcast) window.diaryPodcast.open(n); else app.showToast('Write a note first — then tap ⋯ → Make a podcast'); }],
            html: () => `<div class="wn-pod">
                <div class="wn-mic" style="--d:.2s">🎙️<i class="wn-wave"></i><i class="wn-wave b"></i></div>
                <div class="wn-rack">${['Broadcast mic', 'Compressor', 'Small room', 'Chill intro'].map((t, i) => `<span style="--d:${0.6 + i * 0.35}s"><b></b>${t}</span>`).join('')}</div>
                <div class="wn-episode" style="--d:2.4s"><span class="wn-cover">🎙️</span><span><strong>Sunday Sermon</strong><small>Episode · 4:12</small><i class="wn-play"></i></span></div></div>` },
        { title: 'Every note card has actions', say: 'Tap the three dots on any note — or long-press it — to pin it, edit it, move it to a folder, share it or delete it, without opening the note.', dur: 8000,
            cta: ['See your notes', () => app.setView('home')],
            html: () => `<div class="wn-cards"><div class="wn-mcard" style="--d:.2s"><b>Shopping list</b><small>Milk, eggs…</small></div>
                <div class="wn-mcard on" style="--d:.4s"><b>Sunday Sermon</b><small>Romans 12…</small><span class="wn-dots" style="--d:1.2s">⋯</span>
                <div class="wn-menu" style="--d:1.9s">${[['📌', 'Pin'], ['✏️', 'Edit'], ['📁', 'Move to folder'], ['↗', 'Share'], ['🗑', 'Delete']].map(([e, l], i) => `<span${i === 4 ? ' class="red"' : ''}>${e} ${l}</span>`).join('')}</div></div></div>` },
        { title: 'Scan → Note with your camera', say: 'Point your camera at handwriting, a whiteboard, a textbook or a receipt. Cordial lines it up, cleans it up and turns it into a note you can edit.', dur: 8500,
            cta: ['Scan something', () => window.diaryScan ? window.diaryScan.scan() : app.showToast('Scanning isn’t available here')],
            html: () => `<div class="wn-scan"><div class="wn-phone" style="--d:.2s"><div class="wn-paper"><i></i><i></i><i></i><i></i><span class="wn-beam"></span></div><span class="wn-corners"></span></div>
                <span class="wn-arrow" style="--d:1.8s">→</span>
                <div class="wn-note" style="--d:2.4s"><b>Lecture 4</b><p>Cells are the basic unit of life.</p><p>Nucleus: controls the cell.</p></div></div>` },
        { title: 'Live now, right at the top of Explore', say: 'See who’s live on video and which audio rooms are open, straight away — and start your own with Go live or Host a room.', dur: 8000,
            cta: ['Open Explore', () => app.setView('explore')],
            html: () => `<div class="wn-live"><p class="wn-live-h" style="--d:.2s"><i></i>Live now <b>3</b></p>
                <div class="wn-live-btns" style="--d:.6s"><span class="p">◉ Go live</span><span>🎧 Host a room</span></div>
                <div class="wn-live-row">${[['Sunday worship', 'Video'], ['Prayer room', 'Audio'], ['Q&A', 'Video']].map(([t, k], i) => `<span class="wn-live-card" style="--d:${1.1 + i * 0.3}s"><em>LIVE</em><b>${t}</b><small>${k}</small></span>`).join('')}</div></div>` },
        { title: 'New games with friends', say: 'Play Chess, Ludo and a 3D Penalty Shootout against friends or the computer — with a chat room inside every game.', dur: 8500,
            cta: ['Play now', () => app.setView('play')],
            html: () => `<div class="wn-games">${[['♞', 'Chess'], ['🎲', 'Ludo'], ['⚽', 'Penalty Shootout']].map(([e, t], i) => `<span class="wn-game g${i}" style="--d:${0.3 + i * 0.4}s"><b>${e}</b>${t}</span>`).join('')}
                <div class="wn-goal" style="--d:1.8s"><span class="wn-net"></span><span class="wn-ball">⚽</span><span class="wn-goal-txt">GOAL!</span></div></div>` },
        { title: 'And a few nice touches', say: 'Expand a shared screen during calls, tap a profile photo to see it full size, and your posts now show your name.', dur: 8000,
            html: () => `<div class="wn-touches">${[['🖥️', 'Expand shared screens in calls'], ['🖼️', 'Tap profile photos to view them'], ['✍️', 'Your name on your posts'], ['📷', 'Photos load reliably the first time']].map(([e, t], i) => `<span style="--d:${0.3 + i * 0.4}s"><b>${e}</b>${t}</span>`).join('')}</div>` }
    ];

    let T = null;
    function open() {
        try { localStorage.setItem(KEY, VERSION); } catch (e) { /* private mode */ }
        if (T) return;
        let sound = false;
        try { sound = localStorage.getItem('cordialTourVoice') === '1'; } catch (e) { /* ignore */ }
        const dlg = document.createElement('dialog');
        dlg.className = 'gm wn';
        dlg.setAttribute('aria-label', 'What’s new in Cordial');
        dlg.innerHTML = `
            <div class="gm-card wn-card">
                <header class="gm-head"><button type="button" class="icon-btn" data-w="close" aria-label="Close">${ic('i-close')}</button>
                    <div class="gm-title"><strong>✨ What’s new</strong><small>The latest in Cordial</small></div>
                    ${'speechSynthesis' in window ? `<button type="button" class="icon-btn" data-w="sound" aria-pressed="${sound}" aria-label="Narration">${ic(sound ? 'i-volume' : 'i-volume-off')}</button>` : ''}</header>
                <div class="ht-bar" role="tablist" aria-label="Updates">${SCENES.map((s, i) => `<button type="button" class="ht-seg" data-seg="${i}" role="tab" aria-label="${esc(s.title)}"><i></i></button>`).join('')}</div>
                <div class="wn-stage" aria-hidden="true"></div>
                <div class="ht-cap"><div class="ht-cap-text" aria-live="polite"><small class="ht-n"></small><strong class="ht-title"></strong><p class="ht-say"></p></div></div>
                <div class="wn-try-row"><button type="button" class="primary-btn wn-try" data-w="try" hidden></button></div>
                <div class="ht-ctl"><button type="button" class="icon-btn" data-w="prev" aria-label="Previous">${ic('i-back')}</button><button type="button" class="ht-play" data-w="toggle" aria-label="Pause">${ic('i-pause')}</button><button type="button" class="icon-btn" data-w="next" aria-label="Next">${ic('i-forward')}</button></div>
            </div>`;
        document.body.append(dlg);
        T = { dlg, i: 0, t: 0, playing: true, raf: 0, sound, ended: false };
        const say = text => { if (!T || !T.sound || !('speechSynthesis' in window)) return; try { speechSynthesis.cancel(); const u = new SpeechSynthesisUtterance(text); u.rate = 1.03; speechSynthesis.speak(u); } catch (e) { /* no voice */ } };
        const scene = i => {
            const sc = SCENES[i];
            T.i = i; T.t = 0; T.ended = false;
            const stage = dlg.querySelector('.wn-stage');
            stage.classList.remove('paused');
            stage.innerHTML = sc.html();
            dlg.querySelector('.ht-n').textContent = `New · ${i + 1} of ${SCENES.length}`;
            dlg.querySelector('.ht-title').textContent = sc.title;
            dlg.querySelector('.ht-say').textContent = sc.say;
            const tr = dlg.querySelector('[data-w="try"]');
            tr.hidden = !sc.cta;
            tr.textContent = sc.cta ? `${sc.cta[0]} →` : '';
            dlg.querySelectorAll('.ht-seg').forEach((b, k) => { b.setAttribute('aria-selected', String(k === i)); b.querySelector('i').style.transform = `scaleX(${k < i ? 1 : 0})`; });
            if (!T.playing) setPlaying(true); else { say(sc.say); loop(); }
        };
        const setPlaying = on => {
            T.playing = on;
            const b = dlg.querySelector('[data-w="toggle"]');
            b.innerHTML = ic(on ? 'i-pause' : 'i-play');
            b.setAttribute('aria-label', on ? 'Pause' : 'Play');
            dlg.querySelector('.wn-stage').classList.toggle('paused', !on);
            try { if (on) { if (speechSynthesis.paused) speechSynthesis.resume(); else if (T.t < 300) say(SCENES[T.i].say); } else speechSynthesis.pause(); } catch (e) { /* ignore */ }
            if (on) loop(); else cancelAnimationFrame(T.raf);
        };
        const loop = () => {
            cancelAnimationFrame(T.raf);
            let last = performance.now();
            const tick = now => {
                if (!T || !T.playing) return;
                T.t += Math.min(100, now - last); last = now;
                const sc = SCENES[T.i];
                const seg = dlg.querySelectorAll('.ht-seg i')[T.i];
                if (seg) seg.style.transform = `scaleX(${Math.min(1, T.t / sc.dur)})`;
                if (T.t >= sc.dur) {
                    if (T.i < SCENES.length - 1) return scene(T.i + 1);
                    T.playing = false; T.ended = true;
                    const b = dlg.querySelector('[data-w="toggle"]'); b.innerHTML = ic('i-play'); b.setAttribute('aria-label', 'Watch again');
                    const end = document.createElement('div');
                    end.className = 'ht-end';
                    end.innerHTML = '<strong>That’s what’s new ✨</strong><span>Enjoy — and tell us what you think</span><div><button type="button" class="primary-btn" data-w="close">Got it</button><button type="button" class="ghost-btn" data-w="replay">Watch again</button></div>';
                    dlg.querySelector('.wn-stage').append(end);
                    return;
                }
                T.raf = requestAnimationFrame(tick);
            };
            T.raf = requestAnimationFrame(tick);
        };
        dlg.addEventListener('click', e => {
            if (e.target === dlg) return dlg.close();
            const seg = e.target.closest('[data-seg]');
            if (seg) return scene(Number(seg.dataset.seg));
            const b = e.target.closest('[data-w]');
            if (!b) return;
            const a = b.dataset.w;
            if (a === 'close') return dlg.close();
            if (a === 'toggle') return T.ended ? scene(0) : setPlaying(!T.playing);
            if (a === 'prev') return scene(Math.max(0, T.t > 1500 ? T.i : T.i - 1));
            if (a === 'next') { if (T.i < SCENES.length - 1) scene(T.i + 1); return; }
            if (a === 'replay') return scene(0);
            if (a === 'try') { const sc = SCENES[T.i]; dlg.close(); if (sc.cta) setTimeout(sc.cta[1], 50); return; }
            if (a === 'sound') {
                T.sound = !T.sound;
                try { localStorage.setItem('cordialTourVoice', T.sound ? '1' : '0'); } catch (e2) { /* ignore */ }
                b.setAttribute('aria-pressed', String(T.sound));
                b.innerHTML = ic(T.sound ? 'i-volume' : 'i-volume-off');
                if (T.sound && T.playing) say(SCENES[T.i].say); else speechSynthesis.cancel();
            }
        });
        dlg.addEventListener('keydown', e => {
            if (e.key === 'ArrowRight' && T.i < SCENES.length - 1) scene(T.i + 1);
            else if (e.key === 'ArrowLeft') scene(Math.max(0, T.i - 1));
            else if (e.key === ' ' && !e.target.closest('button')) { e.preventDefault(); T.ended ? scene(0) : setPlaying(!T.playing); }
        });
        dlg.addEventListener('close', () => { cancelAnimationFrame(T && T.raf); try { speechSynthesis.cancel(); } catch (e) { /* ignore */ } dlg.remove(); T = null; });
        dlg.showModal();
        if (matchMedia('(prefers-reduced-motion: reduce)').matches) dlg.classList.add('calm');
        scene(0);
    }

    // Once per update: a moment after the app opens, never over another window or the sign-in screen
    setTimeout(function offer() {
        let seen = null;
        try { seen = localStorage.getItem(KEY); } catch (e) { return; }
        if (seen === VERSION) return;
        const blocked = document.querySelector('dialog[open]') || document.getElementById('splash') || [...document.querySelectorAll('.auth')].some(el => el.getClientRects().length > 0);
        if (blocked || document.visibilityState !== 'visible') return setTimeout(offer, 4000);
        open();
    }, 3500);

    window.diaryWhatsNew = { open };
});
