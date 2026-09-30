// Scheduled posts and drafts: write a feed post, a group post (or announcement) or a message to a friend now,
// and have it go out later. The server publishes it at the chosen minute (pg_cron runs every minute), so the
// phone can be off. You get a notification when it's out, or if it couldn't be posted (e.g. you left the group).
// The Scheduled page (#/scheduled) lists what's coming up, drafts, what's been sent and what didn't go out.
document.addEventListener('DOMContentLoaded', () => {
    const app = window.diaryApp;
    const social = window.diarySocial;
    if (!app || !social || !social.internals) return;
    const I = social.internals;
    const { client, state: s, esc, avatar, timeAgo, hydrateStorage } = I;
    const content = document.getElementById('content');
    const FEED_BUCKET = 'diary-feed';
    const GROUP_BUCKET = 'diary-community';
    const MAX_PHOTOS = 10;

    const S = { list: null, loading: false, tab: 'scheduled' };
    const me = () => s.profile && s.profile.id;
    const bucketFor = target => (target === 'group' ? GROUP_BUCKET : FEED_BUCKET);

    // ---------- Loading ----------
    async function load() {
        if (S.loading || !me()) return;
        S.loading = true;
        const { data, error } = await client.from('diary_scheduled').select('*').order('publish_at', { ascending: true, nullsFirst: false }).order('updated_at', { ascending: false }).limit(300);
        S.loading = false;
        S.list = error ? [] : data || [];
        if (window.diaryCommunities && window.diaryCommunities.myGroups) S.groups = await window.diaryCommunities.myGroups().catch(() => []);
        S.error = !!error;
        if (app.state.view === 'scheduled') app.requestRender ? app.requestRender('scheduled') : app.render();
        paintCounts();
    }

    const upcoming = () => (S.list || []).filter(x => x.status === 'scheduled');
    function paintCounts() {
        const n = upcoming().length;
        document.querySelectorAll('[data-sched-count]').forEach(el => { el.textContent = n ? String(n) : ''; el.hidden = !n; });
    }

    // ---------- When ----------
    const pad = n => String(n).padStart(2, '0');
    const toLocalInput = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
    function whenText(iso) {
        const d = new Date(iso);
        const now = new Date();
        const day = new Date(d.getFullYear(), d.getMonth(), d.getDate());
        const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        const diff = Math.round((day - today) / 864e5);
        const time = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
        if (diff === 0) return `Today at ${time}`;
        if (diff === 1) return `Tomorrow at ${time}`;
        if (diff > 1 && diff < 7) return `${d.toLocaleDateString(undefined, { weekday: 'long' })} at ${time}`;
        return `${d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: d.getFullYear() === now.getFullYear() ? undefined : 'numeric' })} at ${time}`;
    }
    function quickTimes() {
        const at = (days, h, m = 0) => { const d = new Date(); d.setDate(d.getDate() + days); d.setHours(h, m, 0, 0); return d; };
        const now = new Date();
        const inHour = new Date(Math.ceil((now.getTime() + 3600e3) / 300e3) * 300e3);
        const tonight = at(0, 20);
        const monday = at(((8 - now.getDay()) % 7) || 7, 9);
        return [
            ['In an hour', inHour],
            ...(tonight - now > 30 * 60e3 ? [['Tonight, 8 pm', tonight]] : []),
            ['Tomorrow, 9 am', at(1, 9)],
            ['Monday, 9 am', monday]
        ];
    }

    // ---------- The editor ----------
    // opts: { item } to edit, or { target, communityId, recipient, title, body, audience, files: [File] } to start one
    async function open(opts = {}) {
        if (!me()) return app.showToast('Sign in to schedule posts');
        const item = opts.item || null;
        const groups = window.diaryCommunities && window.diaryCommunities.myGroups ? await window.diaryCommunities.myGroups().catch(() => []) : [];
        const d = {
            target: item ? item.target : opts.target || 'feed',
            communityId: item ? item.community_id : opts.communityId || (groups[0] && groups[0].id) || '',
            recipient: item ? item.recipient : opts.recipient || (s.friends[0] && s.friends[0].id) || '',
            title: item ? item.title : opts.title || '',
            body: item ? item.body : opts.body || '',
            audience: item ? item.audience : opts.audience || s.feedAudience || 'friends',
            announce: item ? item.announce : false,
            photos: item ? (item.photos || []).map(p => ({ ...p, bucket: bucketFor(item.target) })) : [],
            fresh: [], // { id, file, preview }
            when: item && item.publish_at ? new Date(item.publish_at) : new Date(Date.now() + 3600e3)
        };
        (opts.files || []).forEach(file => d.fresh.push({ id: Math.random().toString(36).slice(2), file, preview: URL.createObjectURL(file) }));

        const dlg = document.createElement('dialog');
        dlg.className = 'sheet-dialog sched-dialog';
        dlg.setAttribute('aria-labelledby', 'sched-title');
        document.body.append(dlg);

        const targetSeg = () => `
            <div class="sched-seg" role="radiogroup" aria-label="Where it goes">
                ${[['feed', 'i-home', 'Feed'], ['group', 'i-users', 'A group'], ['message', 'i-chat', 'A message']].map(([v, icon, l]) =>
                    `<button type="button" role="radio" aria-checked="${d.target === v}" data-sc="target" data-v="${v}"${v === 'group' && !groups.length ? ' disabled title="Join a group first"' : ''}${v === 'message' && !s.friends.length ? ' disabled title="Add a friend first"' : ''}><svg class="i"><use href="#${icon}"/></svg>${l}</button>`).join('')}
            </div>`;
        const photosHTML = () => [...d.photos.map(p => `<figure class="pc-thumb"><img data-path="${esc(p.path)}" data-bucket="${esc(p.bucket)}" alt=""><button type="button" class="att-remove" data-sc="rm-old" data-id="${esc(p.id)}" aria-label="Remove photo"><svg class="i"><use href="#i-close"/></svg></button></figure>`),
            ...d.fresh.map(p => `<figure class="pc-thumb"><img src="${p.preview}" alt=""><button type="button" class="att-remove" data-sc="rm-new" data-id="${p.id}" aria-label="Remove photo"><svg class="i"><use href="#i-close"/></svg></button></figure>`)].join('');

        const paint = () => {
            const t = d.target;
            dlg.innerHTML = `
                <form class="rx-card sched-form" novalidate>
                    <header class="rx-head"><h2 id="sched-title">${item ? 'Edit scheduled post' : 'Schedule'}</h2><button type="button" class="icon-btn" data-sc="close" aria-label="Close"><svg class="i"><use href="#i-close"/></svg></button></header>
                    <div class="sched-scroll">
                        ${targetSeg()}
                        ${t === 'group' ? `<label class="field"><span>Group</span><select name="community">${groups.map(g => `<option value="${esc(g.id)}"${g.id === d.communityId ? ' selected' : ''}>${esc(g.emoji || '')} ${esc(g.name)}</option>`).join('')}</select></label>` : ''}
                        ${t === 'message' ? `<label class="field"><span>To</span><select name="recipient">${s.friends.map(f => `<option value="${esc(f.id)}"${f.id === d.recipient ? ' selected' : ''}>${esc(f.display_name)} (@${esc(f.username)})</option>`).join('')}</select></label>` : ''}
                        ${t !== 'message' ? `<label class="field"><span>Title <small class="muted">optional</small></span><input name="title" maxlength="200" value="${esc(d.title)}" placeholder="${t === 'group' ? 'e.g. Meeting this Friday' : 'Give it a heading'}"></label>` : ''}
                        <label class="field"><span>${t === 'message' ? 'Message' : 'Post'}</span><textarea name="body" rows="5" maxlength="${t === 'message' ? 4000 : 5000}" placeholder="${t === 'message' ? 'Write your message…' : 'What do you want to share?'}">${esc(d.body)}</textarea></label>
                        ${t !== 'message' ? `
                            <div class="sched-photos">
                                <div class="pc-photos">${photosHTML()}</div>
                                <button type="button" class="chip" data-sc="photos"${d.photos.length + d.fresh.length >= MAX_PHOTOS ? ' disabled' : ''}><svg class="i"><use href="#i-image"/></svg>Add photos</button>
                            </div>` : ''}
                        ${t === 'feed' ? `<div class="field"><span>Who can see it</span><div class="sched-seg small" role="radiogroup" aria-label="Who can see it">
                            ${[['friends', 'i-lock', 'Friends'], ['public', 'i-globe', 'Everyone']].map(([v, icon, l]) => `<button type="button" role="radio" aria-checked="${d.audience === v}" data-sc="audience" data-v="${v}"><svg class="i"><use href="#${icon}"/></svg>${l}</button>`).join('')}</div></div>` : ''}
                        ${t === 'group' ? `<label class="sched-check"><input type="checkbox" name="announce"${d.announce ? ' checked' : ''}><span><strong>Post as an announcement</strong><small>Pinned to the top of the group if you’re an admin or moderator</small></span></label>` : ''}
                        <div class="field"><span>When</span>
                            <div class="sched-quick">${quickTimes().map(([l, at]) => `<button type="button" class="chip" data-sc="quick" data-at="${at.toISOString()}">${l}</button>`).join('')}</div>
                            <input type="datetime-local" name="when" value="${toLocalInput(d.when)}" min="${toLocalInput(new Date(Date.now() + 60e3))}" required>
                            <small class="muted sched-when-text">${esc(whenText(d.when))} · ${esc(Intl.DateTimeFormat().resolvedOptions().timeZone || '')}</small>
                        </div>
                    </div>
                    <footer class="sched-foot">
                        <button type="button" class="ghost-btn" data-sc="draft">Save draft</button>
                        <button type="submit" class="primary-btn">${item && item.status === 'scheduled' ? 'Save changes' : 'Schedule'}</button>
                    </footer>
                </form>`;
            hydrateStorage(dlg);
        };
        // Keep what's typed when the form is redrawn
        const capture = () => {
            const f = dlg.querySelector('form');
            if (!f) return;
            if (f.title) d.title = f.title.value;
            if (f.body) d.body = f.body.value;
            if (f.community) d.communityId = f.community.value;
            if (f.recipient) d.recipient = f.recipient.value;
            if (f.announce) d.announce = f.announce.checked;
            if (f.when && f.when.value) d.when = new Date(f.when.value);
        };
        paint();
        dlg.showModal();
        const close = () => { d.fresh.forEach(p => URL.revokeObjectURL(p.preview)); if (dlg.open) dlg.close(); };
        dlg.addEventListener('close', () => dlg.remove());
        dlg.addEventListener('input', e => {
            if (e.target.name === 'when' && e.target.value) {
                d.when = new Date(e.target.value);
                const tx = dlg.querySelector('.sched-when-text');
                if (tx) tx.textContent = `${whenText(d.when)} · ${Intl.DateTimeFormat().resolvedOptions().timeZone || ''}`;
            }
        });
        dlg.addEventListener('click', async e => {
            if (e.target === dlg) return close();
            const b = e.target.closest('[data-sc]');
            if (!b) return;
            const act = b.dataset.sc;
            if (act === 'close') return close();
            capture();
            if (act === 'target') {
                if (b.dataset.v !== d.target && d.photos.length && (b.dataset.v === 'message' || bucketFor(b.dataset.v) !== bucketFor(d.target))) {
                    d.photos = []; // photos already uploaded for one place can't move to another
                }
                d.target = b.dataset.v;
                paint();
            } else if (act === 'audience') {
                d.audience = b.dataset.v;
                paint();
            } else if (act === 'quick') {
                d.when = new Date(b.dataset.at);
                paint();
            } else if (act === 'photos') {
                const files = await Media.pickFiles('image/*');
                for (const file of files) {
                    if (d.photos.length + d.fresh.length >= MAX_PHOTOS) { app.showToast(`Up to ${MAX_PHOTOS} photos`); break; }
                    d.fresh.push({ id: Math.random().toString(36).slice(2), file, preview: URL.createObjectURL(file) });
                }
                paint();
            } else if (act === 'rm-old') {
                d.photos = d.photos.filter(p => p.id !== b.dataset.id);
                paint();
            } else if (act === 'rm-new') {
                const p = d.fresh.find(x => x.id === b.dataset.id);
                if (p) URL.revokeObjectURL(p.preview);
                d.fresh = d.fresh.filter(x => x.id !== b.dataset.id);
                paint();
            } else if (act === 'draft') {
                save('draft');
            }
        });
        dlg.addEventListener('submit', e => { e.preventDefault(); capture(); save('scheduled'); });

        async function save(status) {
            const body = d.body.trim();
            const title = d.target === 'message' ? '' : d.title.trim();
            if (status === 'scheduled') {
                if (!body && !title && !d.photos.length && !d.fresh.length) return app.showToast('Write something or add a photo first');
                if (!(d.when instanceof Date) || isNaN(d.when)) return app.showToast('Choose a date and time');
                if (d.when.getTime() < Date.now() + 30e3) return app.showToast('Pick a time at least a minute from now — or use Post now');
                if (d.when.getTime() > Date.now() + 365 * 864e5) return app.showToast('You can schedule up to a year ahead');
            }
            if (d.target === 'group' && !d.communityId) return app.showToast('Choose a group');
            if (d.target === 'message' && !d.recipient) return app.showToast('Choose who to message');
            const btns = dlg.querySelectorAll('footer button');
            btns.forEach(x => { x.disabled = true; });
            const fail = msg => { btns.forEach(x => { x.disabled = false; }); app.showToast(msg); };
            // Upload new photos now, so publishing later needs nothing from this phone
            let photos = d.target === 'message' ? [] : d.photos.map(({ id, path, name }) => ({ id, path, name }));
            if (d.target !== 'message' && d.fresh.length) {
                const prefix = d.target === 'group' ? `${d.communityId}/${me()}` : `${me()}/sched`;
                for (const p of d.fresh) {
                    const path = await I.uploadImage(bucketFor(d.target), `${prefix}/${I.randomId()}`, p.file);
                    if (!path) return fail('A photo couldn’t upload — try again or remove it');
                    photos.push({ id: p.id, path, name: String(p.file.name || '').slice(0, 120) });
                }
            }
            const row = {
                target: d.target,
                community_id: d.target === 'group' ? d.communityId : null,
                recipient: d.target === 'message' ? d.recipient : null,
                title, body, photos,
                audience: d.target === 'feed' ? d.audience : 'friends',
                announce: d.target === 'group' && d.announce,
                publish_at: status === 'scheduled' || d.when ? d.when.toISOString() : null,
                status
            };
            const { error } = item
                ? await client.from('diary_scheduled').update(row).eq('id', item.id)
                : await client.from('diary_scheduled').insert(row);
            if (error) return fail(/member|friend/i.test(error.message || '') ? 'You can only post to your groups and message friends' : 'Couldn’t save that — please try again');
            d.fresh.forEach(p => URL.revokeObjectURL(p.preview));
            d.fresh = [];
            if (opts.onSaved) opts.onSaved();
            close();
            app.showToast(status === 'draft' ? 'Saved to drafts' : `Scheduled for ${whenText(d.when).replace(/^T/, 't')}`);
            S.tab = status === 'draft' ? 'drafts' : 'scheduled';
            load();
        }
    }

    // ---------- Actions on the list ----------
    async function publishNow(x) {
        const ok = await app.ask({ title: x.target === 'message' ? 'Send this message now?' : 'Post this now?', text: 'It goes out straight away instead of at the scheduled time.', ok: x.target === 'message' ? 'Send now' : 'Post now' });
        if (!ok) return;
        const { error } = await client.rpc('diary_publish_now', { p_id: x.id });
        if (error) { app.showToast(error.message || 'Couldn’t publish that'); return load(); }
        app.showToast(x.target === 'message' ? 'Sent' : 'Posted');
        s.feed = null;
        load();
    }
    async function setStatus(x, status, toast) {
        const patch = { status };
        if (status === 'scheduled' && (!x.publish_at || Date.parse(x.publish_at) < Date.now() + 30e3)) return open({ item: x });
        const { error } = await client.from('diary_scheduled').update(patch).eq('id', x.id);
        if (error) return app.showToast('Couldn’t update that');
        app.showToast(toast);
        load();
    }
    async function remove(x) {
        const ok = await app.ask({ title: 'Delete this?', text: x.status === 'published' ? 'This only removes it from this list — what was posted stays up.' : 'It won’t be posted.', ok: 'Delete', danger: true });
        if (!ok) return;
        const { error } = await client.from('diary_scheduled').delete().eq('id', x.id);
        if (error) return app.showToast('Couldn’t delete that');
        // Photos only this draft used can go too
        if (x.status !== 'published' && x.photos && x.photos.length) client.storage.from(bucketFor(x.target)).remove(x.photos.map(p => p.path)).catch(() => {});
        S.list = (S.list || []).filter(y => y.id !== x.id);
        app.render();
    }
    function viewPublished(x) {
        if (x.target === 'feed') { app.setView('feed'); I.openEntry(x.published_ref); }
        else if (x.target === 'group') app.setView('post', { postId: `g-${x.published_ref}` });
        else { app.setView('messages'); if (I.openChat) I.openChat(x.recipient); }
    }

    // ---------- The page ----------
    function where(x) {
        if (x.target === 'group') {
            const g = (S.groups || []).find(c => c.id === x.community_id);
            return `<svg class="i"><use href="#i-users"/></svg>${esc(g ? `${g.emoji || ''} ${g.name}` : 'Group')}${x.announce ? ' · Announcement' : ''}`;
        }
        if (x.target === 'message') {
            const f = s.friends.find(p => p.id === x.recipient);
            return `<svg class="i"><use href="#i-chat"/></svg>Message to ${esc(f ? f.display_name : 'a friend')}`;
        }
        return `<svg class="i"><use href="#${x.audience === 'public' ? 'i-globe' : 'i-lock'}"/></svg>Feed · ${x.audience === 'public' ? 'Everyone' : 'Friends'}`;
    }
    function rowHTML(x) {
        const st = x.status;
        const when = st === 'scheduled' ? whenText(x.publish_at)
            : st === 'published' ? `Posted ${timeAgo(x.updated_at)}`
            : st === 'draft' ? `Draft · edited ${timeAgo(x.updated_at)}`
            : st === 'failed' ? 'Didn’t go out' : 'Cancelled';
        const btn = (act, label, cls = '') => `<button type="button" class="chip ${cls}" data-sched="${act}" data-id="${esc(x.id)}">${label}</button>`;
        let actions = '';
        if (st === 'scheduled') actions = btn('edit', 'Edit') + btn('now', x.target === 'message' ? 'Send now' : 'Post now') + btn('draft', 'Move to drafts') + btn('cancel', 'Cancel', 'danger');
        else if (st === 'draft') actions = btn('edit', 'Edit & schedule', 'accent') + btn('now', x.target === 'message' ? 'Send now' : 'Post now') + btn('delete', 'Delete', 'danger');
        else if (st === 'published') actions = (x.published_ref ? btn('view', 'View') : '') + btn('delete', 'Remove from list');
        else actions = btn('edit', 'Edit & reschedule', 'accent') + btn('delete', 'Delete', 'danger');
        const photo = (x.photos || [])[0];
        return `
            <article class="sched-row s-${st}">
                <div class="sched-main">
                    <p class="sched-where">${where(x)}</p>
                    ${x.title ? `<h3>${esc(x.title)}</h3>` : ''}
                    <p class="sched-body">${esc((x.body || '').slice(0, 280)) || '<span class="muted">📷 Photos</span>'}</p>
                    <p class="sched-when"><svg class="i"><use href="#${st === 'failed' ? 'i-alert' : st === 'published' ? 'i-check' : 'i-clock'}"/></svg>${esc(when)}${(x.photos || []).length ? ` · ${x.photos.length} photo${x.photos.length === 1 ? '' : 's'}` : ''}</p>
                    ${st === 'failed' && x.error ? `<p class="sched-error">${esc(x.error)}</p>` : ''}
                    <div class="sched-actions">${actions}</div>
                </div>
                ${photo ? `<img class="sched-thumb" data-path="${esc(photo.path)}" data-bucket="${bucketFor(x.target)}" alt="">` : ''}
            </article>`;
    }

    app.views.scheduled = () => {
        app.setTitle('Scheduled');
        const blocked = I.gate('Schedule posts, group announcements and messages to go out later.');
        if (blocked) return blocked;
        if (S.list === null) { load(); return '<div class="sched-page"><div class="post-skel"><i class="sk-line w40"></i><i class="sk-line"></i><i class="sk-line w70"></i></div></div>'; }
        const groups = {
            scheduled: upcoming().sort((a, b) => Date.parse(a.publish_at) - Date.parse(b.publish_at)),
            drafts: S.list.filter(x => x.status === 'draft'),
            sent: S.list.filter(x => x.status === 'published').sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at)),
            notsent: S.list.filter(x => x.status === 'failed' || x.status === 'cancelled')
        };
        const tabs = [['scheduled', 'Scheduled'], ['drafts', 'Drafts'], ['sent', 'Sent'], ['notsent', 'Not sent']];
        const list = groups[S.tab] || [];
        const empty = {
            scheduled: ['Nothing scheduled', 'Write a post, a group announcement or a message now and pick when it goes out — even if your phone is off.'],
            drafts: ['No drafts', 'Save something as a draft to finish it later.'],
            sent: ['Nothing sent yet', 'Scheduled posts show here once they’re out.'],
            notsent: ['All good', 'Anything that couldn’t go out or that you cancelled shows here.']
        }[S.tab];
        return `
            <div class="sched-page">
                <header class="sched-head">
                    <div><h2>Scheduled</h2><p class="muted small">Posts, announcements and messages that go out later. Times are in your time zone.</p></div>
                    <button type="button" class="primary-btn" data-sched="new"><svg class="i"><use href="#i-plus"/></svg>New</button>
                </header>
                <div class="pf-tabs sched-tabs" role="tablist" aria-label="Scheduled posts">${tabs.map(([k, l]) =>
                    `<button type="button" role="tab" class="pf-tab" data-sched="tab" data-tab="${k}" aria-selected="${S.tab === k}">${l}${groups[k].length ? ` <span class="sched-n">${groups[k].length}</span>` : ''}</button>`).join('')}</div>
                ${S.error ? '<p class="ps-note">Couldn’t load your scheduled posts. Check your connection.</p>' : ''}
                <div class="sched-list">${list.map(rowHTML).join('') || `<div class="empty small"><p class="empty-title">${empty[0]}</p><p>${empty[1]}</p></div>`}</div>
            </div>`;
    };

    content.addEventListener('click', e => {
        const b = e.target.closest('[data-sched]');
        if (!b || app.state.view !== 'scheduled') return;
        const x = (S.list || []).find(y => y.id === b.dataset.id);
        const act = b.dataset.sched;
        if (act === 'tab') { S.tab = b.dataset.tab; app.render(); return; }
        if (act === 'new') return open();
        if (!x) return;
        if (act === 'edit') open({ item: x });
        else if (act === 'now') publishNow(x);
        else if (act === 'draft') setStatus(x, 'draft', 'Moved to drafts');
        else if (act === 'cancel') setStatus(x, 'cancelled', 'Cancelled — it won’t be posted');
        else if (act === 'delete') remove(x);
        else if (act === 'view') viewPublished(x);
    });

    // Entry points elsewhere: the feed composer, a group's composer, a chat
    Object.assign(app.actions, {
        'feed-schedule': () => {
            const text = document.getElementById('feed-text');
            const draft = s.feedDraft || {};
            open({ target: 'feed', body: (text && text.value) || draft.text || '', audience: s.feedAudience, files: (draft.photos || []).map(p => p.file),
                onSaved: () => { s.feedDraft = { text: '', photos: [], audience: null }; if (text) text.value = ''; app.render(); } });
        },
        'cm-schedule': () => {
            const text = document.getElementById('cm-text');
            const cm = window.diaryCommunities && window.diaryCommunities.current && window.diaryCommunities.current();
            open({ target: 'group', communityId: cm && cm.id, body: (text && text.value) || '', onSaved: () => { if (text) text.value = ''; } });
        },
        'go-scheduled': () => app.setView('scheduled')
    });

    const previousMenu = app.hooks.menuItems;
    app.hooks.menuItems = () => [
        ...(previousMenu ? previousMenu() : []),
        ...(me() ? [{ label: 'Scheduled posts', icon: 'i-clock', onClick: () => app.setView('scheduled') }] : [])
    ];

    // Refresh when the server publishes something (the notification arrives over realtime)
    window.diarySchedule = {
        open, refresh: load,
        chatSchedule: friendId => open({ target: 'message', recipient: friendId }),
        count: () => upcoming().length
    };
    app.onRefresh && app.onRefresh('scheduled', load);
    setInterval(() => { if (me() && S.list === null) load(); }, 4000);
});
