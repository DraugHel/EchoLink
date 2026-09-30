// Standardtitel neuer Unterhaltungen kommen vom Server auf Englisch.
// Angezeigt wird der deutsche Titel; gespeichert bleibt der Originalwert.
const DEFAULT_TITLES = new Set(['New Conversation'])

export function displayConvoTitle(title) {
  const value = String(title ?? '').trim()

  if (!value || DEFAULT_TITLES.has(value)) {
    return 'Neue Unterhaltung'
  }

  return value
}
