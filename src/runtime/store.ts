import type { Sql } from '../db/index.ts'
import { newId } from '../ids.ts'
import type { StepKind } from './types.ts'

export const RUN_CHANNEL = 'unkillable_runs'

export type RunStatus = 'queued' | 'running' | 'waiting' | 'succeeded' | 'failed' | 'cancelled'

export interface Run {
  id: string
  agent: string
  input: unknown
  status: RunStatus
  output: unknown
  error: string | null
  errorCode: string | null
  idempotencyKey: string | null
  attempts: number
  nextRunAt: Date
  leaseToken: string | null
  leaseExpiresAt: Date | null
  workerId: string | null
  waitEvent: string | null
  waitUntil: Date | null
  createdAt: Date
  updatedAt: Date
  completedAt: Date | null
}

export interface StepRow {
  runId: string
  key: string
  seq: number
  kind: StepKind
  status: 'started' | 'completed' | 'failed'
  output: unknown
  error: string | null
  attempts: number
  replays: number
  meta: Record<string, unknown>
  startedAt: Date
  completedAt: Date | null
  durationMs: number | null
}

export interface LogRow {
  id: string
  runId: string
  at: Date
  kind: string
  message: string
  workerId: string | null
}

/** The lease a worker holds on a run. Every write it makes is fenced by this token. */
export interface Lease {
  runId: string
  token: string
  workerId: string
}

/* ------------------------------------------------------------ run lifecycle */

export type CreateRunResult =
  | { kind: 'created'; run: Run }
  | { kind: 'existing'; run: Run }
  | { kind: 'conflict'; run: Run }

export async function createRun(
  sql: Sql,
  input: { agent: string; input: unknown; idempotencyKey?: string | undefined },
): Promise<CreateRunResult> {
  return sql.begin(async (tx) => {
    const id = newId('run')
    const [run] = await tx<Run[]>`
      insert into runs (id, agent, input, idempotency_key)
      values (${id}, ${input.agent}, ${tx.json(input.input as never)}, ${input.idempotencyKey ?? null})
      on conflict (idempotency_key) do nothing
      returning *`
    if (run) {
      await tx`insert into run_log (run_id, kind, message) values (${id}, 'queued', 'run created')`
      await tx`select pg_notify(${RUN_CHANNEL}, '')`
      return { kind: 'created', run }
    }
    // Same idempotency key again: same request -> the original run; different request -> conflict.
    const [existing] = await tx<(Run & { same: boolean })[]>`
      select *, (agent = ${input.agent} and input = ${tx.json(input.input as never)}) as same
      from runs where idempotency_key = ${input.idempotencyKey!}`
    const { same, ...rest } = existing!
    return { kind: same ? 'existing' : 'conflict', run: rest }
  })
}

export async function getRun(sql: Sql, id: string): Promise<Run | undefined> {
  const [row] = await sql<Run[]>`select * from runs where id = ${id}`
  return row
}

export async function listRuns(
  sql: Sql,
  opts: {
    limit: number
    before?: string | undefined
    status?: RunStatus | undefined
    agent?: string | undefined
  },
) {
  return sql<(Run & { steps: number; replayed: number })[]>`
    select r.*,
      (select count(*)::int from steps s where s.run_id = r.id) as steps,
      (select coalesce(sum(s.replays), 0)::int from steps s where s.run_id = r.id) as replayed
    from runs r
    where true
      ${opts.before ? sql`and r.id < ${opts.before}` : sql``}
      ${opts.status ? sql`and r.status = ${opts.status}` : sql``}
      ${opts.agent ? sql`and r.agent = ${opts.agent}` : sql``}
    order by r.id desc
    limit ${opts.limit}`
}

export async function getSteps(sql: Sql, runId: string): Promise<StepRow[]> {
  return sql<StepRow[]>`select * from steps where run_id = ${runId} order by seq`
}

export async function getLog(sql: Sql, runId: string): Promise<LogRow[]> {
  return sql<LogRow[]>`select * from run_log where run_id = ${runId} order by id`
}

export async function appendLog(
  sql: Sql,
  runId: string,
  kind: string,
  message: string,
  workerId: string | null = null,
) {
  await sql`insert into run_log (run_id, kind, message, worker_id)
            values (${runId}, ${kind}, ${message}, ${workerId})`
}

/* ------------------------------------------------------------------- queue */

