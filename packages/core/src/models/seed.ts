import type { ImageTask } from './capabilities';

/**
 * Seed candidates for the fal.ai image catalog. These are NOT verified records: endpoint IDs
 * are candidates from the product brief and public documentation and are only enabled after a
 * catalog sync (`GET https://api.fal.ai/v1/models?endpoint_id=…&expand=openapi-3.0`) confirms
 * them and loads their schema. No prices are seeded — prices come only from fal's pricing API
 * or an administrator entry with a source URL.
 *
 * "Best for" tags are editorial suggestions (subjective) and are labelled as such in the UI.
 */
export interface SeedModel {
  endpointId: string;
  displayName: string;
  family: string;
  expectedTasks: ImageTask[];
  editorialTags: EditorialTag[];
  notes: string;
}

export const EDITORIAL_TAGS = ['concept-drafts', 'illustrated', 'photorealistic', 'typography', 'editing', 'reference-images', 'high-resolution', 'line-art', 'vector', 'upscaling'] as const;
export type EditorialTag = (typeof EDITORIAL_TAGS)[number];

const m = (endpointId: string, displayName: string, family: string, expectedTasks: ImageTask[], editorialTags: EditorialTag[], notes = ''): SeedModel => ({ endpointId, displayName, family, expectedTasks, editorialTags, notes });

export const SEED_MODELS: SeedModel[] = [
  m('fal-ai/nano-banana-2', 'Nano Banana 2', 'Google Nano Banana', ['text-to-image'], ['illustrated', 'typography'], 'Requested in the brief.'),
  m('fal-ai/nano-banana-2/edit', 'Nano Banana 2 Edit', 'Google Nano Banana', ['edit', 'reference'], ['editing', 'reference-images']),
  m('fal-ai/nano-banana-pro', 'Nano Banana Pro', 'Google Nano Banana', ['text-to-image'], ['typography', 'high-resolution']),
  m('fal-ai/nano-banana-pro/edit', 'Nano Banana Pro Edit', 'Google Nano Banana', ['edit', 'reference'], ['editing', 'reference-images']),
  m('fal-ai/nano-banana', 'Nano Banana', 'Google Nano Banana', ['text-to-image'], ['illustrated']),
  m('fal-ai/nano-banana/edit', 'Nano Banana Edit', 'Google Nano Banana', ['edit', 'reference'], ['editing', 'reference-images']),
  m('fal-ai/flux/schnell', 'FLUX.1 [schnell]', 'FLUX.1', ['text-to-image'], ['concept-drafts']),
  m('fal-ai/flux/dev', 'FLUX.1 [dev]', 'FLUX.1', ['text-to-image'], ['concept-drafts']),
  m('fal-ai/flux/dev/image-to-image', 'FLUX.1 [dev] Image-to-Image', 'FLUX.1', ['image-to-image'], ['editing']),
  m('fal-ai/flux-2/turbo', 'FLUX.2 [dev] Turbo', 'FLUX.2', ['text-to-image'], ['concept-drafts'], 'Candidate ID for "FLUX.2 [dev] Turbo".'),
  m('fal-ai/flux-2', 'FLUX.2 [dev]', 'FLUX.2', ['text-to-image'], ['illustrated']),
  m('fal-ai/flux-2/edit', 'FLUX.2 [dev] Edit', 'FLUX.2', ['edit', 'reference'], ['editing', 'reference-images']),
  m('fal-ai/flux-2-pro', 'FLUX.2 [pro]', 'FLUX.2', ['text-to-image'], ['photorealistic', 'high-resolution']),
  m('fal-ai/flux-2-pro/edit', 'FLUX.2 [pro] Edit', 'FLUX.2', ['edit', 'reference'], ['editing', 'reference-images']),
  m('fal-ai/flux-2-flex', 'FLUX.2 [flex]', 'FLUX.2', ['text-to-image'], ['typography']),
  m('fal-ai/flux-2-flex/edit', 'FLUX.2 [flex] Edit', 'FLUX.2', ['edit', 'reference'], ['editing']),
  m('fal-ai/flux-2-max', 'FLUX.2 [max]', 'FLUX.2', ['text-to-image'], ['photorealistic', 'high-resolution'], 'Candidate ID for "FLUX.2 [max]".'),
  m('fal-ai/flux-pro/kontext', 'FLUX.1 Kontext [pro]', 'FLUX Kontext', ['edit', 'reference'], ['editing', 'reference-images']),
  m('fal-ai/flux-pro/kontext/max', 'FLUX.1 Kontext [max]', 'FLUX Kontext', ['edit', 'reference'], ['editing']),
  m('fal-ai/flux-pro/v1/fill', 'FLUX.1 [pro] Fill', 'FLUX.1', ['inpaint'], ['editing'], 'Inpainting with a mask.'),
  m('fal-ai/bytedance/seedream/v4.5/text-to-image', 'Seedream V4.5', 'ByteDance Seedream', ['text-to-image'], ['high-resolution', 'illustrated']),
  m('fal-ai/bytedance/seedream/v4.5/edit', 'Seedream V4.5 Edit', 'ByteDance Seedream', ['edit', 'reference'], ['editing', 'reference-images']),
  m('fal-ai/recraft/v3/text-to-image', 'Recraft V3', 'Recraft', ['text-to-image'], ['illustrated', 'typography', 'line-art']),
  m('fal-ai/recraft/v3/image-to-image', 'Recraft V3 Image-to-Image', 'Recraft', ['image-to-image'], ['editing']),
  m('fal-ai/recraft/vectorize', 'Recraft Vectorize', 'Recraft', ['vector'], ['vector'], 'Raster → SVG conversion.'),
  m('fal-ai/recraft/upscale/crisp', 'Recraft Crisp Upscale', 'Recraft', ['upscale'], ['upscaling']),
  m('fal-ai/gpt-image-2', 'GPT Image 2', 'OpenAI GPT Image', ['text-to-image'], ['typography'], 'Candidate ID — GPT Image endpoints on fal may be token-priced or require your own OpenAI key.'),
  m('fal-ai/gpt-image-2/edit', 'GPT Image 2 Edit', 'OpenAI GPT Image', ['edit', 'reference'], ['editing']),
  m('fal-ai/ideogram/v3', 'Ideogram V3', 'Ideogram', ['text-to-image'], ['typography']),
  m('fal-ai/ideogram/v3/edit', 'Ideogram V3 Edit', 'Ideogram', ['inpaint', 'edit'], ['editing']),
  m('fal-ai/ideogram/v3/remix', 'Ideogram V3 Remix', 'Ideogram', ['image-to-image', 'reference'], ['reference-images']),
  m('fal-ai/clarity-upscaler', 'Clarity Upscaler', 'Upscalers', ['upscale'], ['upscaling']),
  m('fal-ai/esrgan', 'ESRGAN Upscaler', 'Upscalers', ['upscale'], ['upscaling']),
];

/** fal catalog categories synchronised for image work. */
export const SYNC_CATEGORIES = ['text-to-image', 'image-to-image'];
