// Cordial works offline: this keeps a copy of the app (pages, scripts, styles, icons, fonts and the two
// libraries it loads from a CDN) on the device. Your notes already live on the device, so the diary works fully
// without internet; friends, feed, chats and live need a connection and say so.
//
// Strategy: when online, always fetch fresh (so a new deploy shows up right away) and refresh the saved copy;
// when the network fails, answer from the saved copy. Supabase data (posts, messages…) is never cached here.
// The app's public Supabase settings (used by the lock-screen "Decline" on calls). Scripts can only be
// imported while the worker installs, so this happens here, once.
try { self.window = self; importScripts('/config.js'); } catch (e) { /* calls can still be declined in the app */ }

const CACHE = 'cordial-shell-v147';
const SHELL = [
    '/', '/index.html', '/manifest.webmanifest',
    '/style.css', '/photoedit.css',
    '/config.js', '/rich.js', '/media.js', '/dilute.js', '/script.js', '/social.js', '/stories.js', '/library.js', '/market.js', '/profile.js', '/invite.js', '/mention.js', '/spaces.js', '/notemedia.js', '/noteshare.js', '/noteslides.js', '/audiolib.js', '/sound.js', '/mediaeditor.js', '/support.js', '/helpline.js', '/schedule.js', '/play.js', '/games.js', '/chattools.js', '/safety.js',
    '/community.js', '/live.js', '/explore.js', '/call.js', '/notify.js', '/settings.js', '/transcribe.js', '/ai.js',
    '/photoedit.js', '/sync.js', '/zoom.js', '/speak.js', '/zoom.css', '/speak.css', '/groupchat.js', '/location.js', '/location.css', '/wallpaper.js',
    '/icons/icon-180.png', '/icons/icon-192.png', '/icons/icon-512.png',
    'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2',
    'https://cdn.jsdelivr.net/npm/dompurify@3/dist/purify.min.js',
    'https://fonts.googleapis.com/css2?family=Inter:opsz,wght@14..32,400..800&display=swap'
];
// Fetched once and kept (fonts, CDN libraries): fine to serve from the saved copy first
const STATIC_HOSTS = ['cdn.jsdelivr.net', 'fonts.googleapis.com', 'fonts.gstatic.com'];

self.addEventListener('install', event => {
    event.waitUntil((async () => {
        const cache = await caches.open(CACHE);
        // One failure (a flaky CDN) mustn't stop the rest from being saved
        await Promise.all(SHELL.map(url => cache.add(new Request(url, { cache: 'reload' })).catch(() => {})));
        await self.skipWaiting();
    })());
});

self.addEventListener('activate', event => {
    event.waitUntil((async () => {
        const keys = await caches.keys();
        await Promise.all(keys.filter(k => k.startsWith('cordial-') && k !== CACHE).map(k => caches.delete(k)));
        await self.clients.claim();
    })());
});

// Fresh from the network when it answers in time; on slow or stalled mobile data, the saved copy after a few
// seconds instead of a blank screen (the fresh one still arrives and is saved for next time)
const NETWORK_WAIT = 3500;
async function networkFirst(request, fallbackUrl) {
    const cache = await caches.open(CACHE);
    const savedCopy = async () => (await cache.match(request, { ignoreSearch: true }))
        || (fallbackUrl && (await cache.match(fallbackUrl))) || null;
    const network = fetch(request).then(fresh => {
        if (fresh && fresh.ok && fresh.type !== 'opaqueredirect') {
            const url = new URL(request.url);
            const own = url.origin === self.location.origin;
            // The exact version ("script.js?v=147"), so a slow load never mixes old and new files…
            if (own && url.search) cache.put(request, fresh.clone()).catch(() => {});
            // …and under the plain address, so the app still opens offline whatever the version
            cache.put(own ? url.pathname : request, fresh.clone()).catch(() => {});
        }
        return fresh;
    });
    const slow = new Promise(resolve => setTimeout(() => resolve('slow'), NETWORK_WAIT));
    try {
        const first = await Promise.race([network, slow]);
        if (first !== 'slow') return first;
        // Slow network: the page itself from the saved copy; its files only in the exact version it asks for
        const saved = request.mode === 'navigate' ? await savedCopy() : await cache.match(request);
        return saved || await network; // nothing suitable saved: keep waiting for the network
    } catch (e) {
        const saved = await savedCopy();
        if (saved) return saved;
        throw e;
    }
}

