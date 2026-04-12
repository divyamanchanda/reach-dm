/**
 * REACH SOS — caches app shell + same-origin assets so the app loads offline
 * after at least one online visit. Navigation falls back to cached index.html.
 */
const SHELL_CACHE = 'reach-sos-shell-v1'

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL_CACHE)
      await cache.addAll(['/', '/index.html', '/favicon.svg']).catch(() => {})
    })(),
  )
  self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim())
})

self.addEventListener('fetch', (event) => {
  const req = event.request
  if (req.method !== 'GET') return
  const url = new URL(req.url)
  if (url.origin !== self.location.origin) return

  event.respondWith(
    (async () => {
      const cache = await caches.open(SHELL_CACHE)
      try {
        const net = await fetch(req)
        if (net.ok) {
          try {
            await cache.put(req, net.clone())
          } catch {
            /* quota / opaque */
          }
        }
        return net
      } catch {
        const hit = await cache.match(req)
        if (hit) return hit
        const accept = req.headers.get('accept') || ''
        if (req.mode === 'navigate' || accept.includes('text/html')) {
          const page =
            (await cache.match('/index.html')) ||
            (await cache.match('index.html')) ||
            (await cache.match(new URL('index.html', self.location.origin).pathname))
          if (page) return page
        }
        return new Response('Offline', { status: 503, statusText: 'Offline' })
      }
    })(),
  )
})
