import { providerFetch, ProviderError, type FetchLike, type TextProvider, type TextRequest, type TextResult } from './types';

/** Any OpenAI-compatible /chat/completions endpoint (OpenAI, OpenRouter, local servers, …). */
export class OpenAICompatibleTextProvider implements TextProvider {
  readonly id = 'openai-compatible';
  constructor(
    private apiKey: string,
    readonly model: string,
    private baseUrl = 'https://api.openai.com/v1',
    private fetchImpl: FetchLike = fetch,
  ) {}
  async generate(req: TextRequest): Promise<TextResult> {
    const res = await providerFetch(this.fetchImpl, this.id, `${this.baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      signal: req.signal,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify({
        model: this.model,
        temperature: req.temperature ?? 0.7,
        max_tokens: req.maxOutputTokens ?? 8192,
        messages: [
          { role: 'system', content: req.system },
          { role: 'user', content: req.prompt },
        ],
        ...(req.json ? { response_format: { type: 'json_object' } } : {}),
      }),
    });
    const data = (await res.json()) as { choices?: { message?: { content?: string } }[]; usage?: { prompt_tokens?: number; completion_tokens?: number } };
    const text = data.choices?.[0]?.message?.content ?? '';
    if (!text) throw new ProviderError('Provider returned an empty completion', this.id, true);
    return { text, inputTokens: data.usage?.prompt_tokens ?? 0, outputTokens: data.usage?.completion_tokens ?? 0, model: this.model };
  }
}
