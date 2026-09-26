// Voice to note: record a conversation and watch it turn into text, then save it as a note
// (or drop it into the note you're writing). Uses the browser's own speech recognition —
// Chrome, Edge and Safari (including iPhone) support it.
document.addEventListener('DOMContentLoaded', () => {
    const app = window.diaryApp;
    if (!app) return;
    const $ = id => document.getElementById(id);
    const dialog = $('transcribe');
    const live = $('tr-live');
    const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    const isIOS = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    const PAUSE_BREAK = 2500; // a pause this long starts a new paragraph (often a new speaker)
    const LANGS = [
        ['en-US', 'English (US)'], ['en-GB', 'English (UK)'], ['en-NG', 'English (Nigeria)'], ['fr-FR', 'Français'],
        ['es-ES', 'Español'], ['pt-BR', 'Português'], ['de-DE', 'Deutsch'], ['yo-NG', 'Yorùbá'], ['ha-NG', 'Hausa'], ['ig-NG', 'Igbo']
    ];

    const t = {
        mode: 'note',        // 'note' saves a new note; 'insert' adds to the open editor
        rec: null,
        listening: false,
        paragraphs: [],      // finished text, one entry per paragraph
        interim: '',
        lastFinal: 0,
        started: 0,
        elapsed: 0,
        timer: null,
        audio: null,         // { recorder, chunks, stream }
        audioFile: null
    };

    window.diaryTranscribe = { open };

    // Language list, defaulting to the device language when we know it
    const langSelect = $('tr-lang');
    const device = navigator.language || 'en-US';
    const langs = LANGS.some(([code]) => code === device) ? LANGS : [[device, device], ...LANGS];
    langSelect.innerHTML = langs.map(([code, label]) => `<option value="${code}">${label}</option>`).join('');
    try { langSelect.value = localStorage.getItem('diaryTranscribeLang') || device; } catch (e) { langSelect.value = device; }
    langSelect.addEventListener('change', () => {
        try { localStorage.setItem('diaryTranscribeLang', langSelect.value); } catch (e) {}
        if (t.listening) {
            stopRecognition();
            startRecognition();
        }
    });

    function open(mode = 'note') {
        if (!Recognition) {
            app.ask({
                title: 'Speech to text isn’t available here',
                text: 'This browser can’t turn speech into text. Open Cordial in Chrome, Edge or Safari — or record a voice note instead.',
                ok: 'OK'
            });
            return;
        }
        Object.assign(t, { mode, paragraphs: [], interim: '', lastFinal: 0, elapsed: 0, audioFile: null });
        $('tr-title').textContent = mode === 'insert' ? 'Dictate into this note' : 'Record a conversation';
        $('tr-save').textContent = mode === 'insert' ? 'Add to note' : 'Save as note';
        $('tr-keep-row').hidden = mode === 'insert';
        // iPhones can't record audio and transcribe at the same time reliably, so audio is opt-in there
        $('tr-keep').checked = !isIOS && mode !== 'insert';
        paint();
        paintTime();
        dialog.showModal();
        start();
    }

    // ---------- Recording ----------
    async function start() {
        if (t.listening) return;
        t.listening = true;
        t.started = Date.now();
        t.timer = setInterval(paintTime, 500);
        dialog.classList.add('listening');
        $('tr-mic').setAttribute('aria-label', 'Pause');
        if ($('tr-keep').checked && !t.audio) startAudio();
        else if (t.audio && t.audio.recorder.state === 'paused') t.audio.recorder.resume();
        startRecognition();
    }

    function pause() {
        if (!t.listening) return;
        t.listening = false;
        t.elapsed += Date.now() - t.started;
        clearInterval(t.timer);
        dialog.classList.remove('listening');
        $('tr-mic').setAttribute('aria-label', 'Continue recording');
        stopRecognition();
        if (t.audio && t.audio.recorder.state === 'recording') t.audio.recorder.pause();
        commitInterim();
        paint();
        paintTime();
    }

    function startRecognition() {
        const rec = new Recognition();
        rec.lang = langSelect.value;
        rec.continuous = true;
        rec.interimResults = true;
        rec.maxAlternatives = 1;
        rec.onresult = e => {
            let interim = '';
            for (let i = e.resultIndex; i < e.results.length; i++) {
                const text = e.results[i][0].transcript;
                if (e.results[i].isFinal) addFinal(text);
                else interim += text;
            }
            t.interim = interim.trim();
            paint();
        };
        rec.onerror = e => {
            if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
                app.showToast('Allow microphone access to record');
                pause();
            } else if (e.error === 'network') {
                app.showToast('Speech to text needs an internet connection');
            }
        };
        // Browsers stop listening after a silence or about a minute — quietly start again
        rec.onend = () => {
            if (t.rec !== rec) return;
            commitInterim();
            if (t.listening) {
                try { rec.start(); } catch (err) { setTimeout(() => t.listening && t.rec === rec && rec.start(), 300); }
            }
        };
        t.rec = rec;
        try { rec.start(); } catch (e) { /* already started */ }
    }

    function stopRecognition() {
        const rec = t.rec;
        t.rec = null;
        if (rec) {
            rec.onend = null;
            try { rec.stop(); } catch (e) {}
        }
    }

    function addFinal(raw) {
        let text = raw.trim();
        if (!text) return;
        text = text.charAt(0).toUpperCase() + text.slice(1);
        if (!/[.!?…]$/.test(text)) text += '.';
        const now = Date.now();
        const last = t.paragraphs.length - 1;
        if (last < 0 || now - t.lastFinal > PAUSE_BREAK) t.paragraphs.push(text);
        else t.paragraphs[last] += ` ${text}`;
        t.lastFinal = now;
    }

    // Keep whatever was half-heard when listening stops
    function commitInterim() {
        if (t.interim) addFinal(t.interim);
        t.interim = '';
    }

    async function startAudio() {
        try {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            const type = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/webm'].find(x => window.MediaRecorder && MediaRecorder.isTypeSupported(x));
            const recorder = new MediaRecorder(stream, type ? { mimeType: type } : undefined);
            const chunks = [];
            recorder.ondataavailable = e => { if (e.data && e.data.size) chunks.push(e.data); };
            recorder.start(1000);
            t.audio = { recorder, chunks, stream };
        } catch (e) {
            $('tr-keep').checked = false;
        }
    }

    function stopAudio() {
        return new Promise(resolve => {
            const a = t.audio;
            t.audio = null;
            if (!a) return resolve(null);
            a.recorder.onstop = () => {
                a.stream.getTracks().forEach(track => track.stop());
                const type = (a.recorder.mimeType || 'audio/webm').split(';')[0];
                const file = new File(a.chunks, `Conversation.${type.includes('mp4') ? 'm4a' : 'webm'}`, { type });
                file.duration = Math.round(totalMs() / 1000);
                resolve(file.size ? file : null);
            };
            if (a.recorder.state !== 'inactive') a.recorder.stop();
            else a.recorder.onstop();
        });
    }

    // ---------- Screen ----------
    function totalMs() {
        return t.elapsed + (t.listening ? Date.now() - t.started : 0);
    }

    function paintTime() {
        const secs = Math.floor(totalMs() / 1000);
        $('tr-time').textContent = `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`;
    }

    function paint() {
        const words = t.paragraphs.join(' ').split(/\s+/).filter(Boolean).length;
        $('tr-save').disabled = !t.paragraphs.length && !t.interim;
        $('tr-count').textContent = words ? `${words} ${words === 1 ? 'word' : 'words'}` : '';
        if (!t.paragraphs.length && !t.interim) {
            live.innerHTML = `<p class="tr-hint">${t.listening ? 'Listening… start talking.' : 'Tap the mic to start.'}</p>`;
            return;
        }
        live.innerHTML = t.paragraphs.map((p, i) => `<p data-i="${i}" contenteditable="${!t.listening}">${app.escapeHTML(p)}</p>`).join('')
            + (t.interim ? `<p class="tr-interim">${app.escapeHTML(t.interim)}</p>` : '');
        live.scrollTop = live.scrollHeight;
    }

    // Fix mis-heard words after pausing
    live.addEventListener('input', e => {
        const p = e.target.closest('[data-i]');
        if (p) t.paragraphs[Number(p.dataset.i)] = p.textContent.trim();
    });

    $('tr-mic').addEventListener('click', () => (t.listening ? pause() : start()));
    $('tr-keep').addEventListener('change', e => {
        if (e.target.checked && t.listening && !t.audio) startAudio();
    });

    $('tr-save').addEventListener('click', async () => {
        pause();
        const paragraphs = t.paragraphs.map(p => p.trim()).filter(Boolean);
        if (!paragraphs.length) return;
        const audio = await stopAudio();
        const text = paragraphs.join('\n\n');
        finish();
        if (t.mode === 'insert') {
            app.editorApi.appendText(text);
            app.editorApi.focus();
            app.showToast('Added to your note');
            return;
        }
        const when = new Date().toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
        const note = await app.createEntry({ title: `Conversation · ${when}`, text }, audio ? [audio] : []);
        app.showToast('Saved as a note 🎙️');
        app.openNote(note.id);
    });

    async function discard() {
        const hasText = t.paragraphs.length || t.interim;
        if (hasText) {
            if (t.listening) pause();
            const ok = await app.ask({ title: 'Discard this recording?', text: 'The transcript hasn’t been saved.', ok: 'Discard', danger: true });
            if (!ok) return;
        }
        await stopAudio();
        finish();
    }

    function finish() {
        t.listening = false;
        clearInterval(t.timer);
        stopRecognition();
        dialog.classList.remove('listening');
        if (dialog.open) dialog.close();
    }

    $('tr-close').addEventListener('click', discard);
    dialog.addEventListener('cancel', e => {
        e.preventDefault();
        discard();
    });
    // Stop cleanly if the page is hidden (phone locked, app switched)
    document.addEventListener('visibilitychange', () => {
        if (document.hidden && t.listening) pause();
    });
});
