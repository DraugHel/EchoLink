import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  DOUBLE_TAP_SCALE,
  IDENTITY_VIEW,
  clampScale,
  clampView,
  distance,
  galleryLayout,
  isDoubleTap,
  isZoomed,
  midpoint,
  pinchView,
  swipeGesture,
  wrapIndex,
  zoomAtPoint
} from '../lib/imageGallery.js'
import './MessageImages.css'

const ExpandIcon = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <polyline points="15 3 21 3 21 9" />
    <polyline points="9 21 3 21 3 15" />
    <line x1="21" y1="3" x2="14" y2="10" />
    <line x1="3" y1="21" x2="10" y2="14" />
  </svg>
)

const ZoomIcon = ({ zoomed }) => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <circle cx="11" cy="11" r="7" />
    <line x1="21" y1="21" x2="16.65" y2="16.65" />
    <line x1="8" y1="11" x2="14" y2="11" />
    {!zoomed && <line x1="11" y1="8" x2="11" y2="14" />}
  </svg>
)

const ExternalIcon = () => (
  <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
    <polyline points="15 3 21 3 21 9" />
    <line x1="10" y1="14" x2="21" y2="3" />
  </svg>
)

const TAP_SLOP = 10
const TAP_MS = 320

// Vollbildansicht mit Pinch-to-zoom. Wird per Portal an <body> gehaengt, damit
// weder Animationen noch overflow der Nachricht die Ansicht beschneiden.
//
// Bedienung:
//  - zwei Finger: zoomen und verschieben (Pinch)
//  - ein Finger bei Zoom: verschieben
//  - Doppeltipp: auf 2,5x zoomen / zuruecksetzen
//  - Mausrad oder Trackpad-Pinch (Strg+Rad): zoomen am Mauszeiger
//  - normal gezoomt (1x): waagerecht wischen = naechstes/vorheriges Bild,
//    nach unten wischen = schliessen
//  - Tipp neben das Bild schliesst, Tasten + - 0 zoomen
export function ImageLightbox({
  images,
  index,
  onClose,
  onIndexChange
}) {
  const [view, setView] = useState(IDENTITY_VIEW)
  const [gesturing, setGesturing] = useState(false)
  const stageRef = useRef(null)
  const imgRef = useRef(null)
  const closeRef = useRef(null)
  const viewRef = useRef(IDENTITY_VIEW)
  const pointers = useRef(new Map())
  const gesture = useRef(null)
  const lastTap = useRef(null)
  const count = images.length
  const current = images[wrapIndex(index, count)]
  const zoomed = isZoomed(view)

  viewRef.current = view

  // Messen: Mitte der Buehne und angezeigte Bildgroesse (ohne Zoom).
  const measure = useCallback(() => {
    const stage = stageRef.current
    const img = imgRef.current

    if (!stage || !img) return null

    const rect = stage.getBoundingClientRect()

    return {
      stageW: rect.width,
      stageH: rect.height,
      imgW: img.offsetWidth,
      imgH: img.offsetHeight,
      centerX: rect.left + rect.width / 2,
      centerY: rect.top + rect.height / 2
    }
  }, [])

  const toStage = useCallback((point, metrics) => ({
    x: point.x - metrics.centerX,
    y: point.y - metrics.centerY
  }), [])

  const applyView = useCallback((next, metrics = measure()) => {
    const clamped = metrics ? clampView(next, metrics) : next

    viewRef.current = clamped
    setView(clamped)
  }, [measure])

  const resetView = useCallback(() => {
    viewRef.current = IDENTITY_VIEW
    setView(IDENTITY_VIEW)
  }, [])

  const zoomBy = useCallback((factor, point = { x: 0, y: 0 }) => {
    const base = viewRef.current

    applyView(zoomAtPoint(base, point, clampScale(base.s * factor)))
  }, [applyView])

  const toggleZoomAt = useCallback((point = { x: 0, y: 0 }) => {
    const base = viewRef.current

    if (isZoomed(base)) {
      resetView()
    } else {
      applyView(zoomAtPoint(base, point, DOUBLE_TAP_SCALE))
    }
  }, [applyView, resetView])

  const go = useCallback(step => {
    resetView()
    onIndexChange(wrapIndex(index + step, count))
  }, [index, count, onIndexChange, resetView])

  // Anderes Bild: Zoom zuruecksetzen.
  useEffect(() => {
    resetView()
    pointers.current.clear()
    gesture.current = null
    lastTap.current = null
    setGesturing(false)
  }, [current?.src, resetView])

  useEffect(() => {
    const previousFocus = document.activeElement
    const previousOverflow = document.body.style.overflow

    document.body.style.overflow = 'hidden'
    closeRef.current?.focus()

    return () => {
      document.body.style.overflow = previousOverflow

      if (previousFocus && typeof previousFocus.focus === 'function') {
        previousFocus.focus()
      }
    }
  }, [])

  useEffect(() => {
    function onKeyDown(event) {
      if (event.key === 'Escape') {
        event.preventDefault()
        onClose()
      } else if (event.key === 'ArrowRight' && count > 1 && !isZoomed(viewRef.current)) {
        event.preventDefault()
        go(1)
      } else if (event.key === 'ArrowLeft' && count > 1 && !isZoomed(viewRef.current)) {
        event.preventDefault()
        go(-1)
      } else if (event.key === '+' || event.key === '=') {
        event.preventDefault()
        zoomBy(1.5)
      } else if (event.key === '-' || event.key === '_') {
        event.preventDefault()
        zoomBy(1 / 1.5)
      } else if (event.key === '0') {
        event.preventDefault()
        resetView()
      }
    }

    window.addEventListener('keydown', onKeyDown)

    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onClose, go, count, zoomBy, resetView])

  // Mausrad und Trackpad-Pinch (Strg+Rad). Muss ein nicht-passiver Listener
  // sein, sonst zoomt zusaetzlich die ganze Seite.
  useEffect(() => {
    const stage = stageRef.current

    if (!stage) return undefined

    function onWheel(event) {
      const metrics = measure()

      if (!metrics) return

      event.preventDefault()

      const base = viewRef.current
      const factor = Math.exp(
        -event.deltaY * (event.ctrlKey ? 0.012 : 0.002)
      )
      const point = toStage(
        { x: event.clientX, y: event.clientY },
        metrics
      )

      applyView(
        zoomAtPoint(base, point, clampScale(base.s * factor)),
        metrics
      )
    }

    stage.addEventListener('wheel', onWheel, { passive: false })

    return () => stage.removeEventListener('wheel', onWheel)
  }, [measure, toStage, applyView, current?.src])

  // Gedrehtes Geraet / geaenderte Fenstergroesse: Bild neu einpassen.
  useEffect(() => {
    function onResize() {
      applyView(viewRef.current)
    }

    window.addEventListener('resize', onResize)

    return () => window.removeEventListener('resize', onResize)
  }, [applyView])

  if (!current) return null

  function onPointerDown(event) {
    // Knoepfe (Pfeile) und Links behandeln ihre Eingabe selbst.
    if (event.target.closest?.('button, a')) return
    if (event.pointerType === 'mouse' && event.button !== 0) return

    stageRef.current?.setPointerCapture?.(event.pointerId)
    pointers.current.set(event.pointerId, {
      x: event.clientX,
      y: event.clientY
    })

    const points = [...pointers.current.values()]

    if (points.length === 1) {
      gesture.current = {
        type: 'single',
        startX: event.clientX,
        startY: event.clientY,
        startTime: Date.now(),
        startView: viewRef.current,
        moved: false,
        onImage: event.target === imgRef.current,
        startTarget: event.target
      }
    } else if (points.length === 2) {
      const metrics = measure()

      if (metrics) {
        gesture.current = {
          type: 'pinch',
          startView: viewRef.current,
          startDist: distance(points[0], points[1]) || 1,
          startMid: toStage(midpoint(points[0], points[1]), metrics)
        }
      }
    }

    setGesturing(true)
  }

  function onPointerMove(event) {
    if (!pointers.current.has(event.pointerId)) return

    pointers.current.set(event.pointerId, {
      x: event.clientX,
      y: event.clientY
    })

    const active = gesture.current

    if (!active) return

    const metrics = measure()

    if (!metrics) return

    if (active.type === 'pinch') {
      const points = [...pointers.current.values()]

      if (points.length < 2) return

      applyView(
        pinchView({
          start: active.startView,
          startMid: active.startMid,
          startDist: active.startDist,
          mid: toStage(midpoint(points[0], points[1]), metrics),
          dist: distance(points[0], points[1])
        }),
        metrics
      )

      return
    }

    const dx = event.clientX - active.startX
    const dy = event.clientY - active.startY

    if (!active.moved && Math.hypot(dx, dy) > TAP_SLOP) {
      active.moved = true
    }

    // Verschieben nur, wenn gezoomt wurde.
    if (active.moved && isZoomed(active.startView)) {
      applyView(
        {
          s: active.startView.s,
          tx: active.startView.tx + dx,
          ty: active.startView.ty + dy
        },
        metrics
      )
    }
  }

  function endPointer(event, cancelled = false) {
    if (!pointers.current.delete(event.pointerId)) return

    stageRef.current?.releasePointerCapture?.(event.pointerId)

    const active = gesture.current
    const remaining = pointers.current.size

    if (active?.type === 'pinch') {
      if (remaining === 1) {
        // Ein Finger bleibt liegen: weiter als Verschieben.
        const [rest] = [...pointers.current.values()]

        gesture.current = {
          type: 'single',
          startX: rest.x,
          startY: rest.y,
          startTime: Date.now(),
          startView: viewRef.current,
          moved: true,
          onImage: true,
          startTarget: null
        }
      } else if (remaining === 0) {
        gesture.current = null
        setGesturing(false)
      }

      return
    }

    if (remaining > 0) return

    gesture.current = null
    setGesturing(false)

    if (!active || cancelled) return

    const isTap =
      !active.moved && Date.now() - active.startTime < TAP_MS

    // Wischen und Schliessen nur im Normalzustand (nicht gezoomt).
    if (active.moved && !isZoomed(viewRef.current)) {
      const action = swipeGesture({
        startX: active.startX,
        startY: active.startY,
        endX: event.clientX,
        endY: event.clientY
      })

      if (action === 'next' && count > 1) go(1)
      else if (action === 'prev' && count > 1) go(-1)
      else if (action === 'close') onClose()

      return
    }

    if (!isTap) return

    const tap = { x: event.clientX, y: event.clientY, time: Date.now() }

    if (active.onImage && isDoubleTap(lastTap.current, tap)) {
      lastTap.current = null

      const metrics = measure()

      toggleZoomAt(metrics ? toStage(tap, metrics) : { x: 0, y: 0 })

      return
    }

    lastTap.current = tap

    // Tipp neben das Bild schliesst; ein Tipp auf das Bild nicht.
    if (active.startTarget === stageRef.current) onClose()
  }

  return createPortal(
    <div
      className="echolink-lightbox"
      role="dialog"
      aria-modal="true"
      aria-label="Bildansicht"
    >
      <div className="echolink-lightbox-bar">
        <span className="echolink-lightbox-title">
          {count > 1 ? `${wrapIndex(index, count) + 1} / ${count}` : ''}
          {count > 1 && current.name ? ' · ' : ''}
          {current.name || ''}
        </span>

        <button
          type="button"
          className={`echolink-lightbox-btn${zoomed ? ' is-active' : ''}`}
          onClick={() => toggleZoomAt()}
          aria-label={zoomed ? 'Verkleinern' : 'Vergrößern'}
          aria-pressed={zoomed}
          title={zoomed ? 'Verkleinern' : 'Vergrößern'}
        >
          <ZoomIcon zoomed={zoomed} />
        </button>

        <a
          className="echolink-lightbox-btn"
          href={current.src}
          target="_blank"
          rel="noreferrer"
          aria-label="Original in neuem Tab öffnen"
          title="Original öffnen"
        >
          <ExternalIcon />
        </a>

        <button
          ref={closeRef}
          type="button"
          className="echolink-lightbox-btn"
          onClick={onClose}
          aria-label="Schließen"
          title="Schließen"
        >
          ×
        </button>
      </div>

      <div
        ref={stageRef}
        className={
          'echolink-lightbox-stage' +
          (zoomed ? ' is-zoomed' : '') +
          (gesturing ? ' is-gesturing' : '')
        }
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={event => endPointer(event)}
        onPointerCancel={event => endPointer(event, true)}
      >
        {count > 1 && !zoomed && (
          <>
            <button
              type="button"
              className="echolink-lightbox-nav is-prev"
              onClick={() => go(-1)}
              aria-label="Vorheriges Bild"
            >
              ‹
            </button>
            <button
              type="button"
              className="echolink-lightbox-nav is-next"
              onClick={() => go(1)}
              aria-label="Nächstes Bild"
            >
              ›
            </button>
          </>
        )}

        <img
          key={current.src}
          ref={imgRef}
          src={current.src}
          alt={current.name || ''}
          draggable={false}
          style={{
            transform:
              `translate3d(${view.tx}px, ${view.ty}px, 0) scale(${view.s})`,
            transition: gesturing ? 'none' : 'transform 0.18s ease'
          }}
        />
      </div>
    </div>,
    document.body
  )
}

