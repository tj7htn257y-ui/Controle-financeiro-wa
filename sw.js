'use strict';

/*
 * Service Worker
 * Estratégia: HTML e arquivos locais atualizados pela rede primeiro;
 * se estiver offline, utiliza a cópia em cache.
 */
const CACHE_NAME = 'mcf-offline-v9';
const APP_FILES = [
  './',
  './index.html',
  './app.js',
  './manifest.json'
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(APP_FILES))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(name => name.startsWith('mcf-offline-') && name !== CACHE_NAME)
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

  const isAppFile = APP_FILES.some(path => new URL(path, self.location.href).pathname === url.pathname);

  if (request.mode === 'navigate' || isAppFile) {
    event.respondWith(
      fetch(request, { cache: 'no-store' })
        .then(async response => {
          if (response && response.ok) {
            const cache = await caches.open(CACHE_NAME);
            const cacheKey = request.mode === 'navigate' ? './index.html' : request;
            await cache.put(cacheKey, response.clone());
          }
          return response;
        })
        .catch(async () => {
          const cached = await caches.match(request) || await caches.match('./index.html');
          return cached || Response.error();
        })
    );
    return;
  }

  event.respondWith(
    caches.match(request).then(cached => cached || fetch(request))
  );
});
