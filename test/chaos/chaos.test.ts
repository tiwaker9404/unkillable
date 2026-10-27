import { describe, expect, it } from 'vitest'
import { runChaos } from '../../bench/chaos.ts'

/**
 * The guarantee, tested end to end with real processes: workers are SIGKILLed at random and
 * right after side effects, and every refund, CRM note and email still happens exactly once.
 */
describe('chaos: SIGKILL workers mid-run', () => {
  it('durable mode completes every run with zero duplicate side effects', async () => {
    const r = await runChaos({
      mode: 'durable',
      runs: 40,
      workers: 3,
      killEveryMs: 700,
      selfKillProbability: 0.1,
      databaseUrl: process.env.TEST_DATABASE_URL!,
      timeoutMs: 150_000,
      seed: `ci-${Date.now()}`,
      quiet: true,
    })
    console.log(JSON.stringify(r, null, 2))

    expect(r.workerKills.external + r.workerKills.selfAfterSideEffect).toBeGreaterThan(5)
    expect(r.succeeded).toBe(r.runs)
    expect(r.refunds.doubleRefundedOrders).toBe(0)
    expect(r.refunds.extraDollars).toBe(0)
    expect(r.emails.customersEmailedTwice).toBe(0)
    expect(r.crmDuplicateNotes).toBe(0)
    // every ticket emailed exactly once
    expect(r.emails.sent).toBe(r.runs)
  }, 200_000)
})
