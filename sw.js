
'use strict';

const CACHE = 'mcf-offline-v2';

const FILES = [
  './',
  './index.html',
  './app.js',
  './manifest.json'
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE)
      .then(cache => cache.addAll(FILES))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys
          .filter(name =>
            name.startsWith('mcf-offline-') &&
            name !== CACHE
          )
          .map(name => caches.delete(name))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const request = event.request;

  if (request.method !== 'GET') {
    return;
  }

  const url = new URL(request.url);

  if (url.origin !== self.location.origin) {
    return;
  }

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then(response => {
          const copy = response.clone();

          caches.open(CACHE).then(cache => {
            cache.put('./index.html', copy);
          });

          return response;
        })
        .catch(async () => {
          return await caches.match('./index.html');
        })
    );

    return;
  }

  event.respondWith(
    caches.match(request)
      .then(async cached => {
        if (cached) {
          return cached;
        }

        const response = await fetch(request);

        if (response.ok) {
          const cache = await caches.open(CACHE);
          cache.put(request, response.clone());
        }

        return response;
      })
      .catch(() => {
        return new Response('Conteúdo indisponível offline.', {
          status: 503,
          headers: {
            'Content-Type': 'text/plain; charset=utf-8'
          }
        });
      })
  );
});
