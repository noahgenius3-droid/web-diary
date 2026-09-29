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

    const ACCENTS = [['indigo', 'Indigo', '#4f46e5'], ['violet', 'Violet', '#7c3aed'], ['rose', 'Rose', '#e11d48'], ['emerald', 'Emerald', '#047857']];
    const SIZES = [['small', 'Small'], ['default', 'Default'], ['large', 'Large']];

    let storageText = '';

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
                    ${row('i-edit', 'Text size', 'Applies across the app', seg('text', SIZES, size))}
                    ${row('i-play', 'Reduce motion', 'Calmer screens: no slides, bounces or confetti', toggle('st-motion', motion, 'Reduce motion'))}
                </section>

                <section class="st-card">
                    <h3>Notifications</h3>
                    ${row('i-bell', 'Alerts on this device', alerts === 'unavailable' ? 'Not available in this browser — on iPhone, add Cordial to your Home Screen first' : 'Messages, likes, comments and calls while Cordial is open',
                        alerts === 'unavailable' ? '<span class="muted small">Off</span>' : toggle('st-alerts', alerts === 'on', 'Device alerts'))}
                </section>

                <section class="st-card">
                    <h3>Privacy & security</h3>
                    ${row('i-lock', 'Private notes PIN', pinSet ? 'On — private notes need your PIN' : 'Off — protect private notes on this device', go('st-pin', pinSet ? 'Change' : 'Set PIN'))}
                    ${signedIn() ? row('i-lock', 'Password', 'Change the password you sign in with', go('st-password', 'Change')) : ''}
                    ${signedIn() ? row('i-logout', 'Sign out', 'Your notes stay on this device', go('st-signout', 'Sign out')) : ''}
                </section>

                <section class="st-card">
                    <h3>Your data</h3>
                    ${row('i-download', 'Export your notes', 'Download everything as a file', go('st-export', 'Export'))}
                    ${row('i-archive', 'Storage', `<span id="st-storage">${esc(storageText || 'Checking…')}</span>`, '')}
                    ${row('i-trash', 'Clear this device', 'Remove notes, photos and settings stored in this browser', go('st-clear', 'Clear', true))}
                </section>

                ${signedIn() ? `
                    <section class="st-card st-danger">
                        <h3>Account</h3>
                        ${row('i-trash', 'Delete account', 'Permanently remove your profile, posts, messages and everything you shared', go('st-delete', 'Delete', true))}
                    </section>` : ''}

                <p class="st-foot muted small">Cordial · your diary, your people.</p>
            </div>`;
    };

    // ---------- Actions ----------
    Object.assign(app.actions, {
        'st-set': el => {
            const { setting, value } = el.dataset;
            if (setting === 'theme') setTheme(value);
            if (setting === 'accent') setPref('accent', 'diaryAccent', value, 'indigo');
            if (setting === 'text') setPref('text', 'diaryTextSize', value, 'default');
            app.render();
        },
        'st-rename': () => app.renameUser(),
        'st-remove-photo': () => I && I.removeAvatar(),
        'st-pin': () => app.setPin().then(() => app.render()),
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
        } else if (a === 'st-alerts') {
            if (e.target.checked && window.diaryNotify && window.diaryNotify.enableAlerts) await window.diaryNotify.enableAlerts();
            else if (!e.target.checked) write('diaryAlerts', null);
            app.render();
        }
    });
});
