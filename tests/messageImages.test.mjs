import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import {
  DOUBLE_TAP_SCALE,
  IDENTITY_VIEW,
  MAX_SCALE,
  attachmentImageUrl,
  clampScale,
  clampView,
  distance,
  galleryLayout,
  isDoubleTap,
  isZoomed,
  midpoint,
  pinchView,
  swipeDirection,
  swipeGesture,
  wrapIndex,
  zoomAtPoint
} from '../client/src/lib/imageGallery.js'

function read(file) {
  return readFileSync(new URL(`../${file}`, import.meta.url), 'utf8')
}

test('Bild-URL zeigt auf den Upload-Endpunkt', () => {
  assert.equal(
    attachmentImageUrl('1720000000000_abcdef123456.png'),
    '/api/uploads/1720000000000_abcdef123456.png'
  )
  assert.equal(attachmentImageUrl('a b.png'), '/api/uploads/a%20b.png')
})

test('Navigation springt am Ende an den Anfang und zurueck', () => {
  assert.equal(wrapIndex(0, 3), 0)
  assert.equal(wrapIndex(3, 3), 0)
  assert.equal(wrapIndex(-1, 3), 2)
  assert.equal(wrapIndex(7, 3), 1)
  assert.equal(wrapIndex(5, 0), 0)
  assert.equal(wrapIndex(5, 1), 0)
})

test('Anordnung der Vorschau richtet sich nach der Anzahl', () => {
  assert.equal(galleryLayout(0), 'single')
  assert.equal(galleryLayout(1), 'single')
  assert.equal(galleryLayout(2), 'pair')
  assert.equal(galleryLayout(3), 'trio')
  assert.equal(galleryLayout(4), 'grid')
  assert.equal(galleryLayout(5), 'grid')
})

test('Wischgesten: nur deutlich waagerechte, lange Bewegungen blaettern', () => {
  const swipe = (dx, dy = 0) =>
    swipeDirection({ startX: 200, startY: 200, endX: 200 + dx, endY: 200 + dy })

  assert.equal(swipe(-120), 1)
  assert.equal(swipe(120), -1)
  assert.equal(swipe(-59), 0)
  assert.equal(swipe(59), 0)
  assert.equal(swipe(-100, 90), 0)
  assert.equal(swipe(100, -80), 0)
  assert.equal(swipe(-100, 40), 1)
  assert.equal(
    swipeDirection({ startX: 0, startY: 0, endX: -30, endY: 0 }, 20),
    1
  )
})

test('Nachrichten zeigen Bilder als antippbares Raster statt als kleine Vorschau', () => {
  const message = read('client/src/components/Message.jsx')

  assert.match(message, /import MessageImageGrid, \{ ZoomableImage \} from '\.\/MessageImages\.jsx'/)
  assert.match(message, /import \{ attachmentImageUrl \} from '\.\.\/lib\/imageGallery\.js'/)
  assert.match(message, /<MessageImageGrid/)
  assert.match(message, /src: attachmentImageUrl\(att\.filename\)/)
  assert.doesNotMatch(message, /maxWidth: 200, maxHeight: 200/)
  assert.match(message, /img: \(\{ src, alt \}\) => <ZoomableImage/)
})

