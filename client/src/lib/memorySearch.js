// Suche im Memory-Panel: alle Woerter muessen vorkommen (UND), Gross-/
// Kleinschreibung und Umlaute sind egal ("ae" findet "ä", "ä" findet "ae").

export function normalizeSearchText(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/ä/g, 'ae')
    .replace(/ö/g, 'oe')
    .replace(/ü/g, 'ue')
    .replace(/ß/g, 'ss')
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
}

export function searchTerms(query) {
  return normalizeSearchText(query).split(/\s+/).filter(Boolean)
}

// Durchsucht Inhalt, Typ (auch die deutsche Bezeichnung), Scope, ID und die
// Quelle automatisch gespeicherter Eintraege.
export function matchesSearch(item, terms, typeLabels = {}) {
  if (!terms.length) return true

  const haystack = normalizeSearchText(
    [
      item.content,
      item.type,
      typeLabels[item.type],
      item.scope,
      `id:${item.id}`,
      `#${item.id}`,
      item.metadata?.source
    ]
      .filter(Boolean)
      .join(' ')
  )

  return terms.every(term => haystack.includes(term))
}
