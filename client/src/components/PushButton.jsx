import { useEffect, useState } from 'react'
import {
  getPushState,
  enablePush,
  disablePush
} from '../lib/push.js'

export default function PushButton({ style }) {
  const [state, setState] = useState('checking')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    getPushState()
      .then(setState)
      .catch(() => setState('off'))
  }, [])

  async function toggle() {
    if (
      busy ||
      state === 'checking' ||
      state === 'unsupported' ||
      state === 'blocked'
    ) return

    setBusy(true)

    try {
      setState(
        state === 'on'
          ? await disablePush()
          : await enablePush()
      )
    } catch (error) {
      window.alert(
        error?.message ||
        'Push konnte nicht geändert werden.'
      )

      setState(await getPushState())
    } finally {
      setBusy(false)
    }
  }

  const unavailable =
    state === 'checking' ||
    state === 'unsupported' ||
    state === 'blocked'

  const title =
    state === 'on'
      ? 'Push deaktivieren'
      : state === 'blocked'
        ? 'Benachrichtigungen sind blockiert'
        : state === 'unsupported'
          ? 'Push wird nicht unterstützt'
          : 'Push aktivieren'

  return (
    <button
      type="button"
      onClick={toggle}
      disabled={busy || unavailable}
      title={title}
      aria-label={title}
      style={{
        ...style,
        color:
          state === 'on'
            ? 'var(--accent)'
            : 'var(--text2)',
        opacity:
          busy || unavailable ? 0.5 : 1,
        cursor:
          busy || unavailable
            ? 'not-allowed'
            : 'pointer'
      }}
    >
      <svg
        width="19"
        height="19"
        viewBox="0 0 24 24"
        fill={state === 'on' ? 'currentColor' : 'none'}
        stroke="currentColor"
        strokeWidth="1.9"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9" />
        <path d="M10 21h4" />
      </svg>
    </button>
  )
}
