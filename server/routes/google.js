import crypto from 'node:crypto'
import { Router } from 'express'
import { requireAuth } from '../middleware/auth.js'
import {
  buildGoogleAuthorizationUrl,
  disconnectGoogle,
  exchangeGoogleCode,
  getGoogleConnectionStatus,
  googleOAuthConfigured,
  saveGoogleTokens
} from '../connectors/google/oauth.js'
import {
  listCalendarEvents
} from '../connectors/google/calendar.js'

const router = Router()
const STATE_MAX_AGE_MS = 10 * 60 * 1000

router.use(requireAuth)

function exposedError(message, statusCode = 400) {
  const error = new Error(message)
  error.statusCode = statusCode
  error.expose = true
  return error
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left || ''))
  const b = Buffer.from(String(right || ''))

  return (
    a.length === b.length &&
    crypto.timingSafeEqual(a, b)
  )
}

router.get('/status', (req, res) => {
  res.json(
    getGoogleConnectionStatus(
      req.session.userId
    )
  )
})

router.get('/oauth/start', (req, res, next) => {
  try {
    if (!googleOAuthConfigured()) {
      throw exposedError(
        'Google OAuth ist nicht konfiguriert',
        503
      )
    }

    const state = crypto.randomBytes(32)
      .toString('base64url')

    req.session.googleOAuth = {
      state,
      userId: req.session.userId,
      createdAt: Date.now()
    }

    req.session.save(error => {
      if (error) return next(error)

      res.redirect(
        buildGoogleAuthorizationUrl(state)
      )
    })
  } catch (error) {
    next(error)
  }
})

router.get(
  '/oauth/callback',
  async (req, res, next) => {
    try {
      if (req.query.error) {
        throw exposedError(
          `Google hat die Freigabe abgelehnt: ${req.query.error}`,
          400
        )
      }

      const saved = req.session.googleOAuth
      delete req.session.googleOAuth

      if (
        !saved ||
        saved.userId !== req.session.userId ||
        Date.now() - saved.createdAt >
          STATE_MAX_AGE_MS ||
        !safeEqual(saved.state, req.query.state)
      ) {
        throw exposedError(
          'Ungültiger oder abgelaufener OAuth-State',
          400
        )
      }

      if (
        typeof req.query.code !== 'string' ||
        !req.query.code
      ) {
        throw exposedError(
          'Google hat keinen Autorisierungscode geliefert',
          400
        )
      }

      const tokens = await exchangeGoogleCode(
        req.query.code
      )

      saveGoogleTokens(
        req.session.userId,
        tokens
      )

      res.redirect('/?google=connected')
    } catch (error) {
      next(error)
    }
  }
)

router.delete('/disconnect', (req, res) => {
  res.json({
    ok: true,
    disconnected: disconnectGoogle(
      req.session.userId
    )
  })
})

router.get('/events', async (req, res, next) => {
  try {
    const result = await listCalendarEvents(
      req.session.userId,
      {
        timeMin: req.query.timeMin,
        timeMax: req.query.timeMax,
        maxResults: req.query.maxResults,
        timeZone:
          req.query.timeZone || 'Europe/Vienna'
      }
    )

    res.json(result)
  } catch (error) {
    next(error)
  }
})

export default router
