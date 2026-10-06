import { Router } from 'express'
import { requireAuth } from '../middleware/auth.js'
import db, { DEFAULT_MODEL } from '../db.js'
import { pushConfigured } from '../lib/push.js'
import {
  defaultCompanionDeps,
  ensureTodayPlan,
  previewCompanion,
  sendCompanionNow
} from '../lib/companion.js'
import {
  COMPANION_DEFAULT_TONE,
  companionStatus,
  ensureCompanionConversation,
  getCompanionSettings,
  listCompanionEvents,
  planNeedsReset,
  resetCompanionPlan,
  syncCompanionConversation,
  updateCompanionSettings
} from '../lib/companionStore.js'
import { isValidTimeZone } from '../lib/companionPlan.js'
import {
  DEFAULT_COMPANION_RULES,
  FIXED_COMPANION_RULES
} from '../lib/companionPrompt.js'

const router = Router()

let depsPromise = null

function deps() {
  if (!depsPromise) {
    depsPromise = defaultCompanionDeps(db).catch(error => {
      depsPromise = null
      throw error
    })
  }

  return depsPromise
}

// Vorschau und "Jetzt senden" kosten Modellaufrufe: hoechstens einer
// alle 10 Sekunden pro Benutzer.
const lastModelCall = new Map()

function throttle(userId) {
  const now = Date.now()
  const last = lastModelCall.get(userId) || 0

  if (now - last < 10_000) {
    const error = new Error('Bitte kurz warten und erneut versuchen')
    error.statusCode = 429
    error.expose = true
    throw error
  }

  lastModelCall.set(userId, now)
}

function payload(userId) {
  const now = Date.now()
  const settings = getCompanionSettings(db, userId)

  return {
    settings,
    status: {
      ...companionStatus(db, userId, now / 1000),
      pushConfigured: pushConfigured(),
      timezoneValid: isValidTimeZone(settings.timezone)
    },
    defaults: {
      rules: DEFAULT_COMPANION_RULES,
      fixedRules: FIXED_COMPANION_RULES,
      tone: COMPANION_DEFAULT_TONE
    },
    events: listCompanionEvents(db, userId, 20)
  }
}

function handler(run) {
  return async (req, res, next) => {
    try {
      await run(req, res)
    } catch (error) {
      next(error)
    }
  }
}

router.get(
  '/',
  requireAuth,
  handler((req, res) => {
    res.json(payload(req.session.userId))
  })
)

router.patch(
  '/',
  requireAuth,
  handler((req, res) => {
    const userId = req.session.userId
    const before = getCompanionSettings(db, userId)
    const settings = updateCompanionSettings(db, userId, req.body)

    // Aendern sich Haeufigkeit, Zeitfenster oder Abstand (oder wird Luna
    // ein- bzw. wieder laut geschaltet), gilt ab sofort ein neuer Tagesplan.
    if (planNeedsReset(before, settings)) {
      resetCompanionPlan(db, userId)
      ensureTodayPlan({
        database: db,
        userId,
        settings,
        nowMs: Date.now()
      })
    }

    // Der Chat "Luna" entsteht beim ersten Einschalten und folgt danach
    // Ton und Modell aus den Einstellungen.
    if (settings.enabled && !before.enabled) {
      ensureCompanionConversation(db, userId, {
        defaultModel: DEFAULT_MODEL
      })
    }

    syncCompanionConversation(db, userId)

    res.json(payload(userId))
  })
)

router.post(
  '/replan',
  requireAuth,
  handler((req, res) => {
    const userId = req.session.userId
    const settings = getCompanionSettings(db, userId)

    resetCompanionPlan(db, userId)

    const result = ensureTodayPlan({
      database: db,
      userId,
      settings,
      nowMs: Date.now()
    })

    res.json({
      ...payload(userId),
      replanned: result.created,
      count: result.state.planned.length
    })
  })
)

router.post(
  '/preview',
  requireAuth,
  handler(async (req, res) => {
    const userId = req.session.userId

    throttle(userId)

    res.json(await previewCompanion({
      database: db,
      userId,
      deps: await deps()
    }))
  })
)

router.post(
  '/send-now',
  requireAuth,
  handler(async (req, res) => {
    const userId = req.session.userId

    throttle(userId)

    const result = await sendCompanionNow({
      database: db,
      userId,
      deps: await deps()
    })

    res.json({ ...result, ...payload(userId) })
  })
)

export default router
