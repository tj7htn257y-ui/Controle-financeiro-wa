'use strict';

const CACHE = 'mcf-offline-v4';

const APP_FILES = [
  './',
  './index.html',
  './app.js',
  './manifest.json'
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE)
      .then(cache => cache.addAll(APP_FILES))
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

  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  if (url.origin !== self.location.origin) return;

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then(response => {
          if (response && response.ok) {
            const copy = response.clone();

            event.waitUntil(
              caches.open(CACHE)
                .then(cache => cache.put('./index.html', copy))
            );
          }

          return response;
        })
        .catch(() => caches.match('./index.html'))
    );

    return;
  }

  event.respondWith(
    caches.match(request)
      .then(cached => {
        if (cached) return cached;

        return fetch(request).then(response => {
          if (response && response.ok) {
            const copy = response.clone();

            event.waitUntil(
              caches.open(CACHE)
                .then(cache => cache.put(request, copy))
            );
          }

          return response;
        });
      })
      .catch(() => new Response(
        'Conteúdo indisponível offline.',
        {
          status: 503,
          headers: {
            'Content-Type': 'text/plain; charset=utf-8'
          }
        }
      ))
  );
});
