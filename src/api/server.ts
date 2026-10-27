import { createHash, timingSafeEqual } from 'node:crypto'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import fastifyStatic from '@fastify/static'
import fastifySwagger from '@fastify/swagger'
import fastifySwaggerUi from '@fastify/swagger-ui'
import Fastify, { LogController } from 'fastify'
import {
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod'
import { z } from 'zod'
import type { Config } from '../config.ts'
import type { Sql } from '../db/index.ts'
import { sampleTickets } from '../demo/tickets.ts'
import type { Logger } from '../logger.ts'
import { registerQueueGauges, registry } from '../metrics.ts'
import {
  cancelRun,
  createRun,
  getLog,
  getRun,
  getStats,
  getSteps,
  listRuns,
  postEvent,
  type Run,
  retryRun,
  type StepRow,
} from '../runtime/store.ts'
import type { AgentRegistry } from '../runtime/worker.ts'

const RunStatus = z.enum(['queued', 'running', 'waiting', 'succeeded', 'failed', 'cancelled'])
const RunIdParams = z.object({ id: z.string().regex(/^run_[0-9A-Z]{26}$/, 'not a run id') })

function publicRun(r: Run) {
  const { leaseToken: _t, leaseExpiresAt: _e, ...rest } = r
  return rest
}

function savings(steps: StepRow[]) {
  let tokensSaved = 0
  let llmCallsSaved = 0
  let effectsNotRepeated = 0
  let replayed = 0
  for (const s of steps) {
    replayed += s.replays
    if (s.kind === 'llm') {
      llmCallsSaved += s.replays
      tokensSaved +=
        s.replays * (Number(s.meta.inputTokens ?? 0) + Number(s.meta.outputTokens ?? 0))
    }
    if (s.kind === 'tool') effectsNotRepeated += s.replays
  }
  return { replayedSteps: replayed, llmCallsSaved, tokensSaved, effectsNotRepeated }
}

function digest(s: string): Buffer {
  return createHash('sha256').update(s).digest()
}

export interface ApiDeps {
  sql: Sql
  cfg: Config
  log: Logger
  agents: AgentRegistry
}

export async function buildApi({ sql, cfg, log, agents }: ApiDeps) {
  const app = Fastify({
    loggerInstance: log,
    logController: new LogController({
      disableRequestLogging: (req) =>
        req.url === '/healthz' || req.url === '/readyz' || req.url === '/metrics' ||
        (cfg.LOG_LEVEL !== 'debug' && cfg.LOG_LEVEL !== 'trace'),
    }),
    bodyLimit: 1024 * 1024,
    trustProxy: true,
  }).withTypeProvider<ZodTypeProvider>()
  app.setValidatorCompiler(validatorCompiler)
  app.setSerializerCompiler(serializerCompiler)

  app.setErrorHandler((err: Error & { statusCode?: number; validation?: unknown }, _req, reply) => {
    const status = err.statusCode ?? 500
    if (status >= 500) app.log.error({ err }, 'request failed')
    const code = err.validation ? 'invalid_request' : status >= 500 ? 'internal' : 'bad_request'
    reply
      .status(status)
      .send({ error: { code, message: status >= 500 ? 'internal error' : err.message } })
  })

  await app.register(fastifySwagger, {
    openapi: {
      info: {
        title: 'unkillable',
        version: '1.0.0',
        description:
          'Crash-proof AI agent runs: checkpointed steps, exactly-once side effects, human approvals.',
      },
      components: { securitySchemes: { bearer: { type: 'http', scheme: 'bearer' } } },
      security: [{ bearer: [] }],
    },
    transform: jsonSchemaTransform,
  })
  await app.register(fastifySwaggerUi, { routePrefix: '/docs' })

  registerQueueGauges(sql)

  /* ------------------------------------------------------------ ops routes */

  app.get('/healthz', { schema: { hide: true } }, async () => ({ ok: true }))
  app.get('/readyz', { schema: { hide: true } }, async (_req, reply) => {
    try {
      await sql`select 1`
      return { ok: true }
    } catch {
      return reply.status(503).send({ ok: false })
    }
  })
  app.get('/metrics', { schema: { hide: true } }, async (_req, reply) => {
    reply.header('content-type', registry.contentType)
    return registry.metrics()
  })

  /* ------------------------------------------------------------------ auth */

  const keys = cfg.API_KEYS.map(digest)
  if (keys.length === 0) app.log.warn('API_KEYS is empty: the API is UNAUTHENTICATED (dev mode)')
  app.addHook('onRequest', async (req, reply) => {
    if (!req.url.startsWith('/v1/') || keys.length === 0) return
    const header = req.headers.authorization ?? ''
    const token = header.startsWith('Bearer ') ? header.slice(7) : ''
    const d = digest(token)
    if (!token || !keys.some((k) => timingSafeEqual(k, d))) {
      return reply
        .status(401)
        .send({ error: { code: 'unauthorized', message: 'missing or invalid API key' } })
    }
  })

  /* ------------------------------------------------------------------ runs */

  app.get(
    '/v1/agents',
    { schema: { tags: ['agents'], summary: 'List registered agents' } },
    async () => ({
      agents: [...agents.keys()],
    }),
  )

  app.post(
    '/v1/runs',
    {
      schema: {
        tags: ['runs'],
        summary: 'Start an agent run',
        description:
          'Durably enqueues a run. Send an Idempotency-Key header (or body field) so client retries never start the same work twice.',
        body: z.object({
          agent: z.string().min(1),
          input: z.unknown(),
          idempotencyKey: z.string().min(1).max(255).optional(),
        }),
        headers: z.object({ 'idempotency-key': z.string().min(1).max(255).optional() }).loose(),
      },
    },
    async (req, reply) => {
      const agent = agents.get(req.body.agent)
      if (!agent) {
        return reply.status(404).send({
          error: { code: 'unknown_agent', message: `no agent named "${req.body.agent}"` },
        })
      }
      if (agent.input) {
        const parsed = agent.input.safeParse(req.body.input)
        if (!parsed.success) {
          return reply.status(422).send({
            error: {
              code: 'invalid_input',
              message: parsed.error.issues
                .map((i) => `${i.path.join('.')}: ${i.message}`)
                .join('; '),
            },
          })
        }
      }
      const result = await createRun(sql, {
        agent: req.body.agent,
        input: req.body.input,
        idempotencyKey: req.headers['idempotency-key'] ?? req.body.idempotencyKey,
      })
      if (result.kind === 'conflict') {
        return reply.status(409).send({
          error: {
            code: 'idempotency_conflict',
            message: 'this Idempotency-Key was already used for a different request',
          },
        })
      }
      if (result.kind === 'existing') reply.header('idempotent-replayed', 'true')
      return reply.status(result.kind === 'created' ? 202 : 200).send(publicRun(result.run))
    },
  )

  app.get(
    '/v1/runs',
    {
      schema: {
        tags: ['runs'],
        summary: 'List runs (newest first, keyset pagination)',
        querystring: z.object({
          limit: z.coerce.number().int().min(1).max(200).default(50),
          before: z.string().optional(),
          status: RunStatus.optional(),
          agent: z.string().optional(),
        }),
      },
    },
    async (req) => {
      const rows = await listRuns(sql, req.query)
      return {
        data: rows.map(publicRun),
        nextCursor: rows.length === req.query.limit ? rows.at(-1)!.id : null,
      }
    },
  )

  app.get(
    '/v1/runs/:id',
    {
      schema: {
        tags: ['runs'],
        summary: 'Run detail: journal, timeline and what replay saved',
        params: RunIdParams,
      },
    },
    async (req, reply) => {
      const run = await getRun(sql, req.params.id)
      if (!run)
        return reply.status(404).send({ error: { code: 'not_found', message: 'run not found' } })
      const [steps, timeline] = await Promise.all([getSteps(sql, run.id), getLog(sql, run.id)])
      return { ...publicRun(run), steps, timeline, savings: savings(steps) }
    },
  )

  app.post(
    '/v1/runs/:id/events',
    {
      schema: {
        tags: ['runs'],
        summary: 'Deliver an event (e.g. a human approval) to a run',
        params: RunIdParams,
        body: z.object({ name: z.string().min(1).max(200), payload: z.unknown().optional() }),
      },
    },
    async (req, reply) => {
      const res = await postEvent(sql, req.params.id, req.body.name, req.body.payload ?? null)
      if (!res)
        return reply.status(404).send({ error: { code: 'not_found', message: 'run not found' } })
      if (['succeeded', 'failed', 'cancelled'].includes(res.run.status) && !res.woke) {
        return reply.status(409).send({
          error: { code: 'run_finished', message: `run is already ${res.run.status}` },
        })
      }
      return reply.status(202).send({ accepted: true, woke: res.woke, run: publicRun(res.run) })
    },
  )

  app.post(
    '/v1/runs/:id/cancel',
    {
      schema: {
        tags: ['runs'],
        summary: 'Cancel a queued, waiting or running run',
        params: RunIdParams,
      },
    },
    async (req, reply) => {
      const run = await cancelRun(sql, req.params.id)
      if (!run) {
        return reply.status(409).send({
          error: { code: 'not_cancellable', message: 'run not found or already finished' },
        })
      }
      return publicRun(run)
    },
  )

  app.post(
    '/v1/runs/:id/retry',
    {
      schema: {
        tags: ['runs'],
        summary: 'Resume a failed run from where it stopped (completed steps are not re-run)',
        params: RunIdParams,
        body: z
          .object({
            resolution: z
              .enum(['assume_done', 'retry_effect'])
              .optional()
              .describe('for an ambiguous at-most-once side effect: what actually happened'),
          })
          .optional(),
      },
    },
    async (req, reply) => {
      const run = await retryRun(sql, req.params.id, req.body?.resolution)
      if (!run)
        return reply.status(409).send({
          error: {
            code: 'not_retryable',
            message: 'only failed or cancelled runs can be retried',
          },
        })
      return publicRun(run)
    },
  )

  app.get(
    '/v1/approvals',
    { schema: { tags: ['runs'], summary: 'Runs parked waiting for a human event' } },
    async () => {
      const rows = await sql<(Run & { request: string | null })[]>`
        select r.*,
          (select s.output->>'note' from steps s
           where s.run_id = r.id and s.kind = 'tool' and s.key = 'request-approval') as request
        from runs r where r.status = 'waiting' and r.wait_event is not null
        order by r.updated_at limit 100`
      return { data: rows.map(publicRun) }
    },
  )

  app.get(
    '/v1/stats',
    { schema: { tags: ['ops'], summary: 'Runtime totals: recoveries, replays, tokens saved' } },
    async () => getStats(sql),
  )

  /* ------------------------------------------------------------- demo only */

  app.post(
    '/v1/demo/tickets',
    {
      schema: {
        tags: ['demo'],
        summary: 'Enqueue sample refund tickets for the demo agent',
        body: z.object({ count: z.number().int().min(1).max(500).default(5) }).optional(),
      },
    },
    async (req, reply) => {
      if (!agents.has('refund-agent')) {
        return reply
          .status(404)
          .send({ error: { code: 'unknown_agent', message: 'demo agent not registered' } })
      }
      const tickets = sampleTickets(req.body?.count ?? 5)
      const runs = []
      for (const t of tickets) {
        const r = await createRun(sql, {
          agent: 'refund-agent',
          input: t,
          idempotencyKey: `ticket:${t.ticketId}`,
        })
        runs.push(publicRun(r.run))
      }
      return reply.status(202).send({ data: runs })
    },
  )

  app.get(
    '/v1/demo/sandbox',
    {
      schema: {
        tags: ['demo'],
        summary: 'Ground truth from the sandboxed payments/CRM/email systems',
      },
    },
    async (_req, reply) => {
      try {
        const [stats, emails] = await Promise.all([
          fetch(`${cfg.SANDBOX_URL}/_stats`, { signal: AbortSignal.timeout(2000) }).then((r) =>
            r.json(),
          ),
          fetch(`${cfg.SANDBOX_URL}/_emails`, { signal: AbortSignal.timeout(2000) }).then((r) =>
            r.json(),
          ),
        ])
        return { stats, emails }
      } catch {
        return reply.status(503).send({
          error: { code: 'sandbox_unreachable', message: `no sandbox at ${cfg.SANDBOX_URL}` },
        })
      }
    },
  )

  /* ------------------------------------------------------------- dashboard */

  const dist = join(import.meta.dirname, '../../dashboard/dist')
  if (existsSync(dist)) {
    await app.register(fastifyStatic, { root: dist, prefix: '/', wildcard: false })
    app.setNotFoundHandler((req, reply) => {
      if (req.method === 'GET' && !req.url.startsWith('/v1/')) return reply.sendFile('index.html')
      reply.status(404).send({ error: { code: 'not_found', message: 'route not found' } })
    })
  }

  return app
}