// Answer from the saved copy straight away, and quietly refresh it for next time
async function cacheFirst(request) {
    const cache = await caches.open(CACHE);
    const saved = await cache.match(request);
    const refresh = fetch(request).then(fresh => {
        if (fresh && (fresh.ok || fresh.type === 'opaque')) cache.put(request, fresh.clone());
        return fresh;
    });
    if (saved) {
        refresh.catch(() => {});
        return saved;
    }
    return refresh;
}

// Saved by the file's address without its token; kept across app updates, cleared on sign-out
const PHOTOS = 'diary-photos';
const PHOTO_LIMIT = 500;
async function photo(request, url) {
    const key = url.origin + url.pathname.replace('/object/sign/', '/object/');
    const cache = await caches.open(PHOTOS);
    const saved = await cache.match(key);
    if (saved) return saved;
    try {
        const fresh = await fetch(new Request(request.url, { mode: 'cors', credentials: 'omit' }));
        if (fresh.ok) {
            await cache.put(key, fresh.clone());
            cache.keys().then(keys => Promise.all(keys.slice(0, Math.max(0, keys.length - PHOTO_LIMIT)).map(k => cache.delete(k)))).catch(() => {});
        }
        return fresh;
    } catch (e) {
        return fetch(request);
    }
}

self.addEventListener('fetch', event => {
    const { request } = event;
    if (request.method !== 'GET') return;
    const url = new URL(request.url);

    // Opening the app (or reloading any #/page): fresh page when the network answers in time; on a stalled or
    // slow connection, the copy saved on the phone (so a bad mobile signal doesn't mean "couldn't open the page")
    if (request.mode === 'navigate') {
        event.respondWith(networkFirst(request, '/index.html'));
        return;
    }
    // The app's own files
    if (url.origin === self.location.origin) {
        event.respondWith(networkFirst(request));
        return;
    }
    // Fonts and the CDN libraries
    if (STATIC_HOSTS.includes(url.hostname)) {
        event.respondWith(cacheFirst(request));
        return;
    }
    // Pictures from Cordial's storage (feed photos, avatars): uploads never change, so once a picture is on the
    // device it's shown straight away, even after its signed link is renewed
    if (request.destination === 'image' && url.pathname.startsWith('/storage/v1/object/')) {
        event.respondWith(photo(request, url));
        return;
    }
    // Everything else (Supabase data, uploads, video) goes straight to the network
});

// ---------- Push notifications (calls, messages, posts, people, live…) ----------
// The server sends { title, body, url, tag, icon, type, actions?, requireInteraction?, decline? }.
// While Cordial is open and in front, the app already shows these itself (realtime), so the system alert is
// skipped — except "Missed call", which replaces a ringing alert that may still be on screen.
// The same tag replaces an earlier alert (one per conversation / caller / poster), so nothing piles up.
self.addEventListener('push', event => {
    let data = {};
    try { data = event.data ? event.data.json() : {}; } catch (e) { data = { body: event.data && event.data.text() }; }
    event.waitUntil((async () => {
        const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
        const inFront = windows.some(w => w.focused && w.visibilityState === 'visible');
        // An open Cordial always hears about it (a ring, a cancelled or missed call), in front or not
        windows.forEach(w => w.postMessage({ type: 'push', data }));
        // In front, the app shows it itself (a missed call still gets its alert)
        if (inFront && data.type !== 'missed_call') return;
        const call = data.type === 'call';
        await self.registration.showNotification(data.title || 'Cordial', {
            body: data.body || '',
            icon: data.icon || '/icons/icon-192.png',
            badge: data.badge || '/icons/icon-192.png',
            tag: data.tag || data.id || 'cordial',
            renotify: data.renotify !== false,
            requireInteraction: !!data.requireInteraction,
            actions: Array.isArray(data.actions) ? data.actions.slice(0, 2) : [],
            vibrate: data.vibrate || (call ? [600, 300, 600, 300, 600] : [120]),
            timestamp: data.timestamp || Date.now(),
            silent: false,
            data: { url: data.url || '/', type: data.type || '', decline: data.decline || null }
        });
        // A ring only lasts so long: if nobody answered, tidy it away (the server sends "Missed call" separately)
        if (call) setTimeout(async () => {
            const open = await self.registration.getNotifications({ tag: data.tag });
            open.forEach(n => { if (n.data && n.data.type === 'call') n.close(); });
        }, 45000);
    })());
});

