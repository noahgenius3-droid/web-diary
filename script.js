document.addEventListener('DOMContentLoaded', () => {
    const COLORS = ['yellow', 'pink', 'blue', 'green', 'purple'];
    const MOODS = { happy: '😊', calm: '😌', thoughtful: '🤔', sad: '😔', stressed: '😤' };
    const RANGES = [['all', 'All'], ['today', 'Today'], ['week', 'This Week'], ['month', 'This Month']];
    const TRASH_DAYS = 30;
    const DAY_MS = 86400000;

    const $ = id => document.getElementById(id);
    const content = $('content');
    const pageTitle = $('page-title');
    const searchInput = $('search-input');
    const toast = $('toast');
    const toastText = $('toast-text');
    const toastUndo = $('toast-undo');
    const popover = $('popover');

    const editor = $('editor');
    const edTitle = $('editor-title');
    const edText = $('editor-text');
    const edFolder = $('editor-folder');
    const edDate = $('editor-date');
    const edWords = $('editor-words');
    const edArchive = $('editor-archive');
    const edDelete = $('editor-delete');

    const askDialog = $('ask');
    const askInput = $('ask-input');

    let notes = [].concat(load('diaryNotes', [])).map(migrateNote).filter(Boolean);
    let folders = [].concat(load('diaryFolders', []))
        .filter(f => f && f.id && typeof f.name === 'string')
        .map((f, i) => ({ ...f, color: COLORS.includes(f.color) ? f.color : COLORS[i % COLORS.length] }));
    let userName = String(load('diaryUser', ''));
    sortNotes();
    purgeTrash();

    const state = {
        view: 'home',
        folderId: null,
        folderRange: 'all',
        noteRange: 'all',
        calMonth: firstOfMonth(new Date()),
        calDay: dayKey(new Date()),
        query: ''
    };

    let editing = null;
    let undoFn = null;
    let toastTimer = null;
    let popoverAnchor = null;
    let askResolve = null;
    let askColor = null;

    buildStatic();
    render();

    // ---------- Static UI ----------
    function buildStatic() {
        const dots = $('color-dots');
        COLORS.forEach(c => {
            const b = document.createElement('button');
            b.className = `color-dot c-${c}`;
            b.title = `New ${c} note`;
            b.setAttribute('aria-label', `New ${c} note`);
            b.addEventListener('click', () => openEditor(null, { color: c }));
            dots.append(b);
        });

        buildSwatches($('editor-colors'), c => { editing.color = c; paintEditor(); });
        buildSwatches($('ask-colors'), c => { askColor = c; paintSwatches($('ask-colors'), c); });

        const moods = $('editor-moods');
        Object.entries(MOODS).forEach(([key, emoji]) => {
            const b = document.createElement('button');
            b.type = 'button';
            b.className = 'mood';
            b.dataset.mood = key;
            b.title = key[0].toUpperCase() + key.slice(1);
            b.setAttribute('role', 'radio');
            b.textContent = emoji;
            b.addEventListener('click', () => {
                editing.mood = editing.mood === key ? null : key;
                paintEditor();
            });
            moods.append(b);
        });

        document.querySelectorAll('.nav-item').forEach(b =>
            b.addEventListener('click', () => setView(b.dataset.view)));
        $('add-new-btn').addEventListener('click', () => openEditor(null));
        $('write-today').addEventListener('click', () => openEditor(null));
        $('fab').addEventListener('click', () => openEditor(null, newNoteDefaults()));
        $('profile-btn').addEventListener('click', renameUser);
        $('menu-btn').addEventListener('click', e => openMainMenu(e.currentTarget));
    }

    function buildSwatches(container, onPick) {
        COLORS.forEach(c => {
            const b = document.createElement('button');
            b.type = 'button';
            b.className = `swatch c-${c}`;
            b.dataset.color = c;
            b.title = c[0].toUpperCase() + c.slice(1);
            b.setAttribute('role', 'radio');
            b.addEventListener('click', () => onPick(c));
            container.append(b);
        });
    }

    function paintSwatches(container, color) {
        container.querySelectorAll('.swatch').forEach(s =>
            s.setAttribute('aria-checked', String(s.dataset.color === color)));
    }

    // ---------- Navigation ----------
    function setView(view, extra = {}) {
        Object.assign(state, { view }, extra);
        render();
        window.scrollTo({ top: 0 });
    }

    searchInput.addEventListener('input', () => {
        state.query = searchInput.value.trim().toLowerCase();
        if (state.view === 'calendar') state.view = 'home';
        render();
    });

    // ---------- Rendering ----------
    function render() {
        const navView = state.view === 'folder' ? 'home' : state.view;
        document.querySelectorAll('.nav-item').forEach(b =>
            b.classList.toggle('active', b.dataset.view === navView));

        const archived = notes.filter(n => n.archived && !n.trashedAt).length;
        const trashed = notes.filter(n => n.trashedAt).length;
        $('archive-count').textContent = archived || '';
        $('trash-count').textContent = trashed || '';

        const live = notes.filter(n => !n.trashedAt);
        $('stat-entries').textContent = live.length.toLocaleString();
        $('stat-words').textContent = live.reduce((s, n) => s + countWords(n.title + ' ' + n.text), 0).toLocaleString();
        $('stat-streak').textContent = calcStreak();

        $('user-name').textContent = userName || 'Add your name';
        $('avatar').innerHTML = userName
            ? escapeHTML(initials(userName))
            : '<svg class="i" style="width:16px;height:16px"><use href="#i-user"/></svg>';

        const views = { home: renderHome, folder: renderFolder, calendar: renderCalendar, archive: renderArchive, trash: renderTrash };
        content.innerHTML = views[state.view]();
    }

    function setTitle(text) {
        pageTitle.textContent = text;
        document.title = text === 'My Diary' ? 'My Diary' : `${text} · My Diary`;
    }

    function renderHome() {
        setTitle('My Diary');

        if (state.query) {
            const results = activeNotes().filter(matches);
            return `
                <section class="section">
                    <div class="section-head">
                        <h2>Search results</h2>
                        <span class="muted">${results.length} ${results.length === 1 ? 'entry' : 'entries'} for “${escapeHTML(searchInput.value.trim())}”</span>
                    </div>
                    <div style="height:22px"></div>
                    ${notesGrid(results, { newTile: false, empty: 'Nothing matches your search.' })}
                </section>`;
        }

        const folderList = folders
            .filter(f => inRange(folderActivity(f), state.folderRange))
            .sort((a, b) => folderActivity(b) - folderActivity(a));
        const noteList = activeNotes().filter(n => inRange(n.createdAt, state.noteRange));
        const now = new Date();

        return `
            <div class="welcome">
                <p class="welcome-date">${now.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })}</p>
                <p class="welcome-greeting">${greeting()}${userName ? `, ${escapeHTML(userName.split(' ')[0])}` : ''}. What’s on your mind today?</p>
            </div>
            <section class="section">
                <h2>Recent Folders</h2>
                ${tabs('folderRange')}
                ${folderList.length === 0 && folders.length > 0 ? `<p class="grid-empty">No folders used ${rangeText(state.folderRange)}.</p>` : ''}
                <div class="grid">
                    ${folderList.map(folderCard).join('')}
                    <button class="new-tile" data-action="new-folder"><svg class="i"><use href="#i-folder-new"/></svg>New folder</button>
                </div>
            </section>
            <section class="section">
                <h2>My Notes</h2>
                ${tabs('noteRange')}
                ${notesGrid(noteList, { empty: activeNotes().length ? `No entries ${rangeText(state.noteRange)}.` : 'Your diary is empty — write your first entry.' })}
            </section>`;
    }

    function renderFolder() {
        const folder = folders.find(f => f.id === state.folderId);
        if (!folder) {
            state.view = 'home';
            return renderHome();
        }
        setTitle(folder.name);
        const list = activeNotes().filter(n => n.folderId === folder.id && matches(n) && inRange(n.createdAt, state.noteRange));
        return `
            <button class="back-link" data-action="back"><svg class="i"><use href="#i-back"/></svg>All notes</button>
            <section class="section">
                <div class="section-head">
                    <h2>${escapeHTML(folder.name)}</h2>
                    <button class="more-btn" data-action="folder-menu" data-id="${escapeHTML(folder.id)}" aria-label="Folder options"><svg class="i"><use href="#i-more"/></svg></button>
                </div>
                ${tabs('noteRange')}
                ${notesGrid(list, { folderId: folder.id, empty: state.query ? 'Nothing in this folder matches your search.' : `No entries ${rangeText(state.noteRange)} in this folder.` })}
            </section>`;
    }

    function renderCalendar() {
        setTitle('Calendar');
        const month = state.calMonth;
        const y = month.getFullYear();
        const m = month.getMonth();
        const offset = (new Date(y, m, 1).getDay() + 6) % 7; // Monday first
        const daysInMonth = new Date(y, m + 1, 0).getDate();
        const todayKey = dayKey(new Date());

        const byDay = new Map();
        activeNotes().forEach(n => {
            const key = dayKey(new Date(n.createdAt));
            if (!byDay.has(key)) byDay.set(key, []);
            byDay.get(key).push(n);
        });

        // Jan 1 2024 was a Monday
        const weekdays = Array.from({ length: 7 }, (_, i) =>
            `<div class="cal-weekday">${new Date(2024, 0, 1 + i).toLocaleDateString(undefined, { weekday: 'short' })}</div>`).join('');
        let cells = '<div></div>'.repeat(offset);
        for (let d = 1; d <= daysInMonth; d++) {
            const key = `${y}-${m}-${d}`;
            const dayNotes = byDay.get(key) || [];
            const dots = dayNotes.slice(0, 3).map(n => `<span class="cal-dot c-${n.color}"></span>`).join('');
            const label = new Date(y, m, d).toLocaleDateString(undefined, { month: 'long', day: 'numeric' });
            cells += `
                <button class="cal-day${key === todayKey ? ' is-today' : ''}" data-action="cal-day" data-day="${key}"
                    aria-pressed="${key === state.calDay}" aria-label="${label}, ${dayNotes.length} ${dayNotes.length === 1 ? 'entry' : 'entries'}">
                    <span class="cal-num">${d}</span><span class="cal-dots">${dots}</span>
                </button>`;
        }

        const selected = byDay.get(state.calDay) || [];
        return `
            <section class="section">
                <div class="section-head">
                    <h2>${month.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}</h2>
                    <div class="month-nav">
                        <button data-action="cal-prev" aria-label="Previous month"><svg class="i"><use href="#i-left"/></svg></button>
                        <button data-action="cal-today">Today</button>
                        <button data-action="cal-next" aria-label="Next month"><svg class="i"><use href="#i-right"/></svg></button>
                    </div>
                </div>
                <div class="calendar">${weekdays}${cells}</div>
            </section>
            <section class="section">
                <h2>${dayLabel(state.calDay)}</h2>
                <div style="height:22px"></div>
                ${notesGrid(selected, { day: state.calDay, empty: 'No entries on this day.' })}
            </section>`;
    }

    function renderArchive() {
        setTitle('Archive');
        const list = notes.filter(n => n.archived && !n.trashedAt && matches(n));
        return `
            <section class="section">
                <div class="section-head"><h2>Archived entries</h2></div>
                <p class="muted" style="margin:6px 0 22px">Archived entries are hidden from your notes but kept safe.</p>
                ${notesGrid(list, { newTile: false, empty: state.query ? 'No archived entries match your search.' : 'Nothing archived yet.' })}
            </section>`;
    }

    function renderTrash() {
        setTitle('Trash');
        const list = notes.filter(n => n.trashedAt && matches(n));
        return `
            <section class="section">
                <div class="section-head">
                    <h2>Trash</h2>
                    ${notes.some(n => n.trashedAt) ? '<button class="ghost-btn danger" data-action="empty-trash">Empty trash</button>' : ''}
                </div>
                <p class="muted" style="margin:6px 0 22px">Entries in the trash are deleted permanently after ${TRASH_DAYS} days.</p>
                ${notesGrid(list, { newTile: false, trash: true, empty: state.query ? 'No trashed entries match your search.' : 'Trash is empty.' })}
            </section>`;
    }

    function tabs(key) {
        return `<div class="tabs" role="tablist">${RANGES.map(([k, label]) =>
            `<button class="tab" role="tab" aria-selected="${state[key] === k}" data-action="range" data-key="${key}" data-range="${k}">${label}</button>`
        ).join('')}</div>`;
    }

    function notesGrid(list, { newTile = true, trash = false, empty = '', folderId = '', day = '' } = {}) {
        if (list.length === 0 && !newTile) {
            return `<div class="grid"><div class="empty"><p class="empty-title">${escapeHTML(empty)}</p></div></div>`;
        }
        const tile = newTile
            ? `<button class="new-tile" data-action="new-note" data-folder="${escapeHTML(folderId)}" data-day="${day}"><svg class="i"><use href="#i-edit"/></svg>New Note</button>`
            : '';
        return `
            ${list.length === 0 ? `<p class="grid-empty">${escapeHTML(empty)}</p>` : ''}
            <div class="grid notes-grid">${list.map(n => noteCard(n, trash)).join('')}${tile}</div>`;
    }

    function folderCard(f) {
        const count = activeNotes().filter(n => n.folderId === f.id).length;
        return `
            <article class="folder-card tinted c-${f.color}" data-action="open-folder" data-id="${escapeHTML(f.id)}" tabindex="0" role="button" aria-label="Open folder ${escapeHTML(f.name)}">
                <div class="folder-top">
                    <svg class="folder-icon"><use href="#i-folder"/></svg>
                    <button class="more-btn" data-action="folder-menu" data-id="${escapeHTML(f.id)}" aria-label="Folder options"><svg class="i"><use href="#i-more"/></svg></button>
                </div>
                <h3>${escapeHTML(f.name)}</h3>
                <p class="folder-meta">${shortDate(new Date(f.createdAt))} · ${count} ${count === 1 ? 'entry' : 'entries'}</p>
            </article>`;
    }

    function noteCard(n, trash) {
        const q = state.query;
        const date = new Date(n.createdAt);
        const lines = n.text.split('\n');
        const title = n.title || lines[0].trim() || 'Untitled';
        const body = n.title ? n.text : lines.slice(1).join('\n').trim();
        const time = date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
        const weekday = date.toLocaleDateString(undefined, { weekday: 'long' });
        const mood = n.mood ? `<span class="note-mood" title="${n.mood}">${MOODS[n.mood]}</span>` : '';
        const id = escapeHTML(n.id);

        const openAttrs = trash ? '' : `data-action="open-note" data-id="${id}" tabindex="0" role="button"`;
        const foot = trash
            ? `<div class="note-actions">
                   <button class="chip" data-action="restore" data-id="${id}">Restore</button>
                   <button class="chip danger" data-action="destroy" data-id="${id}">Delete forever</button>
               </div>`
            : `<div class="note-foot"><svg class="i"><use href="#i-clock"/></svg><span>${time}, ${weekday}</span>${mood}</div>`;

        return `
            <article class="note-card c-${n.color}" ${openAttrs}>
                <div class="note-date">${shortDate(date)}</div>
                <div class="note-head">
                    <h3>${highlight(title, q)}</h3>
                    ${trash ? '' : '<svg class="note-edit"><use href="#i-edit"/></svg>'}
                </div>
                <p class="note-body">${highlight(body, q)}</p>
                ${foot}
            </article>`;
    }

    // ---------- Content actions ----------
    content.addEventListener('click', e => {
        const el = e.target.closest('[data-action]');
        if (!el || !content.contains(el)) return;
        const { action, id } = el.dataset;

        switch (action) {
            case 'range':
                state[el.dataset.key] = el.dataset.range;
                render();
                break;
            case 'open-note':
                openEditor(notes.find(n => n.id === id));
                break;
            case 'new-note':
                openEditor(null, { folderId: el.dataset.folder || null, day: el.dataset.day || null });
                break;
            case 'new-folder':
                createFolder();
                break;
            case 'open-folder':
                setView('folder', { folderId: id });
                break;
            case 'folder-menu':
                openPopover(el, [
                    { label: 'Rename', icon: 'i-pencil', onClick: () => editFolder(id) },
                    { label: 'Delete folder', icon: 'i-trash', danger: true, onClick: () => deleteFolder(id) }
                ]);
                break;
            case 'back':
                setView('home');
                break;
            case 'cal-prev':
            case 'cal-next':
                state.calMonth = new Date(state.calMonth.getFullYear(), state.calMonth.getMonth() + (action === 'cal-next' ? 1 : -1), 1);
                render();
                break;
            case 'cal-today':
                state.calMonth = firstOfMonth(new Date());
                state.calDay = dayKey(new Date());
                render();
                break;
            case 'cal-day':
                state.calDay = el.dataset.day;
                render();
                break;
            case 'restore':
                restoreNote(id);
                break;
            case 'destroy':
                destroyNote(id);
                break;
            case 'empty-trash':
                emptyTrash();
                break;
        }
    });

    content.addEventListener('keydown', e => {
        if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('[role="button"][data-action]')) {
            e.preventDefault();
            e.target.click();
        }
    });

    // ---------- Editor ----------
    function newNoteDefaults() {
        if (state.view === 'folder') return { folderId: state.folderId };
        if (state.view === 'calendar') return { day: state.calDay };
        return {};
    }

    function openEditor(note, defaults = {}) {
        if (!note) {
            let createdAt = Date.now();
            // Writing from another calendar day backdates the entry to that day
            if (defaults.day && defaults.day !== dayKey(new Date())) {
                const [y, m, d] = defaults.day.split('-').map(Number);
                const t = new Date();
                createdAt = new Date(y, m, d, t.getHours(), t.getMinutes()).getTime();
            }
            editing = { id: null, color: defaults.color || COLORS[notes.length % COLORS.length], mood: null, createdAt };
        } else {
            editing = { id: note.id, color: note.color, mood: note.mood, createdAt: note.createdAt };
        }

        edTitle.value = note ? note.title : '';
        edText.value = note ? note.text : '';
        edFolder.innerHTML = '<option value="">No folder</option>' +
            folders.map(f => `<option value="${escapeHTML(f.id)}">${escapeHTML(f.name)}</option>`).join('');
        edFolder.value = (note ? note.folderId : defaults.folderId) || '';
        edDate.textContent = new Date(editing.createdAt).toLocaleString(undefined, {
            weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit'
        });
        edArchive.hidden = edDelete.hidden = !note;
        if (note) edArchive.querySelector('span').textContent = note.archived ? 'Unarchive' : 'Archive';

        paintEditor();
        updateWords();
        editor.showModal();
        autoResize();
        const focusTarget = note ? edText : edTitle;
        focusTarget.focus();
        if (note) edText.setSelectionRange(edText.value.length, edText.value.length);
    }

    function paintEditor() {
        editor.className = `editor tinted c-${editing.color}`;
        paintSwatches($('editor-colors'), editing.color);
        editor.querySelectorAll('.mood').forEach(b =>
            b.setAttribute('aria-checked', String(b.dataset.mood === editing.mood)));
    }

    function updateWords() {
        const count = countWords(edTitle.value + ' ' + edText.value);
        edWords.textContent = `${count} ${count === 1 ? 'word' : 'words'}`;
    }

    function autoResize() {
        edText.style.height = 'auto';
        edText.style.height = edText.scrollHeight + 'px';
    }

    edText.addEventListener('input', () => { autoResize(); updateWords(); });
    edTitle.addEventListener('input', updateWords);
    edTitle.addEventListener('keydown', e => {
        if (e.key === 'Enter' && !e.ctrlKey && !e.metaKey) {
            e.preventDefault();
            edText.focus();
        }
    });
    editor.addEventListener('keydown', e => {
        if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
            e.preventDefault();
            editor.close();
        }
    });
    $('editor-close').addEventListener('click', () => editor.close());

    // Close on backdrop click (only if the press also started on the backdrop)
    let pressedBackdrop = false;
    editor.addEventListener('mousedown', e => { pressedBackdrop = e.target === editor; });
    editor.addEventListener('click', e => {
        if (e.target === editor && pressedBackdrop) editor.close();
    });

    // Every way of closing the editor saves — the diary never loses writing
    editor.addEventListener('close', () => {
        const session = editing;
        editing = null;
        if (session) commitEditor(session);
    });

    function commitEditor(session, quiet = false) {
        const title = edTitle.value.trim();
        const text = edText.value.trim();
        const folderId = edFolder.value || null;
        if (!title && !text) return;

        if (session.id) {
            const n = notes.find(x => x.id === session.id);
            if (!n) return;
            const changed = n.title !== title || n.text !== text || n.color !== session.color ||
                n.mood !== session.mood || n.folderId !== folderId;
            if (!changed) return;
            Object.assign(n, { title, text, color: session.color, mood: session.mood, folderId, updatedAt: Date.now() });
            if (!quiet) showToast('Entry updated');
        } else {
            notes.push({
                id: uid(), title, text, mood: session.mood, color: session.color, folderId,
                archived: false, trashedAt: null, createdAt: session.createdAt, updatedAt: Date.now()
            });
            sortNotes();
            if (!quiet) showToast('Entry saved');
        }
        persist();
        render();
    }

    edArchive.addEventListener('click', () => {
        const session = editing;
        editing = null;
        editor.close();
        commitEditor(session, true);
        const n = notes.find(x => x.id === session.id);
        if (!n) return;
        n.archived = !n.archived;
        persist();
        render();
        showToast(n.archived ? 'Entry archived' : 'Entry moved back to notes', () => {
            n.archived = !n.archived;
            persist();
            render();
        });
    });

    edDelete.addEventListener('click', () => {
        const session = editing;
        editing = null;
        editor.close();
        const n = notes.find(x => x.id === session.id);
        if (!n) return;
        n.trashedAt = Date.now();
        persist();
        render();
        showToast('Moved to trash', () => {
            n.trashedAt = null;
            persist();
            render();
        });
    });

    // ---------- Notes: trash ----------
    function restoreNote(id) {
        const n = notes.find(x => x.id === id);
        if (!n) return;
        n.trashedAt = null;
        persist();
        render();
        showToast('Entry restored');
    }

    async function destroyNote(id) {
        const ok = await ask({ title: 'Delete forever?', text: 'This entry will be permanently deleted. This can’t be undone.', ok: 'Delete', danger: true });
        if (!ok) return;
        notes = notes.filter(n => n.id !== id);
        persist();
        render();
        showToast('Entry deleted');
    }

    async function emptyTrash() {
        const count = notes.filter(n => n.trashedAt).length;
        const ok = await ask({ title: 'Empty trash?', text: `${count} ${count === 1 ? 'entry' : 'entries'} will be permanently deleted. This can’t be undone.`, ok: 'Empty trash', danger: true });
        if (!ok) return;
        notes = notes.filter(n => !n.trashedAt);
        persist();
        render();
        showToast('Trash emptied');
    }

    function purgeTrash() {
        const cutoff = Date.now() - TRASH_DAYS * DAY_MS;
        const before = notes.length;
        notes = notes.filter(n => !n.trashedAt || n.trashedAt > cutoff);
        if (notes.length !== before) persist();
    }

    // ---------- Folders ----------
    async function createFolder() {
        const r = await ask({ title: 'New folder', value: '', placeholder: 'Folder name', color: COLORS[folders.length % COLORS.length], ok: 'Create' });
        if (!r) return;
        folders.unshift({ id: uid(), name: r.value, color: r.color, createdAt: Date.now() });
        persist();
        render();
        showToast('Folder created');
    }

    async function editFolder(id) {
        const f = folders.find(x => x.id === id);
        if (!f) return;
        const r = await ask({ title: 'Edit folder', value: f.name, placeholder: 'Folder name', color: f.color, ok: 'Save' });
        if (!r) return;
        f.name = r.value;
        f.color = r.color;
        persist();
        render();
    }

    function deleteFolder(id) {
        const index = folders.findIndex(x => x.id === id);
        if (index === -1) return;
        const folder = folders[index];
        const members = notes.filter(n => n.folderId === id);
        folders.splice(index, 1);
        members.forEach(n => { n.folderId = null; });
        if (state.view === 'folder' && state.folderId === id) state.view = 'home';
        persist();
        render();
        showToast('Folder deleted — its entries were kept', () => {
            folders.splice(index, 0, folder);
            members.forEach(n => { n.folderId = id; });
            persist();
            render();
        });
    }

    // ---------- Profile & menu ----------
    async function renameUser() {
        const r = await ask({ title: 'Your name', value: userName, placeholder: 'e.g. Alex', ok: 'Save', allowEmpty: true });
        if (!r) return;
        userName = r.value;
        try { localStorage.setItem('diaryUser', JSON.stringify(userName)); } catch (e) {}
        render();
    }

    function isDark() {
        const t = document.documentElement.dataset.theme;
        return t ? t === 'dark' : window.matchMedia('(prefers-color-scheme: dark)').matches;
    }

    function openMainMenu(anchor) {
        const nav = [['home', 'Notes', 'i-notes'], ['calendar', 'Calendar', 'i-calendar'], ['archive', 'Archive', 'i-archive'], ['trash', 'Trash', 'i-trash']]
            .map(([view, label, icon]) => ({ label, icon, cls: 'mobile-only', onClick: () => setView(view) }));
        openPopover(anchor, [
            ...nav,
            { sep: true, cls: 'mobile-only' },
            {
                label: isDark() ? 'Light mode' : 'Dark mode',
                icon: isDark() ? 'i-sun' : 'i-moon',
                onClick: () => {
                    const next = isDark() ? 'light' : 'dark';
                    document.documentElement.dataset.theme = next;
                    try { localStorage.setItem('diaryTheme', next); } catch (e) {}
                }
            },
            { label: 'Change name', icon: 'i-user', onClick: renameUser },
            { label: 'Export entries', icon: 'i-download', onClick: exportData }
        ]);
    }

    function exportData() {
        const blob = new Blob([JSON.stringify({ notes, folders }, null, 2)], { type: 'application/json' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        const d = new Date();
        a.download = `diary-${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}.json`;
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    }

    // ---------- Popover menu ----------
    function openPopover(anchor, items) {
        const wasSame = !popover.hidden && popoverAnchor === anchor;
        closePopover();
        if (wasSame) return;

        items.forEach(item => {
            if (item.sep) {
                const s = document.createElement('div');
                s.className = 'pop-sep' + (item.cls ? ` ${item.cls}` : '');
                popover.append(s);
                return;
            }
            const b = document.createElement('button');
            b.className = 'pop-item' + (item.danger ? ' danger' : '') + (item.cls ? ` ${item.cls}` : '');
            b.setAttribute('role', 'menuitem');
            b.innerHTML = `<svg class="i"><use href="#${item.icon}"/></svg><span></span>`;
            b.querySelector('span').textContent = item.label;
            b.addEventListener('click', () => { closePopover(); item.onClick(); });
            popover.append(b);
        });

        popover.hidden = false;
        const r = anchor.getBoundingClientRect();
        const w = popover.offsetWidth;
        const h = popover.offsetHeight;
        const left = Math.max(8, Math.min(r.right - w, window.innerWidth - w - 8));
        const top = r.bottom + 6 + h > window.innerHeight ? Math.max(8, r.top - h - 6) : r.bottom + 6;
        popover.style.left = `${left}px`;
        popover.style.top = `${top}px`;
        popoverAnchor = anchor;
        anchor.setAttribute('aria-expanded', 'true');
        const first = [...popover.querySelectorAll('.pop-item')].find(b => b.offsetParent !== null);
        if (first) first.focus();
    }

    function closePopover() {
        if (popover.hidden) return;
        popover.hidden = true;
        popover.innerHTML = '';
        if (popoverAnchor) popoverAnchor.setAttribute('aria-expanded', 'false');
        popoverAnchor = null;
    }

    document.addEventListener('click', e => {
        if (popover.hidden || popover.contains(e.target) || (popoverAnchor && popoverAnchor.contains(e.target))) return;
        closePopover();
    });
    document.addEventListener('keydown', e => {
        if (e.key === 'Escape' && !popover.hidden) {
            const anchor = popoverAnchor;
            closePopover();
            if (anchor && document.contains(anchor)) anchor.focus();
        }
    });
    window.addEventListener('resize', closePopover);
    window.addEventListener('scroll', closePopover, { passive: true });

    // ---------- Prompt / confirm dialog ----------
    function ask({ title, text = '', value = null, placeholder = '', color = null, ok = 'OK', danger = false, allowEmpty = false }) {
        return new Promise(resolve => {
            $('ask-title').textContent = title;
            $('ask-text').textContent = text;
            $('ask-text').hidden = !text;
            askInput.hidden = value === null;
            askInput.value = value || '';
            askInput.placeholder = placeholder;
            askInput.dataset.allowEmpty = allowEmpty ? '1' : '';
            askColor = color;
            $('ask-colors').hidden = !color;
            if (color) paintSwatches($('ask-colors'), color);
            $('ask-ok').textContent = ok;
            $('ask-ok').classList.toggle('danger', danger);
            askResolve = resolve;
            askDialog.showModal();
            if (value !== null) {
                askInput.focus();
                askInput.select();
            } else {
                $('ask-cancel').focus();
            }
        });
    }

    function finishAsk(result) {
        const resolve = askResolve;
        askResolve = null;
        askDialog.close();
        if (resolve) resolve(result);
    }

    $('ask-form').addEventListener('submit', e => {
        e.preventDefault();
        if (askInput.hidden) return finishAsk(true);
        const value = askInput.value.trim();
        if (!value && !askInput.dataset.allowEmpty) return askInput.focus();
        finishAsk({ value, color: askColor });
    });
    $('ask-cancel').addEventListener('click', () => finishAsk(null));
    askDialog.addEventListener('close', () => { if (askResolve) finishAsk(null); });

    // ---------- Toast ----------
    function showToast(message, undo = null) {
        toastText.textContent = message;
        undoFn = undo;
        toastUndo.hidden = !undo;
        toast.classList.add('show');
        clearTimeout(toastTimer);
        toastTimer = setTimeout(hideToast, undo ? 5000 : 2000);
    }

    function hideToast() {
        toast.classList.remove('show');
        undoFn = null;
    }

    toastUndo.addEventListener('click', () => {
        const fn = undoFn;
        hideToast();
        if (fn) fn();
    });

    // ---------- Data ----------
    function load(key, fallback) {
        try {
            const value = JSON.parse(localStorage.getItem(key));
            return value ?? fallback;
        } catch (e) {
            return fallback;
        }
    }

    function persist() {
        try {
            localStorage.setItem('diaryNotes', JSON.stringify(notes));
            localStorage.setItem('diaryFolders', JSON.stringify(folders));
        } catch (e) {
            showToast('Could not save — storage unavailable');
        }
    }

    // Upgrades entries saved by the earlier version ({ id, text, mood, date })
    function migrateNote(n, i) {
        if (!n || typeof n.text !== 'string') return null;
        const fromId = Number(n.id);
        const createdAt = Number.isFinite(n.createdAt) ? n.createdAt
            : Number.isFinite(fromId) ? fromId
            : Date.parse(n.date) || Date.now();
        return {
            id: String(n.id ?? createdAt),
            title: typeof n.title === 'string' ? n.title : '',
            text: n.text,
            mood: MOODS[n.mood] ? n.mood : null,
            color: COLORS.includes(n.color) ? n.color : COLORS[i % COLORS.length],
            folderId: n.folderId ?? null,
            archived: !!n.archived,
            trashedAt: n.trashedAt ?? null,
            createdAt,
            updatedAt: n.updatedAt ?? createdAt
        };
    }

    function sortNotes() {
        notes.sort((a, b) => b.createdAt - a.createdAt);
    }

    function activeNotes() {
        return notes.filter(n => !n.trashedAt && !n.archived);
    }

    function matches(n) {
        return !state.query || `${n.title}\n${n.text}`.toLowerCase().includes(state.query);
    }

    function folderActivity(f) {
        return notes.reduce((latest, n) =>
            n.folderId === f.id && !n.trashedAt ? Math.max(latest, n.updatedAt) : latest, f.createdAt);
    }

    function uid() {
        return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
    }

    // ---------- Dates ----------
    function inRange(time, range) {
        const date = new Date(time);
        const now = new Date();
        if (range === 'today') return dayKey(date) === dayKey(now);
        if (range === 'week') {
            const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - (now.getDay() + 6) % 7);
            return date >= start;
        }
        if (range === 'month') return date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth();
        return true;
    }

    function rangeText(range) {
        return { all: 'yet', today: 'today', week: 'this week', month: 'this month' }[range];
    }

    function firstOfMonth(date) {
        return new Date(date.getFullYear(), date.getMonth(), 1);
    }

    function dayKey(date) {
        return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
    }

    function dayLabel(key) {
        const [y, m, d] = key.split('-').map(Number);
        const date = new Date(y, m, d);
        const today = new Date();
        const yesterday = new Date();
        yesterday.setDate(today.getDate() - 1);
        if (key === dayKey(today)) return 'Today';
        if (key === dayKey(yesterday)) return 'Yesterday';
        return date.toLocaleDateString(undefined, {
            weekday: 'long', month: 'long', day: 'numeric',
            year: date.getFullYear() === today.getFullYear() ? undefined : 'numeric'
        });
    }

    function shortDate(date) {
        return date.toLocaleDateString(undefined, { day: '2-digit', month: '2-digit', year: 'numeric' });
    }

    function greeting() {
        const h = new Date().getHours();
        return h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
    }

    function calcStreak() {
        const days = new Set(notes.filter(n => !n.trashedAt).map(n => dayKey(new Date(n.createdAt))));
        const cursor = new Date();
        // Streak still counts if you haven't written yet today
        if (!days.has(dayKey(cursor))) cursor.setDate(cursor.getDate() - 1);
        let streak = 0;
        while (days.has(dayKey(cursor))) {
            streak++;
            cursor.setDate(cursor.getDate() - 1);
        }
        return streak;
    }

    // ---------- Text helpers ----------
    function countWords(str) {
        const trimmed = str.trim();
        return trimmed ? trimmed.split(/\s+/).length : 0;
    }

    function initials(name) {
        return name.split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0].toUpperCase()).join('');
    }

    // Split raw text on the query, escape each piece, then wrap matches
    function highlight(text, query) {
        if (!query) return escapeHTML(text);
        const pattern = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        return text.split(new RegExp(`(${pattern})`, 'gi'))
            .map((part, i) => i % 2 ? `<mark>${escapeHTML(part)}</mark>` : escapeHTML(part))
            .join('');
    }

    // Helper to prevent XSS
    function escapeHTML(str) {
        return String(str).replace(/[&<>'"]/g,
            tag => ({
                '&': '&amp;',
                '<': '&lt;',
                '>': '&gt;',
                "'": '&#39;',
                '"': '&quot;'
            }[tag])
        );
    }
});
