import { providerFetch, ProviderError, type FetchLike, type TextProvider, type TextRequest, type TextResult } from './types';

/** Google Gemini via the Generative Language REST API. The key never leaves the server. */
export class GeminiTextProvider implements TextProvider {
  readonly id = 'gemini';
  constructor(
    private apiKey: string,
    readonly model = 'gemini-2.5-flash',
    private fetchImpl: FetchLike = fetch,
    private baseUrl = 'https://generativelanguage.googleapis.com/v1beta',
  ) {}
  async generate(req: TextRequest): Promise<TextResult> {
    const res = await providerFetch(this.fetchImpl, this.id, `${this.baseUrl}/models/${encodeURIComponent(this.model)}:generateContent`, {
      method: 'POST',
      signal: req.signal,
      headers: { 'content-type': 'application/json', 'x-goog-api-key': this.apiKey },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: req.system }] },
        contents: [{ role: 'user', parts: [{ text: req.prompt }] }],
        generationConfig: { temperature: req.temperature ?? 0.7, maxOutputTokens: req.maxOutputTokens ?? 8192, ...(req.json ? { responseMimeType: 'application/json' } : {}) },
      }),
    });
    const data = (await res.json()) as {
      candidates?: { content?: { parts?: { text?: string }[] }; finishReason?: string }[];
      usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
      promptFeedback?: { blockReason?: string };
    };
    if (data.promptFeedback?.blockReason) throw new ProviderError(`Gemini blocked the prompt: ${data.promptFeedback.blockReason}`, this.id, false);
    const text = data.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('') ?? '';
    if (!text) throw new ProviderError(`Gemini returned no text (finishReason: ${data.candidates?.[0]?.finishReason ?? 'unknown'})`, this.id, true);
    return { text, inputTokens: data.usageMetadata?.promptTokenCount ?? 0, outputTokens: data.usageMetadata?.candidatesTokenCount ?? 0, model: this.model };
  }
}
