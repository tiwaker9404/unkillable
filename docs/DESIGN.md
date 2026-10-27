# Design

This document explains how unkillable makes agent runs crash-proof, what it guarantees, and the trade-offs behind each choice.

## Goals

1. A worker can die at any instruction, and the run still finishes.
2. Finished LLM calls are never paid for twice.
3. Side effects happen exactly once when the downstream supports idempotency keys, and never silently twice when it doesn't.
4. Humans can pause a run (approvals) without holding a worker.
5. No infrastructure beyond the Postgres a team already runs.

Non-goals: millions of tiny tasks per second, cross-region replication, and workflow versioning beyond detecting nondeterminism.

## Data model

| Table     | Role                                                                                                                                                          |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `runs`    | One row per agent execution request. It doubles as the queue: status, `next_run_at`, lease token and expiry.                                                  |
| `steps`   | The journal. Keyed by `(run_id, key)` with a unique `seq` per run, it holds the output, attempts, replay count and metadata (tokens, model, idempotency key). |
| `events`  | Signals for waiting runs, such as an approval. Consumed exactly once.                                                                                         |
| `run_log` | A human-readable timeline: claimed, worker lost, replayed N steps, suspended, resumed. The dashboard tape is built from it.                                   |

Partial indexes keep the hot paths small: `runs (next_run_at) where status = 'queued'` for claiming, `runs (lease_expires_at) where status = 'running'` for the reaper, and `runs (wait_until) where status = 'waiting'` for timers.

## Claiming work

```sql
with ready as (
  select id from runs
  where status = 'queued' and next_run_at <= now()
  order by next_run_at
  limit $free_slots
  for update skip locked
)
update runs r set status = 'running', attempts = attempts + 1,
  lease_token = gen_random_uuid(), lease_expires_at = now() + $lease
from ready where r.id = ready.id
returning r.*
```

`SKIP LOCKED` means N workers polling the same table never block each other and never claim the same row. A worker claims exactly as many runs as it has free slots, so it never holds a lease it can't service. `pg_notify` inside the inserting transaction wakes workers the moment work is committed; a one-second poll is the fallback if a notification is missed.

## Leases, heartbeats and fencing

A run's lease (`LEASE_MS`, 30 s by default) is renewed every `LEASE_MS/3` by the executing worker. When a worker dies:

1. Its heartbeats stop and the lease expires.
2. The reaper, which runs inside every worker, flips the run back to `queued` and logs `worker_lost`.
3. The next worker claims it with a **new token** and replays the journal.

Expiry alone is not enough. A worker that is paused (a long GC, a frozen VM, a network partition) can wake up after its run has been taken over and try to write a result. Every journal write and every run-outcome write is therefore conditioned on the token:

```sql
insert into steps (...)
select ... where exists (
  select 1 from runs where id = $run and lease_token = $token and status = 'running'
)
```

A stale token writes nothing, and the zombie aborts (`LeaseLost`). If a heartbeat fails, the worker aborts the agent through an `AbortSignal` that agent code can pass to its own I/O. This is the fencing-token pattern from distributed locking; the integration test `resumes after a worker dies mid-run` freezes a worker, takes its run over, then proves the zombie's write is rejected.

Every crash counts as an attempt, so a run that reliably kills its worker (a poison input) fails after `RUN_MAX_ATTEMPTS` instead of looping forever.

## Replay

Each execution loads the run's journal and creates a `DurableContext`. Every `ctx.*` call:

1. takes the next sequence number and checks the journal at that position (the determinism guard),
2. returns the recorded output if the step completed, or
3. executes it and journals the result, fenced by the lease.

Outputs are JSON round-tripped on the first execution too. Without that, a first execution would see a `Date` while a replay sees a string, and agent code could branch differently.

### Determinism

Replay only works if the agent reaches the same steps in the same order. If the journal says step #3 was `issue-refund` and the code now calls `update-crm` at #3, the run fails with `non_determinism` rather than continuing on corrupt state. The usual causes are a deploy that changed the agent mid-run, or branching on `Date.now()` or `Math.random()` outside a step. Wrapping those in `ctx.step` records them.

## Side effects

The core problem: a worker can die after the refund API applied the refund but before the journal recorded it. On resume, the step looks unfinished.

**Idempotent mode (default).** The tool receives `unk_<runId>_<stepKey>`, a key that is identical on every execution of that run. The re-sent request carries the same key, and the downstream (Stripe and most payment and email APIs) returns the original result instead of acting again. In the benchmark, 166 re-sent effects were absorbed this way, and zero customers were refunded twice.

**At-most-once mode.** Some downstreams have no idempotency support: a legacy SOAP API, a fax, an SMS gateway. The context writes a `started` marker _before_ calling the tool. If a later execution finds `started` without `completed`, the outcome is unknown, so the run fails with `ambiguous_effect`. An operator then checks the downstream and calls `retry` with `assume_done` or `retry_effect`. Any error from the tool in this mode is treated the same way, because a timeout doesn't prove the effect didn't happen.

## Durable waits

`ctx.sleep` and `ctx.waitForEvent` record a deadline in the step's metadata, then throw an internal `Suspend`. The worker parks the run (`status = 'waiting'`) and releases the slot. The timer loop re-queues runs whose deadline passed, and `POST /events` re-queues runs waiting on that event name.

Two races are closed explicitly:

- **Lost approval.** Consuming an event and journaling it as the step's output happen in one transaction, so a crash between the two can't eat an approval.
- **Lost wakeup.** If an event arrives after the agent checked for it but before the run was parked, `postEvent` saw `running` and didn't wake it. `suspendRun` re-checks for pending events inside its transaction and re-queues immediately. Both paths lock the run row, so they serialize.

## LLM calls

`ctx.llm` journals the completion together with model, token counts and latency, so replay is free and the dashboard can report tokens saved. With a Zod schema, output is parsed and validated; invalid JSON or a schema violation is sent back to the model with the validation error, up to two repairs. Providers are pluggable: any OpenAI-compatible API, or a deterministic scripted model for tests and demos.

## Retries

There are two layers:

- **In-process:** a step retries transient errors (default 2 retries, jittered backoff) before giving up.
- **Run-level:** an error that escapes the agent reschedules the whole run with exponential backoff. Completed steps replay, so the expensive work before the failure is not redone. `NonRetryableError`, `non_determinism` and `ambiguous_effect` fail immediately.

Backoff uses "equal jitter" (half fixed, half random), which keeps a floor between retries while spreading out herds of failures.

## Why Postgres and not Redis, Kafka or SQS

- **Atomicity.** Claiming a run, journaling a step and consuming an event are ordinary transactions. With a separate broker, every one of those becomes a two-system consistency problem.
- **Zero new infrastructure.** Teams already run, back up and monitor Postgres.
- **Enough throughput for agents.** An agent step is an LLM or API call taking hundreds of milliseconds to seconds. The journal write is a small fraction of that.

The trade-off is a throughput ceiling far below a dedicated broker. Agent workloads are latency-bound on LLMs, not on the queue, so that ceiling is far away for this use case.

## What was measured

[bench/chaos.ts](../bench/chaos.ts) runs real worker processes against a sandbox that counts real side effects, SIGKILLs workers once per second, and has workers kill themselves right after side effects. It then compares the identical agent with the journal on and off. The results are in the README and `bench/results/`. The CI chaos test asserts zero duplicate refunds, emails and CRM notes on every push.
