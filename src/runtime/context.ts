import { randomUUID } from 'node:crypto'
import { setTimeout as sleep } from 'node:timers/promises'
import type { ZodType } from 'zod'
import type { Sql } from '../db/index.ts'
import type { ChatMessage, LlmProvider } from '../llm/types.ts'
import { backoffMs } from './backoff.ts'
import {
  AmbiguousEffectError,
  LeaseLost,
  NonDeterminismError,
  NonRetryableError,
  Suspend,
} from './errors.ts'
import {
  consumeEvent,
  type Lease,
  type StepRow,
  type StepWrite,
  takeEventUnjournaled,
  writeStep,
} from './store.ts'
import type {
  AgentContext,
  EventResult,
  LlmOptions,
  StepKind,
  StepOptions,
  ToolOptions,
} from './types.ts'

export interface ContextDeps {
  sql: Sql
  lease: Lease
  attempt: number
  journal: StepRow[]
  llm: LlmProvider
  signal: AbortSignal
  log: (message: string) => void
  /** chaos testing: probability to SIGKILL this process right after a side effect */
  chaosKillAfterEffect?: number
  onLlmCall?: (meta: LlmMeta) => void
}

export interface LlmMeta {
  model: string
  inputTokens: number
  outputTokens: number
  latencyMs: number
  repairs: number
}

const MAX_REPAIRS = 2

/** JSON round-trip so a first execution sees exactly what a replay will see (Dates -> strings...). */
function normalize<T>(value: T): T {
  return value === undefined ? (null as T) : (JSON.parse(JSON.stringify(value)) as T)
}

function isControlFlow(err: unknown): boolean {
  return err instanceof Suspend || err instanceof LeaseLost || err instanceof NonRetryableError
}

/**
 * The durable execution context. Every step is journaled in Postgres; when a run is
 * re-executed after a crash, completed steps return their recorded result instantly
 * (no LLM re-billing, no repeated side effects) and execution continues from the first
 * step that never finished.
 */
export class DurableContext implements AgentContext {
  readonly runId: string
  readonly attempt: number
  readonly signal: AbortSignal
  /** keys of completed steps that were served from the journal in this execution */
  readonly replayed: string[] = []
  replayedFlushed = false

  readonly #d: ContextDeps
  readonly #byKey: Map<string, StepRow>
  readonly #bySeq: Map<number, StepRow>
  readonly #seen = new Set<string>()
  #seq = 0

  constructor(deps: ContextDeps) {
    this.#d = deps
    this.runId = deps.lease.runId
    this.attempt = deps.attempt
    this.signal = deps.signal
    this.#byKey = new Map(deps.journal.map((s) => [s.key, s]))
    this.#bySeq = new Map(deps.journal.map((s) => [s.seq, s]))
  }

  log(message: string): void {
    this.#d.log(message)
  }

  /* -------------------------------------------------------------- plumbing */

  #next(key: string, kind: StepKind): { seq: number; existing: StepRow | undefined } {
    if (this.#seen.has(key)) throw new NonRetryableError(`duplicate step key "${key}" in one run`)
    this.#seen.add(key)
    const seq = this.#seq++
    const existing = this.#byKey.get(key)
    const atSeq = this.#bySeq.get(seq)
    if (atSeq && atSeq.key !== key) {
      throw new NonDeterminismError(
        `step #${seq} was "${atSeq.key}" in a previous execution but is now "${key}". ` +
          'The agent took a different path on replay (code changed, or it branched on time/randomness outside a step).',
      )
    }
    if (existing && existing.kind !== kind) {
      throw new NonDeterminismError(
        `step "${key}" was a ${existing.kind} step and is now a ${kind} step`,
      )
    }
    return { seq, existing }
  }

