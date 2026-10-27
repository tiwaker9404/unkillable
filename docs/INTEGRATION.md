# Moving an existing agent onto unkillable

This guide walks through moving an existing agent onto unkillable, using a support agent as the example. Expect it to take about an hour for a typical agent.

## 1. Find the steps

List every operation your agent performs, then sort each one into a bucket:

| Your code does                                                                 | Wrap it in         | Why                                                                                          |
| ------------------------------------------------------------------------------ | ------------------ | -------------------------------------------------------------------------------------------- |
| Reads data (DB query, GET request, file read)                                  | `ctx.step`         | Replays the recorded result, so the agent sees the same data on resume.                      |
| Calls an LLM                                                                   | `ctx.llm`          | Replays the completion, so it isn't re-billed. Add a Zod `schema` if you parse JSON from it. |
| Changes something outside the agent (payment, email, CRM write, ticket update) | `ctx.tool`         | Hands you a stable idempotency key.                                                          |
| Waits for a person                                                             | `ctx.waitForEvent` | Parks the run without holding a worker.                                                      |
| Waits for time to pass                                                         | `ctx.sleep`        | A durable timer that survives restarts.                                                      |
| Reads the clock or random numbers that affect control flow                     | `ctx.step`         | Keeps replays deterministic.                                                                 |

Pure computation (formatting, arithmetic, string building) needs no wrapper.

## 2. Check each side effect for idempotency support

Every `ctx.tool` call needs one of these:

- **The API accepts an idempotency key.** Pass the key you're given; this is the default mode. Stripe (`Idempotency-Key` header), Adyen, and most modern payment and messaging APIs fall in this group.
- **The API lets you set your own ID or upsert by key**, as most CRMs and databases do. Use the key as the external ID: a second write with the same ID becomes an update, not a duplicate.
- **Neither.** Use `{ mode: 'at-most-once' }`. If a crash makes the outcome unknown, the run stops for an operator instead of guessing.

```ts
// Stripe
await ctx.tool('refund', (key) =>
  stripe.refunds.create({ payment_intent: pi, amount }, { idempotencyKey: key }),
)

// A CRM that upserts by external id
await ctx.tool('log-to-crm', (key) => crm.notes.upsert({ externalId: key, ticketId, body }))

// A legacy API with no idempotency at all
await ctx.tool('notify-warehouse', () => warehouse.send(order), { mode: 'at-most-once' })
```

## 3. Give every step a stable, unique key

Step keys are how replay matches code to journal. Use names that describe the step (`issue-refund`, not `step3`). Inside loops, derive the key from the item, not the loop index, so reordering the input can't shift keys:

```ts
for (const item of order.items) {
  await ctx.tool(`restock:${item.sku}`, (key) => inventory.restock(item, key))
}
```

## 4. Register the agent and start runs

```ts
const agents = registry(refundAgent, onboardingAgent)
const worker = new Worker(sql, config, logger, agents, llmProvider)
await worker.start()
```

Start runs from your app with an idempotency key tied to the business event, so a retried webhook or double-clicked button doesn't start the same work twice:

```bash
curl -X POST $URL/v1/runs \
  -H "Authorization: Bearer $KEY" -H "Idempotency-Key: ticket:T-1042" \
  -d '{"agent":"refund-agent","input":{...}}'
```

## 5. Prove it before going live

1. Run your agent's happy path and confirm each step appears in the journal (`GET /v1/runs/:id`).
2. Set `CHAOS_KILL_AFTER_EFFECT=0.3` on a staging worker. Workers will kill themselves right after side effects. Confirm the downstream shows each effect once.
3. Kill workers mid-run (`kill -9`) and confirm runs resume and the timeline shows `worker_lost` followed by `replayed`.
4. For a full benchmark, copy `bench/chaos.ts`, enqueue your agent's inputs instead of the sample tickets, and point the sandbox counters at your own staging downstreams.

## Common pitfalls

- **Branching on time outside a step.** `if (Date.now() > deadline)` can take a different branch on replay. Wrap it: `await ctx.step('now', async () => Date.now())`.
- **Mutating captured state.** A replayed step returns its recorded output; it does not re-run the function. Side effects inside a `ctx.step` body (pushing to an array outside it, say) won't happen on replay. Return values from steps instead.
- **Giant step outputs.** The output is stored as JSON. Store large blobs (PDFs, transcripts) in object storage and return a reference.
- **Changing agent code under in-flight runs.** Renaming or reordering steps fails those runs with `non_determinism`. Deploy new behavior under a new step key, or let in-flight runs drain first.
