import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Pause, Play, Square } from 'lucide-react';
import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { toast } from 'sonner';
import { Card, CardContent, ErrorBox, PageHeader, Progress, Skeleton } from '@/components/ui/basic';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogTrigger } from '@/components/ui/overlay';
import { api } from '@/lib/api';
import { canEdit, useAuth } from '@/lib/auth';
import { StatusBadge } from '@/lib/status';
import { fmtUsd } from '@/lib/utils';

interface Item {
  id: string;
  position: number;
  status: string;
  projectId: string | null;
  brief: { brief: { workingTitle: string; targetReader: string; differentiation: string } };
  differentiationScore: number | null;
  differentiationNotes: string[] | null;
  estimatedCostUsd: string;
  error: string | null;
  jobs: { id: string; status: string; stage: string; progress: number; error: string | null }[];
}
interface Batch { id: string; name: string; status: string; items: Item[]; settings: { concurrency: number } }

const CHECKLIST: [string, string][] = [
  ['interiorReviewed', 'I reviewed the interior page by page'],
  ['contentOriginalAndSpecific', 'Content is original and specific to the stated audience'],
  ['coverMatchesMetadata', 'Cover title/author match the metadata'],
  ['noBlockingPreflight', 'Preflight has no blocking failures'],
  ['humanReviewItemsResolved', 'All NEEDS HUMAN REVIEW items are resolved'],
  ['aiDisclosureAnswered', 'I will answer KDP’s AI-content disclosure truthfully'],
];

export default function BatchDetail() {
  const { id = '' } = useParams();
  const { role } = useAuth();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['batch', id], queryFn: () => api.get<Batch>(`/batches/${id}`), refetchInterval: (s) => (s.state.data?.status === 'RUNNING' ? 2000 : false) });
  const act = async (a: string) => {
    try {
      await api.post(`/batches/${id}/${a}`);
      await qc.invalidateQueries({ queryKey: ['batch', id] });
      toast.success(`Batch ${a === 'start' ? 'started' : a === 'resume' ? 'resumed' : a === 'pause' ? 'paused' : 'cancelled'}`);
    } catch (e) {
      toast.error((e as Error).message);
    }
  };
  if (q.isLoading) return <Skeleton className="h-96" />;
  if (q.error || !q.data) return <ErrorBox error={q.error} />;
  const b = q.data;
  const done = b.items.filter((i) => ['AWAITING_APPROVAL', 'APPROVED', 'REJECTED', 'FAILED', 'DUPLICATE'].includes(i.status)).length;
  return (
    <>
      <PageHeader
        title={b.name}
        description={<span className="flex items-center gap-2"><StatusBadge status={b.status} /> {done}/{b.items.length} processed · concurrency {b.settings.concurrency}</span>}
        actions={canEdit(role) && (
          <>
            {b.status === 'DRAFT' && <Button onClick={() => act('start')}><Play /> Start</Button>}
            {b.status === 'RUNNING' && <Button variant="outline" onClick={() => act('pause')}><Pause /> Pause</Button>}
            {b.status === 'PAUSED' && <Button onClick={() => act('resume')}><Play /> Resume</Button>}
            {['DRAFT', 'RUNNING', 'PAUSED'].includes(b.status) && <Button variant="ghost" onClick={() => confirm('Cancel the remaining items?') && act('cancel')}><Square /> Cancel</Button>}
          </>
        )}
      />
      <Progress value={(done / Math.max(1, b.items.length)) * 100} label="Batch progress" className="mb-4" />
      <div className="grid gap-3">
        {b.items.map((it) => {
          const job = it.jobs[0];
          return (
            <Card key={it.id}>
              <CardContent className="grid gap-2 p-4">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-xs text-muted-foreground">#{it.position + 1}</span>
                  <span className="font-medium">{it.brief.brief.workingTitle}</span>
                  <StatusBadge status={it.status} />
                  {it.differentiationScore !== null && <span className="text-xs text-muted-foreground">differentiation {Math.round(it.differentiationScore * 100)}%</span>}
                  <span className="text-xs text-muted-foreground">est. {fmtUsd(Number(it.estimatedCostUsd))}</span>
                  {it.projectId && <Link className="ml-auto text-sm text-primary hover:underline" to={`/projects/${it.projectId}`}>Open project</Link>}
                </div>
                <p className="text-sm text-muted-foreground">{it.brief.brief.targetReader} — {it.brief.brief.differentiation}</p>
                {it.differentiationNotes && it.differentiationNotes.length > 0 && <ul className="text-xs text-warning">{it.differentiationNotes.map((n, i) => <li key={i}>{n}</li>)}</ul>}
                {job && (job.status === 'RUNNING' || job.status === 'QUEUED') && <Progress value={job.progress} label={`${it.brief.brief.workingTitle} progress`} />}
                {(it.error || job?.error) && <p className="text-xs text-destructive">{it.error ?? job?.error}</p>}
                {it.status === 'FAILED' && job && canEdit(role) && <Button size="sm" variant="outline" className="justify-self-start" onClick={async () => { try { await api.post(`/jobs/${job.id}/retry`); await q.refetch(); } catch (e) { toast.error((e as Error).message); } }}>Retry</Button>}
                {it.status === 'AWAITING_APPROVAL' && canEdit(role) && <ApproveDialog item={it} onDone={() => q.refetch()} />}
              </CardContent>
            </Card>
          );
        })}
      </div>
    </>
  );
}

function ApproveDialog({ item, onDone }: { item: Item; onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const [checks, setChecks] = useState<Record<string, boolean>>({});
  const all = CHECKLIST.every(([k]) => checks[k]);
  const decide = async (decision: 'APPROVED' | 'REJECTED') => {
    try {
      await api.post(`/batch-items/${item.id}/review`, { decision, checklist: checks });
      toast.success(decision === 'APPROVED' ? 'Approved for final export' : 'Rejected');
      setOpen(false);
      onDone();
    } catch (e) {
      toast.error((e as Error).message);
    }
  };
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild><Button size="sm" className="justify-self-start">Review & approve</Button></DialogTrigger>
      <DialogContent title={`Approve “${item.brief.brief.workingTitle}”`} description="Minimum quality review. Open the project and check it before confirming.">
        <div className="grid gap-2">
          {CHECKLIST.map(([k, label]) => (
            <label key={k} className="flex items-start gap-2 text-sm"><input type="checkbox" className="mt-0.5" checked={!!checks[k]} onChange={(e) => setChecks({ ...checks, [k]: e.target.checked })} /> {label}</label>
          ))}
        </div>
        <div className="flex gap-2">
          <Button disabled={!all} onClick={() => decide('APPROVED')}>Approve</Button>
          <Button variant="outline" onClick={() => decide('REJECTED')}>Reject</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
