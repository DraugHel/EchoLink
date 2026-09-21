import { Router } from 'express'
import crypto from 'node:crypto'
import {
  audiobookshelfConfig,
  assertAudiobookshelfId,
  createAudiobookshelfClient,
  normalizeAudiobookshelfUpdates
} from '../lib/audiobookshelf.js'

const router = Router()

function constantTimeEqual(left, right) {
  const a = Buffer.from(String(left || ''))
  const b = Buffer.from(String(right || ''))
  if (!a.length || a.length !== b.length) return false
  return crypto.timingSafeEqual(a, b)
}

function requireAudiobookshelfAccess(req, res, next) {
  if (req.session?.userId) return next()
  const expected = process.env.ECHO_API_KEY
  const provided = req.get('X-Echo-Api-Key')
  if (expected && constantTimeEqual(provided, expected)) return next()
  return res.status(401).json({ error: 'Unauthorized' })
}

function clientFromEnv() {
  const config = audiobookshelfConfig()
  return {
    config,
    client: config.configured
      ? createAudiobookshelfClient(config)
      : null
  }
}

function requireConfigured(res) {
  const state = clientFromEnv()
  if (!state.client) {
    res.status(503).json({
      error: 'Audiobookshelf not configured',
      code: 'AUDIOBOOKSHELF_NOT_CONFIGURED'
    })
    return null
  }
  return state
}

router.use(requireAudiobookshelfAccess)

router.get('/status', async (req, res, next) => {
  try {
    const state = clientFromEnv()
    if (!state.client) {
      return res.json({ configured: false, reachable: false })
    }
    const libraries = await state.client.listLibraries()
    res.json({
      configured: true,
      reachable: true,
      libraryCount: libraries.length,
      libraries
    })
  } catch (error) {
    next(error)
  }
})

router.get('/libraries', async (req, res, next) => {
  try {
    const state = requireConfigured(res)
    if (!state) return
    res.json({ libraries: await state.client.listLibraries() })
  } catch (error) {
    next(error)
  }
})

router.get('/libraries/:libraryId/items', async (req, res, next) => {
  try {
    const state = requireConfigured(res)
    if (!state) return
    const libraryId = assertAudiobookshelfId(req.params.libraryId, 'library-id')
    res.json(await state.client.listItems(libraryId, {
      limit: req.query.limit,
      page: req.query.page
    }))
  } catch (error) {
    next(error)
  }
})

router.get('/items/:itemId', async (req, res, next) => {
  try {
    const state = requireConfigured(res)
    if (!state) return
    res.json(await state.client.getItem(req.params.itemId))
  } catch (error) {
    next(error)
  }
})

router.post('/apply', async (req, res, next) => {
  try {
    const state = requireConfigured(res)
    if (!state) return
    const updates = normalizeAudiobookshelfUpdates(req.body)

    // Preflight all items before the first write. This prevents a stale plan
    // from overwriting metadata that changed after the proposal was created.
    const before = []
    for (const update of updates) {
      const item = await state.client.getItem(update.id)
      if (item.mediaType !== 'book') {
        return res.status(409).json({
          error: `Item ${update.id} is not a book`,
          code: 'AUDIOBOOKSHELF_NOT_A_BOOK'
        })
      }
      if (item.updatedAt !== update.expectedUpdatedAt) {
        return res.status(409).json({
          error: `Item ${update.id} changed since preview`,
          code: 'AUDIOBOOKSHELF_STALE_PREVIEW',
          itemId: update.id,
          expectedUpdatedAt: update.expectedUpdatedAt,
          actualUpdatedAt: item.updatedAt
        })
      }
      before.push(item)
    }

    const applied = []
    try {
      for (const update of updates) {
        const item = await state.client.updateItemMetadata(update.id, update.metadata)
        applied.push({ id: update.id, item, metadata: update.metadata })
      }
    } catch (error) {
      const rolledBack = []
      const rollbackFailures = []
      for (const appliedEntry of [...applied].reverse()) {
        const original = before.find(item => item.id === appliedEntry.id)
        const originalMetadata = {}
        for (const field of Object.keys(appliedEntry.metadata)) {
          originalMetadata[field] = original?.metadata?.[field] ?? null
        }
        try {
          await state.client.updateItemMetadata(appliedEntry.id, originalMetadata)
          rolledBack.push(appliedEntry.id)
        } catch (rollbackError) {
          rollbackFailures.push({
            id: appliedEntry.id,
            error: rollbackError?.code || rollbackError?.message || 'rollback_failed'
          })
        }
      }
      return res.status(502).json({
        error: 'Audiobookshelf update failed; rollback attempted',
        code: 'AUDIOBOOKSHELF_APPLY_FAILED',
        appliedIds: applied.map(entry => entry.id),
        rolledBackIds: rolledBack,
        rollbackFailures
      })
    }

    res.json({
      success: true,
      applied: applied.length,
      items: applied.map(entry => entry.item)
    })
  } catch (error) {
    next(error)
  }
})

export default router
