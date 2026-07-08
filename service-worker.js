const CACHE_NAME = 'private-chat-v45-pairing-delivery-20260708-1';
const APP_BASE = new URL('./', self.location.href).pathname;
const STATIC_ASSETS = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './invite-addon.js',
  './pairing-addon.js',
  './pairing-addon.css',
  './room-addon.js',
  './call-addon.js',
  './layout-addon.css',
  './manifest.json',
  './assets/icon-192.png',
  './assets/icon-512.png'
];

const OBSERVER_PATTERN = /observer\.observe\(document\.body,\s*\{\s*subtree:\s*true,\s*attributes:\s*true,\s*attributeFilter:\s*\['class'\]\s*\}\);/g;
const OBSERVER_FIX = "const mutationTarget = document.getElementById('chatView') || document.body;\n    observer.observe(mutationTarget, { subtree: false, attributes: true, attributeFilter: ['class'] });";
const INTERACTION_CSS = `
/* v4.4.5 interaction fix */
body.chat-active #chatView { pointer-events:auto !important; touch-action:manipulation; }
body.chat-active #chatView .chat-header,
body.chat-active #chatView .chat-box,
body.chat-active #chatView .composer,
body.chat-active #chatView button,
body.chat-active #chatView input,
body.chat-active #chatView select,
body.chat-active #chatView textarea { pointer-events:auto; }
.room-toast { pointer-events:none !important; }
.call-overlay.hidden,
.conversation-ended-panel.hidden,
.unread-drop-dock.hidden,
.voice-call-mini-bar.hidden { pointer-events:none !important; visibility:hidden !important; }
.conversation-disabled,
.conversation-disabled * { pointer-events:none !important; }
`;

async function fetchFreshTransformed(request) {
  const response = await fetch(request, { cache: 'no-store' });
  if (!response || !response.ok) return response;

  const url = new URL(request.url);
  const isRoomOrCall = url.pathname.endsWith('/room-addon.js') || url.pathname.endsWith('/call-addon.js');
  const isLayoutCss = url.pathname.endsWith('/layout-addon.css');
  const contentType = String(response.headers.get('content-type') || '');
  const isHtml = request.mode === 'navigate' || request.destination === 'document' ||
    contentType.includes('text/html') || url.pathname === APP_BASE || url.pathname.endsWith('/index.html');
  if (!isRoomOrCall && !isLayoutCss && !isHtml) return response;

  let text = await response.text();
  if (isRoomOrCall) text = text.replace(OBSERVER_PATTERN, OBSERVER_FIX);
  if (isLayoutCss && !text.includes('v4.4.5 interaction fix')) text += INTERACTION_CSS;
  if (isHtml) {
    if (!text.includes('pairing-addon.css')) {
      text = text.replace('</head>', '  <link rel="stylesheet" href="./pairing-addon.css">\n</head>');
    }
    if (!text.includes('pairing-addon.js')) {
      text = text.replace('</body>', '  <script src="./pairing-addon.js"></script>\n</body>');
    }
  }

  const headers = new Headers(response.headers);
  headers.set('content-type', isHtml
    ? 'text/html; charset=utf-8'
    : isLayoutCss
      ? 'text/css; charset=utf-8'
      : 'application/javascript; charset=utf-8');
  headers.set('cache-control', 'no-store, max-age=0');

  return new Response(text, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(async (cache) => {
        for (const asset of STATIC_ASSETS) {
          try {
            const request = new Request(new URL(asset, self.location.href), { cache: 'no-store' });
            const response = await fetchFreshTransformed(request);
            if (response && response.ok) await cache.put(asset, response.clone());
          } catch (_) {}
        }
      })
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.map((key) => key === CACHE_NAME ? Promise.resolve() : caches.delete(key))))
      .then(() => self.clients.claim())
      .then(() => self.clients.matchAll({ type: 'window', includeUncontrolled: true }))
      .then((windowClients) => Promise.all(windowClients.map((client) => {
        try { return client.navigate(client.url); } catch (_) { return Promise.resolve(); }
      })))
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== 'GET') return;

  if (url.pathname.includes('/api/')) {
    event.respondWith(fetch(request, { cache: 'no-store' }));
    return;
  }

  const isNavigation = request.mode === 'navigate' ||
    request.destination === 'document' ||
    url.pathname === APP_BASE ||
    url.pathname.endsWith('/index.html');
  const isCodeAsset = ['script', 'style', 'worker'].includes(request.destination) ||
    /\.(?:js|css)$/i.test(url.pathname);

  if (isNavigation) {
    event.respondWith(
      fetchFreshTransformed(request)
        .then((response) => {
          if (response && response.ok && url.origin === self.location.origin) {
            caches.open(CACHE_NAME).then((cache) => cache.put(request, response.clone()));
          }
          return response;
        })
        .catch(() => caches.match(request).then((cached) => cached || caches.match('./index.html')))
    );
    return;
  }

  if (isCodeAsset) {
    event.respondWith(
      fetchFreshTransformed(request)
        .then((response) => {
          if (response && response.ok && url.origin === self.location.origin) {
            caches.open(CACHE_NAME).then((cache) => cache.put(request, response.clone()));
          }
          return response;
        })
        .catch(() => caches.match(request))
    );
    return;
  }

  event.respondWith(
    fetch(request)
      .then((response) => {
        if (response && response.ok && url.origin === self.location.origin) {
          caches.open(CACHE_NAME).then((cache) => cache.put(request, response.clone()));
        }
        return response;
      })
      .catch(() => caches.match(request))
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetUrl = (event.notification.data && event.notification.data.url) || './';
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if ('focus' in client) {
          client.focus();
          if ('navigate' in client) client.navigate(targetUrl);
          return;
        }
      }
      if (clients.openWindow) return clients.openWindow(targetUrl);
    })
  );
});
