// Chat tools shared by one-to-one chats and group chats: search inside a conversation, the shared media /
// files / links gallery, forwarding messages, "who reacted", and notification sounds.
// Each tool gets a small adapter describing the conversation, so the same screens work for both kinds.
document.addEventListener('DOMContentLoaded', () => {
    const app = window.diaryApp;
    const social = window.diarySocial;
    if (!app || !social || !social.internals) return;
    const I = social.internals;
    const { client, state: s, esc, avatar, timeAgo, hydrateStorage, randomId } = I;

    const URL_RE = /\bhttps?:\/\/[^\s<>"']+/gi;
    const likeEscape = q => q.replace(/[\\%_]/g, m => `\\${m}`);
    const textOf = (conv, m) => (conv.kind === 'dm' ? Rich.toText(m.body || '') : String(m.body || '')).trim();

    // One sheet (a <dialog>) reused by every tool
    let dlg = null;
    function sheet(cls) {
        if (!dlg) {
            dlg = document.createElement('dialog');
            dlg.className = 'ct-sheet';
            document.body.append(dlg);
            dlg.addEventListener('click', e => {
                if (e.target === dlg || e.target.closest('[data-ct-close]')) dlg.close();
            });
        }
        dlg.dataset.tool = cls;
        return dlg;
    }
    const head = (title, extra = '') => `
        <header class="ct-head"><strong>${esc(title)}</strong>${extra}
            <button type="button" class="icon-btn" data-ct-close aria-label="Close"><svg class="i"><use href="#i-close"/></svg></button></header>`;

    // ---------- Conversation queries ----------
    // conv = { kind: 'dm', friendId } | { kind: 'gc', communityId }
    function baseQuery(conv) {
        const me = s.profile.id;
        if (conv.kind === 'dm') {
            return client.from('diary_messages').select('*')
                .or(`and(sender.eq.${me},recipient.eq.${conv.friendId}),and(sender.eq.${conv.friendId},recipient.eq.${me})`)
                .is('deleted_at', null);
        }
        return client.from('diary_community_messages')
            .select('id, community_id, author, body, attachments, reply_to, created_at, deleted_at, deleted_by, edited_at, restored_at, forwarded')
            .eq('community_id', conv.communityId).is('deleted_at', null);
    }
    const authorOf = (conv, m) => (conv.kind === 'dm' ? m.sender : m.author);
    const bucketOf = conv => (conv.kind === 'dm' ? 'diary-chat' : 'diary-community');

    // ---------- Search ----------
    const TYPES = [['all', 'All'], ['image', 'Photos'], ['audio', 'Voice'], ['file', 'Files'], ['link', 'Links'], ['location', 'Places']];
    function openSearch(conv) {
        const d = sheet('search');
        const people = conv.people(); // [{ id, name }]
        d.innerHTML = `
            <div class="ct-card ct-search">
                ${head(conv.kind === 'dm' ? 'Search this chat' : 'Search this group')}
                <label class="search ct-q"><svg class="i"><use href="#i-search"/></svg>
                    <input type="search" id="ct-q" placeholder="Search messages" autocomplete="off" enterkeyhint="search"></label>
                <div class="ct-filters">
                    <div class="ct-chips" role="group" aria-label="Type">${TYPES.map(([k, l], i) => `<button type="button" class="cm-filter" aria-pressed="${i === 0}" data-type="${k}">${l}</button>`).join('')}</div>
                    <div class="ct-row">
                        <label><span>From</span><select id="ct-who"><option value="">Anyone</option>${people.map(p => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('')}</select></label>
                        <label><span>After</span><input type="date" id="ct-from"></label>
                        <label><span>Before</span><input type="date" id="ct-to"></label>
                    </div>
                </div>
                <div class="ct-results" id="ct-results" aria-live="polite"><p class="muted small">Type a word, or pick a filter.</p></div>
            </div>`;
        if (!d.open) d.showModal();
        const state = { type: 'all', timer: null, seq: 0 };
        const run = () => { clearTimeout(state.timer); state.timer = setTimeout(() => search(conv, state), 250); };
        d.querySelector('#ct-q').addEventListener('input', run);
        d.querySelectorAll('#ct-who, #ct-from, #ct-to').forEach(el => el.addEventListener('change', run));
        d.querySelector('.ct-chips').addEventListener('click', e => {
            const b = e.target.closest('[data-type]');
            if (!b) return;
            state.type = b.dataset.type;
            d.querySelectorAll('.ct-chips [data-type]').forEach(x => x.setAttribute('aria-pressed', String(x === b)));
            run();
        });
        d.querySelector('#ct-results').onclick = e => {
            const hit = e.target.closest('[data-hit]');
            if (!hit) return;
            d.close();
            conv.jump(Number(hit.dataset.hit), hit.dataset.at);
        };
        setTimeout(() => d.querySelector('#ct-q').focus(), 50);
    }

    async function search(conv, st) {
        const seq = ++st.seq;
        const box = document.getElementById('ct-results');
        const q = document.getElementById('ct-q').value.trim();
        const who = document.getElementById('ct-who').value;
        const from = document.getElementById('ct-from').value;
        const to = document.getElementById('ct-to').value;
        if (!q && st.type === 'all' && !who && !from && !to) {
            box.innerHTML = '<p class="muted small">Type a word, or pick a filter.</p>';
            return;
        }
        box.innerHTML = '<p class="muted small">Searching…</p>';
        let query = baseQuery(conv);
        if (q) query = query.ilike('body', `%${likeEscape(q)}%`);
        if (st.type === 'link') query = query.ilike('body', '%http%');
        else if (st.type !== 'all') query = query.contains('attachments', [{ kind: st.type }]);
        if (who) query = query.eq(conv.kind === 'dm' ? 'sender' : 'author', who);
        if (from) query = query.gte('created_at', new Date(`${from}T00:00:00`).toISOString());
        if (to) query = query.lte('created_at', new Date(`${to}T23:59:59`).toISOString());
        const { data, error } = await query.order('created_at', { ascending: false }).limit(100);
        if (seq !== st.seq) return;
        if (error) { box.innerHTML = '<p class="muted small">Couldn’t search right now.</p>'; return; }
        // HTML bodies can match inside tags: keep only real text matches
        const rows = (data || []).filter(m => !q || textOf(conv, m).toLowerCase().includes(q.toLowerCase()));
        if (!rows.length) { box.innerHTML = '<p class="muted small">No messages found.</p>'; return; }
        const mark = t => {
            const safe = esc(t.length > 160 ? `${t.slice(0, 160)}…` : t);
            if (!q) return safe;
            const re = new RegExp(esc(q).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
            return safe.replace(re, x => `<mark>${x}</mark>`);
        };
        box.innerHTML = `<p class="muted small">${rows.length === 100 ? '100+' : rows.length} ${rows.length === 1 ? 'message' : 'messages'}</p>` + rows.map(m => {
            const a = (m.attachments || [])[0];
            const label = textOf(conv, m) || (a ? ({ image: '📷 Photo', drawing: '🎨 Drawing', audio: '🎤 Voice note', file: `📎 ${a.name || 'File'}`, location: '📍 Location' }[a.kind] || '📎 Attachment') : '');
            return `
                <button type="button" class="ct-hit" data-hit="${m.id}" data-at="${esc(m.created_at)}">
                    <span class="ct-hit-top"><strong>${esc(conv.nameOf(authorOf(conv, m)))}</strong><time>${esc(new Date(m.created_at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }))}</time></span>
                    <span class="ct-hit-text">${mark(label)}</span>
                </button>`;
        }).join('');
    }

    // ---------- Shared media, voice, files & links ----------
    const GALLERY = [['media', 'Media'], ['audio', 'Voice'], ['file', 'Files'], ['link', 'Links']];
    async function openGallery(conv, tab = 'media') {
        const d = sheet('gallery');
        d.innerHTML = `
            <div class="ct-card ct-gallery">
                ${head(conv.kind === 'dm' ? 'Shared in this chat' : 'Shared in this group')}
                <div class="ct-chips" role="tablist">${GALLERY.map(([k, l]) => `<button type="button" class="cm-filter" role="tab" aria-selected="${k === tab}" aria-pressed="${k === tab}" data-tab="${k}">${l}</button>`).join('')}</div>
                <div class="ct-gal" id="ct-gal"><p class="muted small">Loading…</p></div>
            </div>`;
        if (!d.open) d.showModal();
        d.querySelector('.ct-chips').onclick = e => {
            const b = e.target.closest('[data-tab]');
            if (b) openGallery(conv, b.dataset.tab);
        };
        const [withAtts, withLinks] = await Promise.all([
            baseQuery(conv).neq('attachments', '[]').order('created_at', { ascending: false }).limit(300),
            tab === 'link' ? baseQuery(conv).ilike('body', '%http%').order('created_at', { ascending: false }).limit(200) : Promise.resolve({ data: [] })
        ]);
        const box = document.getElementById('ct-gal');
        if (!box || d.dataset.tool !== 'gallery') return;
        const items = [];
        (withAtts.data || []).forEach(m => (m.attachments || []).forEach(a => items.push({ m, a })));
        const bucket = bucketOf(conv);
        let html = '';
        if (tab === 'media') {
            const media = items.filter(x => ['image', 'drawing'].includes(x.a.kind) && x.a.path);
            html = media.length ? `<div class="ct-grid">${media.map(({ m, a }) => `
                <figure class="ct-tile">
                    <button type="button" class="ct-img" data-view="${esc(a.path)}" aria-label="Open photo"><img data-path="${esc(a.path)}" data-bucket="${bucket}" alt="" loading="lazy"></button>
                    <figcaption><button type="button" class="ct-mini" data-download="${esc(a.path)}" data-name="${esc(a.name || 'photo.jpg')}" aria-label="Download"><svg class="i"><use href="#i-download"/></svg></button>
                    ${navigator.share ? `<button type="button" class="ct-mini" data-share="${esc(a.path)}" data-name="${esc(a.name || 'photo.jpg')}" aria-label="Share"><svg class="i"><use href="#i-send"/></svg></button>` : ''}
                    <button type="button" class="ct-mini" data-goto="${m.id}" data-at="${esc(m.created_at)}" aria-label="Show in chat"><svg class="i"><use href="#i-chat"/></svg></button></figcaption>
                </figure>`).join('')}</div>` : '<p class="muted small">Photos you share here appear in this tab.</p>';
        } else if (tab === 'audio') {
            const voice = items.filter(x => x.a.kind === 'audio' && x.a.path);
            html = voice.length ? voice.map(({ m, a }) => `
                <div class="ct-line"><span class="ct-line-top">${esc(conv.nameOf(authorOf(conv, m)))} · ${esc(timeAgo(m.created_at))}
                    <button type="button" class="ct-mini" data-goto="${m.id}" data-at="${esc(m.created_at)}" aria-label="Show in chat"><svg class="i"><use href="#i-chat"/></svg></button></span>
                    ${I.voiceHTML(a, bucket)}</div>`).join('') : '<p class="muted small">Voice notes appear here.</p>';
        } else if (tab === 'file') {
            const files = items.filter(x => x.a.kind === 'file' && x.a.path);
            html = files.length ? files.map(({ m, a }) => `
                <div class="ct-line ct-file"><svg class="i"><use href="#i-file"/></svg>
                    <span class="ct-file-text"><strong>${esc(a.name || 'File')}</strong><small>${esc(Media.formatSize(a.size || 0))} · ${esc(conv.nameOf(authorOf(conv, m)))} · ${esc(timeAgo(m.created_at))}</small></span>
                    <button type="button" class="ct-mini" data-download="${esc(a.path)}" data-name="${esc(a.name || 'file')}" aria-label="Download"><svg class="i"><use href="#i-download"/></svg></button>
                    <button type="button" class="ct-mini" data-goto="${m.id}" data-at="${esc(m.created_at)}" aria-label="Show in chat"><svg class="i"><use href="#i-chat"/></svg></button></div>`).join('') : '<p class="muted small">Documents and PDFs appear here.</p>';
        } else {
            const links = [];
            (withLinks.data || []).forEach(m => (textOf(conv, m).match(URL_RE) || []).forEach(url => links.push({ m, url })));
            html = links.length ? links.map(({ m, url }) => {
                let host = url;
                try { host = new URL(url).hostname.replace(/^www\./, ''); } catch (e) {}
                return `<div class="ct-line ct-link"><span class="ct-link-ic">${esc(host.slice(0, 1).toUpperCase())}</span>
                    <a href="${esc(url)}" target="_blank" rel="noopener noreferrer"><strong>${esc(host)}</strong><small>${esc(url.length > 70 ? `${url.slice(0, 70)}…` : url)}</small></a>
                    <button type="button" class="ct-mini" data-goto="${m.id}" data-at="${esc(m.created_at)}" aria-label="Show in chat"><svg class="i"><use href="#i-chat"/></svg></button></div>`;
            }).join('') : '<p class="muted small">Links people share appear here.</p>';
        }
        box.innerHTML = html;
        hydrateStorage(box);
        box.onclick = async e => {
            const go = e.target.closest('[data-goto]');
            if (go) { d.close(); return conv.jump(Number(go.dataset.goto), go.dataset.at); }
            const view = e.target.closest('[data-view]');
            if (view) {
                const img = view.querySelector('img');
                if (img && img.src) {
                    if (window.ZoomViewer) window.ZoomViewer.open([img.src], { origin: img });
                    else Media.lightbox(img.src);
                }
                return;
            }
            const dl = e.target.closest('[data-download]');
            if (dl) return download(bucket, dl.dataset.download, dl.dataset.name);
            const sh = e.target.closest('[data-share]');
            if (sh) return shareFile(bucket, sh.dataset.share, sh.dataset.name);
            // Voice notes play here too
            const act = e.target.closest('[data-action]');
            if (act && app.actions[act.dataset.action]) app.actions[act.dataset.action](act, e);
        };
    }

    async function fetchBlob(bucket, path) {
        const { data, error } = await client.storage.from(bucket).download(path);
        if (error || !data) throw new Error('download');
        return data;
    }

    async function download(bucket, path, name) {
        try {
            const blob = await fetchBlob(bucket, path);
            const a = document.createElement('a');
            a.href = URL.createObjectURL(blob);
            a.download = name || path.split('/').pop();
            a.click();
            setTimeout(() => URL.revokeObjectURL(a.href), 2000);
        } catch (e) {
            app.showToast('Couldn’t download that');
        }
    }

    async function shareFile(bucket, path, name) {
        try {
            const blob = await fetchBlob(bucket, path);
            const file = new File([blob], name || 'photo.jpg', { type: blob.type });
            if (navigator.canShare && navigator.canShare({ files: [file] })) await navigator.share({ files: [file] });
            else app.showToast('Sharing files isn’t supported on this device — use Download');
        } catch (e) {
            if (e && e.name !== 'AbortError') app.showToast('Couldn’t share that');
        }
    }

    // ---------- Forward ----------
    // msgs: [{ kind: 'dm' | 'gc', body, attachments }] from one conversation; targets: friends and your groups
    async function openForward(source) {
        const d = sheet('forward');
        const groups = window.diaryCommunities && window.diaryCommunities.all ? (await window.diaryCommunities.all().catch(() => [])).filter(g => g.joined) : [];
        const people = s.friends.map(f => ({ key: `dm:${f.id}`, name: f.display_name, sub: `@${f.username}`, html: avatar(f, 'md') }));
        const places = groups.map(g => ({ key: `gc:${g.id}`, name: g.name, sub: 'Group chat', html: `<span class="ct-group-emoji">${esc(g.emoji || '💬')}</span>` }));
        const all = [...people, ...places];
        d.innerHTML = `
            <div class="ct-card ct-forward">
                ${head('Forward to…')}
                <label class="search ct-q"><svg class="i"><use href="#i-search"/></svg><input type="search" id="ct-fq" placeholder="Search friends and groups" autocomplete="off"></label>
                <div class="ct-targets" id="ct-targets">${all.length ? all.map(t => `
                    <label class="ct-target" data-name="${esc(t.name.toLowerCase())}">
                        <input type="checkbox" value="${esc(t.key)}">
                        ${t.html}<span><strong>${esc(t.name)}</strong><small>${esc(t.sub)}</small></span>
                    </label>`).join('') : '<p class="muted small">Add friends or join a group to forward messages.</p>'}</div>
                <footer class="ct-foot"><button type="button" class="primary-btn block" id="ct-send" disabled>Forward</button></footer>
            </div>`;
        if (!d.open) d.showModal();
        const count = () => d.querySelectorAll('.ct-targets input:checked').length;
        d.querySelector('#ct-targets').addEventListener('change', () => {
            const n = count();
            const btn = d.querySelector('#ct-send');
            btn.disabled = !n;
            btn.textContent = n ? `Forward to ${n}` : 'Forward';
        });
        d.querySelector('#ct-fq').addEventListener('input', e => {
            const q = e.target.value.trim().toLowerCase();
            d.querySelectorAll('.ct-target').forEach(el => { el.hidden = !!q && !el.dataset.name.includes(q); });
        });
        d.querySelector('#ct-send').addEventListener('click', async e => {
            const btn = e.currentTarget;
            const keys = [...d.querySelectorAll('.ct-targets input:checked')].map(x => x.value);
            btn.disabled = true;
            btn.textContent = 'Forwarding…';
            let ok = 0;
            for (const key of keys) if (await forwardTo(key, source)) ok++;
            d.close();
            app.showToast(ok === keys.length ? `Forwarded to ${ok}` : `Forwarded to ${ok} of ${keys.length}`);
            if (source.onDone) source.onDone(keys);
        });
    }

    async function forwardTo(key, source) {
        const [kind, id] = key.split(/:(.+)/);
        const me = s.profile.id;
        const toBucket = kind === 'dm' ? 'diary-chat' : 'diary-community';
        try {
            // Files are copied into the new conversation's own storage (the original stays with its chat)
            const atts = [];
            for (const a of source.attachments || []) {
                if (!a || a.kind === 'location' || !a.path) continue;
                const blob = await fetchBlob(source.bucket, a.path);
                const ext = (a.path.match(/\.[a-z0-9]{1,5}$/i) || [''])[0];
                const path = kind === 'dm' ? `${me}/${id}/${randomId()}${ext}` : `${id}/${me}/${randomId()}${ext}`;
                if (kind === 'gc' && !/^(image|audio)\//.test(blob.type || a.type || '')) continue; // groups take photos and voice notes
                const { error } = await client.storage.from(toBucket).upload(path, blob, { contentType: blob.type || a.type || 'application/octet-stream', upsert: false });
                if (error) continue;
                const { path: _old, ...rest } = a;
                atts.push({ ...rest, path });
            }
            const text = source.kind === 'dm' ? Rich.toText(source.body || '') : String(source.body || '');
            if (!text.trim() && !atts.length) return false;
            if (kind === 'dm') {
                const body = source.kind === 'dm' ? Rich.sanitize(source.body || '') : Rich.textToHTML(text);
                const { error } = await client.from('diary_messages').insert({ recipient: id, body: text.trim() ? body : '', attachments: atts, forwarded: true, client_id: randomId() });
                return !error;
            }
            const { error } = await client.from('diary_community_messages').insert({ community_id: id, body: text.slice(0, 4000), attachments: atts, forwarded: true, client_id: randomId() });
            return !error;
        } catch (e) {
            return false;
        }
    }

    // ---------- Who reacted ----------
    // byEmoji: { '🔥': [userId, …] }
    function whoReacted(byEmoji, nameOf, personOf) {
        const d = sheet('reacts');
        const entries = Object.entries(byEmoji).filter(([, ids]) => ids.length);
        const total = entries.reduce((n, [, ids]) => n + ids.length, 0);
        d.innerHTML = `
            <div class="ct-card">
                ${head(`${total} ${total === 1 ? 'reaction' : 'reactions'}`)}
                <div class="ct-reacts">${entries.map(([e, ids]) => ids.map(id => `
                    <div class="ct-react-row">${avatar(personOf(id), 'sm')}<span>${esc(nameOf(id))}</span><b>${esc(e)}</b></div>`).join('')).join('')}</div>
            </div>`;
        if (!d.open) d.showModal();
    }

    // ---------- Notification sounds (generated; no files) ----------
    const SOUNDS = { chime: [[880, 1175], 0.11, 0.18], pop: [[660], 0.08, 0.09], bell: [[1318, 1760, 1318], 0.14, 0.3], soft: [[523, 659], 0.16, 0.22] };
    let ctx = null;
    function playSound(name = 'chime') {
        const p = SOUNDS[name];
        if (!p) return;
        try {
            ctx = ctx || new (window.AudioContext || window.webkitAudioContext)();
            const [freqs, gap, len] = p;
            freqs.forEach((f, i) => {
                const at = ctx.currentTime + i * gap;
                const o = ctx.createOscillator();
                const g = ctx.createGain();
                o.type = 'sine';
                o.frequency.value = f;
                g.gain.setValueAtTime(0.0001, at);
                g.gain.exponentialRampToValueAtTime(0.14, at + 0.015);
                g.gain.exponentialRampToValueAtTime(0.0001, at + len);
                o.connect(g).connect(ctx.destination);
                o.start(at);
                o.stop(at + len + 0.02);
            });
        } catch (e) { /* sound is optional */ }
    }

    // ---------- AI helpers (optional, always labelled) ----------
    // task: chat_summary | chat_replies | translate | grammar. The conversation text goes to Cordial's AI
    // function only when you ask; nothing is sent otherwise.
    function transcript(conv, messages, limit = 120) {
        return messages.filter(m => !m.deleted_at).slice(-limit).map(m => {
            const who = conv.nameOf(authorOf(conv, m));
            const t = textOf(conv, m) || ((m.attachments || [])[0] ? `[${(m.attachments[0].kind || 'attachment')}]` : '');
            return `${who}: ${t}`;
        }).join('\n').slice(-18000);
    }

    async function aiSheet(title, payload, { chips = false, onPick = null, onUse = null } = {}) {
        const d = sheet('ai');
        d.innerHTML = `
            <div class="ct-card ct-ai">
                ${head(title, '<span class="ai-badge" title="Written by AI — it can be wrong">✨ AI</span>')}
                <div class="ct-ai-out" id="ct-ai-out" aria-live="polite"><p class="muted small">Thinking…</p></div>
                <p class="muted small">AI can make mistakes — check anything important.</p>
                ${onUse ? '<footer class="ct-foot"><button type="button" class="primary-btn block" id="ct-ai-use" disabled>Use this</button></footer>' : ''}
            </div>`;
        if (!d.open) d.showModal();
        const out = d.querySelector('#ct-ai-out');
        if (!window.diaryAI) { out.innerHTML = '<p>The AI assistant isn’t available.</p>'; return; }
        let final = '';
        try {
            final = await window.diaryAI.stream(payload, text => {
                if (chips) return;
                out.innerHTML = `<p class="ct-ai-text">${esc(text)}</p>`;
            });
        } catch (e) {
            out.innerHTML = `<p>${esc(e.message || 'The assistant isn’t available right now.')}</p>`;
            return;
        }
        if (chips) {
            const list = (window.diaryAI.listOf ? window.diaryAI.listOf(window.diaryAI.tagged(final, 'replies') || final) : final.split('\n'))
                .map(x => x.replace(/^[-*\d.\s]+/, '').trim()).filter(Boolean).slice(0, 4);
            out.innerHTML = list.length ? `<div class="ct-ai-chips">${list.map(r => `<button type="button" class="chip" data-reply="${esc(r)}">${esc(r)}</button>`).join('')}</div>` : `<p class="ct-ai-text">${esc(final)}</p>`;
            out.onclick = e => {
                const b = e.target.closest('[data-reply]');
                if (!b) return;
                d.close();
                if (onPick) onPick(b.dataset.reply);
            };
        }
        const use = d.querySelector('#ct-ai-use');
        if (use) {
            use.disabled = !final.trim();
            use.onclick = () => { d.close(); onUse(final.trim()); };
        }
    }

    function aiSummarise(conv, messages, { unreadOnly = false } = {}) {
        const text = transcript(conv, messages);
        if (!text.trim()) return app.showToast('Nothing to summarise yet');
        aiSheet(unreadOnly ? 'Unread messages, summarised' : 'This chat, summarised', { mode: 'assist', task: 'chat_summary', text, title: unreadOnly ? 'Only the unread messages' : '' });
    }
    function aiReplies(conv, messages, onPick) {
        const text = transcript(conv, messages, 30);
        if (!text.trim()) return app.showToast('Say hello first — there’s nothing to reply to yet');
        aiSheet('Suggested replies', { mode: 'assist', task: 'chat_replies', text, title: `I am ${conv.nameOf(s.profile.id) === 'You' ? s.profile.display_name : conv.nameOf(s.profile.id)}` }, { chips: true, onPick });
    }
    function aiTranslate(text) {
        const lang = (navigator.language || 'en').split('-')[0];
        let name = lang;
        try { name = new Intl.DisplayNames([navigator.language || 'en'], { type: 'language' }).of(lang) || lang; } catch (e) {}
        aiSheet(`Translation (${name})`, { mode: 'assist', task: 'translate', text, title: `Translate into ${name}` });
    }
    function aiGrammar(text, onUse) {
        if (!text.trim()) return app.showToast('Write your message first');
        aiSheet('Improved wording', { mode: 'assist', task: 'grammar', text }, { onUse });
    }

    window.diaryChatTools = { openSearch, openGallery, openForward, whoReacted, playSound, SOUNDS: Object.keys(SOUNDS), download, aiSummarise, aiReplies, aiTranslate, aiGrammar };
});
