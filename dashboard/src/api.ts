export type RunStatus = 'queued' | 'running' | 'waiting' | 'succeeded' | 'failed' | 'cancelled'

export interface Run {
  id: string
  agent: string
  input: { ticketId?: string; message?: string; orderId?: string; customerEmail?: string } & Record<
    string,
    unknown
  >
  status: RunStatus
  output: unknown
  error: string | null
  errorCode: string | null
  attempts: number
  waitEvent: string | null
  waitUntil: string | null
  createdAt: string
  updatedAt: string
  completedAt: string | null
  steps?: number
  replayed?: number
  request?: string | null
}

export interface Step {
  key: string
  seq: number
  kind: 'step' | 'llm' | 'tool' | 'sleep' | 'event'
  status: 'started' | 'completed' | 'failed'
  output: unknown
  error: string | null
  attempts: number
  replays: number
  meta: Record<string, unknown>
  startedAt: string
  completedAt: string | null
  durationMs: number | null
}

export interface LogEntry {
  id: string
  at: string
  kind: string
  message: string
  workerId: string | null
}

export interface RunDetail extends Omit<Run, 'steps'> {
  steps: Step[]
  timeline: LogEntry[]
  savings: {
    replayedSteps: number
    llmCallsSaved: number
    tokensSaved: number
    effectsNotRepeated: number
  }
}

export interface Stats {
  runs: Record<RunStatus, number>
  recoveredRuns: number
  replayedSteps: number
  llm: { calls: number; callsSaved: number; tokens: number; tokensSaved: number }
  effects: { executed: number; replayedNotRepeated: number }
  awaitingApproval: number
  durationMs: { p50: number | null; p95: number | null }
}

export class ApiError extends Error {
  readonly status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

const KEY = 'unkillable.apiKey'

export function getApiKey(): string {
  try {
    return localStorage.getItem(KEY) ?? ''
  } catch {
    return ''
  }
}

export function setApiKey(v: string): void {
  try {
    localStorage.setItem(KEY, v)
  } catch {
    /* storage unavailable: key lives for this page only */
  }
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const key = getApiKey()
  const res = await fetch(path, {
    ...init,
    headers: {
      ...(init.body ? { 'content-type': 'application/json' } : {}),
      ...(key ? { authorization: `Bearer ${key}` } : {}),
      ...init.headers,
    },
  })
  const body = (await res.json().catch(() => ({}))) as { error?: { message?: string } }
  if (!res.ok) throw new ApiError(res.status, body.error?.message ?? `HTTP ${res.status}`)
  return body as T
}

export const post = <T>(path: string, body: unknown = {}) =>
  api<T>(path, { method: 'POST', body: JSON.stringify(body) })
