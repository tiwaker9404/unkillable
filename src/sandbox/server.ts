import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { orderFor, scriptedModel } from '../demo/policy.ts'
import { newId } from '../ids.ts'
import { estimateTokens } from '../llm/types.ts'

/**
 * The sandbox: stand-ins for the customer's systems, instrumented to COUNT side effects.
 *
 *   GET  /orders/:id                order lookup
 *   POST /payments/refunds          Stripe-style: honors Idempotency-Key
 *   POST /crm/notes                 honors Idempotency-Key
 *   POST /email/send                honors Idempotency-Key
 *   POST /v1/chat/completions       OpenAI-compatible LLM (scripted model), counts calls/tokens
 *   GET  /_stats  POST /_reset      ground truth for the chaos benchmark
 *
 * Side effects are applied mid-request (before the response), so a worker killed while
 * waiting for the response leaves exactly the "it happened but nobody wrote it down" state.
 */

export interface SandboxOptions {
  failureRate?: number
  latencyMs?: [number, number]
  llmLatencyMs?: [number, number]
}

interface EffectLog {
  requests: number
  applied: number
  deduplicated: number
  /** per business key (order / ticket) how many times the effect really happened */
  perSubject: Map<string, { count: number; cents: number }>
}

function newLog(): EffectLog {
  return { requests: 0, applied: 0, deduplicated: 0, perSubject: new Map() }
}

