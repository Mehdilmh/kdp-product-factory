import { ListChecks } from 'lucide-react';
import { Link, useSearchParams } from 'react-router-dom';
import { EmptyState, ErrorBox, PageHeader, Select, Skeleton } from '@/components/ui/basic';
import { JobCard } from '@/features/job-card';
import { useJobs } from '@/lib/hooks';

export default function JobsPage() {
  const [sp, setSp] = useSearchParams();
  const status = sp.get('status') ?? '';
  const jobs = useJobs({ status });
  return (
    <>
      <PageHeader
        title="Generation jobs"
        description="Long-running work happens in the background: progress, stage errors, logs, retry, and cancellation (at safe points)."
        actions={
          <Select aria-label="Filter by status" className="w-44" value={status} onChange={(e) => setSp(e.target.value ? { status: e.target.value } : {})}>
            <option value="">All statuses</option>
            {['QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED'].map((s) => <option key={s} value={s}>{s.toLowerCase()}</option>)}
          </Select>
        }
      />
      <ErrorBox error={jobs.error} />
      {jobs.isLoading ? <Skeleton className="h-64" /> : !jobs.data?.length ? (
        <EmptyState icon={<ListChecks />} title="No jobs" description="Jobs appear when you generate, validate, or export products." />
      ) : (
        <div className="grid gap-3 lg:grid-cols-2">
          {jobs.data.map((j) => (
            <div key={j.id} className="grid gap-1">
              {j.projectId && <Link to={`/projects/${j.projectId}`} className="text-sm font-medium hover:underline">{j.project?.title ?? 'Project'}</Link>}
              <JobCard job={j} />
            </div>
          ))}
        </div>
      )}
    </>
  );
}
