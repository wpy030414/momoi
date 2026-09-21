// Momoi Service Worker — handles Web Push notifications
// Scope: /

self.addEventListener('push', (event) => {
  if (!event.data) return

  try {
    const payload = event.data.json()
    const { title, body } = payload

    event.waitUntil(
      self.registration.showNotification(title, {
        body,
        icon: '/favicon.ico',
        badge: '/favicon.ico',
        tag: 'momoi-push',
        data: { url: self.location.origin },
        requireInteraction: true,
      })
    )
  } catch {
    // Non-JSON payload — skip
  }
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windowClients) => {
      // Focus existing tab if open
      for (const client of windowClients) {
        if (client.url.startsWith(self.location.origin) && 'focus' in client) {
          return client.focus()
        }
      }
      // Open new tab
      if (clients.openWindow) {
        return clients.openWindow(self.location.origin)
      }
    })
  )
})

// Activate immediately (skip waiting phase)
self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim())
})

// Required: prevent SW from being terminated during install
self.addEventListener('install', () => {
  self.skipWaiting()
})