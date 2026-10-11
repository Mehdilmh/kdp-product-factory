import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Boxes, Upload } from 'lucide-react';
import { useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { Card, CardContent, CardDescription, CardHeader, CardTitle, EmptyState, ErrorBox, Field, Input, PageHeader, Skeleton, Textarea } from '@/components/ui/basic';
import { Button } from '@/components/ui/button';
import { api, ApiError } from '@/lib/api';
import { canEdit, useAuth } from '@/lib/auth';
import { StatusBadge } from '@/lib/status';
import { fmtDate, fmtUsd, titleCase } from '@/lib/utils';

interface BatchRow { id: string; name: string; status: string; createdAt: string; counts: Record<string, number>; estimatedCostUsd: number; total: number }

export default function BatchesPage() {
  const { role } = useAuth();
  const qc = useQueryClient();
  const nav = useNavigate();
  const list = useQuery({ queryKey: ['batches'], queryFn: () => api.get<BatchRow[]>('/batches'), refetchInterval: 5000 });
  const tpl = useQuery({ queryKey: ['batch-template'], queryFn: () => api.get<{ columns: string[] }>('/batches/csv-template') });
  const [name, setName] = useState('');
  const [csv, setCsv] = useState('');
  const [concurrency, setConcurrency] = useState(2);
  const [rowErrors, setRowErrors] = useState<{ row: number; message: string }[]>([]);
  const [busy, setBusy] = useState(false);
  const file = useRef<HTMLInputElement>(null);
  const create = async () => {
    setBusy(true);
    setRowErrors([]);
    try {
      const b = await api.post<{ id: string }>('/batches', { name, csv, concurrency });
      await qc.invalidateQueries({ queryKey: ['batches'] });
      toast.success('Batch created — review differentiation results before starting.');
      nav(`/batches/${b.id}`);
    } catch (e) {
      if (e instanceof ApiError && (e.details as { rowErrors?: [] })?.rowErrors) setRowErrors((e.details as { rowErrors: { row: number; message: string }[] }).rowErrors);
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const sample = tpl.data ? `${tpl.data.columns.join(',')}\n"Night Shift Notes",GUIDED_JOURNAL,LINED,"Night-shift warehouse workers","Unwinding after shifts","shift work reflection","Prompts follow rotating shift patterns with a sleep-debt tracker and weekly recovery plan.",Sam Lee,PAPERBACK,6x9,BLACK_WHITE,WHITE,false,100,English,midnight` : '';
  return (
    <>
      <PageHeader title="Batch generation" description="Queue several independently configured products. Each item gets a differentiation check; near-identical briefs are flagged and skipped, and every product needs manual approval before final export." />
      <div className="grid gap-6 xl:grid-cols-3">
        {canEdit(role) && (
          <Card>
            <CardHeader><CardTitle>Import product briefs (CSV)</CardTitle><CardDescription>Columns: {tpl.data?.columns.join(', ')}</CardDescription></CardHeader>
            <CardContent className="grid gap-3">
              <Field label="Batch name" htmlFor="bn"><Input id="bn" value={name} onChange={(e) => setName(e.target.value)} /></Field>
              <Field label="CSV" htmlFor="csv" hint="Paste CSV or load a file. Max 500 rows per import.">
                <Textarea id="csv" rows={8} className="font-mono text-xs" value={csv} onChange={(e) => setCsv(e.target.value)} />
              </Field>
              <div className="flex flex-wrap gap-2">
                <Button size="sm" variant="outline" onClick={() => file.current?.click()}><Upload /> Load file</Button>
                <Button size="sm" variant="ghost" onClick={() => setCsv(sample)}>Insert example row</Button>
                <input ref={file} type="file" accept=".csv,text/csv" className="hidden" onChange={async (e) => { const f = e.target.files?.[0]; if (f) setCsv(await f.text()); }} />
              </div>
              <Field label="Concurrency" htmlFor="cc" hint="Products generated at the same time (quotas still apply)."><Input id="cc" type="number" min={1} max={10} value={concurrency} onChange={(e) => setConcurrency(Number(e.target.value))} /></Field>
              {rowErrors.length > 0 && (
                <div className="max-h-40 overflow-auto rounded-md bg-destructive/10 p-2 text-xs text-destructive" role="alert">
                  {rowErrors.map((r) => <p key={r.row}>Row {r.row}: {r.message}</p>)}
                </div>
              )}
              <Button onClick={create} loading={busy} disabled={!name.trim() || !csv.trim()}>Create batch</Button>
            </CardContent>
          </Card>
        )}
        <div className="grid content-start gap-3 xl:col-span-2">
          <ErrorBox error={list.error} />
          {list.isLoading ? <Skeleton className="h-40" /> : !list.data?.length ? <EmptyState icon={<Boxes />} title="No batches yet" /> : list.data.map((b) => (
            <Link key={b.id} to={`/batches/${b.id}`} className="rounded-lg border bg-card p-4 transition-colors hover:bg-accent">
              <div className="flex flex-wrap items-center gap-2"><span className="font-medium">{b.name}</span><StatusBadge status={b.status} /><span className="ml-auto text-xs text-muted-foreground">{fmtDate(b.createdAt)}</span></div>
              <div className="mt-2 flex flex-wrap gap-3 text-xs text-muted-foreground">
                <span>{b.total} item(s)</span>
                {Object.entries(b.counts).map(([k, n]) => <span key={k}>{titleCase(k)}: {n}</span>)}
                <span>Estimated cost {fmtUsd(b.estimatedCostUsd)}</span>
              </div>
            </Link>
          ))}
        </div>
      </div>
    </>
  );
}
