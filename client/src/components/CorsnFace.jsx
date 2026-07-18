// Luna: das kleine Wesen, das in EchoLink wohnt.
// mood: 'ok' | 'focus' | 'wink' | 'sleepy' | 'panic'

const activitySymbols = {
  gmail: '✉',
  calendar: '▣',
  web: '⌕',
  terminal: '›',
  file: '▤',
  memory: '◆',
  task: '✓',
  tool: '✦'
}

export default function CorsnFace({
  mood = 'ok',
  activity = ''
}) {
  const panic = mood === 'panic'
  const focus = mood === 'focus'
  const wink = mood === 'wink'
  const sleepy = mood === 'sleepy'

  const eyeColor =
    panic
      ? 'var(--danger)'
      : 'var(--accent)'

  const activitySymbol =
    activitySymbols[activity] || ''

  const label =
    panic
      ? 'Luna meldet ein Systemproblem'
      : focus
        ? 'Luna ist beschäftigt'
        : wink
          ? 'Luna ist zufrieden'
          : sleepy
            ? 'Luna döst'
            : 'Luna ist bereit'

  return (
    <span
      className={[
        'corsn-face',
        panic ? 'corsn-panic' : '',
        focus ? 'corsn-focus' : '',
        wink ? 'corsn-wink' : '',
        sleepy ? 'corsn-sleepy' : ''
      ].filter(Boolean).join(' ')}
      title={label}
      aria-label={label}
    >
      <svg
        width="24"
        height="24"
        viewBox="0 0 24 24"
        aria-hidden="true"
      >
        <rect
          x="1"
          y="3"
          width="22"
          height="18"
          rx="5"
          fill="var(--bg3)"
          stroke={
            panic
              ? 'var(--danger)'
              : 'var(--border)'
          }
          strokeWidth="1.5"
        />

        {panic ? (
          <>
            <circle cx="8.5" cy="11" r="2.6" fill="none" stroke={eyeColor} strokeWidth="1.4" />
            <circle cx="15.5" cy="11" r="2.6" fill="none" stroke={eyeColor} strokeWidth="1.4" />
            <circle cx="8.5" cy="11" r="0.9" fill={eyeColor} />
            <circle cx="15.5" cy="11" r="0.9" fill={eyeColor} />
          </>
        ) : sleepy ? (
          <>
            <path d="M 6.8 11.2 Q 8.3 12.2 9.8 11.2" fill="none" stroke={eyeColor} strokeWidth="1.35" strokeLinecap="round" />
            <path d="M 14.2 11.2 Q 15.7 12.2 17.2 11.2" fill="none" stroke={eyeColor} strokeWidth="1.35" strokeLinecap="round" />
          </>
        ) : wink ? (
          <>
            <path className="corsn-wink-eye" d="M 6.8 11.2 Q 8.3 12.2 9.8 11.2" fill="none" stroke={eyeColor} strokeWidth="1.35" strokeLinecap="round" />
            <rect className="corsn-eye" x="14.4" y="9" width="2.6" height="4" rx="1" fill={eyeColor} />
          </>
        ) : (
          <>
            <rect className="corsn-eye" x="7" y={focus ? 10 : 9} width="2.6" height={focus ? 2.4 : 4} rx="1" fill={eyeColor} />
            <rect className="corsn-eye" x="14.4" y={focus ? 10 : 9} width="2.6" height={focus ? 2.4 : 4} rx="1" fill={eyeColor} />
          </>
        )}

        {panic ? (
          <ellipse cx="12" cy="16.6" rx="1.8" ry="2" fill="none" stroke={eyeColor} strokeWidth="1.3" />
        ) : focus ? (
          <ellipse className="corsn-mouth" cx="12" cy="16.5" rx="2.55" ry="0.75" fill="none" stroke={eyeColor} strokeWidth="1.3" />
        ) : sleepy ? (
          <path d="M 10.3 16.6 Q 12 17.2 13.7 16.6" fill="none" stroke={eyeColor} strokeWidth="1.2" strokeLinecap="round" />
        ) : (
          <path d="M 9 15.8 Q 12 18 15 15.8" fill="none" stroke={eyeColor} strokeWidth="1.3" strokeLinecap="round" />
        )}
      </svg>

      {activitySymbol && (
        <span
          className={`luna-activity-badge luna-activity-${activity}`}
          aria-hidden="true"
        >
          {activitySymbol}
        </span>
      )}
    </span>
  )
}
