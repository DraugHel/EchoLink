import { Router } from 'express'
import { requireAuth } from '../middleware/auth.js'
import db from '../db.js'
import { loadModelList } from './chat.js'
import { hasActiveChatRequest } from '../lib/chatCancellation.js'
import {
  ConversationSummaryError,
  createConversationSummaryService
} from '../lib/conversationSummaryService.js'

const router = Router()
const service = createConversationSummaryService({
  db,
  hasActiveChatRun(userId, conversationId) {
    return hasActiveChatRequest({ userId, conversationId })
  }
})

function respondError(res, error) {
  const status = Number(error?.statusCode || error?.status)
  const safeStatus = Number.isInteger(status) && status >= 400 && status <= 599
    ? status
    : 500

  if (!(error instanceof ConversationSummaryError) && safeStatus === 500) {
    console.error('Conversation summary failed:', error?.stack || error)
  }

  res.status(safeStatus).json({
    error: safeStatus === 500
      ? 'Zusammenfassung fehlgeschlagen.'
      : error?.message || 'Zusammenfassung fehlgeschlagen.',
    code: error?.code || 'SUMMARY_ERROR'
  })
}

router.get('/:id/summary', requireAuth, (req, res) => {
  try {
    const state = service.getState(
      req.session.userId,
      req.params.id,
      req.query?.model
    )
    res.json(state)
  } catch (error) {
    respondError(res, error)
  }
})

router.post('/:id/summary/generate', requireAuth, async (req, res) => {
  try {
    const state = service.getState(req.session.userId, req.params.id)
    const selectedModel = String(req.body?.model || state.source.model || '').trim()

    if (selectedModel !== state.source.model) {
      const available = await loadModelList()
      const allowed = available.some(item => item?.name === selectedModel)
      if (!allowed) {
        throw new ConversationSummaryError(
          'Das gewählte Zusammenfassungsmodell ist nicht als konfiguriertes Chat-Modell verfügbar.',
          { status: 400, code: 'SUMMARY_MODEL_NOT_ALLOWED' }
        )
      }
    }

    const result = await service.generate(
      req.session.userId,
      req.params.id,
      {
        model: selectedModel,
        requestId: req.body?.requestId
      }
    )
    res.json(result)
  } catch (error) {
    respondError(res, error)
  }
})

router.post('/:id/summary/cancel', requireAuth, (req, res) => {
  try {
    res.json(service.cancel(
      req.session.userId,
      req.params.id,
      req.body?.requestId
    ))
  } catch (error) {
    respondError(res, error)
  }
})

router.patch('/:id/summary', requireAuth, (req, res) => {
  try {
    res.json(service.save(
      req.session.userId,
      req.params.id,
      {
        content: req.body?.content,
        expectedRevision: req.body?.expectedRevision
      }
    ))
  } catch (error) {
    respondError(res, error)
  }
})

router.post('/:id/summary/continue', requireAuth, (req, res) => {
  try {
    res.json(service.continueFromSummary(
      req.session.userId,
      req.params.id,
      {
        content: req.body?.content,
        expectedRevision: req.body?.expectedRevision,
        requestId: req.body?.requestId
      }
    ))
  } catch (error) {
    respondError(res, error)
  }
})

export default router
