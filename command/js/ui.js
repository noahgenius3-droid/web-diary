// Shared UI pieces: escaping, formatting, icons, avatars, state blocks, toasts, modals with typed confirmation,
// and small SVG charts. Views compose these; nothing here knows about data.

/** @param {unknown} v */
export const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

// ---------- Icons (24px grid, stroked) ----------
const P = {
    home: 'M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6h-6v6H4a1 1 0 0 1-1-1z',
    users: 'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75',
    user: 'M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8',
    shield: 'M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z',
    flag: 'M4 22V4M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1',
    life: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20M12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8M4.93 4.93l4.24 4.24M14.83 14.83l4.24 4.24M14.83 9.17l4.24-4.24M4.93 19.07l4.24-4.24',
    gift: 'M20 12v10H4V12M2 7h20v5H2zM12 22V7M12 7H7.5a2.5 2.5 0 0 1 0-5C11 2 12 7 12 7zM12 7h4.5a2.5 2.5 0 0 0 0-5C13 2 12 7 12 7z',
    chart: 'M3 3v18h18M7 16v-5M12 16V8M17 16v-9',
    list: 'M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01',
    bell: 'M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9M13.73 21a2 2 0 0 1-3.46 0',
    settings: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z',
    search: 'M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16M21 21l-4.35-4.35',
    x: 'M18 6 6 18M6 6l12 12',
    check: 'M20 6 9 17l-5-5',
    pause: 'M10 15V9M14 15V9M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20',
    ban: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20M4.93 4.93l14.14 14.14',
    power: 'M18.36 6.64a9 9 0 1 1-12.73 0M12 2v10',
    undo: 'M3 7v6h6M3 13a9 9 0 1 0 3-7.7L3 8',
    mail: 'M4 4h16a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2zM22 6l-10 7L2 6',
    activity: 'M22 12h-4l-3 9L9 3l-3 9H2',
    chevR: 'M9 18l6-6-6-6',
    chevL: 'M15 18l-6-6 6-6',
    chevD: 'M6 9l6 6 6-6',
    menu: 'M3 12h18M3 6h18M3 18h18',
    sun: 'M12 17a5 5 0 1 0 0-10 5 5 0 0 0 0 10M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42',
    moon: 'M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z',
    out: 'M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9',
    post: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6M16 13H8M16 17H8',
    reel: 'M23 7l-7 5 7 5V7zM1 5h15v14H1z',
    chat: 'M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z',
    star: 'M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z',
    alert: 'M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0zM12 9v4M12 17h.01',
    lock: 'M19 11H5a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7a2 2 0 0 0-2-2zM7 11V7a5 5 0 0 1 10 0v4',
    ext: 'M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6M15 3h6v6M10 14 21 3',
    copy: 'M20 9h-9a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h9a2 2 0 0 0 2-2v-9a2 2 0 0 0-2-2zM5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1',
    note: 'M12 20h9M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z',
    send: 'M22 2 11 13M22 2l-7 20-4-9-9-4z',
    megaphone: 'M3 11v2a1 1 0 0 0 1 1h2l5 4V6L6 10H4a1 1 0 0 0-1 1zM15.5 8.5a5 5 0 0 1 0 7M18.5 5.5a9 9 0 0 1 0 13',
    download: 'M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3',
    columns: 'M12 3v18M3 3h18v18H3z',
    tag: 'M20.59 13.41 13.42 20.58a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82zM7 7h.01',
    clock: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20M12 6v6l4 2',
    filter: 'M22 3H2l8 9.46V19l4 2v-8.54z',
    refresh: 'M23 4v6h-6M1 20v-6h6M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15'
};
export const ic = (name, cls = '') => `<svg class="i${cls ? ` ${cls}` : ''}" viewBox="0 0 24 24" aria-hidden="true"><path d="${P[name] || P.x}"/></svg>`;

