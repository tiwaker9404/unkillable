import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildApi } from '../../src/api/server.ts'
import type { Sql } from '../../src/db/index.ts'
import { TicketSchema } from '../../src/demo/policy.ts'
import { defineAgent } from '../../src/runtime/types.ts'
import { registry } from '../../src/runtime/worker.ts'
import { freshDb, log, testConfig } from '../helpers/index.ts'

let sql: Sql
let app: Awaited<ReturnType<typeof buildApi>>
const auth = { authorization: 'Bearer test_key' }

beforeAll(async () => {
  sql = await freshDb()
  const agents = registry(
    defineAgent({ name: 'refund-agent', input: TicketSchema, run: async () => null }) as never,
  )
  app = await buildApi({ sql, cfg: testConfig({ API_KEYS: 'test_key,other' }), log, agents })
})
afterAll(async () => {
  await app.close()
  await sql.end()
})

const ticket = {
  ticketId: 'T-1',
  orderId: 'ord_1',
  customerEmail: 'a@example.com',
  message: 'refund please',
}

describe('API', () => {
  it('requires a valid API key on /v1', async () => {
    expect((await app.inject({ url: '/v1/runs' })).statusCode).toBe(401)
    expect((await app.inject({ url: '/v1/runs', headers: { authorization: 'Bearer nope' } })).statusCode).toBe(401)
    expect((await app.inject({ url: '/v1/runs', headers: auth })).statusCode).toBe(200)
    expect((await app.inject({ url: '/healthz' })).statusCode).toBe(200)
  })

  it('creates runs idempotently', async () => {
    const send = (input: unknown) =>
      app.inject({
        method: 'POST',
        url: '/v1/runs',
        headers: { ...auth, 'idempotency-key': 'ticket-T-1' },
        payload: { agent: 'refund-agent', input },
      })
    const first = await send(ticket)
    expect(first.statusCode).toBe(202)
    const again = await send(ticket)
    expect(again.statusCode).toBe(200)
    expect(again.headers['idempotent-replayed']).toBe('true')
    expect(again.json().id).toBe(first.json().id)
    expect(first.json()).not.toHaveProperty('leaseToken')
    expect((await send({ ...ticket, message: 'different' })).statusCode).toBe(409)
  })

  it('validates agent and input', async () => {
    const unknown = await app.inject({
      method: 'POST',
      url: '/v1/runs',
      headers: auth,
      payload: { agent: 'nope', input: {} },
    })
    expect(unknown.statusCode).toBe(404)
    const bad = await app.inject({
      method: 'POST',
      url: '/v1/runs',
      headers: auth,
      payload: { agent: 'refund-agent', input: { ticketId: 'x' } },
    })
    expect(bad.statusCode).toBe(422)
    expect(bad.json().error.message).toContain('customerEmail')
  })

  it('lists, reads, events, cancels and retries', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/v1/runs',
      headers: auth,
      payload: { agent: 'refund-agent', input: { ...ticket, ticketId: 'T-2' } },
    })
    const id = created.json().id as string

    const list = await app.inject({ url: '/v1/runs?limit=1', headers: auth })
    expect(list.json().data).toHaveLength(1)
    expect(list.json().nextCursor).toBeTruthy()

    const detail = await app.inject({ url: `/v1/runs/${id}`, headers: auth })
    expect(detail.json()).toMatchObject({ id, status: 'queued', steps: [], savings: { replayedSteps: 0 } })
    expect((await app.inject({ url: '/v1/runs/not-an-id', headers: auth })).statusCode).toBe(400)

    const ev = await app.inject({
      method: 'POST',
      url: `/v1/runs/${id}/events`,
      headers: auth,
      payload: { name: 'approval', payload: { approved: true } },
    })
    expect(ev.statusCode).toBe(202)
    expect(ev.json().woke).toBe(false) // not waiting on it yet; it will be consumed when it is

    expect((await app.inject({ method: 'POST', url: `/v1/runs/${id}/cancel`, headers: auth })).statusCode).toBe(200)
    expect((await app.inject({ method: 'POST', url: `/v1/runs/${id}/cancel`, headers: auth })).statusCode).toBe(409)
    const retried = await app.inject({ method: 'POST', url: `/v1/runs/${id}/retry`, headers: auth, payload: {} })
    expect(retried.json().status).toBe('queued')
  })

  it('serves stats, metrics and an OpenAPI spec', async () => {
    const stats = await app.inject({ url: '/v1/stats', headers: auth })
    expect(stats.json()).toHaveProperty('llm.tokensSaved')
    const metrics = await app.inject({ url: '/metrics' })
    expect(metrics.body).toContain('unkillable_runs')
    const spec = await app.inject({ url: '/docs/json' })
    expect(Object.keys(spec.json().paths)).toEqual(
      expect.arrayContaining(['/v1/runs', '/v1/runs/{id}', '/v1/runs/{id}/events', '/v1/runs/{id}/retry']),
    )
  })
})
