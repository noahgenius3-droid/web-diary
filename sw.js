// Cordial works offline: this keeps a copy of the app (pages, scripts, styles, icons, fonts and the two
// libraries it loads from a CDN) on the device. Your notes already live on the device, so the diary works fully
// without internet; friends, feed, chats and live need a connection and say so.
//
// Strategy: when online, always fetch fresh (so a new deploy shows up right away) and refresh the saved copy;
// when the network fails, answer from the saved copy. Supabase data (posts, messages…) is never cached here.
const CACHE = 'cordial-shell-v103';
const SHELL = [
    '/', '/index.html', '/manifest.webmanifest',
    '/style.css', '/photoedit.css',
    '/config.js', '/rich.js', '/media.js', '/dilute.js', '/script.js', '/social.js', '/stories.js', '/library.js', '/market.js', '/profile.js', '/invite.js', '/mention.js', '/spaces.js', '/notemedia.js', '/noteshare.js', '/noteslides.js', '/schedule.js', '/play.js', '/games.js', '/chattools.js', '/safety.js',
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

async function networkFirst(request, fallbackUrl) {
    const cache = await caches.open(CACHE);
    try {
        const fresh = await fetch(request);
        if (fresh && fresh.ok && fresh.type !== 'opaqueredirect') {
            // Save under the plain address too, so "?v=29" and "?v=30" share one offline copy
            const url = new URL(request.url);
            cache.put(url.origin === self.location.origin ? url.pathname : request, fresh.clone());
        }
        return fresh;
    } catch (e) {
        const saved = await cache.match(request, { ignoreSearch: true })
            || (fallbackUrl && (await cache.match(fallbackUrl)));
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

    // Opening the app (or reloading any #/page): fresh page when online, saved page when not
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

// ---------- Push notifications (friend requests, new followers…) ----------
// The server sends { title, body, url, tag, icon }. If Cordial is open and in front, the app already
// shows it as a toast, so the lock-screen alert is skipped.
self.addEventListener('push', event => {
    let data = {};
    try { data = event.data ? event.data.json() : {}; } catch (e) { data = { body: event.data && event.data.text() }; }
    event.waitUntil((async () => {
        const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
        if (windows.some(w => w.focused && w.visibilityState === 'visible')) return;
        await self.registration.showNotification(data.title || 'Cordial', {
            body: data.body || '',
            icon: data.icon || '/icons/icon-192.png',
            badge: data.badge || '/icons/icon-192.png',
            tag: data.tag || data.id || 'cordial',
            renotify: true,
            data: { url: data.url || '/' }
        });
    })());
});

// Tapping the alert opens Cordial on the right page (reusing an open window when there is one)
self.addEventListener('notificationclick', event => {
    event.notification.close();
    const target = new URL((event.notification.data && event.notification.data.url) || '/', self.location.origin).href;
    event.waitUntil((async () => {
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
