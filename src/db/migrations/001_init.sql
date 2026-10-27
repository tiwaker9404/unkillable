-- unkillable schema v1
-- runs  = one agent execution request (the queue: claimed with FOR UPDATE SKIP LOCKED)
-- steps = the checkpoint journal; a re-executed run replays completed steps from here
-- events = signals delivered to waiting runs (e.g. a manager approving a refund)
-- run_log = human-readable timeline (claimed, crashed, resumed, replayed N steps, ...)

create table runs (
  id                text primary key,
  agent             text not null,
  input             jsonb not null,
  status            text not null default 'queued'
                    check (status in ('queued', 'running', 'waiting', 'succeeded', 'failed', 'cancelled')),
  output            jsonb,
  error             text,
  error_code        text,
  idempotency_key   text unique,
  attempts          integer not null default 0,
  next_run_at       timestamptz not null default now(),
  lease_token       uuid,
  lease_expires_at  timestamptz,
  worker_id         text,
  wait_event        text,
  wait_until        timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  completed_at      timestamptz
);
-- hot path: only claimable rows, ordered by due time
create index runs_ready_idx on runs (next_run_at) where status = 'queued';
create index runs_lease_idx on runs (lease_expires_at) where status = 'running';
create index runs_wait_idx on runs (wait_until) where status = 'waiting';
create index runs_list_idx on runs (id desc);
create index runs_status_idx on runs (status, id desc);

create table steps (
  run_id        text not null references runs (id) on delete cascade,
  key           text not null,
  seq           integer not null,
  kind          text not null check (kind in ('step', 'llm', 'tool', 'sleep', 'event')),
  status        text not null check (status in ('started', 'completed', 'failed')),
  output        jsonb,
  error         text,
  attempts      integer not null default 1,
  replays       integer not null default 0,
  meta          jsonb not null default '{}',
  started_at    timestamptz not null default now(),
  completed_at  timestamptz,
  duration_ms   integer,
  primary key (run_id, key),
  unique (run_id, seq)
);

create table events (
  id          bigint generated always as identity primary key,
  run_id      text not null references runs (id) on delete cascade,
  name        text not null,
  payload     jsonb,
  consumed    boolean not null default false,
  created_at  timestamptz not null default now()
);
create index events_pending_idx on events (run_id, name) where not consumed;

create table run_log (
  id          bigint generated always as identity primary key,
  run_id      text not null references runs (id) on delete cascade,
  at          timestamptz not null default now(),
  kind        text not null,
  message     text not null,
  worker_id   text
);
create index run_log_run_idx on run_log (run_id, id);
