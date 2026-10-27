import type { LogEntry } from './api.ts'

interface Segment {
  n: number
  start: string
  end: string | null
  worker: string | null
  ending: 'crash' | 'suspended' | 'retry' | 'succeeded' | 'failed' | 'lost' | 'live'
  note: string
  replayed: number
}

/** Fold the run log into executions: each claim starts one; a crash, wait or finish ends it. */
function segments(log: LogEntry[]): { segs: Segment[] } {
  const segs: Segment[] = []
  let cur: Segment | null = null
  for (const e of log) {
    if (e.kind === 'claimed') {
      cur = {
        n: segs.length + 1,
        start: e.at,
        end: null,
        worker: e.workerId,
        ending: 'live',
        note: '',
        replayed: 0,
      }
      segs.push(cur)
      continue
    }
    if (!cur) continue
    if (e.kind === 'replayed') cur.replayed = Number(e.message.match(/replayed (\d+)/)?.[1] ?? 0)
    const end = (ending: Segment['ending'], note: string) => {
      cur!.end = e.at
      cur!.ending = ending
      cur!.note = note
      cur = null
    }
    if (e.kind === 'worker_lost') end('crash', 'worker died')
    else if (e.kind === 'suspended')
      end(
        'suspended',
        e.message.replace(/ until .*$/, '').replace('waiting for event', 'parked until'),
      )
    else if (e.kind === 'retry_scheduled') end('retry', e.message.split(' — ')[0] ?? 'failed')
    else if (e.kind === 'succeeded') end('succeeded', 'finished')
    else if (e.kind === 'failed') end('failed', 'stopped')
    else if (e.kind === 'cancelled') end('failed', 'cancelled')
  }
  return { segs }
}

const short = (w: string | null) => (w ? w.split(':').slice(1, 2).join('') || w : '')

export function Tape({ timeline }: { timeline: LogEntry[] }) {
  const { segs } = segments(timeline)
  if (segs.length === 0) return <div className="tape empty-tape">Waiting for a worker…</div>
  const crashes = segs.filter((s) => s.ending === 'crash').length

  return (
    <figure className="tape-wrap">
      <figcaption>
        {segs.length === 1
          ? 'One execution.'
          : `${segs.length} executions${crashes ? `, ${crashes} cut short by a dying worker` : ''}.`}
      </figcaption>
      <ol className="tape">
        {segs.map((s) => (
          <li key={s.n} className={`seg ${s.ending}`}>
            <span className="seg-n">#{s.n}</span>
            <span className="seg-body">
              {s.replayed > 0 && <span className="seg-replay">replayed {s.replayed}</span>}
              <span className="seg-note">{s.ending === 'live' ? 'executing' : s.note}</span>
            </span>
            <span className="seg-worker" title={s.worker ?? ''}>
              pid {short(s.worker)}
            </span>
          </li>
        ))}
      </ol>
    </figure>
  )
}
