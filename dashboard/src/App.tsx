import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import {
  ApiError,
  api,
  getApiKey,
  post,
  type Run,
  type RunDetail,
  type RunStatus,
  type Stats,
  setApiKey,
} from './api.ts'
import { Tape } from './Tape.tsx'

const FILTERS: { label: string; status?: RunStatus }[] = [
  { label: 'All' },
  { label: 'Running', status: 'running' },
  { label: 'Waiting', status: 'waiting' },
  { label: 'Failed', status: 'failed' },
  { label: 'Done', status: 'succeeded' },
]

export function App() {
  const [selected, setSelected] = useState<string | null>(null)
  const [filter, setFilter] = useState<RunStatus | undefined>()
  const qc = useQueryClient()

  const stats = useQuery({ queryKey: ['stats'], queryFn: () => api<Stats>('/v1/stats') })
  const runs = useQuery({
    queryKey: ['runs', filter],
    queryFn: () => api<{ data: Run[] }>(`/v1/runs?limit=100${filter ? `&status=${filter}` : ''}`),
  })
  const approvals = useQuery({
    queryKey: ['approvals'],
    queryFn: () => api<{ data: Run[] }>('/v1/approvals'),
  })

  const addTickets = useMutation({
    mutationFn: () => post<{ data: Run[] }>('/v1/demo/tickets', { count: 5 }),
    onSuccess: (r) => {
      void qc.invalidateQueries()
      if (!selected && r.data[0]) setSelected(r.data[0].id)
    },
  })

  const unauthorized = [stats.error, runs.error].some(
    (e) => e instanceof ApiError && e.status === 401,
  )
  const activeId = selected ?? runs.data?.data[0]?.id ?? null

  return (
    <div className="shell">
      <header className="masthead">
        <div className="brand">
          <span className="recorder" aria-hidden="true" />
          <h1>unkillable</h1>
        </div>
        <Summary stats={stats.data} />
        <button
          type="button"
          className="primary"
          onClick={() => addTickets.mutate()}
          disabled={addTickets.isPending}
        >
          {addTickets.isPending ? 'Adding tickets…' : 'Add 5 sample tickets'}
        </button>
      </header>

      {unauthorized && <KeyPrompt />}
      {addTickets.error && <p className="notice error">{addTickets.error.message}</p>}

      {(approvals.data?.data.length ?? 0) > 0 && (
        <Approvals runs={approvals.data!.data} onOpen={setSelected} />
      )}

      <main className="workspace">
        <section className="ledger" aria-label="Runs">
          <div className="filters" role="tablist">
            {FILTERS.map((f) => (
              <button
                key={f.label}
                type="button"
                role="tab"
                aria-selected={filter === f.status}
                className={filter === f.status ? 'tab on' : 'tab'}
                onClick={() => setFilter(f.status)}
              >
                {f.label}
                {f.status && stats.data ? (
                  <span className="count">{stats.data.runs[f.status]}</span>
                ) : null}
              </button>
            ))}
          </div>
          {runs.data?.data.length === 0 ? (
            <div className="empty">
              <p>No runs yet.</p>
              <p className="muted">
                Add sample tickets, then kill the worker process while they run. Each run picks up
                where it stopped.
              </p>
            </div>
          ) : (
            <ol className="runs">
              {runs.data?.data.map((r) => (
                <li key={r.id}>
                  <button
                    type="button"
                    className={r.id === activeId ? 'run active' : 'run'}
                    onClick={() => setSelected(r.id)}
                  >
                    <span className={`dot ${r.status}`} aria-hidden="true" />
                    <span className="run-main">
                      <span className="run-title">{r.input.ticketId ?? r.id}</span>
                      <span className="run-sub">{r.input.message ?? r.agent}</span>
                    </span>
                    <span className="run-meta">
                      {r.attempts > 1 && (
                        <span
                          className="survived"
                          title="executions, including resumes after crashes or waits"
                        >
                          {r.attempts} executions
                        </span>
                      )}
                      <span className="status-text">{statusLabel(r.status)}</span>
                    </span>
                  </button>
                </li>
              ))}
            </ol>
          )}
        </section>

        <section className="detail" aria-label="Run detail">
          {activeId ? (
            <RunView id={activeId} />
          ) : (
            <p className="muted pad">Select a run to see its journal.</p>
          )}
        </section>
      </main>
    </div>
  )
}

