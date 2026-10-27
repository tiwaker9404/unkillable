import { setTimeout as sleep } from 'node:timers/promises'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import type { Sql } from '../../src/db/index.ts'
import { DurableContext } from '../../src/runtime/context.ts'
import { NonRetryableError } from '../../src/runtime/errors.ts'
import {
  claimRuns,
  createRun,
  getLog,
  getSteps,
  postEvent,
  reapExpiredLeases,
  retryRun,
  writeStep,
} from '../../src/runtime/store.ts'
import { type AgentDefinition, defineAgent } from '../../src/runtime/types.ts'
import { type AgentRegistry, registry, Worker } from '../../src/runtime/worker.ts'
import {
  FakeLlm,
  FakePayments,
  freshDb,
  log,
  testConfig,
  waitForStatus,
  waitUntil,
} from '../helpers/index.ts'

let sql: Sql
const workers: Worker[] = []

beforeAll(async () => {
  sql = await freshDb()
})
afterAll(async () => {
  await sql.end()
})
beforeEach(async () => {
  await sql`truncate runs cascade`
})
afterEach(async () => {
  await Promise.all(workers.splice(0).map((w) => w.stop(1000)))
})

async function startWorker(
  agents: AgentRegistry,
  llm = new FakeLlm(() => 'ok'),
  cfg = testConfig(),
) {
  const w = new Worker(sql, cfg, log, agents, llm)
  await w.start()
  workers.push(w)
  return w
}

const reg = (...a: AgentDefinition<never, unknown>[]) => registry(...a)

async function start(agent: string, input: unknown = {}) {
  const r = await createRun(sql, { agent, input })
  return r.run.id
}

describe('happy path', () => {
  it('runs every step once and journals it', async () => {
    const payments = new FakePayments()
    const llm = new FakeLlm(() => '{"ok":true}')
    const agent = defineAgent({
      name: 'basic',
      async run(ctx) {
        const a = await ctx.step('load', async () => ({ n: 2, at: new Date(0) }))
        const plan = await ctx.llm('plan', {
          schema: z.object({ ok: z.boolean() }),
          messages: [{ role: 'user', content: 'go' }],
        })
        const charge = await ctx.tool('charge', async (key) => payments.charge(key))
        return { a, plan, charge }
      },
    })
    await startWorker(reg(agent as never), llm)
    const id = await start('basic')
    const run = await waitForStatus(sql, id, ['succeeded'])

    // step output is JSON-normalized on the first execution, exactly as replay would return it
    expect(run.output).toEqual({
      a: { n: 2, at: '1970-01-01T00:00:00.000Z' },
      plan: { ok: true },
      charge: { id: 'ch_1' },
    })
    const steps = await getSteps(sql, id)
    expect(steps.map((s) => [s.seq, s.key, s.kind, s.status])).toEqual([
      [0, 'load', 'step', 'completed'],
      [1, 'plan', 'llm', 'completed'],
      [2, 'charge', 'tool', 'completed'],
    ])
    expect(steps[1]!.meta).toMatchObject({ model: 'fake', inputTokens: 10, outputTokens: 5 })
    expect(steps[2]!.meta).toMatchObject({ mode: 'idempotent', idempotencyKey: `unk_${id}_charge` })
    expect(llm.calls).toBe(1)
    expect(payments.applied).toBe(1)
  })
})

describe('crash recovery', () => {
  it('resumes after a worker dies mid-run: no LLM re-billing, no double charge, zombie fenced', async () => {
    const payments = new FakePayments()
    const llm = new FakeLlm(() => 'plan')
    let crashOnce = true
    const agent = defineAgent({
      name: 'refunder',
      async run(ctx) {
        await ctx.step('lookup', async () => 'order-1')
        await ctx.llm('decide', { messages: [{ role: 'user', content: 'refund?' }] })
        const r = await ctx.tool('refund', async (key) => {
          const res = payments.charge(key)
          if (crashOnce) {
            crashOnce = false
            // the effect happened, then the process froze/died before journaling it
            await new Promise(() => {})
          }
          return res
        })
        await ctx.tool('email', async (key) => payments.charge(`email:${key}`))
        return r
      },
    })

    // Worker A: execute by hand so we can "kill" it at the worst moment.
    const id = await start('refunder')
    const [claimed] = await claimRuns(sql, 'worker-A', 1, 60_000)
    const leaseA = { runId: id, token: claimed!.leaseToken, workerId: 'worker-A' }
    const ctxA = new DurableContext({
      sql,
      lease: leaseA,
      attempt: 1,
      journal: [],
      llm,
      signal: new AbortController().signal,
      log: () => {},
    })
    void agent.run(ctxA, undefined as never) // never settles: worker A is frozen mid-effect
    await waitUntil(() => payments.applied === 1)
    expect(llm.calls).toBe(1)

    // A is gone: its lease expires and the reaper re-queues the run.
    await sql`update runs set lease_expires_at = now() - interval '1 second' where id = ${id}`
    expect(await reapExpiredLeases(sql, 5)).toBe(1)

    // Worker B picks it up and finishes.
    await startWorker(reg(agent as never), llm)
    const run = await waitForStatus(sql, id, ['succeeded'])
    expect(run.attempts).toBe(2)

    expect(llm.calls).toBe(1) // the LLM decision was replayed, not re-billed
    expect(payments.applied).toBe(2) // 1 refund + 1 email, never a second refund
    expect(payments.deduped).toBe(1) // the refund retry carried the same idempotency key

    const steps = await getSteps(sql, id)
    expect(steps.find((s) => s.key === 'lookup')!.replays).toBe(1)
    expect(steps.find((s) => s.key === 'decide')!.replays).toBe(1)
    const timeline = (await getLog(sql, id)).map((l) => l.kind)
    expect(timeline).toEqual(
      expect.arrayContaining(['claimed', 'worker_lost', 'replayed', 'succeeded']),
    )

    // Zombie A wakes up and tries to write: fenced out, journal untouched.
    const wrote = await writeStep(sql, leaseA, {
      key: 'refund',
      seq: 2,
      kind: 'tool',
      status: 'failed',
      startedAt: new Date(),
    })
    expect(wrote).toBe(false)
    expect((await getSteps(sql, id)).find((s) => s.key === 'refund')!.status).toBe('completed')
  })

  it('fails a run that keeps killing workers instead of looping forever', async () => {
    const id = await start('never-registered-but-claimed')
    for (let i = 0; i < 5; i++) {
      await claimRuns(sql, `w${i}`, 1, 1)
      await sleep(5)
      await reapExpiredLeases(sql, 5)
    }
    const [run] = await sql`select status, error_code from runs where id = ${id}`
    expect(run).toMatchObject({ status: 'failed', errorCode: 'max_attempts' })
  })
})

