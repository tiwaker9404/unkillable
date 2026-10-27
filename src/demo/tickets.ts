import { randomBytes } from 'node:crypto'
import type { Ticket } from './policy.ts'

const MESSAGES = [
  'Hi, the item arrived broken. I would like a refund please.',
  'This is not what I ordered — wrong size and color. Can I get my money back?',
  'The product stopped working after two days. Requesting a refund.',
  'Changed my mind, I want to return this and get a refund.',
  'Package was damaged in shipping, the box was crushed. Refund please.',
  'Can you tell me when my next order ships?',
  'I love it! Just wanted to say thanks.',
  'It is defective, the power button does nothing. I want a refund.',
]

/** Realistic-looking support tickets for demos and benchmarks. */
export function sampleTickets(count: number, seed = randomBytes(4).toString('hex')): Ticket[] {
  return Array.from({ length: count }, (_, i) => {
    const id = `${seed}-${String(i + 1).padStart(4, '0')}`
    return {
      ticketId: `T-${id}`,
      orderId: `ord_${id}`,
      customerEmail: `customer+${id}@example.com`,
      message: MESSAGES[(i * 7 + seed.charCodeAt(0)) % MESSAGES.length]!,
    }
  })
}