function Tile({ image, index, count, onOpen }) {
  const [state, setState] = useState('loading')
  const label = image.name
    ? `Bild vergrößern: ${image.name}`
    : count > 1
      ? `Bild ${index + 1} von ${count} vergrößern`
      : 'Bild vergrößern'

  if (state === 'failed') {
    return (
      <div className="msg-image-tile" role="img" aria-label="Bild nicht verfügbar">
        <div className="msg-image-failed">
          Bild nicht verfügbar
        </div>
      </div>
    )
  }

  return (
    <button
      type="button"
      className={`msg-image-tile${state === 'loaded' ? ' is-loaded' : ''}`}
      onClick={() => onOpen(index)}
      aria-label={label}
    >
      <img
        src={image.src}
        alt={image.name || ''}
        loading="lazy"
        decoding="async"
        onLoad={() => setState('loaded')}
        onError={() => setState('failed')}
      />
      <span className="msg-image-zoom" aria-hidden="true">
        <ExpandIcon />
      </span>
    </button>
  )
}

// Bilder einer Nachricht: Vorschau-Raster, Tippen oeffnet die Vollbildansicht.
export default function MessageImageGrid({ images, spaced = false }) {
  const [openIndex, setOpenIndex] = useState(null)
  const list = Array.isArray(images) ? images : []

  if (list.length === 0) return null

  return (
    <>
      <div
        className={
          `msg-images msg-images-${galleryLayout(list.length)}` +
          (spaced ? ' is-spaced' : '')
        }
      >
        {list.map((image, index) => (
          <Tile
            key={image.src}
            image={image}
            index={index}
            count={list.length}
            onOpen={setOpenIndex}
          />
        ))}
      </div>

      {openIndex !== null && (
        <ImageLightbox
          images={list}
          index={openIndex}
          onIndexChange={setOpenIndex}
          onClose={() => setOpenIndex(null)}
        />
      )}
    </>
  )
}

// Bild in einer Antwort (Markdown): ebenfalls antippbar.
export function ZoomableImage({ src, alt }) {
  const [open, setOpen] = useState(false)
  const [failed, setFailed] = useState(false)

  if (!src || failed) {
    return (
      <span className="msg-image-failed" role="img" aria-label="Bild nicht verfügbar">
        {alt || 'Bild nicht verfügbar'}
      </span>
    )
  }

  return (
    <>
      <button
        type="button"
        className="msg-inline-image"
        onClick={() => setOpen(true)}
        aria-label={alt ? `Bild vergrößern: ${alt}` : 'Bild vergrößern'}
      >
        <img
          src={src}
          alt={alt || ''}
          loading="lazy"
          onError={() => setFailed(true)}
        />
      </button>

      {open && (
        <ImageLightbox
          images={[{ src, name: alt || '' }]}
          index={0}
          onIndexChange={() => {}}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  )
}
