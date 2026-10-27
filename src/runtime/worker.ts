import { hostname } from 'node:os'
import type { Config } from '../config.ts'
import type { Sql } from '../db/index.ts'
import type { LlmProvider } from '../llm/types.ts'
import type { Logger } from '../logger.ts'
import * as metrics from '../metrics.ts'
import { backoffMs } from './backoff.ts'
import { type ContextDeps, DurableContext, NaiveContext } from './context.ts'
import { errorCode, isRetryable, LeaseLost, Suspend, UnknownAgentError } from './errors.ts'
import {
  appendLog,
  claimRuns,
  completeRun,
  failRun,
  getSteps,
  heartbeat,
  type Lease,
  RUN_CHANNEL,
  type Run,
  reapExpiredLeases,
  recordReplays,
  retryRunLater,
  suspendRun,
  wakeDueRuns,
} from './store.ts'
import type { AgentDefinition } from './types.ts'

export type AgentRegistry = Map<string, AgentDefinition<never, unknown>>

export function registry(...agents: AgentDefinition<never, unknown>[]): AgentRegistry {
  return new Map(agents.map((a) => [a.name, a]))
}

/**
 * Worker loop. Any number of these run against one Postgres:
 *
 *   wake (NOTIFY / poll) -> claim due runs (SKIP LOCKED + lease) -> load journal
 *   -> execute agent (completed steps replay instantly) -> heartbeat the lease meanwhile
 *   -> succeed | suspend (sleep / wait for event) | retry with backoff | fail
 */
export class Worker {
  readonly id = `${hostname()}:${process.pid}:${Math.random().toString(36).slice(2, 6)}`
  readonly #sql: Sql
  readonly #cfg: Config
  readonly #log: Logger
  readonly #agents: AgentRegistry
  readonly #llm: LlmProvider
  readonly #active = new Map<string, AbortController>()
  #running = false
  #wake: (() => void) | null = null
  #poked = false
  #timer: NodeJS.Timeout | undefined
  #unlisten: (() => Promise<void>) | undefined
  #drained: (() => void) | null = null
  #ticks = 0

  constructor(sql: Sql, cfg: Config, log: Logger, agents: AgentRegistry, llm: LlmProvider) {
    this.#sql = sql
    this.#cfg = cfg
    this.#log = log.child({ worker: this.id, mode: cfg.EXECUTION_MODE })
    this.#agents = agents
    this.#llm = llm
  }

  get inFlight(): number {
    return this.#active.size
  }

  async start(): Promise<void> {
    this.#running = true
    const listener = await this.#sql.listen(RUN_CHANNEL, () => this.#poke())
    this.#unlisten = listener.unlisten
    this.#timer = setInterval(() => void this.#maintenance(), 1000)
    this.#timer.unref()
    this.#log.info(
      {
        concurrency: this.#cfg.WORKER_CONCURRENCY,
        agents: [...this.#agents.keys()],
        llm: this.#llm.name,
      },
      'worker started',
    )
    void this.#loop()
  }

  /** Graceful shutdown: stop claiming and let in-flight executions finish or suspend. */
  async stop(graceMs = 25_000): Promise<void> {
    if (!this.#running) return
    this.#running = false
    this.#poke()
    clearInterval(this.#timer)
    await this.#unlisten?.().catch(() => {})
    if (this.#active.size > 0) {
      this.#log.info({ inFlight: this.#active.size }, 'draining')
      const drained = new Promise<void>((r) => {
        this.#drained = r
      })
      const timeout = new Promise<void>((r) => setTimeout(r, graceMs).unref())
      await Promise.race([drained, timeout])
      // Anything still running is abandoned; its lease expires and another worker resumes it.
      for (const c of this.#active.values()) c.abort()
    }
    this.#log.info('worker stopped')
  }

  #poke(): void {
    const wake = this.#wake
    this.#wake = null
    if (wake) wake()
    else this.#poked = true
  }

  async #idle(ms: number): Promise<void> {
    if (this.#poked) {
      this.#poked = false
      return
    }
    await new Promise<void>((resolve) => {
      const t = setTimeout(() => {
        this.#wake = null
        resolve()
      }, ms)
      this.#wake = () => {
        clearTimeout(t)
        resolve()
      }
    })
  }

  async #loop(): Promise<void> {
    while (this.#running) {
      const free = this.#cfg.WORKER_CONCURRENCY - this.#active.size
      if (free <= 0) {
        await this.#idle(this.#cfg.POLL_INTERVAL_MS)
        continue
      }
      let claimed: Run[] = []
      try {
        claimed = await claimRuns(this.#sql, this.id, free, this.#cfg.LEASE_MS)
      } catch (err) {
        this.#log.error({ err }, 'claim failed; backing off')
        await this.#idle(this.#cfg.POLL_INTERVAL_MS)
        continue
      }
      for (const run of claimed) void this.#execute(run)
      if (claimed.length < free) await this.#idle(this.#cfg.POLL_INTERVAL_MS)
    }
  }

  async #execute(run: Run): Promise<void> {
    const cfg = this.#cfg
    const lease: Lease = { runId: run.id, token: run.leaseToken!, workerId: this.id }
    const controller = new AbortController()
    this.#active.set(run.id, controller)
    const started = performance.now()
    const resumed = run.attempts > 1
    metrics.executions.inc({ agent: run.agent, resumed: String(resumed) })
    const log = this.#log.child({ run: run.id, agent: run.agent, attempt: run.attempts })

