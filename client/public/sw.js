self.addEventListener('push', event => {
  let payload = {}

  try {
    payload = event.data
      ? event.data.json()
      : {}
  } catch {
    payload = {
      body: event.data
        ? event.data.text()
        : ''
    }
  }

  const title =
    payload.title || 'EchoLink'

  const options = {
    body: payload.body || '',
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    tag: payload.tag || 'echolink',
    renotify: true,
    data: {
      url: payload.url || '/'
    }
  }

  event.waitUntil(
    self.registration.showNotification(
      title,
      options
    )
  )
})

self.addEventListener(
  'notificationclick',
  event => {
    event.notification.close()

    const targetUrl =
      new URL(
        event.notification.data?.url || '/',
        self.location.origin
      ).href

    event.waitUntil((async () => {
      const windows = await clients.matchAll({
        type: 'window',
        includeUncontrolled: true
      })

      for (const client of windows) {
        try {
          if ('navigate' in client) {
            await client.navigate(targetUrl)
          }

          return client.focus()
        } catch {
          // Nächstes Fenster versuchen.
        }
      }

      return clients.openWindow(targetUrl)
    })())
  }
)
