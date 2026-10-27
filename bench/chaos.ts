/**
 * Chaos benchmark: the same refund agent, the same tickets, the same crashes, two runtimes.
 *
 *   node bench/chaos.ts                       # both modes, defaults
 *   node bench/chaos.ts --mode durable --runs 500 --workers 4 --kill-every 300
 *
 * - W worker processes execute agent runs; a "killer" SIGKILLs a random one every N ms and an
 *   "orchestrator" restarts it, like Kubernetes would.
 * - Workers also SIGKILL themselves with probability p right after a side effect: the worst
 *   possible moment (refund done, journal not updated).
 * - A manager bot approves large refunds as they come in.
 * - The sandbox (payments / CRM / email / LLM API) counts what REALLY happened.
 */
import { type ChildProcess, spawn } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { parseArgs } from 'node:util'
import { connect, migrate, type Sql } from '../src/db/index.ts'
import { sampleTickets } from '../src/demo/tickets.ts'
import { createRun, postEvent } from '../src/runtime/store.ts'
import { createSandbox } from '../src/sandbox/server.ts'

export interface ChaosOptions {
  mode: 'durable' | 'naive'
  runs: number
  workers: number
  killEveryMs: number
  selfKillProbability: number
  databaseUrl: string
  timeoutMs: number
  seed: string
  quiet?: boolean
}

export interface ChaosResult {
  mode: 'durable' | 'naive'
  runs: number
  succeeded: number
  failed: number
  unfinished: number
  elapsedSeconds: number
  workerKills: { external: number; selfAfterSideEffect: number }
  executions: number
  runsThatSurvivedACrash: number
  refunds: {
    applied: number
    orders: number
    doubleRefundedOrders: number
    extraDollars: number
    deduplicated: number
  }
  emails: { sent: number; customersEmailedTwice: number }
  crmDuplicateNotes: number
  /** re-sent side effects (refund / CRM / email) that downstreams dropped thanks to the stable key */
  duplicatesAbsorbed: number
  llm: { calls: number; tokens: number; callsPerRun: number }
}

const ROOT = join(import.meta.dirname, '..')

