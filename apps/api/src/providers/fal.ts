import { imageSize } from '@kdp/core';
import { providerFetch, ProviderError, type FetchLike, type ImageProvider, type ImageRequest, type ImageResult } from './types';

/**
 * fal.ai synchronous endpoint. Used for cover/illustration *art only* — titles, author names,
 * spine text, and barcodes are always live text added by the cover editor.
 */
export class FalImageProvider implements ImageProvider {
  readonly id = 'fal';
  constructor(
    private apiKey: string,
    readonly model = 'fal-ai/flux/schnell',
    private fetchImpl: FetchLike = fetch,
    private baseUrl = 'https://fal.run',
  ) {}
  async generate(req: ImageRequest): Promise<ImageResult> {
    const res = await providerFetch(this.fetchImpl, this.id, `${this.baseUrl}/${this.model}`, {
      method: 'POST',
      signal: req.signal,
      headers: { 'content-type': 'application/json', authorization: `Key ${this.apiKey}` },
      body: JSON.stringify({ prompt: req.prompt, image_size: { width: req.widthPx, height: req.heightPx }, num_images: 1, enable_safety_checker: true }),
    });
    const data = (await res.json()) as { images?: { url?: string }[] };
    const url = data.images?.[0]?.url;
    if (!url) throw new ProviderError('fal.ai returned no image', this.id, true);
    if (!/^https:\/\//.test(url) && !url.startsWith('data:')) throw new ProviderError('fal.ai returned an unexpected image URL', this.id, false);
    let bytes: Uint8Array;
    if (url.startsWith('data:')) bytes = new Uint8Array(Buffer.from(url.split(',')[1], 'base64'));
    else bytes = new Uint8Array(await (await providerFetch(this.fetchImpl, this.id, url, { signal: req.signal })).arrayBuffer());
    const size = imageSize(bytes);
    if (!size) throw new ProviderError('fal.ai image is not a PNG or JPEG', this.id, false);
    return { bytes, mimeType: size.mimeType, model: this.model };
  }
}
