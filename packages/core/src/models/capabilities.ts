import Ajv, { type ErrorObject } from 'ajv';
import addFormats from 'ajv-formats';

/**
 * Capabilities are derived from each model's own OpenAPI input schema (fal Platform API,
 * `expand=openapi-3.0`). A setting is only offered when the schema declares it — models are
 * never assumed to share parameters.
 */

export type JsonSchema = {
  type?: string | string[];
  properties?: Record<string, JsonSchema>;
  required?: string[];
  enum?: unknown[];
  default?: unknown;
  minimum?: number;
  maximum?: number;
  items?: JsonSchema;
  anyOf?: JsonSchema[];
  oneOf?: JsonSchema[];
  allOf?: JsonSchema[];
  $ref?: string;
  title?: string;
  description?: string;
  nullable?: boolean;
  format?: string;
  maxItems?: number;
  minItems?: number;
  [k: string]: unknown;
};

export const IMAGE_TASKS = ['text-to-image', 'image-to-image', 'edit', 'reference', 'inpaint', 'outpaint', 'vector', 'upscale', 'high-resolution'] as const;
export type ImageTask = (typeof IMAGE_TASKS)[number];

export interface SizeOption {
  value: string;
  widthPx: number | null;
  heightPx: number | null;
  /** True when dimensions come from fal's documented preset table rather than the schema. */
  assumed: boolean;
}

export interface ModelCapabilities {
  promptParam: string | null;
  negativePromptParam: string | null;
  /** `image_size` style parameter: enum presets and/or a custom {width,height} object. */
  imageSize: { param: string; presets: SizeOption[]; allowsCustom: boolean; maxDimension: number | null } | null;
  aspectRatio: { param: string; values: string[] } | null;
  resolution: { param: string; values: string[] } | null;
  numImages: { param: string; min: number; max: number } | null;
  /** Single reference/source image URL parameter (image-to-image / editing). */
  imageUrlParam: string | null;
  /** Multiple reference images. */
  imageUrlsParam: { param: string; maxItems: number | null } | null;
  maskParam: string | null;
  seedParam: string | null;
  outputFormat: { param: string; values: string[] } | null;
  quality: { param: string; values: string[] } | null;
  safetyCheckerParam: string | null;
  /** Upscale factor parameter, when the model is an upscaler. */
  scaleParam: string | null;
  requiredParams: string[];
  /** All declared input properties (for display and the advanced form). */
  properties: { name: string; type: string; description: string; enumValues: string[] | null; default: unknown }[];
  tasks: ImageTask[];
  /** How each task was determined. */
  taskEvidence: Record<string, string>;
}

/** fal's documented `image_size` presets (fal Model API docs). Marked as assumptions. */
export const FAL_IMAGE_SIZE_PRESETS: Record<string, [number, number]> = {
  square_hd: [1024, 1024],
  square: [512, 512],
  portrait_4_3: [768, 1024],
  portrait_16_9: [576, 1024],
  landscape_4_3: [1024, 768],
  landscape_16_9: [1024, 576],
};

function resolveRef(root: Record<string, unknown>, ref: string): JsonSchema | null {
  if (!ref.startsWith('#/')) return null;
  let cur: unknown = root;
  for (const part of ref.slice(2).split('/')) {
    if (cur && typeof cur === 'object') cur = (cur as Record<string, unknown>)[part.replace(/~1/g, '/').replace(/~0/g, '~')];
    else return null;
  }
  return (cur as JsonSchema) ?? null;
}

/** Inline local $refs and merge allOf (depth-limited) so the schema is self-contained. */
export function derefSchema(root: Record<string, unknown>, s: JsonSchema | undefined, depth = 0): JsonSchema {
  if (!s || depth > 12) return {};
  if (s.$ref) return derefSchema(root, resolveRef(root, s.$ref) ?? {}, depth + 1);
  const out: JsonSchema = { ...s };
  if (s.allOf) {
    delete out.allOf;
    for (const part of s.allOf) {
      const d = derefSchema(root, part, depth + 1);
      out.properties = { ...(out.properties ?? {}), ...(d.properties ?? {}) };
      out.required = [...new Set([...(out.required ?? []), ...(d.required ?? [])])];
      if (d.type && !out.type) out.type = d.type;
    }
  }
  if (out.properties) out.properties = Object.fromEntries(Object.entries(out.properties).map(([k, v]) => [k, derefSchema(root, v, depth + 1)]));
  if (out.items) out.items = derefSchema(root, out.items, depth + 1);
  if (out.anyOf) out.anyOf = out.anyOf.map((x) => derefSchema(root, x, depth + 1));
  if (out.oneOf) out.oneOf = out.oneOf.map((x) => derefSchema(root, x, depth + 1));
  return out;
}

