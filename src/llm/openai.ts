import { estimateTokens, type LlmProvider, type LlmRequest, type LlmResponse } from './types.ts'

/**
 * Any OpenAI-compatible chat completions API: Ollama (free, local), OpenAI, Groq,
 * Together, vLLM, LM Studio... Point LLM_BASE_URL at it and set LLM_MODEL.
 */
export class OpenAICompatibleProvider implements LlmProvider {
  readonly name: string
  readonly #baseUrl: string
  readonly #model: string
  readonly #apiKey: string
  readonly #timeoutMs: number

  constructor(opts: { baseUrl: string; model: string; apiKey: string; timeoutMs: number }) {
    this.#baseUrl = opts.baseUrl.replace(/\/$/, '')
    this.#model = opts.model
    this.#apiKey = opts.apiKey
    this.#timeoutMs = opts.timeoutMs
    this.name = `openai-compatible:${opts.model}`
  }

  async complete(req: LlmRequest): Promise<LlmResponse> {
    const started = performance.now()
    const signal = req.signal
      ? AbortSignal.any([req.signal, AbortSignal.timeout(this.#timeoutMs)])
      : AbortSignal.timeout(this.#timeoutMs)
    const res = await fetch(`${this.#baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.#apiKey}`,
      },
      body: JSON.stringify({
        model: this.#model,
        messages: req.messages,
        temperature: req.temperature ?? 0,
        ...(req.json ? { response_format: { type: 'json_object' } } : {}),
      }),
      signal,
    })
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      throw new LlmHttpError(res.status, body.slice(0, 500))
    }
    const data = (await res.json()) as {
      model?: string
      choices: { message: { content: string } }[]
      usage?: { prompt_tokens?: number; completion_tokens?: number }
    }
    const text = data.choices[0]?.message.content ?? ''
    return {
      text,
      model: data.model ?? this.#model,
      inputTokens:
        data.usage?.prompt_tokens ?? estimateTokens(req.messages.map((m) => m.content).join('\n')),
      outputTokens: data.usage?.completion_tokens ?? estimateTokens(text),
      latencyMs: Math.round(performance.now() - started),
    }
  }
}

export class LlmHttpError extends Error {
  readonly status: number
  constructor(status: number, body: string) {
    super(`LLM API returned HTTP ${status}: ${body}`)
    this.status = status
  }
  /** 429 and 5xx are worth retrying; 4xx (bad model name, auth) are not */
  get retryable(): boolean {
    return this.status === 429 || this.status >= 500
  }
}
