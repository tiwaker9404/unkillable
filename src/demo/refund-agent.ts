import { defineAgent } from '../runtime/types.ts'
import {
  DecisionSchema,
  REPLY_SYSTEM,
  replyPrompt,
  type Ticket,
  TicketSchema,
  TRIAGE_SYSTEM,
  triagePrompt,
} from './policy.ts'
import { SandboxClient } from './sandbox-client.ts'

export interface RefundAgentOptions {
  sandboxUrl: string
  approvalThresholdCents: number
  approvalTimeoutMs?: number
}

/**
 * A customer-support refund agent. Reads the order, lets an LLM apply the refund policy
 * (Zod-validated structured output), asks a human for approval on large refunds, then
 * refunds, updates the CRM and emails the customer.
 *
 * Every line here is ordinary async code; ctx.* calls make each step crash-proof.
 * Kill the worker anywhere in this function and the run resumes without re-billing the
 * LLM or refunding twice.
 */
export function createRefundAgent(opts: RefundAgentOptions) {
  const api = new SandboxClient(opts.sandboxUrl)

  return defineAgent({
    name: 'refund-agent',
    input: TicketSchema,
    async run(ctx, ticket: Ticket) {
      const order = await ctx.step('fetch-order', () =>
        api.getOrder(ticket.orderId, ticket.customerEmail, ctx.signal),
      )

      const decision = await ctx.llm('triage', {
        schema: DecisionSchema,
        messages: [
          { role: 'system', content: TRIAGE_SYSTEM },
          { role: 'user', content: triagePrompt(ticket, order) },
        ],
      })
      // Guardrail: whatever the model says, never refund more than was paid.
      const amountCents = Math.min(decision.amountCents, order.totalCents)

      let approved = decision.decision === 'refund'
      let approver: string | null = null
      if (decision.decision === 'refund' && amountCents > opts.approvalThresholdCents) {
        await ctx.tool('request-approval', (key) =>
          api.crmNote(
            {
              ticketId: ticket.ticketId,
              status: 'pending_approval',
              note: `Refund of $${(amountCents / 100).toFixed(2)} needs manager approval: ${decision.reason}`,
            },
            key,
            ctx.signal,
          ),
        )
        // The run parks here (no worker held) until a manager approves in the dashboard.
        const ev = await ctx.waitForEvent<{ approved: boolean; by?: string }>(
          'manager-approval',
          'approval',
          { timeoutMs: opts.approvalTimeoutMs ?? 24 * 60 * 60 * 1000 },
        )
        approved = ev?.payload.approved ?? false
        approver = ev?.payload.by ?? (ev ? 'manager' : 'timeout')
      }

      let refundId: string | null = null
      if (approved) {
        const refund = await ctx.tool('issue-refund', (key) =>
          api.refund(
            { orderId: order.id, amountCents, ticketId: ticket.ticketId },
            key,
            ctx.signal,
          ),
        )
        refundId = refund.id
      }

      const finalDecision = approved
        ? 'refund'
        : decision.decision === 'refund'
          ? 'decline'
          : decision.decision
      const reason =
        decision.decision === 'refund' && !approved
          ? `Manager did not approve (${approver}).`
          : decision.reason

      await ctx.tool('update-crm', (key) =>
        api.crmNote(
          { ticketId: ticket.ticketId, status: finalDecision, note: `${finalDecision}: ${reason}` },
          key,
          ctx.signal,
        ),
      )

      const reply = await ctx.llm('draft-reply', {
        messages: [
          { role: 'system', content: REPLY_SYSTEM },
          {
            role: 'user',
            content: replyPrompt(ticket, order, {
              decision: finalDecision,
              refundedCents: approved ? amountCents : 0,
              reason,
            }),
          },
        ],
      })

      await ctx.tool('send-email', (key) =>
        api.sendEmail(
          {
            ticketId: ticket.ticketId,
            to: ticket.customerEmail,
            subject: `Re: your order ${order.id}`,
            text: reply,
          },
          key,
          ctx.signal,
        ),
      )

      return {
        decision: finalDecision,
        refundedCents: approved ? amountCents : 0,
        refundId,
        approvedBy: approver,
        reason,
      }
    },
  })
}