  #replay<T>(s: StepRow): T {
    this.replayed.push(s.key)
    return s.output as T
  }

  async #write(s: StepWrite): Promise<void> {
    if (!(await writeStep(this.#d.sql, this.#d.lease, s))) throw new LeaseLost()
  }

  #checkLease(): void {
    if (this.signal.aborted) throw new LeaseLost()
  }

  /** Run fn with in-process retries, then journal the result. */
  async #execute<T>(
    key: string,
    seq: number,
    kind: StepKind,
    retries: number,
    fn: () => Promise<T>,
    meta: () => Record<string, unknown> = () => ({}),
    recordFailure = true,
  ): Promise<T> {
    const startedAt = new Date()
    let attempts = 0
    for (;;) {
      this.#checkLease()
      attempts++
      try {
        const out = normalize(await fn())
        this.#checkLease()
        await this.#write({
          key,
          seq,
          kind,
          status: 'completed',
          output: out,
          attempts,
          meta: meta(),
          startedAt,
          completedAt: new Date(),
          durationMs: Date.now() - startedAt.getTime(),
        })
        return out
      } catch (err) {
        if (isControlFlow(err) || attempts > retries) {
          if (!isControlFlow(err) && recordFailure) {
            // best effort: record the failure so it shows on the timeline
            await writeStep(this.#d.sql, this.#d.lease, {
              key,
              seq,
              kind,
              status: 'failed',
              error: err instanceof Error ? err.message : String(err),
              attempts,
              meta: meta(),
              startedAt,
              durationMs: Date.now() - startedAt.getTime(),
            }).catch(() => {})
          }
          throw err
        }
        this.log(`step "${key}" failed (attempt ${attempts}/${retries + 1}): ${String(err)}`)
        await sleep(backoffMs(attempts, 200, 5_000), undefined, { signal: this.signal }).catch(
          () => {},
        )
      }
    }
  }

  /* ------------------------------------------------------------ public API */

  async step<T>(key: string, fn: () => Promise<T>, opts: StepOptions = {}): Promise<T> {
    const { seq, existing } = this.#next(key, 'step')
    if (existing?.status === 'completed') return this.#replay<T>(existing)
    return this.#execute(key, seq, 'step', opts.retries ?? 2, fn)
  }

  llm(key: string, opts: LlmOptions<undefined> & { schema?: undefined }): Promise<string>
  llm<T>(key: string, opts: LlmOptions<T> & { schema: ZodType<T> }): Promise<T>
  async llm<T>(key: string, opts: LlmOptions<T>): Promise<T | string> {
    const { seq, existing } = this.#next(key, 'llm')
    if (existing?.status === 'completed') return this.#replay<{ value: T | string }>(existing).value

    let meta: LlmMeta = { model: '', inputTokens: 0, outputTokens: 0, latencyMs: 0, repairs: 0 }
    const result = await this.#execute(
      key,
      seq,
      'llm',
      2,
      async () => {
        const out = await callModel(this.#d.llm, opts, this.signal)
        meta = out.meta
        this.#d.onLlmCall?.(meta)
        return { value: out.value }
      },
      () => ({ ...meta }),
    )
    return result.value
  }

  async tool<T>(
    key: string,
    fn: (idempotencyKey: string) => Promise<T>,
    opts: ToolOptions = {},
  ): Promise<T> {
    const { seq, existing } = this.#next(key, 'tool')
    if (existing?.status === 'completed') return this.#replay<T>(existing)

    const mode = opts.mode ?? 'idempotent'
    // Stable across every re-execution of this run: the whole trick behind exactly-once.
    const idempotencyKey = `unk_${this.runId}_${key}`.replace(/[^A-Za-z0-9_\-:.]/g, '_')
    const meta = { mode, idempotencyKey }

    if (mode === 'at-most-once') {
      if (existing?.status === 'started') {
        throw new AmbiguousEffectError(
          `"${key}" started before a crash and its outcome is unknown; the downstream has no ` +
            'idempotency support, so retrying could duplicate it. Resolve it and retry the run.',
        )
      }
      await this.#write({ key, seq, kind: 'tool', status: 'started', meta, startedAt: new Date() })
    }

    const run = async () => {
      const out = await fn(idempotencyKey)
      this.#maybeCrash(key)
      return out
    }
    if (mode === 'idempotent') {
      return this.#execute(key, seq, 'tool', opts.retries ?? 2, run, () => meta)
    }
    try {
      // no retries, and the 'started' marker stays put on failure: an error (a timeout, a
      // dropped connection) does not prove the effect didn't happen
      return await this.#execute(key, seq, 'tool', 0, run, () => meta, false)
    } catch (err) {
      if (isControlFlow(err)) throw err
      throw new AmbiguousEffectError(
        `"${key}" failed with "${err instanceof Error ? err.message : String(err)}" and the ` +
          'downstream has no idempotency support, so it may or may not have happened. Resolve it and retry the run.',
      )
    }
  }

  async sleep(key: string, ms: number): Promise<void> {
    const { seq, existing } = this.#next(key, 'sleep')
    if (existing?.status === 'completed') return void this.#replay(existing)
    const until = existing ? new Date(String(existing.meta.until)) : new Date(Date.now() + ms)
    const startedAt = existing?.startedAt ?? new Date()
    if (!existing) {
      await this.#write({
        key,
        seq,
        kind: 'sleep',
        status: 'started',
        meta: { until: until.toISOString() },
        startedAt,
      })
    }
    if (Date.now() >= until.getTime()) {
      await this.#write({
        key,
        seq,
        kind: 'sleep',
        status: 'completed',
        output: null,
        startedAt,
        completedAt: new Date(),
      })
      return
    }
    throw new Suspend({ until, eventName: null })
  }

  async waitForEvent<T = unknown>(
    key: string,
    eventName: string,
    opts: { timeoutMs: number },
  ): Promise<EventResult<T> | null> {
    const { seq, existing } = this.#next(key, 'event')
    if (existing?.status === 'completed') return this.#replay<EventResult<T> | null>(existing)
    const until = existing
      ? new Date(String(existing.meta.until))
      : new Date(Date.now() + opts.timeoutMs)
    const startedAt = existing?.startedAt ?? new Date()
    const meta = { until: until.toISOString(), event: eventName }
    if (!existing)
      await this.#write({ key, seq, kind: 'event', status: 'started', meta, startedAt })

    const res = await consumeEvent(
      this.#d.sql,
      this.#d.lease,
      { key, seq, kind: 'event', meta, startedAt },
      eventName,
    )
    if ('fenced' in res) throw new LeaseLost()
    if (res.found) return { payload: res.payload as T }
    if (Date.now() >= until.getTime()) {
      await this.#write({
        key,
        seq,
        kind: 'event',
        status: 'completed',
        output: null,
        meta: { ...meta, timedOut: true },
        startedAt,
        completedAt: new Date(),
      })
      return null
    }
    throw new Suspend({ until, eventName })
  }

  #maybeCrash(key: string): void {
    const p = this.#d.chaosKillAfterEffect ?? 0
    if (p > 0 && Math.random() < p) {
      // The worst possible moment: the side effect happened, the journal doesn't know yet.
      process.stderr.write(`[chaos] SIGKILL after side effect "${key}" in ${this.runId}\n`)
      process.kill(process.pid, 'SIGKILL')
    }
  }
}

