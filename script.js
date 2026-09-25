document.addEventListener('DOMContentLoaded', () => {
    const COLORS = ['yellow', 'pink', 'blue', 'green', 'purple'];
    const MOODS = { happy: '😊', calm: '😌', thoughtful: '🤔', sad: '😔', stressed: '😤' };
    const MOOD_LABELS = { happy: 'Happy', calm: 'Calm', thoughtful: 'Thoughtful', sad: 'Sad', stressed: 'Stressed' };
    const EMOTIONS = ['Grateful', 'Joyful', 'Excited', 'Proud', 'Loved', 'Hopeful', 'Content', 'Relaxed',
        'Tired', 'Anxious', 'Frustrated', 'Lonely', 'Overwhelmed', 'Angry', 'Confused', 'Bored'];
    const KINDS = {
        free: { label: 'Free write', icon: '✏️' },
        morning: { label: 'Morning', icon: '☀️' },
        evening: { label: 'Evening', icon: '🌙' }
    };
    const SECTIONS = {
        gratitude: { label: 'Gratitude', icon: '🙏', placeholder: 'Three things I’m grateful for…' },
        highlights: { label: 'Daily highlights', icon: '✨', placeholder: 'The best moments of today…' },
        learned: { label: 'What I learned today', icon: '💡', placeholder: 'Something new I discovered…' },
        improve: { label: 'What I need to improve', icon: '🌱', placeholder: 'Next time I’ll…' }
    };
    const KIND_SECTIONS = { free: [], morning: ['gratitude'], evening: ['highlights', 'learned', 'improve'] };
    const RANGES = [['all', 'All'], ['today', 'Today'], ['week', 'This Week'], ['month', 'This Month']];
    const TRASH_DAYS = 30;
    const DAY_MS = 86400000;
    const MAX_FILE = 25 * 1048576;
    const hooks = { displayName: null, profileClick: null, menuItems: null, afterRender: null, shareToggle: null, rename: null };

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
    const edBody = $('editor-text');
    const edFolder = $('editor-folder');
    const edDate = $('editor-date');
    const edWords = $('editor-words');
    const edSaved = $('editor-saved');
    const edArchive = $('editor-archive');
    const edDelete = $('editor-delete');
    const edShare = $('editor-share');
    const edPrivate = $('editor-private');
    const edLocation = $('editor-location');
    const edAttachments = $('editor-attachments');
    const edReflection = $('editor-reflection');
    const edEmotions = $('editor-emotions');
    const edEmotionPicker = $('emotion-picker');

    const askDialog = $('ask');
    const askInput = $('ask-input');

    let notes = [].concat(load('diaryNotes', [])).map(migrateNote).filter(Boolean);
    let folders = [].concat(load('diaryFolders', []))
        .filter(f => f && f.id && typeof f.name === 'string')
        .map((f, i) => ({ ...f, color: COLORS.includes(f.color) ? f.color : COLORS[i % COLORS.length] }));
    let userName = String(load('diaryUser', ''));
    sortNotes();

    const state = {
        view: 'home',
        folderId: null,
        folderRange: 'all',
        noteRange: 'all',
        calMonth: firstOfMonth(new Date()),
        calDay: dayKey(new Date()),
        query: ''
    };

    // Extension points for social.js and ai.js
    const views = {
        home: renderHome, folder: renderFolder, calendar: renderCalendar, insights: renderInsights,
        photos: renderPhotos, archive: renderArchive, trash: renderTrash
    };
    const actions = {};
    const listeners = {};

    let editing = null;
    let saveTimer = null;
    let privateUnlocked = false;
    let undoFn = null;
    let toastTimer = null;
    let popoverAnchor = null;
    let askResolve = null;
    let askColor = null;

    purgeTrash();
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

        buildSwatches($('editor-colors'), c => { editing.color = c; paintEditor(); changed(); });
        buildSwatches($('ask-colors'), c => { askColor = c; paintSwatches($('ask-colors'), c); });

        const kinds = $('editor-kind');
        Object.entries(KINDS).forEach(([key, k]) => {
            const b = document.createElement('button');
            b.type = 'button';
            b.dataset.kind = key;
            b.setAttribute('role', 'radio');
            b.innerHTML = `<span aria-hidden="true">${k.icon}</span> ${k.label}`;
            b.addEventListener('click', () => {
                editing.kind = key;
                paintEditor();
                renderReflection();
                changed();
            });
            kinds.append(b);
        });

        const moods = $('editor-moods');
        Object.entries(MOODS).forEach(([key, emoji]) => {
            const b = document.createElement('button');
            b.type = 'button';
            b.className = 'mood';
            b.dataset.mood = key;
            b.title = MOOD_LABELS[key];
            b.setAttribute('aria-label', MOOD_LABELS[key]);
            b.setAttribute('role', 'radio');
            b.textContent = emoji;
            b.addEventListener('click', () => {
                editing.mood = editing.mood === key ? null : key;
                paintEditor();
                changed();
            });
            moods.append(b);
        });

        edEmotionPicker.innerHTML = EMOTIONS.map(e =>
            `<button type="button" class="emotion-chip" data-emotion="${e}" aria-pressed="false">${e}</button>`).join('');
        edEmotionPicker.addEventListener('click', e => {
            const chip = e.target.closest('[data-emotion]');
            if (!chip) return;
            toggleEmotion(chip.dataset.emotion);
        });
        edEmotions.addEventListener('click', e => {
            if (e.target.closest('[data-add-emotion]')) {
                edEmotionPicker.hidden = !edEmotionPicker.hidden;
                return;
            }
            const chip = e.target.closest('[data-emotion]');
            if (chip) toggleEmotion(chip.dataset.emotion);
        });

        Rich.attach($('editor-toolbar'), edBody, {
            onChange: changed,
            onFiles: addFiles,
            askLink,
            extra: [
                { cmd: 'image', label: 'Add photos', icon: 'i-image', run: () => pickAndAdd('image/*') },
                { cmd: 'file', label: 'Attach a file', icon: 'i-paperclip', run: () => pickAndAdd('') },
                { cmd: 'voice', label: 'Record a voice note', icon: 'i-mic', run: recordVoiceNote },
                { cmd: 'draw', label: 'Handwrite or draw', icon: 'i-draw', run: drawNote }
            ]
        });

        document.querySelectorAll('.nav-item[data-view]').forEach(b =>
            b.addEventListener('click', () => setView(b.dataset.view)));
        $('add-new-btn').addEventListener('click', () => openEditor(null));
        $('write-today').addEventListener('click', () => openEditor(null));
        $('fab').addEventListener('click', () => openEditor(null, newNoteDefaults()));
        $('profile-btn').addEventListener('click', e =>
            hooks.profileClick ? hooks.profileClick(e.currentTarget) : renameUser());
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
        if (!['home', 'folder', 'archive', 'trash'].includes(state.view)) state.view = 'home';
        render();
    });

    // ---------- Rendering ----------
    function render() {
        const navView = state.view === 'folder' ? 'home' : state.view;
        document.querySelectorAll('.nav-item[data-view]').forEach(b =>
            b.classList.toggle('active', b.dataset.view === navView));

        const archived = notes.filter(n => n.archived && !n.trashedAt).length;
        const trashed = notes.filter(n => n.trashedAt).length;
        $('archive-count').textContent = archived || '';
        $('trash-count').textContent = trashed || '';

        const live = notes.filter(n => !n.trashedAt);
        $('stat-entries').textContent = live.length.toLocaleString();
        $('stat-words').textContent = live.reduce((s, n) => s + countWords(fullText(n)), 0).toLocaleString();
        $('stat-streak').textContent = calcStreak();

        const name = displayName();
        $('user-name').textContent = name || 'Add your name';
        $('avatar').innerHTML = name
            ? escapeHTML(initials(name))
            : '<svg class="i" style="width:16px;height:16px"><use href="#i-user"/></svg>';

        document.body.dataset.view = state.view;
        content.innerHTML = (views[state.view] || renderHome)();
        Media.hydrate(content);
        if (hooks.afterRender) hooks.afterRender(state.view);
    }

    function displayName() {
        return (hooks.displayName && hooks.displayName()) || userName;
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
                <p class="welcome-greeting">${greeting()}${displayName() ? `, ${escapeHTML(displayName().split(' ')[0])}` : ''}. What’s on your mind today?</p>
            </div>
            ${todayPanel()}
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

    function todayPanel() {
        const today = dayKey(new Date());
        const todays = activeNotes().filter(n => dayKey(new Date(n.createdAt)) === today);
        const morning = todays.find(n => n.kind === 'morning');
        const evening = todays.find(n => n.kind === 'evening');
        const goals = todays.flatMap(n => n.goals.filter(g => g.text.trim()).map(g => ({ ...g, noteId: n.id })));
        const done = goals.filter(g => g.done).length;
        const memory = photoMemory();

        const journalCard = (kind, entry, blurb) => `
            <button class="today-card ${kind}${entry ? ' done' : ''}" data-action="journal" data-kind="${kind}">
                <span class="today-icon" aria-hidden="true">${KINDS[kind].icon}</span>
                <span class="today-text">
                    <strong>${kind === 'morning' ? 'Morning journal' : 'Evening reflection'}</strong>
                    <span>${entry ? '✓ Done today — tap to open' : blurb}</span>
                </span>
            </button>`;

        return `
            <section class="today-grid" aria-label="Today">
                ${journalCard('morning', morning, 'Gratitude and goals for the day')}
                ${journalCard('evening', evening, 'Highlights, lessons and what to improve')}
                <div class="today-card goals">
                    <div class="today-goals-head">
                        <strong>🎯 Today’s goals</strong>
                        ${goals.length ? `<span class="muted small">${done}/${goals.length} done</span>` : ''}
                    </div>
                    ${goals.length
                        ? `<ul class="goal-list">${goals.slice(0, 5).map(g => `
                            <li><label><input type="checkbox" data-action="toggle-goal" data-note="${escapeHTML(g.noteId)}" data-goal="${escapeHTML(g.id)}"${g.done ? ' checked' : ''}>
                            <span>${escapeHTML(g.text)}</span></label></li>`).join('')}</ul>`
                        : '<p class="muted small">Set goals in your morning journal and tick them off here.</p>'}
                </div>
                ${memory ? `
                    <button class="today-card memory" data-action="view-photo" data-media-id="${escapeHTML(memory.att.id)}" data-caption="${escapeHTML(memory.caption)}">
                        <img data-media="${escapeHTML(memory.att.id)}" alt="">
                        <span class="memory-label">📸 ${escapeHTML(memory.label)}</span>
                    </button>` : ''}
            </section>`;
    }

    // A past photo to resurface: same calendar day in an earlier month/year first, otherwise the oldest one
    function photoMemory() {
        const now = new Date();
        const photos = allPhotos().filter(p => now - p.note.createdAt > 6 * DAY_MS);
        if (!photos.length) return null;
        const sameDay = photos.find(p => new Date(p.note.createdAt).getDate() === now.getDate());
        const pick = sameDay || photos[now.getDate() % photos.length];
        const d = new Date(pick.note.createdAt);
        return {
            att: pick.att,
            label: sameDay ? `On this day · ${d.toLocaleDateString(undefined, { month: 'short', year: 'numeric' })}` : `Memory from ${d.toLocaleDateString(undefined, { month: 'long', day: 'numeric' })}`,
            caption: `${pick.note.title || 'Untitled'} · ${d.toLocaleDateString()}`
        };
    }

    function allPhotos() {
        return notes
            .filter(n => !n.trashedAt && !n.private)
            .flatMap(n => n.attachments.filter(a => a.kind === 'image' || a.kind === 'drawing').map(att => ({ att, note: n })));
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
            const mood = dayNotes.find(n => n.mood);
            const dots = dayNotes.slice(0, 3).map(n => `<span class="cal-dot c-${n.color}"></span>`).join('');
            const label = new Date(y, m, d).toLocaleDateString(undefined, { month: 'long', day: 'numeric' });
            cells += `
                <button class="cal-day${key === todayKey ? ' is-today' : ''}" data-action="cal-day" data-day="${key}"
                    aria-pressed="${key === state.calDay}" aria-label="${label}, ${dayNotes.length} ${dayNotes.length === 1 ? 'entry' : 'entries'}${mood ? `, feeling ${MOOD_LABELS[mood.mood].toLowerCase()}` : ''}">
                    <span class="cal-num">${d}</span>
                    ${mood ? `<span class="cal-mood" aria-hidden="true">${MOODS[mood.mood]}</span>` : `<span class="cal-dots">${dots}</span>`}
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

    // ---------- Insights (mood & emotion tracking) ----------
    function renderInsights() {
        setTitle('Insights');
        const since = Date.now() - 30 * DAY_MS;
        const recent = notes.filter(n => !n.trashedAt && n.createdAt >= since);
        const goals = recent.flatMap(n => n.goals.filter(g => g.text.trim()));
        const goalsDone = goals.filter(g => g.done).length;

        const moodCounts = countBy(recent.filter(n => n.mood), n => n.mood);
        const emotionCounts = countBy(recent.flatMap(n => n.emotions), e => e);
        const topMood = Object.entries(moodCounts).sort((a, b) => b[1] - a[1])[0];

        // One cell per day for the last 30 days, showing that day's latest mood
        const days = [];
        for (let i = 29; i >= 0; i--) {
            const d = new Date();
            d.setDate(d.getDate() - i);
            const dayNotes = recent.filter(n => dayKey(new Date(n.createdAt)) === dayKey(d));
            const withMood = dayNotes.find(n => n.mood);
            days.push({ d, count: dayNotes.length, mood: withMood ? withMood.mood : null });
        }

        const stat = (value, label) => `<div class="stat-tile"><span class="stat-tile-value">${value}</span><span class="stat-tile-label">${label}</span></div>`;

        const bars = (counts, labelFor) => {
            const entries = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 10);
            if (!entries.length) return '<p class="muted small">Nothing tracked yet.</p>';
            const max = entries[0][1];
            return `<div class="bars" role="list">${entries.map(([key, count]) => `
                <div class="bar-row" role="listitem" title="${escapeHTML(labelFor(key))}: ${count} ${count === 1 ? 'entry' : 'entries'}">
                    <span class="bar-label">${labelFor(key, true)}</span>
                    <span class="bar-track"><span class="bar-fill" style="width:${Math.max(4, (count / max) * 100)}%"></span></span>
                    <span class="bar-value">${count}</span>
                </div>`).join('')}</div>`;
        };

        return `
            <section class="section">
                <div class="section-head">
                    <div>
                        <h2>Last 30 days</h2>
                        <p class="muted">How you’ve been feeling, based on the moods and emotions you log in entries.</p>
                    </div>
                </div>
                <div class="stat-tiles">
                    ${stat(recent.length, 'entries')}
                    ${stat(calcStreak(), 'day streak')}
                    ${stat(goals.length ? `${Math.round((goalsDone / goals.length) * 100)}%` : '—', 'goals completed')}
                    ${stat(topMood ? `${MOODS[topMood[0]]} ${MOOD_LABELS[topMood[0]]}` : '—', 'most common mood')}
                </div>
            </section>
            <section class="section insight-card">
                <h3>Mood by day</h3>
                <div class="mood-strip">
                    ${days.map(({ d, count, mood }) => `
                        <div class="mood-day${mood ? '' : ' no-mood'}" title="${d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })}: ${mood ? MOOD_LABELS[mood] : count ? 'no mood logged' : 'no entry'}">
                            <span class="mood-day-emoji">${mood ? MOODS[mood] : count ? '•' : ''}</span>
                            <span class="mood-day-num">${d.getDate()}</span>
                        </div>`).join('')}
                </div>
            </section>
            <div class="insight-grid">
                <section class="insight-card">
                    <h3>Moods</h3>
                    ${bars(moodCounts, (k, rich) => rich ? `${MOODS[k]} ${MOOD_LABELS[k]}` : MOOD_LABELS[k])}
                </section>
                <section class="insight-card">
                    <h3>Emotions</h3>
                    ${bars(emotionCounts, k => escapeHTML(k))}
                </section>
            </div>`;
    }

    // ---------- Photo memories ----------
    function renderPhotos() {
        setTitle('Photo memories');
        const photos = allPhotos();
        if (!photos.length) {
            return `<div class="empty">
                <p class="empty-title">No photo memories yet</p>
                <p>Add photos or drawings to your entries with the picture button in the editor.</p>
            </div>`;
        }

        const now = new Date();
        const onThisDay = photos.filter(p => {
            const d = new Date(p.note.createdAt);
            return d.getMonth() === now.getMonth() && d.getDate() === now.getDate() && d.getFullYear() !== now.getFullYear();
        });

        const groups = new Map();
        photos.forEach(p => {
            const d = new Date(p.note.createdAt);
            const key = d.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
            if (!groups.has(key)) groups.set(key, []);
            groups.get(key).push(p);
        });

        const tile = ({ att, note }) => {
            const caption = `${note.title || 'Untitled'} · ${new Date(note.createdAt).toLocaleDateString()}`;
            return `<button class="photo-tile" data-action="view-photo" data-media-id="${escapeHTML(att.id)}" data-caption="${escapeHTML(caption)}" aria-label="${escapeHTML(caption)}">
                <img data-media="${escapeHTML(att.id)}" alt="" loading="lazy">
                <span class="photo-date">${new Date(note.createdAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</span>
            </button>`;
        };

        return `
            ${onThisDay.length ? `<section class="section"><h2>On this day</h2><div class="photo-grid" style="margin-top:16px">${onThisDay.map(tile).join('')}</div></section>` : ''}
            ${[...groups.entries()].map(([label, list]) => `
                <section class="section">
                    <h2>${escapeHTML(label)}</h2>
                    <div class="photo-grid" style="margin-top:16px">${list.map(tile).join('')}</div>
                </section>`).join('')}`;
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
        const time = date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
        const weekday = date.toLocaleDateString(undefined, { weekday: 'long' });
        const id = escapeHTML(n.id);
        const hidden = n.private && !privateUnlocked;

        let title;
        let body;
        if (hidden) {
            title = 'Private entry';
            body = '';
        } else {
            const lines = n.text.split('\n');
            title = n.title || lines[0].trim() || (n.kind !== 'free' ? `${KINDS[n.kind].label} journal` : 'Untitled');
            body = n.title ? n.text : lines.slice(1).join('\n').trim();
            if (!body) body = Object.values(n.sections).find(v => v.trim()) || '';
        }

        const thumb = !hidden && n.attachments.find(a => a.kind === 'image' || a.kind === 'drawing');
        const badges = [
            n.kind !== 'free' ? `<span title="${KINDS[n.kind].label} journal">${KINDS[n.kind].icon}</span>` : '',
            n.private ? '<span title="Private"><svg class="i"><use href="#i-lock"/></svg></span>' : '',
            n.attachments.some(a => a.kind === 'audio') ? '<span title="Voice note"><svg class="i"><use href="#i-mic"/></svg></span>' : '',
            n.attachments.some(a => a.kind === 'file') ? '<span title="Attachments"><svg class="i"><use href="#i-paperclip"/></svg></span>' : '',
            n.mood ? `<span class="note-mood" title="${MOOD_LABELS[n.mood]}">${MOODS[n.mood]}</span>` : ''
        ].join('');

        const openAttrs = trash ? '' : `data-action="open-note" data-id="${id}" tabindex="0" role="button"`;
        const foot = trash
            ? `<div class="note-actions">
                   <button class="chip" data-action="restore" data-id="${id}">Restore</button>
                   <button class="chip danger" data-action="destroy" data-id="${id}">Delete forever</button>
               </div>`
            : `<div class="note-foot"><svg class="i"><use href="#i-clock"/></svg><span>${time}, ${weekday}</span><span class="note-badges">${badges}</span></div>`;

        return `
            <article class="note-card c-${n.color}${thumb ? ' has-thumb' : ''}${hidden ? ' is-private' : ''}" ${openAttrs}>
                <div class="note-date">${shortDate(date)}${n.location && !hidden ? ` · ${escapeHTML(n.location.weather ? n.location.weather.emoji : '📍')}` : ''}</div>
                <div class="note-head">
                    <h3>${hidden ? '🔒 Private entry' : highlight(title, q)}</h3>
                    ${trash ? '' : '<svg class="note-edit"><use href="#i-edit"/></svg>'}
                </div>
                ${thumb ? `<img class="note-thumb" data-media="${escapeHTML(thumb.id)}" alt="">` : ''}
                <p class="note-body">${hidden ? 'Open to read this entry.' : highlight(body, q)}</p>
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
                openNote(notes.find(n => n.id === id));
                break;
            case 'new-note':
                openEditor(null, { folderId: el.dataset.folder || null, day: el.dataset.day || null });
                break;
            case 'journal':
                openJournal(el.dataset.kind);
                break;
            case 'toggle-goal':
                toggleGoal(el.dataset.note, el.dataset.goal);
                break;
            case 'view-photo':
                Media.url(el.dataset.mediaId).then(u => u && Media.lightbox(u, el.dataset.caption));
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
            default:
                if (actions[action]) actions[action](el, e);
        }
    });

    content.addEventListener('keydown', e => {
        if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('[role="button"][data-action]')) {
            e.preventDefault();
            e.target.click();
        }
    });

    function openJournal(kind) {
        const today = dayKey(new Date());
        const existing = activeNotes().find(n => n.kind === kind && dayKey(new Date(n.createdAt)) === today);
        if (existing) openNote(existing);
        else openEditor(null, { kind, color: kind === 'morning' ? 'yellow' : 'purple' });
    }

    function toggleGoal(noteId, goalId) {
        const n = notes.find(x => x.id === noteId);
        const g = n && n.goals.find(x => x.id === goalId);
        if (!g) return;
        g.done = !g.done;
        n.updatedAt = Date.now();
        persist();
        render();
        if (g.done) showToast('Goal done — nice work 🎉');
    }

    // ---------- Private entries ----------
    async function openNote(note) {
        if (!note) return;
        if (note.private && !(await unlockPrivate())) return;
        openEditor(note);
    }

    async function unlockPrivate() {
        const saved = load('diaryPin', null);
        if (!saved || privateUnlocked) return true;
        const r = await ask({ title: 'Private entries', text: 'Enter your PIN to open private entries.', value: '', placeholder: 'PIN', ok: 'Unlock', inputType: 'password' });
        if (!r) return false;
        if (await hashPin(r.value) === saved) {
            privateUnlocked = true;
            render();
            return true;
        }
        showToast('That PIN isn’t right');
        return false;
    }

    async function setPin() {
        const saved = load('diaryPin', null);
        if (saved && !privateUnlocked && !(await unlockPrivate())) return;
        const r = await ask({
            title: saved ? 'Change private PIN' : 'Set a private PIN',
            text: saved ? 'Enter a new PIN, or leave it empty to remove the PIN.' : 'You’ll need this PIN to open entries marked Private. It keeps them from casual eyes on this device — it isn’t encryption.',
            value: '', placeholder: '4+ digits or letters', ok: 'Save', allowEmpty: !!saved, inputType: 'password'
        });
        if (!r) return;
        if (!r.value) {
            localStorage.removeItem('diaryPin');
            showToast('PIN removed');
            return;
        }
        if (r.value.length < 4) return showToast('Use at least 4 characters');
        try { localStorage.setItem('diaryPin', JSON.stringify(await hashPin(r.value))); } catch (e) {}
        privateUnlocked = true;
        showToast('PIN saved');
    }

    async function hashPin(pin) {
        const data = new TextEncoder().encode(`diary-pin:${pin}`);
        if (window.crypto && crypto.subtle) {
            const digest = await crypto.subtle.digest('SHA-256', data);
            return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
        }
        return btoa(String.fromCharCode(...data));
    }

    // ---------- Editor ----------
    function newNoteDefaults() {
        if (state.view === 'folder') return { folderId: state.folderId };
        if (state.view === 'calendar') return { day: state.calDay };
        return {};
    }

    function openEditor(note, defaults = {}) {
        if (editor.open) editor.close();
        if (!note) {
            let createdAt = Date.now();
            // Writing from another calendar day backdates the entry to that day
            if (defaults.day && defaults.day !== dayKey(new Date())) {
                const [y, m, d] = defaults.day.split('-').map(Number);
                const t = new Date();
                createdAt = new Date(y, m, d, t.getHours(), t.getMinutes()).getTime();
            }
            editing = {
                id: null, color: defaults.color || COLORS[notes.length % COLORS.length], mood: null, emotions: [],
                kind: defaults.kind || 'free', sections: emptySections(), goals: [], attachments: [], location: null,
                private: false, shared: false, createdAt
            };
        } else {
            editing = {
                id: note.id, color: note.color, mood: note.mood, emotions: [...note.emotions], kind: note.kind,
                sections: { ...emptySections(), ...note.sections }, goals: note.goals.map(g => ({ ...g })),
                attachments: note.attachments.map(a => ({ ...a })), location: note.location,
                private: note.private, shared: note.shared, createdAt: note.createdAt
            };
        }
        Object.assign(editing, { shownSections: new Set(), showGoals: false, changed: false, created: false });

        edTitle.value = note ? note.title : '';
        edBody.innerHTML = note ? Rich.sanitize(note.html) : '';
        edFolder.innerHTML = '<option value="">No folder</option>' +
            folders.map(f => `<option value="${escapeHTML(f.id)}">${escapeHTML(f.name)}</option>`).join('');
        edFolder.value = (note ? note.folderId : defaults.folderId) || '';
        edDate.textContent = new Date(editing.createdAt).toLocaleString(undefined, {
            weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit'
        });
        edArchive.hidden = edDelete.hidden = !note;
        if (note) edArchive.querySelector('span').textContent = note.archived ? 'Unarchive' : 'Archive';
        edEmotionPicker.hidden = true;
        edSaved.textContent = note ? 'All changes saved' : '';

        paintEditor();
        renderAttachments();
        renderReflection();
        updateWords();
        editor.showModal();
        edReflection.querySelectorAll('textarea').forEach(autoGrow);
        if (note) {
            edBody.focus();
            Rich.placeCaretAtEnd(edBody);
        } else {
            edTitle.focus();
        }
    }

    function emptySections() {
        return { gratitude: '', highlights: '', learned: '', improve: '' };
    }

    function paintEditor() {
        editor.className = `editor tinted c-${editing.color}`;
        paintSwatches($('editor-colors'), editing.color);
        $('editor-kind').querySelectorAll('button').forEach(b =>
            b.setAttribute('aria-checked', String(b.dataset.kind === editing.kind)));
        editor.querySelectorAll('.mood').forEach(b =>
            b.setAttribute('aria-checked', String(b.dataset.mood === editing.mood)));
        edPrivate.checked = editing.private;
        edShare.checked = editing.shared && !editing.private;
        edShare.disabled = editing.private;
        edShare.closest('label').classList.toggle('disabled', editing.private);
        edTitle.placeholder = editing.kind === 'free' ? 'Title' : `${KINDS[editing.kind].label} journal — ${new Date(editing.createdAt).toLocaleDateString(undefined, { weekday: 'long' })}`;

        // Emotions: selected chips + an add button
        edEmotions.innerHTML = editing.emotions.map(e =>
            `<button type="button" class="emotion-chip on" data-emotion="${escapeHTML(e)}" title="Remove ${escapeHTML(e)}">${escapeHTML(e)} <span aria-hidden="true">×</span></button>`).join('') +
            `<button type="button" class="emotion-add" data-add-emotion>${editing.emotions.length ? '+' : '+ How do you feel?'}</button>`;
        edEmotionPicker.querySelectorAll('[data-emotion]').forEach(c =>
            c.setAttribute('aria-pressed', String(editing.emotions.includes(c.dataset.emotion))));

        const loc = editing.location;
        edLocation.querySelector('span').textContent = loc
            ? `${loc.place}${loc.weather ? ` · ${loc.weather.emoji} ${loc.weather.temp}° ${loc.weather.label}` : ''}`
            : 'Add location & weather';
        edLocation.classList.toggle('set', !!loc);
    }

    function toggleEmotion(emotion) {
        const i = editing.emotions.indexOf(emotion);
        if (i === -1) editing.emotions.push(emotion);
        else editing.emotions.splice(i, 1);
        paintEditor();
        changed();
    }

    edShare.addEventListener('change', () => {
        // social.js may veto sharing (e.g. when signed out)
        if (edShare.checked && hooks.shareToggle && !hooks.shareToggle()) {
            edShare.checked = false;
            return;
        }
        editing.shared = edShare.checked;
        changed();
    });

    edPrivate.addEventListener('change', () => {
        editing.private = edPrivate.checked;
        if (editing.private) editing.shared = false;
        paintEditor();
        changed();
        if (editing.private && !load('diaryPin', null)) showToast('Tip: set a PIN in the menu to lock private entries');
    });

    edLocation.addEventListener('click', async () => {
        if (editing.location) {
            openPopover(edLocation, [
                { label: 'Update location & weather', icon: 'i-pin', onClick: fetchLocation },
                { label: 'Remove', icon: 'i-trash', danger: true, onClick: () => { editing.location = null; paintEditor(); changed(); } }
            ]);
            return;
        }
        fetchLocation();
    });

    async function fetchLocation() {
        const label = edLocation.querySelector('span');
        label.textContent = 'Finding you…';
        try {
            editing.location = await Media.locate();
            changed();
        } catch (err) {
            showToast(err.message);
        }
        if (editing) paintEditor();
    }

    edFolder.addEventListener('change', changed);

    // ---------- Attachments ----------
    async function pickAndAdd(accept) {
        addFiles(await Media.pickFiles(accept));
    }

    async function addFiles(files, kindOverride) {
        if (!editing || !files.length) return;
        for (const file of files) {
            if (file.size > MAX_FILE) {
                showToast(`${file.name || 'File'} is larger than 25 MB`);
                continue;
            }
            const att = {
                id: uid(),
                kind: kindOverride || Media.kindOf(file.type || ''),
                name: file.name || `${kindOverride || 'attachment'}-${new Date().toISOString().slice(0, 10)}`,
                type: file.type || 'application/octet-stream',
                size: file.size,
                duration: file.duration
            };
            try {
                await Media.put(att.id, file);
            } catch (e) {
                showToast('Could not store that file on this device');
                continue;
            }
            if (!editing) return Media.del(att.id);
            editing.attachments.push(att);
        }
        renderAttachments();
        changed();
    }

    async function recordVoiceNote() {
        const result = await Media.recordVoice();
        if (!result) return;
        if (result.error) return showToast(result.error);
        const blob = result.blob;
        blob.duration = result.duration;
        blob.name = `Voice note ${new Date().toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}`;
        const file = new File([blob], blob.name, { type: result.type });
        file.duration = result.duration;
        addFiles([file], 'audio');
    }

    async function drawNote() {
        const result = await Media.drawPad();
        if (!result) return;
        const file = new File([result.blob], `Drawing ${new Date().toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}.png`, { type: 'image/png' });
        addFiles([file], 'drawing');
    }

    function renderAttachments() {
        const list = editing.attachments;
        edAttachments.hidden = !list.length;
        edAttachments.innerHTML = list.map(a => {
            const remove = `<button type="button" class="att-remove" data-remove="${escapeHTML(a.id)}" aria-label="Remove ${escapeHTML(a.name)}"><svg class="i"><use href="#i-close"/></svg></button>`;
            if (a.kind === 'image' || a.kind === 'drawing') {
                return `<figure class="att-thumb${a.kind === 'drawing' ? ' drawing' : ''}">
                    <button type="button" class="att-view" data-view="${escapeHTML(a.id)}" aria-label="View ${escapeHTML(a.name)}"><img data-media="${escapeHTML(a.id)}" alt="${escapeHTML(a.name)}"></button>
                    ${remove}</figure>`;
            }
            if (a.kind === 'audio') {
                return `<div class="att-audio"><svg class="i"><use href="#i-mic"/></svg>
                    <audio controls preload="metadata" data-media="${escapeHTML(a.id)}"></audio>
                    <span class="muted small">${Media.formatDuration(a.duration)}</span>${remove}</div>`;
            }
            return `<div class="att-file"><a data-media="${escapeHTML(a.id)}" download="${escapeHTML(a.name)}">
                <svg class="i"><use href="#i-file"/></svg><span>${escapeHTML(a.name)}<small>${Media.formatSize(a.size)}</small></span></a>${remove}</div>`;
        }).join('');
        Media.hydrate(edAttachments);
    }

    edAttachments.addEventListener('click', async e => {
        const remove = e.target.closest('[data-remove]');
        if (remove) {
            const id = remove.dataset.remove;
            editing.attachments = editing.attachments.filter(a => a.id !== id);
            Media.del(id);
            renderAttachments();
            changed();
            return;
        }
        const view = e.target.closest('[data-view]');
        if (view) {
            const u = await Media.url(view.dataset.view);
            if (u) Media.lightbox(u);
        }
    });

    // ---------- Reflection sections & goals ----------
    function renderReflection() {
        const shown = new Set(KIND_SECTIONS[editing.kind]);
        Object.keys(SECTIONS).forEach(k => { if (editing.sections[k].trim()) shown.add(k); });
        editing.shownSections.forEach(k => shown.add(k));
        const showGoals = editing.kind !== 'free' || editing.goals.length > 0 || editing.showGoals;
        const hidden = Object.keys(SECTIONS).filter(k => !shown.has(k));

        const blocks = Object.keys(SECTIONS).filter(k => shown.has(k)).map(k => `
            <div class="reflect-block">
                <label for="section-${k}"><span aria-hidden="true">${SECTIONS[k].icon}</span> ${SECTIONS[k].label}</label>
                <textarea id="section-${k}" data-section="${k}" rows="2" placeholder="${SECTIONS[k].placeholder}">${escapeHTML(editing.sections[k])}</textarea>
            </div>`).join('');

        const goals = showGoals ? `
            <div class="reflect-block">
                <label><span aria-hidden="true">🎯</span> Daily goals</label>
                <ul class="goal-edit">
                    ${editing.goals.map(g => `
                        <li>
                            <input type="checkbox" data-goal-done="${escapeHTML(g.id)}" aria-label="Done"${g.done ? ' checked' : ''}>
                            <input class="goal-text${g.done ? ' done' : ''}" data-goal-text="${escapeHTML(g.id)}" value="${escapeHTML(g.text)}" aria-label="Goal">
                            <button type="button" class="att-remove" data-goal-remove="${escapeHTML(g.id)}" aria-label="Remove goal"><svg class="i"><use href="#i-close"/></svg></button>
                        </li>`).join('')}
                </ul>
                <input class="goal-new" id="goal-new" placeholder="Add a goal and press Enter" autocomplete="off">
            </div>` : '';

        const adders = [
            ...hidden.map(k => `<button type="button" class="chip" data-show-section="${k}">+ ${SECTIONS[k].label}</button>`),
            showGoals ? '' : '<button type="button" class="chip" data-show-goals>+ Daily goals</button>'
        ].join('');

        edReflection.innerHTML = `${blocks}${goals}${adders ? `<div class="reflect-adders">${adders}</div>` : ''}`;
        edReflection.querySelectorAll('textarea').forEach(autoGrow);
    }

    edReflection.addEventListener('input', e => {
        const t = e.target;
        if (t.dataset.section) {
            editing.sections[t.dataset.section] = t.value;
            autoGrow(t);
            changed();
        } else if (t.dataset.goalText) {
            const g = editing.goals.find(x => x.id === t.dataset.goalText);
            if (g) g.text = t.value;
            changed();
        }
    });

    edReflection.addEventListener('change', e => {
        const id = e.target.dataset.goalDone;
        if (!id) return;
        const g = editing.goals.find(x => x.id === id);
        if (g) g.done = e.target.checked;
        renderReflection();
        changed();
    });

    edReflection.addEventListener('keydown', e => {
        if (e.target.id === 'goal-new' && e.key === 'Enter') {
            e.preventDefault();
            const text = e.target.value.trim();
            if (!text) return;
            editing.goals.push({ id: uid(), text, done: false });
            renderReflection();
            $('goal-new').focus();
            changed();
        } else if (e.target.dataset.goalText && e.key === 'Enter') {
            e.preventDefault();
            $('goal-new').focus();
        }
    });

    edReflection.addEventListener('click', e => {
        const show = e.target.closest('[data-show-section]');
        if (show) {
            editing.shownSections.add(show.dataset.showSection);
            renderReflection();
            $(`section-${show.dataset.showSection}`).focus();
            return;
        }
        if (e.target.closest('[data-show-goals]')) {
            editing.showGoals = true;
            renderReflection();
            $('goal-new').focus();
            return;
        }
        const remove = e.target.closest('[data-goal-remove]');
        if (remove) {
            editing.goals = editing.goals.filter(g => g.id !== remove.dataset.goalRemove);
            renderReflection();
            changed();
        }
    });

    function autoGrow(el) {
        if (!el.isConnected || !el.offsetParent) return; // not visible yet — measured again once the editor opens
        el.style.height = 'auto';
        el.style.height = el.scrollHeight + 'px';
    }

    // ---------- Saving (automatic) ----------
    function changed() {
        if (!editing) return;
        updateWords();
        edSaved.textContent = 'Saving…';
        clearTimeout(saveTimer);
        saveTimer = setTimeout(() => {
            if (!editing) return;
            if (save(editing)) render();
            edSaved.textContent = editing.id
                ? `Saved ${new Date().toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}`
                : '';
        }, 700);
    }

    function collectFields(session) {
        const html = Rich.sanitize(edBody.innerHTML);
        return {
            title: edTitle.value.trim(),
            html,
            text: Rich.toText(html),
            folderId: edFolder.value || null,
            color: session.color,
            mood: session.mood,
            emotions: [...session.emotions],
            kind: session.kind,
            sections: Object.fromEntries(Object.entries(session.sections).map(([k, v]) => [k, v.trim()])),
            goals: session.goals.filter(g => g.text.trim()).map(g => ({ ...g, text: g.text.trim() })),
            attachments: session.attachments.map(a => ({ ...a })),
            location: session.location,
            private: session.private,
            shared: session.shared && !session.private
        };
    }

    function isEmpty(f) {
        return !f.title && !f.text && !f.attachments.length &&
            !Object.values(f.sections).some(Boolean) && !f.goals.length;
    }

    function save(session) {
        const fields = collectFields(session);
        if (isEmpty(fields)) return false;

        let n;
        if (session.id) {
            n = notes.find(x => x.id === session.id);
            if (!n) return false;
            const same = Object.keys(fields).every(k => JSON.stringify(n[k]) === JSON.stringify(fields[k]));
            if (same) return false;
            Object.assign(n, fields, { updatedAt: Date.now() });
        } else {
            n = { id: uid(), ...fields, archived: false, trashedAt: null, createdAt: session.createdAt, updatedAt: Date.now() };
            notes.push(n);
            sortNotes();
            session.id = n.id;
            session.created = true;
            edArchive.hidden = edDelete.hidden = false;
            edArchive.querySelector('span').textContent = 'Archive';
        }
        session.changed = true;
        persist();
        emit('note', n);
        return true;
    }

    function updateWords() {
        const sections = Object.values(editing.sections).join(' ');
        const count = countWords(`${edTitle.value} ${Rich.toText(edBody.innerHTML)} ${sections}`);
        edWords.textContent = `${count} ${count === 1 ? 'word' : 'words'}`;
    }

    edBody.addEventListener('input', changed);
    edTitle.addEventListener('input', changed);
    edTitle.addEventListener('keydown', e => {
        if (e.key === 'Enter' && !e.ctrlKey && !e.metaKey) {
            e.preventDefault();
            edBody.focus();
        }
    });
    editor.addEventListener('keydown', e => {
        if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
            e.preventDefault();
            editor.close();
        }
    });
    $('editor-close').addEventListener('click', () => editor.close());
    $('editor-form').addEventListener('submit', e => {
        // Only the Done button submits; Enter inside fields must not close the editor
        if (e.submitter && e.submitter.id !== 'editor-done') e.preventDefault();
    });

    // Close on backdrop click (only if the press also started on the backdrop)
    let pressedBackdrop = false;
    editor.addEventListener('mousedown', e => { pressedBackdrop = e.target === editor; });
    editor.addEventListener('click', e => {
        if (e.target === editor && pressedBackdrop) editor.close();
    });

    // Closing saves one last time; a brand-new entry that stayed empty leaves nothing behind
    editor.addEventListener('close', () => {
        const session = editing;
        editing = null;
        clearTimeout(saveTimer);
        if (!session) return;
        const savedNow = save(session);
        if (!session.id) {
            session.attachments.forEach(a => Media.del(a.id));
            return;
        }
        render();
        if (!session.silent && (savedNow || session.changed)) {
            const n = notes.find(x => x.id === session.id);
            showToast(session.created
                ? (n && n.shared ? 'Entry saved and shared with friends' : 'Entry saved')
                : 'Entry updated');
        }
    });

    // Archive/Delete save pending edits first and silence the close handler's toast so theirs (with Undo) stays
    edArchive.addEventListener('click', () => {
        const session = editing;
        session.silent = true;
        save(session);
        editor.close();
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
        session.silent = true;
        save(session);
        editor.close();
        const n = notes.find(x => x.id === session.id);
        if (!n) return;
        n.trashedAt = Date.now();
        persist();
        emit('note', n);
        render();
        showToast('Moved to trash', () => {
            n.trashedAt = null;
            persist();
            emit('note', n);
            render();
        });
    });

    async function askLink(current) {
        const r = await ask({ title: current ? 'Edit link' : 'Add a link', value: current || '', placeholder: 'https://example.com', ok: 'Save', allowEmpty: !!current });
        return r ? r.value : null;
    }

    // ---------- Notes: trash ----------
    function restoreNote(id) {
        const n = notes.find(x => x.id === id);
        if (!n) return;
        n.trashedAt = null;
        persist();
        emit('note', n);
        render();
        showToast('Entry restored');
    }

    function removeNotes(predicate) {
        notes.filter(predicate).forEach(n => {
            emit('note-removed', n);
            n.attachments.forEach(a => Media.del(a.id));
        });
        notes = notes.filter(n => !predicate(n));
    }

    async function destroyNote(id) {
        const ok = await ask({ title: 'Delete forever?', text: 'This entry and its attachments will be permanently deleted. This can’t be undone.', ok: 'Delete', danger: true });
        if (!ok) return;
        removeNotes(n => n.id === id);
        persist();
        render();
        showToast('Entry deleted');
    }

    async function emptyTrash() {
        const count = notes.filter(n => n.trashedAt).length;
        const ok = await ask({ title: 'Empty trash?', text: `${count} ${count === 1 ? 'entry' : 'entries'} will be permanently deleted. This can’t be undone.`, ok: 'Empty trash', danger: true });
        if (!ok) return;
        removeNotes(n => !!n.trashedAt);
        persist();
        render();
        showToast('Trash emptied');
    }

    function purgeTrash() {
        const cutoff = Date.now() - TRASH_DAYS * DAY_MS;
        const before = notes.length;
        removeNotes(n => n.trashedAt && n.trashedAt <= cutoff);
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
        if (hooks.rename) return hooks.rename();
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
        const nav = [['home', 'Notes', 'i-notes'], ['calendar', 'Calendar', 'i-calendar'], ['insights', 'Insights', 'i-chart'],
            ['photos', 'Photos', 'i-image'], ['feed', 'Feed', 'i-feed'], ['messages', 'Messages', 'i-chat'],
            ['archive', 'Archive', 'i-archive'], ['trash', 'Trash', 'i-trash']]
            .map(([view, label, icon]) => ({ label, icon, cls: 'mobile-only', onClick: () => setView(view) }));
        openPopover(anchor, [
            ...nav,
            { sep: true, cls: 'mobile-only' },
            ...(hooks.menuItems ? hooks.menuItems() : []),
            {
                label: isDark() ? 'Light mode' : 'Dark mode',
                icon: isDark() ? 'i-sun' : 'i-moon',
                onClick: () => {
                    const next = isDark() ? 'light' : 'dark';
                    document.documentElement.dataset.theme = next;
                    try { localStorage.setItem('diaryTheme', next); } catch (e) {}
                }
            },
            { label: load('diaryPin', null) ? 'Change private PIN' : 'Set private PIN', icon: 'i-lock', onClick: setPin },
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

        // Inside a modal dialog the rest of the page is inert, so the menu has to live in the dialog
        const host = anchor.closest('dialog') || document.body;
        if (popover.parentElement !== host) host.append(popover);

        items.forEach(item => {
            if (item.sep) {
                const s = document.createElement('div');
                s.className = 'pop-sep' + (item.cls ? ` ${item.cls}` : '');
                popover.append(s);
                return;
            }
            const b = document.createElement('button');
            b.type = 'button';
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
    function ask({ title, text = '', value = null, placeholder = '', color = null, ok = 'OK', danger = false, allowEmpty = false, inputType = 'text' }) {
        return new Promise(resolve => {
            $('ask-title').textContent = title;
            $('ask-text').textContent = text;
            $('ask-text').hidden = !text;
            askInput.hidden = value === null;
            askInput.type = inputType;
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
        toastTimer = setTimeout(hideToast, undo ? 5000 : 2400);
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

    // ---------- Public API for social.js / ai.js ----------
    function emit(type, payload) {
        (listeners[type] || []).forEach(fn => fn(payload));
    }

    window.diaryApp = {
        views, actions, hooks, state,
        on(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
        getNotes: () => notes,
        render, setView, setTitle, showToast, ask, askLink, openPopover, closePopover,
        escapeHTML, initials, shortDate, dayLabel, dayKey, renameUser, fullText,
        // The AI assistant reads and writes the open entry through this
        editorApi: {
            getTitle: () => edTitle.value,
            setTitle(value) { edTitle.value = value; changed(); },
            getText: () => Rich.toText(edBody.innerHTML),
            setText(text) { edBody.innerHTML = Rich.textToHTML(text); changed(); },
            appendText(text) {
                const sep = Rich.toText(edBody.innerHTML) ? '<br><br>' : '';
                edBody.insertAdjacentHTML('beforeend', sep + Rich.textToHTML(text));
                changed();
            },
            focus() { edBody.focus(); Rich.placeCaretAtEnd(edBody); }
        }
    };

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

    // Upgrades entries saved by earlier versions (plain text, no journal fields)
    function migrateNote(n, i) {
        if (!n || typeof n.text !== 'string') return null;
        const fromId = Number(n.id);
        const createdAt = Number.isFinite(n.createdAt) ? n.createdAt
            : Number.isFinite(fromId) ? fromId
            : Date.parse(n.date) || Date.now();
        const sections = { ...emptySections() };
        if (n.sections && typeof n.sections === 'object') {
            Object.keys(sections).forEach(k => { if (typeof n.sections[k] === 'string') sections[k] = n.sections[k]; });
        }
        return {
            id: String(n.id ?? createdAt),
            title: typeof n.title === 'string' ? n.title : '',
            text: n.text,
            html: typeof n.html === 'string' ? n.html : Rich.textToHTML(n.text),
            mood: MOODS[n.mood] ? n.mood : null,
            emotions: Array.isArray(n.emotions) ? n.emotions.filter(e => EMOTIONS.includes(e)) : [],
            kind: KINDS[n.kind] ? n.kind : 'free',
            sections,
            goals: Array.isArray(n.goals) ? n.goals.filter(g => g && typeof g.text === 'string').map(g => ({ id: String(g.id || uid()), text: g.text, done: !!g.done })) : [],
            attachments: Array.isArray(n.attachments) ? n.attachments.filter(a => a && a.id && a.kind) : [],
            location: n.location && typeof n.location.place === 'string' ? n.location : null,
            color: COLORS.includes(n.color) ? n.color : COLORS[i % COLORS.length],
            folderId: n.folderId ?? null,
            archived: !!n.archived,
            private: !!n.private,
            shared: !!n.shared && !n.private,
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

    function fullText(n) {
        return [n.title, n.text, ...Object.values(n.sections), ...n.goals.map(g => g.text), ...n.emotions].join('\n');
    }

    function matches(n) {
        if (!state.query) return true;
        if (n.private && !privateUnlocked) return false;
        return fullText(n).toLowerCase().includes(state.query);
    }

    function folderActivity(f) {
        return notes.reduce((latest, n) =>
            n.folderId === f.id && !n.trashedAt ? Math.max(latest, n.updatedAt) : latest, f.createdAt);
    }

    function countBy(list, keyFn) {
        return list.reduce((acc, item) => {
            const k = keyFn(item);
            acc[k] = (acc[k] || 0) + 1;
            return acc;
        }, {});
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
