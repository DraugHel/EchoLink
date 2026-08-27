function normalizeMemoryIntentText(value) {
  return String(value || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
}

function hasRequestedRememberIntent(text) {
  return (
    /(?:^|[.!?]\s+)(?:bitte\s+)?merk(?:e)?\b/u.test(text) ||
    /\bmerk(?:e)?\s+(?:dir|die|bitte|mal)\b/u.test(text) ||
    /\bbitte\s+merk(?:e)?\b/u.test(text) ||
    /\bbitte\s+merken\b/u.test(text) ||
    /\b(?:kannst|könntest|kannste)\s+du(?:\s+\S+){0,4}\s+merken\b/u.test(text) ||
    /\bspeicher(?:e)?\s+(?:dir|das|dies|die|bitte)\b/u.test(text) ||
    /\bbitte\s+speichern\b/u.test(text) ||
    /\b(?:kannst|könntest|kannste)\s+du(?:\s+\S+){0,4}\s+speichern\b/u.test(text) ||
    /\bbehalt(?:e)?\s+(?:dir|das|dies|die|bitte)\b/u.test(text) ||
    /\b(?:kannst|könntest|kannste)\s+du(?:\s+\S+){0,4}\s+behalten\b/u.test(text) ||
    /\bplease\s+remember\b/u.test(text) ||
    /\bremember\s+(?:this|that)\b/u.test(text) ||
    /\bsave\s+(?:this|that)\b/u.test(text)
  )
}

function hasRequestedForgetIntent(text) {
  return (
    /\bvergiss(?:\s+bitte)?\b/u.test(text) ||
    /\bbitte\s+vergiss\b/u.test(text) ||
    /\bnicht\s+mehr\s+(?:merken|speichern)\b/u.test(text) ||
    /\baus\s+(?:(?:der|den|meiner|meinen)\s+)?(?:memory|erinnerung(?:en)?)\s+(?:entfernen|löschen)\b/u.test(text) ||
    /\b(?:forget|please\s+forget)\s+(?:this|that|it)?\b/u.test(text)
  )
}

export function shouldForceMemoryUpdate(content) {
  const text = normalizeMemoryIntentText(content)
  if (!text) return false

  if (hasRequestedRememberIntent(text)) return true
  if (hasRequestedForgetIntent(text)) return true

  return (
    /\bab\s+jetzt\b/u.test(text) ||
    /\bvon\s+nun\s+an\b/u.test(text) ||
    /\bich\s+bevorzuge\b/u.test(text)
  )
}
