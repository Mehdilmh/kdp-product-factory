import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, BookOpen, CheckCircle2, ListChecks, PlusCircle } from 'lucide-react';
import { Link } from 'react-router-dom';
import { Card, CardContent, CardDescription, CardHeader, CardTitle, EmptyState, PageHeader, Progress, Skeleton } from '@/components/ui/basic';
import { Button } from '@/components/ui/button';
import { api } from '@/lib/api';
import { useJobs } from '@/lib/hooks';
import { FORMAT_LABEL, StatusBadge } from '@/lib/status';
import { STATUS_ORDER, type ProjectListItem } from '@/lib/types';
import { fmtDate, fmtUsd, titleCase } from '@/lib/utils';

export function Dashboard() {
  const projects = useQuery({ queryKey: ['projects', 'all'], queryFn: () => api.get<{ items: ProjectListItem[]; total: number }>('/projects?take=200') });
  const jobs = useJobs({});
  const usage = useQuery({ queryKey: ['usage'], queryFn: () => api.get<{ totals: { dayUsd: number; monthUsd: number }; limits: { dailyCostLimitUsd: number; monthlyCostLimitUsd: number; dailyJobLimit: number; jobsLast24h: number } }>('/usage') });
  const items = projects.data?.items ?? [];
  const counts = STATUS_ORDER.map((s) => ({ s, n: items.filter((p) => p.status === s).length }));
  const active = (jobs.data ?? []).filter((j) => j.status === 'RUNNING' || j.status === 'QUEUED');
  const failed = (jobs.data ?? []).filter((j) => j.status === 'FAILED').slice(0, 5);
  const blocked = items.filter((p) => p.validationReports[0]?.blocked);

  return (
    <>
      <PageHeader
        title="Overview"
        description="Your products, generation jobs, and validation status at a glance."
        actions={
          <Button asChild>
            <Link to="/projects/new">
              <PlusCircle /> New product
            </Link>
          </Button>
        }
      />
      <section aria-label="Pipeline" className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-4 xl:grid-cols-8">
        {counts.map(({ s, n }) => (
          <Link key={s} to={`/projects?status=${s}`} className="rounded-lg border bg-card p-3 transition-colors hover:bg-accent">
            <p className="text-xs text-muted-foreground">{titleCase(s)}</p>
            <p className="mt-1 text-2xl font-semibold tabular-nums">{projects.isLoading ? '–' : n}</p>
          </Link>
        ))}
      </section>
      <div className="grid gap-6 xl:grid-cols-3">
        <Card className="xl:col-span-2">
          <CardHeader>
            <CardTitle>Recent products</CardTitle>
            <CardDescription>Most recently updated projects.</CardDescription>
          </CardHeader>
          <CardContent>
            {projects.isLoading ? (
              <div className="grid gap-2">{Array.from({ length: 4 }, (_, i) => <Skeleton key={i} className="h-12" />)}</div>
            ) : items.length === 0 ? (
              <EmptyState icon={<BookOpen />} title="No products yet" description="Start with the guided wizard: describe the reader, the problem, and what makes your book different." action={<Button asChild><Link to="/projects/new">Create your first product</Link></Button>} />
            ) : (
              <ul className="divide-y">
                {items.slice(0, 8).map((p) => (
                  <li key={p.id}>
                    <Link to={`/projects/${p.id}`} className="flex flex-wrap items-center gap-3 py-3 hover:bg-accent/50">
                      <div className="min-w-0 flex-1">
                        <p className="truncate font-medium">{p.title}</p>
                        <p className="text-xs text-muted-foreground">
                          {FORMAT_LABEL[p.format?.format ?? '']} · {p.format?.format === 'EBOOK' ? 'reflowable' : p.format?.trimId} · {titleCase(p.category)} · updated {fmtDate(p.updatedAt)}
                        </p>
                      </div>
                      {p.jobs[0] && <span className="text-xs text-primary">{titleCase(p.jobs[0].stage)}…</span>}
                      {p.validationReports[0] && (p.validationReports[0].blocked ? <StatusBadge status="BLOCKED" /> : <StatusBadge status="PASSED" />)}
                      <StatusBadge status={p.status} />
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
        <div className="grid content-start gap-6">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <ListChecks className="size-4" aria-hidden /> Generation jobs
              </CardTitle>
            </CardHeader>
            <CardContent className="grid gap-3">
              {active.length === 0 && <p className="text-sm text-muted-foreground">No jobs running. The app stays fully usable while jobs run in the background.</p>}
              {active.slice(0, 5).map((j) => (
                <Link key={j.id} to={j.projectId ? `/projects/${j.projectId}` : '/jobs'} className="grid gap-1">
                  <div className="flex justify-between text-sm">
                    <span className="truncate">{j.project?.title ?? titleCase(j.type)}</span>
                    <span className="text-muted-foreground">{titleCase(j.stage)}</span>
                  </div>
                  <Progress value={j.progress} label={`${j.project?.title ?? j.type} progress`} />
                </Link>
              ))}
              {failed.length > 0 && (
                <div className="rounded-md border border-destructive/30 p-2 text-sm">
                  <p className="flex items-center gap-1 font-medium text-destructive">
                    <AlertTriangle className="size-4" aria-hidden /> {failed.length} failed job(s)
                  </p>
                  <Link to="/jobs?status=FAILED" className="text-xs text-primary hover:underline">
                    Review and retry
                  </Link>
                </div>
              )}
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>Validation attention</CardTitle>
            </CardHeader>
            <CardContent>
              {blocked.length === 0 ? (
                <p className="flex items-center gap-2 text-sm text-muted-foreground">
                  <CheckCircle2 className="size-4 text-success" aria-hidden /> No products with blocking failures.
                </p>
              ) : (
                <ul className="grid gap-1 text-sm">
                  {blocked.slice(0, 6).map((p) => (
                    <li key={p.id}>
                      <Link className="text-primary hover:underline" to={`/projects/${p.id}/validation`}>
                        {p.title}
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
          {usage.data && (
            <Card>
              <CardHeader>
                <CardTitle>AI spend (estimated)</CardTitle>
              </CardHeader>
              <CardContent className="grid gap-3 text-sm">
                <div>
                  <div className="mb-1 flex justify-between">
                    <span>Today</span>
                    <span className="tabular-nums">{fmtUsd(usage.data.totals.dayUsd)} / {fmtUsd(usage.data.limits.dailyCostLimitUsd)}</span>
                  </div>
                  <Progress value={(usage.data.totals.dayUsd / Math.max(0.0001, usage.data.limits.dailyCostLimitUsd)) * 100} label="Daily budget used" />
                </div>
                <div>
                  <div className="mb-1 flex justify-between">
                    <span>This month</span>
                    <span className="tabular-nums">{fmtUsd(usage.data.totals.monthUsd)} / {fmtUsd(usage.data.limits.monthlyCostLimitUsd)}</span>
                  </div>
                  <Progress value={(usage.data.totals.monthUsd / Math.max(0.0001, usage.data.limits.monthlyCostLimitUsd)) * 100} label="Monthly budget used" />
                </div>
              </CardContent>
            </Card>
          )}
        </div>
      </div>
    </>
  );
}
