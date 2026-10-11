import type { CheckResult, CoverDesign, CoverGeometry, InteriorDocument, MetadataDraft, PageTemplate, ResolvedPrintSpec } from '@kdp/core/browser';

export type ProjectStatus = 'DRAFT' | 'RESEARCH' | 'CONTENT' | 'INTERIOR' | 'COVER' | 'VALIDATION' | 'READY_FOR_REVIEW' | 'EXPORTED';
export const STATUS_ORDER: ProjectStatus[] = ['DRAFT', 'RESEARCH', 'CONTENT', 'INTERIOR', 'COVER', 'VALIDATION', 'READY_FOR_REVIEW', 'EXPORTED'];

export interface Me {
  user: { id: string; email: string; name: string };
  workspaces: { id: string; name: string; role: 'OWNER' | 'ADMIN' | 'EDITOR' | 'VIEWER' }[];
  activeWorkspaceId: string | null;
}

export interface JobSummary {
  id: string;
  type: string;
  status: 'QUEUED' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'CANCELLED';
  stage: string;
  progress: number;
  attempts?: number;
  maxAttempts?: number;
  error?: string | null;
  projectId?: string | null;
  batchItemId?: string | null;
  createdAt: string;
  startedAt?: string | null;
  finishedAt?: string | null;
  cancelRequested?: boolean;
  project?: { title: string } | null;
}
export interface JobDetail extends JobSummary {
  logs: { at: string; level: 'info' | 'warn' | 'error'; message: string }[];
  result: Record<string, unknown> | null;
  input: Record<string, unknown>;
}

export interface ReportSummary {
  id: string;
  blocked: boolean;
  summary: Record<string, number>;
  createdAt: string;
  projectVersion?: number;
  specVersion?: string;
  rulesetVersion?: string;
}

export interface ProjectListItem {
  id: string;
  title: string;
  category: string;
  contentClass: 'LOW' | 'MEDIUM' | 'FULL';
  status: ProjectStatus;
  updatedAt: string;
  createdAt: string;
  format: { format: 'PAPERBACK' | 'HARDCOVER' | 'EBOOK'; trimId: string; ink: string; paper: string } | null;
  validationReports: { blocked: boolean; summary: Record<string, number>; createdAt: string }[];
  jobs: { id: string; stage: string; progress: number; type: string }[];
}

export interface ProjectDetail {
  id: string;
  title: string;
  category: string;
  contentClass: 'LOW' | 'MEDIUM' | 'FULL';
  status: ProjectStatus;
  currentVersion: number;
  aiTextGenerated: boolean;
  aiImagesGenerated: boolean;
  aiDisclosureAck: boolean;
  similarity: { status: string; evidence: string; checkedAt: string } | null;
  updatedAt: string;
  brief: Record<string, string> & { generationSettings: Record<string, boolean> };
  format: { format: 'PAPERBACK' | 'HARDCOVER' | 'EBOOK'; trimId: string; ink: string; paper: string; bleed: boolean; coverFinish: string; direction: 'LTR' | 'RTL'; targetPageCount: number | null; specVersion: string; officialCover: Record<string, unknown> | null };
  latestReport: ReportSummary | null;
  jobs: JobSummary[];
  metadata: MetadataDraft | null;
  exportCount: number;
  batchItem: { id: string; status: string; batchId: string } | null;
}

export interface LayoutSummary {
  revision: number;
  pageCount: number;
  margins: { insideIn: number; outsideIn: number; topIn: number; bottomIn: number };
  spec: { version: string; trim: ResolvedPrintSpec['trim']; pageWidthIn: number; pageHeightIn: number; bleed: ResolvedPrintSpec['bleed']; minMargins: ResolvedPrintSpec['minMargins']; pageCountLimit: ResolvedPrintSpec['pageCountLimit']; issues: ResolvedPrintSpec['issues']; verifications: ResolvedPrintSpec['verifications'] };
  toc: { title: string; pageIndex: number; displayNumber: string | null }[];
  warnings: { code: string; message: string; pageIndex?: number; elementId?: string; level: 'info' | 'warning' | 'error' }[];
  pages: { index: number; pageNumber: number; displayNumber: string | null; section: 'front' | 'body' | 'back'; source: { instanceId?: string; templateId?: string | null; chapterId?: string }; isBlank: boolean; intentionalBlank: boolean; gutterSide: 'left' | 'right' }[];
}

export interface CoverRow {
  id: string;
  name: string;
  design: CoverDesign;
  isActive: boolean;
  revision: number;
  updatedAt: string;
}

export type { CheckResult, CoverDesign, CoverGeometry, InteriorDocument, MetadataDraft, PageTemplate };
