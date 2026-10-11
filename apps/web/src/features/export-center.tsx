import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Download, FileOutput, ShieldCheck } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { Card, CardContent, CardDescription, CardHeader, CardTitle, EmptyState, ErrorBox, Skeleton } from '@/components/ui/basic';
import { Button } from '@/components/ui/button';
import { api } from '@/lib/api';
import { canEdit, useAuth } from '@/lib/auth';
import { useRefreshAfterJobs } from '@/lib/hooks';
import { StatusBadge } from '@/lib/status';
import type { ProjectDetail } from '@/lib/types';
import { fmtBytes, fmtDate, titleCase } from '@/lib/utils';
import { JobCard } from './job-card';

const GROUPS: { title: string; note: string; kinds: { kind: string; label: string; formats?: string[]; final?: boolean }[] }[] = [
  {
    title: 'Print',
    note: 'Final files require a preflight with no blocking failures and completed human reviews.',
    kinds: [
      { kind: 'INTERIOR_PDF', label: 'Interior PDF (print-ready)', formats: ['PAPERBACK', 'HARDCOVER'], final: true },
      { kind: 'COVER_PDF', label: 'Cover PDF (full wrap)', formats: ['PAPERBACK', 'HARDCOVER'], final: true },
      { kind: 'INTERIOR_PROOF_PDF', label: 'Proof PDF with guides (not for upload)', formats: ['PAPERBACK', 'HARDCOVER'] },
      { kind: 'VALIDATION_REPORT', label: 'Validation report (JSON + HTML)' },
    ],
  },
  {
    title: 'Kindle',
    note: 'Reflowable EPUB with navigation, plus the 1600 × 2560 px cover image.',
    kinds: [
      { kind: 'EPUB', label: 'EPUB (reflowable)', formats: ['EBOOK'], final: true },
      { kind: 'EBOOK_COVER_PNG', label: 'eBook cover PNG', formats: ['EBOOK'], final: true },
    ],
  },
  {
    title: 'Editable',
    note: 'Always available — even while technical issues remain.',
    kinds: [
      { kind: 'COVER_SVG', label: 'Editable SVG cover' },
      { kind: 'PROJECT_JSON', label: 'JSON project source' },
      { kind: 'TEMPLATES_JSON', label: 'Reusable interior templates' },
      { kind: 'ASSETS_ZIP', label: 'Original assets + design metadata' },
      { kind: 'DOCX', label: 'DOCX manuscript' },
    ],
  },
  {
    title: 'Metadata',
    note: 'For entering into KDP by hand. Nothing is published automatically.',
    kinds: [
      { kind: 'METADATA_CSV', label: 'Metadata CSV' },
      { kind: 'METADATA_JSON', label: 'Metadata JSON' },
      { kind: 'KEYWORDS_CSV', label: 'Keyword research log (CSV)' },
    ],
  },
];

interface Bundle {
  bundleId: string;
  createdAt: string;
  validationStatus: string;
  artifacts: { id: string; kind: string; filename: string; sizeBytes: number; sha256: string; specVersion: string; pageCount: number | null; trimSize: string | null }[];
}

export default function ExportCenter({ project }: { project: ProjectDetail }) {
  const { role } = useAuth();
  const qc = useQueryClient();
  const fmt = project.format.format;
  const available = GROUPS.map((g) => ({ ...g, kinds: g.kinds.filter((k) => !k.formats || k.formats.includes(fmt)) })).filter((g) => g.kinds.length);
  const [sel, setSel] = useState<Set<string>>(() => new Set(available.flatMap((g) => g.kinds.map((k) => k.kind)).filter((k) => !['INTERIOR_PROOF_PDF', 'ASSETS_ZIP'].includes(k))));
  const bundles = useQuery({ queryKey: ['exports', project.id], queryFn: () => api.get<Bundle[]>(`/projects/${project.id}/exports`) });
  useRefreshAfterJobs(project, [['exports', project.id]]);
  const exportJobs = project.jobs.filter((j) => j.type === 'EXPORT');
  const start = async () => {
    try {
      await api.post(`/projects/${project.id}/exports`, { kinds: [...sel] });
      await qc.invalidateQueries({ queryKey: ['project', project.id] });
      toast.success('Export started in the background');
    } catch (e) {
      toast.error((e as Error).message);
    }
  };
  const blocked = project.latestReport?.blocked;
  return (
    <div className="grid gap-6 xl:grid-cols-3">
      <Card className="xl:col-span-1">
        <CardHeader>
          <CardTitle>Create export bundle</CardTitle>
          <CardDescription>Each bundle includes a manifest with filenames, SHA-256 checksums, spec version, page count, trim size, and validation status.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4">
          {blocked && <p className="rounded-md bg-destructive/10 p-2 text-sm text-destructive">The latest preflight has blocking failures — final print/EPUB files will be refused until they are fixed. Editable exports still work.</p>}
          {available.map((g) => (
            <fieldset key={g.title} className="grid gap-2">
              <legend className="mb-1 text-sm font-medium">{g.title}</legend>
              {g.kinds.map((k) => (
                <label key={k.kind} className="flex items-center gap-2 text-sm">
                  <input type="checkbox" checked={sel.has(k.kind)} onChange={(e) => { const n = new Set(sel); if (e.target.checked) n.add(k.kind); else n.delete(k.kind); setSel(n); }} />
                  {k.label} {k.final && <ShieldCheck className="size-3.5 text-muted-foreground" aria-label="Gated by preflight" />}
                </label>
              ))}
              <p className="text-xs text-muted-foreground">{g.note}</p>
            </fieldset>
          ))}
          {canEdit(role) && <Button onClick={start} disabled={sel.size === 0}><FileOutput /> Export {sel.size} item(s)</Button>}
          {exportJobs.slice(0, 2).map((j) => <JobCard key={j.id} job={j} compact />)}
        </CardContent>
      </Card>
      <div className="grid content-start gap-4 xl:col-span-2">
        {bundles.isLoading ? <Skeleton className="h-64" /> : bundles.error ? <ErrorBox error={bundles.error} /> : bundles.data!.length === 0 ? (
          <EmptyState icon={<FileOutput />} title="No exports yet" description="Exports run in the background and appear here with checksums." />
        ) : bundles.data!.map((b) => (
          <Card key={b.bundleId}>
            <CardHeader className="pb-2">
              <CardTitle className="flex flex-wrap items-center gap-2 text-sm">Bundle {b.bundleId} <StatusBadge status={b.validationStatus} /> <span className="font-normal text-muted-foreground">{fmtDate(b.createdAt)}</span></CardTitle>
              <CardDescription>Spec {b.artifacts[0]?.specVersion}{b.artifacts[0]?.trimSize && ` · trim ${b.artifacts[0].trimSize}`}{b.artifacts[0]?.pageCount && ` · ${b.artifacts[0].pageCount} pages`}</CardDescription>
            </CardHeader>
            <CardContent>
              <ul className="divide-y text-sm">
                {b.artifacts.map((a) => (
                  <li key={a.id} className="flex flex-wrap items-center gap-2 py-1.5">
                    <span className="min-w-0 flex-1 truncate">{a.filename}</span>
                    <span className="text-xs text-muted-foreground">{titleCase(a.kind)} · {fmtBytes(a.sizeBytes)}</span>
                    <code className="hidden text-[10px] text-muted-foreground md:inline" title={a.sha256}>{a.sha256.slice(0, 12)}…</code>
                    <Button asChild size="sm" variant="ghost"><a href={`/api/exports/${a.id}/download`} download><Download /> Download</a></Button>
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
