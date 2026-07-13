import { Router } from 'express'
import { requireAuth } from '../middleware/auth.js'
import db from '../db.js'
import {
  getVapidPublicKey,
  sendPushToUser
} from '../lib/push.js'

const router = Router()

function readSubscription(body) {
  const endpoint = body?.endpoint
  const p256dh = body?.keys?.p256dh
  const auth = body?.keys?.auth

  if (
    typeof endpoint !== 'string' ||
    !endpoint.startsWith('https://') ||
    endpoint.length > 4096
  ) {
    throw new Error(
      'Ungültiger Push-Endpunkt'
    )
  }

  if (
    typeof p256dh !== 'string' ||
    p256dh.length < 20 ||
    p256dh.length > 512
  ) {
    throw new Error(
      'Ungültiger Push-Schlüssel'
    )
  }

  if (
    typeof auth !== 'string' ||
    auth.length < 8 ||
    auth.length > 256
  ) {
    throw new Error(
      'Ungültiger Auth-Schlüssel'
    )
  }

  return {
    endpoint,
    p256dh,
    auth
  }
}

router.get(
  '/public-key',
  requireAuth,
  (req, res) => {
    try {
      res.json({
        publicKey: getVapidPublicKey()
      })
    } catch (error) {
      res.status(503).json({
        error: error?.message || String(error)
      })
    }
  }
)

router.post(
  '/subscribe',
  requireAuth,
  (req, res) => {
    try {
      const subscription =
        readSubscription(req.body)

      const userAgent = String(
        req.get('user-agent') || ''
      ).slice(0, 500)

      db.prepare(`
        INSERT INTO push_subscriptions (
          user_id,
          endpoint,
          p256dh,
          auth,
          user_agent
        )
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(endpoint) DO UPDATE SET
          user_id = excluded.user_id,
          p256dh = excluded.p256dh,
          auth = excluded.auth,
          user_agent = excluded.user_agent,
          updated_at = unixepoch()
      `).run(
        req.session.userId,
        subscription.endpoint,
        subscription.p256dh,
        subscription.auth,
        userAgent
      )

      // Maximal 20 Geräte/Browser pro Benutzer behalten.
      db.prepare(`
        DELETE FROM push_subscriptions
        WHERE user_id = ?
          AND id NOT IN (
            SELECT id
            FROM push_subscriptions
            WHERE user_id = ?
            ORDER BY updated_at DESC, id DESC
            LIMIT 20
          )
      `).run(
        req.session.userId,
        req.session.userId
      )

      res.json({ ok: true })
    } catch (error) {
      res.status(400).json({
        error: error?.message || String(error)
      })
    }
  }
)

router.post(
  '/unsubscribe',
  requireAuth,
  (req, res) => {
    const endpoint = req.body?.endpoint

    if (
      typeof endpoint !== 'string' ||
      !endpoint
    ) {
      return res.status(400).json({
        error: 'Push-Endpunkt fehlt'
      })
    }

    db.prepare(`
      DELETE FROM push_subscriptions
      WHERE user_id = ? AND endpoint = ?
    `).run(
      req.session.userId,
      endpoint
    )

    res.json({ ok: true })
  }
)

router.post(
  '/test',
  requireAuth,
  async (req, res) => {
    const result = await sendPushToUser(
      req.session.userId,
      {
        title: 'EchoLink Push aktiviert',
        body:
          'Erinnerungen können jetzt als Push-Nachricht zugestellt werden.',
        url: '/',
        tag: 'echolink-push-test'
      }
    )

    res.json({
      ok: result.sent > 0,
      ...result
    })
  }
)

export default router
