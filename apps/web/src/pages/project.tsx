import { BookText, Brush, ClipboardCheck, FileOutput, History, LayoutGrid, Ruler, Sparkles, Tags } from 'lucide-react';
import { lazy, Suspense } from 'react';
import { Link, NavLink, Route, Routes, useParams } from 'react-router-dom';
import { Badge, ErrorBox, Skeleton } from '@/components/ui/basic';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogTrigger } from '@/components/ui/overlay';
import { Switch } from '@/components/ui/overlay';
import { useState } from 'react';
import { api } from '@/lib/api';
import { canEdit, useAuth } from '@/lib/auth';
import { isActive, useAction, useProject } from '@/lib/hooks';
import { FORMAT_LABEL, StatusBadge } from '@/lib/status';
import { STATUS_ORDER, type ProjectDetail } from '@/lib/types';
import { cn, titleCase } from '@/lib/utils';
import { OverviewTab } from '@/features/overview';

const InteriorEditor = lazy(() => import('@/features/interior-editor'));
const CoverEditor = lazy(() => import('@/features/cover-editor'));
const MetadataEditor = lazy(() => import('@/features/metadata-editor'));
const SpecsPanel = lazy(() => import('@/features/specs-panel'));
const ValidationPanel = lazy(() => import('@/features/validation-panel'));
const ExportCenter = lazy(() => import('@/features/export-center'));
const VersionsPanel = lazy(() => import('@/features/versions-panel'));

const TABS = [
  { path: '', label: 'Overview', icon: LayoutGrid },
  { path: 'interior', label: 'Interior', icon: BookText },
  { path: 'cover', label: 'Cover', icon: Brush },
  { path: 'metadata', label: 'Metadata', icon: Tags },
  { path: 'specs', label: 'Print specs', icon: Ruler },
  { path: 'validation', label: 'Validation', icon: ClipboardCheck },
  { path: 'exports', label: 'Exports', icon: FileOutput },
  { path: 'versions', label: 'Versions', icon: History },
];

const GEN = ['outline', 'content', 'interior', 'coverConcept', 'titleSuggestions', 'metadata', 'similarity', 'validate'] as const;

function GenerateDialog({ project }: { project: ProjectDetail }) {
  const [open, setOpen] = useState(false);
  const [settings, setSettings] = useState<Record<string, boolean>>(() => ({ ...Object.fromEntries(GEN.map((k) => [k, true])), ...project.brief.generationSettings }));
  const gen = useAction(() => api.post(`/projects/${project.id}/generate`, { settings }), { success: 'Generation started in the background', invalidate: [['project', project.id], ['jobs']], onSuccess: () => setOpen(false) });
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button><Sparkles /> Generate…</Button>
      </DialogTrigger>
      <DialogContent title="Generate with AI" description="A version snapshot is saved first. Locked pages are never overwritten. Everything stays editable.">
        <div className="grid gap-3 sm:grid-cols-2">
          {GEN.map((k) => (
            <label key={k} className="flex items-center gap-3 text-sm">
              <Switch checked={!!settings[k]} onCheckedChange={(c) => setSettings((s) => ({ ...s, [k]: c }))} />
              {titleCase(k.replace(/([A-Z])/g, '_$1'))}
            </label>
          ))}
        </div>
        <Button onClick={() => gen.mutate(undefined)} loading={gen.isPending} disabled={!Object.values(settings).some(Boolean)}>Start generation</Button>
      </DialogContent>
    </Dialog>
  );
}

export default function ProjectPage() {
  const { id = '' } = useParams();
  const { role } = useAuth();
  const q = useProject(id);
  if (q.isLoading) return <div className="grid gap-3"><Skeleton className="h-10 w-1/3" /><Skeleton className="h-64" /></div>;
  if (q.error || !q.data) return <ErrorBox error={q.error ?? new Error('Not found')} title="Could not load project" />;
  const p = q.data;
  const running = p.jobs.find((j) => isActive(j.status));
  const idx = STATUS_ORDER.indexOf(p.status);

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="text-xs text-muted-foreground"><Link to="/projects" className="hover:underline">Product library</Link> / {titleCase(p.category)}</p>
          <h1 className="truncate text-2xl font-semibold tracking-tight">{p.title}</h1>
          <div className="mt-1 flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
            <span>{FORMAT_LABEL[p.format.format]}{p.format.format !== 'EBOOK' && ` · ${p.format.trimId}`}</span>
            <Badge tone="muted">{titleCase(p.contentClass)}-content</Badge>
            {p.batchItem && <Link to={`/batches/${p.batchItem.batchId}`}><StatusBadge status={p.batchItem.status} /></Link>}
            {(p.aiTextGenerated || p.aiImagesGenerated) && <Badge tone="review">Contains AI-generated {[p.aiTextGenerated && 'text', p.aiImagesGenerated && 'images'].filter(Boolean).join(' & ')}</Badge>}
          </div>
        </div>
        {canEdit(role) && <GenerateDialog project={p} />}
      </div>
      <ol className="mb-4 flex flex-wrap items-center gap-1 text-xs" aria-label="Project status">
        {STATUS_ORDER.map((s, i) => (
          <li key={s} className={cn('rounded-full px-2.5 py-1', i < idx && 'bg-success/10 text-success', i === idx && 'bg-primary text-primary-foreground', i > idx && 'bg-muted text-muted-foreground')} aria-current={i === idx ? 'step' : undefined}>
            {titleCase(s)}
          </li>
        ))}
      </ol>
      {running && (
        <div className="mb-4 rounded-md border border-primary/30 bg-primary/5 px-3 py-2 text-sm" role="status">
          {titleCase(running.type)} job running — stage <strong>{titleCase(running.stage)}</strong> ({running.progress}%). You can keep working; editors refresh when it finishes.
        </div>
      )}
      <nav className="mb-4 flex gap-1 overflow-x-auto border-b" aria-label="Project sections">
        {TABS.map((t) => (
          <NavLink key={t.path} to={t.path ? `/projects/${id}/${t.path}` : `/projects/${id}`} end className={({ isActive: a }) => cn('flex items-center gap-1.5 whitespace-nowrap border-b-2 px-3 py-2 text-sm font-medium', a ? 'border-primary text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground')}>
            <t.icon className="size-4" aria-hidden /> {t.label}
          </NavLink>
        ))}
      </nav>
      <Suspense fallback={<Skeleton className="h-96" />}>
        <Routes>
          <Route index element={<OverviewTab project={p} />} />
          <Route path="interior" element={<InteriorEditor project={p} />} />
          <Route path="cover" element={<CoverEditor project={p} />} />
          <Route path="metadata" element={<MetadataEditor project={p} />} />
          <Route path="specs" element={<SpecsPanel project={p} />} />
          <Route path="validation" element={<ValidationPanel project={p} />} />
          <Route path="exports" element={<ExportCenter project={p} />} />
          <Route path="versions" element={<VersionsPanel project={p} />} />
        </Routes>
      </Suspense>
    </div>
  );
}
