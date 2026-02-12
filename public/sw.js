// ═══════════════════════════════════════════════════════════════
// WEBAR Service Worker - Cache models & assets for instant load
// ═══════════════════════════════════════════════════════════════
const CACHE_VERSION = 'webar-v2';
const STATIC_CACHE = 'webar-static-v2';
const MODEL_CACHE = 'webar-models-v2';

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

// Activate - clean old caches
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys => {
      return Promise.all(
        keys.filter(k => k !== STATIC_CACHE && k !== MODEL_CACHE)
            .map(k => caches.delete(k))
      );
    })
  );
  self.clients.claim();
});

// Fetch - cache-first for models, network-first for API
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  
  // Model files: cache-first (they don't change)
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
            cache.put(event.request, response.clone());
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
