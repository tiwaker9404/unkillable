import { randomBytes } from 'node:crypto'

/**
 * Prefixed, time-sortable IDs (ULID layout, Crockford base32): `run_01JB8X...`.
 * Lexicographic order == creation order, which keeps cursor pagination and
 * B-tree inserts cheap, and the prefix makes IDs self-describing in logs.
 */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

let lastTime = 0
let lastRandom: Uint8Array = new Uint8Array(10)

function encode(bytes: Uint8Array, length: number): string {
  // big-endian base32 encode of an arbitrary byte array, left-padded to `length`
  let value = 0n
  for (const b of bytes) value = (value << 8n) | BigInt(b)
  let out = ''
  for (let i = 0; i < length; i++) {
    out = ALPHABET[Number(value & 31n)] + out
    value >>= 5n
  }
  return out
}

function increment(bytes: Uint8Array): Uint8Array {
  const next = new Uint8Array(bytes)
  for (let i = next.length - 1; i >= 0; i--) {
    if (next[i]! < 255) {
      next[i]! += 1
      return next
    }
    next[i] = 0
  }
  return next
}

export function ulid(now = Date.now()): string {
  // Monotonic within the same millisecond so IDs from one process never sort backwards.
  if (now <= lastTime) {
    lastRandom = increment(lastRandom)
    now = lastTime
  } else {
    lastTime = now
    lastRandom = new Uint8Array(randomBytes(10))
  }
  const time = new Uint8Array(6)
  let t = now
  for (let i = 5; i >= 0; i--) {
    time[i] = t % 256
    t = Math.floor(t / 256)
  }
  return encode(time, 10) + encode(lastRandom, 16)
}

export type IdPrefix = 'run' | 'rf' | 'note' | 'em'

export function newId(prefix: IdPrefix): string {
  return `${prefix}_${ulid()}`
}