/**
 * Baseline for comparison: how most agent code runs today. Nothing is journaled, so a
 * re-executed run starts from scratch: every LLM call is paid again and every side effect
 * is attempted again with a fresh idempotency key (equivalent to having none).
 */
export class NaiveContext implements AgentContext {
  readonly runId: string
  readonly attempt: number
  readonly signal: AbortSignal
  readonly replayed: string[] = []
  replayedFlushed = false
  readonly #d: ContextDeps

  constructor(deps: ContextDeps) {
    this.#d = deps
    this.runId = deps.lease.runId
    this.attempt = deps.attempt
    this.signal = deps.signal
  }

  log(message: string): void {
    this.#d.log(message)
  }

  async step<T>(_key: string, fn: () => Promise<T>): Promise<T> {
    return normalize(await fn())
  }

  llm(key: string, opts: LlmOptions<undefined> & { schema?: undefined }): Promise<string>
  llm<T>(key: string, opts: LlmOptions<T> & { schema: ZodType<T> }): Promise<T>
  async llm<T>(_key: string, opts: LlmOptions<T>): Promise<T | string> {
    const out = await callModel(this.#d.llm, opts, this.signal)
    this.#d.onLlmCall?.(out.meta)
    return normalize(out.value)
  }

  async tool<T>(key: string, fn: (idempotencyKey: string) => Promise<T>): Promise<T> {
    const out = await fn(randomUUID())
    const p = this.#d.chaosKillAfterEffect ?? 0
    if (p > 0 && Math.random() < p) {
      process.stderr.write(`[chaos] SIGKILL after side effect "${key}" in ${this.runId}\n`)
      process.kill(process.pid, 'SIGKILL')
    }
    return normalize(out)
  }

  async sleep(_key: string, ms: number): Promise<void> {
    await sleep(ms, undefined, { signal: this.signal })
  }

  async waitForEvent<T = unknown>(
    _key: string,
    eventName: string,
    opts: { timeoutMs: number },
  ): Promise<EventResult<T> | null> {
    // blocks a worker slot while polling: the other cost of not having durable waits
    const deadline = Date.now() + opts.timeoutMs
    while (Date.now() < deadline) {
      if (this.signal.aborted) throw new LeaseLost()
      const ev = await takeEventUnjournaled(this.#d.sql, this.runId, eventName)
      if (ev) return { payload: ev.payload as T }
      await sleep(250)
    }
    return null
  }
}

/* --------------------------------------------------------- LLM w/ repair loop */

async function callModel<T>(
  provider: LlmProvider,
  opts: LlmOptions<T>,
  signal: AbortSignal,
): Promise<{ value: T | string; meta: LlmMeta }> {
  const messages: ChatMessage[] = [...opts.messages]
  const meta: LlmMeta = { model: '', inputTokens: 0, outputTokens: 0, latencyMs: 0, repairs: 0 }
  for (let repair = 0; ; repair++) {
    const res = await provider.complete({
      messages,
      json: Boolean(opts.schema),
      temperature: opts.temperature ?? 0,
      signal,
    })
    meta.model = res.model
    meta.inputTokens += res.inputTokens
    meta.outputTokens += res.outputTokens
    meta.latencyMs += res.latencyMs
    meta.repairs = repair
    if (!opts.schema) return { value: res.text, meta }

    const problem = validate(opts.schema, res.text)
    if (problem.ok) return { value: problem.value, meta }
    if (repair >= MAX_REPAIRS) {
      throw new Error(
        `model output failed validation after ${MAX_REPAIRS} repairs: ${problem.error}`,
      )
    }
    // structured-output repair: show the model its mistake and ask for corrected JSON
    messages.push(
      { role: 'assistant', content: res.text },
      {
        role: 'user',
        content: `That response was invalid: ${problem.error}. Reply with only the corrected JSON object.`,
      },
    )
  }
}

function validate<T>(
  schema: ZodType<T>,
  text: string,
): { ok: true; value: T } | { ok: false; error: string } {
  let json: unknown
  try {
    const trimmed = text.trim().replace(/^```(?:json)?\s*|\s*```$/g, '')
    json = JSON.parse(trimmed)
  } catch {
    return { ok: false, error: 'not valid JSON' }
  }
  const parsed = schema.safeParse(json)
  if (parsed.success) return { ok: true, value: parsed.data }
  return {
    ok: false,
    error: parsed.error.issues
      .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('; '),
  }
}
