self.addEventListener('install', event => {
  event.waitUntil(self.skipWaiting())
})

self.addEventListener('activate', event => {
  event.waitUntil(self.clients.claim())
})

self.addEventListener('push', event => {
  let payload = {}

  try {
    payload = event.data ? event.data.json() : {}
  } catch {
    payload = {
      body: event.data ? event.data.text() : ''
    }
  }

  const notification = self.registration.showNotification(
    payload.title || 'EchoLink',
    {
      body: payload.body || '',
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      tag: payload.tag || 'echolink',
      renotify: true,
      data: {
        url: payload.url || '/',
        conversationId: payload.conversationId || null
      }
    }
  )

  const refreshClients = self.clients
    .matchAll({
      type: 'window',
      includeUncontrolled: true
    })
    .then(windows => {
      for (const windowClient of windows) {
        windowClient.postMessage({
          type: 'ECHOLINK_PUSH',
          payload
        })
      }
    })

  event.waitUntil(
    Promise.all([notification, refreshClients])
  )
})

self.addEventListener('notificationclick', event => {
  event.notification.close()

  const targetUrl = new URL(
    event.notification.data?.url || '/',
    self.location.origin
  ).href

  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({
      type: 'window',
      includeUncontrolled: true
    })

    for (const windowClient of windows) {
      try {
        if ('navigate' in windowClient) {
          await windowClient.navigate(targetUrl)
        }

        return windowClient.focus()
      } catch {}
    }

    return self.clients.openWindow(targetUrl)
  })())
})
