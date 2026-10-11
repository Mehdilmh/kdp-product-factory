import { useQuery } from '@tanstack/react-query';
import { Card, CardContent, CardDescription, CardHeader, CardTitle, ErrorBox, PageHeader, Progress, Skeleton } from '@/components/ui/basic';
import { api } from '@/lib/api';
import { fmtDate, fmtUsd } from '@/lib/utils';

interface Usage {
  totals: { dayUsd: number; monthUsd: number };
  limits: { dailyCostLimitUsd: number; monthlyCostLimitUsd: number; dailyJobLimit: number; jobsLast24h: number };
  byProvider: { provider: string; model: string; kind: string; calls: number; costUsd: number; inputTokens: number; outputTokens: number; images: number }[];
  byProject: { projectId: string | null; title: string; calls: number; costUsd: number }[];
  recent: { id: string; provider: string; model: string; operation: string; inputTokens: number; outputTokens: number; images: number; estimatedCostUsd: number; success: boolean; createdAt: string }[];
  note: string;
}

export default function UsagePage() {
  const q = useQuery({ queryKey: ['usage'], queryFn: () => api.get<Usage>('/usage'), refetchInterval: 15000 });
  if (q.isLoading) return <Skeleton className="h-96" />;
  if (q.error || !q.data) return <ErrorBox error={q.error} />;
  const u = q.data;
  return (
    <>
      <PageHeader title="AI usage & estimated cost" description={u.note} />
      <div className="mb-6 grid gap-4 md:grid-cols-3">
        {[['Today', u.totals.dayUsd, u.limits.dailyCostLimitUsd], ['This month', u.totals.monthUsd, u.limits.monthlyCostLimitUsd]].map(([label, used, limit]) => (
          <Card key={label as string}><CardHeader className="pb-2"><CardDescription>{label}</CardDescription><CardTitle className="text-2xl tabular-nums">{fmtUsd(used as number)}</CardTitle></CardHeader><CardContent><Progress value={((used as number) / Math.max(0.0001, limit as number)) * 100} label={`${label} budget`} /><p className="mt-1 text-xs text-muted-foreground">Limit {fmtUsd(limit as number)} (Settings)</p></CardContent></Card>
        ))}
        <Card><CardHeader className="pb-2"><CardDescription>Jobs in the last 24 h</CardDescription><CardTitle className="text-2xl tabular-nums">{u.limits.jobsLast24h} / {u.limits.dailyJobLimit}</CardTitle></CardHeader><CardContent><Progress value={(u.limits.jobsLast24h / u.limits.dailyJobLimit) * 100} label="Daily job limit" /></CardContent></Card>
      </div>
      <div className="grid gap-6 xl:grid-cols-2">
        <Card>
          <CardHeader><CardTitle>By provider (this month)</CardTitle></CardHeader>
          <CardContent className="overflow-x-auto">
            <table className="w-full text-sm"><thead className="text-left text-xs text-muted-foreground"><tr><th className="py-1">Provider / model</th><th>Calls</th><th>Tokens in/out</th><th>Images</th><th className="text-right">Est. cost</th></tr></thead>
              <tbody className="divide-y">{u.byProvider.map((p) => <tr key={p.provider + p.model + p.kind}><td className="py-1.5">{p.provider} <span className="text-muted-foreground">{p.model}</span></td><td>{p.calls}</td><td className="tabular-nums">{p.inputTokens.toLocaleString()} / {p.outputTokens.toLocaleString()}</td><td>{p.images}</td><td className="text-right tabular-nums">{fmtUsd(p.costUsd)}</td></tr>)}</tbody>
            </table>
            {u.byProvider.length === 0 && <p className="text-sm text-muted-foreground">No AI usage yet this month.</p>}
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle>By project (this month)</CardTitle></CardHeader>
          <CardContent>
            <ul className="divide-y text-sm">{u.byProject.map((p) => <li key={p.projectId ?? 'none'} className="flex justify-between py-1.5"><span>{p.title}</span><span className="tabular-nums">{p.calls} calls · {fmtUsd(p.costUsd)}</span></li>)}</ul>
          </CardContent>
        </Card>
        <Card className="xl:col-span-2">
          <CardHeader><CardTitle>Recent calls</CardTitle></CardHeader>
          <CardContent className="overflow-x-auto">
            <table className="w-full text-sm"><thead className="text-left text-xs text-muted-foreground"><tr><th className="py-1">When</th><th>Operation</th><th>Provider</th><th>Tokens</th><th>Result</th><th className="text-right">Est. cost</th></tr></thead>
              <tbody className="divide-y">{u.recent.map((r) => <tr key={r.id}><td className="py-1.5 text-muted-foreground">{fmtDate(r.createdAt)}</td><td>{r.operation}</td><td>{r.provider}</td><td className="tabular-nums">{r.inputTokens}/{r.outputTokens}{r.images ? ` · ${r.images} img` : ''}</td><td>{r.success ? 'ok' : <span className="text-destructive">failed</span>}</td><td className="text-right tabular-nums">{fmtUsd(r.estimatedCostUsd)}</td></tr>)}</tbody>
            </table>
          </CardContent>
        </Card>
      </div>
    </>
  );
}