/**
 * Claim due runs. FOR UPDATE SKIP LOCKED lets any number of workers share the table without
 * blocking or double-claiming; each claim mints a new lease token that fences all writes.
 */
export async function claimRuns(
  sql: Sql,
  workerId: string,
  limit: number,
  leaseMs: number,
): Promise<(Run & { leaseToken: string })[]> {
  const rows = await sql<(Run & { leaseToken: string })[]>`
    with ready as (
      select id from runs
      where status = 'queued' and next_run_at <= now()
      order by next_run_at
      limit ${limit}
      for update skip locked
    )
    update runs r set
      status = 'running',
      attempts = r.attempts + 1,
      lease_token = gen_random_uuid(),
      lease_expires_at = now() + make_interval(secs => ${leaseMs / 1000}),
      worker_id = ${workerId},
      updated_at = now()
    from ready where r.id = ready.id
    returning r.*`
  if (rows.length > 0) {
    await sql`
      insert into run_log (run_id, kind, message, worker_id)
      select * from unnest(
        ${sql.array(rows.map((r) => r.id))}::text[],
        ${sql.array(rows.map(() => 'claimed'))}::text[],
        ${sql.array(rows.map((r) => (r.attempts > 1 ? `execution #${r.attempts} started (resuming)` : 'execution #1 started')))}::text[],
        ${sql.array(rows.map(() => workerId))}::text[]
      )`
  }
  return rows
}

/** Extend the lease. Returns false if we no longer own the run. */
export async function heartbeat(sql: Sql, lease: Lease, leaseMs: number): Promise<boolean> {
  const rows = await sql`
    update runs set lease_expires_at = now() + make_interval(secs => ${leaseMs / 1000})
    where id = ${lease.runId} and lease_token = ${lease.token} and status = 'running'
    returning id`
  return rows.length > 0
}

/* -------------------------------------------------------- fenced step writes */

export interface StepWrite {
  key: string
  seq: number
  kind: StepKind
  status: StepRow['status']
  output?: unknown
  error?: string | null
  attempts?: number
  meta?: Record<string, unknown>
  startedAt: Date
  completedAt?: Date | null
  durationMs?: number | null
}

/**
 * Upsert a journal entry ONLY if we still hold the lease. A zombie worker (paused by GC,
 * partitioned, slow) whose lease was taken over can never overwrite the new owner's journal.
 */
export async function writeStep(sql: Sql, lease: Lease, s: StepWrite): Promise<boolean> {
  const rows = await sql`
    insert into steps (run_id, key, seq, kind, status, output, error, attempts, meta,
                       started_at, completed_at, duration_ms)
    select ${lease.runId}, ${s.key}, ${s.seq}, ${s.kind}, ${s.status},
           ${s.output === undefined ? null : sql.json(s.output as never)}, ${s.error ?? null},
           ${s.attempts ?? 1}, ${sql.json((s.meta ?? {}) as never)},
           ${s.startedAt}, ${s.completedAt ?? null}, ${s.durationMs ?? null}
    where exists (
      select 1 from runs
      where id = ${lease.runId} and lease_token = ${lease.token} and status = 'running'
    )
    on conflict (run_id, key) do update set
      status = excluded.status,
      output = excluded.output,
      error = excluded.error,
      attempts = excluded.attempts,
      meta = steps.meta || excluded.meta,
      completed_at = excluded.completed_at,
      duration_ms = excluded.duration_ms
    returning key`
  return rows.length > 0
}

/**
 * Atomically consume a pending event AND checkpoint it as the step's output, so a crash can
 * never "eat" an approval: either both happen or neither does.
 */
export async function consumeEvent(
  sql: Sql,
  lease: Lease,
  step: Omit<StepWrite, 'status' | 'output'>,
  eventName: string,
): Promise<{ found: false } | { found: true; payload: unknown } | { fenced: true }> {
  return sql.begin(async (tx) => {
    const owned = await tx`
      select 1 from runs where id = ${lease.runId} and lease_token = ${lease.token}
        and status = 'running' for update`
    if (owned.length === 0) return { fenced: true } as const
    const [ev] = await tx<{ id: string; payload: unknown }[]>`
      update events set consumed = true
      where id = (
        select id from events where run_id = ${lease.runId} and name = ${eventName} and not consumed
        order by id limit 1 for update
      )
      returning id, payload`
    if (!ev) return { found: false } as const
    await tx`
      insert into steps (run_id, key, seq, kind, status, output, meta, started_at, completed_at, duration_ms)
      values (${lease.runId}, ${step.key}, ${step.seq}, ${step.kind}, 'completed',
              ${tx.json({ payload: ev.payload } as never)}, ${tx.json((step.meta ?? {}) as never)},
              ${step.startedAt}, now(), ${step.durationMs ?? null})
      on conflict (run_id, key) do update set
        status = 'completed', output = excluded.output, meta = steps.meta || excluded.meta,
        completed_at = excluded.completed_at`
    return { found: true, payload: ev.payload } as const
  })
}

export async function recordReplays(sql: Sql, runId: string, keys: string[]): Promise<void> {
  if (keys.length === 0) return
  await sql`update steps set replays = replays + 1
            where run_id = ${runId} and key in ${sql(keys)}`
}

/* ------------------------------------------------------ fenced run outcomes */

async function fencedRunUpdate(
  sql: Sql,
  lease: Lease,
  set: ReturnType<Sql>,
  log: { kind: string; message: string },
  notify = false,
): Promise<boolean> {
  return sql.begin(async (tx) => {
    const rows = await tx`
      update runs set ${set}, lease_token = null, lease_expires_at = null, updated_at = now()
      where id = ${lease.runId} and lease_token = ${lease.token} and status = 'running'
      returning id`
    if (rows.length === 0) return false
    await tx`insert into run_log (run_id, kind, message, worker_id)
             values (${lease.runId}, ${log.kind}, ${log.message}, ${lease.workerId})`
    if (notify) await tx`select pg_notify(${RUN_CHANNEL}, '')`
    return true
  })
}

export function completeRun(sql: Sql, lease: Lease, output: unknown, message: string) {
  return fencedRunUpdate(
    sql,
    lease,
    sql`status = 'succeeded', output = ${sql.json((output ?? null) as never)}, error = null,
        error_code = null, completed_at = now(), wait_event = null, wait_until = null`,
    { kind: 'succeeded', message },
  )
}

export function failRun(sql: Sql, lease: Lease, error: string, code: string) {
  return fencedRunUpdate(
    sql,
    lease,
    sql`status = 'failed', error = ${error}, error_code = ${code}, completed_at = now()`,
    { kind: 'failed', message: `${code}: ${error}` },
  )
}

export function retryRunLater(sql: Sql, lease: Lease, error: string, delayMs: number) {
  return fencedRunUpdate(
    sql,
    lease,
    sql`status = 'queued', error = ${error},
        next_run_at = now() + make_interval(secs => ${delayMs / 1000})`,
    { kind: 'retry_scheduled', message: `${error} — retrying in ${Math.round(delayMs / 1000)}s` },
  )
}

/**
 * Park a run. Guards the classic lost-wakeup race: if the awaited event arrived after the
 * agent checked for it but before we parked (postEvent saw status 'running' and so did not
 * wake it), we re-queue immediately instead of sleeping until the timeout. postEvent and this
 * both lock the run row, so the two can't interleave.
 */
export async function suspendRun(
  sql: Sql,
  lease: Lease,
  until: Date | null,
  eventName: string | null,
  message: string,
): Promise<boolean> {
  return sql.begin(async (tx) => {
    const rows = await tx`
      update runs set status = 'waiting', wait_event = ${eventName}, wait_until = ${until},
        lease_token = null, lease_expires_at = null, updated_at = now()
      where id = ${lease.runId} and lease_token = ${lease.token} and status = 'running'
      returning id`
    if (rows.length === 0) return false
    await tx`insert into run_log (run_id, kind, message, worker_id)
             values (${lease.runId}, 'suspended', ${message}, ${lease.workerId})`
    if (eventName) {
      const pending = await tx`
        select 1 from events where run_id = ${lease.runId} and name = ${eventName} and not consumed
        limit 1`
      if (pending.length > 0) {
        await tx`update runs set status = 'queued', next_run_at = now() where id = ${lease.runId}`
        await tx`select pg_notify(${RUN_CHANNEL}, '')`
      }
    }
    return true
  })
}

/** Naive-mode helper: take a pending event without journaling it (no checkpoint). */
export async function takeEventUnjournaled(
  sql: Sql,
  runId: string,
  name: string,
): Promise<{ payload: unknown } | undefined> {
  const [ev] = await sql<{ payload: unknown }[]>`
    update events set consumed = true
    where id = (select id from events where run_id = ${runId} and name = ${name} and not consumed
                order by id limit 1 for update skip locked)
    returning payload`
  return ev
}

/* ------------------------------------------------------- recovery & timers */

/**
 * Crash recovery. A worker that died (SIGKILL, OOM, node lost) stops heartbeating; once its
 * lease expires the run goes back to the queue and the next execution replays the journal.
 * Every crash counts as an attempt, so a run that keeps killing workers eventually fails
 * instead of looping forever.
 */
export async function reapExpiredLeases(sql: Sql, maxAttempts: number): Promise<number> {
  return sql.begin(async (tx) => {
    const rows = await tx<{ id: string; workerId: string | null; dead: boolean }[]>`
      update runs set
        status = case when attempts >= ${maxAttempts} then 'failed' else 'queued' end,
        error = case when attempts >= ${maxAttempts}
                then 'worker lost too many times' else error end,
        error_code = case when attempts >= ${maxAttempts} then 'max_attempts' else error_code end,
        completed_at = case when attempts >= ${maxAttempts} then now() else null end,
        next_run_at = now(),
        lease_token = null, lease_expires_at = null, updated_at = now()
      where status = 'running' and lease_expires_at < now()
      returning id, worker_id, status = 'failed' as dead`
    if (rows.length === 0) return 0
    await tx`
      insert into run_log (run_id, kind, message, worker_id)
      select * from unnest(
        ${tx.array(rows.map((r) => r.id))}::text[],
        ${tx.array(rows.map(() => 'worker_lost'))}::text[],
        ${tx.array(rows.map((r) => (r.dead ? 'worker lost; out of attempts' : 'worker stopped heartbeating (crashed?); lease expired, run re-queued')))}::text[],
        ${tx.array(rows.map((r) => r.workerId ?? ''))}::text[]
      )`
    await tx`select pg_notify(${RUN_CHANNEL}, '')`
    return rows.length
  })
}

/** Durable timers: wake sleeping runs and time out event waits whose deadline passed. */
export async function wakeDueRuns(sql: Sql): Promise<number> {
  return sql.begin(async (tx) => {
    const rows = await tx<{ id: string }[]>`
      update runs set status = 'queued', next_run_at = now(), updated_at = now()
      where status = 'waiting' and wait_until is not null and wait_until <= now()
      returning id`
    if (rows.length === 0) return 0
    await tx`
      insert into run_log (run_id, kind, message)
      select id, 'resumed', 'timer fired' from unnest(${tx.array(rows.map((r) => r.id))}::text[]) as id`
    await tx`select pg_notify(${RUN_CHANNEL}, '')`
    return rows.length
  })
}

/* ---------------------------------------------------------- external control */

export async function postEvent(
  sql: Sql,
  runId: string,
  name: string,
  payload: unknown,
): Promise<{ run: Run; woke: boolean } | undefined> {
  return sql.begin(async (tx) => {
    const [run] = await tx<Run[]>`select * from runs where id = ${runId} for update`
    if (!run) return undefined
    await tx`insert into events (run_id, name, payload)
             values (${runId}, ${name}, ${tx.json((payload ?? null) as never)})`
    await tx`insert into run_log (run_id, kind, message)
             values (${runId}, 'event', ${`event "${name}" received`})`
    let woke = false
    if (run.status === 'waiting' && run.waitEvent === name) {
      await tx`update runs set status = 'queued', next_run_at = now(), updated_at = now()
               where id = ${runId}`
      await tx`select pg_notify(${RUN_CHANNEL}, '')`
      woke = true
    }
    const [after] = await tx<Run[]>`select * from runs where id = ${runId}`
    return { run: after!, woke }
  })
}

export async function cancelRun(sql: Sql, runId: string): Promise<Run | undefined> {
  const [row] = await sql<Run[]>`
    update runs set status = 'cancelled', completed_at = now(), updated_at = now(),
      lease_token = null, lease_expires_at = null
    where id = ${runId} and status in ('queued', 'waiting', 'running')
    returning *`
  if (row) await appendLog(sql, runId, 'cancelled', 'cancelled by operator')
  return row
}

export type AmbiguousResolution = 'assume_done' | 'retry_effect'

/**
 * Resume a failed run from where it stopped. Completed steps replay from the journal, so a
 * fix-and-retry after an outage re-does only the work that didn't happen.
 * For an ambiguous at-most-once effect the operator decides what really happened.
 */
export async function retryRun(
  sql: Sql,
  runId: string,
  resolution?: AmbiguousResolution,
): Promise<Run | undefined> {
  return sql.begin(async (tx) => {
    const [run] = await tx<Run[]>`
      update runs set status = 'queued', attempts = 0, next_run_at = now(), error = null,
        error_code = null, completed_at = null, updated_at = now()
      where id = ${runId} and status in ('failed', 'cancelled')
      returning *`
    if (!run) return undefined
    if (resolution === 'assume_done') {
      await tx`update steps set status = 'completed', completed_at = now(),
                 meta = meta || '{"resolvedBy":"operator","assumedDone":true}'::jsonb
               where run_id = ${runId} and kind = 'tool' and status = 'started'`
    } else if (resolution === 'retry_effect') {
      await tx`delete from steps where run_id = ${runId} and kind = 'tool' and status = 'started'`
    }
    await tx`insert into run_log (run_id, kind, message)
             values (${runId}, 'retried', ${`retried by operator${resolution ? ` (${resolution})` : ''}`})`
    await tx`select pg_notify(${RUN_CHANNEL}, '')`
    return run
  })
}

/* ------------------------------------------------------------------- stats */

export interface Stats {
  runs: Record<RunStatus, number>
  recoveredRuns: number
  replayedSteps: number
  llm: { calls: number; callsSaved: number; tokens: number; tokensSaved: number }
  effects: { executed: number; replayedNotRepeated: number }
  awaitingApproval: number
  durationMs: { p50: number | null; p95: number | null }
}

export async function getStats(sql: Sql): Promise<Stats> {
  const [counts, recovered, steps, durations] = await Promise.all([
    sql<
      { status: RunStatus; n: number }[]
    >`select status, count(*)::int as n from runs group by status`,
    sql<{ n: number }[]>`
      select count(distinct run_id)::int as n from run_log where kind = 'worker_lost'`,
    sql<
      {
        replayed: number
        llmCalls: number
        llmSaved: number
        tokens: number
        tokensSaved: number
        effects: number
        effectsSaved: number
      }[]
    >`
      select
        coalesce(sum(replays), 0)::int as replayed,
        count(*) filter (where kind = 'llm' and status = 'completed')::int as llm_calls,
        coalesce(sum(replays) filter (where kind = 'llm'), 0)::int as llm_saved,
        coalesce(sum(((meta->>'inputTokens')::int + (meta->>'outputTokens')::int))
          filter (where kind = 'llm'), 0)::int as tokens,
        coalesce(sum(replays * ((meta->>'inputTokens')::int + (meta->>'outputTokens')::int))
          filter (where kind = 'llm'), 0)::int as tokens_saved,
        count(*) filter (where kind = 'tool' and status = 'completed')::int as effects,
        coalesce(sum(replays) filter (where kind = 'tool'), 0)::int as effects_saved
      from steps`,
    sql<{ p50: number | null; p95: number | null }[]>`
      select
        percentile_cont(0.5) within group (order by ms) as p50,
        percentile_cont(0.95) within group (order by ms) as p95
      from (
        select extract(epoch from completed_at - created_at) * 1000 as ms
        from runs where status = 'succeeded' and completed_at > now() - interval '24 hours'
      ) t`,
  ])
  const runs: Record<RunStatus, number> = {
    queued: 0,
    running: 0,
    waiting: 0,
    succeeded: 0,
    failed: 0,
    cancelled: 0,
  }
  for (const c of counts) runs[c.status] = c.n
  const s = steps[0]!
  const round = (v: number | null | undefined) => (v == null ? null : Math.round(v))
  return {
    runs,
    recoveredRuns: recovered[0]?.n ?? 0,
    replayedSteps: s.replayed,
    llm: {
      calls: s.llmCalls,
      callsSaved: s.llmSaved,
      tokens: s.tokens,
      tokensSaved: s.tokensSaved,
    },
    effects: { executed: s.effects, replayedNotRepeated: s.effectsSaved },
    awaitingApproval: runs.waiting,
    durationMs: { p50: round(durations[0]?.p50), p95: round(durations[0]?.p95) },
  }
}
