'use strict';

const CACHE_NAME = 'mcf-offline-v7';

const FILES = [
  './',
  './index.html',
  './app.js',
  './manifest.json'
];

self.addEventListener('install',event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(FILES))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate',event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys
          .filter(key =>
            key.startsWith('mcf-offline-') &&
            key !== CACHE_NAME
          )
          .map(key => caches.delete(key))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch',event => {
  const request = event.request;
  const url = new URL(request.url);

  if (request.method !== 'GET') return;

  if (url.origin !== self.location.origin) return;

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then(response => {
          const copy = response.clone();

          caches.open(CACHE_NAME)
            .then(cache => cache.put('./index.html',copy));

          return response;
        })
        .catch(async () => {
          return (
            await caches.match('./index.html')
          ) || Response.error();
        })
    );

    return;
  }

  event.respondWith(
    caches.match(request)
      .then(cached => {
        if (cached) return cached;

        return fetch(request)
          .then(response => {
            if (
              response &&
              response.status === 200 &&
              response.type === 'basic'
            ) {
              const copy = response.clone();

              caches.open(CACHE_NAME)
                .then(cache => cache.put(request,copy));
            }

            return response;
          });
      })
  );
});
