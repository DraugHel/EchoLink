const MAX_GOAL_LENGTH = 180
const MAX_DETAIL_LENGTH = 800

const AGENTIC_PATTERN = /\b(?:analysier|prüf|recherch|such|find|vergleich|fass|erst(e|el)|änder|bearbeit|öffn|lies|schreib|send|plane|plan|deploy|build|test|debug|mail|gmail|kalender|termin|datei|upload|web|quelle|status|logs?|terminal|agent|task)\w*/i

function unixNow() {
  return Math.floor(Date.now() / 1000)
}

function compactText(value, maxLength = MAX_DETAIL_LENGTH) {
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength)
}


function compactDetail(value, maxLength = MAX_DETAIL_LENGTH) {
  return String(value ?? '')
    .split(/\r?\n/)
    .map(line => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join('\n')
    .slice(0, maxLength)
}

function appendEvent(run, event) {
  const sequence = Number(run?.eventSequence) || 0
  const createdAt = Number(event?.createdAt) || unixNow()

  return {
    ...run,
    eventSequence: sequence + 1,
    events: [
      ...(Array.isArray(run?.events) ? run.events : []),
      {
        id: `${run.id}-${sequence + 1}`,
        type: compactText(event?.type || 'info', 80),
        message: compactText(event?.message, 500),
        detail: compactDetail(event?.detail, MAX_DETAIL_LENGTH),
        stepIndex: Number.isInteger(event?.stepIndex)
          ? event.stepIndex
          : null,
        createdAt
      }
    ]
  }
}

function updateWithEvent(run, patch, event) {
  const updated = {
    ...run,
    ...patch
  }

  return event ? appendEvent(updated, event) : updated
}

function readableToolName(value) {
  const raw = compactText(value, 120)
  if (!raw) return 'Tool'

  return raw
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export function shouldShowChatRun({
  content,
  attachments = []
} = {}) {
  const text = compactText(content, 4_000)

  return Boolean(
    attachments.length > 0 ||
    text.length >= 90 ||
    AGENTIC_PATTERN.test(text)
  )
}

export function createChatRun({
  id,
  content,
  startedAt = unixNow()
}) {
  const goal = compactText(content, MAX_GOAL_LENGTH) ||
    'Aktuellen Chat-Auftrag bearbeiten'

  const plan = [
    {
      id: 'understand',
      title: `Auftrag verstehen: ${goal}`
    },
    {
      id: 'tools',
      title: 'Benötigte Informationen oder Werkzeuge einsetzen'
    },
    {
      id: 'verify',
      title: 'Ergebnisse prüfen und zusammenführen'
    },
    {
      id: 'compose',
      title: 'Antwort formulieren'
    },
    {
      id: 'quality',
      title: 'Abschluss und Vollständigkeit prüfen'
    }
  ]

  let run = {
    id,
    source: 'chat',
    status: 'running',
    phase: 'planning',
    plan,
    currentStep: 0,
    progress: 'Auftrag wird analysiert',
    controlState: 'active',
    startedAt,
    finishedAt: null,
    result: null,
    error: null,
    eventSequence: 0,
    events: []
  }

  run = appendEvent(run, {
    type: 'started',
    message: 'Chat-Auftrag gestartet',
    stepIndex: 0,
    createdAt: startedAt
  })

  run = appendEvent(run, {
    type: 'plan',
    message: 'Arbeitsplan erstellt',
    detail: plan
      .map((step, index) => `${index + 1}. ${step.title}`)
      .join('\n'),
    stepIndex: 0,
    createdAt: startedAt
  })

  return appendEvent(run, {
    type: 'step',
    message: 'Auftrag wird analysiert',
    stepIndex: 0,
    createdAt: startedAt
  })
}

export function markChatRunTool(run, event = {}) {
  if (!run || run.status !== 'running') return run

  const toolName = readableToolName(event.tool)
  const status = compactText(event.status, 40).toLowerCase()
  const query = compactText(event.query, 500)
  const resultCount = Number(event.resultCount)

  if (status === 'done') {
    return updateWithEvent(run, {
      phase: 'running',
      currentStep: 2,
      progress: `${toolName}-Ergebnis wird geprüft`,
      controlState: 'active'
    }, {
      type: 'tool_finished',
      message: `${toolName} abgeschlossen`,
      detail: Number.isFinite(resultCount)
        ? `${resultCount} Ergebnisse`
        : '',
      stepIndex: 1
    })
  }

  if (status === 'error') {
    return updateWithEvent(run, {
      phase: 'running',
      currentStep: 1,
      progress: `${toolName} meldet einen Fehler`,
      controlState: 'active'
    }, {
      type: 'tool_failed',
      message: `${toolName} meldet einen Fehler`,
      detail: query,
      stepIndex: 1
    })
  }

  return updateWithEvent(run, {
    phase: 'running',
    currentStep: 1,
    progress: `${toolName} wird ausgeführt`,
    controlState: 'active'
  }, {
    type: 'tool_started',
    message: `${toolName} wird ausgeführt`,
    detail: query,
    stepIndex: 1
  })
}

export function markChatRunWriting(run) {
  if (
    !run ||
    run.status !== 'running' ||
    run.currentStep >= 3
  ) {
    return run
  }

  return updateWithEvent(run, {
    phase: 'running',
    currentStep: 3,
    progress: 'Antwort wird formuliert',
    controlState: 'active'
  }, {
    type: 'step',
    message: 'Antwort wird formuliert',
    stepIndex: 3
  })
}

export function markChatRunWaitingApproval(run, detail = '') {
  if (!run || run.status !== 'running') return run

  return updateWithEvent(run, {
    phase: 'waiting_approval',
    progress: 'Freigabe wird benötigt',
    controlState: 'waiting_approval'
  }, {
    type: 'approval_requested',
    message: 'Luna wartet auf deine Freigabe',
    detail,
    stepIndex: Math.max(1, Number(run.currentStep) || 0)
  })
}

export function markChatRunApproval(run, approved) {
  if (!run || run.status !== 'running') return run

  return updateWithEvent(run, {
    phase: 'running',
    progress: approved
      ? 'Freigabe erteilt – Auftrag läuft weiter'
      : 'Freigabe abgelehnt – Auftrag wird angepasst',
    controlState: 'active'
  }, {
    type: approved ? 'approval_granted' : 'approval_denied',
    message: approved
      ? 'Freigabe wurde erteilt'
      : 'Freigabe wurde abgelehnt',
    stepIndex: Math.max(1, Number(run.currentStep) || 0)
  })
}

export function requestChatRunCancel(run) {
  if (!run || run.status !== 'running') return run

  return updateWithEvent(run, {
    progress: 'Abbruch wurde angefordert',
    controlState: 'cancel_requested'
  }, {
    type: 'cancel_requested',
    message: 'Abbruch wurde angefordert',
    stepIndex: Number(run.currentStep) || 0
  })
}

export function finishChatRun(
  run,
  finishedAt = unixNow()
) {
  if (!run || run.status !== 'running') return run

  let updated = updateWithEvent(run, {
    phase: 'finalizing',
    currentStep: 4,
    progress: 'Abschluss und Vollständigkeit werden geprüft',
    controlState: 'active'
  }, {
    type: 'quality',
    message: 'Abschluss und Vollständigkeit werden geprüft',
    stepIndex: 4,
    createdAt: finishedAt
  })

  updated = updateWithEvent(updated, {
    status: 'success',
    phase: 'success',
    currentStep: 4,
    progress: 'Chat-Auftrag erfolgreich abgeschlossen',
    controlState: 'finished',
    finishedAt
  }, {
    type: 'completed',
    message: 'Chat-Auftrag erfolgreich abgeschlossen',
    stepIndex: 4,
    createdAt: finishedAt
  })

  return updated
}

export function cancelChatRun(
  run,
  finishedAt = unixNow()
) {
  if (!run || run.status !== 'running') return run

  return updateWithEvent(run, {
    status: 'cancelled',
    phase: 'cancelled',
    progress: 'Chat-Auftrag wurde abgebrochen',
    controlState: 'cancelled',
    finishedAt
  }, {
    type: 'cancelled',
    message: 'Chat-Auftrag wurde abgebrochen',
    stepIndex: Number(run.currentStep) || 0,
    createdAt: finishedAt
  })
}

export function failChatRun(
  run,
  error,
  finishedAt = unixNow()
) {
  if (!run || run.status !== 'running') return run

  const message = compactText(
    error?.message || error || 'Unbekannter Fehler',
    1_000
  )

  return updateWithEvent(run, {
    status: 'failed',
    phase: 'failed',
    progress: 'Chat-Auftrag ist fehlgeschlagen',
    controlState: 'finished',
    error: message,
    finishedAt
  }, {
    type: 'failed',
    message: 'Chat-Auftrag ist fehlgeschlagen',
    detail: message,
    stepIndex: Number(run.currentStep) || 0,
    createdAt: finishedAt
  })
}
