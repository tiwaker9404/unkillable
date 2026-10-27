import client from '@prometheus-io/client'
import type { Sql } from './db/index.ts'

export const registry = new client.Registry()
client.collectDefaultMetrics({ register: registry, prefix: 'unkillable_' })

export const executions = new client.Counter({
  name: 'unkillable_executions_total',
  help: 'Agent executions started (a resumed run is a new execution)',
  labelNames: ['agent', 'resumed'],
  registers: [registry],
})

export const outcomes = new client.Counter({
  name: 'unkillable_execution_outcomes_total',
  help: 'How executions ended',
  labelNames: ['agent', 'outcome'],
  registers: [registry],
})

export const replayedSteps = new client.Counter({
  name: 'unkillable_replayed_steps_total',
  help: 'Completed steps served from the journal instead of re-executed',
  registers: [registry],
})

export const llmCalls = new client.Counter({
  name: 'unkillable_llm_calls_total',
  help: 'LLM API calls actually made',
  registers: [registry],
})

export const llmTokens = new client.Counter({
  name: 'unkillable_llm_tokens_total',
  help: 'LLM tokens actually billed',
  labelNames: ['direction'],
  registers: [registry],
})

export const leasesReaped = new client.Counter({
  name: 'unkillable_leases_reaped_total',
  help: 'Runs recovered after their worker disappeared',
  registers: [registry],
})

export const leasesLost = new client.Counter({
  name: 'unkillable_leases_lost_total',
  help: 'Executions aborted because another worker took over the run',
  registers: [registry],
})

export const executionDuration = new client.Histogram({
  name: 'unkillable_execution_duration_seconds',
  help: 'Wall time of one execution (until it finished, suspended or failed)',
  buckets: [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 300],
  registers: [registry],
})

/** Read from Postgres at scrape time so every replica reports the same truth. */
export function registerQueueGauges(sql: Sql): void {
  new client.Gauge({
    name: 'unkillable_runs',
    help: 'Runs by status',
    labelNames: ['status'],
    registers: [registry],
    async collect() {
      const rows = await sql<{ status: string; n: number }[]>`
        select status, count(*)::int as n from runs group by status`
      this.reset()
      for (const r of rows) this.set({ status: r.status }, r.n)
    },
  })
  new client.Gauge({
    name: 'unkillable_queue_lag_seconds',
    help: 'Age of the oldest due-but-unclaimed run',
    registers: [registry],
    async collect() {
      const [row] = await sql<{ s: number | null }[]>`
        select coalesce(extract(epoch from now() - min(next_run_at)), 0)::float8 as s
        from runs where status = 'queued' and next_run_at <= now()`
      this.set(Math.max(0, row?.s ?? 0))
    },
  })
}