/** Find the request-body schema of the model's POST operation in a fal OpenAPI document. */
export function extractIoSchemas(openapi: Record<string, unknown>): { input: JsonSchema | null; output: JsonSchema | null } {
  const paths = (openapi.paths ?? {}) as Record<string, Record<string, Record<string, unknown>>>;
  for (const [path, ops] of Object.entries(paths)) {
    const post = ops?.post;
    if (!post) continue;
    if (/\/requests\//.test(path)) continue; // queue status/result routes
    const body = (post.requestBody as { content?: Record<string, { schema?: JsonSchema }> } | undefined)?.content?.['application/json']?.schema;
    if (!body) continue;
    const input = derefSchema(openapi, body);
    // Output: prefer the queue result route, else the POST 200 response.
    let output: JsonSchema | null = null;
    for (const [p2, ops2] of Object.entries(paths)) {
      if (/\/requests\/\{request_id\}$/.test(p2) && ops2?.get) {
        const s = ((ops2.get.responses as Record<string, { content?: Record<string, { schema?: JsonSchema }> }>)?.['200']?.content?.['application/json']?.schema);
        if (s) output = derefSchema(openapi, s);
      }
    }
    if (!output) {
      const s = ((post.responses as Record<string, { content?: Record<string, { schema?: JsonSchema }> }>)?.['200']?.content?.['application/json']?.schema);
      if (s) output = derefSchema(openapi, s);
    }
    return { input, output };
  }
  return { input: null, output: null };
}

const typeOf = (s: JsonSchema): string => {
  if (s.enum) return 'enum';
  if (Array.isArray(s.type)) return s.type.join('|');
  if (s.type) return s.type;
  if (s.anyOf) return s.anyOf.map(typeOf).join('|');
  return 'unknown';
};
const enumValues = (s: JsonSchema | undefined): string[] | null => {
  if (!s) return null;
  if (s.enum) return s.enum.map(String);
  const alt = [...(s.anyOf ?? []), ...(s.oneOf ?? [])].find((x) => x.enum);
  return alt?.enum ? alt.enum.map(String) : null;
};
const pick = (props: Record<string, JsonSchema>, names: string[]) => names.find((n) => n in props) ?? null;

export function deriveCapabilities(input: JsonSchema | null, ctx: { endpointId: string; category?: string | null; displayName?: string | null }): ModelCapabilities {
  const props = input?.properties ?? {};
  const required = input?.required ?? [];
  const tasks = new Set<ImageTask>();
  const ev: Record<string, string> = {};
  const add = (t: ImageTask, why: string) => {
    tasks.add(t);
    ev[t] = ev[t] ?? why;
  };

  const sizeParam = pick(props, ['image_size']);
  let imageSize: ModelCapabilities['imageSize'] = null;
  if (sizeParam) {
    const s = props[sizeParam];
    const presets = enumValues(s) ?? [];
    const custom = [s, ...(s.anyOf ?? []), ...(s.oneOf ?? [])].find((x) => x.properties?.width && x.properties?.height);
    const maxDim = (custom?.properties?.width?.maximum as number | undefined) ?? null;
    imageSize = {
      param: sizeParam,
      presets: presets.map((p) => {
        const d = FAL_IMAGE_SIZE_PRESETS[p];
        return { value: p, widthPx: d?.[0] ?? null, heightPx: d?.[1] ?? null, assumed: !!d };
      }),
      allowsCustom: !!custom,
      maxDimension: maxDim,
    };
  }
  const arParam = pick(props, ['aspect_ratio']);
  const resParam = pick(props, ['resolution']);
  const nParam = pick(props, ['num_images', 'num_outputs', 'n']);
  const imgParam = pick(props, ['image_url', 'input_image_url', 'source_image_url']);
  const imgsParam = pick(props, ['image_urls', 'reference_image_urls', 'input_image_urls', 'reference_images']);
  const maskParam = pick(props, ['mask_url', 'mask_image_url', 'mask']);
  const scaleParam = pick(props, ['upscale_factor', 'scale', 'upscaling_factor']);
  const ofParam = pick(props, ['output_format']);
  const qParam = pick(props, ['quality']);

  const id = ctx.endpointId.toLowerCase();
  const name = (ctx.displayName ?? '').toLowerCase();
  const cat = (ctx.category ?? '').toLowerCase();
  if (cat === 'text-to-image') add('text-to-image', 'catalog category text-to-image');
  if (cat === 'image-to-image') add('image-to-image', 'catalog category image-to-image');
  if (!cat && props.prompt && !imgParam && !imgsParam) add('text-to-image', 'schema: prompt without input image');
  if (imgParam || imgsParam) add('image-to-image', `schema: ${imgParam ?? imgsParam} parameter`);
  if (/edit/.test(id) || /edit/.test(name)) add('edit', 'endpoint name contains "edit"');
  if (imgsParam) add('reference', `schema: ${imgsParam} (multiple reference images)`);
  if (maskParam) add('inpaint', `schema: ${maskParam} parameter`);
  if (/outpaint|expand/.test(id)) add('outpaint', 'endpoint name indicates outpainting/expansion');
  if (/vector|svg/.test(id) || /vector|svg/.test(name)) add('vector', 'endpoint/model name indicates vector output');
  if (/upscal|esrgan|clarity|super-?res/.test(id) || scaleParam) add('upscale', scaleParam ? `schema: ${scaleParam}` : 'endpoint name indicates upscaling');
  const res = enumValues(resParam ? props[resParam] : undefined) ?? [];
  if (res.some((r) => /^(2k|4k)$/i.test(r)) || (imageSize?.maxDimension ?? 0) >= 2048) add('high-resolution', res.length ? `schema: resolution ${res.join('/')}` : `schema: width up to ${imageSize?.maxDimension}px`);

  const nSchema = nParam ? props[nParam] : undefined;
  return {
    promptParam: pick(props, ['prompt']),
    negativePromptParam: pick(props, ['negative_prompt']),
    imageSize,
    aspectRatio: arParam ? { param: arParam, values: enumValues(props[arParam]) ?? [] } : null,
    resolution: resParam ? { param: resParam, values: res } : null,
    numImages: nParam ? { param: nParam, min: (nSchema?.minimum as number) ?? 1, max: (nSchema?.maximum as number) ?? 1 } : null,
    imageUrlParam: imgParam,
    imageUrlsParam: imgsParam ? { param: imgsParam, maxItems: (props[imgsParam].maxItems as number | undefined) ?? null } : null,
    maskParam,
    seedParam: pick(props, ['seed']),
    outputFormat: ofParam ? { param: ofParam, values: enumValues(props[ofParam]) ?? [] } : null,
    quality: qParam && enumValues(props[qParam]) ? { param: qParam, values: enumValues(props[qParam])! } : null,
    safetyCheckerParam: pick(props, ['enable_safety_checker']),
    scaleParam,
    requiredParams: required,
    properties: Object.entries(props).map(([n, s]) => ({ name: n, type: typeOf(s), description: String(s.description ?? '').slice(0, 300), enumValues: enumValues(s), default: s.default ?? null })),
    tasks: [...tasks],
    taskEvidence: ev,
  };
}

/* ------------------------------------------------------------------------------------------ */
/* Normalised request → model-specific input                                                   */
/* ------------------------------------------------------------------------------------------ */

export interface NormalizedImageRequest {
  prompt: string;
  negativePrompt?: string | null;
  /** Desired output aspect (width / height). */
  aspect?: number | null;
  /** Exact size when the model accepts custom sizes. */
  widthPx?: number | null;
  heightPx?: number | null;
  /** Explicit preset / enum choices from the UI. */
  imageSizePreset?: string | null;
  aspectRatio?: string | null;
  resolution?: string | null;
  quality?: string | null;
  numImages: number;
  imageUrl?: string | null;
  imageUrls?: string[];
  maskUrl?: string | null;
  seed?: number | null;
  outputFormat?: string | null;
  /** Advanced, schema-validated extras (only declared properties are accepted). */
  extra?: Record<string, unknown>;
}

export interface BuiltInput {
  input: Record<string, unknown>;
  errors: string[];
  /** Expected output size for pricing (null when unknown). */
  expectedWidthPx: number | null;
  expectedHeightPx: number | null;
  dimensionsAreAssumed: boolean;
  imagesPerRequest: number;
}

const ratioOf = (r: string) => {
  const m = r.match(/^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/);
  return m ? Number(m[1]) / Number(m[2]) : null;
};

export function nearestAspectRatio(values: string[], aspect: number): string | null {
  let best: string | null = null;
  let bestD = Infinity;
  for (const v of values) {
    const r = ratioOf(v);
    if (r === null) continue;
    const d = Math.abs(Math.log(r / aspect));
    if (d < bestD) {
      bestD = d;
      best = v;
    }
  }
  return best;
}

const ajv = new Ajv({ strict: false, allErrors: true, coerceTypes: false, useDefaults: false });
addFormats(ajv);
const validators = new WeakMap<object, ReturnType<typeof ajv.compile>>();

/** Convert OpenAPI 3.0 `nullable` into JSON-Schema type unions for validation. */
function toJsonSchema(s: JsonSchema): JsonSchema {
  const c: JsonSchema = { ...s };
  if (c.nullable && typeof c.type === 'string') c.type = [c.type, 'null'];
  delete c.nullable;
  for (const k of ['example', 'examples', 'x-fal-order-properties', 'ui', 'discriminator', 'xml', 'externalDocs']) delete c[k];
  if (c.properties) c.properties = Object.fromEntries(Object.entries(c.properties).map(([k, v]) => [k, toJsonSchema(v)]));
  if (c.items) c.items = toJsonSchema(c.items);
  if (c.anyOf) c.anyOf = c.anyOf.map(toJsonSchema);
  if (c.oneOf) c.oneOf = c.oneOf.map(toJsonSchema);
  return c;
}

export function validateAgainstSchema(schema: JsonSchema, input: Record<string, unknown>): string[] {
  let v = validators.get(schema);
  if (!v) {
    v = ajv.compile(toJsonSchema(schema));
    validators.set(schema, v);
  }
  if (v(input)) return [];
  return (v.errors ?? []).slice(0, 10).map((e: ErrorObject) => `${e.instancePath || '(input)'} ${e.message}`);
}

/**
 * Builds the input object for a specific model. Settings the model does not declare are
 * rejected with an error rather than silently sent.
 */
export function buildModelInput(caps: ModelCapabilities, schema: JsonSchema | null, req: NormalizedImageRequest): BuiltInput {
  const input: Record<string, unknown> = {};
  const errors: string[] = [];
  let w: number | null = null;
  let h: number | null = null;
  let assumed = false;

  if (caps.promptParam) input[caps.promptParam] = req.prompt;
  else if (req.prompt) errors.push('This model does not accept a text prompt.');
  if (req.negativePrompt) {
    if (caps.negativePromptParam) input[caps.negativePromptParam] = req.negativePrompt;
    else errors.push('This model does not support a negative prompt.');
  }

  if (caps.imageSize) {
    const is = caps.imageSize;
    if (req.imageSizePreset) {
      const p = is.presets.find((x) => x.value === req.imageSizePreset);
      if (!p) errors.push(`Unsupported image size preset "${req.imageSizePreset}".`);
      else {
        input[is.param] = p.value;
        w = p.widthPx;
        h = p.heightPx;
        assumed = p.assumed;
      }
    } else if (req.widthPx && req.heightPx && is.allowsCustom) {
      if (is.maxDimension && Math.max(req.widthPx, req.heightPx) > is.maxDimension) errors.push(`Requested size exceeds the model maximum of ${is.maxDimension}px.`);
      input[is.param] = { width: req.widthPx, height: req.heightPx };
      w = req.widthPx;
      h = req.heightPx;
    } else if (req.aspect && is.presets.length) {
      let best = is.presets[0];
      for (const p of is.presets) if (p.widthPx && p.heightPx && best.widthPx && best.heightPx && Math.abs(Math.log(p.widthPx / p.heightPx / req.aspect)) < Math.abs(Math.log(best.widthPx / best.heightPx / req.aspect))) best = p;
      input[is.param] = best.value;
      w = best.widthPx;
      h = best.heightPx;
      assumed = best.assumed;
    }
  } else if (req.widthPx || req.imageSizePreset) {
    if (!caps.aspectRatio && !caps.resolution) errors.push('This model does not accept an output size; it chooses its own dimensions.');
  }
  if (caps.aspectRatio) {
    const v = req.aspectRatio ?? (req.aspect ? nearestAspectRatio(caps.aspectRatio.values, req.aspect) : null);
    if (v) {
      if (caps.aspectRatio.values.length && !caps.aspectRatio.values.includes(v)) errors.push(`Unsupported aspect ratio "${v}".`);
      else input[caps.aspectRatio.param] = v;
    }
  } else if (req.aspectRatio) errors.push('This model does not accept an aspect ratio.');
  if (req.resolution) {
    if (caps.resolution && caps.resolution.values.includes(req.resolution)) input[caps.resolution.param] = req.resolution;
    else errors.push(`Resolution "${req.resolution}" is not supported by this model.`);
  }
  if (req.quality) {
    if (caps.quality?.values.includes(req.quality)) input[caps.quality.param] = req.quality;
    else errors.push(`Quality "${req.quality}" is not supported by this model.`);
  }
  let perRequest = 1;
  if (caps.numImages) {
    perRequest = Math.max(caps.numImages.min, Math.min(caps.numImages.max, req.numImages));
    input[caps.numImages.param] = perRequest;
  }
  if (req.imageUrl) {
    if (caps.imageUrlParam) input[caps.imageUrlParam] = req.imageUrl;
    else if (caps.imageUrlsParam) input[caps.imageUrlsParam.param] = [req.imageUrl];
    else errors.push('This model does not accept an input image.');
  }
  if (req.imageUrls?.length) {
    if (!caps.imageUrlsParam) errors.push('This model does not accept multiple reference images.');
    else if (caps.imageUrlsParam.maxItems && req.imageUrls.length > caps.imageUrlsParam.maxItems) errors.push(`At most ${caps.imageUrlsParam.maxItems} reference images are allowed.`);
    else input[caps.imageUrlsParam.param] = [...((input[caps.imageUrlsParam.param] as string[]) ?? []), ...req.imageUrls];
  }
  if (req.maskUrl) {
    if (caps.maskParam) input[caps.maskParam] = req.maskUrl;
    else errors.push('This model does not support masks (inpainting).');
  }
  if (req.seed !== null && req.seed !== undefined && caps.seedParam) input[caps.seedParam] = req.seed;
  if (req.outputFormat) {
    if (caps.outputFormat?.values.includes(req.outputFormat)) input[caps.outputFormat.param] = req.outputFormat;
    else errors.push(`Output format "${req.outputFormat}" is not supported.`);
  }
  // Resolution tiers such as "1K/2K/4K" with an aspect ratio: approximate size for pricing only.
  if (!w && req.resolution && /^\d(?:\.\d)?K$/i.test(req.resolution)) {
    const longSide = Math.round(parseFloat(req.resolution) * 1024);
    const ar = req.aspectRatio ? ratioOf(req.aspectRatio) : req.aspect ?? 1;
    if (ar) {
      w = ar >= 1 ? longSide : Math.round(longSide * ar);
      h = ar >= 1 ? Math.round(longSide / ar) : longSide;
      assumed = true;
    }
  }
  for (const [k, v] of Object.entries(req.extra ?? {})) {
    if (!caps.properties.some((p) => p.name === k)) errors.push(`Unknown parameter "${k}" for this model.`);
    else input[k] = v;
  }
  for (const r of caps.requiredParams) if (!(r in input)) errors.push(`Required parameter "${r}" is missing.`);
  if (schema && !errors.length) errors.push(...validateAgainstSchema(schema, input));
  return { input, errors, expectedWidthPx: w, expectedHeightPx: h, dimensionsAreAssumed: assumed, imagesPerRequest: perRequest };
}
