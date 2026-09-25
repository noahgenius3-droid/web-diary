document.addEventListener('DOMContentLoaded', () => {
    const noteInput = document.getElementById('note-input');
    const saveBtn = document.getElementById('save-btn');
    const notesList = document.getElementById('notes-list');
    const searchInput = document.getElementById('search-input');
    const wordCount = document.getElementById('word-count');
    const moodButtons = document.querySelectorAll('.mood');
    const themeToggle = document.getElementById('theme-toggle');
    const toast = document.getElementById('toast');
    const toastText = document.getElementById('toast-text');
    const toastUndo = document.getElementById('toast-undo');

    const MOODS = { happy: '😊', calm: '😌', thoughtful: '🤔', sad: '😔', stressed: '😤' };

    let notes = load('diaryNotes', []);
    let selectedMood = null;
    let lastDeleted = null;
    let toastTimer = null;

    renderHeader();
    renderNotes();

    // ---------- Composer ----------
    noteInput.addEventListener('input', () => {
        autoResize();
        const count = countWords(noteInput.value);
        wordCount.textContent = `${count} ${count === 1 ? 'word' : 'words'}`;
        saveBtn.disabled = noteInput.value.trim() === '';
    });

    noteInput.addEventListener('keydown', (e) => {
        if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
            e.preventDefault();
            saveNote();
        }
    });

    saveBtn.addEventListener('click', saveNote);

    moodButtons.forEach(btn => {
        btn.addEventListener('click', () => {
            const mood = btn.dataset.mood;
            selectedMood = selectedMood === mood ? null : mood;
            moodButtons.forEach(b => b.setAttribute('aria-checked', String(b.dataset.mood === selectedMood)));
        });
    });

    function saveNote() {
        const text = noteInput.value.trim();
        if (text === '') return;

        const now = new Date();
        notes.unshift({
            id: now.getTime().toString(),
            text,
            mood: selectedMood,
            date: now.toLocaleString(undefined, {
                weekday: 'short', year: 'numeric', month: 'short',
                day: 'numeric', hour: '2-digit', minute: '2-digit'
            })
        });

        saveNotes();
        noteInput.value = '';
        noteInput.dispatchEvent(new Event('input'));
        selectedMood = null;
        moodButtons.forEach(b => b.setAttribute('aria-checked', 'false'));
        searchInput.value = '';
        renderNotes();
        renderHeader();
        showToast('Entry saved', false);
    }

    function autoResize() {
        noteInput.style.height = 'auto';
        noteInput.style.height = noteInput.scrollHeight + 'px';
    }

    // ---------- Search ----------
    searchInput.addEventListener('input', renderNotes);

    // ---------- Theme ----------
    themeToggle.addEventListener('click', () => {
        const root = document.documentElement;
        const current = root.dataset.theme ||
            (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
        const next = current === 'dark' ? 'light' : 'dark';
        root.dataset.theme = next;
        try { localStorage.setItem('diaryTheme', next); } catch (e) {}
    });

    // ---------- Rendering ----------
    function renderHeader() {
        const now = new Date();
        const hour = now.getHours();
        const greeting = hour < 12 ? 'Good morning.' : hour < 18 ? 'Good afternoon.' : 'Good evening.';
        document.getElementById('greeting').textContent = greeting;
        document.getElementById('today').textContent = now.toLocaleDateString(undefined, {
            weekday: 'long', month: 'long', day: 'numeric'
        });

        document.getElementById('stat-entries').textContent = notes.length;
        document.getElementById('stat-words').textContent =
            notes.reduce((sum, n) => sum + countWords(n.text), 0).toLocaleString();
        document.getElementById('stat-streak').textContent = calcStreak();
    }

    function renderNotes() {
        const query = searchInput.value.trim().toLowerCase();
        const visible = query ? notes.filter(n => n.text.toLowerCase().includes(query)) : notes;

        notesList.innerHTML = '';

        if (notes.length === 0) {
            notesList.innerHTML = `
                <div class="empty">
                    <p class="empty-title">Your diary is empty</p>
                    <p>Write your first entry above to get started.</p>
                </div>`;
            return;
        }

        if (visible.length === 0) {
            notesList.innerHTML = `
                <div class="empty">
                    <p class="empty-title">No matches</p>
                    <p>Nothing found for “${escapeHTML(searchInput.value.trim())}”.</p>
                </div>`;
            return;
        }

        // Group entries by calendar day
        const groups = new Map();
        visible.forEach(note => {
            const key = dayKey(noteTime(note));
            if (!groups.has(key)) groups.set(key, []);
            groups.get(key).push(note);
        });

        groups.forEach((groupNotes, key) => {
            const group = document.createElement('div');
            group.className = 'day-group';
            group.innerHTML = `<div class="day-label">${dayLabel(key)}</div><div class="day-entries"></div>`;
            const container = group.querySelector('.day-entries');

            groupNotes.forEach(note => {
                const card = document.createElement('article');
                card.className = 'note-card';
                const time = noteTime(note).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
                const mood = note.mood && MOODS[note.mood]
                    ? `<span class="note-mood" title="${note.mood}">${MOODS[note.mood]}</span>` : '';

                card.innerHTML = `
                    <div class="note-header">
                        ${mood}
                        <span class="note-time">${time}</span>
                        <button class="delete-btn" aria-label="Delete entry" title="Delete">
                            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0-1 14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2L4 6"/></svg>
                        </button>
                    </div>
                    <div class="note-content">${highlight(note.text, query)}</div>
                `;

                card.querySelector('.delete-btn').addEventListener('click', () => {
                    card.classList.add('removing');
                    card.addEventListener('animationend', () => deleteNote(note.id), { once: true });
                });

                container.appendChild(card);
            });

            notesList.appendChild(group);
        });
    }

    function deleteNote(id) {
        const index = notes.findIndex(n => n.id === id);
        if (index === -1) return;
        lastDeleted = { note: notes[index], index };
        notes.splice(index, 1);
        saveNotes();
        renderNotes();
        renderHeader();
        showToast('Entry deleted', true);
    }

    toastUndo.addEventListener('click', () => {
        if (!lastDeleted) return;
        notes.splice(lastDeleted.index, 0, lastDeleted.note);
        lastDeleted = null;
        saveNotes();
        renderNotes();
        renderHeader();
        hideToast();
    });

    function showToast(message, undoable) {
        toastText.textContent = message;
        toastUndo.hidden = !undoable;
        toast.classList.add('show');
        clearTimeout(toastTimer);
        toastTimer = setTimeout(hideToast, undoable ? 5000 : 2000);
    }

    function hideToast() {
        toast.classList.remove('show');
    }

    // ---------- Helpers ----------
    function load(key, fallback) {
        try {
            return JSON.parse(localStorage.getItem(key)) || fallback;
        } catch (e) {
            return fallback;
        }
    }

    function saveNotes() {
        try {
            localStorage.setItem('diaryNotes', JSON.stringify(notes));
        } catch (e) {
            showToast('Could not save — storage unavailable', false);
        }
    }

    // Ids are creation timestamps, so they work for older entries too
    function noteTime(note) {
        const t = Number(note.id);
        return Number.isFinite(t) ? new Date(t) : new Date(note.date);
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

    function calcStreak() {
        const days = new Set(notes.map(n => dayKey(noteTime(n))));
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

    function countWords(str) {
        const trimmed = str.trim();
        return trimmed ? trimmed.split(/\s+/).length : 0;
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
        return str.replace(/[&<>'"]/g,
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
