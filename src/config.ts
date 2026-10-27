import { z } from 'zod'

const schema = z.object({
  DATABASE_URL: z.string().url().default('postgres://postgres@127.0.0.1:5432/unkillable'),
  API_KEYS: z
    .string()
    .default('')
    .transform((s) =>
      s
        .split(',')
        .map((k) => k.trim())
        .filter(Boolean),
    ),
  PORT: z.coerce.number().int().default(8080),
  HOST: z.string().default('0.0.0.0'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  DB_POOL_SIZE: z.coerce.number().int().positive().default(20),

  /** how many agent runs one worker process executes concurrently */
  WORKER_CONCURRENCY: z.coerce.number().int().positive().default(16),
  POLL_INTERVAL_MS: z.coerce.number().int().positive().default(1000),
  /** a run's lease; renewed by heartbeat every LEASE_MS/3 while the run executes */
  LEASE_MS: z.coerce.number().int().min(1000).default(30_000),
  /** executions per run before it is marked failed (crash recoveries count) */
  RUN_MAX_ATTEMPTS: z.coerce.number().int().min(1).default(10),
  RETRY_BASE_MS: z.coerce.number().int().positive().default(2_000),
  RETRY_MAX_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(10 * 60 * 1000),

  /** durable = checkpoint + replay (unkillable). naive = re-run from scratch (baseline for comparison) */
  EXECUTION_MODE: z.enum(['durable', 'naive']).default('durable'),

  /** scripted = deterministic local model for tests/demos; openai = any OpenAI-compatible API (Ollama, OpenAI, Groq...) */
  LLM_PROVIDER: z.enum(['scripted', 'openai']).default('scripted'),
  LLM_BASE_URL: z.string().default('http://localhost:11434/v1'),
  LLM_MODEL: z.string().default('qwen2.5:7b'),
  LLM_API_KEY: z.string().default('ollama'),
  LLM_TIMEOUT_MS: z.coerce.number().int().positive().default(120_000),

  /** demo agent: where the sandboxed payments/CRM/email APIs live */
  SANDBOX_URL: z.string().default('http://127.0.0.1:4000'),
  /** demo agent: refunds above this need a human approval event */
  APPROVAL_THRESHOLD_CENTS: z.coerce.number().int().nonnegative().default(20_000),

  /** chaos testing only: probability a worker SIGKILLs itself right after a side effect */
  CHAOS_KILL_AFTER_EFFECT: z.coerce.number().min(0).max(1).default(0),
})

export type Config = z.infer<typeof schema>

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env)
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')
    throw new Error(`Invalid configuration: ${issues}`)
  }
  return parsed.data
}
