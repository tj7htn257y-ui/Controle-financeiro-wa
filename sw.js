'use strict';

const CACHE_NAME = 'mcf-offline-v5';

const APP_FILES = [
  './',
  './index.html',
  './app.js',
  './manifest.json'
];

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);

    await cache.addAll(APP_FILES);

    await self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const names = await caches.keys();

    await Promise.all(
      names
        .filter(name =>
          name.startsWith('mcf-offline-') &&
          name !== CACHE_NAME
        )
        .map(name => caches.delete(name))
    );

    await self.clients.claim();
  })());
});

self.addEventListener('fetch', event => {
  const request = event.request;

  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  if (url.origin !== self.location.origin) return;

  if (request.mode === 'navigate') {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE_NAME);

      try {
        const response = await fetch(request);

        if (response && response.ok) {
          await cache.put(
            './index.html',
            response.clone()
          );
        }

        return response;
      } catch (_) {
        const cached = await cache.match('./index.html');

        if (cached) return cached;

        return new Response(
          'Aplicativo indisponível offline.',
          {
            status:503,
            headers:{
              'Content-Type':'text/plain; charset=utf-8'
            }
          }
        );
      }
    })());

    return;
  }

  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);

    const cached = await cache.match(request);

    if (cached) return cached;

    try {
      const response = await fetch(request);

      if (
        response &&
        response.ok &&
        response.type === 'basic'
      ) {
        await cache.put(
          request,
          response.clone()
        );
      }

      return response;
    } catch (_) {
      return new Response(
        'Conteúdo indisponível offline.',
        {
          status:503,
          headers:{
            'Content-Type':'text/plain; charset=utf-8'
          }
        }
      );
    }
  })());
});
