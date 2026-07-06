// Corsn: das kleine Wesen, das im Server wohnt.
// mood: 'ok' (alles gruen) | 'focus' (streamt gerade) | 'panic' (ein Prozess ist nicht online)
export default function CorsnFace({ mood = 'ok' }) {
  const panic = mood === 'panic'
  const focus = mood === 'focus'
  const eyeColor = panic ? 'var(--danger)' : 'var(--accent)'
  return (
    <span className={'corsn-face' + (panic ? ' corsn-panic' : '')} title="Corsn">
      <svg width="24" height="24" viewBox="0 0 24 24">
        <rect x="1" y="3" width="22" height="18" rx="5"
          fill="var(--bg3)" stroke={panic ? 'var(--danger)' : 'var(--border)'} strokeWidth="1.5" />
        {panic ? (
          <>
            <circle cx="8.5" cy="11" r="2.6" fill="none" stroke={eyeColor} strokeWidth="1.4" />
            <circle cx="15.5" cy="11" r="2.6" fill="none" stroke={eyeColor} strokeWidth="1.4" />
            <circle cx="8.5" cy="11" r="0.9" fill={eyeColor} />
            <circle cx="15.5" cy="11" r="0.9" fill={eyeColor} />
          </>
        ) : (
          <>
            <rect className="corsn-eye" x="7" y={focus ? 10 : 9} width="2.6" height={focus ? 2.4 : 4} rx="1" fill={eyeColor} />
            <rect className="corsn-eye" x="14.4" y={focus ? 10 : 9} width="2.6" height={focus ? 2.4 : 4} rx="1" fill={eyeColor} />
          </>
        )}
        {panic
          ? <ellipse cx="12" cy="16.6" rx="1.8" ry="2" fill="none" stroke={eyeColor} strokeWidth="1.3" />
          : focus
            ? <line x1="9.5" y1="16.5" x2="14.5" y2="16.5" stroke={eyeColor} strokeWidth="1.3" strokeLinecap="round" />
            : <path d="M 9 15.8 Q 12 18 15 15.8" fill="none" stroke={eyeColor} strokeWidth="1.3" strokeLinecap="round" />}
      </svg>
    </span>
  )
}
