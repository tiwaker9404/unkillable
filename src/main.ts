import { buildApi } from './api/server.ts'
import { loadConfig } from './config.ts'
import { connect, migrate } from './db/index.ts'
import { scriptedModel } from './demo/policy.ts'
import { createRefundAgent } from './demo/refund-agent.ts'
import { OpenAICompatibleProvider } from './llm/openai.ts'
import { ScriptedProvider } from './llm/scripted.ts'
import type { LlmProvider } from './llm/types.ts'
import { createLogger } from './logger.ts'
import { registry, Worker } from './runtime/worker.ts'

/**
 *   node src/main.ts migrate   apply schema migrations
 *   node src/main.ts api       HTTP API + dashboard
 *   node src/main.ts worker    agent executor (run as many as you like)
 *   node src/main.ts all       api + worker in one process (dev / small deployments)
 */
const role = process.argv[2] ?? 'all'
const cfg = loadConfig()
const log = createLogger(cfg.LOG_LEVEL, `unkillable:${role}`)

const llm: LlmProvider =
  cfg.LLM_PROVIDER === 'openai'
    ? new OpenAICompatibleProvider({
        baseUrl: cfg.LLM_BASE_URL,
        model: cfg.LLM_MODEL,
        apiKey: cfg.LLM_API_KEY,
        timeoutMs: cfg.LLM_TIMEOUT_MS,
      })
    : new ScriptedProvider(scriptedModel)

const agents = registry(
  createRefundAgent({
    sandboxUrl: cfg.SANDBOX_URL,
    approvalThresholdCents: cfg.APPROVAL_THRESHOLD_CENTS,
  }) as never,
)

const sql = connect(cfg.DATABASE_URL, cfg.DB_POOL_SIZE)
const stoppers: (() => Promise<void>)[] = []

async function main() {
  if (role === 'migrate' || role === 'all') {
    const applied = await migrate(sql, (m) => log.info(m))
    if (role === 'migrate') {
      log.info({ applied }, 'migrations complete')
      await sql.end()
      return
    }
  }

  if (role === 'worker' || role === 'all') {
    const worker = new Worker(sql, cfg, log, agents, llm)
    await worker.start()
    stoppers.push(() => worker.stop())
  }

  if (role === 'api' || role === 'all') {
    const app = await buildApi({ sql, cfg, log, agents })
    await app.listen({ port: cfg.PORT, host: cfg.HOST })
    stoppers.unshift(() => app.close())
  }

  if (!['api', 'worker', 'all'].includes(role)) {
    throw new Error(`unknown role "${role}" (expected migrate | api | worker | all)`)
  }
}

let stopping = false
async function shutdown(signal: string) {
  if (stopping) return
  stopping = true
  log.info({ signal }, 'shutting down')
  for (const stop of stoppers)
    await stop().catch((err) => log.error({ err }, 'shutdown step failed'))
  await sql.end({ timeout: 5 })
  process.exit(0)
}
process.on('SIGTERM', () => void shutdown('SIGTERM'))
process.on('SIGINT', () => void shutdown('SIGINT'))

main().catch((err) => {
  log.fatal({ err }, 'startup failed')
  process.exit(1)
})
