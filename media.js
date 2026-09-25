// Media for journal entries and chat: on-device blob storage (IndexedDB), file picking,
// voice recording, a drawing pad, an image lightbox and optional location + weather.
window.Media = (() => {
    const $ = id => document.getElementById(id);

    // ---------- IndexedDB blob store ----------
    const DB_NAME = 'diary-media';
    const STORE = 'blobs';
    let dbPromise = null;

    function db() {
        if (!dbPromise) {
            dbPromise = new Promise((resolve, reject) => {
                const req = indexedDB.open(DB_NAME, 1);
                req.onupgradeneeded = () => req.result.createObjectStore(STORE);
                req.onsuccess = () => resolve(req.result);
                req.onerror = () => reject(req.error);
            });
        }
        return dbPromise;
    }

    async function tx(mode, fn) {
        const database = await db();
        return new Promise((resolve, reject) => {
            const t = database.transaction(STORE, mode);
            const req = fn(t.objectStore(STORE));
            t.oncomplete = () => resolve(req ? req.result : undefined);
            t.onerror = () => reject(t.error);
            t.onabort = () => reject(t.error);
        });
    }

    const put = (id, blob) => tx('readwrite', s => s.put(blob, id));
    const get = id => tx('readonly', s => s.get(id));
    const urls = new Map();

    async function del(id) {
        if (urls.has(id)) {
            URL.revokeObjectURL(urls.get(id));
            urls.delete(id);
        }
        try { await tx('readwrite', s => s.delete(id)); } catch (e) {}
    }

    async function url(id) {
        if (urls.has(id)) return urls.get(id);
        try {
            const blob = await get(id);
            if (!blob) return null;
            const u = URL.createObjectURL(blob);
            urls.set(id, u);
            return u;
        } catch (e) {
            return null;
        }
    }

    // Fill <img|audio|a data-media="id"> elements with local object URLs
    function hydrate(root) {
        root.querySelectorAll('[data-media]').forEach(async el => {
            if (el.dataset.hydrated) return;
            el.dataset.hydrated = '1';
            const u = await url(el.dataset.media);
            if (!u) {
                el.classList.add('media-missing');
                return;
            }
            if (el.tagName === 'A') el.href = u;
            else el.src = u;
        });
    }

    // ---------- Helpers ----------
    function kindOf(type) {
        if (type.startsWith('image/')) return 'image';
        if (type.startsWith('audio/')) return 'audio';
        return 'file';
    }

    function formatSize(bytes) {
        if (!bytes && bytes !== 0) return '';
        if (bytes < 1024) return `${bytes} B`;
        if (bytes < 1048576) return `${Math.round(bytes / 1024)} KB`;
        return `${(bytes / 1048576).toFixed(1)} MB`;
    }

    function formatDuration(seconds) {
        const s = Math.max(0, Math.round(seconds || 0));
        return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
    }

    function pickFiles(accept, multiple = true) {
        return new Promise(resolve => {
            const input = document.createElement('input');
            input.type = 'file';
            input.accept = accept;
            input.multiple = multiple;
            input.addEventListener('change', () => resolve([...input.files]));
            input.addEventListener('cancel', () => resolve([]));
            input.click();
        });
    }

    // ---------- Voice notes ----------
    function recordVoice() {
        return new Promise(async resolve => {
            if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
                resolve({ error: 'Voice notes aren’t supported in this browser.' });
                return;
            }
            let stream;
            try {
                stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            } catch (e) {
                resolve({ error: 'Microphone access was blocked. Allow it in your browser to record voice notes.' });
                return;
            }

            const dialog = $('voice-dialog');
            const timer = $('voice-timer');
            const mime = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg']
                .find(t => MediaRecorder.isTypeSupported(t)) || '';
            const recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
            const chunks = [];
            const started = Date.now();
            let keep = false;
            let tick = null;

            const finish = () => {
                clearInterval(tick);
                stream.getTracks().forEach(t => t.stop());
                if (dialog.open) dialog.close();
            };

            recorder.ondataavailable = e => { if (e.data.size) chunks.push(e.data); };
            recorder.onstop = () => {
                finish();
                if (!keep || !chunks.length) return resolve(null);
                const type = (recorder.mimeType || mime || 'audio/webm').split(';')[0];
                resolve({ blob: new Blob(chunks, { type }), duration: (Date.now() - started) / 1000, type });
            };

            $('voice-stop').onclick = () => { keep = true; recorder.stop(); };
            $('voice-cancel').onclick = () => { keep = false; recorder.stop(); };
            dialog.oncancel = e => { e.preventDefault(); keep = false; recorder.stop(); };

            timer.textContent = '0:00';
            tick = setInterval(() => {
                const secs = (Date.now() - started) / 1000;
                timer.textContent = formatDuration(secs);
                if (secs >= 300) { keep = true; recorder.stop(); } // 5 minute cap
            }, 250);

            recorder.start(250);
            dialog.showModal();
        });
    }

    // ---------- Inline recorder (chat voice notes, WhatsApp style) ----------
    // onLevel(level 0–1, seconds) fires ~10×/s for a live meter; stop() also returns a 40-bar waveform.
    async function createRecorder(onLevel) {
        if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
            throw new Error('Voice notes aren’t supported in this browser.');
        }
        let stream;
        try {
            stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        } catch (e) {
            throw new Error('Microphone access was blocked. Allow it in your browser to send voice notes.');
        }

        const mime = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg']
            .find(t => MediaRecorder.isTypeSupported(t)) || '';
        const recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
        const chunks = [];
        const levels = [];

        let ctx = null;
        let analyser = null;
        try {
            ctx = new (window.AudioContext || window.webkitAudioContext)();
            analyser = ctx.createAnalyser();
            analyser.fftSize = 512;
            ctx.createMediaStreamSource(stream).connect(analyser);
        } catch (e) {
            analyser = null;
        }
        const buffer = analyser ? new Uint8Array(analyser.fftSize) : null;
        const started = Date.now();

        const tick = setInterval(() => {
            let level = 0.2;
            if (analyser) {
                analyser.getByteTimeDomainData(buffer);
                let sum = 0;
                for (const v of buffer) {
                    const x = (v - 128) / 128;
                    sum += x * x;
                }
                level = Math.min(1, Math.sqrt(sum / buffer.length) * 3.5);
            }
            levels.push(level);
            if (onLevel) onLevel(level, (Date.now() - started) / 1000);
        }, 100);

        const cleanup = () => {
            clearInterval(tick);
            stream.getTracks().forEach(t => t.stop());
            if (ctx) ctx.close().catch(() => {});
        };

        recorder.ondataavailable = e => { if (e.data.size) chunks.push(e.data); };
        recorder.start(250);

        return {
            elapsed: () => (Date.now() - started) / 1000,
            stop: () => new Promise(resolve => {
                const duration = (Date.now() - started) / 1000;
                recorder.onstop = () => {
                    cleanup();
                    const type = (recorder.mimeType || mime || 'audio/webm').split(';')[0];
                    resolve({ blob: new Blob(chunks, { type }), type, duration, waveform: waveformFrom(levels) });
                };
                recorder.stop();
            }),
            cancel: () => {
                recorder.onstop = cleanup;
                try { recorder.stop(); } catch (e) { cleanup(); }
            }
        };
    }

    function waveformFrom(levels, bars = 40) {
        if (!levels.length) return [];
        const out = [];
        for (let i = 0; i < bars; i++) {
            const start = Math.floor(i * levels.length / bars);
            const end = Math.max(start + 1, Math.floor((i + 1) * levels.length / bars));
            out.push(Math.max(...levels.slice(start, end)));
        }
        const max = Math.max(...out, 0.01);
        return out.map(v => Math.round(Math.max(0.1, v / max) * 100) / 100);
    }

    // ---------- Drawing pad ----------
    const INKS = ['#23211f', '#2b3f7e', '#d9534f', '#2e9e5b', '#e0a800'];
    const SIZES = [2, 5, 10];

    function drawPad() {
        return new Promise(resolve => {
            const dialog = $('draw-dialog');
            const canvas = $('draw-canvas');
            const ctx = canvas.getContext('2d');
            const history = [];
            let ink = INKS[0];
            let size = SIZES[1];
            let erasing = false;
            let drawing = false;
            let last = null;
            let dirty = false;

            dialog.showModal();
            const rect = canvas.getBoundingClientRect();
            const ratio = window.devicePixelRatio || 1;
            canvas.width = Math.round(rect.width * ratio);
            canvas.height = Math.round(rect.height * ratio);
            ctx.scale(ratio, ratio);
            ctx.fillStyle = '#fffdf7';
            ctx.fillRect(0, 0, rect.width, rect.height);
            ctx.lineCap = 'round';
            ctx.lineJoin = 'round';

            const tools = $('draw-tools');
            tools.innerHTML =
                INKS.map((c, i) => `<button type="button" class="ink${i === 0 ? ' on' : ''}" data-ink="${c}" style="--ink:${c}" aria-label="Ink ${i + 1}"></button>`).join('') +
                '<span class="tb-sep"></span>' +
                SIZES.map(s => `<button type="button" class="size${s === size ? ' on' : ''}" data-size="${s}" aria-label="Brush ${s}px"><span style="width:${s + 2}px;height:${s + 2}px"></span></button>`).join('') +
                '<span class="tb-sep"></span>' +
                '<button type="button" class="tb-btn" data-tool="eraser" aria-pressed="false" title="Eraser"><svg class="i"><use href="#i-eraser"/></svg></button>' +
                '<button type="button" class="tb-btn" data-tool="undo" title="Undo"><svg class="i"><use href="#i-undo"/></svg></button>' +
                '<button type="button" class="tb-btn" data-tool="clear" title="Clear"><svg class="i"><use href="#i-trash"/></svg></button>';

            tools.onclick = e => {
                const b = e.target.closest('button');
                if (!b) return;
                if (b.dataset.ink) {
                    ink = b.dataset.ink;
                    erasing = false;
                    tools.querySelectorAll('.ink').forEach(x => x.classList.toggle('on', x === b));
                    tools.querySelector('[data-tool="eraser"]').setAttribute('aria-pressed', 'false');
                } else if (b.dataset.size) {
                    size = Number(b.dataset.size);
                    tools.querySelectorAll('.size').forEach(x => x.classList.toggle('on', x === b));
                } else if (b.dataset.tool === 'eraser') {
                    erasing = !erasing;
                    b.setAttribute('aria-pressed', String(erasing));
                } else if (b.dataset.tool === 'undo' && history.length) {
                    ctx.putImageData(history.pop(), 0, 0);
                } else if (b.dataset.tool === 'clear') {
                    history.push(ctx.getImageData(0, 0, canvas.width, canvas.height));
                    ctx.save();
                    ctx.setTransform(1, 0, 0, 1, 0, 0);
                    ctx.fillStyle = '#fffdf7';
                    ctx.fillRect(0, 0, canvas.width, canvas.height);
                    ctx.restore();
                }
            };

            const point = e => {
                const r = canvas.getBoundingClientRect();
                return { x: e.clientX - r.left, y: e.clientY - r.top, p: e.pressure || 0.5 };
            };

            canvas.onpointerdown = e => {
                canvas.setPointerCapture(e.pointerId);
                history.push(ctx.getImageData(0, 0, canvas.width, canvas.height));
                if (history.length > 30) history.shift();
                drawing = true;
                dirty = true;
                last = point(e);
                ctx.beginPath();
                ctx.arc(last.x, last.y, size / 2, 0, Math.PI * 2);
                ctx.fillStyle = erasing ? '#fffdf7' : ink;
                ctx.fill();
            };
            canvas.onpointermove = e => {
                if (!drawing) return;
                const p = point(e);
                ctx.strokeStyle = erasing ? '#fffdf7' : ink;
                ctx.lineWidth = erasing ? size * 3 : size * (0.6 + p.p * 0.8);
                ctx.beginPath();
                ctx.moveTo(last.x, last.y);
                ctx.lineTo(p.x, p.y);
                ctx.stroke();
                last = p;
            };
            canvas.onpointerup = canvas.onpointercancel = () => { drawing = false; };

            const done = keep => {
                dialog.close();
                if (!keep || !dirty) return resolve(null);
                canvas.toBlob(blob => resolve(blob ? { blob, type: 'image/png' } : null), 'image/png');
            };
            $('draw-save').onclick = () => done(true);
            $('draw-cancel').onclick = () => done(false);
            dialog.oncancel = e => { e.preventDefault(); done(false); };
        });
    }

    // ---------- Lightbox ----------
    function lightbox(src, caption = '') {
        const dialog = $('lightbox');
        $('lightbox-img').src = src;
        $('lightbox-caption').textContent = caption;
        $('lightbox-caption').hidden = !caption;
        dialog.showModal();
    }

    document.addEventListener('DOMContentLoaded', () => {
        const dialog = $('lightbox');
        dialog.addEventListener('click', () => dialog.close());
    });

    // ---------- Location & weather (opt-in, per entry) ----------
    const WEATHER = [
        [[0], 'Clear', '☀️'], [[1, 2], 'Partly cloudy', '⛅'], [[3], 'Overcast', '☁️'],
        [[45, 48], 'Fog', '🌫️'], [[51, 53, 55, 56, 57], 'Drizzle', '🌦️'],
        [[61, 63, 65, 66, 67, 80, 81, 82], 'Rain', '🌧️'], [[71, 73, 75, 77, 85, 86], 'Snow', '🌨️'],
        [[95, 96, 99], 'Thunderstorm', '⛈️']
    ];

    function locate() {
        return new Promise((resolve, reject) => {
            if (!navigator.geolocation) return reject(new Error('Location isn’t available in this browser.'));
            navigator.geolocation.getCurrentPosition(async pos => {
                const lat = Number(pos.coords.latitude.toFixed(3));
                const lon = Number(pos.coords.longitude.toFixed(3));
                const result = { lat, lon, place: '', weather: null };
                try {
                    const [placeRes, weatherRes] = await Promise.all([
                        fetch(`https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${lat}&longitude=${lon}&localityLanguage=en`),
                        fetch(`https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,weather_code`)
                    ]);
                    if (placeRes.ok) {
                        const p = await placeRes.json();
                        result.place = [p.city || p.locality, p.countryName].filter(Boolean).join(', ');
                    }
                    if (weatherRes.ok) {
                        const w = (await weatherRes.json()).current;
                        const match = WEATHER.find(([codes]) => codes.includes(w.weather_code)) || [[], 'Weather', '🌡️'];
                        result.weather = { temp: Math.round(w.temperature_2m), label: match[1], emoji: match[2] };
                    }
                } catch (e) {
                    // Keep the coordinates even if the lookups fail
                }
                if (!result.place) result.place = `${lat}, ${lon}`;
                resolve(result);
            }, err => reject(new Error(err.code === 1 ? 'Location permission was denied.' : 'Couldn’t get your location.')),
            { timeout: 15000, maximumAge: 600000 });
        });
    }

    return { put, get, del, url, hydrate, kindOf, formatSize, formatDuration, pickFiles, recordVoice, createRecorder, drawPad, lightbox, locate };
})();