    // Heartbeat: keep the lease alive while a long LLM call or tool runs. If we can't renew
    // (we were partitioned, paused, or the run was cancelled) abort the agent at once.
    let failures = 0
    const beat = setInterval(
      async () => {
        try {
          if (!(await heartbeat(this.#sql, lease, cfg.LEASE_MS))) controller.abort()
          failures = 0
        } catch (err) {
          if (++failures >= 2) controller.abort()
          log.warn({ err }, 'heartbeat failed')
        }
      },
      Math.max(250, Math.floor(cfg.LEASE_MS / 3)),
    )

    let ctx: DurableContext | NaiveContext | undefined
    const outcome = (o: string) => metrics.outcomes.inc({ agent: run.agent, outcome: o })
    try {
      const agent = this.#agents.get(run.agent)
      if (!agent) throw new UnknownAgentError(`no agent named "${run.agent}" is registered`)

      const deps: ContextDeps = {
        sql: this.#sql,
        lease,
        attempt: run.attempts,
        journal: cfg.EXECUTION_MODE === 'durable' ? await getSteps(this.#sql, run.id) : [],
        llm: this.#llm,
        signal: controller.signal,
        log: (m) => log.info(m),
        chaosKillAfterEffect: cfg.CHAOS_KILL_AFTER_EFFECT,
        onLlmCall: (m) => {
          metrics.llmCalls.inc()
          metrics.llmTokens.inc({ direction: 'input' }, m.inputTokens)
          metrics.llmTokens.inc({ direction: 'output' }, m.outputTokens)
        },
      }
      ctx = cfg.EXECUTION_MODE === 'durable' ? new DurableContext(deps) : new NaiveContext(deps)

      const output = await agent.run(ctx, run.input as never)
      await this.#flushReplays(ctx, run.id)
      const ok = await completeRun(this.#sql, lease, output, summary(ctx, 'succeeded'))
      if (!ok) throw new LeaseLost()
      outcome('succeeded')
    } catch (err) {
      if (ctx) await this.#flushReplays(ctx, run.id).catch(() => {})
      await this.#handleError(run, lease, err, log)
      if (err instanceof Suspend) outcome('suspended')
      else if (err instanceof LeaseLost) outcome('lease_lost')
      else outcome('error')
    } finally {
      clearInterval(beat)
      metrics.executionDuration.observe((performance.now() - started) / 1000)
      this.#active.delete(run.id)
      if (this.#active.size === 0) this.#drained?.()
      this.#poke()
    }
  }

  async #flushReplays(ctx: DurableContext | NaiveContext, runId: string): Promise<void> {
    if (ctx.replayed.length === 0 || ctx.replayedFlushed) return
    ctx.replayedFlushed = true
    metrics.replayedSteps.inc(ctx.replayed.length)
    await recordReplays(this.#sql, runId, ctx.replayed)
    await appendLog(
      this.#sql,
      runId,
      'replayed',
      `replayed ${ctx.replayed.length} completed step(s) from the journal instead of re-running them: ${ctx.replayed.join(', ')}`,
      this.id,
    )
  }

  async #handleError(run: Run, lease: Lease, err: unknown, log: Logger): Promise<void> {
    const cfg = this.#cfg
    try {
      if (err instanceof Suspend) {
        const what = err.eventName
          ? `waiting for event "${err.eventName}"${err.until ? ` until ${err.until.toISOString()}` : ''}`
          : `sleeping until ${err.until?.toISOString()}`
        await suspendRun(this.#sql, lease, err.until, err.eventName, what)
        return
      }
      if (err instanceof LeaseLost) {
        metrics.leasesLost.inc()
        log.warn('lease lost; another worker owns this run now — stopping without writing')
        return
      }
      const message = err instanceof Error ? err.message : String(err)
      if (isRetryable(err) && run.attempts < cfg.RUN_MAX_ATTEMPTS) {
        const delay = backoffMs(run.attempts, cfg.RETRY_BASE_MS, cfg.RETRY_MAX_MS)
        await retryRunLater(this.#sql, lease, message, delay)
        log.warn({ err: message, delay }, 'execution failed; retry scheduled')
      } else {
        await failRun(this.#sql, lease, message, isRetryable(err) ? 'max_attempts' : errorCode(err))
        log.error({ err: message }, 'run failed')
      }
    } catch (writeErr) {
      // Couldn't record the outcome. The lease will expire and the run will be resumed.
      log.error({ err: writeErr }, 'failed to record execution outcome')
    }
  }

  async #maintenance(): Promise<void> {
    this.#ticks++
    try {
      await wakeDueRuns(this.#sql)
      if (
        this.#ticks % Math.max(1, Math.floor(Math.min(5_000, this.#cfg.LEASE_MS / 2) / 1000)) ===
        0
      ) {
        const n = await reapExpiredLeases(this.#sql, this.#cfg.RUN_MAX_ATTEMPTS)
        if (n > 0) {
          metrics.leasesReaped.inc(n)
          this.#log.warn({ count: n }, 'recovered runs from crashed workers')
        }
      }
    } catch (err) {
      this.#log.error({ err }, 'maintenance tick failed')
    }
  }
}

function summary(ctx: DurableContext | NaiveContext, verb: string): string {
  return ctx.replayed.length > 0
    ? `${verb} on execution #${ctx.attempt} (resumed: ${ctx.replayed.length} step(s) replayed, not repeated)`
    : `${verb} on execution #${ctx.attempt}`
}
