import webpush from 'web-push'
import db from '../db.js'

const VAPID_SUBJECT =
  process.env.VAPID_SUBJECT || 'mailto:admin@localhost'

const VAPID_PUBLIC_KEY =
  process.env.VAPID_PUBLIC_KEY || ''

const VAPID_PRIVATE_KEY =
  process.env.VAPID_PRIVATE_KEY || ''

export function pushConfigured() {
  return Boolean(
    VAPID_PUBLIC_KEY &&
    VAPID_PRIVATE_KEY
  )
}

if (pushConfigured()) {
  webpush.setVapidDetails(
    VAPID_SUBJECT,
    VAPID_PUBLIC_KEY,
    VAPID_PRIVATE_KEY
  )
}

export function getVapidPublicKey() {
  if (!pushConfigured()) {
    throw new Error(
      'Web Push ist auf dem Server nicht konfiguriert'
    )
  }

  return VAPID_PUBLIC_KEY
}

function clampText(value, maxLength) {
  return String(value || '').slice(0, maxLength)
}

export async function sendPushToUser(
  userId,
  payload = {}
) {
  if (!pushConfigured()) {
    return {
      configured: false,
      sent: 0,
      failed: 0,
      removed: 0
    }
  }

  const subscriptions = db.prepare(`
    SELECT id, endpoint, p256dh, auth
    FROM push_subscriptions
    WHERE user_id = ?
    ORDER BY id ASC
  `).all(userId)

  const message = JSON.stringify({
    title: clampText(
      payload.title || 'EchoLink',
      120
    ),
    body: clampText(
      payload.body || '',
      500
    ),
    url: clampText(
      payload.url || '/',
      1000
    ),
    tag: clampText(
      payload.tag || 'echolink',
      120
    ),
    conversationId:
      Number.isInteger(Number(payload.conversationId))
        ? Number(payload.conversationId)
        : null
  })

  let sent = 0
  let failed = 0
  let removed = 0

  for (const subscription of subscriptions) {
    try {
      await webpush.sendNotification(
        {
          endpoint: subscription.endpoint,
          keys: {
            p256dh: subscription.p256dh,
            auth: subscription.auth
          }
        },
        message,
        {
          TTL: 24 * 60 * 60,
          urgency: 'high'
        }
      )

      sent++
    } catch (error) {
      const statusCode =
        error?.statusCode ||
        error?.status

      if (
        statusCode === 404 ||
        statusCode === 410
      ) {
        db.prepare(`
          DELETE FROM push_subscriptions
          WHERE id = ?
        `).run(subscription.id)

        removed++
        continue
      }

      failed++

      console.error(JSON.stringify({
        level: 'error',
        event: 'push_delivery_failed',
        userId,
        subscriptionId: subscription.id,
        statusCode: statusCode || null,
        error: error?.message || String(error)
      }))
    }
  }

  return {
    configured: true,
    sent,
    failed,
    removed
  }
}
