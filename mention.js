// Tag people: type @ in a post, comment or reply and pick someone from the list (friends first, then anyone
// on Cordial by username). Tagged names in posts and comments open that person's profile. The server tells
// whoever was tagged, if they can see the post (see the diary_tagging migration).
document.addEventListener('DOMContentLoaded', () => {
    const app = window.diaryApp;
    const social = window.diarySocial;
    if (!app || !social || !social.internals) return;
    const I = social.internals;
    const { client, state: s, esc, avatar } = I;
    const FIELDS = '#feed-text, #pv-input, form[data-form="comment"] input[name="body"], form.igc-inline input, form[data-form="cm-post"] textarea';
    const ids = new Map(); // username -> id, learned as we go

    const pop = document.createElement('div');
    pop.className = 'mention-pop';
    pop.setAttribute('role', 'listbox');
    pop.hidden = true;
    document.body.append(pop);
    const M = { field: null, items: [], index: 0, token: 0 };

    function close() { pop.hidden = true; M.field = null; M.items = []; }
    const typedAt = field => {
        const before = field.value.slice(0, field.selectionStart || 0);
        const m = before.match(/(?:^|[\s(])@([a-z0-9_]{0,20})$/i);
        return m ? m[1].toLowerCase() : null;
    };

    function people() {
        const seen = new Set();
        const out = [];
        const add = (p, friend) => {
            if (!p || !p.username || seen.has(p.username) || (s.profile && p.id === s.profile.id)) return;
            seen.add(p.username);
            ids.set(p.username, p.id);
            out.push({ ...p, friend });
        };
        (s.friends || []).forEach(f => add(f, true));
        (s.suggestions || []).forEach(p => add(p, false));
        return out;
    }

    async function suggest(field) {
        const q = typedAt(field);
        if (q === null || (social.isGuest && social.isGuest())) return close();
        M.field = field;
        const local = people().filter(p => !q || p.username.startsWith(q) || String(p.display_name || '').toLowerCase().split(/\s+/).some(w => w.startsWith(q)));
        M.items = local.slice(0, 6);
        M.index = 0;
        paint();
        // Anyone on Cordial, by username
        if (q.length >= 2 && M.items.length < 6) {
            const token = ++M.token;
            const { data } = await client.from('diary_profiles').select('id, username, display_name, avatar_path').ilike('username', `${q}%`).limit(8);
            if (token !== M.token || M.field !== field) return;
            const have = new Set(M.items.map(p => p.username));
            (data || []).forEach(p => { ids.set(p.username, p.id); if (!have.has(p.username) && (!s.profile || p.id !== s.profile.id) && M.items.length < 6) M.items.push({ ...p, friend: false }); });
            paint();
        }
    }

    function paint() {
        if (!M.field || !M.items.length) { pop.hidden = true; return; }
        pop.innerHTML = M.items.map((p, i) => `
            <button type="button" class="mention-opt${i === M.index ? ' on' : ''}" role="option" aria-selected="${i === M.index}" data-i="${i}">
                ${avatar(p, 'xs')}<span><strong>${esc(p.display_name || p.username)}</strong><small>@${esc(p.username)}${p.friend ? ' · Friend' : ''}</small></span>
            </button>`).join('');
        const r = M.field.getBoundingClientRect();
        const vv = window.visualViewport;
        const bottom = vv ? vv.height + vv.offsetTop : innerHeight;
        pop.hidden = false;
        const h = pop.offsetHeight;
        const below = r.bottom + 6 + h < bottom - 8;
        pop.style.left = `${Math.max(8, Math.min(r.left, innerWidth - pop.offsetWidth - 8))}px`;
        pop.style.top = `${below ? r.bottom + 6 : Math.max(8, r.top - h - 6)}px`;
        pop.style.width = `${Math.min(Math.max(r.width, 260), innerWidth - 16)}px`;
    }

    function choose(i) {
        const p = M.items[i];
        const field = M.field;
        if (!p || !field) return;
        const pos = field.selectionStart || 0;
        const before = field.value.slice(0, pos).replace(/@([a-z0-9_]{0,20})$/i, `@${p.username} `);
        field.value = before + field.value.slice(pos);
        field.setSelectionRange(before.length, before.length);
        close();
        field.dispatchEvent(new Event('input', { bubbles: true }));
        field.focus();
    }

    document.addEventListener('input', e => { if (e.target.matches && e.target.matches(FIELDS)) suggest(e.target); });
    document.addEventListener('keydown', e => {
        if (pop.hidden || e.target !== M.field) return;
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault();
            M.index = (M.index + (e.key === 'ArrowDown' ? 1 : -1) + M.items.length) % M.items.length;
            paint();
        } else if (e.key === 'Enter' || e.key === 'Tab') {
            e.preventDefault();
            e.stopPropagation();
            choose(M.index);
        } else if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            close();
        }
    }, true);
    pop.addEventListener('pointerdown', e => e.preventDefault()); // keep the keyboard up
    pop.addEventListener('click', e => { const b = e.target.closest('[data-i]'); if (b) choose(Number(b.dataset.i)); });
    document.addEventListener('focusout', e => { if (e.target === M.field) setTimeout(() => { if (document.activeElement !== M.field) close(); }, 150); });
    window.addEventListener('resize', () => { if (!pop.hidden) paint(); });
    document.addEventListener('scroll', () => { if (!pop.hidden) paint(); }, true);

    // Tapping a tagged @name opens that person's profile
    document.addEventListener('click', async e => {
        const b = e.target.closest('[data-mention]');
        if (!b) return;
        e.preventDefault();
        e.stopPropagation();
        const name = b.dataset.mention.toLowerCase();
        let id = ids.get(name) || ((s.friends || []).find(f => f.username === name) || {}).id;
        if (!id && s.profile && s.profile.username === name) id = s.profile.id;
        if (!id) {
            const { data } = await client.from('diary_profiles').select('id').eq('username', name).maybeSingle();
            id = data && data.id;
            if (id) ids.set(name, id);
        }
        if (!id) return app.showToast(`No one on Cordial is called @${name}`);
        const dlg = b.closest('dialog[open]');
        if (dlg && !dlg.matches('#post-view') && dlg.close) dlg.close();
        if (window.diaryProfile) window.diaryProfile.open(id);
    }, true);
});
