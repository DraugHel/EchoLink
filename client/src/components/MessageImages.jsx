import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  galleryLayout,
  swipeDirection,
  wrapIndex
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

// Vollbildansicht. Wird per Portal an <body> gehaengt, damit weder
// Animationen noch overflow der Nachricht die Ansicht beschneiden.
export function ImageLightbox({
  images,
  index,
  onClose,
  onIndexChange
}) {
  const [zoomed, setZoomed] = useState(false)
  const closeRef = useRef(null)
  const touchRef = useRef(null)
  const count = images.length
  const current = images[wrapIndex(index, count)]

  const go = useCallback(step => {
    setZoomed(false)
    onIndexChange(wrapIndex(index + step, count))
  }, [index, count, onIndexChange])

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
      } else if (event.key === 'ArrowRight' && count > 1) {
        event.preventDefault()
        go(1)
      } else if (event.key === 'ArrowLeft' && count > 1) {
        event.preventDefault()
        go(-1)
      }
    }

    window.addEventListener('keydown', onKeyDown)

    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onClose, go, count])

  if (!current) return null

  function onTouchStart(event) {
    const touch = event.touches[0]

    touchRef.current =
      event.touches.length === 1 && touch
        ? { startX: touch.clientX, startY: touch.clientY }
        : null
  }

  function onTouchEnd(event) {
    const start = touchRef.current
    const touch = event.changedTouches[0]

    touchRef.current = null

    if (!start || !touch || zoomed || count < 2) return

    const direction = swipeDirection({
      ...start,
      endX: touch.clientX,
      endY: touch.clientY
    })

    if (direction !== 0) go(direction)
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
          onClick={() => setZoomed(value => !value)}
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
        className={`echolink-lightbox-stage${zoomed ? ' is-zoomed' : ''}`}
        onClick={event => {
          // Nur ein Tipp neben das Bild schliesst.
          if (event.target === event.currentTarget) onClose()
        }}
        onTouchStart={onTouchStart}
        onTouchEnd={onTouchEnd}
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
          src={current.src}
          alt={current.name || ''}
          className={zoomed ? 'is-zoomed' : ''}
          draggable={false}
          onClick={() => setZoomed(value => !value)}
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
