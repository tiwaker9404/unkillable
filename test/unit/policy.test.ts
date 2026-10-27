import { describe, expect, it } from 'vitest'
import {
  DecisionSchema,
  orderFor,
  REPLY_SYSTEM,
  scriptedModel,
  TRIAGE_SYSTEM,
  triagePrompt,
} from '../../src/demo/policy.ts'
import { createSandbox } from '../../src/sandbox/server.ts'

const ticket = (message: string, orderId = 'ord_x') => ({
  ticketId: 'T-1',
  orderId,
  customerEmail: 'a@example.com',
  message,
})

function triage(message: string, order = orderFor('ord_x')) {
  const text = scriptedModel({
    messages: [
      { role: 'system', content: TRIAGE_SYSTEM },
      { role: 'user', content: triagePrompt(ticket(message), order) },
    ],
  })
  return DecisionSchema.parse(JSON.parse(text))
}

describe('scripted model applies the refund policy', () => {
  const eligible = { ...orderFor('a'), deliveredDaysAgo: 5, finalSale: false }

  it('refunds the full total inside the window', () => {
    const d = triage('It arrived broken, refund please', eligible)
    expect(d).toMatchObject({ decision: 'refund', amountCents: eligible.totalCents })
  })
  it('declines final sale and late requests', () => {
    expect(triage('refund please', { ...eligible, finalSale: true }).decision).toBe('decline')
    expect(triage('refund please', { ...eligible, deliveredDaysAgo: 40 }).decision).toBe('decline')
  })
  it('escalates non-refund messages', () => {
    expect(triage('When does my next order ship?', eligible).decision).toBe('escalate')
  })
  it('drafts replies', () => {
    const text = scriptedModel({
      messages: [
        { role: 'system', content: REPLY_SYSTEM },
        { role: 'user', content: 'Ticket T-9 about order o (Desk).\nOutcome: refund. Refunded: $12.00. Reason: ok.' },
      ],
    })
    expect(text).toContain('$12.00')
    expect(text).toContain('T-9')
  })
  it('orders are deterministic', () => {
    expect(orderFor('ord_1')).toEqual(orderFor('ord_1'))
  })
})

describe('sandbox honors idempotency keys', () => {
  it('applies a keyed refund once and counts the dedupe', async () => {
    const sb = createSandbox({ latencyMs: [0, 0] })
    const port = await sb.listen(0)
    const order = orderFor('ord_idem')
    const post = (key?: string) =>
      fetch(`http://127.0.0.1:${port}/payments/refunds`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(key ? { 'idempotency-key': key } : {}) },
        body: JSON.stringify({ orderId: order.id, amountCents: 100, ticketId: 'T' }),
      }).then((r) => r.json() as Promise<{ id: string }>)
    try {
      const a = await post('k1')
      const b = await post('k1')
      expect(a.id).toBe(b.id)
      await post() // no key: a second, real refund
      const s = sb.stats().refunds
      expect(s).toMatchObject({ applied: 2, deduplicatedByIdempotencyKey: 1, subjectsAffectedMoreThanOnce: 1 })
    } finally {
      await sb.close()
    }
  })
})