// Supabase details for the lock-screen "Decline" are loaded at the top of this file (config.js)
const cordialConfig = () => self.DIARY_CONFIG || null;

// Tapping an alert opens Cordial on the right page (reusing an open window when there is one)
self.addEventListener('notificationclick', event => {
    const n = event.notification;
    const d = n.data || {};
    n.close();
    // Hang up (or cancel) from the "On a call" alert: the open app ends the call
    if (d.type === 'ongoing') {
        event.waitUntil((async () => {
            const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
            if (event.action === 'hangup') windows.forEach(w => w.postMessage({ type: 'hangup' }));
            else if (windows[0]) await windows[0].focus().catch(() => {});
        })());
        return;
    }
    // Decline a call right from the lock screen: no need to open Cordial
    if (event.action === 'decline' && d.decline) {
        event.waitUntil((async () => {
            const cfg = cordialConfig();
            if (!cfg) return;
            await fetch(`${cfg.supabaseUrl}/functions/v1/diary-notify`, {
                method: 'POST',
                headers: { apikey: cfg.supabaseKey, 'Content-Type': 'application/json' },
                body: JSON.stringify({ action: 'decline', ring: d.decline.token })
            }).catch(() => {});
        })());
        return;
    }
    let url = d.url || '/';
    if (event.action === 'answer') url += (url.includes('?') ? '&' : '?') + 'answer=1';
    const target = new URL(url, self.location.origin).href;
    event.waitUntil((async () => {
        // First, leave the destination where the app will find it. A Cordial that was asleep in the background
        // (iPhone especially) may not answer a message in time, and iPhone can't be told to change page —
        // but the app reads this the moment it's on screen again, so the tap always lands in the right place.
        try {
            const box = await caches.open('link-handoff');
            await box.put('/__pending-link', new Response(JSON.stringify({ url: target, at: Date.now(), tag: n.tag || '' }), { headers: { 'Content-Type': 'application/json' } }));
        } catch (e) { /* no storage: the message below still works */ }
        const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
        const open = windows.find(w => new URL(w.url).origin === self.location.origin);
        if (open) {
            await open.focus().catch(() => {});
            // Ask the open app to go there itself (no reload); fall back to loading the address
            const handled = await new Promise(resolve => {
                const ch = new MessageChannel();
                const timer = setTimeout(() => resolve(false), 1500);
                ch.port1.onmessage = () => { clearTimeout(timer); resolve(true); };
                open.postMessage({ type: 'open-url', url: target }, [ch.port2]);
            });
            if (!handled && 'navigate' in open) return open.navigate(target).catch(() => {});
            return;
        }
        return self.clients.openWindow(target);
    })());
});

// The browser renewed this device's push address: subscribe again with the same key. Cordial saves the new
// address the next time it opens (it can't sign in from here).
self.addEventListener('pushsubscriptionchange', event => {
    const old = event.oldSubscription;
    const key = old && old.options && old.options.applicationServerKey;
    if (!key) return;
    event.waitUntil(self.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key }).catch(() => {}));
});

