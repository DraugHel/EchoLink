export default function EchoLinkMark({
  size = 32,
  style,
  title
}) {
  const labelled = Boolean(title)

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="none"
      role={labelled ? 'img' : undefined}
      aria-label={labelled ? title : undefined}
      aria-hidden={labelled ? undefined : true}
      style={{
        display: 'block',
        flexShrink: 0,
        color: 'var(--accent)',
        ...style
      }}
    >
      <path
        d="M8.5 5.5h15a5 5 0 0 1 5 5v8.8a5 5 0 0 1-5 5h-7.8L9.5 28v-3.7h-1a5 5 0 0 1-5-5v-8.8a5 5 0 0 1 5-5Z"
        stroke="currentColor"
        strokeWidth="2.35"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M14.8 12.1h-1.6a3.9 3.9 0 0 0 0 7.8h3.1"
        stroke="currentColor"
        strokeWidth="2.35"
        strokeLinecap="round"
      />
      <path
        d="M17.2 12.1h1.6a3.9 3.9 0 0 1 0 7.8h-3.1"
        stroke="currentColor"
        strokeWidth="2.35"
        strokeLinecap="round"
      />
      <path
        d="M13.9 16h4.2"
        stroke="currentColor"
        strokeWidth="2.35"
        strokeLinecap="round"
      />
    </svg>
  )
}
