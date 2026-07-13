import api from './api.js'

function supported() {
  return (
    'serviceWorker' in navigator &&
    'PushManager' in window &&
    'Notification' in window
  )
}

function base64UrlToUint8Array(value) {
  const padding =
    '='.repeat((4 - value.length % 4) % 4)

  const base64 = (
    value + padding
  )
    .replace(/-/g, '+')
    .replace(/_/g, '/')

  const raw = window.atob(base64)
  const result = new Uint8Array(raw.length)

  for (let index = 0; index < raw.length; index++) {
    result[index] = raw.charCodeAt(index)
  }

  return result
}

async function registration() {
  if (!supported()) {
    throw new Error(
      'Push-Benachrichtigungen werden nicht unterstützt'
    )
  }

  await navigator.serviceWorker.register(
    '/sw.js',
    { scope: '/' }
  )

  return navigator.serviceWorker.ready
}

export async function getPushState() {
  if (!supported()) {
    return 'unsupported'
  }

  if (Notification.permission === 'denied') {
    return 'blocked'
  }

  try {
    const worker = await registration()
    const subscription =
      await worker.pushManager.getSubscription()

    return subscription ? 'on' : 'off'
  } catch {
    return 'off'
  }
}

export async function enablePush() {
  const worker = await registration()

  let permission = Notification.permission

  if (permission === 'default') {
    permission =
      await Notification.requestPermission()
  }

  if (permission !== 'granted') {
    throw new Error(
      'Benachrichtigungen wurden nicht erlaubt'
    )
  }

  const { publicKey } =
    await api.get('/api/push/public-key')

  let subscription =
    await worker.pushManager.getSubscription()

  if (!subscription) {
    subscription =
      await worker.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey:
          base64UrlToUint8Array(publicKey)
      })
  }

  await api.post(
    '/api/push/subscribe',
    subscription.toJSON()
  )

  // Sofortiger Test, damit klar ist, dass das Gerät erreichbar ist.
  await api.post('/api/push/test', {})

  return 'on'
}

export async function disablePush() {
  if (!supported()) {
    return 'unsupported'
  }

  const worker = await registration()
  const subscription =
    await worker.pushManager.getSubscription()

  if (subscription) {
    await api.post('/api/push/unsubscribe', {
      endpoint: subscription.endpoint
    })

    await subscription.unsubscribe()
  }

  return 'off'
}
