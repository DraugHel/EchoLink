export function normalizeLunaToolStatus(value) {
  if (!value) return ''

  if (typeof value === 'string') {
    return value.trim()
  }

  if (Array.isArray(value)) {
    return value
      .map(normalizeLunaToolStatus)
      .filter(Boolean)
      .join(', ')
  }

  if (typeof value === 'object') {
    const preferred =
      value.message ||
      value.label ||
      value.description ||
      value.status ||
      value.tool ||
      value.name

    return normalizeLunaToolStatus(preferred)
  }

  return String(value).trim()
}

export function getLunaToolText(value) {
  const raw = normalizeLunaToolStatus(value)

  if (!raw) return ''

  const compact = raw
    .replace(/\s+/g, ' ')
    .trim()

  // "terminal" contains the German substring "termin". Commands must
  // therefore be classified before calendar terms.
  if (/\b(?:terminal|shell|command|befehl|exec)\b/i.test(compact)) {
    return 'Luna führt einen Befehl aus …'
  }

  if (/gmail|e-?mail|mailbox/i.test(compact)) {
    return 'Luna durchsucht Gmail …'
  }

  if (/calendar|kalender|\btermin(?:e|en|s)?\b/i.test(compact)) {
    return 'Luna schaut in den Kalender …'
  }

  if (/web|search|suche|searx|browse/i.test(compact)) {
    return 'Luna durchsucht das Web …'
  }

  if (/upload|attachment|anhang|datei|file/i.test(compact)) {
    return 'Luna liest eine Datei …'
  }

  if (/memory|gedächtnis|gedaechtnis|erinner/i.test(compact)) {
    return 'Luna schaut ins Gedächtnis …'
  }

  if (/task|aufgabe|scheduler/i.test(compact)) {
    return 'Luna arbeitet an einer Aufgabe …'
  }

  if (/tool|werkzeug/i.test(compact)) {
    return 'Luna benutzt ein Werkzeug …'
  }

  return compact.toLowerCase().startsWith('luna')
    ? compact
    : `Luna arbeitet: ${compact}`
}

export function getLunaToolKind(value) {
  const raw = normalizeLunaToolStatus(value)

  if (!raw) return ''

  if (/\b(?:terminal|shell|command|befehl|exec)\b/i.test(raw)) {
    return 'terminal'
  }
  if (/gmail|e-?mail|mailbox/i.test(raw)) return 'gmail'
  if (/calendar|kalender|\btermin(?:e|en|s)?\b/i.test(raw)) {
    return 'calendar'
  }
  if (/upload|attachment|anhang|datei|file/i.test(raw)) return 'file'
  if (/memory|gedächtnis|gedaechtnis|erinner/i.test(raw)) return 'memory'
  if (/task|aufgabe|scheduler/i.test(raw)) return 'task'
  if (/web|search|suche|searx|browse/i.test(raw)) return 'web'

  return 'tool'
}