function statusLabel(s: RunStatus): string {
  return {
    queued: 'Queued',
    running: 'Running',
    waiting: 'Waiting',
    succeeded: 'Done',
    failed: 'Failed',
    cancelled: 'Cancelled',
  }[s]
}

function Summary({ stats }: { stats: Stats | undefined }) {
  if (!stats) return <p className="summary muted">Connecting…</p>
  const total = Object.values(stats.runs).reduce((a, b) => a + b, 0)
  if (total === 0) return <p className="summary muted">No runs yet.</p>
  return (
    <p className="summary">
      <strong>{stats.recoveredRuns}</strong> of {total} runs survived a worker crash.{' '}
      <strong>{stats.llm.callsSaved}</strong> LLM calls ({stats.llm.tokensSaved.toLocaleString()}{' '}
      tokens) and <strong>{stats.effects.replayedNotRepeated}</strong> side effects were replayed
      from the journal instead of repeated.
    </p>
  )
}

function KeyPrompt() {
  const [key, setKey] = useState(getApiKey())
  const qc = useQueryClient()
  return (
    <form
      className="notice keyform"
      onSubmit={(e) => {
        e.preventDefault()
        setApiKey(key)
        void qc.invalidateQueries()
      }}
    >
      <label htmlFor="apikey">This server needs an API key to show runs.</label>
      <input
        id="apikey"
        type="password"
        value={key}
        onChange={(e) => setKey(e.target.value)}
        placeholder="API key"
      />
      <button type="submit">Use key</button>
    </form>
  )
}

function Approvals({ runs, onOpen }: { runs: Run[]; onOpen: (id: string) => void }) {
  const qc = useQueryClient()
  const decide = useMutation({
    mutationFn: ({ id, approved }: { id: string; approved: boolean }) =>
      post(`/v1/runs/${id}/events`, { name: 'approval', payload: { approved, by: 'dashboard' } }),
    onSuccess: () => void qc.invalidateQueries(),
  })
  return (
    <section className="approvals" aria-label="Waiting for approval">
      <h2>
        {runs.length === 1 ? '1 refund needs' : `${runs.length} refunds need`} a manager's approval
      </h2>
      <ul>
        {runs.map((r) => (
          <li key={r.id}>
            <button type="button" className="link" onClick={() => onOpen(r.id)}>
              {r.input.ticketId ?? r.id}
            </button>
            <span className="request">{r.request ?? `waiting for "${r.waitEvent}"`}</span>
            <span className="actions">
              <button
                type="button"
                className="approve"
                onClick={() => decide.mutate({ id: r.id, approved: true })}
              >
                Approve
              </button>
              <button type="button" onClick={() => decide.mutate({ id: r.id, approved: false })}>
                Decline
              </button>
            </span>
          </li>
        ))}
      </ul>
    </section>
  )
}

