import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ExternalLink, PlayCircle } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { Card, CardContent, CardDescription, CardHeader, CardTitle, EmptyState, ErrorBox, Field, Select, Skeleton, Textarea } from '@/components/ui/basic';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogTrigger } from '@/components/ui/overlay';
import { api } from '@/lib/api';
import { canEdit, useAuth } from '@/lib/auth';
import { useRefreshAfterJobs } from '@/lib/hooks';
import { StatusBadge } from '@/lib/status';
import type { CheckResult, ProjectDetail, ReportSummary } from '@/lib/types';
import { cn, fmtDate, titleCase } from '@/lib/utils';

interface FullReport extends ReportSummary {
  results: CheckResult[];
  reviews: { ruleId: string; decision: string; note: string; reviewerId: string; createdAt: string }[];
  format: string;
}

export default function ValidationPanel({ project }: { project: ProjectDetail }) {
  const { role } = useAuth();
  const qc = useQueryClient();
  const reports = useQuery({ queryKey: ['reports', project.id], queryFn: () => api.get<ReportSummary[]>(`/projects/${project.id}/reports`) });
  const [reportId, setReportId] = useState<string | null>(null);
  const id = reportId ?? reports.data?.[0]?.id ?? null;
  const report = useQuery({ queryKey: ['report', id], queryFn: () => api.get<FullReport>(`/projects/${project.id}/reports/${id}`), enabled: !!id });
  const [status, setStatus] = useState('');
  const [category, setCategory] = useState('');
  useRefreshAfterJobs(project, [['reports', project.id]]);
  const running = project.jobs.some((j) => j.type === 'VALIDATE' && (j.status === 'RUNNING' || j.status === 'QUEUED'));
  const run = async () => {
    try {
      await api.post(`/projects/${project.id}/validate`);
      setReportId(null);
      await qc.invalidateQueries({ queryKey: ['project', project.id] });
      toast.success('Preflight started');
    } catch (e) {
      toast.error((e as Error).message);
    }
  };
  const r = report.data;
  const results = (r?.results ?? []).filter((x) => (!status || x.status === status) && (!category || x.category === category));
  const reviewOf = (ruleId: string) => r?.reviews.find((x) => x.ruleId === ruleId) ?? null;
  const pending = (r?.results ?? []).filter((x) => x.status === 'NEEDS_HUMAN_REVIEW' && !reviewOf(x.ruleId) && !x.review);

  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-center gap-2">
        {canEdit(role) && <Button onClick={run} loading={running}><PlayCircle /> Run preflight</Button>}
        {reports.data && reports.data.length > 0 && (
          <Select aria-label="Report history" className="w-72" value={id ?? ''} onChange={(e) => setReportId(e.target.value)}>
            {reports.data.map((x) => <option key={x.id} value={x.id}>{fmtDate(x.createdAt)} — {x.blocked ? 'blocked' : 'no blocking failures'}</option>)}
          </Select>
        )}
        <Select aria-label="Filter by status" className="w-48" value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">All results</option>
          {['FAIL', 'WARNING', 'NEEDS_HUMAN_REVIEW', 'PASS', 'NOT_APPLICABLE'].map((s) => <option key={s} value={s}>{titleCase(s)}</option>)}
        </Select>
        <Select aria-label="Filter by category" className="w-40" value={category} onChange={(e) => setCategory(e.target.value)}>
          <option value="">All categories</option>
          {['TECHNICAL', 'CONTENT', 'METADATA'].map((s) => <option key={s} value={s}>{titleCase(s)}</option>)}
        </Select>
      </div>
      <p className="rounded-md border bg-muted/40 p-3 text-xs text-muted-foreground">Preflight reduces risk but is <strong>not a guarantee</strong> of KDP acceptance, sales, or policy compliance. Only explicitly defined technical failures block export. Similarity and policy checks flag items for human review — they never declare content infringing.</p>
      {reports.isLoading ? <Skeleton className="h-64" /> : !id ? (
        <EmptyState title="No validation report yet" description="Run preflight to check page geometry, fonts, margins, cover geometry, metadata, and content risks." />
      ) : report.isLoading ? <Skeleton className="h-64" /> : report.error ? <ErrorBox error={report.error} /> : r && (
        <>
          <Card>
            <CardHeader>
              <CardTitle className="flex flex-wrap items-center gap-2">{r.blocked ? <StatusBadge status="BLOCKED" /> : <StatusBadge status="PASSED" />} Report from {fmtDate(r.createdAt)}</CardTitle>
              <CardDescription>Spec {r.specVersion} · rules {r.rulesetVersion} · project version {r.projectVersion}</CardDescription>
            </CardHeader>
            <CardContent className="flex flex-wrap gap-3 text-sm">
              {Object.entries(r.summary).filter(([k]) => k !== 'pageCount').map(([k, n]) => <button key={k} onClick={() => setStatus(k === status ? '' : k)} className="flex items-center gap-1"><StatusBadge status={k} /> {n}</button>)}
              {pending.length > 0 && <span className="text-review">{pending.length} item(s) need your review before final export.</span>}
            </CardContent>
          </Card>
          <div className="overflow-x-auto rounded-lg border">
            <table className="w-full text-sm">
              <thead className="bg-muted/50 text-left text-xs text-muted-foreground">
                <tr><th className="px-3 py-2">Rule</th><th className="px-3 py-2">Result</th><th className="px-3 py-2">Evidence and correction</th><th className="px-3 py-2">Source</th><th className="px-3 py-2"><span className="sr-only">Actions</span></th></tr>
              </thead>
              <tbody className="divide-y">
                {results.map((x) => {
                  const rv = reviewOf(x.ruleId) ?? (x.review ? { decision: x.review.decision, note: x.review.note, reviewerId: x.review.reviewer } : null);
                  return (
                    <tr key={x.ruleId} className={cn(x.blocking && 'bg-destructive/5')}>
                      <td className="px-3 py-2 align-top"><p className="font-medium">{x.title}</p><p className="text-xs text-muted-foreground"><code>{x.ruleId}</code> v{x.ruleVersion} · {titleCase(x.category)} · {titleCase(x.severity)}</p></td>
                      <td className="px-3 py-2 align-top"><StatusBadge status={x.status} />{x.blocking && <p className="mt-1 text-xs font-medium text-destructive">Blocks export</p>}</td>
                      <td className="max-w-xl px-3 py-2 align-top">
                        <p className="break-words">{x.evidence}</p>
                        {x.suggestion && <p className="mt-1 text-xs text-muted-foreground">Fix: {x.suggestion}</p>}
                        {rv && <p className="mt-1 text-xs"><StatusBadge status={rv.decision === 'REJECTED' ? 'REJECTED' : 'APPROVED'} /> {titleCase(rv.decision)} by {rv.reviewerId}: {rv.note}</p>}
                      </td>
                      <td className="px-3 py-2 align-top text-xs">
                        {x.source.startsWith('http') ? <a className="inline-flex items-center gap-1 text-primary hover:underline" href={x.source} target="_blank" rel="noreferrer">KDP help <ExternalLink className="size-3" /></a> : x.source}
                        <p className="mt-1"><StatusBadge status={x.sourceVerification} /></p>
                        <p className="text-muted-foreground">checked {x.lastVerified}</p>
                      </td>
                      <td className="px-3 py-2 align-top">{canEdit(role) && !x.blocking && ['NEEDS_HUMAN_REVIEW', 'WARNING', 'FAIL'].includes(x.status) && <ReviewDialog projectId={project.id} reportId={r.id} result={x} reviewed={!!rv} />}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}

function ReviewDialog({ projectId, reportId, result, reviewed }: { projectId: string; reportId: string; result: CheckResult; reviewed: boolean }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [decision, setDecision] = useState('ACCEPTED_RISK');
  const [note, setNote] = useState('');
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild><Button size="sm" variant={reviewed ? 'ghost' : 'outline'}>{reviewed ? 'Change' : 'Review'}</Button></DialogTrigger>
      <DialogContent title={`Review: ${result.title}`} description={result.evidence}>
        <Field label="Decision" htmlFor="dec">
          <Select id="dec" value={decision} onChange={(e) => setDecision(e.target.value)}>
            <option value="ACCEPTED_RISK">Reviewed — acceptable as is</option>
            <option value="RESOLVED">Resolved (I changed the product)</option>
            <option value="REJECTED">Not acceptable — I will change it</option>
          </Select>
        </Field>
        <Field label="Note (required)" htmlFor="note" hint={result.ruleId === 'CNT-AI-001' ? 'Accepting confirms you will disclose AI-generated content in KDP.' : 'Recorded in the audit log with your name.'}>
          <Textarea id="note" rows={3} value={note} onChange={(e) => setNote(e.target.value)} />
        </Field>
        <Button disabled={note.trim().length < 3} onClick={async () => {
          try {
            await api.post(`/projects/${projectId}/reports/${reportId}/reviews`, { ruleId: result.ruleId, decision, note });
            await qc.invalidateQueries({ queryKey: ['report', reportId] });
            await qc.invalidateQueries({ queryKey: ['project', projectId] });
            setOpen(false);
            toast.success('Review recorded');
          } catch (e) {
            toast.error((e as Error).message);
          }
        }}>Record decision</Button>
      </DialogContent>
    </Dialog>
  );
}
