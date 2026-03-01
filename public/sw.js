// ═══════════════════════════════════════════════════════════════
// WEBAR Service Worker - Cache models & assets for instant load
// ═══════════════════════════════════════════════════════════════
const STATIC_CACHE = 'webar-static-v2';

// PERF: MODEL_CACHE uses a STABLE name (no version suffix)
// Model files have unique nanoid-based filenames → they NEVER change
// So this cache should NEVER be wiped on SW version bumps
const MODEL_CACHE = 'webar-models';

// Max model cache size (500MB) to prevent storage bloat
const MAX_MODEL_CACHE_BYTES = 500 * 1024 * 1024;

// Static assets to pre-cache
const STATIC_ASSETS = [
  '/',
  '/viewer.html',
  'https://cdn.jsdelivr.net/npm/three@0.150.1/build/three.min.js',
  'https://cdn.jsdelivr.net/npm/three@0.150.1/examples/js/controls/OrbitControls.js',
  'https://cdn.jsdelivr.net/npm/three@0.150.1/examples/js/loaders/GLTFLoader.js',
  'https://cdn.jsdelivr.net/npm/three@0.150.1/examples/js/loaders/DRACOLoader.js',
  'https://cdn.jsdelivr.net/npm/fflate@0.8.0/umd/index.min.js',
  'https://cdn.jsdelivr.net/npm/three@0.150.1/examples/js/loaders/FBXLoader.js',
];

// Install - pre-cache static assets
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(STATIC_CACHE).then(cache => {
      return cache.addAll(STATIC_ASSETS).catch(err => {
        console.log('Some static assets failed to cache:', err);
      });
    })
  );
  self.skipWaiting();
});

// Activate - clean old caches but PRESERVE model cache
self.addEventListener('activate', event => {
  const keepCaches = [STATIC_CACHE, MODEL_CACHE];
  event.waitUntil(
    caches.keys().then(keys => {
      return Promise.all(
        keys.filter(k => !keepCaches.includes(k))
          .map(k => {
            console.log('SW: Deleting old cache:', k);
            return caches.delete(k);
          })
      );
    })
  );
  self.clients.claim();
});

// LRU eviction: remove oldest cached models when over size limit
async function evictOldModels() {
  try {
    const cache = await caches.open(MODEL_CACHE);
    const keys = await cache.keys();

    if (keys.length === 0) return;

    // Calculate total size (approximate via Content-Length headers)
    let totalSize = 0;
    const entries = [];

    for (const request of keys) {
      const response = await cache.match(request);
      if (!response) continue;

      const size = parseInt(response.headers.get('Content-Length') || '0');
      const cachedAt = parseInt(response.headers.get('X-Cached-At') || '0');
      entries.push({ request, size, cachedAt });
      totalSize += size;
    }

    // If under limit, no eviction needed
    if (totalSize <= MAX_MODEL_CACHE_BYTES) return;

    // Sort by oldest first (LRU eviction)
    entries.sort((a, b) => a.cachedAt - b.cachedAt);

    // Remove oldest entries until under limit
    while (totalSize > MAX_MODEL_CACHE_BYTES && entries.length > 1) {
      const oldest = entries.shift();
      await cache.delete(oldest.request);
      totalSize -= oldest.size;
      console.log(`SW: Evicted old model cache: ${oldest.request.url} (${(oldest.size / 1024 / 1024).toFixed(1)}MB)`);
    }
  } catch (e) {
    console.log('SW: Cache eviction error:', e.message);
  }
}

// Fetch - cache-first for models, network-first for API
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // Model files: cache-first (they don't change — unique filenames)
  if (url.pathname.match(/\.(glb|gltf|fbx)$/i)) {
    event.respondWith(
      caches.open(MODEL_CACHE).then(async cache => {
        const cached = await cache.match(event.request);
        if (cached) {
          console.log('SW: Model from cache:', url.pathname);
          return cached;
        }

        try {
          const response = await fetch(event.request);
          if (response.ok) {
            // Clone and add metadata for LRU eviction
            const headers = new Headers(response.headers);
            if (!headers.has('X-Cached-At')) {
              headers.set('X-Cached-At', Date.now().toString());
            }
            const cachedResponse = new Response(await response.clone().arrayBuffer(), {
              status: response.status,
              statusText: response.statusText,
              headers
            });
            cache.put(event.request, cachedResponse);

            // Run LRU eviction in background (non-blocking)
            evictOldModels();
          }
          return response;
        } catch (e) {
          return new Response('Model not available offline', { status: 503 });
        }
      })
    );
    return;
  }

  // CDN scripts: cache-first
  if (url.hostname === 'cdn.jsdelivr.net' || url.hostname === 'www.gstatic.com') {
    event.respondWith(
      caches.open(STATIC_CACHE).then(async cache => {
        const cached = await cache.match(event.request);
        if (cached) return cached;

        const response = await fetch(event.request);
        if (response.ok) cache.put(event.request, response.clone());
        return response;
      })
    );
    return;
  }

  // API calls: network-first
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(
      fetch(event.request).catch(() => {
        return caches.match(event.request) || new Response('{}', {
          headers: { 'Content-Type': 'application/json' }
        });
      })
    );
    return;
  }

  // Everything else: network-first with fallback
  event.respondWith(
    fetch(event.request).then(response => {
      if (response.ok && event.request.method === 'GET') {
        const clone = response.clone();
        caches.open(STATIC_CACHE).then(cache => cache.put(event.request, clone));
      }
      return response;
    }).catch(() => caches.match(event.request))
  );
});
