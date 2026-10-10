// Kleine, testbare Helfer fuer die Bilddarstellung im Chat.

export function attachmentImageUrl(filename) {
  return `/api/uploads/${encodeURIComponent(String(filename))}`
}

// Springt am Ende der Reihe an den Anfang (und umgekehrt).
export function wrapIndex(index, count) {
  if (!Number.isInteger(count) || count < 1) return 0

  return ((index % count) + count) % count
}

// Anordnung der Vorschaubilder in einer Nachricht.
export function galleryLayout(count) {
  if (count <= 1) return 'single'
  if (count === 2) return 'pair'
  if (count === 3) return 'trio'

  return 'grid'
}

// Wischgeste: 1 = naechstes Bild (nach links gewischt), -1 = vorheriges,
// 0 = keine Navigation (zu kurz oder eher senkrecht).
export function swipeDirection(
  { startX, startY, endX, endY },
  threshold = 60
) {
  const dx = endX - startX
  const dy = endY - startY

  if (Math.abs(dx) < threshold) return 0
  if (Math.abs(dx) < Math.abs(dy) * 1.5) return 0

  return dx < 0 ? 1 : -1
}
