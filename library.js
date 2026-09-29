// The Library: stories, books, poems and essays people publish on Cordial.
// Explore what others wrote, publish your own (write it here, upload a PDF/EPUB, or use a note), and read in a calm reader.
document.addEventListener('DOMContentLoaded', () => {
    const app = window.diaryApp;
    const social = window.diarySocial;
    const I = social && social.internals;
    if (!I) return;
    const { client, state: s, esc, avatar, timeAgo, gate, randomId, uploadImage, hydrateStorage } = I;
    const $ = id => document.getElementById(id);
    const content = $('content');

    const BUCKET = 'diary-library';
    const KINDS = { story: 'Story', book: 'Book', poem: 'Poem', essay: 'Essay' };
    const FILE_TYPES = { pdf: 'application/pdf', epub: 'application/epub+zip' };
    const MAX_FILE = 50 * 1048576;
    const FIELDS = `id, author, kind, title, description, genre, words, file_path, file_type, file_size, cover_path, visibility, reads, created_at,
        author_profile:diary_profiles!diary_library_author_fkey(username, display_name, avatar_path),
        likes:diary_library_likes(user_id)`;
    const COVERS = [['#312e81', '#7c3aed'], ['#065f46', '#10b981'], ['#9d174d', '#f472b6'], ['#7c2d12', '#f97316'], ['#1e3a8a', '#38bdf8'], ['#3f3f46', '#a1a1aa'], ['#4c1d95', '#ec4899'], ['#134e4a', '#2dd4bf']];

    const L = {
        userId: null,
        items: null,
        loading: false,
        saved: new Set(),
        tab: 'explore',   // explore | shelf
        kind: 'all',
        query: '',
        open: null,       // item shown in the reader
        draft: null
    };

    window.diaryLibrary = {
        latest: n => (L.items || []).filter(x => x.visibility === 'public').slice(0, n),
        popular: n => (L.items || []).filter(x => x.visibility === 'public')
            .sort((a, b) => (b.likes || []).length - (a.likes || []).length || Date.parse(b.created_at) - Date.parse(a.created_at))
            .slice(0, n),
        open: id => openItem(id),
        publishNote: note => openCompose({ note }),
        cover: item => coverHTML(item)
    };

    // ---------- Data ----------
    setInterval(() => {
        const id = s.profile && s.profile.id;
        if (id !== L.userId) {
            L.userId = id;
            L.items = null;
            L.saved = new Set();
            if (id) load();
        }
    }, 1000);

    async function load() {
        if (L.loading) return;
        L.loading = true;
        const [items, saved] = await Promise.all([
            client.from('diary_library').select(FIELDS).order('created_at', { ascending: false }).limit(150),
            client.from('diary_saved_items').select('item_id').eq('kind', 'book')
        ]);
        L.loading = false;
        L.items = items.error ? [] : items.data;
        L.saved = new Set((saved.data || []).map(r => r.item_id));
        if (['library', 'feed'].includes(app.state.view)) app.render();
    }

    const hearts = x => (x.likes || []).length;
    const readMins = x => Math.max(1, Math.round((x.words || 0) / 220));
    const authorName = x => (x.author === (s.profile && s.profile.id) ? 'You' : (x.author_profile && x.author_profile.display_name) || 'Someone');

    // ---------- Covers: a photo, or a generated typographic cover ----------
    function coverHTML(x, size = '') {
        if (x.cover_path) {
            return `<span class="book-cover ${size}"><img data-path="${esc(x.cover_path)}" data-bucket="${BUCKET}" alt="" loading="lazy"></span>`;
        }
        let h = 0;
        for (const ch of x.id) h = (h * 31 + ch.charCodeAt(0)) | 0;
        const [a, b] = COVERS[Math.abs(h) % COVERS.length];
        return `
            <span class="book-cover gen ${size}" style="--c1:${a};--c2:${b}" aria-hidden="true">
                <span class="gen-kind">${KINDS[x.kind] || 'Story'}</span>
                <span class="gen-title">${esc(x.title)}</span>
                <span class="gen-author">${esc(authorName(x))}</span>
            </span>`;
    }

    function bookCard(x) {
        return `
            <button class="book" data-action="lib-open" data-id="${esc(x.id)}" aria-label="${esc(x.title)} by ${esc(authorName(x))}">
                ${coverHTML(x)}
                <span class="book-title">${esc(x.title)}</span>
                <span class="book-meta">${KINDS[x.kind]}${x.file_type ? ` · ${x.file_type === 'application/pdf' ? 'PDF' : 'EPUB'}` : ` · ${readMins(x)} min`}${hearts(x) ? ` · ♥ ${hearts(x)}` : ''}</span>
            </button>`;
    }

    // ---------- Page ----------
    app.views.library = () => {
        app.setTitle('Library');
        const blocked = gate('Read stories, books and poems from people on Cordial — and publish your own.');
        if (blocked) return blocked;
        if (L.items === null) {
            load();
            return skeleton();
        }
        const me = s.profile.id;
        const tab = (key, label) => `<button class="tab" role="tab" aria-selected="${L.tab === key}" data-action="lib-tab" data-tab="${key}">${label}</button>`;
        return `
            <div class="lib">
                <header class="notes-head lib-head">
                    <div>
                        <h2 class="notes-title">Library</h2>
                        <p class="muted">Stories, books, poems and essays from people on Cordial.</p>
                    </div>
                    <button class="create-post" data-action="lib-new"><svg class="i"><use href="#i-plus"/></svg><span>Publish</span></button>
                </header>
                <div class="tabs" role="tablist">${tab('explore', 'Explore')}${tab('shelf', 'My shelf')}</div>
                ${L.tab === 'shelf' ? shelfTab(me) : exploreTab()}
            </div>`;
    };

    function skeleton() {
        return `<div class="lib"><div class="lib-skel">${'<span class="sk-book"></span>'.repeat(6)}</div></div>`;
    }

    function exploreTab() {
        const q = L.query.trim().toLowerCase();
        const list = L.items.filter(x => (L.kind === 'all' || x.kind === L.kind)
            && (!q || `${x.title} ${x.description} ${x.genre} ${authorName(x)}`.toLowerCase().includes(q)));
        const chip = (key, label) => `<button class="cm-filter" data-action="lib-kind" data-kind="${key}" aria-pressed="${L.kind === key}">${label}</button>`;
        const month = Date.now() - 30 * 86400000;
        const featured = [...list].sort((a, b) =>
            (Date.parse(b.created_at) > month) - (Date.parse(a.created_at) > month) || hearts(b) - hearts(a) || b.reads - a.reads)[0];
        const loved = [...list].filter(x => hearts(x) || x.reads).sort((a, b) => hearts(b) * 3 + b.reads - (hearts(a) * 3 + a.reads)).slice(0, 10);

        return `
            <div class="lib-tools">
                <label class="search lib-search"><svg class="i"><use href="#i-search"/></svg>
                    <input type="search" id="lib-search" value="${esc(L.query)}" placeholder="Search stories, books, poems" aria-label="Search the library" enterkeyhint="search"></label>
                <div class="cm-filters lib-kinds" role="group" aria-label="Kind">
                    ${chip('all', 'All')}${chip('story', 'Stories')}${chip('book', 'Books')}${chip('poem', 'Poems')}${chip('essay', 'Essays')}
                </div>
            </div>
            ${!list.length ? `
                <div class="empty lib-empty">
                    <p class="empty-title">${L.items.length ? 'Nothing matches that yet' : 'The shelves are empty — for now'}</p>
                    <p>${L.items.length ? 'Try another word or category.' : 'Be the first to publish a story, a poem or a whole book.'}</p>
                    <button class="primary-btn" data-action="lib-new">Publish something</button>
                </div>` : `
                ${featured && !q ? `
                    <button class="lib-feature" data-action="lib-open" data-id="${esc(featured.id)}">
                        ${coverHTML(featured, 'lg')}
                        <span class="lib-feature-text">
                            <span class="lib-eyebrow">Featured ${KINDS[featured.kind].toLowerCase()}</span>
                            <strong>${esc(featured.title)}</strong>
                            <span class="lib-feature-meta">by ${esc(authorName(featured))} · ${featured.file_type ? (featured.file_type === 'application/pdf' ? 'PDF' : 'EPUB') : `${readMins(featured)} min read`}</span>
                            ${featured.description ? `<span class="lib-feature-desc">${esc(featured.description)}</span>` : ''}
                            <span class="lib-feature-cta">Start reading</span>
                        </span>
                    </button>` : ''}
                <section class="lib-shelf">
                    <div class="section-head"><h2>${q ? 'Results' : 'New arrivals'}</h2></div>
                    <div class="lib-row">${list.slice(0, q ? 60 : 12).map(bookCard).join('')}</div>
                </section>
                ${!q && loved.length ? `
                    <section class="lib-shelf">
                        <div class="section-head"><h2>Most loved</h2></div>
                        <div class="lib-row">${loved.map(bookCard).join('')}</div>
                    </section>` : ''}
                ${!q && list.length > 12 ? `
                    <section class="lib-shelf">
                        <div class="section-head"><h2>Everything</h2></div>
                        <div class="lib-grid">${list.map(bookCard).join('')}</div>
                    </section>` : ''}`}`;
    }

    function shelfTab(me) {
        const mine = L.items.filter(x => x.author === me);
        const saved = L.items.filter(x => L.saved.has(x.id));
        return `
            <section class="lib-shelf">
                <div class="section-head"><h2>Your writing</h2></div>
                ${mine.length ? `<div class="lib-grid">${mine.map(bookCard).join('')}</div>` : `
                    <div class="empty lib-empty"><p class="empty-title">Nothing published yet</p>
                        <p>Write a story here, upload a PDF, or turn one of your notes into a piece.</p>
                        <button class="primary-btn" data-action="lib-new">Publish your first piece</button></div>`}
            </section>
            <section class="lib-shelf">
                <div class="section-head"><h2>Saved to read</h2></div>
                ${saved.length ? `<div class="lib-grid">${saved.map(bookCard).join('')}</div>` : '<p class="muted small">Tap the bookmark in the reader to keep something here.</p>'}
            </section>`;
    }

    // ---------- Reader ----------
    const reader = $('reader');
    let readerSize = Number(localStorage.getItem('diaryReaderSize')) || 19;

    async function openItem(id) {
        if (!L.items) await load();
        const x = (L.items || []).find(i => i.id === id);
        if (!x) return app.showToast('That piece isn’t available');
        L.open = x;
        paintReader(x, true);
        if (!reader.open) reader.showModal();
        $('reader-body').scrollTop = 0;
        client.rpc('diary_library_read', { p_item: id }).then(({ data }) => {
            if (typeof data === 'number' && L.open === x) {
                x.reads = data;
                const el = $('reader-reads');
                if (el) el.textContent = `${data} ${data === 1 ? 'read' : 'reads'}`;
            }
        });
        if (!x.file_path && x.content === undefined) {
            const { data } = await client.from('diary_library').select('content').eq('id', id).maybeSingle();
            x.content = data ? data.content : '';
            if (L.open === x) paintReader(x, false);
        }
    }

    function paintReader(x, loading) {
        const me = s.profile.id;
        const liked = (x.likes || []).some(l => l.user_id === me);
        const saved = L.saved.has(x.id);
        $('reader-like').setAttribute('aria-pressed', String(liked));
        $('reader-like').querySelector('use').setAttribute('href', liked ? '#i-heart-fill' : '#i-heart');
        $('reader-save').setAttribute('aria-pressed', String(saved));
        $('reader-save').querySelector('use').setAttribute('href', saved ? '#i-bookmark-fill' : '#i-bookmark');
        $('reader-delete').hidden = x.author !== me;
        $('reader-title-bar').textContent = x.title;
        const body = $('reader-body');
        body.style.setProperty('--reader-size', `${readerSize}px`);
        let main;
        if (x.file_path) {
            const pdf = x.file_type === 'application/pdf';
            main = `
                <div class="reader-file">
                    <a class="primary-btn" data-path="${esc(x.file_path)}" data-bucket="${BUCKET}" target="_blank" rel="noopener">${pdf ? 'Open the PDF' : 'Download the EPUB'}</a>
                    <p class="muted small">${pdf ? 'Opens in a new tab.' : 'Open it in Apple Books, Google Play Books or any e-reader.'} ${x.file_size ? `${(x.file_size / 1048576).toFixed(1)} MB` : ''}</p>
                    ${pdf && window.matchMedia('(min-width: 900px)').matches ? `<iframe class="reader-pdf" data-path="${esc(x.file_path)}" data-bucket="${BUCKET}" title="${esc(x.title)}"></iframe>` : ''}
                </div>`;
        } else {
            main = loading && x.content === undefined
                ? '<p class="muted">Opening…</p>'
                : `<div class="reader-text">${Rich.sanitize(x.content || '')}</div>`;
        }
        body.innerHTML = `
            <header class="reader-head">
                ${coverHTML(x, 'lg')}
                <span class="lib-eyebrow">${KINDS[x.kind]}${x.genre ? ` · ${esc(x.genre)}` : ''}${x.visibility === 'friends' ? ' · Friends only' : ''}</span>
                <h1 class="reader-h">${esc(x.title)}</h1>
                <div class="reader-author">${avatar({ id: x.author, ...(x.author_profile || { display_name: 'Someone' }) }, 'sm')}<span>${esc(authorName(x))}</span><span class="muted">· ${timeAgo(x.created_at)}</span></div>
                ${x.description ? `<p class="reader-desc">${esc(x.description)}</p>` : ''}
                <p class="reader-stats">${x.file_path ? '' : `${readMins(x)} min read · `}<span id="reader-reads">${x.reads} ${x.reads === 1 ? 'read' : 'reads'}</span> · ♥ ${hearts(x)}</p>
            </header>
            ${main}
            <p class="reader-end">${x.file_path ? '' : '✦ The end ✦'}</p>`;
        hydrateStorage(body);
        updateProgress();
    }

    function updateProgress() {
        const b = $('reader-body');
        const max = b.scrollHeight - b.clientHeight;
        $('reader-prog').style.width = `${max > 0 ? Math.min(100, (b.scrollTop / max) * 100) : 0}%`;
    }

    $('reader-body').addEventListener('scroll', updateProgress, { passive: true });
    $('reader-close').addEventListener('click', () => reader.close());
    reader.addEventListener('close', () => { L.open = null; if (app.state.view === 'library') app.render(); });
    const resize = d => {
        readerSize = Math.min(26, Math.max(15, readerSize + d));
        try { localStorage.setItem('diaryReaderSize', String(readerSize)); } catch (e) {}
        $('reader-body').style.setProperty('--reader-size', `${readerSize}px`);
    };
    $('reader-smaller').addEventListener('click', () => resize(-1));
    $('reader-bigger').addEventListener('click', () => resize(1));

    $('reader-like').addEventListener('click', async () => {
        const x = L.open;
        if (!x) return;
        const me = s.profile.id;
        const had = x.likes.some(l => l.user_id === me);
        x.likes = had ? x.likes.filter(l => l.user_id !== me) : [...x.likes, { user_id: me }];
        paintReaderButtons(x);
        const { error } = had
            ? await client.from('diary_library_likes').delete().eq('item_id', x.id).eq('user_id', me)
            : await client.from('diary_library_likes').insert({ item_id: x.id });
        if (error) {
            x.likes = had ? [...x.likes, { user_id: me }] : x.likes.filter(l => l.user_id !== me);
            paintReaderButtons(x);
            app.showToast('Couldn’t save that');
        }
    });

    $('reader-save').addEventListener('click', async () => {
        const x = L.open;
        if (!x) return;
        const had = L.saved.has(x.id);
        if (had) L.saved.delete(x.id);
        else L.saved.add(x.id);
        paintReaderButtons(x);
        app.showToast(had ? 'Removed from your shelf' : 'Saved to your shelf');
        const { error } = had
            ? await client.from('diary_saved_items').delete().eq('kind', 'book').eq('item_id', x.id)
            : await client.from('diary_saved_items').insert({ kind: 'book', item_id: x.id });
        if (error) {
            if (had) L.saved.add(x.id);
            else L.saved.delete(x.id);
            paintReaderButtons(x);
        }
    });

    function paintReaderButtons(x) {
        const liked = x.likes.some(l => l.user_id === s.profile.id);
        $('reader-like').setAttribute('aria-pressed', String(liked));
        $('reader-like').querySelector('use').setAttribute('href', liked ? '#i-heart-fill' : '#i-heart');
        const saved = L.saved.has(x.id);
        $('reader-save').setAttribute('aria-pressed', String(saved));
        $('reader-save').querySelector('use').setAttribute('href', saved ? '#i-bookmark-fill' : '#i-bookmark');
    }

    $('reader-delete').addEventListener('click', async () => {
        const x = L.open;
        if (!x) return;
        const ok = await app.ask({ title: `Delete “${x.title}”?`, text: 'It’s removed from the Library for everyone.', ok: 'Delete', danger: true });
        if (!ok) return;
        const { error } = await client.from('diary_library').delete().eq('id', x.id);
        if (error) return app.showToast('Couldn’t delete it');
        const files = [x.file_path, x.cover_path].filter(Boolean);
        if (files.length) client.storage.from(BUCKET).remove(files);
        L.items = L.items.filter(i => i.id !== x.id);
        reader.close();
        app.showToast('Deleted');
    });

    // ---------- Publishing ----------
    const sheet = $('lib-compose');

    function openCompose({ note = null } = {}) {
        if (!s.profile) return social.requireSignIn('Sign in to publish to the Library.');
        L.draft = { kind: 'story', source: 'write', file: null, cover: null, coverPreview: null, visibility: 'public' };
        $('lc-title').value = note ? (note.title || '').slice(0, 160) : '';
        $('lc-desc').value = '';
        $('lc-genre').value = '';
        $('lc-editor').innerHTML = note ? Rich.sanitize(note.html || Rich.textToHTML(note.text)) : '';
        paintCompose();
        if (!sheet.open) sheet.showModal();
        $('lc-title').focus();
    }

    function paintCompose() {
        const d = L.draft;
        sheet.querySelectorAll('[data-lc-kind]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.lcKind === d.kind)));
        sheet.querySelectorAll('[data-lc-source]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.lcSource === d.source)));
        sheet.querySelectorAll('[data-lc-vis]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.lcVis === d.visibility)));
        $('lc-write').hidden = d.source !== 'write';
        $('lc-upload').hidden = d.source !== 'file';
        $('lc-file-name').textContent = d.file ? `${d.file.name} · ${(d.file.size / 1048576).toFixed(1)} MB` : 'No file chosen';
        $('lc-cover').innerHTML = d.coverPreview
            ? `<img src="${d.coverPreview}" alt=""><span>Change cover</span>`
            : '<svg class="i"><use href="#i-image"/></svg><span>Add a cover photo</span>';
    }

    Rich.attach($('lc-toolbar'), $('lc-editor'), { askLink: app.askLink, history: true });

    sheet.addEventListener('click', async e => {
        const b = e.target.closest('button');
        if (!b || !L.draft) return;
        if (b.dataset.lcKind) L.draft.kind = b.dataset.lcKind;
        else if (b.dataset.lcVis) L.draft.visibility = b.dataset.lcVis;
        else if (b.dataset.lcSource === 'note') return pickNote(b);
        else if (b.dataset.lcSource) L.draft.source = b.dataset.lcSource;
        else if (b.id === 'lc-pick-file') {
            const [file] = await Media.pickFiles('.pdf,.epub,application/pdf,application/epub+zip', false);
            if (!file) return;
            if (file.size > MAX_FILE) return app.showToast('Files can be up to 50 MB');
            const type = file.type || (/\.epub$/i.test(file.name) ? FILE_TYPES.epub : /\.pdf$/i.test(file.name) ? FILE_TYPES.pdf : '');
            if (!Object.values(FILE_TYPES).includes(type)) return app.showToast('Upload a PDF or an EPUB');
            L.draft.file = new File([file], file.name, { type });
            if (!$('lc-title').value.trim()) $('lc-title').value = file.name.replace(/\.(pdf|epub)$/i, '').slice(0, 160);
        } else if (b.id === 'lc-cover') {
            const [file] = await Media.pickFiles('image/*', false);
            if (!file) return;
            if (L.draft.coverPreview) URL.revokeObjectURL(L.draft.coverPreview);
            L.draft.cover = file;
            L.draft.coverPreview = URL.createObjectURL(file);
        } else if (b.id === 'lc-cancel') {
            return sheet.close();
        } else return;
        paintCompose();
    });

    function pickNote(anchor) {
        const notes = app.getNotes().filter(n => !n.private && !n.trashedAt && (n.text || '').trim()).slice(0, 30);
        if (!notes.length) return app.showToast('No notes to use yet — private notes stay private');
        app.openPopover(anchor, notes.map(n => ({
            label: (n.title || n.text.split('\n')[0] || 'Untitled').slice(0, 48),
            icon: 'i-notes',
            onClick: () => {
                L.draft.source = 'write';
                if (!$('lc-title').value.trim()) $('lc-title').value = (n.title || n.text.split('\n')[0] || '').slice(0, 160);
                $('lc-editor').innerHTML = Rich.sanitize(n.html || Rich.textToHTML(n.text));
                paintCompose();
            }
        })));
    }

    $('lc-form').addEventListener('submit', async e => {
        e.preventDefault();
        const d = L.draft;
        const title = $('lc-title').value.trim();
        if (!title) return app.showToast('Give it a title');
        const html = Rich.sanitize($('lc-editor').innerHTML);
        const text = Rich.toText(html);
        if (d.source === 'write' && text.length < 20) return app.showToast('Write a little more before publishing');
        if (d.source === 'file' && !d.file) return app.showToast('Choose a PDF or EPUB to upload');
        const btn = $('lc-publish');
        btn.disabled = true;
        btn.textContent = 'Publishing…';
        const me = s.profile.id;
        const uploaded = [];
        try {
            let cover_path = null;
            if (d.cover) {
                cover_path = await uploadImage(BUCKET, `${me}/${randomId()}`, d.cover);
                if (cover_path) uploaded.push(cover_path);
            }
            let file_path = null;
            if (d.source === 'file') {
                file_path = `${me}/${randomId()}${d.file.type === FILE_TYPES.pdf ? '.pdf' : '.epub'}`;
                const { error } = await client.storage.from(BUCKET).upload(file_path, await d.file.arrayBuffer(), { contentType: d.file.type, upsert: false });
                if (error) throw error;
                uploaded.push(file_path);
            }
            const row = {
                kind: d.kind, title: title.slice(0, 160),
                description: $('lc-desc').value.trim().slice(0, 600),
                genre: $('lc-genre').value.trim().slice(0, 40),
                visibility: d.visibility, cover_path,
                ...(d.source === 'file'
                    ? { file_path, file_type: d.file.type, file_size: d.file.size }
                    : { content: html.slice(0, 300000), words: text.split(/\s+/).filter(Boolean).length })
            };
            const { data, error } = await client.from('diary_library').insert(row).select(FIELDS).single();
            if (error) throw error;
            L.items = [data, ...(L.items || [])];
            sheet.close();
            app.showToast('Published to the Library 📚');
            app.setView('library');
            L.tab = 'explore';
            openItem(data.id);
        } catch (err) {
            if (uploaded.length) client.storage.from(BUCKET).remove(uploaded);
            app.showToast('Couldn’t publish — check your connection and try again');
        } finally {
            btn.disabled = false;
            btn.textContent = 'Publish';
        }
    });

    sheet.addEventListener('close', () => {
        if (L.draft && L.draft.coverPreview) URL.revokeObjectURL(L.draft.coverPreview);
        L.draft = null;
    });

    // ---------- Actions ----------
    Object.assign(app.actions, {
        'lib-new': () => openCompose(),
        'lib-open': el => openItem(el.dataset.id),
        'lib-tab': el => { L.tab = el.dataset.tab; app.render(); },
        'lib-kind': el => { L.kind = el.dataset.kind; app.render(); }
    });

    content.addEventListener('input', e => {
        if (e.target.id !== 'lib-search') return;
        L.query = e.target.value;
        clearTimeout(content._libSearch);
        content._libSearch = setTimeout(() => {
            app.render();
            const input = $('lib-search');
            if (input) {
                input.focus();
                input.setSelectionRange(input.value.length, input.value.length);
            }
        }, 250);
    });

    const previousAfter = app.hooks.afterRender;
    app.hooks.afterRender = view => {
        if (previousAfter) previousAfter(view);
        if (view === 'library' || view === 'feed') hydrateStorage(content);
    };
});
