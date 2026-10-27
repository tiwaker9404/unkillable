/**
 * Exponential backoff with "equal jitter": half the window is fixed, half is random.
 * Pure full-jitter can retry almost immediately after a failure; equal jitter keeps a
 * guaranteed floor while still spreading a thundering herd of retries across time.
 *
 *   delay(n) = w/2 + rand(0, w/2),  w = min(max, base * 2^(n-1))
 */
export function backoffMs(
  attempt: number,
  baseMs: number,
  maxMs: number,
  random: () => number = Math.random,
): number {
  const exp = Math.min(30, Math.max(0, attempt - 1))
  const window = Math.min(maxMs, baseMs * 2 ** exp)
  return Math.round(window / 2 + random() * (window / 2))
}

/**
 * Parse a Retry-After header (delta-seconds or HTTP-date). Returns milliseconds, or
 * undefined when absent/invalid. Capped so a hostile receiver can't park a delivery forever.
 */
export function parseRetryAfter(
  value: string | undefined,
  maxMs: number,
  now = Date.now(),
): number | undefined {
  if (!value) return undefined
  const trimmed = value.trim()
  let ms: number
  if (/^\d+$/.test(trimmed)) {
    ms = Number(trimmed) * 1000
  } else {
    const date = Date.parse(trimmed)
    if (Number.isNaN(date)) return undefined
    ms = date - now
  }
  if (!Number.isFinite(ms) || ms < 0) return 0
  return Math.min(ms, maxMs)
}
