const RECALL_PATTERNS = [
  /\b(?:erinnerst\s+du\s+dich|wei(?:ß|ss)t\s+du\b[^?\n]{0,120}\bnoch)\b/iu,
  /\b(?:was|wie|welche[rsn]?|welchen|worüber|woran)\b[^?\n]{0,100}\b(?:hatten|haben|hat|wurde|wurden)\s+wir\b/iu,
  /\bwir\b[^?\n]{0,100}\b(?:damals|vorhin|früher|zuletzt|besprochen|vereinbart|entschieden|identifiziert)\b/iu,
  /\b(?:damals|vorhin|früher|beim\s+letzten\s+mal)\b[^?\n]{0,100}\b(?:besprochen|vereinbart|entschieden|identifiziert|festgestellt)\b/iu
]

const EXPLICIT_INVESTIGATION_PATTERNS = [
  /\b(?:prüf|prüfe|prüfen|überprüf|kontrollier|untersuch|auditier)\w*\b/iu,
  /\b(?:such|suche|suchen|durchsuch|recherchier|ermittle)\w*\b/iu,
  /\b(?:schau|sieh)\b[^?\n]{0,40}\b(?:nach|rein|an)\b/iu,
  /\b(?:aktuell|jetzt|live)\b[^?\n]{0,50}\b(?:server|system|repo|repository|datei|datenbank|status|zustand)\b/iu,
  /\b(?:terminal|shell|bash|git|docker|pm2|sqlite|logs?)\b/iu
]

const MEMORY_INVENTORY_PATTERNS = [
  /was[^?\n]{0,40}wei(?:ß|ss)t\s+du[^?\n]{0,40}(?:über|von)\s+mi(?:r|ch)/iu,
  /welche[^?\n]{0,40}(?:memor(?:y|ies)|erinnerungen|fakten|informationen)[^?\n]{0,60}(?:hast|kennst|speicherst|wei(?:ß|ss)t)/iu,
  /(?:zeig|zeige|nenn|nenne|liste|zähl|zaehl)\w*[^?\n]{0,80}(?:memor(?:y|ies)|erinnerungen)/iu,
  /was[^?\n]{0,50}(?:hast\s+du|ist)[^?\n]{0,50}(?:gespeichert|gemerkt)/iu
]

export function isMemoryInventoryRequest(content) {
  const text = String(content || '').trim()

  if (!text || text.length > 1000) {
    return false
  }

  return MEMORY_INVENTORY_PATTERNS.some(pattern => pattern.test(text))
}

export function isRecallOnlyRequest(content) {
  const text = String(content || '').trim()

  if (!text || text.length > 1000) {
    return false
  }

  const recallsPriorConversation =
    RECALL_PATTERNS.some(pattern => pattern.test(text))

  if (!recallsPriorConversation) {
    return false
  }

  const explicitlyRequestsInvestigation =
    EXPLICIT_INVESTIGATION_PATTERNS.some(pattern => pattern.test(text))

  return !explicitlyRequestsInvestigation
}

export function recallRuntimeInstruction({ hasRecallMatch }) {
  if (hasRecallMatch) {
    return `[Recall-only request policy:
- This request asks what was previously discussed, remembered or decided.
- Answer directly from the visible conversation and the relevant structured memories supplied below.
- Tools are intentionally unavailable for this request. Do not reconstruct history from the terminal, filesystem, logs, Git, Docker, web or external services.
- State uncertainty honestly when the available context does not support a detail.]`
  }

  return `[Recall-only request policy:
- This request asks what was previously discussed, remembered or decided.
- No matching structured memory was retrieved for this request.
- Use only the visible conversation. Tools are intentionally unavailable; do not search the terminal, filesystem, logs, Git, Docker, web or external services for historical traces.
- If the answer is not present in the visible conversation, say briefly that it is not stored or not available in the current context. Do not investigate or guess.]`
}
