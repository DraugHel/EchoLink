import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import {
  attachmentImageUrl,
  galleryLayout,
  swipeDirection,
  wrapIndex
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

test('Vollbildansicht: Portal, Tastatur, Wischen, Zoom, Dialog-Attribute', () => {
  const component = read('client/src/components/MessageImages.jsx')

  assert.match(component, /createPortal\(/)
  assert.match(component, /import '\.\/MessageImages\.css'/)
  assert.match(component, /event\.key === 'Escape'/)
  assert.match(component, /'ArrowRight'/)
  assert.match(component, /'ArrowLeft'/)
  assert.match(component, /role="dialog"/)
  assert.match(component, /aria-modal="true"/)
  assert.match(component, /Original in neuem Tab öffnen/)
  assert.match(component, /swipeDirection\(/)
  assert.match(component, /document\.body\.style\.overflow = 'hidden'/)
  assert.match(component, /previousFocus\.focus\(\)/)
  assert.match(component, /event\.target === event\.currentTarget/)
})

test('Stylesheet: Raster, Vollbild, iPhone-Sicherheitsbereiche, reduzierte Bewegung', () => {
  const css = read('client/src/components/MessageImages.css')

  for (const selector of [
    '.msg-images-single',
    '.msg-images-trio',
    '.msg-image-tile',
    '.msg-inline-image',
    '.echolink-lightbox',
    '.echolink-lightbox-stage img.is-zoomed'
  ]) {
    assert.ok(css.includes(selector), selector)
  }

  assert.match(css, /z-index: 400/)
  assert.match(css, /env\(safe-area-inset-top\)/)
  assert.match(css, /env\(safe-area-inset-bottom\)/)
  assert.match(css, /prefers-reduced-motion: reduce/)
  assert.match(css, /cursor: zoom-in/)
})
