import type { CostEstimate } from '@kdp/core/browser';

export interface QcCheck {
  id: string;
  label: string;
  kind: 'AUTOMATED' | 'HEURISTIC' | 'MANUAL';
  status: 'PASS' | 'WARN' | 'FAIL' | 'MANUAL';
  message: string;
}
export interface PageVersion {
  id: string;
  version: number;
  source: 'AI' | 'UPLOAD' | 'MOCK';
  prompt: string;
  negativePrompt: string;
  modelId: string | null;
  originalAssetId: string;
  processedAssetId: string | null;
  processing: { options: Record<string, unknown>; steps: string[]; at: string } | null;
  qc: { checks: QcCheck[]; metrics: Record<string, unknown>; summary: { fail: number; warn: number; manual: number } } | null;
  estimatedCostUsd: string | null;
  actualCostUsd: string | null;
  createdAt: string;
}
export interface ColoringPage {
  id: string;
  position: number;
  concept: string;
  prompt: string;
  negativePrompt: string;
  promptEdited: boolean;
  status: 'PLANNED' | 'QUEUED' | 'GENERATING' | 'NEEDS_REVIEW' | 'APPROVED' | 'REJECTED' | 'FAILED';
  favorite: boolean;
  notes: string;
  error: string | null;
  currentVersionId: string | null;
  qcOverride: { checks: string[]; note: string; at: string } | null;
  versions: PageVersion[];
  current: PageVersion | null;
  similarTo: { pageId: string; position: number; distance: number }[];
}
export interface StyleProfile {
  name: string;
  styleId: string;
  outlineThickness: 'THIN' | 'MEDIUM' | 'THICK' | 'EXTRA_THICK';
  detail: string;
  complexity: string;
  subjectSize: string;
  whiteSpace: string;
  subjects: string;
  background: string;
  composition: string;
  aspect: string;
  extraDirection: string;
  referenceAssetIds: string[];
}
export interface InteriorSettings {
  singleSided: boolean;
  scale: number;
  verticalAlign: 'top' | 'center' | 'bottom';
  pageNumbers: boolean;
  titlePage: boolean;
  belongsTo: boolean;
  copyrightPage: boolean;
  testPage: boolean;
  rectoOnly: boolean;
  marginsIn: { inside: number; outside: number; top: number; bottom: number };
  fullBleed: boolean;
}
export interface ColoringBookDetail {
  id: string;
  projectId: string;
  audience: string;
  theme: string;
  description: string;
  ageRange: string;
  difficulty: string;
  illustrationTarget: number;
  seriesName: string;
  stage: string;
  modelId: string | null;
  style: StyleProfile;
  interior: InteriorSettings;
  thresholds: Record<string, number>;
  placement: { widthIn: number; heightIn: number };
  counts: Record<string, number>;
  approvedCount: number;
  cost: { estimatedUsd: number; actualUsd: number; capUsd: number | null };
  repeatedConcepts: { a: string; b: string; similarity: number }[];
  metadataChecklist: string[];
  metadataExtras: { backCoverCopy?: string; checklist?: Record<string, boolean>; processing?: Record<string, unknown> };
  jobs: { id: string; status: string; progress: number; stage: string; error: string | null; createdAt: string; cancelRequested: boolean; type: string; attempts: number; maxAttempts: number }[];
  project: { id: string; title: string; status: string };
  pages: ColoringPage[];
}
export interface Presets {
  audiences: { id: string; label: string; ageRange: string; difficulty: string; style: StyleProfile }[];
  styles: { id: string; label: string }[];
  themes: { id: string; label: string; conceptCount: number }[];
  trims: { id: string; label: string; verification: string }[];
  interiorDefaults: InteriorSettings;
  processingDefaults: Record<string, unknown>;
}
export interface BatchEstimate {
  pages: { pageId: string; position: number; estimate: CostEstimate; errors: string[] }[];
  knownTotalUsd: number;
  unverifiedCount: number;
  perImageUsd: number | null;
  table: { quantity: number; total: number | null }[];
  budget: { capUsd: number | null; spentUsd: number; remainingUsd: number | null; exceeds: boolean };
}

export const STAGE_LABEL: Record<string, string> = { SETUP: 'Setup', PLANNING: 'Planning', GENERATING: 'Generating', REVIEW: 'Review', INTERIOR: 'Interior built', COVER: 'Cover', PREFLIGHT: 'Preflight issues', READY: 'Preflight run', EXPORTED: 'Exported' };
export const PAGE_STATUS_TONE: Record<ColoringPage['status'], 'muted' | 'primary' | 'warning' | 'success' | 'danger' | 'review'> = { PLANNED: 'muted', QUEUED: 'primary', GENERATING: 'primary', NEEDS_REVIEW: 'review', APPROVED: 'success', REJECTED: 'danger', FAILED: 'danger' };
export const assetUrl = (id: string) => `/api/assets/${id}/file`;