export async function runChaos(o: ChaosOptions): Promise<ChaosResult> {
  const say = (m: string) => o.quiet || console.log(`[${o.mode}] ${m}`)
  const sql: Sql = connect(o.databaseUrl, 10)
  await sql.unsafe('drop schema if exists public cascade; create schema public;')
  await migrate(sql)

  const sandbox = createSandbox({ latencyMs: [20, 80], llmLatencyMs: [100, 400] })
  const port = await sandbox.listen(0)
  const sandboxUrl = `http://127.0.0.1:${port}`

  const env = {
    ...process.env,
    DATABASE_URL: o.databaseUrl,
    EXECUTION_MODE: o.mode,
    LLM_PROVIDER: 'openai',
    LLM_BASE_URL: `${sandboxUrl}/v1`,
    LLM_MODEL: 'scripted-v1',
    SANDBOX_URL: sandboxUrl,
    APPROVAL_THRESHOLD_CENTS: '40000',
    LEASE_MS: '3000',
    POLL_INTERVAL_MS: '200',
    WORKER_CONCURRENCY: '16',
    RETRY_BASE_MS: '200',
    RETRY_MAX_MS: '2000',
    RUN_MAX_ATTEMPTS: '25',
    CHAOS_KILL_AFTER_EFFECT: String(o.selfKillProbability),
    LOG_LEVEL: 'error',
  }

  let running = true
  let external = 0
  let selfKills = 0
  const procs = new Set<ChildProcess>()
  const spawnWorker = () => {
    const p = spawn(process.execPath, ['src/main.ts', 'worker'], {
      cwd: ROOT,
      env,
      stdio: ['ignore', 'ignore', 'pipe'],
    })
    p.stderr?.on('data', (d: Buffer) => {
      const n = d.toString().match(/\[chaos\] SIGKILL/g)?.length ?? 0
      selfKills += n
    })
    procs.add(p)
    p.on('exit', () => {
      procs.delete(p)
      // the orchestrator restarts dead workers after a moment
      if (running) setTimeout(spawnWorker, 300)
    })
  }
  for (let i = 0; i < o.workers; i++) spawnWorker()

  const tickets = sampleTickets(o.runs, o.seed)
  const t0 = Date.now()
  for (const t of tickets) {
    await createRun(sql, {
      agent: 'refund-agent',
      input: t,
      idempotencyKey: `ticket:${t.ticketId}`,
    })
  }
  say(`enqueued ${o.runs} runs across ${o.workers} workers`)

  const killer = (async () => {
    while (running) {
      await sleep(o.killEveryMs)
      const live = [...procs].filter((p) => p.exitCode === null && p.signalCode === null)
      const victim = live[Math.floor(Math.random() * live.length)]
      if (victim && running) {
        victim.kill('SIGKILL')
        external++
      }
    }
  })()

  // Manager bot: keeps an approval available for every unfinished run. (Durable runs consume
  // one; naive runs consume a fresh one on every re-execution, as they have no memory.)
  const approver = (async () => {
    while (running) {
      const need = await sql<{ id: string }[]>`
        select r.id from runs r
        where r.status in ('queued', 'running', 'waiting')
          and not exists (select 1 from events e where e.run_id = r.id and e.name = 'approval' and not e.consumed)`
      for (const r of need)
        await postEvent(sql, r.id, 'approval', { approved: true, by: 'manager-bot' })
      await sleep(300)
    }
  })()

  let last = ''
  for (;;) {
    const [c] = await sql<{ done: number; ok: number; failed: number }[]>`
      select count(*) filter (where status in ('succeeded', 'failed', 'cancelled'))::int as done,
             count(*) filter (where status = 'succeeded')::int as ok,
             count(*) filter (where status = 'failed')::int as failed
      from runs`
    const line = `${c!.done}/${o.runs} finished (${c!.failed} failed), workers killed: ${external} external + ${selfKills} mid-effect`
    if (line !== last) {
      say(line)
      last = line
    }
    if (c!.done >= o.runs || Date.now() - t0 > o.timeoutMs) break
    await sleep(1000)
  }
  const elapsedSeconds = Math.round((Date.now() - t0) / 100) / 10

  running = false
  await Promise.all([killer, approver])
  for (const p of procs) p.kill('SIGKILL')
  await sleep(200)

  const [counts] = await sql<
    { ok: number; failed: number; unfinished: number; executions: number }[]
  >`
    select count(*) filter (where status = 'succeeded')::int as ok,
           count(*) filter (where status = 'failed')::int as failed,
           count(*) filter (where status not in ('succeeded', 'failed', 'cancelled'))::int as unfinished,
           coalesce(sum(attempts), 0)::int as executions
    from runs`
  const [recovered] = await sql<{ n: number }[]>`
    select count(distinct run_id)::int as n from run_log where kind = 'worker_lost'`
  const s = sandbox.stats()
  await sandbox.close()
  await sql.end()

  return {
    mode: o.mode,
    runs: o.runs,
    succeeded: counts!.ok,
    failed: counts!.failed,
    unfinished: counts!.unfinished,
    elapsedSeconds,
    workerKills: { external, selfAfterSideEffect: selfKills },
    executions: counts!.executions,
    runsThatSurvivedACrash: recovered!.n,
    refunds: {
      applied: s.refunds.applied,
      orders: s.refunds.subjects,
      doubleRefundedOrders: s.refunds.subjectsAffectedMoreThanOnce,
      extraDollars: Math.round(s.refunds.extraCents) / 100,
      deduplicated: s.refunds.deduplicatedByIdempotencyKey,
    },
    emails: {
      sent: s.emails.applied,
      customersEmailedTwice: s.emails.subjectsAffectedMoreThanOnce,
    },
    crmDuplicateNotes: s.crm.subjectsAffectedMoreThanOnce,
    duplicatesAbsorbed:
      s.refunds.deduplicatedByIdempotencyKey +
      s.crm.deduplicatedByIdempotencyKey +
      s.emails.deduplicatedByIdempotencyKey,
    llm: {
      calls: s.llm.calls,
      tokens: s.llm.inputTokens + s.llm.outputTokens,
      callsPerRun: Math.round((s.llm.calls / o.runs) * 100) / 100,
    },
  }
}

