
'use strict';

const CACHE_NAME = 'mcf-offline-v8';

const FILES = [
  './',
  './index.html',
  './app.js',
  './manifest.json'
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
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
            name !== CACHE_NAME
          )
          .map(name => caches.delete(name))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const request = event.request;

  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  if (url.origin !== self.location.origin) return;

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then(async response => {
          if (response && response.ok) {
            const cache = await caches.open(CACHE_NAME);
            await cache.put('./index.html', response.clone());
          }

          return response;
        })
        .catch(async () => {
          const cached = await caches.match('./index.html');

          return cached || Response.error();
        })
    );

    return;
  }

  event.respondWith(
    caches.match(request)
      .then(async cached => {
        if (cached) return cached;

        const response = await fetch(request);

        if (
          response &&
          response.status === 200 &&
          response.type === 'basic'
        ) {
          const cache = await caches.open(CACHE_NAME);
          await cache.put(request, response.clone());
        }

        return response;
      })
  );
});
