# Runbook

How to run unkillable in production and respond when something goes wrong.

## Deploying

- Run `node src/main.ts migrate` once per deploy, before the new version starts. The migrator takes an advisory lock, so it's safe if several replicas run it at once.
- Run API and workers as separate deployments (`api`, `worker`) so they scale independently. `all` is for development and small installs.
- Workers handle `SIGTERM` by finishing or parking in-flight runs, with up to 25 seconds of grace. Anything still running after that is abandoned and resumed by another worker once its lease expires. Set the orchestrator's termination grace period to at least 30 seconds.
- `LEASE_MS` must comfortably exceed your longest pause between heartbeats; the default of 30 s is generous. A shorter lease recovers crashed runs faster but risks false takeovers on an overloaded host. Fencing makes a false takeover safe, though it wastes work.

## Scaling

- Each worker executes `WORKER_CONCURRENCY` runs at once (default 16). Agent runs mostly wait on LLM and API calls, so concurrency per worker can be high. Watch event-loop lag in the default metrics before raising it.
- The total of `DB_POOL_SIZE` across replicas must stay under Postgres `max_connections`. A pooler such as PgBouncer works for API replicas, but workers need one direct connection each for `LISTEN`.

## Metrics worth alerting on

| Metric                                                 | Alert when           | Likely cause                                                     |
| ------------------------------------------------------ | -------------------- | ---------------------------------------------------------------- |
| `unkillable_queue_lag_seconds`                         | above 60 s for 5 min | Not enough workers, or workers stuck.                            |
| `unkillable_leases_reaped_total`                       | rate jumps           | Workers are crashing (OOM, bad deploy). Check worker restarts.   |
| `unkillable_leases_lost_total`                         | any sustained rate   | Heartbeats failing: database latency, or the lease is too short. |
| `unkillable_runs{status="failed"}`                     | rising               | See "Failed runs" below.                                         |
| `unkillable_execution_outcomes_total{outcome="error"}` | rising               | Downstream outage or an agent bug; runs are retrying.            |

## Failed runs

Open the run in the dashboard or call `GET /v1/runs/:id`, then go by `errorCode`:

- **`max_attempts`:** the run kept failing or kept killing workers. Read the timeline. Repeated `worker_lost` entries mean a poison input (for example, a payload that makes the worker run out of memory). Repeated `retry_scheduled` entries mean a downstream has been failing longer than the retry budget. Fix the cause, then `POST /v1/runs/:id/retry`; completed steps will not run again.
- **`non_determinism`:** the agent code changed under an in-flight run. If the change was intended, start a new run for the same input; this run's completed side effects are recorded in its journal, so check them first.
- **`ambiguous_effect`:** an at-most-once side effect started but its outcome is unknown. Check the downstream system:
  - It happened: `POST /v1/runs/:id/retry` with `{"resolution": "assume_done"}`.
  - It did not: `POST /v1/runs/:id/retry` with `{"resolution": "retry_effect"}`.
- **`non_retryable`:** the agent rejected the input (an order that doesn't exist, say). Usually nothing to do; tell the requester.

## Recovering after an outage

When a downstream like the payments API was down, runs fail after their retry budget. Once it's healthy, retry the affected runs:

```bash
curl -s "$URL/v1/runs?status=failed&limit=200" -H "Authorization: Bearer $KEY" \
  | jq -r '.data[] | select(.errorCode == "max_attempts") | .id' \
  | xargs -I{} curl -s -X POST "$URL/v1/runs/{}/retry" -H "Authorization: Bearer $KEY" -d '{}'
```

Each run resumes at its failed step; refunds already issued are not repeated.

## Data retention

The journal grows with every step. Delete finished runs past your retention window; `on delete cascade` removes their steps, events and timeline:

```sql
delete from runs where status in ('succeeded', 'cancelled') and completed_at < now() - interval '30 days';
```
