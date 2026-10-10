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

// ----- Zoomen und Verschieben (Pinch-to-zoom) -----
//
// Eine Ansicht ist { s, tx, ty }: Skalierung s und Verschiebung (tx, ty) in
// Pixeln relativ zur Bildmitte. Alle Punkte sind relativ zur Mitte der Buehne.

export const MIN_SCALE = 1
export const MAX_SCALE = 6
export const DOUBLE_TAP_SCALE = 2.5

export const IDENTITY_VIEW = Object.freeze({ s: 1, tx: 0, ty: 0 })

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value))
}

export function clampScale(value, min = MIN_SCALE, max = MAX_SCALE) {
  const number = Number(value)

  if (!Number.isFinite(number)) return min

  return clamp(number, min, max)
}

export function distance(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y)
}

export function midpoint(a, b) {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
}

export function isZoomed(view) {
  return Number(view?.s) > MIN_SCALE + 0.001
}

// Neue Skalierung, bei der der Punkt unter dem Finger/Mauszeiger stehen bleibt.
export function zoomAtPoint(view, point, nextScale) {
  const s = clampScale(nextScale)

  if (s <= MIN_SCALE + 0.001) return { s: MIN_SCALE, tx: 0, ty: 0 }

  const factor = s / view.s

  return {
    s,
    tx: point.x - factor * (point.x - view.tx),
    ty: point.y - factor * (point.y - view.ty)
  }
}

// Zwei-Finger-Geste: Der Bildpunkt, der beim Start unter der Mitte beider
// Finger lag, bleibt unter der (bewegten) Mitte. Das ergibt Zoom und Verschieben.
export function pinchView({ start, startMid, startDist, mid, dist }) {
  const s = clampScale(start.s * (dist / (startDist || 1)))
  const factor = s / start.s

  return {
    s,
    tx: mid.x - factor * (startMid.x - start.tx),
    ty: mid.y - factor * (startMid.y - start.ty)
  }
}

// Haelt das Bild im Sichtbereich: bei Skalierung 1 mittig, sonst darf es nur
// so weit verschoben werden, wie es ueber die Buehne hinausragt.
export function clampView(view, { stageW, stageH, imgW, imgH }) {
  const s = clampScale(view.s)

  if (s <= MIN_SCALE + 0.001) return { s: MIN_SCALE, tx: 0, ty: 0 }

  // Noch nicht gemessen: nicht raten.
  if (!(stageW > 0) || !(stageH > 0) || !(imgW > 0) || !(imgH > 0)) {
    return { s, tx: view.tx, ty: view.ty }
  }

  const maxX = Math.max(0, (imgW * s - stageW) / 2)
  const maxY = Math.max(0, (imgH * s - stageH) / 2)

  // "+ 0" macht aus -0 eine 0 (sonst steht "-0px" im Stil).
  return {
    s,
    tx: clamp(view.tx, -maxX, maxX) + 0,
    ty: clamp(view.ty, -maxY, maxY) + 0
  }
}

// Wischgeste im Normalzustand: 'next' / 'prev' (waagerecht), 'close'
// (deutlich nach unten) oder null.
export function swipeGesture(
  { startX, startY, endX, endY },
  { threshold = 60, closeThreshold = 90 } = {}
) {
  const dx = endX - startX
  const dy = endY - startY

  if (dy >= closeThreshold && dy >= Math.abs(dx) * 1.5) return 'close'

  const direction = swipeDirection(
    { startX, startY, endX, endY },
    threshold
  )

  if (direction === 1) return 'next'
  if (direction === -1) return 'prev'

  return null
}

export function isDoubleTap(
  previous,
  current,
  { ms = 320, px = 32 } = {}
) {
  if (!previous || !current) return false

  return (
    current.time - previous.time <= ms &&
    Math.hypot(current.x - previous.x, current.y - previous.y) <= px
  )
}
