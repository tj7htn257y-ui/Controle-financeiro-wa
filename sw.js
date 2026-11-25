'use strict';

/*
 * Meu Controle Financeiro — Service Worker v11.1
 * Rede primeiro para os arquivos do aplicativo; cache como alternativa offline.
 * A biblioteca do Supabase é carregada sob demanda e não faz parte do cache local.
 */
const CACHE_NAME = 'mcf-offline-v11-1';
const APP_FILES = [
  './',
  './index.html',
  './app.js?v=11.1',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png'
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

  const appPaths = APP_FILES.map(path => new URL(path, self.registration.scope).pathname);
  const isAppFile = appPaths.includes(url.pathname);

  if (request.mode === 'navigate' || isAppFile) {
    event.respondWith(
      fetch(request, { cache: 'no-store' })
        .then(async response => {
          if (response && response.ok) {
            const cache = await caches.open(CACHE_NAME);
            const cacheKey = request.mode === 'navigate'
              ? new URL('./index.html', self.registration.scope).href
              : request;
            await cache.put(cacheKey, response.clone());
          }
          return response;
        })
        .catch(async () => {
          const cached = await caches.match(request, { ignoreSearch: true });
          if (cached) return cached;
          const indexUrl = new URL('./index.html', self.registration.scope).href;
          const fallback = await caches.match(indexUrl);
          return fallback || Response.error();
        })
    );
    return;
  }

  event.respondWith(caches.match(request).then(cached => cached || fetch(request)));
});
