// Service Worker — Dashboard Perso
//
// Stratégie "stale-while-revalidate" pour le shell :
//   1. Renvoyer immédiatement depuis le cache (chargement instantané même offline)
//   2. En parallèle, fetcher le réseau pour rafraîchir le cache (prochain chargement = à jour)
//   3. /api/* est exclu : toujours réseau, jamais cache

const CACHE = 'dashboard-perso-v12';
const SHELL = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './manifest.json',
  './icon.svg',
  './icon-180.png',
  './icon-192.png',
  './icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // Add resilient : si un fichier échoue (ex. réseau coupé pendant install),
    // on installe quand même le SW avec ce qu'on a pu cacher.
    await Promise.all(
      SHELL.map((url) =>
        cache.add(new Request(url, { cache: 'reload' })).catch(() => null)
      )
    );
  })());
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(
      keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))
    );
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);

  // 1) /api/*  → JAMAIS le SW. Toujours réseau direct (sinon SSE casse).
  if (url.pathname.startsWith('/api/')) return;

  // 2) Méthodes non-GET → pas de cache
  if (req.method !== 'GET') return;

  // 3) Stale-while-revalidate
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const cached = await cache.match(req, { ignoreSearch: true });

    // Fetch réseau en arrière-plan (mise à jour silencieuse du cache)
    const networkPromise = fetch(req)
      .then((res) => {
        if (res && res.status === 200 && res.type === 'basic') {
          cache.put(req, res.clone()).catch(() => {});
        }
        return res;
      })
      .catch(() => null);

    // Si on a du cache, on le renvoie tout de suite (instantané, marche offline)
    if (cached) return cached;

    // Sinon on attend le réseau
    const networkRes = await networkPromise;
    if (networkRes) return networkRes;

    // Si réseau ET cache KO :
    //   - pour une navigation HTML → renvoyer index.html cached (PWA reste accessible)
    //   - sinon erreur 503
    if (req.mode === 'navigate') {
      const fallback = await cache.match('./index.html');
      if (fallback) return fallback;
    }
    return new Response('Offline', {
      status: 503,
      headers: { 'Content-Type': 'text/plain' }
    });
  })());
});
