import { setTimeout as sleep } from 'node:timers/promises'
import { type Config, loadConfig } from '../../src/config.ts'
import { connect, migrate, type Sql } from '../../src/db/index.ts'
import type { LlmProvider, LlmRequest, LlmResponse } from '../../src/llm/types.ts'
import { createLogger } from '../../src/logger.ts'
import { type Run, type RunStatus, getRun } from '../../src/runtime/store.ts'

export const TEST_DB = process.env.TEST_DATABASE_URL!
export const log = createLogger('silent', 'test')

export function testConfig(overrides: Partial<Record<keyof Config, string>> = {}): Config {
  return loadConfig({
    DATABASE_URL: TEST_DB,
    LOG_LEVEL: 'silent',
    LEASE_MS: '2000',
    POLL_INTERVAL_MS: '100',
    RETRY_BASE_MS: '100',
    RETRY_MAX_MS: '400',
    RUN_MAX_ATTEMPTS: '5',
    WORKER_CONCURRENCY: '8',
    ...overrides,
  })
}

/** Fresh schema per test file: drop everything and re-run migrations. */
export async function freshDb(): Promise<Sql> {
  const sql = connect(TEST_DB, 10)
  await sql.unsafe('drop schema if exists public cascade; create schema public;')
  await migrate(sql)
  return sql
}

export async function waitForStatus(
  sql: Sql,
  id: string,
  statuses: RunStatus[],
  timeoutMs = 10_000,
): Promise<Run> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const run = await getRun(sql, id)
    if (run && statuses.includes(run.status)) return run
    if (Date.now() > deadline) {
      throw new Error(`run ${id} still ${run?.status} (${run?.error ?? ''}) after ${timeoutMs}ms`)
    }
    await sleep(50)
  }
}

/** LLM fake: returns queued responses (or a function's), counts calls. */
export class FakeLlm implements LlmProvider {
  readonly name = 'fake'
  calls = 0
  readonly requests: LlmRequest[] = []
  readonly #respond: (req: LlmRequest, n: number) => string
  constructor(respond: (req: LlmRequest, n: number) => string) {
    this.#respond = respond
  }
  async complete(req: LlmRequest): Promise<LlmResponse> {
    this.calls++
    this.requests.push(req)
    await sleep(5)
    const text = this.#respond(req, this.calls)
    return { text, model: 'fake', inputTokens: 10, outputTokens: 5, latencyMs: 5 }
  }
}

/** A downstream with Stripe-style idempotency, counting what actually happened. */
export class FakePayments {
  applied = 0
  deduped = 0
  readonly #seen = new Map<string, { id: string }>()
  charge(key: string | undefined): { id: string } {
    if (key && this.#seen.has(key)) {
      this.deduped++
      return this.#seen.get(key)!
    }
    this.applied++
    const res = { id: `ch_${this.applied}` }
    if (key) this.#seen.set(key, res)
    return res
  }
}

export async function waitUntil(cond: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('condition not met in time')
    await sleep(10)
  }
}
