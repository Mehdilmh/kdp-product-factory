/**
 * Test fixtures shaped like fal's `expand=openapi-3.0` documents (queue submit POST + result GET,
 * component $refs, OpenAPI 3.0 `nullable`). They are synthetic — not copies of real model schemas.
 */
export function falOpenApi(endpointId: string, inputProps: Record<string, unknown>, required: string[] = ['prompt']) {
  return {
    openapi: '3.0.4',
    info: { title: endpointId, version: '1.0.0' },
    paths: {
      [`/${endpointId}`]: {
        post: {
          requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/Input' } } } },
          responses: { '200': { description: 'queued', content: { 'application/json': { schema: { $ref: '#/components/schemas/QueueStatus' } } } } },
        },
      },
      [`/${endpointId}/requests/{request_id}`]: {
        get: { responses: { '200': { description: 'result', content: { 'application/json': { schema: { $ref: '#/components/schemas/Output' } } } } } },
      },
      [`/${endpointId}/requests/{request_id}/status`]: { get: { responses: {} } },
    },
    components: {
      schemas: {
        Input: { type: 'object', properties: inputProps, required },
        ImageSize: { type: 'object', properties: { width: { type: 'integer', maximum: 14142 }, height: { type: 'integer', maximum: 14142 } } },
        Image: { type: 'object', properties: { url: { type: 'string' }, width: { type: 'integer' }, height: { type: 'integer' }, content_type: { type: 'string' } } },
        Output: { type: 'object', properties: { images: { type: 'array', items: { $ref: '#/components/schemas/Image' } }, seed: { type: 'integer' } } },
        QueueStatus: { type: 'object', properties: { request_id: { type: 'string' } } },
      },
    },
  };
}

export const SCHNELL_LIKE = falOpenApi('fal-ai/flux/schnell', {
  prompt: { type: 'string', description: 'The prompt' },
  image_size: { anyOf: [{ $ref: '#/components/schemas/ImageSize' }, { type: 'string', enum: ['square_hd', 'square', 'portrait_4_3', 'portrait_16_9', 'landscape_4_3', 'landscape_16_9'] }], default: 'landscape_4_3' },
  num_images: { type: 'integer', minimum: 1, maximum: 4, default: 1 },
  seed: { type: 'integer', nullable: true },
  enable_safety_checker: { type: 'boolean', default: true },
  output_format: { type: 'string', enum: ['jpeg', 'png'] },
});

export const BANANA_EDIT_LIKE = falOpenApi(
  'fal-ai/nano-banana-2/edit',
  {
    prompt: { type: 'string' },
    image_urls: { type: 'array', items: { type: 'string' }, maxItems: 4 },
    aspect_ratio: { type: 'string', enum: ['1:1', '3:4', '4:3', '2:3', '3:2', '9:16', '16:9'] },
    resolution: { type: 'string', enum: ['1K', '2K', '4K'] },
    num_images: { type: 'integer', minimum: 1, maximum: 4 },
  },
  ['prompt', 'image_urls'],
);

export const FILL_LIKE = falOpenApi('fal-ai/flux-pro/v1/fill', { prompt: { type: 'string' }, image_url: { type: 'string' }, mask_url: { type: 'string' } }, ['prompt', 'image_url', 'mask_url']);
