// Touch? Service Worker v1
// Strategy: Network-first for HTML/API, Cache-first for static assets

const CACHE_NAME = 'touch-cache-v1';
const OFFLINE_URL = '/offline.html';

// Resources to precache on install
const PRECACHE_URLS = [
  '/',
  '/offline.html',
  '/manifest.json',
  '/icons/icon-192.png',
  '/icons/icon-512.png'
];

// Patterns that should NEVER be cached
const NO_CACHE_PATTERNS = [
  /\/api\//,
  /\/socket\.io\//,
  /\/e\//,
  /\/operator/,
  /\/admin/,
  /hot-update/,
  /\.map$/,
  /\.mp4(\?|$)/
];

// Patterns for cache-first strategy (static assets)
const CACHE_FIRST_PATTERNS = [
  /\.css(\?|$)/,
  /\.js(\?|$)/,
  /\.woff2?(\?|$)/,
  /\.ttf(\?|$)/,
  /\.png(\?|$)/,
  /\.jpg(\?|$)/,
  /\.jpeg(\?|$)/,
  /\.gif(\?|$)/,
  /\.svg(\?|$)/,
  /\.ico(\?|$)/,
  /\.webp(\?|$)/,
  /fonts\.googleapis\.com/,
  /fonts\.gstatic\.com/,
  /\/i18n\//,
  /\/icons\//
];

// ---- INSTALL: Precache critical resources ----
self.addEventListener('install', (event) => {
  console.log('[SW] Installing v1');
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => {
        console.log('[SW] Precaching critical resources');
        return cache.addAll(PRECACHE_URLS);
      })
      .then(() => self.skipWaiting())
  );
});

// ---- ACTIVATE: Clean old caches ----
self.addEventListener('activate', (event) => {
  console.log('[SW] Activating v1');
  event.waitUntil(
    caches.keys()
      .then((cacheNames) => {
        return Promise.all(
          cacheNames
            .filter((name) => name !== CACHE_NAME)
            .map((name) => {
              console.log('[SW] Deleting old cache:', name);
              return caches.delete(name);
            })
        );
      })
      .then(() => self.clients.claim())
  );
});

// ---- FETCH: Smart caching strategy ----
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Skip non-GET requests
  if (event.request.method !== 'GET') return;

  // Skip chrome-extension and other non-http(s) requests
  if (!url.protocol.startsWith('http')) return;

  // Skip requests that should never be cached
  if (NO_CACHE_PATTERNS.some((pattern) => pattern.test(url.pathname + url.search))) {
    return;
  }

  // Navigation requests (HTML pages) -> Network-first with offline fallback
  if (event.request.mode === 'navigate') {
    event.respondWith(networkFirstWithOfflineFallback(event.request));
    return;
  }

  // Static assets -> Cache-first
  if (CACHE_FIRST_PATTERNS.some((pattern) => pattern.test(url.href))) {
    event.respondWith(cacheFirstWithNetworkFallback(event.request));
    return;
  }

  // Everything else -> Network-first (cache as bonus)
  event.respondWith(networkFirstWithCache(event.request));
});

// ---- STRATEGIES ----

// Network-first for navigation, falls back to offline page
async function networkFirstWithOfflineFallback(request) {
  try {
    const networkResponse = await fetch(request);
    // Cache successful navigation responses
    if (networkResponse.ok) {
      const cache = await caches.open(CACHE_NAME);
      cache.put(request, networkResponse.clone());
    }
    return networkResponse;
  } catch (error) {
    // Try cache first
    const cachedResponse = await caches.match(request);
    if (cachedResponse) return cachedResponse;
    // Fallback to offline page
    const offlineResponse = await caches.match(OFFLINE_URL);
    if (offlineResponse) return offlineResponse;
    // Last resort
    return new Response('Offline', { status: 503, statusText: 'Offline' });
  }
}

// Cache-first for static assets
async function cacheFirstWithNetworkFallback(request) {
  const cachedResponse = await caches.match(request);
  if (cachedResponse) return cachedResponse;

  try {
    const networkResponse = await fetch(request);
    if (networkResponse.ok && networkResponse.status !== 206) {
      const cache = await caches.open(CACHE_NAME);
      cache.put(request, networkResponse.clone());
    }
    return networkResponse;
  } catch (error) {
    return new Response('', { status: 408, statusText: 'Offline' });
  }
}

// Network-first with cache as bonus
async function networkFirstWithCache(request) {
  try {
    const networkResponse = await fetch(request);
    if (networkResponse.ok && networkResponse.status !== 206) {
      const cache = await caches.open(CACHE_NAME);
      cache.put(request, networkResponse.clone());
    }
    return networkResponse;
  } catch (error) {
    const cachedResponse = await caches.match(request);
    if (cachedResponse) return cachedResponse;
    return new Response('', { status: 408, statusText: 'Offline' });
  }
}

// ---- MESSAGE HANDLER: Support cache updates from app ----
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
  if (event.data && event.data.type === 'CLEAR_CACHE') {
    caches.keys().then((names) => {
      names.forEach((name) => caches.delete(name));
    });
  }
});
