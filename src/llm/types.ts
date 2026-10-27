export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface LlmRequest {
  messages: ChatMessage[]
  /** ask the model for a JSON object (OpenAI `response_format: json_object`) */
  json?: boolean
  temperature?: number
  signal?: AbortSignal
}

export interface LlmResponse {
  text: string
  model: string
  inputTokens: number
  outputTokens: number
  latencyMs: number
}

export interface LlmProvider {
  readonly name: string
  complete(req: LlmRequest): Promise<LlmResponse>
}

/** Rough token estimate (~4 chars/token) for providers that don't report usage. */
export function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4))
}
