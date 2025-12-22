const CACHE_STATIC = 'eurlex-site-v7';
const STATIC_ASSETS = [
  './', './index.html', './live.html', './settings.html',
  './assets/ui.css', './assets/theme.js', './assets/app.js', './assets/live.js', 
  './assets/settings.js', './assets/notifications.js', './assets/feed-fetcher.js', './assets/ai.js', './assets/manifest.json'
];

// Install event - cache static assets
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE_STATIC)
      .then(c => c.addAll(STATIC_ASSETS))
      .then(() => self.skipWaiting())
  );
});

// Activate event - clean old caches and claim clients
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(k => k !== CACHE_STATIC).map(k => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

// Fetch event - network first for data, cache first for assets
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  
  // Data files: network first, fallback to cache
  if (url.pathname.includes('/data/')) {
    e.respondWith(
      fetch(e.request)
        .then(r => {
          const clone = r.clone();
          caches.open(CACHE_STATIC).then(c => c.put(e.request, clone));
          return r;
        })
        .catch(() => caches.match(e.request))
    );
  } else {
    // Static assets: cache first, fallback to network
    e.respondWith(
      caches.match(e.request)
        .then(r => r || fetch(e.request))
    );
  }
});

// Push event - handle push notifications from server (future use)
self.addEventListener('push', e => {
  const data = e.data ? e.data.json() : {};
  const title = data.title || 'EUR-Lex Update';
  const options = {
    body: data.body || 'New updates available',
    icon: './assets/icon.svg',
    badge: './assets/icon.svg',
    tag: data.tag || 'eurlex-updates',
    data: { url: data.url || './' },
    actions: [
      { action: 'view', title: 'View' },
      { action: 'dismiss', title: 'Dismiss' }
    ]
  };
  
  e.waitUntil(self.registration.showNotification(title, options));
});

// Notification click event
self.addEventListener('notificationclick', e => {
  e.notification.close();
  
  if (e.action === 'dismiss') return;
  
  const urlToOpen = e.notification.data?.url || './';
  
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true })
      .then(clients => {
        // Focus existing window if available
        for (const client of clients) {
          if (client.url.includes('index.html') || client.url.endsWith('/')) {
            return client.focus().then(c => c.navigate(urlToOpen));
          }
        }
        // Open new window
        return self.clients.openWindow(urlToOpen);
      })
  );
});

// Message event - handle messages from main thread
self.addEventListener('message', e => {
  if (e.data && e.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
  
  // Handle notification requests from main thread
  if (e.data && e.data.type === 'SHOW_NOTIFICATION') {
    const { title, options } = e.data;
    self.registration.showNotification(title, options);
  }
});

// Background sync (for future periodic updates)
self.addEventListener('sync', e => {
  if (e.tag === 'check-updates') {
    e.waitUntil(checkForUpdates());
  }
});

// Periodic background sync (requires user permission)
self.addEventListener('periodicsync', e => {
  if (e.tag === 'check-updates') {
    e.waitUntil(checkForUpdates());
  }
});

// Check for updates and notify
async function checkForUpdates() {
  try {
    const response = await fetch('./data/posts.json?v=' + Date.now());
    if (!response.ok) return;
    
    const posts = await response.json();
    const latest = posts.slice(0, 5);
    
    // Get stored last check time
    const cache = await caches.open(CACHE_STATIC);
    const lastCheck = await cache.match('last-check-time');
    const lastCheckTime = lastCheck ? await lastCheck.text() : null;
    
    // Find new posts since last check
    const newPosts = lastCheckTime 
      ? latest.filter(p => new Date(p.added || p.date) > new Date(lastCheckTime))
      : [];
    
    if (newPosts.length > 0) {
      await self.registration.showNotification('EUR-Lex Updates', {
        body: `${newPosts.length} new update${newPosts.length > 1 ? 's' : ''} available`,
        icon: './assets/icon.svg',
        tag: 'eurlex-bg-update',
        data: { url: './' }
      });
    }
    
    // Store new check time
    await cache.put('last-check-time', new Response(new Date().toISOString()));
  } catch (e) {
    console.error('[SW] Background check failed:', e);
  }
}
