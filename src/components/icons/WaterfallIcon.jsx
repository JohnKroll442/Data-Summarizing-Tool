function WaterfallIcon({ size = 16 }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 20 20"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      focusable="false"
    >
      <line x1="1.5" y1="17" x2="18.5" y2="17" stroke="#556b82" strokeWidth="1" strokeLinecap="round" />
      <rect x="2"  y="10" width="3" height="7" rx="0.5" fill="#0070f2" />
      <rect x="6"  y="6"  width="3" height="5" rx="0.5" fill="#f0ab00" />
      <rect x="10" y="6"  width="3" height="4" rx="0.5" fill="#bb0000" />
      <rect x="14" y="4"  width="3" height="13" rx="0.5" fill="#00295c" />
      <path
        d="M3.5 10 L7.5 6 M9.5 8 L11.5 8 M13.5 8 L15.5 4"
        stroke="#556b82"
        strokeWidth="0.6"
        strokeDasharray="1.2 1"
        fill="none"
        strokeLinecap="round"
      />
    </svg>
  )
}

export default WaterfallIcon