describe('determinism guard', () => {
  it('refuses to replay when the agent took a different path', async () => {
    let version = 1
    const agent = defineAgent({
      name: 'shifty',
      async run(ctx) {
        if (version === 1) {
          await ctx.step('a', async () => 1)
          throw new Error('transient')
        }
        await ctx.step('b', async () => 2) // a deploy changed the code between executions
        return 'done'
      },
    })
    const id = await start('shifty')
    const w = await startWorker(
      reg(agent as never),
      undefined,
      testConfig({ RETRY_BASE_MS: '2000' }),
    )
    await sleep(500)
    await w.stop(500)
    version = 2
    await sql`update runs set next_run_at = now() where id = ${id}`
    await startWorker(reg(agent as never))
    const run = await waitForStatus(sql, id, ['failed'])
    expect(run.errorCode).toBe('non_determinism')
    expect(run.error).toContain('step #0 was "a"')
  })
})

describe('at-most-once effects', () => {
  it('stops for human review when a crash makes the outcome ambiguous', async () => {
    let calls = 0
    let crash = true
    const agent = defineAgent({
      name: 'legacy-api',
      async run(ctx) {
        return ctx.tool(
          'fax-the-bank',
          async () => {
            calls++
            if (crash) {
              crash = false
              await new Promise(() => {}) // dies mid-call
            }
            return 'sent'
          },
          { mode: 'at-most-once' },
        )
      },
    })
    const id = await start('legacy-api')
    const [claimed] = await claimRuns(sql, 'A', 1, 60_000)
    const ctxA = new DurableContext({
      sql,
      lease: { runId: id, token: claimed!.leaseToken, workerId: 'A' },
      attempt: 1,
      journal: [],
      llm: new FakeLlm(() => ''),
      signal: new AbortController().signal,
      log: () => {},
    })
    void agent.run(ctxA, undefined as never)
    await waitUntil(() => calls === 1)
    await sql`update runs set lease_expires_at = now() - interval '1 second' where id = ${id}`
    await reapExpiredLeases(sql, 5)

    await startWorker(reg(agent as never))
    const failed = await waitForStatus(sql, id, ['failed'])
    expect(failed.errorCode).toBe('ambiguous_effect')
    expect(calls).toBe(1) // never blindly retried

    // Operator checks the bank: it went through. Resume without repeating it.
    await retryRun(sql, id, 'assume_done')
    const done = await waitForStatus(sql, id, ['succeeded'])
    expect(calls).toBe(1)
    expect(done.output).toBeNull()
  })
})

