// Note backup: your notes (and their photos, voice notes, drawings and files) are copied to your account,
// so signing in on a new phone or computer brings them all back. Only you can read your backup.
//
// How it works: every note is one row in diary_note_backups (the folders list is one more row). We remember a
// fingerprint of each note as it was last backed up; anything that changed on this device goes up, anything that
// changed in the account (another device) comes down. Attachments go to the private "diary-note-media" bucket and
// are downloaded on demand the first time a restored note needs them.
document.addEventListener('DOMContentLoaded', () => {
    const app = window.diaryApp;
    const social = window.diarySocial;
    if (!app || !social || !social.available || !social.internals) return;
    const I = social.internals;
    const { client } = I;
    const s = I.state;
    const BUCKET = 'diary-note-media';
    const FOLDERS_ROW = '__folders__';

    const B = {
        uid: null,
        busy: false,
        again: false,
        timer: null,
        lastSync: null,
        error: null,
        memo: null   // { notes: { id: fingerprint }, folders: fingerprint, media: [ids] } for this account
    };

    window.diaryBackup = {
        status: () => ({ signedIn: !!B.uid, busy: B.busy, lastSync: B.lastSync, error: B.error, count: B.uid ? app.getNotes().length : 0 }),
        syncNow: () => sync(true),
        onchange: null
    };
    const changed = () => { if (window.diaryBackup.onchange) window.diaryBackup.onchange(window.diaryBackup.status()); };

    // A cheap, stable fingerprint of a note's saved form
    function print(value) {
        const str = JSON.stringify(value);
        let h = 5381;
        for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) | 0;
        return `${str.length}:${h >>> 0}`;
    }

    const memoKey = () => `diaryBackup:${B.uid}`;
    function loadMemo() {
        try { B.memo = JSON.parse(localStorage.getItem(memoKey())) || null; } catch (e) { B.memo = null; }
        if (!B.memo) B.memo = { notes: {}, folders: '', media: [] };
        B.lastSync = B.memo.lastSync || null;
    }
    function saveMemo() {
        B.memo.lastSync = B.lastSync;
        try { localStorage.setItem(memoKey(), JSON.stringify(B.memo)); } catch (e) {}
    }

    // Attachments restored from the backup are fetched the first time something shows them
    Media.remote = async id => {
        if (!B.uid || !navigator.onLine) return null;
        const { data, error } = await client.storage.from(BUCKET).download(`${B.uid}/${id}`);
        return error ? null : data;
    };

    // ---------- Signing in and out ----------
    // Follow the signed-in account (social.js owns sign-in; we just watch it)
    setInterval(watchAccount, 800);
    function watchAccount() {
        const uid = (s.profile && s.profile.id) || null;
        if (uid === B.uid) return;
        B.uid = uid;
        B.error = null;
        if (!uid) {
            // Signed out: this account's notes are hidden again (still on this device, and in the account)
            app.switchAccount(null);
            changed();
            return;
        }
        app.switchAccount(uid);
        loadMemo();
        changed();
        start();
    }

    async function start() {
        const uid = B.uid;
        // Notes written on this device before signing in: offer them to this account, once
        const loose = app.looseNotes();
        const askedKey = `diaryAdoptAsked:${uid}`;
        let asked = false;
        try { asked = localStorage.getItem(askedKey) === '1'; } catch (e) {}
        if (loose.length && !asked) {
            try { localStorage.setItem(askedKey, '1'); } catch (e) {}
            const ok = await app.ask({
                title: `Add ${loose.length} ${loose.length === 1 ? 'note' : 'notes'} to your account?`,
                text: 'These were written on this device before you signed in. Adding them backs them up to your account, so they’re safe and come back on any device you sign in to. If you don’t, they stay on this device and show when you’re signed out.',
                ok: 'Add and back up'
            });
            if (B.uid !== uid) return;
            if (ok) {
                const n = app.adoptLooseNotes();
                app.showToast(`${n} ${n === 1 ? 'note' : 'notes'} added to your account`);
            }
        }
        await sync(false, { announce: true });
    }

    // Back up soon after you change something
    app.on('saved', () => {
        if (!B.uid) return;
        clearTimeout(B.timer);
        B.timer = setTimeout(() => sync(false), 2500);
    });
    window.addEventListener('online', () => { if (B.uid) sync(false); });
    // Pick up changes made on your other devices when you come back to the app
    document.addEventListener('visibilitychange', () => {
        if (!document.hidden && B.uid && Date.now() - (B.lastSync || 0) > 60000) sync(false);
    });

    // ---------- Sync ----------
    async function sync(manual, { announce = false } = {}) {
        if (!B.uid) return;
        if (!navigator.onLine) {
            if (manual) app.showToast('You’re offline — your notes will back up when you’re back online');
            return;
        }
        if (B.busy) { B.again = true; return; }
        const uid = B.uid;
        B.busy = true;
        B.error = null;
        changed();
        try {
            const restored = await pull(uid);
            if (B.uid !== uid) return;
            const pushed = await push(uid);
            if (B.uid !== uid) return;
            await pushMedia(uid);
            B.lastSync = Date.now();
            saveMemo();
            if (announce && restored > 0) app.showToast(`Restored ${restored} ${restored === 1 ? 'note' : 'notes'} from your account ✓`);
            else if (manual) app.showToast(pushed || restored ? 'Backup up to date ✓' : 'Everything’s already backed up ✓');
        } catch (e) {
            B.error = 'Couldn’t reach your backup';
            if (manual) app.showToast('Couldn’t back up right now — we’ll try again');
        } finally {
            B.busy = false;
            changed();
            if (B.again) {
                B.again = false;
                setTimeout(() => sync(false), 500);
            }
        }
    }

    // Bring down what changed in the account since this device last synced
    async function pull(uid) {
        const rows = [];
        for (let from = 0; ; from += 500) {
            const { data, error } = await client.from('diary_note_backups')
                .select('note_id, data, deleted, updated_at')
                .order('note_id')
                .range(from, from + 499);
            if (error) throw error;
            rows.push(...data);
            if (data.length < 500) break;
        }
        if (B.uid !== uid) return 0;
        const local = new Map(app.getNotes().map(n => [n.id, n]));
        const upserts = [];
        const removeIds = [];
        let folderList = null;
        rows.forEach(row => {
            if (row.note_id === FOLDERS_ROW) {
                const cloud = print(row.data.folders || []);
                const mine = print(app.getFolders());
                if (cloud !== mine && (!B.memo.folders || B.memo.folders === mine)) folderList = row.data.folders || [];
                B.memo.folders = folderList ? cloud : B.memo.folders;
                return;
            }
            const id = row.note_id;
            const here = local.get(id);
            const lastSeen = B.memo.notes[id];
            if (row.deleted) {
                // Deleted on another device: remove here too, unless you've changed it here since
                if (here && (!lastSeen || print(here) === lastSeen)) removeIds.push(id);
                delete B.memo.notes[id];
                return;
            }
            const cloud = print(row.data);
            if (!here) {
                upserts.push(row.data);
                B.memo.notes[id] = cloud;
                return;
            }
            const mine = print(here);
            if (mine === cloud) {
                B.memo.notes[id] = cloud;
                return;
            }
            const untouchedHere = lastSeen && mine === lastSeen;
            const newer = (row.data.updatedAt || row.data.createdAt || 0) > (here.updatedAt || here.createdAt || 0);
            if (untouchedHere || (!lastSeen && newer)) {
                upserts.push(row.data);
                B.memo.notes[id] = cloud;
            }
            // Otherwise this device has newer edits: push() sends them up
        });
        if (upserts.length || removeIds.length || folderList) app.importNotes({ upserts, removeIds, folderList });
        // Their attachments already live in the backup (another device put them there): no need to upload again
        const known = new Set(B.memo.media);
        upserts.forEach(n => (n.attachments || []).forEach(a => { if (!known.has(a.id)) { known.add(a.id); B.memo.media.push(a.id); } }));
        return upserts.filter(n => !local.has(n.id)).length;
    }

    // Send up what changed on this device
    async function push(uid) {
        const notes = app.getNotes();
        const now = new Date().toISOString();
        const rows = [];
        notes.forEach(n => {
            const fp = print(n);
            if (B.memo.notes[n.id] !== fp) rows.push({ note_id: n.id, data: n, deleted: false, updated_at: now, fp });
        });
        const live = new Set(notes.map(n => n.id));
        Object.keys(B.memo.notes).forEach(id => {
            if (!live.has(id)) rows.push({ note_id: id, data: {}, deleted: true, updated_at: now, fp: null });
        });
        const folderPrint = print(app.getFolders());
        if (B.memo.folders !== folderPrint) rows.push({ note_id: FOLDERS_ROW, data: { folders: app.getFolders() }, deleted: false, updated_at: now, fp: folderPrint, folders: true });
        for (let i = 0; i < rows.length; i += 50) {
            const batch = rows.slice(i, i + 50);
            const { error } = await client.from('diary_note_backups')
                .upsert(batch.map(({ note_id, data, deleted, updated_at }) => ({ note_id, data, deleted, updated_at })), { onConflict: 'user_id,note_id' });
            if (error) throw error;
            if (B.uid !== uid) return 0;
            batch.forEach(r => {
                if (r.folders) B.memo.folders = r.fp;
                else if (r.deleted) delete B.memo.notes[r.note_id];
                else B.memo.notes[r.note_id] = r.fp;
            });
            saveMemo();
        }
        return rows.length;
    }

    // Photos, voice notes, drawings and files: each uploaded once
    async function pushMedia(uid) {
        const done = new Set(B.memo.media);
        const wanted = app.getNotes().flatMap(n => (n.attachments || []).map(a => a.id)).filter(id => !done.has(id));
        for (const id of wanted) {
            if (B.uid !== uid || !navigator.onLine) return;
            const bytes = await Media.bytes(id);
            if (!bytes) continue;
            const { error } = await client.storage.from(BUCKET).upload(`${uid}/${id}`, bytes.buf, { contentType: bytes.type || 'application/octet-stream', upsert: true });
            if (!error || /exists/i.test(error.message || '')) {
                B.memo.media.push(id);
                saveMemo();
            }
        }
    }
});
