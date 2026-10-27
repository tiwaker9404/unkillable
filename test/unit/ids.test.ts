import { describe, expect, it } from 'vitest'
import { newId, ulid } from '../../src/ids.ts'

describe('ids', () => {
  it('are prefixed, 26-char Crockford ULIDs', () => {
    expect(newId('run')).toMatch(/^run_[0-9A-HJKMNP-TV-Z]{26}$/)
  })

  it('sort in creation order, even within one millisecond', () => {
    const ids = Array.from({ length: 2000 }, () => ulid(1_700_000_000_000))
    expect([...ids].sort()).toEqual(ids)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('encode time in the first 10 characters', () => {
    expect(ulid(1_000).slice(0, 10) < ulid(2_000_000_000_000).slice(0, 10)).toBe(true)
  })
})