describe('durable waits', () => {
  it('parks for a human approval and resumes on the event', async () => {
    const llm = new FakeLlm(() => 'draft')
    const agent = defineAgent({
      name: 'approver',
      async run(ctx) {
        await ctx.llm('draft', { messages: [{ role: 'user', content: 'x' }] })
        const ev = await ctx.waitForEvent<{ ok: boolean }>('approval', 'approve', {
          timeoutMs: 60_000,
        })
        return ev?.payload
      },
    })
    await startWorker(reg(agent as never), llm)
    const id = await start('approver')
    const waiting = await waitForStatus(sql, id, ['waiting'])
    expect(waiting.waitEvent).toBe('approve')

    const res = await postEvent(sql, id, 'approve', { ok: true })
    expect(res?.woke).toBe(true)
    const run = await waitForStatus(sql, id, ['succeeded'])
    expect(run.output).toEqual({ ok: true })
    expect(llm.calls).toBe(1)
  })

  it('an event that arrives before the wait is consumed without parking', async () => {
    const agent = defineAgent({
      name: 'early',
      async run(ctx) {
        await ctx.step('slow', () => sleep(300).then(() => 1))
        return (await ctx.waitForEvent('w', 'go', { timeoutMs: 60_000 }))?.payload
      },
    })
    await startWorker(reg(agent as never))
    const id = await start('early')
    await waitForStatus(sql, id, ['running'])
    await postEvent(sql, id, 'go', 'early-bird')
    const run = await waitForStatus(sql, id, ['succeeded'])
    expect(run.output).toBe('early-bird')
    expect((await getLog(sql, id)).some((l) => l.kind === 'suspended')).toBe(false)
  })

  it('times out a wait and sleeps durably', async () => {
    const agent = defineAgent({
      name: 'timer',
      async run(ctx) {
        await ctx.sleep('nap', 1200)
        return ctx.waitForEvent('never', 'nope', { timeoutMs: 800 })
      },
    })
    await startWorker(reg(agent as never))
    const t0 = Date.now()
    const id = await start('timer')
    const run = await waitForStatus(sql, id, ['succeeded'], 15_000)
    expect(run.output).toBeNull()
    expect(Date.now() - t0).toBeGreaterThanOrEqual(1900)
    const steps = await getSteps(sql, id)
    expect(steps.find((s) => s.key === 'never')!.meta).toMatchObject({ timedOut: true })
  })
})

describe('retries and failure handling', () => {
  it('retries transient step errors in-process, then succeeds', async () => {
    let n = 0
    const agent = defineAgent({
      name: 'flaky',
      async run(ctx) {
        return ctx.step('call', async () => {
          if (++n < 3) throw new Error('503')
          return 'ok'
        })
      },
    })
    await startWorker(reg(agent as never))
    const id = await start('flaky')
    await waitForStatus(sql, id, ['succeeded'])
    expect((await getSteps(sql, id))[0]!.attempts).toBe(3)
  })

  it('reschedules the whole run with backoff and keeps completed steps', async () => {
    let failures = 0
    let expensive = 0
    const agent = defineAgent({
      name: 'outage',
      async run(ctx) {
        await ctx.step('expensive', async () => ++expensive)
        await ctx.step(
          'downstream',
          async () => {
            if (failures++ < 4) throw new Error('downstream down')
            return 'up'
          },
          { retries: 0 },
        )
        return 'done'
      },
    })
    await startWorker(reg(agent as never))
    const id = await start('outage')
    const run = await waitForStatus(sql, id, ['succeeded'], 15_000)
    expect(run.attempts).toBe(5)
    expect(expensive).toBe(1)
  })

  it('fails fast on non-retryable errors', async () => {
    const agent = defineAgent({
      name: 'bad-input',
      async run() {
        throw new NonRetryableError('order not found')
      },
    })
    await startWorker(reg(agent as never))
    const id = await start('bad-input')
    const run = await waitForStatus(sql, id, ['failed'])
    expect(run).toMatchObject({ attempts: 1, errorCode: 'non_retryable' })
  })

  it('repairs invalid structured LLM output', async () => {
    const llm = new FakeLlm((_req, n) => (n === 1 ? '{"amount": "lots"}' : '{"amount": 42}'))
    const agent = defineAgent({
      name: 'structured',
      async run(ctx) {
        return ctx.llm('extract', {
          schema: z.object({ amount: z.number() }),
          messages: [{ role: 'user', content: 'how much?' }],
        })
      },
    })
    await startWorker(reg(agent as never), llm)
    const id = await start('structured')
    const run = await waitForStatus(sql, id, ['succeeded'])
    expect(run.output).toEqual({ amount: 42 })
    expect(llm.calls).toBe(2)
    expect(llm.requests[1]!.messages.at(-1)!.content).toContain('amount')
    expect((await getSteps(sql, id))[0]!.meta).toMatchObject({ repairs: 1, inputTokens: 20 })
  })

  it('rejects duplicate step keys in one run', async () => {
    const agent = defineAgent({
      name: 'dupe',
      async run(ctx) {
        await ctx.step('x', async () => 1)
        await ctx.step('x', async () => 2)
      },
    })
    await startWorker(reg(agent as never))
    const run = await waitForStatus(sql, await start('dupe'), ['failed'])
    expect(run.error).toContain('duplicate step key')
  })
})

describe('idempotent run creation', () => {
  it('returns the original run for a repeated key and rejects a mismatched one', async () => {
    const a = await createRun(sql, { agent: 'x', input: { n: 1 }, idempotencyKey: 'k' })
    const b = await createRun(sql, { agent: 'x', input: { n: 1 }, idempotencyKey: 'k' })
    const c = await createRun(sql, { agent: 'x', input: { n: 2 }, idempotencyKey: 'k' })
    expect(a.kind).toBe('created')
    expect(b).toMatchObject({ kind: 'existing', run: { id: a.run.id } })
    expect(c.kind).toBe('conflict')
  })
})
