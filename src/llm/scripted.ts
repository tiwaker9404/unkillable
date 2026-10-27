import { setTimeout as sleep } from 'node:timers/promises'
import { estimateTokens, type LlmProvider, type LlmRequest, type LlmResponse } from './types.ts'

/** A pure function from a chat request to what a well-behaved model would answer. */
export type ScriptedModel = (req: LlmRequest) => string

/**
 * Deterministic stand-in model. It simulates realistic latency and token counts, so CI, the
 * chaos test and the hosted demo run with zero API cost and reproducible results. Swap in a
 * real model with LLM_PROVIDER=openai (e.g. local Ollama) without touching agent code.
 */
export class ScriptedProvider implements LlmProvider {
  readonly name = 'scripted'
  readonly #model: ScriptedModel
  readonly #latency: [number, number]

  constructor(model: ScriptedModel, latencyMs: [number, number] = [150, 600]) {
    this.#model = model
    this.#latency = latencyMs
  }

  async complete(req: LlmRequest): Promise<LlmResponse> {
    const [lo, hi] = this.#latency
    const latencyMs = Math.round(lo + Math.random() * (hi - lo))
    await sleep(latencyMs, undefined, req.signal ? { signal: req.signal } : undefined)
    const text = this.#model(req)
    return {
      text,
      model: 'scripted-v1',
      inputTokens: estimateTokens(req.messages.map((m) => m.content).join('\n')),
      outputTokens: estimateTokens(text),
      latencyMs,
    }
  }
}
