/* Rummikube Clubs - Service Worker
   אסטרטגיה: רשת-קודם. תמיד מנסים להביא את הגרסה הטרייה מהשרת,
   והמטמון משמש רק כגיבוי לחוסר-חיבור. כך פריסות חדשות מגיעות מיידית. */
const CACHE = 'rummikube-shell-v18';

self.addEventListener('install', (e) => { self.skipWaiting(); });
self.addEventListener('activate', (e) => {
    e.waitUntil((async () => {
        const keys = await caches.keys();
        await Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)));
        await self.clients.claim();
    })());
});

self.addEventListener('fetch', (e) => {
    const req = e.request;
    if (req.method !== 'GET') return;
    const url = new URL(req.url);
    // לא נוגעים בתקשורת של Firebase/גוגל - עוברת ישירות
    if (url.hostname.includes('googleapis.com') || url.hostname.includes('firebaseapp.com') || url.hostname.includes('gstatic.com') && url.pathname.includes('firebasejs')) return;
    // Page/document loads always come fresh from the network (never the HTTP cache),
    // so a new deploy shows up immediately instead of a stale cached shell.
    const isDoc = req.mode === 'navigate' || req.destination === 'document';
    e.respondWith((async () => {
        try {
            const res = await fetch(isDoc ? new Request(req, { cache: 'no-store' }) : req);
            if (res && res.ok && (url.origin === self.location.origin || res.type === 'basic' || res.type === 'cors')) {
                try { const c = await caches.open(CACHE); c.put(req, res.clone()); } catch (err) {}
            }
            return res;
        } catch (err) {
            const cached = await caches.match(req, { ignoreSearch: url.origin === self.location.origin });
            if (cached) return cached;
            throw err;
        }
    })());
});