// ---------- Formatting ----------
const nf = new Intl.NumberFormat();
export const num = n => (n === null || n === undefined || n === '' ? '—' : nf.format(Number(n)));
export const compact = n => (n === null || n === undefined ? '—' : new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 }).format(Number(n)));
export function ago(iso) {
    if (!iso) return '—';
    const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
    if (s < 45) return s < 0 ? 'in the future' : 'just now';
    const units = [['year', 31536000], ['month', 2592000], ['week', 604800], ['day', 86400], ['hour', 3600], ['minute', 60]];
    const [u, size] = units.find(([, x]) => s >= x);
    return new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' }).format(-Math.floor(s / size), u);
}
export function until(iso) {
    if (!iso) return 'until lifted';
    const s = Math.round((new Date(iso).getTime() - Date.now()) / 1000);
    if (s <= 0) return 'ended';
    const units = [['day', 86400], ['hour', 3600], ['minute', 60]];
    const [u, size] = units.find(([, x]) => s >= x) || ['minute', 60];
    return new Intl.RelativeTimeFormat(undefined, { numeric: 'always' }).format(Math.max(1, Math.round(s / size)), u);
}
export const date = iso => (iso ? new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : '—');
export const dateTime = iso => (iso ? new Date(iso).toLocaleString(undefined, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—');
export const shortId = id => String(id || '').replace(/-/g, '').slice(0, 8).toUpperCase();
export const timeTag = iso => `<time datetime="${esc(iso || '')}" title="${esc(dateTime(iso))}">${esc(ago(iso))}</time>`;

// ---------- People ----------
const cfg = window.DIARY_CONFIG || {};
export const avatarSrc = path => (path ? `${cfg.supabaseUrl}/storage/v1/object/public/diary-avatars/${String(path).split('/').map(encodeURIComponent).join('/')}` : '');
const initials = name => String(name || '?').trim().split(/\s+/).slice(0, 2).map(w => w[0]).join('').toUpperCase() || '?';
export function avatar(p, size = '') {
    const name = (p && (p.display_name || p.username)) || '?';
    const src = p && p.avatar_path ? avatarSrc(p.avatar_path) : '';
    return `<span class="av${size ? ` ${size}` : ''}" aria-hidden="true">${src ? `<img src="${esc(src)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : esc(initials(name))}</span>`;
}
export const tick = verified => (verified ? `<span class="tick" title="Verified: ${esc(verified)}">${ic('check')}</span>` : '');
export function who(p, { sub = null, link = true, size = '' } = {}) {
    if (!p) return '<span class="muted">—</span>';
    const inner = `${avatar(p, size)}<span><strong>${esc(p.display_name || 'Unknown')}${tick(p.verified)}</strong><small>${sub !== null ? sub : `@${esc(p.username || '')}`}</small></span>`;
    return link && p.id ? `<a class="who" href="#/user/${esc(p.id)}" style="color:inherit;text-decoration:none">${inner}</a>` : `<span class="who">${inner}</span>`;
}

// ---------- States ----------
export const loadingRows = (n = 5) => `<div class="skel-rows" aria-busy="true" aria-label="Loading">${Array.from({ length: n }, (_, i) => `<span class="skel" style="width:${92 - (i % 3) * 14}%"></span>`).join('')}</div>`;
export const empty = (title, text = '', action = '') => `<div class="state"><strong>${esc(title)}</strong>${text ? `<p>${esc(text)}</p>` : ''}${action}</div>`;
export const failed = (err, retry = 'retry') => `<div class="state err" role="alert"><strong>Couldn’t load this</strong><p>${esc(err && err.message ? err.message : String(err || 'Something went wrong'))}</p>${retry ? `<button class="btn sm" data-act="${retry}">${ic('refresh')}Try again</button>` : ''}</div>`;
export const needsUpgrade = (what = 'This') => `<div class="upgrade" role="note"><strong>${ic('lock')} ${esc(what)} needs the Command Center database update</strong>
    <p>Run <code>supabase/migrations/20261002070000_diary_command_center.sql</code> in the Supabase SQL editor (or approve it from Claude Code). It adds the account-status model, rewards, the helpline, appeals, alerts and the full audit trail. Everything here switches on automatically once it’s there.</p></div>`;

// ---------- Toasts ----------
export function toast(text, { error = false, ms = 3800 } = {}) {
    const box = document.getElementById('toasts');
    const t = document.createElement('div');
    t.className = `toast${error ? ' err' : ''}`;
    t.setAttribute('role', error ? 'alert' : 'status');
    t.innerHTML = `${ic(error ? 'alert' : 'check')}<span>${esc(text)}</span>`;
    box.append(t);
    setTimeout(() => t.remove(), ms);
}

// ---------- Modals ----------
// open({ title, text, icon, tone, body, confirm, confirmTone, cancel, typed, onSubmit(form) }) → resolves true when done
export function modal({ title, text = '', icon = 'shield', tone = '', body = '', confirm = 'Confirm', confirmTone = 'primary', cancel = 'Cancel', typed = '', wide = false, onSubmit, onInput }) {
    return new Promise(resolve => {
        const dlg = document.createElement('dialog');
        dlg.className = 'modal';
        if (wide) dlg.style.width = 'min(760px, calc(100vw - 32px))';
        dlg.setAttribute('aria-labelledby', 'm-title');
        dlg.innerHTML = `
            <form method="dialog" novalidate>
                <header class="modal-h">
                    <span class="modal-ic ${tone}">${ic(icon)}</span>
                    <div><h2 id="m-title">${esc(title)}</h2>${text ? `<p>${text}</p>` : ''}</div>
                </header>
                <div class="modal-b">
                    ${body}
                    ${typed ? `<label class="field"><span>Type <b>${esc(typed)}</b> to confirm</span><input class="input" name="__typed" autocomplete="off" spellcheck="false" aria-describedby="m-err"></label>` : ''}
                    <p class="form-err" id="m-err" role="alert" hidden></p>
                </div>
                <footer class="modal-f">
                    <button type="button" class="btn" value="cancel" data-m="cancel">${esc(cancel)}</button>
                    <button type="submit" class="btn ${confirmTone}" data-m="ok"${typed ? ' disabled' : ''}>${esc(confirm)}</button>
                </footer>
            </form>`;
        document.body.append(dlg);
        const form = dlg.querySelector('form');
        const ok = dlg.querySelector('[data-m="ok"]');
        const err = dlg.querySelector('#m-err');
        const showErr = m => { err.textContent = m; err.hidden = !m; };
        const check = () => {
            if (typed) ok.disabled = form.elements.__typed.value.trim() !== typed;
            if (onInput) onInput(form, { ok, showErr });
        };
        form.addEventListener('input', check);
        form.addEventListener('change', check);
        dlg.querySelector('[data-m="cancel"]').addEventListener('click', () => dlg.close());
        let done = false;
        form.addEventListener('submit', async e => {
            e.preventDefault();
            if (ok.disabled) return;
            showErr('');
            ok.disabled = true;
            const label = ok.textContent;
            ok.innerHTML = `<span class="spin" aria-hidden="true"></span>${esc(label)}`;
            try {
                const res = onSubmit ? await onSubmit(form) : true;
                if (res === false) { ok.disabled = false; ok.textContent = label; return; }
                done = true;
                dlg.close();
            } catch (error) {
                showErr(friendly(error));
                ok.disabled = false;
                ok.textContent = label;
            }
        });
        dlg.addEventListener('close', () => { dlg.remove(); resolve(done); });
        dlg.showModal();
        check();
        const first = dlg.querySelector('.modal-b input:not([type=hidden]), .modal-b select, .modal-b textarea');
        if (first) first.focus();
    });
}
export function friendly(error) {
    const m = (error && (error.message || error.error_description)) || String(error || 'Something went wrong');
    if (/permission|42501/i.test(m)) return 'You don’t have permission for that action.';
    if (/JWT|session/i.test(m)) return 'Your session has expired — sign in again.';
    return m.replace(/^LARGE_REWARD:\s*/, '');
}

// ---------- Charts (single hue; value labels on hover; never decorative) ----------
export function bars(series, key, { alt = null, height = 160, label = '' } = {}) {
    if (!series || !series.length) return '<p class="muted">No data yet.</p>';
    const W = 640, H = height, pad = { l: 28, r: 6, t: 8, b: 20 };
    const vals = series.map(d => Number(d[key]) || 0);
    const alts = alt ? series.map(d => Number(d[alt]) || 0) : [];
    const max = Math.max(1, ...vals, ...alts);
    const step = (W - pad.l - pad.r) / series.length;
    const bw = Math.max(2, step * (alt ? 0.38 : 0.62));
    const y = v => pad.t + (H - pad.t - pad.b) * (1 - v / max);
    const ticks = [0, Math.ceil(max / 2), max];
    const day = d => new Date(d.day).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
    return `<svg class="chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="${esc(label)}">
        ${ticks.map(t => `<line class="grid" x1="${pad.l}" x2="${W - pad.r}" y1="${y(t)}" y2="${y(t)}"/><text x="${pad.l - 6}" y="${y(t) + 3}" text-anchor="end">${compact(t)}</text>`).join('')}
        ${series.map((d, i) => {
            const x = pad.l + i * step + (step - bw * (alt ? 2.1 : 1)) / 2;
            const v = vals[i];
            const a = alt ? alts[i] : null;
            return `<g><title>${esc(day(d))}: ${num(v)}${alt ? ` / ${num(a)}` : ''}</title>
                <rect class="bar" x="${x}" y="${y(v)}" width="${bw}" height="${Math.max(0, H - pad.b - y(v))}" rx="2"/>
                ${alt ? `<rect class="bar alt" x="${x + bw * 1.1}" y="${y(a)}" width="${bw}" height="${Math.max(0, H - pad.b - y(a))}" rx="2"/>` : ''}
                ${i % Math.ceil(series.length / 6) === 0 ? `<text x="${pad.l + i * step + step / 2}" y="${H - 6}" text-anchor="middle">${esc(day(d))}</text>` : ''}</g>`;
        }).join('')}
    </svg>`;
}

// Debounce for search boxes
export const debounce = (fn, ms = 250) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
