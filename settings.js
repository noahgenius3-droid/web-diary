// Settings: account, appearance, notifications, privacy, data.
document.addEventListener('DOMContentLoaded', () => {
    const app = window.diaryApp;
    const social = window.diarySocial;
    const I = social && social.internals;
    const $ = id => document.getElementById(id);
    const root = document.documentElement;
    const esc = app.escapeHTML;

    const read = (k, d) => { try { return localStorage.getItem(k) || d; } catch (e) { return d; } };
    const write = (k, v) => { try { if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch (e) {} };

    const ACCENTS = [
        ['indigo', 'Indigo', '#4f46e5'], ['violet', 'Violet', '#7c3aed'], ['blue', 'Blue', '#2563eb'], ['sky', 'Ocean', '#0e7490'],
        ['teal', 'Teal', '#0f766e'], ['emerald', 'Emerald', '#047857'], ['orange', 'Sunset', '#c2410c'], ['rose', 'Rose', '#e11d48'],
        ['pink', 'Pink', '#db2777'], ['graphite', 'Graphite', '#475569']
    ];
    // App background: [value, label, light swatch, dark swatch]
    const BACKGROUNDS = [
        ['default', 'Default', '#fafafa', '#09090b'], ['paper', 'Paper', '#f7f3ec', '#12100d'], ['mist', 'Mist', '#eef2f7', '#0a0f16'],
        ['sage', 'Sage', '#eef4ef', '#0a100c'], ['blush', 'Blush', '#fbf0f2', '#120b0d'], ['midnight', 'Pure black', '#fafafa', '#000000']
    ];
    const SIZES = [['small', 'Small'], ['default', 'Default'], ['large', 'Large']];

    let storageText = '';
    const F = { loaded: false, loading: false, followers: [], following: [] };
    const PROFILE = 'id, username, display_name, avatar_path';

    // Online status & last seen privacy (kept on the server, so it applies on every device)
    const PRESENCE = [['everyone', 'Everyone'], ['friends', 'Friends'], ['nobody', 'Nobody']];
    const P = { loaded: false, settings: { show_online: 'everyone', show_last_seen: 'everyone', read_receipts: true } };
    async function loadPresencePrivacy() {
        P.loaded = true;
        const { data } = await I.client.from('diary_presence').select('show_online, show_last_seen, read_receipts, status, status_text, status_until, allow_calls, photo_visibility, profile_visibility, stats_visibility, email_search').maybeSingle();
        if (data) {
            if (data.status_until && Date.parse(data.status_until) < Date.now()) Object.assign(data, { status: null, status_text: null });
            P.settings = data;
            if (I.state) I.state.myStatus = data.status;
            if (app.state.view === 'settings') app.requestRender ? app.requestRender('settings') : app.render();
        }
    }
    async function setPresencePrivacy(key, value) {
        const before = { ...P.settings };
        P.settings = { ...P.settings, [key]: value };
        app.render();
        const { error } = await I.client.rpc('diary_set_presence_privacy', { p_online: P.settings.show_online, p_last_seen: P.settings.show_last_seen });
        if (error) {
            P.settings = before;
            app.render();
            return app.showToast('Couldn’t save that — check your connection');
        }
        app.showToast(value === 'nobody' ? 'Hidden from everyone' : value === 'friends' ? 'Only friends can see it' : 'Everyone can see it');
    }

    // ---------- Status, more privacy, security, chat backup ----------
    const STATUSES = [['available', '🟢 Available'], ['busy', '⛔ Busy'], ['meeting', '📅 In a meeting'], ['dnd', '🔕 Do not disturb'], ['away', '🌙 Away']];
    const SEC = { factors: null, devices: null, blocked: null, loading: false };

    async function loadSecurity() {
        if (SEC.loading || !I) return;
        SEC.loading = true;
        const [factors, devices, blocked] = await Promise.all([
            I.client.auth.mfa ? I.client.auth.mfa.listFactors().catch(() => ({ data: null })) : { data: null },
            I.client.from('diary_devices').select('*').order('last_seen', { ascending: false }),
            window.diarySafety ? window.diarySafety.blockedList() : []
        ]);
        SEC.loading = false;
        SEC.factors = factors && factors.data ? (factors.data.totp || []).filter(f => f.status === 'verified') : [];
        SEC.devices = devices.data || [];
        SEC.blocked = blocked || [];
        if (app.state.view === 'settings') app.requestRender('settings');
    }

    async function setStatus(status) {
        let text = null;
        let until = null;
        if (status) {
            const res = await app.ask({ title: STATUSES.find(x => x[0] === status)[1], text: 'Add a short note (optional) — e.g. “Back at 3pm”. It clears itself after 8 hours.', value: P.settings.status === status ? (P.settings.status_text || '') : '', placeholder: 'What are you up to?', ok: 'Set status', allowEmpty: true });
            if (!res) return;
            text = (res.value || '').trim().slice(0, 80) || null;
            until = new Date(Date.now() + 8 * 3600e3).toISOString();
        }
        const { error } = await I.client.rpc('diary_set_status', { p_status: status, p_text: text, p_until: until });
        if (error) return app.showToast('Couldn’t set your status');
        P.settings = { ...P.settings, status, status_text: text, status_until: until };
        if (I.state) I.state.myStatus = status;
        app.showToast(status ? 'Status set' : 'Status cleared');
        app.render();
    }

    // Notification categories you've turned off (the server drops those notifications — and their push alerts)
    const NOTIF_CATS = [
        ['reactions', 'i-thumb', 'Reactions', 'When people react to or repost your posts'],
        ['comments', 'i-chat', 'Comments', 'On your posts, and on posts you follow'],
        ['mentions', 'i-reply', 'Mentions & replies', 'When someone @mentions or replies to you'],
        ['people', 'i-user-plus', 'Friends & followers', 'Friend requests, accepted requests, new followers'],
        ['groups', 'i-users', 'Group activity', 'New posts, people joining, group calls'],
        ['live', 'i-live', 'Live videos', 'When someone you follow goes live'],
        ['scheduled', 'i-clock', 'Scheduled posts', 'When your scheduled posts go out, or can’t'],
        ['market', 'i-store', 'Marketplace', 'Requests and messages about books'],
        ['calls', 'i-phone', 'Missed calls', 'Calls you didn’t answer'],
        ['games', 'i-trophy', 'Trivia & games', 'Where you placed in the daily and weekly challenges']
    ];
    const NP = { muted: null, loading: false };
    async function loadNotifPrefs() {
        if (NP.loading) return;
        NP.loading = true;
        const { data } = await I.client.from('diary_notification_prefs').select('muted').maybeSingle();
        NP.muted = new Set((data && data.muted) || []);
        NP.loading = false;
        if (app.state.view === 'settings') app.render();
    }
    async function setNotifCat(cat, on) {
        if (!NP.muted) return;
        const before = new Set(NP.muted);
        if (on) NP.muted.delete(cat); else NP.muted.add(cat);
        const { error } = await I.client.from('diary_notification_prefs').upsert({ muted: [...NP.muted], updated_at: new Date().toISOString() }, { onConflict: 'user_id' });
        if (error) { NP.muted = before; app.showToast('Couldn’t save that'); }
        else app.showToast(on ? 'Turned on' : 'Turned off — you won’t get these');
        app.render();
    }

    // Verification: a request goes to the Cordial team; the tick appears once approved
    const VER = { loaded: false, request: null };
    const VKIND = { person: 'Public figure', organisation: 'Organisation', minister: 'Minister', educator: 'Educator', administrator: 'Administrator' };
    async function loadVerification() {
        VER.loaded = true;
        const { data } = await I.client.from('diary_verification_requests').select('*').order('created_at', { ascending: false }).limit(1);
        VER.request = (data && data[0]) || null;
        if (app.state.view === 'settings') app.render();
    }
    function verificationRow() {
        if (!VER.loaded) { loadVerification(); return ''; }
        const mine = I.state.verified && I.state.verified.get(I.state.profile.id);
        const r = VER.request;
        const sub = mine ? `Verified as ${VKIND[mine].toLowerCase()} — the tick shows next to your name`
            : r && r.status === 'pending' ? `Request sent ${I.timeAgo(r.created_at)} — we’ll let you know`
            : r && r.status === 'declined' ? `Not approved${r.response ? `: ${r.response}` : ''} — you can ask again`
            : 'For recognised people, organisations, ministers and educators';
        return `<div class="st-row"><span class="st-ic"><svg class="i"><use href="#i-verified"/></svg></span><span class="st-text"><strong>Verification</strong><small>${esc(sub)}</small></span>${mine || (r && r.status === 'pending') ? '' : '<button class="st-btn" data-action="st-verify">Ask to be verified</button>'}</div>`;
    }
    function verifyDialog() {
        const dlg = document.createElement('dialog');
        dlg.className = 'sheet-dialog';
        dlg.innerHTML = `
            <form class="rx-card sched-form" novalidate>
                <header class="rx-head"><h2>Ask to be verified</h2><button type="button" class="icon-btn" data-x="close" aria-label="Close"><svg class="i"><use href="#i-close"/></svg></button></header>
                <div class="sched-scroll">
                    <p class="muted small">Verification shows people that an account really belongs to who it says. The Cordial team checks each request.</p>
                    <label class="field"><span>I am a…</span><select name="kind">${Object.entries(VKIND).map(([k, l]) => `<option value="${k}">${l}</option>`).join('')}</select></label>
                    <label class="field"><span>Tell us who you are</span><textarea name="note" rows="3" maxlength="600" placeholder="e.g. Senior pastor at …, or head teacher at …"></textarea></label>
                    <label class="field"><span>A link that shows it <small class="muted">optional</small></span><input name="link" maxlength="300" placeholder="Website, official page or article"></label>
                </div>
                <footer class="sched-foot"><button type="button" class="ghost-btn" data-x="close">Cancel</button><button type="submit" class="primary-btn">Send request</button></footer>
            </form>`;
        document.body.append(dlg);
        dlg.showModal();
        dlg.addEventListener('close', () => dlg.remove());
        dlg.addEventListener('click', e => { if (e.target === dlg || e.target.closest('[data-x="close"]')) dlg.close(); });
        dlg.addEventListener('submit', async e => {
            e.preventDefault();
            const f = dlg.querySelector('form');
            if (f.note.value.trim().length < 10) return app.showToast('Tell us a little about who you are');
            const { error } = await I.client.from('diary_verification_requests').insert({ kind: f.kind.value, note: f.note.value.trim(), link: f.link.value.trim() });
            if (error) return app.showToast(/duplicate|unique/i.test(error.message) ? 'You already have a request waiting' : 'Couldn’t send your request');
            dlg.close();
            app.showToast('Request sent — we’ll let you know');
            loadVerification();
        });
    }

    async function setPrivacyKey(key, value) {
        const before = P.settings[key];
        P.settings = { ...P.settings, [key]: value };
        app.render();
        const { error } = await I.client.rpc('diary_set_privacy', { p_key: key, p_value: value });
        if (error) { P.settings = { ...P.settings, [key]: before }; app.render(); return app.showToast('Couldn’t save that'); }
        app.showToast('Saved');
    }

    // Two-step verification with an authenticator app (TOTP)
    async function enrollMfa() {
        const mfa = I.client.auth.mfa;
        if (!mfa) return app.showToast('Two-step verification isn’t available here');
        const { data, error } = await mfa.enroll({ factorType: 'totp', friendlyName: `Cordial ${new Date().toLocaleDateString()}` });
        if (error || !data) return app.showToast(error ? error.message : 'Couldn’t start two-step verification');
        const d = mfaDialog();
        d.innerHTML = `
            <form class="ct-card" id="mfa-form">
                <header class="ct-head"><strong>Turn on two-step verification</strong><button type="button" class="icon-btn" data-ct-close aria-label="Close"><svg class="i"><use href="#i-close"/></svg></button></header>
                <p class="muted small">1. Open an authenticator app (Google Authenticator, Microsoft Authenticator, 1Password…) and scan this code.</p>
                <div class="mfa-qr"><img src="${esc(data.totp.qr_code)}" alt="QR code for your authenticator app"></div>
                <p class="muted small">Can’t scan it? Enter this key instead: <code class="mfa-key">${esc(data.totp.secret)}</code></p>
                <label class="mk-field"><span>2. Type the 6-digit code it shows</span><input name="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6" required></label>
                <footer class="ct-foot"><button type="submit" class="primary-btn block">Verify and turn on</button></footer>
            </form>`;
        d.dataset.factor = data.id;
        d.showModal();
        d.querySelector('#mfa-form').onsubmit = async e => {
            e.preventDefault();
            const code = e.currentTarget.code.value.trim();
            const { error: err } = await mfa.challengeAndVerify({ factorId: data.id, code });
            if (err) return app.showToast('That code didn’t match — try the newest one');
            d.dataset.factor = '';
            d.close();
            app.showToast('Two-step verification is on');
            SEC.factors = null;
            loadSecurity();
        };
        d.addEventListener('close', () => {
            if (d.dataset.factor) mfa.unenroll({ factorId: d.dataset.factor }).catch(() => {}); // abandoned half-way
        }, { once: true });
    }

    async function disableMfa() {
        const f = (SEC.factors || [])[0];
        if (!f) return;
        const ok = await app.ask({ title: 'Turn off two-step verification?', text: 'Signing in will only need your password again.', ok: 'Turn off', danger: true });
        if (!ok) return;
        const { error } = await I.client.auth.mfa.unenroll({ factorId: f.id });
        if (error) return app.showToast(error.message || 'Couldn’t turn it off');
        app.showToast('Two-step verification is off');
        SEC.factors = null;
        loadSecurity();
    }

    let mfaDlg = null;
    function mfaDialog() {
        if (!mfaDlg) {
            mfaDlg = document.createElement('dialog');
            mfaDlg.className = 'ct-sheet';
            document.body.append(mfaDlg);
            mfaDlg.addEventListener('click', e => { if (e.target === mfaDlg || e.target.closest('[data-ct-close]')) mfaDlg.close(); });
        }
        return mfaDlg;
    }

    // ---------- Encrypted chat backup ----------
    // Your chats already live safely in your account (they come back on any device you sign in on).
    // This makes an extra copy you keep yourself, locked with a passphrase only you know.
    const b64 = buf => btoa(String.fromCharCode(...new Uint8Array(buf)));
    const unb64 = str => Uint8Array.from(atob(str), c => c.charCodeAt(0));
    async function keyFrom(pass, salt) {
        const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(pass), 'PBKDF2', false, ['deriveKey']);
        return crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations: 250000, hash: 'SHA-256' }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    }

    async function backupChats() {
        const res = await app.ask({ title: 'Back up your chats', text: 'Choose a passphrase (at least 8 characters). You’ll need it to open the backup — Cordial can’t recover it for you.', value: '', placeholder: 'Passphrase', ok: 'Continue', inputType: 'password' });
        if (!res) return;
        const pass = res.value || '';
        if (pass.length < 8) return app.showToast('Use at least 8 characters');
        const again = await app.ask({ title: 'Type it again', text: 'Just to be sure.', value: '', placeholder: 'Passphrase', ok: 'Make backup', inputType: 'password' });
        if (!again || again.value !== pass) return app.showToast('Those didn’t match — try again');
        app.showToast('Collecting your chats…');
        try {
            const me = I.state.profile.id;
            const dms = [];
            for (let from = 0; from < 20000; from += 1000) {
                const { data, error } = await I.client.from('diary_messages').select('id, sender, recipient, body, attachments, created_at, edited_at')
                    .is('deleted_at', null).order('id').range(from, from + 999);
                if (error) throw error;
                dms.push(...data);
                if (data.length < 1000) break;
            }
            const groups = window.diaryCommunities && window.diaryCommunities.myGroups ? await window.diaryCommunities.myGroups() : [];
            const gcs = {};
            for (const g of groups) {
                const { data } = await I.client.from('diary_community_messages').select('id, author, body, attachments, created_at, edited_at')
                    .eq('community_id', g.id).is('deleted_at', null).order('id').limit(5000);
                gcs[g.id] = { name: g.name, emoji: g.emoji, messages: data || [] };
            }
            const people = Object.fromEntries(I.state.friends.map(f => [f.id, { name: f.display_name, username: f.username }]));
            people[me] = { name: I.state.profile.display_name, username: I.state.profile.username };
            const plain = new TextEncoder().encode(JSON.stringify({ app: 'Cordial', version: 1, exported_at: new Date().toISOString(), me, people, dms, groups: gcs }));
            const salt = crypto.getRandomValues(new Uint8Array(16));
            const iv = crypto.getRandomValues(new Uint8Array(12));
            const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await keyFrom(pass, salt), plain);
            const file = new Blob([JSON.stringify({ cordialBackup: 1, salt: b64(salt), iv: b64(iv), data: b64(data) })], { type: 'application/json' });
            const a = document.createElement('a');
            a.href = URL.createObjectURL(file);
            a.download = `cordial-chats-${new Date().toISOString().slice(0, 10)}.cordialbackup`;
            a.click();
            setTimeout(() => URL.revokeObjectURL(a.href), 2000);
            app.showToast(`Backed up ${dms.length} messages and ${groups.length} group ${groups.length === 1 ? 'chat' : 'chats'}`);
        } catch (e) {
            app.showToast('Couldn’t make the backup — check your connection');
        }
    }

    async function openBackup() {
        const [file] = await Media.pickFiles('.cordialbackup,application/json', false);
        if (!file) return;
        const res = await app.ask({ title: 'Open chat backup', text: 'Enter the passphrase you chose for this backup.', value: '', placeholder: 'Passphrase', ok: 'Open', inputType: 'password' });
        if (!res) return;
        try {
            const wrap = JSON.parse(await file.text());
            const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(wrap.iv) }, await keyFrom(res.value || '', unb64(wrap.salt)), unb64(wrap.data));
            showBackup(JSON.parse(new TextDecoder().decode(plain)));
        } catch (e) {
            app.showToast('Wrong passphrase, or that isn’t a Cordial backup');
        }
    }

    function showBackup(b) {
        const d = mfaDialog();
        const name = id => (b.people[id] ? b.people[id].name : 'Someone');
        const convos = {};
        b.dms.forEach(m => {
            const other = m.sender === b.me ? m.recipient : m.sender;
            (convos[other] = convos[other] || []).push(m);
        });
        const list = [
            ...Object.entries(convos).map(([id, msgs]) => ({ key: `dm:${id}`, title: name(id), msgs, who: m => name(m.sender) })),
            ...Object.entries(b.groups || {}).map(([id, g]) => ({ key: `gc:${id}`, title: `${g.emoji || '💬'} ${g.name}`, msgs: g.messages, who: m => name(m.author) }))
        ];
        const render = key => {
            const c = list.find(x => x.key === key);
            d.innerHTML = `
                <div class="ct-card">
                    <header class="ct-head">${c ? '<button type="button" class="icon-btn" data-bk="" aria-label="Back"><svg class="i"><use href="#i-back"/></svg></button>' : ''}<strong>${c ? esc(c.title) : `Backup from ${esc(new Date(b.exported_at).toLocaleString())}`}</strong><button type="button" class="icon-btn" data-ct-close aria-label="Close"><svg class="i"><use href="#i-close"/></svg></button></header>
                    <div class="ct-results">${c
                        ? c.msgs.map(m => `<div class="bk-msg"><small>${esc(c.who(m))} · ${esc(new Date(m.created_at).toLocaleString())}</small><p>${esc(Rich.toText(m.body || '') || ((m.attachments || [])[0] ? `[${m.attachments[0].kind}]` : ''))}</p></div>`).join('')
                        : list.map(x => `<button type="button" class="ct-hit" data-bk="${esc(x.key)}"><span class="ct-hit-top"><strong>${esc(x.title)}</strong><time>${x.msgs.length} messages</time></span></button>`).join('') || '<p class="muted small">This backup is empty.</p>'}</div>
                    <p class="muted small">A read-only copy from your backup file. Your live chats are unchanged.</p>
                </div>`;
        };
        d.onclick = e => {
            if (e.target === d || e.target.closest('[data-ct-close]')) return d.close();
            const b2 = e.target.closest('[data-bk]');
            if (b2) render(b2.dataset.bk);
        };
        render('');
        if (!d.open) d.showModal();
    }

    async function loadFollowLists() {
        if (F.loading || !I || !signedIn()) return;
        F.loading = true;
        const me = profile().id;
        const [fans, mine] = await Promise.all([
            I.client.from('diary_follows').select(`created_at, person:diary_profiles!diary_follows_follower_fkey(${PROFILE})`).eq('followee', me).order('created_at', { ascending: false }).limit(100),
            I.client.from('diary_follows').select(`created_at, person:diary_profiles!diary_follows_followee_fkey(${PROFILE})`).eq('follower', me).order('created_at', { ascending: false }).limit(100)
        ]);
        F.followers = fans.error ? [] : fans.data.map(r => r.person).filter(Boolean);
        F.following = mine.error ? [] : mine.data.map(r => r.person).filter(Boolean);
        F.loaded = true;
        F.loading = false;
        if (app.state.view === 'settings') app.render();
    }

    function setTheme(mode) {
        if (mode === 'system') {
            delete root.dataset.theme;
            write('diaryTheme', null);
            document.querySelectorAll('meta[name="theme-color"]').forEach(m =>
                m.setAttribute('content', m.media.includes('dark') ? '#09090b' : '#ffffff'));
        } else {
            root.dataset.theme = mode;
            write('diaryTheme', mode);
            document.querySelectorAll('meta[name="theme-color"]').forEach(m => m.setAttribute('content', mode === 'dark' ? '#09090b' : '#ffffff'));
        }
    }

    function setPref(attr, key, value, fallback) {
        if (value === fallback) {
            delete root.dataset[attr];
            write(key, null);
        } else {
            root.dataset[attr] = value;
            write(key, value);
        }
    }

    const signedIn = () => social && social.isSignedIn();
    const profile = () => I && I.state.profile;

    // ---------- Page ----------
    app.views.settings = () => {
        app.setTitle('Settings');
        const theme = read('diaryTheme', 'system');
        const accent = root.dataset.accent || 'indigo';
        const size = root.dataset.text || 'default';
        const bg = root.dataset.bg || 'default';
        const motion = root.dataset.motion === 'reduce';
        const alerts = window.diaryNotify && window.diaryNotify.alertStatus ? window.diaryNotify.alertStatus() : 'unavailable';
        const pinSet = !!read('diaryPin', '');
        const p = profile();
        if (!storageText && navigator.storage && navigator.storage.estimate) {
            navigator.storage.estimate().then(e => {
                storageText = `${(e.usage / 1048576).toFixed(1)} MB used on this device`;
                const el = $('st-storage');
                if (el) el.textContent = storageText;
            }).catch(() => {});
        }

        const presence = P.settings;
        if (signedIn() && !P.loaded) loadPresencePrivacy();
        if (signedIn() && SEC.devices === null) loadSecurity();
        const WHO2 = [['everyone', 'Everyone'], ['friends', 'Friends']];
        const seg = (name, options, current) => `
            <div class="st-seg" role="radiogroup" aria-label="${name}">
                ${options.map(([v, l]) => `<button type="button" role="radio" aria-checked="${current === v}" data-action="st-set" data-setting="${name}" data-value="${v}">${l}</button>`).join('')}
            </div>`;
        const row = (icon, title, sub, control, extra = '') => `
            <div class="st-row"${extra}>
                <span class="st-ic"><svg class="i"><use href="#${icon}"/></svg></span>
                <span class="st-text"><strong>${title}</strong>${sub ? `<small>${sub}</small>` : ''}</span>
                ${control}
            </div>`;
        const toggle = (action, on, label) => `
            <label class="st-switch share-toggle" aria-label="${label}">
                <input type="checkbox" data-action="${action}"${on ? ' checked' : ''}>
                <span class="switch" aria-hidden="true"></span>
            </label>`;
        const go = (action, label, danger = false) => `<button class="st-btn${danger ? ' danger' : ''}" data-action="${action}">${label}</button>`;

        return `
            <div class="settings">
                <section class="st-card st-profile">
                    ${p ? `
                        <button class="st-avatar" data-action="change-avatar" aria-label="Change profile photo">
                            ${I.avatar(p, 'xl')}<span class="photo-badge" aria-hidden="true"><svg class="i"><use href="#i-camera"/></svg></span>
                        </button>
                        <div class="st-who">
                            <strong>${esc(p.display_name)}</strong>
                            <small>@${esc(p.username)}</small>
                        </div>
                        <div class="st-profile-actions">
                            ${go('st-rename', 'Edit name')}
                            ${p.avatar_path ? go('st-remove-photo', 'Remove photo') : ''}
                        </div>` : `
                        <div class="st-who"><strong>You’re not signed in</strong><small>Your notes stay on this device. Sign in to share with friends.</small></div>
                        <button class="primary-btn" data-action="sign-in">Sign in or create an account</button>`}
                </section>

                ${signedIn() ? `<section class="st-card">
                    <h3>Your status</h3>
                    <div class="st-status">${STATUSES.map(([k, l]) => `<button type="button" class="chip${presence.status === k ? ' on' : ''}" data-action="st-status" data-value="${k}" aria-pressed="${presence.status === k}">${l}</button>`).join('')}
                        ${presence.status ? '<button type="button" class="chip" data-action="st-status" data-value="">Clear</button>' : ''}</div>
                    <p class="muted small">${presence.status ? `${esc((STATUSES.find(x => x[0] === presence.status) || ['', ''])[1])}${presence.status_text ? ` · “${esc(presence.status_text)}”` : ''}${presence.status_until ? ` · until ${esc(new Date(presence.status_until).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }))}` : ''}${presence.status === 'dnd' ? ' — calls and messages arrive quietly' : ''}` : 'Let friends know if you’re busy. Do not disturb silences message sounds and incoming calls.'}</p>
                </section>` : ''}

                <section class="st-card">
                    <h3>Appearance</h3>
                    ${row('i-moon', 'Theme', 'Follow your phone, or choose one', seg('theme', [['system', 'Auto'], ['light', 'Light'], ['dark', 'Dark']], theme))}
                    <div class="st-row">
                        <span class="st-ic"><svg class="i"><use href="#i-sparkle"/></svg></span>
                        <span class="st-text"><strong>Accent colour</strong><small>${esc((ACCENTS.find(a => a[0] === accent) || ACCENTS[0])[1])}</small></span>
                        <div class="st-swatches" role="radiogroup" aria-label="Accent colour">
                            ${ACCENTS.map(([v, l, c]) => `<button type="button" class="st-swatch" role="radio" aria-checked="${accent === v}" aria-label="${l}" style="--sw:${c}" data-action="st-set" data-setting="accent" data-value="${v}"></button>`).join('')}
                        </div>
                    </div>
                    <div class="st-row">
                        <span class="st-ic"><svg class="i"><use href="#i-palette"/></svg></span>
                        <span class="st-text"><strong>Background</strong><small>${esc((BACKGROUNDS.find(b => b[0] === bg) || BACKGROUNDS[0])[1])}${bg === 'midnight' ? ' · shows in dark mode' : ''}</small></span>
                        <div class="st-swatches st-bg" role="radiogroup" aria-label="App background">
                            ${BACKGROUNDS.map(([v, l, light, dark]) => `<button type="button" class="st-swatch st-bgswatch" role="radio" aria-checked="${bg === v}" aria-label="${l}" style="--l:${light};--d:${dark}" data-action="st-set" data-setting="bg" data-value="${v}"></button>`).join('')}
                        </div>
                    </div>
                    ${row('i-edit', 'Text size', 'Applies across the app', seg('text', SIZES, size))}
                    ${window.Speak && window.Speak.supported ? row('i-volume', 'Read-aloud voice', 'Used when you tap Listen on a note or post', seg('speakvoice', [['female', 'Female'], ['male', 'Male']], window.Speak.getPrefs().voice)) : ''}
                    ${row('i-play', 'Reduce motion', 'Calmer screens: no slides, bounces or confetti', toggle('st-motion', motion, 'Reduce motion'))}
                </section>

                <section class="st-card">
                    <h3>Notifications</h3>
                    ${row('i-bell', 'Alerts on this device', alerts === 'unavailable' ? 'Not available in this browser — on iPhone, add Cordial to your Home Screen first' : (window.diaryNotify && window.diaryNotify.pushSupported && window.diaryNotify.pushSupported() ? 'Friend requests, new followers and people going live — even when Cordial is closed; messages, likes and calls while it’s open' : 'Messages, likes, comments and calls while Cordial is open'),
                        alerts === 'unavailable' ? '<span class="muted small">Off</span>' : toggle('st-alerts', alerts === 'on', 'Device alerts'))}
                    ${signedIn() ? (() => {
                        if (!NP.muted) { loadNotifPrefs(); return '<p class="muted small st-pad">Loading your notification choices…</p>'; }
                        return `<h4 class="st-sub">What to notify you about</h4>${NOTIF_CATS.map(([cat, icon, title, sub]) => row(icon, title, sub, `
                            <label class="st-switch share-toggle" aria-label="${title}">
                                <input type="checkbox" data-action="st-notif" data-cat="${cat}"${NP.muted.has(cat) ? '' : ' checked'}>
                                <span class="switch" aria-hidden="true"></span>
                            </label>`)).join('')}<p class="muted small st-pad">New sign-ins to your account are always shown.</p>`;
                    })() : ''}
                </section>

                <section class="st-card">
                    <h3>Privacy & security</h3>
                    ${row('i-lock', 'Private notes PIN', pinSet ? 'On — private notes need your PIN' : 'Off — protect private notes on this device', go('st-pin', pinSet ? 'Change' : 'Set PIN'))}
                    ${signedIn() ? row('i-user', 'Who sees when you’re online', 'The green dot and “Active now”', seg('presence-online', PRESENCE, presence.show_online)) : ''}
                    ${signedIn() ? row('i-history', 'Who sees your last seen', presence.show_last_seen === 'nobody' ? 'Hidden — and you won’t see other people’s last seen either' : '“Last seen 5 min ago” when you’re away', seg('presence-last', PRESENCE, presence.show_last_seen)) : ''}
                    ${signedIn() ? row('i-checks', 'Read receipts', presence.read_receipts === false ? 'Off — people won’t see when you’ve read their messages, and you won’t see theirs' : 'On — blue ticks when a message has been read', toggle('st-receipts', presence.read_receipts !== false, 'Read receipts')) : ''}
                    ${signedIn() ? row('i-phone', 'Who can call you', presence.allow_calls === 'nobody' ? 'No one — calls are blocked' : 'Your friends', seg('privacy-calls', [['friends', 'Friends'], ['nobody', 'No one']], presence.allow_calls || 'friends')) : ''}
                    ${signedIn() ? row('i-image', 'Who sees your profile photo', 'Everyone else sees your initials', seg('privacy-photo', WHO2, presence.photo_visibility || 'everyone')) : ''}
                    ${signedIn() ? verificationRow() : ''}
                    ${signedIn() ? row('i-user', 'Who sees your profile details', 'Your bio, location, interests and when you joined', seg('privacy-profile', WHO2, presence.profile_visibility || 'everyone')) : ''}
                    ${signedIn() ? row('i-chart', 'Who sees your numbers', 'Posts, followers, following and reactions — and your follower lists', seg('privacy-stats', [['everyone', 'Everyone'], ['friends', 'Friends'], ['nobody', 'Only me']], presence.stats_visibility || 'everyone')) : ''}
                    ${signedIn() ? row('i-search', 'Let people find me by email', 'Only someone who types your exact email address', seg('privacy-email', [['off', 'Off'], ['on', 'On']], presence.email_search === true || presence.email_search === 'on' ? 'on' : 'off')) : ''}
                    ${signedIn() ? row('i-bell', 'Message previews in alerts', read('diaryPreviews', '1') === '1' ? 'Alerts show what the message says' : 'Alerts only say who it’s from', toggle('st-previews', read('diaryPreviews', '1') === '1', 'Message previews')) : ''}
                    ${signedIn() ? `<div class="st-row st-col">
                        <span class="st-ic"><svg class="i"><use href="#i-block"/></svg></span>
                        <span class="st-text"><strong>Blocked people</strong><small>${SEC.blocked === null ? 'Loading…' : SEC.blocked.length ? `${SEC.blocked.length} blocked` : 'No one — block someone from their profile or chat'}</small></span>
                        ${(SEC.blocked || []).length ? `<div class="st-list">${SEC.blocked.map(p => `<div class="st-person">${I.avatar(p, 'sm')}<span>${esc(p.display_name)}<small>@${esc(p.username)}</small></span><button type="button" class="st-btn" data-action="st-unblock" data-id="${esc(p.id)}">Unblock</button></div>`).join('')}</div>` : ''}
                    </div>` : ''}
                    ${signedIn() ? row('i-shield', 'Two-step verification', (SEC.factors || []).length ? 'On — signing in needs a code from your authenticator app' : 'Off — add a code from an authenticator app when you sign in', (SEC.factors || []).length ? go('st-mfa-off', 'Turn off') : go('st-mfa-on', 'Turn on')) : ''}
                    ${signedIn() ? `<div class="st-row st-col">
                        <span class="st-ic"><svg class="i"><use href="#i-grid"/></svg></span>
                        <span class="st-text"><strong>Your devices</strong><small>Where your account is signed in. You get an alert when a new one signs in.</small></span>
                        <div class="st-list">${(SEC.devices || []).map(d => `<div class="st-person"><span class="st-dev-ic"><svg class="i"><use href="#i-grid"/></svg></span><span>${esc(d.label || 'A device')}${I.deviceId && d.device_id === I.deviceId() ? ' <b class="st-this">This device</b>' : ''}<small>Last active ${esc(I.timeAgo(d.last_seen))} · first seen ${esc(new Date(d.first_seen).toLocaleDateString())}</small></span>${I.deviceId && d.device_id === I.deviceId() ? '' : `<button type="button" class="st-btn" data-action="st-forget-device" data-id="${esc(d.id)}">Remove</button>`}</div>`).join('') || '<p class="muted small">Loading…</p>'}</div>
                        <button type="button" class="st-btn danger" data-action="st-signout-others">Sign out of all other devices</button>
                    </div>` : ''}
                    ${signedIn() ? row('i-lock', 'Password', 'Change the password you sign in with', go('st-password', 'Change')) : ''}
                    ${signedIn() ? row('i-logout', 'Sign out', 'Your notes stay on this device', go('st-signout', 'Sign out')) : ''}
                </section>

                <section class="st-card">
                    <h3>Your data</h3>
                    ${window.diaryBackup ? (signedIn()
                        ? row('i-refresh', 'Backup', `<span id="st-backup-sub">${esc(backupText())}</span>`, go('st-backup', 'Back up now'))
                        : row('i-lock', 'Back up your notes', 'Sign in and your notes are saved to your account, so they come back on any device', go('sign-in', 'Sign in'))) : ''}
                    ${row('i-download', 'Export your notes', 'Download everything as a file', go('st-export', 'Export'))}
                    ${signedIn() ? row('i-lock', 'Chat backup', 'An extra, passphrase-locked copy of your chats (they’re already kept in your account)', `<span class="st-two">${go('st-chat-backup', 'Back up')}${go('st-chat-open', 'Open')}</span>`) : ''}
                    ${row('i-archive', 'Storage', `<span id="st-storage">${esc(storageText || 'Checking…')}</span>`, '')}
                    ${row('i-refresh', 'Reload the app', 'Get the latest version of Cordial', go('st-reload', 'Reload'))}
                    ${row('i-trash', 'Clear this device', 'Remove notes, photos and settings stored in this browser', go('st-clear', 'Clear', true))}
                </section>

                ${signedIn() ? followSection() : ''}

                ${signedIn() ? `
                    <section class="st-card st-danger">
                        <h3>Account</h3>
                        ${row('i-trash', 'Delete account', 'Permanently remove your profile, posts, messages and everything you shared', go('st-delete', 'Delete', true))}
                    </section>` : ''}

                <p class="st-foot muted small">Cordial · your diary, your people.</p>
            </div>`;
    };

    // Fresh lists every time you come back to Settings
    const previousAfter = app.hooks.afterRender;
    app.hooks.afterRender = view => {
        if (previousAfter) previousAfter(view);
        if (view !== 'settings') F.loaded = false;
        else I && I.hydrateStorage(document.getElementById('content'));
    };

    function backupText() {
        const b = window.diaryBackup.status();
        if (b.busy) return 'Backing up your notes…';
        if (b.error) return `${b.error} — tap Back up now to try again`;
        if (!navigator.onLine) return 'You’re offline — changes back up when you reconnect';
        const when = b.lastSync ? `last backed up ${I.timeAgo(new Date(b.lastSync).toISOString())}` : 'not backed up yet';
        return `${b.count} ${b.count === 1 ? 'note' : 'notes'} saved to your account · ${when}`;
    }
    if (window.diaryBackup) {
        window.diaryBackup.onchange = () => {
            const el = document.getElementById('st-backup-sub');
            if (el) el.textContent = backupText();
        };
    }

    function followSection() {
        if (!F.loaded) loadFollowLists();
        const person = (p, action, label) => `
            <div class="st-person">
                <button type="button" class="row-av" data-profile="${esc(p.id)}" aria-label="${esc(p.display_name)}’s profile">${I.avatar(p, 'sm')}</button>
                <span class="st-text" data-profile="${esc(p.id)}" role="button" tabindex="0"><strong>${esc(p.display_name)}</strong><small>@${esc(p.username)}</small></span>
                <button class="st-btn" data-action="${action}" data-id="${esc(p.id)}" data-name="${esc(p.display_name.split(' ')[0])}">${label}</button>
            </div>`;
        const list = (items, action, label, empty) => !F.loaded
            ? '<p class="muted small st-pad">Loading…</p>'
            : items.length ? `<div class="st-people">${items.map(p => person(p, action, label)).join('')}</div>` : `<p class="muted small st-pad">${empty}</p>`;
        return `
            <section class="st-card">
                <h3>Followers</h3>
                <p class="muted small st-pad">People who follow you get a notification when you go live, just like your friends, and can watch.</p>
                <details class="st-fold"${F.followers.length && F.followers.length <= 5 ? ' open' : ''}>
                    <summary><strong>${F.loaded ? F.followers.length : '…'}</strong> ${F.followers.length === 1 ? 'follower' : 'followers'}</summary>
                    ${list(F.followers, 'st-remove-follower', 'Remove', 'No followers yet. People can follow you from Explore or a community.')}
                </details>
                <details class="st-fold">
                    <summary><strong>${F.loaded ? F.following.length : '…'}</strong> following</summary>
                    ${list(F.following, 'st-unfollow', 'Unfollow', 'You’re not following anyone yet. Find people in Explore.')}
                </details>
            </section>`;
    }

    // ---------- Actions ----------
    Object.assign(app.actions, {
        'st-verify': () => verifyDialog(),
        'st-set': el => {
            const { setting, value } = el.dataset;
            if (setting === 'presence-online' || setting === 'presence-last') return setPresencePrivacy(setting === 'presence-online' ? 'show_online' : 'show_last_seen', value);
            if (setting === 'privacy-calls') return setPrivacyKey('allow_calls', value);
            if (setting === 'privacy-photo') return setPrivacyKey('photo_visibility', value);
            if (setting === 'privacy-profile') return setPrivacyKey('profile_visibility', value);
            if (setting === 'privacy-stats') return setPrivacyKey('stats_visibility', value);
            if (setting === 'privacy-email') return setPrivacyKey('email_search', value);
            if (setting === 'theme') setTheme(value);
            if (setting === 'accent') setPref('accent', 'diaryAccent', value, 'indigo');
            if (setting === 'text') setPref('text', 'diaryTextSize', value, 'default');
            if (setting === 'bg') {
                setPref('bg', 'diaryBackground', value, 'default');
                // The phone's status bar follows the new background
                const pageBg = getComputedStyle(root).getPropertyValue('--bg').trim();
                if (pageBg) document.querySelectorAll('meta[name="theme-color"]').forEach(m => m.setAttribute('content', pageBg));
            }
            if (setting === 'speakvoice' && window.Speak) window.Speak.setPrefs({ voice: value });
            app.render();
        },
        'st-rename': () => app.renameUser(),
        'st-backup': () => window.diaryBackup && window.diaryBackup.syncNow(),
        'st-unfollow': async el => {
            await I.toggleFollow(el.dataset.id, el.dataset.name);
            F.following = F.following.filter(p => p.id !== el.dataset.id);
            app.render();
        },
        'st-remove-follower': async el => {
            const ok = await app.ask({ title: `Remove ${el.dataset.name} as a follower?`, text: 'They won’t be told. They’ll stop getting your live notifications, but can follow you again.', ok: 'Remove', danger: true });
            if (!ok) return;
            const { error } = await I.client.from('diary_follows').delete().eq('follower', el.dataset.id).eq('followee', profile().id);
            if (error) return app.showToast('Couldn’t remove that follower');
            F.followers = F.followers.filter(p => p.id !== el.dataset.id);
            I.state.followerCount = F.followers.length;
            app.render();
            app.showToast('Follower removed');
        },
        'st-remove-photo': () => I && I.removeAvatar(),
        'st-pin': () => app.setPin().then(() => app.render()),
        'st-reload': () => location.reload(),
        'st-status': el => setStatus(el.dataset.value || null),
        'st-unblock': async el => {
            const p = (SEC.blocked || []).find(x => x.id === el.dataset.id);
            if (p && window.diarySafety && await window.diarySafety.unblock(p)) { SEC.blocked = SEC.blocked.filter(x => x.id !== p.id); app.render(); }
        },
        'st-mfa-on': () => enrollMfa(),
        'st-mfa-off': () => disableMfa(),
        'st-forget-device': async el => {
            const { error } = await I.client.from('diary_devices').delete().eq('id', el.dataset.id);
            if (error) return app.showToast('Couldn’t remove it');
            SEC.devices = SEC.devices.filter(d => d.id !== el.dataset.id);
            app.render();
        },
        'st-signout-others': async () => {
            const ok = await app.ask({ title: 'Sign out everywhere else?', text: 'Every other phone and computer signed in to your account will be signed out. This device stays signed in.', ok: 'Sign out others', danger: true });
            if (!ok) return;
            const { error } = await I.client.auth.signOut({ scope: 'others' });
            if (error) return app.showToast('Couldn’t do that — try again');
            const mine = I.deviceId ? I.deviceId() : null;
            await I.client.from('diary_devices').delete().neq('device_id', mine || '');
            SEC.devices = (SEC.devices || []).filter(d => d.device_id === mine);
            app.showToast('Signed out of your other devices');
            app.render();
        },
        'st-chat-backup': () => backupChats(),
        'st-chat-open': () => openBackup(),
        'st-export': () => { app.exportData(); app.showToast('Your notes are downloading'); },
        'st-signout': async () => {
            const ok = await app.ask({ title: 'Sign out?', text: 'Your notes stay on this device.', ok: 'Sign out' });
            if (ok && I) I.signOut();
        },
        'st-password': async () => {
            const r = await app.ask({ title: 'New password', text: 'At least 8 characters.', value: '', placeholder: 'New password', ok: 'Next', inputType: 'password' });
            if (!r) return;
            if (r.value.length < 8) return app.showToast('Use at least 8 characters');
            const again = await app.ask({ title: 'Type it again', value: '', placeholder: 'New password', ok: 'Save', inputType: 'password' });
            if (!again) return;
            if (again.value !== r.value) return app.showToast('The passwords didn’t match');
            const { error } = await I.client.auth.updateUser({ password: r.value });
            app.showToast(error ? 'Couldn’t change your password' : 'Password changed');
        },
        'st-clear': async () => {
            const r = await app.ask({
                title: 'Clear this device?',
                text: 'This removes every note, photo, voice note and setting stored in this browser. Export your notes first if you want to keep them. Type CLEAR to confirm.',
                value: '', placeholder: 'CLEAR', ok: 'Clear everything', danger: true
            });
            if (!r || r.value.trim().toUpperCase() !== 'CLEAR') return;
            try { localStorage.clear(); sessionStorage.clear(); } catch (e) {}
            try {
                const dbs = indexedDB.databases ? await indexedDB.databases() : [];
                dbs.forEach(d => d.name && indexedDB.deleteDatabase(d.name));
            } catch (e) {}
            location.reload();
        },
        'st-delete': async () => {
            const p = profile();
            if (!p) return;
            const r = await app.ask({
                title: 'Delete your account?',
                text: `This permanently removes your profile, posts, stories, reels, messages, library and community posts. It can’t be undone. Notes on this device stay. Type ${p.username} to confirm.`,
                value: '', placeholder: p.username, ok: 'Delete my account', danger: true
            });
            if (!r || r.value.trim().toLowerCase() !== p.username) return app.showToast('Account not deleted');
            const { error } = await I.client.rpc('diary_delete_account');
            if (error) return app.showToast('Couldn’t delete your account — please try again');
            await I.client.auth.signOut();
            app.showToast('Your account was deleted');
            app.setView('home');
        }
    });

    // Switches fire change, not click
    $('content').addEventListener('change', async e => {
        const a = e.target.dataset && e.target.dataset.action;
        if (a === 'st-motion') {
            setPref('motion', 'diaryMotion', e.target.checked ? 'reduce' : 'full', 'full');
        } else if (a === 'st-previews') {
            write('diaryPreviews', e.target.checked ? '1' : '0');
            app.showToast(e.target.checked ? 'Alerts show message text' : 'Alerts hide message text');
            app.render();
        } else if (a === 'st-receipts') {
            const on = e.target.checked;
            P.settings = { ...P.settings, read_receipts: on };
            const { error } = await I.client.rpc('diary_set_read_receipts', { p_on: on });
            if (error) { P.settings = { ...P.settings, read_receipts: !on }; app.showToast('Couldn’t save that'); }
            else app.showToast(on ? 'Read receipts on' : 'Read receipts off');
            if (I.refreshPresence) I.refreshPresence();
            app.render();
        } else if (a === 'st-notif') {
            setNotifCat(e.target.dataset.cat, e.target.checked);
        } else if (a === 'st-alerts') {
            if (e.target.checked && window.diaryNotify && window.diaryNotify.enableAlerts) await window.diaryNotify.enableAlerts();
            else if (!e.target.checked) {
                write('diaryAlerts', null);
                if (window.diaryNotify && window.diaryNotify.disableAlerts) await window.diaryNotify.disableAlerts();
            }
            app.render();
        }
    });
});
