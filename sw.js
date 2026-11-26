
'use strict';

/*
 * Meu Controle Financeiro
 * Service Worker v11.2
 *
 * Estratégia:
 * - Rede primeiro para arquivos do aplicativo.
 * - Cache como alternativa offline.
 * - Atualização automática da versão.
 * - Exclusão dos caches antigos.
 * - Supabase externo não é interceptado.
 */

const CACHE_NAME = 'mcf-offline-v11-2';

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

  // Não interceptar bibliotecas e serviços externos,
  // incluindo o Supabase.
  if (url.origin !== self.location.origin) return;

  const appPaths = APP_FILES.map(path =>
    new URL(path, self.registration.scope).pathname
  );

  const isAppFile = appPaths.includes(url.pathname);

  if (request.mode === 'navigate' || isAppFile) {
    event.respondWith(
      fetch(request, { cache: 'no-store' })
        .then(async response => {
          if (response && response.ok) {
            const cache = await caches.open(CACHE_NAME);

            const cacheKey = request.mode === 'navigate'
              ? new URL(
                  './index.html',
                  self.registration.scope
                ).href
              : request;

            await cache.put(
              cacheKey,
              response.clone()
            );
          }

          return response;
        })
        .catch(async () => {
          const cached = await caches.match(
            request,
            { ignoreSearch: true }
          );

          if (cached) return cached;

          const indexUrl = new URL(
            './index.html',
            self.registration.scope
          ).href;

          const fallback = await caches.match(indexUrl);

          return fallback || Response.error();
        })
    );

    return;
  }

  // Outros arquivos: cache primeiro, rede depois.
  event.respondWith(
    caches.match(request)
      .then(cached => cached || fetch(request))
  );
});