test('Vollbildansicht: Portal, Tastatur, Pinch, Doppeltipp, Mausrad, Dialog-Attribute', () => {
  const component = read('client/src/components/MessageImages.jsx')

  assert.match(component, /createPortal\(/)
  assert.match(component, /import '\.\/MessageImages\.css'/)
  assert.match(component, /event\.key === 'Escape'/)
  assert.match(component, /'ArrowRight'/)
  assert.match(component, /'ArrowLeft'/)
  assert.match(component, /role="dialog"/)
  assert.match(component, /aria-modal="true"/)
  assert.match(component, /Original in neuem Tab öffnen/)
  assert.match(component, /document\.body\.style\.overflow = 'hidden'/)
  assert.match(component, /previousFocus\.focus\(\)/)

  // Pinch-to-zoom per Pointer Events
  assert.match(component, /onPointerDown=\{onPointerDown\}/)
  assert.match(component, /onPointerMove=\{onPointerMove\}/)
  assert.match(component, /onPointerUp=\{event => endPointer\(event\)\}/)
  assert.match(component, /onPointerCancel=\{event => endPointer\(event, true\)\}/)
  assert.match(component, /setPointerCapture\?\./)
  assert.match(component, /pinchView\(/)
  assert.match(component, /isDoubleTap\(/)
  assert.match(component, /swipeGesture\(/)

  // Mausrad / Trackpad-Pinch mit nicht-passivem Listener
  assert.match(component, /addEventListener\('wheel', onWheel, \{ passive: false \}\)/)
  assert.match(component, /event\.ctrlKey/)
  assert.match(component, /event\.key === '\+'/)
  assert.match(component, /transform:\s*\n?\s*`translate3d\(/)
})

test('Stylesheet: Raster, Vollbild, Pinch-Buehne, iPhone-Sicherheitsbereiche, reduzierte Bewegung', () => {
  const css = read('client/src/components/MessageImages.css')

  for (const selector of [
    '.msg-images-single',
    '.msg-images-trio',
    '.msg-image-tile',
    '.msg-inline-image',
    '.echolink-lightbox',
    '.echolink-lightbox-stage.is-zoomed img',
    '.echolink-lightbox-stage.is-gesturing img'
  ]) {
    assert.ok(css.includes(selector), selector)
  }

  assert.match(css, /touch-action: none/)
  assert.match(css, /transform-origin: center center/)
  assert.match(css, /overflow: hidden/)
  assert.doesNotMatch(css, /width: 220%/)
  assert.match(css, /z-index: 400/)
  assert.match(css, /env\(safe-area-inset-top\)/)
  assert.match(css, /env\(safe-area-inset-bottom\)/)
  assert.match(css, /prefers-reduced-motion: reduce/)
  assert.match(css, /cursor: zoom-in/)
})

// ---------- Pinch-to-zoom: Rechnen ----------

const near = (actual, expected, epsilon = 1e-9) =>
  assert.ok(Math.abs(actual - expected) <= epsilon, `${actual} != ${expected}`)

test('Skalierung bleibt zwischen 1 und 6', () => {
  assert.equal(MAX_SCALE, 6)
  assert.equal(clampScale(0.2), 1)
  assert.equal(clampScale(3), 3)
  assert.equal(clampScale(99), 6)
  assert.equal(clampScale('abc'), 1)
  assert.equal(clampScale(NaN), 1)
  assert.equal(isZoomed({ s: 1 }), false)
  assert.equal(isZoomed({ s: 1.0004 }), false)
  assert.equal(isZoomed({ s: 1.5 }), true)
  assert.equal(isZoomed(null), false)
  assert.deepEqual({ ...IDENTITY_VIEW }, { s: 1, tx: 0, ty: 0 })
})

test('Abstand und Mitte zweier Finger', () => {
  assert.equal(distance({ x: 0, y: 0 }, { x: 3, y: 4 }), 5)
  assert.deepEqual(midpoint({ x: 0, y: 10 }, { x: 100, y: 30 }), { x: 50, y: 20 })
})

test('zoomAtPoint: der Punkt unter dem Finger bleibt stehen', () => {
  // Bildpunkt unter (100, 40) vor dem Zoom
  const before = { s: 1, tx: 0, ty: 0 }
  const after = zoomAtPoint(before, { x: 100, y: 40 }, 2.5)
  const imagePointBefore = { x: (100 - before.tx) / before.s, y: (40 - before.ty) / before.s }
  const screenAfter = {
    x: after.tx + after.s * imagePointBefore.x,
    y: after.ty + after.s * imagePointBefore.y
  }

  assert.equal(after.s, 2.5)
  near(screenAfter.x, 100)
  near(screenAfter.y, 40)
  assert.deepEqual(after, { s: 2.5, tx: -150, ty: -60 })

  // aus einem bereits verschobenen Zustand heraus
  const moved = zoomAtPoint({ s: 2, tx: -50, ty: 20 }, { x: 30, y: -10 }, 4)

  near(moved.tx + 4 * ((30 - -50) / 2), 30)
  near(moved.ty + 4 * ((-10 - 20) / 2), -10)

  // zurueck auf 1: mittig, ohne Verschiebung
  assert.deepEqual(zoomAtPoint({ s: 2, tx: -50, ty: 20 }, { x: 30, y: 0 }, 1), { s: 1, tx: 0, ty: 0 })
  assert.equal(zoomAtPoint({ s: 1, tx: 0, ty: 0 }, { x: 0, y: 0 }, 99).s, 6)
})

test('pinchView: Zoom folgt dem Fingerabstand, die Mitte nimmt das Bild mit', () => {
  const start = { s: 1, tx: 0, ty: 0 }

  // Beide Finger bewegen sich symmetrisch um die gleiche Mitte: reiner Zoom.
  const centered = pinchView({
    start, startMid: { x: 0, y: 0 }, startDist: 100, mid: { x: 0, y: 0 }, dist: 200
  })

  assert.deepEqual(centered, { s: 2, tx: 0, ty: 0 })

  // Mitte bei (100, 0): derselbe Bildpunkt bleibt darunter.
  assert.deepEqual(
    pinchView({ start, startMid: { x: 100, y: 0 }, startDist: 100, mid: { x: 100, y: 0 }, dist: 200 }),
    { s: 2, tx: -100, ty: 0 }
  )

  // Die Mitte wandert (Verschieben waehrend des Zoomens).
  const dragged = pinchView({
    start, startMid: { x: 0, y: 0 }, startDist: 100, mid: { x: 40, y: -20 }, dist: 100
  })

  assert.deepEqual(dragged, { s: 1, tx: 40, ty: -20 })

  // Grenzen und Absicherung gegen Abstand 0
  assert.equal(pinchView({ start, startMid: { x: 0, y: 0 }, startDist: 100, mid: { x: 0, y: 0 }, dist: 10000 }).s, 6)
  assert.equal(pinchView({ start, startMid: { x: 0, y: 0 }, startDist: 100, mid: { x: 0, y: 0 }, dist: 10 }).s, 1)
  assert.ok(Number.isFinite(pinchView({ start, startMid: { x: 0, y: 0 }, startDist: 0, mid: { x: 0, y: 0 }, dist: 50 }).s))

  // Weiter zoomen aus einem schon gezoomten Zustand
  const again = pinchView({
    start: { s: 2, tx: -30, ty: 10 }, startMid: { x: 20, y: 5 }, startDist: 100, mid: { x: 20, y: 5 }, dist: 150
  })

  near(again.s, 3)
  near(again.tx, 20 - 1.5 * (20 - -30))
  near(again.ty, 5 - 1.5 * (5 - 10))
})

test('clampView: mittig bei 1x, sonst nur so weit verschiebbar wie das Bild ueber die Buehne ragt', () => {
  const size = { stageW: 400, stageH: 700, imgW: 400, imgH: 300 }

  assert.deepEqual(clampView({ s: 1, tx: 80, ty: 40 }, size), { s: 1, tx: 0, ty: 0 })
  assert.deepEqual(clampView({ s: 1.0005, tx: 80, ty: 40 }, size), { s: 1, tx: 0, ty: 0 })

  // 2x: Breite 800 > 400 -> +-200; Hoehe 600 < 700 -> 0
  assert.deepEqual(clampView({ s: 2, tx: 900, ty: 50 }, size), { s: 2, tx: 200, ty: 0 })
  assert.deepEqual(clampView({ s: 2, tx: -900, ty: -50 }, size), { s: 2, tx: -200, ty: 0 })
  assert.deepEqual(clampView({ s: 2, tx: 60, ty: 0 }, size), { s: 2, tx: 60, ty: 0 })

  // 6x: Hoehe 1800 > 700 -> +-550
  assert.deepEqual(clampView({ s: 9, tx: 0, ty: 9999 }, size), { s: 6, tx: 0, ty: 550 })

  // Hochformat-Bild in breiter Buehne
  assert.deepEqual(
    clampView({ s: 3, tx: 500, ty: 500 }, { stageW: 800, stageH: 400, imgW: 200, imgH: 400 }),
    { s: 3, tx: 0, ty: 400 }
  )

  // Noch nicht gemessen: keine geratenen Grenzen.
  assert.deepEqual(
    clampView({ s: 2, tx: 33, ty: 44 }, { stageW: 0, stageH: 0, imgW: 0, imgH: 0 }),
    { s: 2, tx: 33, ty: 44 }
  )
})

test('swipeGesture: waagerecht blaettert, deutlich nach unten schliesst, sonst nichts', () => {
  const g = (dx, dy) => swipeGesture({ startX: 200, startY: 300, endX: 200 + dx, endY: 300 + dy })

  assert.equal(g(-120, 0), 'next')
  assert.equal(g(120, 10), 'prev')
  assert.equal(g(10, 120), 'close')
  assert.equal(g(-20, 100), 'close')
  assert.equal(g(0, 89), null)
  assert.equal(g(0, -200), null)
  assert.equal(g(-40, 0), null)
  assert.equal(g(120, 120), null)
  assert.equal(g(-100, 130), null)

  assert.equal(
    swipeGesture({ startX: 0, startY: 0, endX: 0, endY: 50 }, { closeThreshold: 40 }),
    'close'
  )
})

test('Doppeltipp: kurzer Abstand in Zeit und Ort', () => {
  const first = { x: 100, y: 100, time: 1000 }

  assert.equal(DOUBLE_TAP_SCALE, 2.5)
  assert.equal(isDoubleTap(first, { x: 105, y: 98, time: 1250 }), true)
  assert.equal(isDoubleTap(first, { x: 100, y: 100, time: 1321 }), false)
  assert.equal(isDoubleTap(first, { x: 160, y: 100, time: 1100 }), false)
  assert.equal(isDoubleTap(null, first), false)
  assert.equal(isDoubleTap(first, null), false)
})
