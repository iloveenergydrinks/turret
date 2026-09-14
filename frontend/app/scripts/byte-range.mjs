// Browsers (notably mobile Safari) request byte ranges for playback and seeking.
export function parseByteRange(header, size) {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header);
  if (!match || (!match[1] && !match[2]) || size <= 0) return false;

  const startValue = match[1] ? Number(match[1]) : null;
  const endValue = match[2] ? Number(match[2]) : null;
  if (
    (startValue !== null && !Number.isSafeInteger(startValue))
    || (endValue !== null && !Number.isSafeInteger(endValue))
  ) return false;

  const start = startValue ?? Math.max(0, size - endValue);
  const end = startValue === null || endValue === null ? size - 1 : Math.min(endValue, size - 1);
  if (start >= size || start > end) return false;
  return { start, end };
}
