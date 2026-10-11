import { Link } from 'react-router-dom';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/basic';
import { Button } from '@/components/ui/button';
import { api } from '@/lib/api';
import { canEdit, useAuth } from '@/lib/auth';
import { useAction } from '@/lib/hooks';
import { StatusBadge } from '@/lib/status';
import type { ProjectDetail } from '@/lib/types';
import { fmtDate, titleCase } from '@/lib/utils';
import { JobCard } from './job-card';

export function OverviewTab({ project: p }: { project: ProjectDetail }) {
  const { role } = useAuth();
  const validate = useAction(() => api.post(`/projects/${p.id}/validate`), { success: 'Validation started', invalidate: [['project', p.id]] });
  const brief = p.brief;
  return (
    <div className="grid gap-6 xl:grid-cols-3">
      <Card className="xl:col-span-2">
        <CardHeader><CardTitle>Product brief</CardTitle></CardHeader>
        <CardContent>
          <dl className="grid gap-3 text-sm sm:grid-cols-2">
            {[['Working title', brief.workingTitle], ['Target reader', brief.targetReader], ['Reader problem / use', brief.readerProblem], ['Niche', brief.niche], ['Differentiation', brief.differentiation], ['Author / imprint', brief.authorName], ['Language', brief.language], ['Marketplace', brief.marketplace], ['Content type', titleCase(brief.contentType)], ['Content style', brief.contentStyle || '—']].map(([k, v]) => (
              <div key={k} className={k === 'Differentiation' || k === 'Reader problem / use' ? 'sm:col-span-2' : ''}>
                <dt className="text-xs text-muted-foreground">{k}</dt>
                <dd className="mt-0.5">{v}</dd>
              </div>
            ))}
          </dl>
        </CardContent>
      </Card>
      <div className="grid content-start gap-6">
        <Card>
          <CardHeader><CardTitle>Validation</CardTitle></CardHeader>
          <CardContent className="grid gap-3 text-sm">
            {p.latestReport ? (
              <>
                <div className="flex items-center gap-2"><StatusBadge status={p.latestReport.blocked ? 'BLOCKED' : 'PASSED'} /> <span className="text-muted-foreground">{fmtDate(p.latestReport.createdAt)}</span></div>
                <div className="flex flex-wrap gap-2">
                  {Object.entries(p.latestReport.summary).filter(([k]) => k !== 'pageCount').map(([k, n]) => <span key={k} className="text-xs"><StatusBadge status={k} /> {n}</span>)}
                </div>
                <Link className="text-primary hover:underline" to={`/projects/${p.id}/validation`}>Open report</Link>
              </>
            ) : <p className="text-muted-foreground">Not validated yet.</p>}
            {canEdit(role) && <Button variant="outline" onClick={() => validate.mutate(undefined)} loading={validate.isPending}>Run preflight</Button>}
            {p.similarity && <p className="text-xs text-muted-foreground">Portfolio similarity: <StatusBadge status={p.similarity.status} /> {p.similarity.evidence}</p>}
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle>Recent jobs</CardTitle></CardHeader>
          <CardContent className="grid gap-2">
            {p.jobs.length === 0 ? <p className="text-sm text-muted-foreground">No jobs yet.</p> : p.jobs.map((j) => <JobCard key={j.id} job={j} />)}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
