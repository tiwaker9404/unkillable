import type { Order } from './policy.ts'

/**
 * Client for the sandboxed "customer systems" the demo agent touches: an order API,
 * a payments API (Stripe-style Idempotency-Key semantics), a CRM and an email service.
 * Swapping in real systems means replacing these four functions.
 */
export class SandboxClient {
  readonly #base: string
  constructor(baseUrl: string) {
    this.#base = baseUrl.replace(/\/$/, '')
  }

  async #call<T>(
    method: string,
    path: string,
    opts: { body?: unknown; idempotencyKey?: string; signal?: AbortSignal } = {},
  ): Promise<T> {
    const headers: Record<string, string> = { 'content-type': 'application/json' }
    if (opts.idempotencyKey) headers['idempotency-key'] = opts.idempotencyKey
    const res = await fetch(`${this.#base}${path}`, {
      method,
      headers,
      ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }),
      signal: opts.signal
        ? AbortSignal.any([opts.signal, AbortSignal.timeout(10_000)])
        : AbortSignal.timeout(10_000),
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new Error(`${method} ${path} -> HTTP ${res.status} ${text.slice(0, 200)}`)
    }
    return (await res.json()) as T
  }

  getOrder(orderId: string, email: string, signal?: AbortSignal): Promise<Order> {
    return this.#call(
      'GET',
      `/orders/${encodeURIComponent(orderId)}?email=${encodeURIComponent(email)}`,
      {
        ...(signal ? { signal } : {}),
      },
    )
  }

  refund(
    body: { orderId: string; amountCents: number; ticketId: string },
    idempotencyKey: string,
    signal?: AbortSignal,
  ): Promise<{ id: string; amountCents: number }> {
    return this.#call('POST', '/payments/refunds', {
      body,
      idempotencyKey,
      ...(signal ? { signal } : {}),
    })
  }

  crmNote(
    body: { ticketId: string; note: string; status: string },
    idempotencyKey: string,
    signal?: AbortSignal,
  ): Promise<{ id: string }> {
    return this.#call('POST', '/crm/notes', { body, idempotencyKey, ...(signal ? { signal } : {}) })
  }

  sendEmail(
    body: { ticketId: string; to: string; subject: string; text: string },
    idempotencyKey: string,
    signal?: AbortSignal,
  ): Promise<{ id: string }> {
    return this.#call('POST', '/email/send', {
      body,
      idempotencyKey,
      ...(signal ? { signal } : {}),
    })
  }
}
