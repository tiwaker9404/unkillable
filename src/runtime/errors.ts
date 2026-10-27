/** Thrown inside an agent to park the run (sleep / waitForEvent). Never surfaces to users. */
export class Suspend extends Error {
  readonly until: Date | null
  readonly eventName: string | null
  constructor(opts: { until: Date | null; eventName: string | null }) {
    super('run suspended')
    this.until = opts.until
    this.eventName = opts.eventName
  }
}

/** Another worker owns this run now (our lease expired). Stop immediately, write nothing. */
export class LeaseLost extends Error {
  constructor() {
    super('lease lost: another worker owns this run')
  }
}

/**
 * Replay hit a different step than the journal recorded at the same position. The agent's
 * control flow changed between executions (e.g. a deploy changed code, or it branched on
 * Date.now()/Math.random() outside a step). Replaying further would corrupt the run.
 */
export class NonDeterminismError extends Error {
  readonly code = 'non_determinism'
}

/** An at-most-once side effect may or may not have happened. A human must decide. */
export class AmbiguousEffectError extends Error {
  readonly code = 'ambiguous_effect'
}

/** Throw from agent code for failures that retrying will not fix. */
export class NonRetryableError extends Error {
  readonly code = 'non_retryable'
}

export class UnknownAgentError extends Error {
  readonly code = 'unknown_agent'
}

export function errorCode(err: unknown): string {
  if (err && typeof err === 'object' && 'code' in err && typeof err.code === 'string') {
    return err.code
  }
  return 'agent_error'
}

export function isRetryable(err: unknown): boolean {
  return !(
    err instanceof NonDeterminismError ||
    err instanceof AmbiguousEffectError ||
    err instanceof NonRetryableError ||
    err instanceof UnknownAgentError
  )
}