export function toMarkdown(results: ChaosResult[]): string {
  const cols = results.map((r) => (r.mode === 'durable' ? '**unkillable**' : 'naive agent'))
  const row = (label: string, f: (r: ChaosResult) => string | number) =>
    `| ${label} | ${results.map((r) => f(r)).join(' | ')} |`
  return [
    `| | ${cols.join(' | ')} |`,
    `|---|${results.map(() => '---:').join('|')}|`,
    row('Runs (support tickets)', (r) => r.runs),
    row('Workers SIGKILLed', (r) => r.workerKills.external + r.workerKills.selfAfterSideEffect),
    row('…of which right after a side effect', (r) => r.workerKills.selfAfterSideEffect),
    row('Runs completed', (r) => `${r.succeeded}/${r.runs}`),
    row('Customers refunded twice', (r) =>
      r.mode === 'durable'
        ? `**${r.refunds.doubleRefundedOrders}**`
        : r.refunds.doubleRefundedOrders,
    ),
    row('Money refunded twice', (r) =>
      r.mode === 'durable'
        ? `**$${r.refunds.extraDollars.toFixed(2)}**`
        : `$${r.refunds.extraDollars.toFixed(2)}`,
    ),
    row('Customers emailed twice', (r) => r.emails.customersEmailedTwice),
    row('Duplicate CRM notes', (r) => r.crmDuplicateNotes),
    row('LLM calls (2 needed per ticket)', (r) => `${r.llm.calls} (${r.llm.callsPerRun}/ticket)`),
    row('Re-sent effects safely deduplicated', (r) => r.duplicatesAbsorbed),
    row('Wall time', (r) => `${r.elapsedSeconds}s`),
  ].join('\n')
}

if (process.argv[1] && import.meta.filename === process.argv[1]) {
  const { values } = parseArgs({
    options: {
      mode: { type: 'string', default: 'both' },
      runs: { type: 'string', default: '200' },
      workers: { type: 'string', default: '3' },
      'kill-every': { type: 'string', default: '400' },
      p: { type: 'string', default: '0.08' },
      timeout: { type: 'string', default: '600' },
      seed: { type: 'string', default: 'bench' },
      out: { type: 'string', default: join(ROOT, 'bench/results') },
    },
  })
  const modes =
    values.mode === 'both' ? (['naive', 'durable'] as const) : [values.mode as 'durable' | 'naive']
  const results: ChaosResult[] = []
  for (const mode of modes) {
    results.push(
      await runChaos({
        mode,
        runs: Number(values.runs),
        workers: Number(values.workers),
        killEveryMs: Number(values['kill-every']),
        selfKillProbability: Number(values.p),
        databaseUrl:
          process.env.BENCH_DATABASE_URL ?? 'postgres://postgres@127.0.0.1:5432/unkillable_bench',
        timeoutMs: Number(values.timeout) * 1000,
        seed: values.seed!,
      }),
    )
  }
  const md = toMarkdown(results)
  console.log(`\n${md}\n`)
  await mkdir(values.out!, { recursive: true })
  await writeFile(join(values.out!, 'chaos.json'), `${JSON.stringify(results, null, 2)}\n`)
  await writeFile(join(values.out!, 'chaos.md'), `${md}\n`)
  process.exit(0)
}
