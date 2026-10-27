import { describe, expect, it } from 'vitest'
import { backoffMs, parseRetryAfter } from '../../src/runtime/backoff.ts'

describe('backoffMs', () => {
  it('grows exponentially with an equal-jitter floor', () => {
    for (let attempt = 1; attempt <= 6; attempt++) {
      const window = 100 * 2 ** (attempt - 1)
      for (let i = 0; i < 50; i++) {
        const d = backoffMs(attempt, 100, 1_000_000)
        expect(d).toBeGreaterThanOrEqual(window / 2)
        expect(d).toBeLessThanOrEqual(window)
      }
    }
  })

  it('never exceeds the cap', () => {
    expect(backoffMs(50, 1000, 5000, () => 1)).toBe(5000)
    expect(backoffMs(50, 1000, 5000, () => 0)).toBe(2500)
  })
})

describe('parseRetryAfter', () => {
  it('parses delta-seconds and HTTP dates, and caps', () => {
    expect(parseRetryAfter('3', 60_000)).toBe(3000)
    expect(parseRetryAfter('99999', 60_000)).toBe(60_000)
    const now = Date.parse('2026-01-01T00:00:00Z')
    expect(parseRetryAfter('Thu, 01 Jan 2026 00:00:10 GMT', 60_000, now)).toBe(10_000)
    expect(parseRetryAfter(undefined, 1000)).toBeUndefined()
    expect(parseRetryAfter('soon', 1000)).toBeUndefined()
  })
})