function RunView({ id }: { id: string }) {
  const qc = useQueryClient()
  const q = useQuery({ queryKey: ['run', id], queryFn: () => api<RunDetail>(`/v1/runs/${id}`) })
  const act = useMutation({
    mutationFn: (path: string) =>
      post(`/v1/runs/${id}/${path}`, path.startsWith('retry') ? {} : undefined),
    onSuccess: () => void qc.invalidateQueries(),
  })
  const retry = useMutation({
    mutationFn: (resolution?: 'assume_done' | 'retry_effect') =>
      post(`/v1/runs/${id}/retry`, resolution ? { resolution } : {}),
    onSuccess: () => void qc.invalidateQueries(),
  })

  if (q.isLoading) return <p className="muted pad">Loading…</p>
  if (q.error) return <p className="notice error">{q.error.message}</p>
  const run = q.data!
  const out = run.output as {
    decision?: string
    refundedCents?: number
    approvedBy?: string | null
  } | null

  return (
    <article className="runview">
      <header className="runhead">
        <div>
          <h2>{run.input.ticketId ?? run.id}</h2>
          {run.input.message && <blockquote>{run.input.message}</blockquote>}
          <p className="muted small">
            {run.agent}, {run.id}
          </p>
        </div>
        <div className="outcome">
          <span className={`pill ${run.status}`}>{statusLabel(run.status)}</span>
          {out?.decision && (
            <p>
              {out.decision === 'refund'
                ? `Refunded $${((out.refundedCents ?? 0) / 100).toFixed(2)}`
                : out.decision === 'decline'
                  ? 'Declined'
                  : 'Escalated to a person'}
              {out.approvedBy ? `, approved by ${out.approvedBy}` : ''}
            </p>
          )}
        </div>
      </header>

      <Tape timeline={run.timeline} />

      {run.savings.replayedSteps > 0 && (
        <p className="saved">
          Resuming replayed {run.savings.replayedSteps} finished step
          {run.savings.replayedSteps === 1 ? '' : 's'}: {run.savings.llmCallsSaved} LLM call
          {run.savings.llmCallsSaved === 1 ? '' : 's'} not re-billed
          {run.savings.tokensSaved ? ` (${run.savings.tokensSaved.toLocaleString()} tokens)` : ''},{' '}
          {run.savings.effectsNotRepeated} side effect
          {run.savings.effectsNotRepeated === 1 ? '' : 's'} not repeated.
        </p>
      )}

      {run.status === 'failed' && (
        <div className="failure">
          <p>
            <strong>
              {run.errorCode === 'ambiguous_effect' ? 'Needs a decision.' : 'This run stopped.'}
            </strong>{' '}
            {run.error}
          </p>
          {run.errorCode === 'ambiguous_effect' ? (
            <div className="actions">
              <button type="button" onClick={() => retry.mutate('assume_done')}>
                It happened: continue
              </button>
              <button type="button" onClick={() => retry.mutate('retry_effect')}>
                It didn't: try it again
              </button>
            </div>
          ) : (
            <button type="button" onClick={() => retry.mutate(undefined)}>
              Resume from the failed step
            </button>
          )}
        </div>
      )}

      <h3>Journal</h3>
      <ol className="journal">
        {run.steps.map((s) => (
          <li key={s.key} className={`step ${s.status}`}>
            <span className={`kind k-${s.kind}`}>{kindLabel(s.kind)}</span>
            <span className="step-key">{s.key}</span>
            <span className="step-note">{stepNote(s)}</span>
            <span className="step-time">{s.durationMs != null ? `${s.durationMs} ms` : ''}</span>
            {s.replays > 0 && (
              <span className="replay">
                replayed {s.replays === 1 ? 'once' : `${s.replays}×`}
                {s.kind === 'llm' ? ', not re-billed' : s.kind === 'tool' ? ', not repeated' : ''}
              </span>
            )}
            {s.error && <span className="step-error">{s.error}</span>}
          </li>
        ))}
        {run.steps.length === 0 && <li className="muted">No steps yet.</li>}
      </ol>

      {['queued', 'waiting', 'running'].includes(run.status) && (
        <button type="button" className="quiet" onClick={() => act.mutate('cancel')}>
          Cancel run
        </button>
      )}
    </article>
  )
}

function kindLabel(k: string): string {
  return { step: 'Read', llm: 'LLM', tool: 'Effect', sleep: 'Timer', event: 'Wait' }[k] ?? k
}

function stepNote(s: RunDetail['steps'][number]): string {
  if (s.kind === 'llm' && s.meta.model) {
    const tokens = Number(s.meta.inputTokens ?? 0) + Number(s.meta.outputTokens ?? 0)
    return `${s.meta.model}, ${tokens} tokens${Number(s.meta.repairs) > 0 ? `, ${s.meta.repairs} repair` : ''}`
  }
  if (s.kind === 'tool')
    return s.status === 'started' ? 'outcome unknown' : 'same idempotency key on every retry'
  if (s.kind === 'event') {
    if (s.status === 'started') return `waiting for "${s.meta.event}"`
    return s.meta.timedOut ? 'timed out' : `received "${s.meta.event}"`
  }
  if (s.status === 'failed') return `failed after ${s.attempts} tries`
  return s.attempts > 1 ? `succeeded on try ${s.attempts}` : ''
}
