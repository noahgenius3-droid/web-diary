// Chat wallpapers: pick a photo from your library or one of the recommended designs for any chat
// (a friend's DM or a community group chat). Saved on this device; a photo stays on the phone (IndexedDB).
(() => {
    const KEY = 'diaryWallpapers';   // { "dm:<id>" | "gc:<id>" | "*": { id, dim } }
    const PHOTO = key => `wallpaper:${key}`;

    // Recommended designs — drawn with CSS, so they're crisp at any size and weigh nothing
    const dots = (c, bg) => `radial-gradient(${c} 1.2px, transparent 1.4px) 0 0 / 18px 18px, ${bg}`;
    const PRESETS = [
        { id: 'dusk', name: 'Dusk', css: 'linear-gradient(160deg, #312e81 0%, #7c3aed 45%, #db2777 100%)', dark: true },
        { id: 'ocean', name: 'Ocean', css: 'linear-gradient(160deg, #0c4a6e 0%, #0e7490 50%, #14b8a6 100%)', dark: true },
        { id: 'meadow', name: 'Meadow', css: 'linear-gradient(160deg, #ecfccb 0%, #bbf7d0 50%, #99f6e4 100%)' },
        { id: 'peach', name: 'Peach', css: 'linear-gradient(160deg, #fff7ed 0%, #fed7aa 55%, #fecdd3 100%)' },
        { id: 'lilac', name: 'Lilac', css: 'linear-gradient(160deg, #f5f3ff 0%, #e9d5ff 55%, #fbcfe8 100%)' },
        { id: 'midnight', name: 'Midnight', css: 'radial-gradient(120% 90% at 20% 0%, #1e1b4b 0%, #09090b 60%), #09090b', dark: true },
        { id: 'sunrise', name: 'Sunrise', css: 'linear-gradient(180deg, #fde68a 0%, #fb923c 55%, #e11d48 100%)', dark: true },
        { id: 'paper', name: 'Paper', css: dots('rgba(120, 113, 108, 0.22)', '#faf7f2') },
        { id: 'graphite', name: 'Graphite', css: dots('rgba(255, 255, 255, 0.08)', '#18181b'), dark: true },
        { id: 'mint', name: 'Mint dots', css: dots('rgba(4, 120, 87, 0.18)', '#ecfdf5') },
        { id: 'aurora', name: 'Aurora', css: 'radial-gradient(60% 50% at 20% 20%, rgba(52, 211, 153, 0.55), transparent 70%), radial-gradient(60% 50% at 80% 30%, rgba(129, 140, 248, 0.6), transparent 70%), radial-gradient(70% 60% at 50% 90%, rgba(236, 72, 153, 0.45), transparent 70%), #0b1020', dark: true },
        { id: 'sand', name: 'Sand', css: 'linear-gradient(160deg, #fef3c7 0%, #fde68a 40%, #d6d3d1 100%)' }
    ];

    const read = () => { try { return JSON.parse(localStorage.getItem(KEY)) || {}; } catch (e) { return {}; } };
    const write = all => { try { localStorage.setItem(KEY, JSON.stringify(all)); } catch (e) {} };
    const urls = new Map(); // chat key -> object URL for a custom photo

    function choiceFor(key) {
        const all = read();
        return all[key] || all['*'] || null;
    }

    async function photoURL(key) {
        if (urls.has(key)) return urls.get(key);
        const blob = await Media.get(PHOTO(key));
        if (!blob) return null;
        const u = URL.createObjectURL(blob);
        urls.set(key, u);
        return u;
    }

    // Paint a chat's thread element with its wallpaper (or clear it)
    async function apply(el, key) {
        if (!el) return;
        const choice = choiceFor(key);
        const all = read();
        const source = all[key] ? key : '*';
        el.classList.remove('has-wallpaper', 'wp-dark', 'wp-light');
        el.style.removeProperty('--wp');
        el.style.removeProperty('--wp-dim');
        if (!choice) return;
        let css = null;
        let dark = false;
        if (choice.id === 'photo') {
            const u = await photoURL(source);
            if (!u) return;
            css = `url("${u}") center / cover no-repeat`;
            dark = true; // photos get a gentle dim so bubbles stay readable
        } else {
            const p = PRESETS.find(x => x.id === choice.id);
            if (!p) return;
            css = p.css;
            dark = !!p.dark;
        }
        el.style.setProperty('--wp', css);
        el.style.setProperty('--wp-dim', String(choice.dim ?? (choice.id === 'photo' ? 0.25 : 0)));
        el.classList.add('has-wallpaper', dark ? 'wp-dark' : 'wp-light');
    }

    // ---------- Picker ----------
    let dialog = null;
    let current = null; // { key, label, onDone }

    function build() {
        dialog = document.createElement('dialog');
        dialog.className = 'wp-picker';
        dialog.id = 'wp-picker';
        dialog.setAttribute('aria-labelledby', 'wp-title');
        dialog.innerHTML = `
            <div class="wp-sheet">
                <header class="wp-head">
                    <h3 id="wp-title">Chat wallpaper</h3>
                    <button type="button" class="icon-btn" data-wp="close" aria-label="Close"><svg class="i"><use href="#i-close"/></svg></button>
                </header>
                <div class="wp-preview" id="wp-preview" aria-hidden="true">
                    <span class="wp-b in">Hey! Are we still on for Sunday? 😊</span>
                    <span class="wp-b out">Yes — see you at 4!</span>
                </div>
                <button type="button" class="wp-photo" data-wp="photo"><svg class="i"><use href="#i-image"/></svg><span><strong>Choose from your photos</strong><small>Any picture from your library</small></span></button>
                <p class="wp-label">Recommended</p>
                <div class="wp-grid" role="radiogroup" aria-label="Recommended wallpapers">
                    <button type="button" class="wp-tile none" role="radio" data-wp="none" aria-label="No wallpaper"><span>None</span></button>
                    ${PRESETS.map(p => `<button type="button" class="wp-tile" role="radio" data-wp="preset" data-id="${p.id}" aria-label="${p.name}" style="--wp:${p.css}"><span>${p.name}</span></button>`).join('')}
                </div>
                <label class="wp-dim-row">
                    <span>Dim</span>
                    <input type="range" id="wp-dim" min="0" max="0.7" step="0.05" aria-label="Dim the wallpaper">
                </label>
                <label class="wp-all"><span class="share-toggle"><input type="checkbox" id="wp-all"><span class="switch" aria-hidden="true"></span></span><span>Use for all my chats</span></label>
                <div class="wp-actions">
                    <button type="button" class="ghost-btn" data-wp="close">Cancel</button>
                    <button type="button" class="primary-btn" data-wp="save">Set wallpaper</button>
                </div>
            </div>`;
        document.body.append(dialog);
        dialog.addEventListener('click', onClick);
        dialog.addEventListener('cancel', e => { e.preventDefault(); close(); });
        dialog.querySelector('#wp-dim').addEventListener('input', e => {
            if (!current.pick) return;
            current.pick.dim = Number(e.target.value);
            preview();
        });
    }

    let draftPhoto = null; // a newly picked photo, not saved until "Set wallpaper"

    async function preview() {
        const box = dialog.querySelector('#wp-preview');
        const pick = current.pick;
        dialog.querySelectorAll('.wp-tile').forEach(t => t.setAttribute('aria-checked', String(
            (pick === null && t.dataset.wp === 'none') || (pick && pick.id === t.dataset.id))));
        dialog.querySelector('.wp-photo').classList.toggle('on', !!pick && pick.id === 'photo');
        box.classList.remove('has-wallpaper', 'wp-dark', 'wp-light');
        box.style.removeProperty('--wp');
        dialog.querySelector('.wp-dim-row').hidden = !pick;
        if (!pick) return;
        let css;
        let dark = true;
        if (pick.id === 'photo') {
            const u = draftPhoto ? draftPhoto.url : await photoURL(current.key);
            if (!u) return;
            css = `url("${u}") center / cover no-repeat`;
        } else {
            const p = PRESETS.find(x => x.id === pick.id);
            css = p.css;
            dark = !!p.dark;
        }
        box.style.setProperty('--wp', css);
        box.style.setProperty('--wp-dim', String(pick.dim || 0));
        box.classList.add('has-wallpaper', dark ? 'wp-dark' : 'wp-light');
        dialog.querySelector('#wp-dim').value = String(pick.dim || 0);
    }

    async function onClick(e) {
        if (e.target === dialog) return close();
        const b = e.target.closest('[data-wp]');
        if (!b) return;
        const what = b.dataset.wp;
        if (what === 'close') return close();
        if (what === 'none') { current.pick = null; return preview(); }
        if (what === 'preset') { current.pick = { id: b.dataset.id, dim: 0 }; return preview(); }
        if (what === 'photo') {
            const [file] = await Media.pickFiles('image/*', false);
            if (!file) return;
            const img = await Media.compressImage(file);
            if (draftPhoto) URL.revokeObjectURL(draftPhoto.url);
            draftPhoto = { blob: img, url: URL.createObjectURL(img) };
            current.pick = { id: 'photo', dim: 0.25 };
            return preview();
        }
        if (what === 'save') {
            const all = read();
            const target = dialog.querySelector('#wp-all').checked ? '*' : current.key;
            if (current.pick && current.pick.id === 'photo') {
                if (draftPhoto) {
                    await Media.put(PHOTO(target), draftPhoto.blob);
                    if (urls.has(target)) { URL.revokeObjectURL(urls.get(target)); urls.delete(target); }
                } else if (target !== current.key) {
                    const existing = await Media.get(PHOTO(current.key));
                    if (existing) await Media.put(PHOTO(target), existing);
                    urls.delete(target);
                }
            }
            if (current.pick) all[target] = current.pick;
            else delete all[target];
            if (target === '*' ) delete all[current.key]; // "all chats" wins for this chat too
            write(all);
            const done = current.onDone;
            close();
            if (window.diaryApp) window.diaryApp.showToast(current && !current.pick ? 'Wallpaper removed' : target === '*' ? 'Wallpaper set for all your chats' : 'Wallpaper set');
            if (done) done();
        }
    }

    function close() {
        if (draftPhoto) { URL.revokeObjectURL(draftPhoto.url); draftPhoto = null; }
        if (dialog && dialog.open) dialog.close();
    }

    function open(key, { label = '', onDone = null } = {}) {
        if (!dialog) build();
        const all = read();
        current = { key, label, onDone, pick: all[key] ? { ...all[key] } : all['*'] ? { ...all['*'] } : null };
        dialog.querySelector('#wp-title').textContent = label ? `Wallpaper · ${label}` : 'Chat wallpaper';
        dialog.querySelector('#wp-all').checked = !all[key] && !!all['*'];
        dialog.showModal();
        preview();
    }

    window.ChatWallpaper = { open, apply, presets: PRESETS.map(p => ({ id: p.id, name: p.name })) };
})();
