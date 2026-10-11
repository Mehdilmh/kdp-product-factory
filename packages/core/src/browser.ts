/** Browser-safe subset of @kdp/core: schemas, specifications, geometry. No Node APIs. */
export * from './units';
export * from './specs/types';
export * from './specs/engine';
export { KDP_SPEC_2026_10 } from './specs/kdp-2026-10';
export * from './fonts/families';
export * from './interior/schema';
export { BUILT_IN_TEMPLATES, getTemplate } from './interior/templates';
export * from './cover/schema';
export * from './cover/geometry';
export { COVER_THEMES, starterCoverDesign } from './cover/starter';
export * from './metadata';
export * from './similarity';
export type { CheckResult, CheckStatus, PreflightReport, Severity, ContentClass } from './validation/result-types';
export * from './models/pricing';
export { EDITORIAL_TAGS, type EditorialTag } from './models/seed';
export type { ModelCapabilities, ImageTask, SizeOption } from './models/capabilities';
export * from './coloring';
