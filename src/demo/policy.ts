import { createHash } from 'node:crypto'
import { z } from 'zod'
import type { LlmRequest } from '../llm/types.ts'

/* ------------------------------------------------------------------ domain */

export interface Order {
  id: string
  item: string
  totalCents: number
  deliveredDaysAgo: number
  finalSale: boolean
  customerEmail: string
}

const ITEMS = [
  'Trail running shoes',
  'Noise-cancelling headphones',
  'Espresso machine',
  'Standing desk',
  'Mechanical keyboard',
  'Winter jacket',
  'Smart watch',
  'Cast iron skillet',
]

/** Deterministic fake order book: the same id always yields the same order. */
export function orderFor(id: string, customerEmail = 'customer@example.com'): Order {
  const h = createHash('sha256').update(id).digest()
  return {
    id,
    item: ITEMS[h[0]! % ITEMS.length]!,
    totalCents: 1500 + (h.readUInt16BE(1) % 58_500),
    deliveredDaysAgo: h[3]! % 45,
    finalSale: h[4]! % 10 === 0,
    customerEmail,
  }
}

export const TicketSchema = z.object({
  ticketId: z.string().min(1),
  orderId: z.string().min(1),
  customerEmail: z.string().email(),
  message: z.string().min(1).max(5000),
})
export type Ticket = z.infer<typeof TicketSchema>

export const DecisionSchema = z.object({
  decision: z.enum(['refund', 'decline', 'escalate']),
  amountCents: z.number().int().nonnegative(),
  reason: z.string().min(1),
})
export type Decision = z.infer<typeof DecisionSchema>

/* ----------------------------------------------------------------- prompts */

export const TRIAGE_SYSTEM = `You are a support agent for an online store deciding refund requests.
Policy:
- Refund the full order total when the customer asks for a refund AND the order was delivered 30 or fewer days ago AND it is not final sale.
- Decline when the order is final sale or was delivered more than 30 days ago.
- Escalate when the message is not a refund request or is abusive or unclear.
- Never refund more than the order total.
Respond with a JSON object: {"decision": "refund"|"decline"|"escalate", "amountCents": integer, "reason": string}. amountCents is 0 unless decision is "refund".`

export function triagePrompt(ticket: Ticket, order: Order): string {
  return `Order:\n${JSON.stringify(order)}\n\nCustomer message (ticket ${ticket.ticketId}):\n${ticket.message}`
}

export const REPLY_SYSTEM = `You write short, warm, specific customer support emails (under 120 words). Plain text, no subject line, sign off as "The Support Team".`

export function replyPrompt(
  ticket: Ticket,
  order: Order,
  outcome: { decision: string; refundedCents: number; reason: string },
): string {
  return `Ticket ${ticket.ticketId} about order ${order.id} (${order.item}).
Outcome: ${outcome.decision}. Refunded: $${(outcome.refundedCents / 100).toFixed(2)}. Reason: ${outcome.reason}.
Customer wrote: ${ticket.message}`
}

/* ---------------------------------------------------- scripted stand-in model */

/**
 * What a well-behaved model answers for the two prompts above. Used by the in-process
 * ScriptedProvider and by the sandbox's OpenAI-compatible endpoint, so every test and the
 * chaos benchmark are reproducible and free. Real models plug in via LLM_PROVIDER=openai.
 */
export function scriptedModel(req: LlmRequest): string {
  const system = req.messages[0]?.content ?? ''
  const user = req.messages.find((m) => m.role === 'user')?.content ?? ''

  if (system === TRIAGE_SYSTEM) {
    const orderJson = user.match(/Order:\n(\{.*\})/)?.[1]
    const order = orderJson ? (JSON.parse(orderJson) as Order) : undefined
    const text = user.toLowerCase()
    const wantsRefund = /refund|return|money back|broken|damaged|defective|wrong/.test(text)
    let d: Decision
    if (!order || !wantsRefund) {
      d = { decision: 'escalate', amountCents: 0, reason: 'Not a refund request; needs a human.' }
    } else if (order.finalSale) {
      d = { decision: 'decline', amountCents: 0, reason: 'Item was sold as final sale.' }
    } else if (order.deliveredDaysAgo > 30) {
      d = {
        decision: 'decline',
        amountCents: 0,
        reason: `Delivered ${order.deliveredDaysAgo} days ago; the window is 30 days.`,
      }
    } else {
      d = {
        decision: 'refund',
        amountCents: order.totalCents,
        reason: `Within the 30-day window (${order.deliveredDaysAgo} days) and not final sale.`,
      }
    }
    return JSON.stringify(d)
  }

  if (system === REPLY_SYSTEM) {
    const ticket = user.match(/Ticket (\S+)/)?.[1] ?? ''
    const item = user.match(/\(([^)]+)\)/)?.[1] ?? 'your order'
    const decision = user.match(/Outcome: (\w+)/)?.[1]
    const amount = user.match(/Refunded: (\$[\d.]+)/)?.[1] ?? '$0.00'
    const body =
      decision === 'refund'
        ? `Hi there,\n\nThanks for reaching out about the ${item}. We've issued a full refund of ${amount} to your original payment method; you'll see it in 5-10 business days.\n\nSorry this one didn't work out.`
        : decision === 'decline'
          ? `Hi there,\n\nThanks for reaching out about the ${item}. Unfortunately this order isn't eligible for a refund under our policy, but we'd be glad to help with a repair or exchange.`
          : `Hi there,\n\nThanks for your message about the ${item}. A member of our team will follow up personally within one business day.`
    return `${body}\n\n(ref ${ticket})\nThe Support Team`
  }

  throw new Error('scripted model: unrecognized prompt')
}
