/*
 * Walkie service worker.
 *
 * Its only job is to make the app installable (Chrome requires a fetch
 * handler for the "Add to home screen" prompt) and to cache the hashed
 * /assets/ bundles. Audio is peer-to-peer WebRTC and NEVER passes through
 * here, and signaling (/ws) is deliberately left untouched so the socket
 * always talks to the live server.
 */
const ASSET_CACHE = 'walkie-assets-v1'

self.addEventListener('install', () => {
  self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys()
      await Promise.all(keys.filter((k) => k !== ASSET_CACHE).map((k) => caches.delete(k)))
      await self.clients.claim()
    })(),
  )
})

self.addEventListener('fetch', (event) => {
  const { request } = event
  if (request.method !== 'GET') return

  let url
  try {
    url = new URL(request.url)
  } catch {
    return
  }
  if (url.origin !== self.location.origin) return
  // never intercept signaling, health checks, or the HTML shell
  if (url.pathname === '/ws' || url.pathname === '/health') return
  if (!url.pathname.startsWith('/assets/')) return

  // hashed filenames are immutable: cache-first is safe
  event.respondWith(
    (async () => {
      const cache = await caches.open(ASSET_CACHE)
      const hit = await cache.match(request)
      if (hit) return hit
      const res = await fetch(request)
      if (res.ok) cache.put(request, res.clone())
      return res
    })(),
  )
})
