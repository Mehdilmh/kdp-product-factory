import type { BookFormat, VerificationStatus } from '../specs/types';

/** Browser-safe preflight result types (no Node or rendering imports). */
export type CheckStatus = 'PASS' | 'WARNING' | 'FAIL' | 'NEEDS_HUMAN_REVIEW' | 'NOT_APPLICABLE';
export type Severity = 'CRITICAL' | 'MAJOR' | 'MINOR' | 'INFO';
export type ContentClass = 'LOW' | 'MEDIUM' | 'FULL';

export interface CheckResult {
  ruleId: string;
  ruleVersion: number;
  title: string;
  category: 'TECHNICAL' | 'CONTENT' | 'METADATA';
  severity: Severity;
  status: CheckStatus;
  evidence: string;
  suggestion: string;
  applicableFormats: (BookFormat | 'ALL')[];
  format: BookFormat;
  source: string;
  sourceVerification: VerificationStatus | 'INTERNAL_HEURISTIC';
  lastVerified: string;
  /** True only for explicitly defined technical failures that stop final export. */
  blocking: boolean;
  /** Human review decision recorded against this rule, if any. */
  review?: { decision: 'ACCEPTED_RISK' | 'RESOLVED' | 'REJECTED'; note: string; reviewer: string; at: string } | null;
}

export interface PreflightReport {
  rulesetVersion: string;
  specVersion: string;
  format: BookFormat;
  generatedAt: string;
  results: CheckResult[];
  summary: Record<CheckStatus, number>;
  blocked: boolean;
  blockingRuleIds: string[];
  disclaimer: string;
}

