import type { ZodType } from 'zod'
import type { ChatMessage } from '../llm/types.ts'

export type StepKind = 'step' | 'llm' | 'tool' | 'sleep' | 'event'

export interface StepOptions {
  /** in-process retries for transient errors before the run itself is retried (default 2) */
  retries?: number
}

export interface LlmOptions<T> {
  messages: ChatMessage[]
  /** validate the model's JSON output; invalid output is sent back to the model to repair */
  schema?: ZodType<T>
  temperature?: number
}

/**
 * - idempotent (default): the effect may be attempted again after a crash, always with the
 *   SAME idempotency key, so a downstream that honors keys (Stripe, most payment/email
 *   APIs) applies it exactly once.
 * - at-most-once: for downstreams with no idempotency support. A "started" marker is
 *   written before the call; if a crash leaves it ambiguous, the run stops for human
 *   review instead of risking a duplicate.
 */
export type ToolMode = 'idempotent' | 'at-most-once'

export interface ToolOptions {
  mode?: ToolMode
  retries?: number
}

export interface EventResult<T> {
  payload: T
}

export interface AgentContext {
  readonly runId: string
  /** 1 on the first execution; >1 when resuming after a crash or retry */
  readonly attempt: number
  /** aborted if this worker loses the run's lease; pass it to your I/O */
  readonly signal: AbortSignal
  log(message: string): void

  /** checkpointed deterministic work (reads, computations). Replayed from the journal after a crash. */
  step<T>(key: string, fn: () => Promise<T>, opts?: StepOptions): Promise<T>
  /** checkpointed LLM call: on resume the stored completion is returned, not re-billed */
  llm(key: string, opts: LlmOptions<undefined> & { schema?: undefined }): Promise<string>
  llm<T>(key: string, opts: LlmOptions<T> & { schema: ZodType<T> }): Promise<T>
  /** an external side effect (refund, email, CRM write) with exactly-once semantics */
  tool<T>(key: string, fn: (idempotencyKey: string) => Promise<T>, opts?: ToolOptions): Promise<T>
  /** durable timer: the run releases its worker and wakes later */
  sleep(key: string, ms: number): Promise<void>
  /** human-in-the-loop: suspend until an event is posted to this run, or time out (null) */
  waitForEvent<T = unknown>(
    key: string,
    eventName: string,
    opts: { timeoutMs: number },
  ): Promise<EventResult<T> | null>
}

export type AgentFn<I = unknown, O = unknown> = (ctx: AgentContext, input: I) => Promise<O>

export interface AgentDefinition<I = unknown, O = unknown> {
  name: string
  /** optional input validation at the API boundary */
  input?: ZodType<I>
  run: AgentFn<I, O>
}

export function defineAgent<I, O>(def: AgentDefinition<I, O>): AgentDefinition<I, O> {
  return def
}
