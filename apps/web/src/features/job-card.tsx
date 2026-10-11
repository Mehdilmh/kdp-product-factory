import { RotateCcw, Square } from 'lucide-react';
import { useState } from 'react';
import { Badge, Progress } from '@/components/ui/basic';
import { Button } from '@/components/ui/button';
import { api } from '@/lib/api';
import { useAction, useJob, isActive } from '@/lib/hooks';
import { StatusBadge } from '@/lib/status';
import type { JobSummary } from '@/lib/types';
import { cn, fmtDate, titleCase } from '@/lib/utils';

export function JobCard({ job, compact }: { job: JobSummary; compact?: boolean }) {
  const [open, setOpen] = useState(false);
  const detail = useJob(open || isActive(job.status) ? job.id : null);
  const j = detail.data ?? job;
  const cancel = useAction(() => api.post(`/jobs/${job.id}/cancel`), { success: 'Cancellation requested', invalidate: [['jobs'], ['project'], ['job', job.id]] });
  const retry = useAction(() => api.post(`/jobs/${job.id}/retry`), { success: 'Job re-queued', invalidate: [['jobs'], ['project'], ['job', job.id]] });
  return (
    <div className="rounded-lg border p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{titleCase(j.type)}</span>
        <StatusBadge status={j.status} />
        {isActive(j.status) && <Badge tone="primary">{titleCase(j.stage)}</Badge>}
        {j.cancelRequested && isActive(j.status) && <Badge tone="warning">Stopping at next safe point</Badge>}
        <span className="ml-auto text-xs text-muted-foreground">{fmtDate(j.createdAt)}</span>
      </div>
      {isActive(j.status) && <Progress className="mt-2" value={j.progress} label="Job progress" />}
      {j.error && <p className="mt-2 rounded bg-destructive/10 p-2 text-xs text-destructive">{j.error}</p>}
      <div className="mt-2 flex flex-wrap gap-2">
        {isActive(j.status) && j.type !== 'EXPORT' && <Button size="sm" variant="outline" onClick={() => cancel.mutate(undefined)} loading={cancel.isPending}><Square /> Cancel</Button>}
        {(j.status === 'FAILED' || j.status === 'CANCELLED') && <Button size="sm" variant="outline" onClick={() => retry.mutate(undefined)} loading={retry.isPending}><RotateCcw /> Retry</Button>}
        {!compact && <Button size="sm" variant="ghost" onClick={() => setOpen((o) => !o)} aria-expanded={open}>{open ? 'Hide log' : 'Show log'}</Button>}
        {j.attempts !== undefined && <span className="self-center text-xs text-muted-foreground">Attempts {j.attempts}/{j.maxAttempts}</span>}
      </div>
      {open && detail.data && (
        <ol className="mt-2 max-h-64 overflow-auto rounded bg-muted p-2 font-mono text-xs" aria-label="Job log">
          {detail.data.logs.map((l, i) => (
            <li key={i} className={cn(l.level === 'error' && 'text-destructive', l.level === 'warn' && 'text-warning')}>
              <span className="text-muted-foreground">{new Date(l.at).toLocaleTimeString()}</span> {l.message}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
