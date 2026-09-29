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
        const { data } = await I.client.from('diary_presence').select('show_online, show_last_seen, read_receipts').maybeSingle();
        if (data) {
            P.settings = data;
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
                </section>

                <section class="st-card">
                    <h3>Privacy & security</h3>
                    ${row('i-lock', 'Private notes PIN', pinSet ? 'On — private notes need your PIN' : 'Off — protect private notes on this device', go('st-pin', pinSet ? 'Change' : 'Set PIN'))}
                    ${signedIn() ? row('i-user', 'Who sees when you’re online', 'The green dot and “Active now”', seg('presence-online', PRESENCE, presence.show_online)) : ''}
                    ${signedIn() ? row('i-history', 'Who sees your last seen', presence.show_last_seen === 'nobody' ? 'Hidden — and you won’t see other people’s last seen either' : '“Last seen 5 min ago” when you’re away', seg('presence-last', PRESENCE, presence.show_last_seen)) : ''}
                    ${signedIn() ? row('i-checks', 'Read receipts', presence.read_receipts === false ? 'Off — people won’t see when you’ve read their messages, and you won’t see theirs' : 'On — blue ticks when a message has been read', toggle('st-receipts', presence.read_receipts !== false, 'Read receipts')) : ''}
                    ${signedIn() ? row('i-lock', 'Password', 'Change the password you sign in with', go('st-password', 'Change')) : ''}
                    ${signedIn() ? row('i-logout', 'Sign out', 'Your notes stay on this device', go('st-signout', 'Sign out')) : ''}
                </section>

                <section class="st-card">
                    <h3>Your data</h3>
                    ${window.diaryBackup ? (signedIn()
                        ? row('i-refresh', 'Backup', `<span id="st-backup-sub">${esc(backupText())}</span>`, go('st-backup', 'Back up now'))
                        : row('i-lock', 'Back up your notes', 'Sign in and your notes are saved to your account, so they come back on any device', go('sign-in', 'Sign in'))) : ''}
                    ${row('i-download', 'Export your notes', 'Download everything as a file', go('st-export', 'Export'))}
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
                ${I.avatar(p, 'sm')}
                <span class="st-text"><strong>${esc(p.display_name)}</strong><small>@${esc(p.username)}</small></span>
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
        'st-set': el => {
            const { setting, value } = el.dataset;
            if (setting === 'presence-online' || setting === 'presence-last') return setPresencePrivacy(setting === 'presence-online' ? 'show_online' : 'show_last_seen', value);
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
        } else if (a === 'st-receipts') {
            const on = e.target.checked;
            P.settings = { ...P.settings, read_receipts: on };
            const { error } = await I.client.rpc('diary_set_read_receipts', { p_on: on });
            if (error) { P.settings = { ...P.settings, read_receipts: !on }; app.showToast('Couldn’t save that'); }
            else app.showToast(on ? 'Read receipts on' : 'Read receipts off');
            if (I.refreshPresence) I.refreshPresence();
            app.render();
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