export function createSandbox(opts: SandboxOptions = {}) {
  const failureRate = opts.failureRate ?? 0
  const [lo, hi] = opts.latencyMs ?? [10, 60]
  const [llo, lhi] = opts.llmLatencyMs ?? [150, 600]
  const between = (a: number, b: number) => Math.round(a + Math.random() * (b - a))

  let state = fresh()
  function fresh() {
    return {
      refunds: newLog(),
      crm: newLog(),
      email: newLog(),
      idempotency: new Map<string, unknown>(),
      llm: { calls: 0, inputTokens: 0, outputTokens: 0 },
      emails: [] as {
        id: string
        ticketId: string
        to: string
        subject: string
        text: string
        at: string
      }[],
    }
  }

  async function effect(
    req: IncomingMessage,
    log: EffectLog,
    subject: string,
    cents: number,
    apply: () => unknown,
  ): Promise<{ status: number; body: unknown }> {
    log.requests++
    if (Math.random() < failureRate) {
      await sleep(between(lo, hi))
      return { status: 503, body: { error: 'temporarily unavailable' } }
    }
    const key = req.headers['idempotency-key']
    const scoped = typeof key === 'string' && key ? `${req.url}:${key}` : null
    await sleep(between(lo, hi) / 2)
    if (scoped && state.idempotency.has(scoped)) {
      log.deduplicated++
      await sleep(between(lo, hi) / 2)
      return { status: 200, body: state.idempotency.get(scoped) }
    }
    const result = apply()
    log.applied++
    const s = log.perSubject.get(subject) ?? { count: 0, cents: 0 }
    s.count++
    s.cents += cents
    log.perSubject.set(subject, s)
    if (scoped) state.idempotency.set(scoped, result)
    await sleep(between(lo, hi) / 2) // the effect is done; the caller doesn't know yet
    return { status: 200, body: result }
  }

  function summarize(log: EffectLog) {
    let duplicated = 0
    let extraCents = 0
    for (const s of log.perSubject.values()) {
      if (s.count > 1) {
        duplicated++
        extraCents += s.cents - s.cents / s.count
      }
    }
    return {
      requests: log.requests,
      applied: log.applied,
      deduplicatedByIdempotencyKey: log.deduplicated,
      subjects: log.perSubject.size,
      subjectsAffectedMoreThanOnce: duplicated,
      extraCents: Math.round(extraCents),
    }
  }

  function stats() {
    return {
      refunds: summarize(state.refunds),
      crm: summarize(state.crm),
      emails: summarize(state.email),
      llm: { ...state.llm },
    }
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://sandbox')
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(body))
    }
    const body = async <T>() => {
      const chunks: Buffer[] = []
      for await (const c of req) chunks.push(c as Buffer)
      return (chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}) as T
    }

    if (req.method === 'GET' && url.pathname === '/healthz') return send(200, { ok: true })
    if (req.method === 'GET' && url.pathname === '/_stats') return send(200, stats())
    if (req.method === 'GET' && url.pathname === '/_emails')
      return send(200, state.emails.slice(-50))
    if (req.method === 'POST' && url.pathname === '/_reset') {
      state = fresh()
      return send(200, { ok: true })
    }

    const orderMatch = url.pathname.match(/^\/orders\/([^/]+)$/)
    if (req.method === 'GET' && orderMatch) {
      await sleep(between(lo, hi))
      return send(
        200,
        orderFor(decodeURIComponent(orderMatch[1]!), url.searchParams.get('email') ?? undefined),
      )
    }

    if (req.method === 'POST' && url.pathname === '/payments/refunds') {
      const b = await body<{ orderId: string; amountCents: number; ticketId: string }>()
      const order = orderFor(b.orderId)
      if (
        !Number.isInteger(b.amountCents) ||
        b.amountCents <= 0 ||
        b.amountCents > order.totalCents
      ) {
        return send(400, { error: 'invalid amount' })
      }
      const r = await effect(req, state.refunds, b.orderId, b.amountCents, () => ({
        id: newId('rf'),
        orderId: b.orderId,
        amountCents: b.amountCents,
        status: 'succeeded',
      }))
      return send(r.status, r.body)
    }

    if (req.method === 'POST' && url.pathname === '/crm/notes') {
      const b = await body<{ ticketId: string; note: string; status: string }>()
      const r = await effect(req, state.crm, `${b.ticketId}:${b.status}`, 0, () => ({
        id: newId('note'),
        ...b,
      }))
      return send(r.status, r.body)
    }

    if (req.method === 'POST' && url.pathname === '/email/send') {
      const b = await body<{ ticketId: string; to: string; subject: string; text: string }>()
      const r = await effect(req, state.email, b.ticketId, 0, () => {
        const email = { id: newId('em'), ...b, at: new Date().toISOString() }
        state.emails.push(email)
        if (state.emails.length > 500) state.emails.shift()
        return { id: email.id }
      })
      return send(r.status, r.body)
    }

    if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
      const b = await body<{
        model?: string
        messages: { role: 'system' | 'user' | 'assistant'; content: string }[]
      }>()
      await sleep(between(llo, lhi))
      let text: string
      try {
        text = scriptedModel({ messages: b.messages })
      } catch (err) {
        return send(400, { error: { message: String(err) } })
      }
      const input = estimateTokens(b.messages.map((m) => m.content).join('\n'))
      const output = estimateTokens(text)
      state.llm.calls++
      state.llm.inputTokens += input
      state.llm.outputTokens += output
      return send(200, {
        id: `chatcmpl-${newId('rf').slice(3)}`,
        object: 'chat.completion',
        model: b.model ?? 'scripted-v1',
        choices: [
          { index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' },
        ],
        usage: { prompt_tokens: input, completion_tokens: output, total_tokens: input + output },
      })
    }

    send(404, { error: 'not found' })
  }

  const server: Server = createServer((req, res) => {
    handle(req, res).catch((err) => {
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: String(err) }))
    })
  })
  server.keepAliveTimeout = 30_000

  return {
    server,
    stats,
    reset: () => {
      state = fresh()
    },
    listen: (port: number, host = '127.0.0.1') =>
      new Promise<number>((resolve) => {
        server.listen(port, host, () => {
          const addr = server.address()
          resolve(typeof addr === 'object' && addr ? addr.port : port)
        })
      }),
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      }),
  }
}

// `node src/sandbox/server.ts` runs it standalone
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const range = (v: string | undefined, d: [number, number]): [number, number] => {
    if (!v) return d
    const [a, b] = v.split(',').map(Number)
    return [a ?? d[0], b ?? a ?? d[1]]
  }
  const sb = createSandbox({
    failureRate: Number(process.env.SANDBOX_FAILURE_RATE ?? 0),
    latencyMs: range(process.env.SANDBOX_LATENCY_MS, [10, 60]),
    llmLatencyMs: range(process.env.SANDBOX_LLM_LATENCY_MS, [150, 600]),
  })
  const port = await sb.listen(
    Number(process.env.SANDBOX_PORT ?? 4000),
    process.env.SANDBOX_HOST ?? '127.0.0.1',
  )
  console.log(JSON.stringify({ msg: 'sandbox listening', port }))
  const shutdown = () => void sb.close().then(() => process.exit(0))
  process.on('SIGTERM', shutdown)
  process.on('SIGINT', shutdown)
}
