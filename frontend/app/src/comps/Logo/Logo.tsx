export function Logo({
  size = 32,
}: {
  size?: number;
}) {
  return (
    <svg
      aria-label="rUSD"
      height={size}
      role="img"
      viewBox="0 0 112 36"
      width={Math.round(size * 3.11)}
    >
      <path
        d="M5 27V14.5C5 8.7 8.8 5 14.5 5S24 8.7 24 14.5v3.8c0 3.4 2.2 5.7 5.5 5.7H34"
        fill="none"
        stroke="var(--rusd-primary, #5a50e8)"
        strokeLinecap="round"
        strokeWidth="4"
      />
      <circle cx="14.5" cy="14.5" fill="var(--rusd-primary, #5a50e8)" r="2.5" />
      <text
        fill="var(--rusd-ink, #11142f)"
        fontFamily="Geist, Arial, sans-serif"
        fontSize="22"
        fontWeight="760"
        letterSpacing="-1"
        x="39"
        y="26"
      >
        rUSD
      </text>
    </svg>
  );
}
