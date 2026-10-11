import { Badge, type Tone } from '@/components/ui/basic';
import { titleCase } from './utils';

const STATUS_TONE: Record<string, Tone> = {
  DRAFT: 'muted',
  RESEARCH: 'primary',
  CONTENT: 'primary',
  INTERIOR: 'primary',
  COVER: 'primary',
  VALIDATION: 'warning',
  READY_FOR_REVIEW: 'review',
  EXPORTED: 'success',
  QUEUED: 'muted',
  RUNNING: 'primary',
  SUCCEEDED: 'success',
  FAILED: 'danger',
  CANCELLED: 'muted',
  PASS: 'success',
  WARNING: 'warning',
  FAIL: 'danger',
  NEEDS_HUMAN_REVIEW: 'review',
  NOT_APPLICABLE: 'muted',
  PENDING: 'muted',
  AWAITING_APPROVAL: 'review',
  APPROVED: 'success',
  REJECTED: 'danger',
  DUPLICATE: 'warning',
  PAUSED: 'warning',
  COMPLETED: 'success',
  PASSED: 'success',
  PASSED_WITH_WARNINGS: 'warning',
  NEEDS_REVIEW: 'review',
  BLOCKED: 'danger',
  CORROBORATED: 'primary',
  UNVERIFIED: 'warning',
  OFFICIAL_TEMPLATE: 'success',
  INTERNAL_HEURISTIC: 'muted',
};

export function StatusBadge({ status, className }: { status: string; className?: string }) {
  return (
    <Badge tone={STATUS_TONE[status] ?? 'default'} className={className}>
      {titleCase(status)}
    </Badge>
  );
}

export const FORMAT_LABEL: Record<string, string> = { PAPERBACK: 'Paperback', HARDCOVER: 'Hardcover', EBOOK: 'Kindle eBook' };
