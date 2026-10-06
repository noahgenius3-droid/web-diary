// Stickers for chats (one-to-one and groups). Built-in packs, drawn on the device: nothing to download or upload.
// A sticker is sent as a tiny attachment, { kind: 'sticker', pack, id }, and drawn by whoever views it.
window.CordialStickers = (() => {
    const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    // Captioned stickers: [id, emoji, caption, pill colour, caption colour]
    const PACKS = [
        { id: 'say', name: 'Say it', icon: '💬', items: [
            ['hi', '👋', 'Hi!', '#fde68a', '#78350f'], ['morning', '☀️', 'Good morning', '#fed7aa', '#7c2d12'], ['night', '🌙', 'Good night', '#c7d2fe', '#1e1b4b'],
            ['thanks', '🙏', 'Thank you', '#bbf7d0', '#14532d'], ['lol', '😂', 'LOL', '#fef08a', '#713f12'], ['love', '❤️', 'Love you', '#fecdd3', '#881337'],
            ['congrats', '🎉', 'Congrats!', '#e9d5ff', '#581c87'], ['hugs', '🤗', 'Hugs', '#fbcfe8', '#831843'], ['onit', '👍', 'On it!', '#bae6fd', '#0c4a6e'],
            ['omw', '🏃', 'On my way', '#a7f3d0', '#064e3b'], ['tired', '😴', 'So tired', '#ddd6fe', '#3b0764'], ['yay', '🥳', 'Yay!', '#fde68a', '#78350f'],
            ['missyou', '🥺', 'Miss you', '#fecaca', '#7f1d1d'], ['hmm', '🤔', 'Hmm…', '#e5e7eb', '#111827'], ['seen', '👀', 'Seen', '#e0e7ff', '#312e81'],
            ['coffee', '☕', 'Coffee?', '#fed7aa', '#431407'], ['bday', '🎂', 'Happy birthday', '#fbcfe8', '#831843'], ['fire', '🔥', 'Fire!', '#fdba74', '#7c2d12'],
            ['facts', '💯', 'Facts', '#fecaca', '#7f1d1d'], ['brb', '⏳', 'BRB', '#cffafe', '#164e63'], ['sorry', '😔', 'Sorry', '#e2e8f0', '#0f172a'],
            ['wow', '😮', 'Wow!', '#fef3c7', '#78350f'], ['callme', '📞', 'Call me', '#bbf7d0', '#14532d'], ['proud', '🥹', 'So proud', '#e9d5ff', '#581c87']
        ] },
        { id: 'faith', name: 'Faith', icon: '🙏', items: [
            ['amen', '🙌', 'Amen!', '#fde68a', '#78350f'], ['godgood', '✨', 'God is good', '#e9d5ff', '#581c87'], ['praying', '🤲', 'Praying for you', '#bae6fd', '#0c4a6e'],
            ['blessed', '🌸', 'Blessed', '#fbcfe8', '#831843'], ['peace', '🕊️', 'Peace be with you', '#e0f2fe', '#0c4a6e'], ['halle', '🎶', 'Hallelujah', '#fef08a', '#713f12'],
            ['church', '⛪', 'See you at church', '#c7d2fe', '#1e1b4b'], ['word', '📖', 'Read the Word', '#bbf7d0', '#14532d'], ['grace', '💛', 'Grace', '#fef3c7', '#78350f'],
            ['thankgod', '🙏', 'Thank God', '#a7f3d0', '#064e3b'], ['faithful', '🌅', 'He is faithful', '#fed7aa', '#7c2d12'], ['joy', '😇', 'Joy!', '#fde68a', '#78350f']
        ] },
        { id: 'big', name: 'Big emoji', icon: '😀', items: [
            ['grin', '😀'], ['joy', '😂'], ['hold', '🥹'], ['heart', '😍'], ['kiss', '😘'], ['cool', '😎'], ['star', '🤩'], ['party', '🥳'],
            ['sob', '😭'], ['angry', '😡'], ['mind', '🤯'], ['pray', '🙏'], ['up', '👍'], ['clap', '👏'], ['fire', '🔥'], ['redheart', '❤️'],
            ['broken', '💔'], ['sparkles', '✨'], ['tada', '🎉'], ['hundred', '💯'], ['eyes', '👀'], ['skull', '💀'], ['wave', '👋'], ['muscle', '💪']
        ] }
    ];
    const find = (pack, id) => { const p = PACKS.find(x => x.id === pack); const it = p && p.items.find(x => x[0] === id); return it ? { pack: p, it } : null; };

    // The sticker itself: a big emoji, and (for captioned ones) a tilted, die-cut caption pill underneath
    function svg(pack, id) {
        const hit = find(pack, id);
        if (!hit) return '';
        const [, emoji, caption, bg, fg] = hit.it;
        if (!caption) return `<svg viewBox="0 0 160 160" aria-hidden="true"><text x="80" y="84" font-size="118" text-anchor="middle" dominant-baseline="central">${emoji}</text></svg>`;
        const size = caption.length > 13 ? 15 : caption.length > 9 ? 18 : 21;
        const w = Math.min(152, 26 + caption.length * size * 0.56);
        return `<svg viewBox="0 0 160 160" aria-hidden="true">
            <text x="80" y="62" font-size="86" text-anchor="middle" dominant-baseline="central">${emoji}</text>
            <g transform="rotate(-5 80 128)">
                <rect x="${80 - w / 2}" y="110" width="${w}" height="36" rx="18" fill="${bg}" stroke="#fff" stroke-width="5"/>
                <text x="80" y="129" font-size="${size}" font-weight="800" font-family="system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif" fill="${fg}" text-anchor="middle" dominant-baseline="central">${esc(caption)}</text>
            </g>
        </svg>`;
    }
    const label = a => { const hit = a && find(a.pack, a.id); return hit ? `${hit.it[1]} ${hit.it[2] || ''}`.trim() : 'Sticker'; };
    // In a message
    function html(a) {
        const drawn = a && svg(a.pack, a.id);
        if (!drawn) return '<p class="sticker-missing">🎨 Sticker</p>';
        return `<span class="sticker" role="img" aria-label="Sticker: ${esc(label(a))}">${drawn}</span>`;
    }
    const preview = a => `🎨 ${label(a)}`;
    const isSticker = a => !!(a && a.kind === 'sticker');

    // ---------- The picker: Recent + one tab per pack; tap a sticker to send it ----------
    const RECENT_KEY = 'cordialStickersRecent';
    const recent = () => { try { return (JSON.parse(localStorage.getItem(RECENT_KEY)) || []).filter(r => find(r.pack, r.id)).slice(0, 16); } catch (e) { return []; } };
    const remember = a => { try { localStorage.setItem(RECENT_KEY, JSON.stringify([{ pack: a.pack, id: a.id }, ...recent().filter(r => !(r.pack === a.pack && r.id === a.id))].slice(0, 16))); } catch (e) { /* private mode */ } };
    let panel = null, tab = null;
    function close() {
        if (!panel) return;
        const p = panel; panel = null;
        p.classList.add('closing');
        setTimeout(() => p.remove(), 140);
        document.removeEventListener('pointerdown', outside, true);
        document.removeEventListener('keydown', onKey, true);
    }
    function outside(e) { if (panel && !panel.contains(e.target) && !e.target.closest('[data-sticker-toggle]')) close(); }
    function onKey(e) { if (e.key === 'Escape' && panel) { e.stopPropagation(); close(); } }
    function grid(which) {
        const items = which === 'recent' ? recent().map(r => [r.pack, r.id]) : (PACKS.find(p => p.id === which) || PACKS[0]).items.map(it => [which, it[0]]);
        if (!items.length) return '<p class="stk-empty">Stickers you send show up here.</p>';
        return items.map(([pk, id]) => { const hit = find(pk, id); return `<button type="button" class="stk-item" data-stk-pack="${pk}" data-stk-id="${id}" aria-label="${esc(`${hit.it[1]} ${hit.it[2] || ''}`.trim())}">${svg(pk, id)}</button>`; }).join('');
    }
    function paint() {
        panel.querySelectorAll('[data-stk-tab]').forEach(b => b.setAttribute('aria-selected', String(b.dataset.stkTab === tab)));
        const g = panel.querySelector('.stk-grid');
        g.innerHTML = grid(tab);
        g.scrollTop = 0;
    }
    // Opens above the composer that contains the button (toggles if it's already open)
    function toggle(button, onPick) {
        if (panel) { close(); return; }
        const host = button.closest('form') || button.parentElement;
        tab = recent().length ? 'recent' : PACKS[0].id;
        panel = document.createElement('div');
        panel.className = 'stk-panel';
        panel.setAttribute('role', 'dialog');
        panel.setAttribute('aria-label', 'Stickers');
        panel.innerHTML = `<div class="stk-tabs" role="tablist">
                <button type="button" role="tab" data-stk-tab="recent" aria-label="Recent">🕘</button>
                ${PACKS.map(p => `<button type="button" role="tab" data-stk-tab="${p.id}" aria-label="${esc(p.name)}" title="${esc(p.name)}">${p.icon}</button>`).join('')}
            </div>
            <div class="stk-grid"></div>`;
        host.append(panel);
        paint();
        panel.addEventListener('click', e => {
            const t = e.target.closest('[data-stk-tab]');
            if (t) { tab = t.dataset.stkTab; return paint(); }
            const b = e.target.closest('[data-stk-pack]');
            if (!b) return;
            const att = { kind: 'sticker', pack: b.dataset.stkPack, id: b.dataset.stkId };
            remember(att);
            close();
            onPick(att);
        });
        setTimeout(() => { document.addEventListener('pointerdown', outside, true); document.addEventListener('keydown', onKey, true); }, 0);
    }
    return { PACKS, svg, html, preview, isSticker, toggle, close };
})();
