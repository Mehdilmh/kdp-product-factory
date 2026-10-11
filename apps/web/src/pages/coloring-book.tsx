import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, ArrowDown, ArrowUp, Check, Download, ExternalLink, Heart, Plus, RefreshCw, Sparkles, Trash2, Upload, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { toast } from 'sonner';
import { Badge, Card, CardContent, CardDescription, CardHeader, CardTitle, EmptyState, ErrorBox, Field, Input, PageHeader, Progress, Select, Skeleton, Textarea } from '@/components/ui/basic';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, Switch, Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/overlay';
import { StyleControls } from '@/features/coloring-style';
import { assetUrl, PAGE_STATUS_TONE, STAGE_LABEL, type BatchEstimate, type ColoringBookDetail, type ColoringPage, type InteriorSettings, type Presets, type QcCheck } from '@/features/coloring-types';
import { EstimateView, ModelSelect, money, useModels } from '@/features/image-models';
import { JobCard } from '@/features/job-card';
import { api, ApiError } from '@/lib/api';
import { canEdit, useAuth } from '@/lib/auth';
import { useAction } from '@/lib/hooks';
import type { JobSummary } from '@/lib/types';
import { cn, titleCase } from '@/lib/utils';

export default function ColoringBookPage() {
  const { id = '' } = useParams();
  const { role } = useAuth();
  const editable = canEdit(role);
  const q = useQuery({
    queryKey: ['coloring-book', id],
    queryFn: () => api.get<ColoringBookDetail>(`/coloring/${id}`),
    refetchInterval: (d) => (d.state.data?.pages.some((p) => p.status === 'QUEUED' || p.status === 'GENERATING') ? 2500 : false),
  });
  const presets = useQuery({ queryKey: ['coloring-presets'], queryFn: () => api.get<Presets>('/coloring/presets') });
  if (q.isLoading || presets.isLoading) return <Skeleton className="h-96" />;
  if (q.error || !q.data) return <ErrorBox error={q.error} />;
  const b = q.data;
  return (
    <>
      <PageHeader
        title={b.project.title}
        description={<>{titleCase(b.audience)} ({b.ageRange}) · {b.theme || 'custom theme'} · {STAGE_LABEL[b.stage] ?? b.stage}</>}
        actions={<Button asChild variant="outline"><Link to={`/projects/${b.projectId}`}>Project overview <ExternalLink /></Link></Button>}
      />
      <div className="mb-4 grid gap-3 sm:grid-cols-3">
        <Card><CardContent className="pt-4"><p className="text-xs text-muted-foreground">Approved illustrations</p><p className="text-xl font-semibold tabular-nums">{b.approvedCount} / {b.illustrationTarget}</p><Progress value={(b.approvedCount / Math.max(1, b.illustrationTarget)) * 100} label="Approved" /></CardContent></Card>
        <Card><CardContent className="pt-4"><p className="text-xs text-muted-foreground">Pages in plan</p><p className="text-sm">{b.pages.length} total · {Object.entries(b.counts).map(([k, v]) => `${v} ${titleCase(k).toLowerCase()}`).join(' · ')}</p></CardContent></Card>
        <Card><CardContent className="pt-4"><p className="text-xs text-muted-foreground">Cost (estimated / provider-reported)</p><p className="text-xl font-semibold tabular-nums">{money(b.cost.estimatedUsd)} <span className="text-sm font-normal text-muted-foreground">/ {money(b.cost.actualUsd)}</span></p>{b.cost.capUsd !== null && <p className="text-xs text-muted-foreground">Budget cap {money(b.cost.capUsd)}</p>}</CardContent></Card>
      </div>
      {b.jobs[0] && ['QUEUED', 'RUNNING', 'FAILED'].includes(b.jobs[0].status) && <div className="mb-4"><JobCard job={b.jobs[0] as unknown as JobSummary} /></div>}
      <Tabs defaultValue={b.pages.some((p) => p.current) ? 'review' : 'plan'}>
        <TabsList>
          <TabsTrigger value="plan">Plan & style</TabsTrigger>
          <TabsTrigger value="review">Generate & review</TabsTrigger>
          <TabsTrigger value="interior">Interior</TabsTrigger>
          <TabsTrigger value="cover">Cover</TabsTrigger>
          <TabsTrigger value="preflight">Preflight</TabsTrigger>
          <TabsTrigger value="metadata">Metadata</TabsTrigger>
          <TabsTrigger value="export">Export</TabsTrigger>
        </TabsList>
        <TabsContent value="plan"><PlanTab b={b} presets={presets.data!} editable={editable} /></TabsContent>
        <TabsContent value="review"><ReviewTab b={b} editable={editable} /></TabsContent>
        <TabsContent value="interior"><InteriorTab b={b} editable={editable} /></TabsContent>
        <TabsContent value="cover"><CoverTab b={b} /></TabsContent>
        <TabsContent value="preflight"><PreflightTab b={b} /></TabsContent>
        <TabsContent value="metadata"><MetadataTab b={b} editable={editable} /></TabsContent>
        <TabsContent value="export"><ExportTab b={b} editable={editable} /></TabsContent>
      </Tabs>
    </>
  );
}

const useBookAction = <V, O>(id: string, fn: (v: V) => Promise<O>, success?: string) => useAction(fn, { success, invalidate: [['coloring-book', id], ['coloring']] });

/* ------------------------------------------- Plan ------------------------------------------- */

function PlanTab({ b, presets, editable }: { b: ColoringBookDetail; presets: Presets; editable: boolean }) {
  const [style, setStyle] = useState(b.style);
  const [concepts, setConcepts] = useState('');
  const [theme, setTheme] = useState(b.theme || presets.themes[0]?.id || '');
  const [count, setCount] = useState(Math.max(1, b.illustrationTarget - b.pages.length));
  useEffect(() => setStyle(b.style), [JSON.stringify(b.style)]); // eslint-disable-line react-hooks/exhaustive-deps
  const saveStyle = useBookAction(b.id, () => api.patch(`/coloring/${b.id}`, { style, rebuildPrompts: true }), 'Style saved; prompts that were not hand-edited were rebuilt');
  const addConcepts = useBookAction(b.id, () => api.post(`/coloring/${b.id}/pages`, { concepts: concepts.split('\n').map((s) => s.trim()).filter((s) => s.length > 1) }), 'Pages added');
  const addTheme = useBookAction(b.id, () => api.post(`/coloring/${b.id}/pages`, { fromTheme: { theme, count } }), 'Pages added from theme');
  const reorder = useBookAction(b.id, (ids: string[]) => api.post(`/coloring/${b.id}/pages/reorder`, { pageIds: ids }));
  const del = useBookAction(b.id, (pid: string) => api.del(`/coloring/${b.id}/pages/${pid}`), 'Page removed');
  const repeated = new Set(b.repeatedConcepts.flatMap((r) => [r.a, r.b]));
  const move = (i: number, d: number) => {
    const ids = b.pages.map((p) => p.id);
    const j = i + d;
    if (j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j], ids[i]];
    reorder.mutate(ids);
  };
  const dirtyStyle = JSON.stringify(style) !== JSON.stringify(b.style);
  return (
    <div className="grid gap-4">
      <Card>
        <CardHeader><CardTitle>Style profile</CardTitle><CardDescription>Changing the style rebuilds prompts for pages whose prompt you have not edited by hand. QC thresholds follow the style.</CardDescription></CardHeader>
        <CardContent className="grid gap-3">
          <StyleControls style={style} styles={presets.styles} onChange={setStyle} disabled={!editable} />
          {editable && <div className="flex gap-2"><Button disabled={!dirtyStyle} onClick={() => saveStyle.mutate(undefined)} loading={saveStyle.isPending}>Save style</Button><SaveProfile style={style} /></div>}
        </CardContent>
      </Card>
      <Card>
        <CardHeader><CardTitle>Page plan ({b.pages.length})</CardTitle><CardDescription>Each page stores its concept, prompt, model, parameters, versions, cost and QC.</CardDescription></CardHeader>
        <CardContent className="grid gap-3">
          {b.repeatedConcepts.length > 0 && <p className="rounded bg-warning/10 p-2 text-sm text-warning"><AlertTriangle className="mr-1 inline size-4" />{b.repeatedConcepts.length} pair(s) of pages have very similar concepts. Repetitive books are a quality risk.</p>}
          {b.pages.length === 0 ? <EmptyState title="No pages yet" description="Add concepts below or fill from a theme preset." /> : (
            <ol className="divide-y rounded border">
              {b.pages.map((p, i) => (
                <PlanRow key={p.id} b={b} p={p} i={i} n={b.pages.length} repeated={repeated.has(p.id)} editable={editable} onMove={move} onDelete={() => confirm(`Remove page ${i + 1}? Its images stay in the asset library.`) && del.mutate(p.id)} />
              ))}
            </ol>
          )}
          {editable && (
            <div className="grid gap-3 md:grid-cols-2">
              <div className="grid gap-2">
                <Field label="Add concepts (one per line)" htmlFor="add-c"><Textarea id="add-c" rows={3} value={concepts} onChange={(e) => setConcepts(e.target.value)} /></Field>
                <Button variant="outline" disabled={!concepts.trim()} onClick={() => addConcepts.mutate(undefined, { onSuccess: () => setConcepts('') })} loading={addConcepts.isPending}><Plus /> Add</Button>
              </div>
              <div className="grid content-start gap-2">
                <div className="grid grid-cols-[1fr_100px] gap-2">
                  <Field label="From theme preset" htmlFor="add-t"><Select id="add-t" value={theme} onChange={(e) => setTheme(e.target.value)}>{presets.themes.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}</Select></Field>
                  <Field label="Count" htmlFor="add-n"><Input id="add-n" type="number" min={1} max={300} value={count} onChange={(e) => setCount(Number(e.target.value) || 1)} /></Field>
                </div>
                <Button variant="outline" onClick={() => addTheme.mutate(undefined)} loading={addTheme.isPending}><Plus /> Add from theme</Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function SaveProfile({ style }: { style: ColoringBookDetail['style'] }) {
  const save = useAction(() => api.post('/coloring-styles', { name: prompt('Name for this style profile:', style.name) || style.name, profile: style }), { success: 'Style profile saved', invalidate: [['coloring-styles']] });
  return <Button variant="ghost" onClick={() => save.mutate(undefined)} loading={save.isPending}>Save as reusable profile</Button>;
}

function PlanRow({ b, p, i, n, repeated, editable, onMove, onDelete }: { b: ColoringBookDetail; p: ColoringPage; i: number; n: number; repeated: boolean; editable: boolean; onMove: (i: number, d: number) => void; onDelete: () => void }) {
  const [open, setOpen] = useState(false);
  const [concept, setConcept] = useState(p.concept);
  const [promptText, setPrompt] = useState(p.prompt);
  useEffect(() => { setConcept(p.concept); setPrompt(p.prompt); }, [p.concept, p.prompt]);
  const patch = useBookAction(b.id, (body: Record<string, unknown>) => api.patch(`/coloring/${b.id}/pages/${p.id}`, body));
  return (
    <li className="grid gap-2 p-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="w-8 text-right text-sm tabular-nums text-muted-foreground">{i + 1}</span>
        <Input aria-label={`Concept for page ${i + 1}`} className="h-8 min-w-[200px] flex-1" value={concept} disabled={!editable} onChange={(e) => setConcept(e.target.value)} onBlur={() => concept !== p.concept && concept.trim().length > 1 && patch.mutate({ concept })} />
        <Badge tone={PAGE_STATUS_TONE[p.status]}>{titleCase(p.status)}</Badge>
        {repeated && <Badge tone="warning">Similar concept</Badge>}
        {p.promptEdited && <Badge tone="muted">Custom prompt</Badge>}
        <Button size="sm" variant="ghost" onClick={() => setOpen((o) => !o)} aria-expanded={open}>Prompt</Button>
        {editable && <><Button size="sm" variant="ghost" aria-label="Move up" disabled={i === 0} onClick={() => onMove(i, -1)}><ArrowUp /></Button><Button size="sm" variant="ghost" aria-label="Move down" disabled={i === n - 1} onClick={() => onMove(i, 1)}><ArrowDown /></Button><Button size="sm" variant="ghost" aria-label="Remove page" onClick={onDelete}><Trash2 /></Button></>}
      </div>
      {open && (
        <div className="ml-10 grid gap-2">
          <Textarea aria-label="Prompt" rows={4} value={promptText} disabled={!editable} onChange={(e) => setPrompt(e.target.value)} />
          <p className="text-xs text-muted-foreground">Negative prompt (used only by models that support it): {p.negativePrompt}</p>
          {editable && <div className="flex gap-2"><Button size="sm" disabled={promptText === p.prompt} onClick={() => patch.mutate({ prompt: promptText })}>Save prompt</Button>{p.promptEdited && <Button size="sm" variant="ghost" onClick={() => patch.mutate({ resetPrompt: true })}>Reset to generated prompt</Button>}</div>}
        </div>
      )}
    </li>
  );
}

/* ------------------------------------- Generate & review ------------------------------------ */

function ReviewTab({ b, editable }: { b: ColoringBookDetail; editable: boolean }) {
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState('');
  const [openPage, setOpenPage] = useState<string | null>(null);
  const [gen, setGen] = useState<{ pageIds: string[]; mode: 'NEW' | 'VARIATION' | 'EDIT' } | null>(null);
  const bulk = useBookAction(b.id, (v: { action: string }) => api.post<{ results: { ok: boolean; error?: string }[] }>(`/coloring/${b.id}/bulk`, { pageIds: [...sel], action: v.action }));
  const pages = b.pages.filter((p) => !filter || (filter === 'FAVORITE' ? p.favorite : filter === 'SIMILAR' ? p.similarTo.length > 0 : p.status === filter));
  const toggle = (id: string) => setSel((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const runBulk = (action: string) => bulk.mutate({ action }, { onSuccess: (r) => { const bad = r.results.filter((x) => !x.ok); if (bad.length) toast.warning(`${bad.length} page(s) not updated: ${bad[0].error}`); else toast.success('Done'); setSel(new Set()); } });
  const selectable = (p: ColoringPage) => p.status !== 'QUEUED' && p.status !== 'GENERATING';
  return (
    <div className="grid gap-3">
      <div className="sticky top-0 z-10 flex flex-wrap items-center gap-2 rounded-lg border bg-background p-2">
        <Select aria-label="Filter pages" className="h-8 w-44" value={filter} onChange={(e) => setFilter(e.target.value)}>
          <option value="">All pages ({b.pages.length})</option>
          {['PLANNED', 'NEEDS_REVIEW', 'APPROVED', 'REJECTED', 'FAILED'].map((s) => <option key={s} value={s}>{titleCase(s)} ({b.counts[s] ?? 0})</option>)}
          <option value="FAVORITE">Favorites</option>
          <option value="SIMILAR">Possible duplicates</option>
        </Select>
        <Button size="sm" variant="ghost" onClick={() => setSel(new Set(pages.filter(selectable).map((p) => p.id)))}>Select shown</Button>
        <Button size="sm" variant="ghost" onClick={() => setSel(new Set())}>Clear</Button>
        <span className="text-sm text-muted-foreground">{sel.size} selected</span>
        {editable && (
          <div className="ml-auto flex flex-wrap gap-1">
            <Button size="sm" disabled={!sel.size} onClick={() => setGen({ pageIds: [...sel], mode: 'NEW' })}><Sparkles /> Generate…</Button>
            <Button size="sm" variant="outline" disabled={!sel.size} onClick={() => runBulk('approve')} loading={bulk.isPending}><Check /> Approve</Button>
            <Button size="sm" variant="outline" disabled={!sel.size} onClick={() => runBulk('reject')}><X /> Reject</Button>
            <Button size="sm" variant="outline" disabled={!sel.size} onClick={() => runBulk('favorite')}><Heart /> Favorite</Button>
            <Button size="sm" variant="outline" disabled={!sel.size} onClick={() => runBulk('process')}><RefreshCw /> Re-process</Button>
            <Button size="sm" variant="ghost" disabled={!sel.size} onClick={() => confirm(`Remove ${sel.size} page(s) from the plan?`) && runBulk('delete')}><Trash2 /></Button>
          </div>
        )}
      </div>
      {pages.length === 0 ? <EmptyState title="No pages match" /> : (
        <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
          {pages.map((p) => {
            const v = p.current;
            const s = v?.qc?.summary;
            return (
              <div key={p.id} className={cn('grid content-start gap-1 rounded-lg border p-2', sel.has(p.id) && 'ring-2 ring-primary')}>
                <div className="flex items-center gap-1 text-xs">
                  <input type="checkbox" aria-label={`Select page ${p.position + 1}`} disabled={!selectable(p)} checked={sel.has(p.id)} onChange={() => toggle(p.id)} />
                  <span className="font-medium">#{p.position + 1}</span>
                  {p.favorite && <Heart className="size-3 fill-current text-destructive" aria-label="Favorite" />}
                  <Badge tone={PAGE_STATUS_TONE[p.status]} className="ml-auto">{titleCase(p.status)}</Badge>
                </div>
                <button className="relative aspect-[3/4] w-full overflow-hidden rounded border bg-white" onClick={() => setOpenPage(p.id)} aria-label={`Open page ${p.position + 1}: ${p.concept}`}>
                  {v ? <img src={assetUrl(v.processedAssetId ?? v.originalAssetId)} alt={p.concept} className="h-full w-full object-contain" loading="lazy" /> : <span className="grid h-full place-items-center p-2 text-center text-xs text-muted-foreground">{p.status === 'GENERATING' || p.status === 'QUEUED' ? 'Generating…' : p.error ?? 'Not generated yet'}</span>}
                </button>
                <p className="line-clamp-2 text-xs">{p.concept}</p>
                <div className="flex flex-wrap gap-1">
                  {s && s.fail > 0 && <Badge tone="danger">{s.fail} fail</Badge>}
                  {s && s.warn > 0 && <Badge tone="warning">{s.warn} warning{s.warn > 1 ? 's' : ''}</Badge>}
                  {p.similarTo.length > 0 && <Badge tone="warning">Similar to #{p.similarTo.map((x) => x.position + 1).join(', #')}</Badge>}
                  {p.qcOverride && <Badge tone="muted">Override</Badge>}
                </div>
              </div>
            );
          })}
        </div>
      )}
      {gen && <GenerateDialog b={b} pageIds={gen.pageIds} initialMode={gen.mode} onClose={() => { setGen(null); setSel(new Set()); }} />}
      {openPage && <PageDialog b={b} pageId={openPage} editable={editable} onClose={() => setOpenPage(null)} onGenerate={(mode) => setGen({ pageIds: [openPage], mode })} />}
    </div>
  );
}

function GenerateDialog({ b, pageIds, initialMode, onClose }: { b: ColoringBookDetail; pageIds: string[]; initialMode: 'NEW' | 'VARIATION' | 'EDIT'; onClose: () => void }) {
  const models = useModels({});
  const [modelId, setModelId] = useState<string | null>(b.modelId);
  const [mode, setMode] = useState(initialMode);
  const [ack, setAck] = useState(false);
  const qc = useQueryClient();
  useEffect(() => {
    if (!modelId && models.data) setModelId(models.data.preferredModelId ?? models.data.models.find((m) => m.usable)?.id ?? null);
  }, [models.data]); // eslint-disable-line react-hooks/exhaustive-deps
  const model = models.data?.models.find((m) => m.id === modelId);
  const est = useQuery({ queryKey: ['coloring-estimate', b.id, pageIds, modelId, mode], enabled: !!modelId, queryFn: () => api.post<BatchEstimate>(`/coloring/${b.id}/estimate`, { pageIds, modelId, mode }), retry: false });
  useEffect(() => setAck(false), [est.data?.knownTotalUsd, modelId, mode]);
  const run = useAction(() => api.post<{ jobId: string }>(`/coloring/${b.id}/generate`, { pageIds, modelId, mode, confirmation: { acceptedTotalUsd: est.data!.knownTotalUsd, acceptUnverifiedCost: est.data!.unverifiedCount > 0 } }), {
    success: 'Generation queued — it runs in the background',
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['coloring-book', b.id] });
      onClose();
    },
  });
  const errors = est.data?.pages.filter((p) => p.errors.length) ?? [];
  const first = est.data?.pages[0]?.estimate;
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent wide title={`Generate ${pageIds.length} page${pageIds.length > 1 ? 's' : ''}`} description="One image per page. The batch runs in the background; finished pages are kept even if later pages fail.">
        <div className="grid gap-3 md:grid-cols-2">
          <Field label="Model"><ModelSelect value={modelId} onChange={setModelId} models={models.data?.models ?? []} /></Field>
          <Field label="Mode" htmlFor="g-mode">
            <Select id="g-mode" value={mode} onChange={(e) => setMode(e.target.value as typeof mode)}>
              <option value="NEW">New image from the page prompt</option>
              <option value="VARIATION">Variation (new seed and arrangement)</option>
              <option value="EDIT" disabled={!model?.tasks.some((t) => t === 'edit' || t === 'image-to-image')}>Edit / redraw the current image</option>
            </Select>
          </Field>
        </div>
        {model?.price?.isBuiltIn && <p className="text-xs text-muted-foreground">Offline mock: procedural shapes for testing the workflow, not real illustrations.</p>}
        {est.isFetching && <Skeleton className="h-24" />}
        {est.error && <ErrorBox error={est.error} />}
        {est.data && (
          <div className="grid gap-2 rounded border p-3 text-sm">
            {first && <EstimateView e={first} compact mock={model?.price?.isBuiltIn} />}
            <p>Known total for {pageIds.length} page(s): <strong>{money(est.data.knownTotalUsd)}</strong>{est.data.unverifiedCount > 0 && <span className="text-warning"> · {est.data.unverifiedCount} page(s) without a verified price</span>}</p>
            {est.data.perImageUsd !== null && <p className="text-xs text-muted-foreground">Per image {money(est.data.perImageUsd)} · {est.data.table.map((t) => `${t.quantity}: ${money(t.total)}`).join(' · ')}</p>}
            {est.data.budget.capUsd !== null && <p className={cn('text-xs', est.data.budget.exceeds ? 'text-destructive' : 'text-muted-foreground')}>Budget: {money(est.data.budget.spentUsd)} spent of {money(est.data.budget.capUsd)}{est.data.budget.exceeds ? ' — this batch would exceed it.' : ''}</p>}
            {errors.length > 0 && <ul className="rounded bg-destructive/10 p-2 text-xs text-destructive">{errors.slice(0, 5).map((e) => <li key={e.pageId}>Page {e.position + 1}: {e.errors.join('; ')}</li>)}</ul>}
            <label className="flex items-start gap-2"><input type="checkbox" className="mt-0.5" checked={ack} onChange={(e) => setAck(e.target.checked)} /><span>I confirm the estimated cost{est.data.unverifiedCount ? ' and accept unverified costs for pages without a verified price' : ''}. Actual cost is recorded when the provider reports it.</span></label>
            <Button disabled={!ack || errors.length > 0 || est.data.budget.exceeds} onClick={() => run.mutate(undefined)} loading={run.isPending}><Sparkles /> Generate {pageIds.length} page(s)</Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function QcList({ checks, override }: { checks: QcCheck[]; override: ColoringPage['qcOverride'] }) {
  const tone = { PASS: 'success', WARN: 'warning', FAIL: 'danger', MANUAL: 'review' } as const;
  return (
    <ul className="grid gap-1 text-xs">
      {checks.map((c) => (
        <li key={c.id} className="flex gap-2">
          <Badge tone={tone[c.status]} className="shrink-0">{c.status}</Badge>
          <span><strong>{c.label}</strong> <span className="text-muted-foreground">({c.kind.toLowerCase()})</span> — {c.message}{override?.checks.includes(c.id) ? ' · overridden' : ''}</span>
        </li>
      ))}
    </ul>
  );
}

function PageDialog({ b, pageId, editable, onClose, onGenerate }: { b: ColoringBookDetail; pageId: string; editable: boolean; onClose: () => void; onGenerate: (mode: 'NEW' | 'VARIATION' | 'EDIT') => void }) {
  const p = b.pages.find((x) => x.id === pageId);
  const [viewId, setViewId] = useState<string | null>(null);
  const [overrideNote, setOverrideNote] = useState('');
  const [proc, setProc] = useState({ threshold: '200', denoise: '0', trimWhitespace: false, padToAspect: false, paddingRatio: '0', upscaleToDpi: '300', grayscale: true });
  const fileRef = useRef<HTMLInputElement>(null);
  const qc = useQueryClient();
  const status = useBookAction(b.id, (v: { status: string; overrideNote?: string }) => api.post(`/coloring/${b.id}/pages/${pageId}/status`, v));
  const fav = useBookAction(b.id, (favorite: boolean) => api.patch(`/coloring/${b.id}/pages/${pageId}`, { favorite }));
  const restore = useBookAction(b.id, (versionId: string) => api.post(`/coloring/${b.id}/pages/${pageId}/restore`, { versionId }), 'Version restored');
  const dup = useBookAction(b.id, () => api.post(`/coloring/${b.id}/pages/${pageId}/duplicate`), 'Page duplicated');
  const process = useBookAction(b.id, () => api.post(`/coloring/${b.id}/pages/${pageId}/process`, { versionId: viewId ?? undefined, options: { threshold: proc.threshold === '' ? null : Number(proc.threshold), denoise: Number(proc.denoise), trimWhitespace: proc.trimWhitespace, padToAspect: proc.padToAspect, paddingRatio: Number(proc.paddingRatio), upscaleToDpi: Number(proc.upscaleToDpi), grayscale: proc.grayscale } }), 'Re-processed (original kept)');
  const override = useBookAction(b.id, (checks: string[]) => api.post(`/coloring/${b.id}/pages/${pageId}/override`, { checks, note: overrideNote }), 'Override recorded');
  if (!p) return null;
  const v = p.versions.find((x) => x.id === (viewId ?? p.currentVersionId)) ?? p.current;
  const warn = v?.qc?.checks.filter((c) => c.status === 'WARN' || c.status === 'FAIL') ?? [];
  const approve = () =>
    status.mutate(
      { status: 'APPROVED', overrideNote: overrideNote || undefined },
      { onError: (e) => { if (e instanceof ApiError && e.code === 'QC_OVERRIDE_REQUIRED') toast.error('Failed checks: enter an override note, then approve again.'); } },
    );
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent wide className="max-w-6xl" title={`Page ${p.position + 1}: ${p.concept}`} description={`${titleCase(p.status)}${v ? ` · version ${v.version} (${v.source.toLowerCase()})` : ''}`}>
        {!v ? (
          <div className="grid gap-2"><p className="text-sm text-muted-foreground">{p.error ?? 'No image yet.'}</p>{editable && <Button onClick={() => onGenerate('NEW')}><Sparkles /> Generate…</Button>}</div>
        ) : (
          <div className="grid gap-4 lg:grid-cols-[1fr_1fr_320px]">
            <figure className="grid content-start gap-1"><figcaption className="text-xs font-medium">Original (never modified)</figcaption><img src={assetUrl(v.originalAssetId)} alt="Original" className="max-h-[60vh] w-full rounded border bg-white object-contain" /><a className="text-xs underline" href={assetUrl(v.originalAssetId)} download><Download className="mr-1 inline size-3" />Download original</a></figure>
            <figure className="grid content-start gap-1"><figcaption className="text-xs font-medium">Processed (used in the interior)</figcaption>{v.processedAssetId ? <><img src={assetUrl(v.processedAssetId)} alt="Processed" className="max-h-[60vh] w-full rounded border bg-white object-contain" /><a className="text-xs underline" href={assetUrl(v.processedAssetId)} download><Download className="mr-1 inline size-3" />Download print image</a></> : <p className="text-xs text-destructive">Processing failed — see QC.</p>}{v.processing && <p className="text-xs text-muted-foreground">{v.processing.steps.join(' · ')}</p>}</figure>
            <div className="grid content-start gap-3">
              {editable && (
                <div className="flex flex-wrap gap-1">
                  <Button size="sm" onClick={approve} loading={status.isPending}><Check /> Approve</Button>
                  <Button size="sm" variant="outline" onClick={() => status.mutate({ status: 'REJECTED' })}><X /> Reject</Button>
                  <Button size="sm" variant="ghost" onClick={() => fav.mutate(!p.favorite)} aria-pressed={p.favorite}><Heart className={p.favorite ? 'fill-current' : ''} /></Button>
                  <Button size="sm" variant="outline" onClick={() => onGenerate('NEW')}>Regenerate</Button>
                  <Button size="sm" variant="outline" onClick={() => onGenerate('VARIATION')}>Variation</Button>
                  <Button size="sm" variant="outline" onClick={() => onGenerate('EDIT')}>Edit image</Button>
                  <Button size="sm" variant="outline" onClick={() => fileRef.current?.click()}><Upload /> Replace</Button>
                  <Button size="sm" variant="ghost" onClick={() => dup.mutate(undefined)}>Duplicate page</Button>
                  <input ref={fileRef} type="file" accept="image/png,image/jpeg" className="hidden" onChange={async (e) => {
                    const file = e.target.files?.[0];
                    if (!file) return;
                    const note = prompt('License / permission note for this image (required for images you did not create):', '') ?? '';
                    const fd = new FormData();
                    fd.append('file', file);
                    fd.append('projectId', b.projectId);
                    fd.append('licenseNote', note);
                    try {
                      const a = await api.upload<{ id: string }>('/assets', fd);
                      await api.post(`/coloring/${b.id}/pages/${pageId}/replace`, { assetId: a.id });
                      toast.success('Replaced (new version; previous versions kept)');
                      await qc.invalidateQueries({ queryKey: ['coloring-book', b.id] });
                    } catch (err) {
                      toast.error((err as Error).message);
                    }
                    e.target.value = '';
                  }} />
                </div>
              )}
              {p.similarTo.length > 0 && <p className="rounded bg-warning/10 p-2 text-xs text-warning">Looks very similar to page(s) #{p.similarTo.map((s) => s.position + 1).join(', #')} (perceptual hash).</p>}
              {v.qc && <QcList checks={v.qc.checks} override={p.qcOverride} />}
              {editable && warn.length > 0 && (
                <div className="grid gap-1">
                  <Field label="Override note (recorded with your name)" htmlFor="ov-note"><Input id="ov-note" value={overrideNote} onChange={(e) => setOverrideNote(e.target.value)} placeholder="e.g. Checked at 100%; gray is intentional texture" /></Field>
                  <Button size="sm" variant="outline" disabled={overrideNote.trim().length < 3} onClick={() => override.mutate(warn.map((w) => w.id))}>Override {warn.length} warning(s)</Button>
                </div>
              )}
              <details className="text-sm">
                <summary className="cursor-pointer font-medium">Processing</summary>
                <div className="mt-2 grid grid-cols-2 gap-2">
                  <Field label="Threshold (blank = keep grays)" htmlFor="pr-t"><Input id="pr-t" value={proc.threshold} onChange={(e) => setProc({ ...proc, threshold: e.target.value })} /></Field>
                  <Field label="Denoise (0–7)" htmlFor="pr-d"><Input id="pr-d" type="number" min={0} max={7} value={proc.denoise} onChange={(e) => setProc({ ...proc, denoise: e.target.value })} /></Field>
                  <Field label="Resample to DPI" htmlFor="pr-u"><Input id="pr-u" type="number" min={0} max={600} value={proc.upscaleToDpi} onChange={(e) => setProc({ ...proc, upscaleToDpi: e.target.value })} /></Field>
                  <Field label="White margin (0–0.3)" htmlFor="pr-m"><Input id="pr-m" type="number" step="0.01" min={0} max={0.3} value={proc.paddingRatio} onChange={(e) => setProc({ ...proc, paddingRatio: e.target.value })} /></Field>
                  <label className="flex items-center gap-2 text-xs"><Switch checked={proc.grayscale} onCheckedChange={(x) => setProc({ ...proc, grayscale: x })} /> Grayscale</label>
                  <label className="flex items-center gap-2 text-xs"><Switch checked={proc.trimWhitespace} onCheckedChange={(x) => setProc({ ...proc, trimWhitespace: x })} /> Trim white space</label>
                  <label className="col-span-2 flex items-center gap-2 text-xs"><Switch checked={proc.padToAspect} onCheckedChange={(x) => setProc({ ...proc, padToAspect: x })} /> Pad to page aspect (center; never crops art)</label>
                </div>
                {editable && <Button size="sm" className="mt-2" variant="outline" onClick={() => process.mutate(undefined)} loading={process.isPending}><RefreshCw /> Re-process this version</Button>}
              </details>
              <details className="text-sm">
                <summary className="cursor-pointer font-medium">Prompt used</summary>
                <p className="mt-1 text-xs">{v.prompt || '(uploaded image)'}</p>
                {v.negativePrompt && <p className="mt-1 text-xs text-muted-foreground">Negative: {v.negativePrompt}</p>}
                <p className="mt-1 text-xs text-muted-foreground">Estimated {money(v.estimatedCostUsd === null ? null : Number(v.estimatedCostUsd))} · actual {v.actualCostUsd === null ? 'not reported' : money(Number(v.actualCostUsd))}</p>
              </details>
            </div>
            <div className="lg:col-span-3">
              <p className="mb-1 text-sm font-medium">Versions ({p.versions.length})</p>
              <div className="flex gap-2 overflow-x-auto pb-1">
                {p.versions.map((x) => (
                  <div key={x.id} className={cn('grid w-28 shrink-0 gap-1 rounded border p-1 text-xs', x.id === v.id && 'ring-2 ring-primary')}>
                    <button onClick={() => setViewId(x.id)} aria-label={`View version ${x.version}`}><img src={assetUrl(x.processedAssetId ?? x.originalAssetId)} alt="" className="aspect-[3/4] w-full object-contain" loading="lazy" /></button>
                    <span>v{x.version} · {x.source.toLowerCase()}{x.id === p.currentVersionId ? ' · current' : ''}</span>
                    {editable && x.id !== p.currentVersionId && <Button size="sm" variant="ghost" onClick={() => restore.mutate(x.id)}>Restore</Button>}
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

/* ----------------------------------------- Interior ---------------------------------------- */

interface InteriorSummary { illustrations: number; pageCount: number; pageWidthIn: number; pageHeightIn: number; warnings: { code: string; message: string; level: string }[]; pages: { index: number; blank: boolean; hasImage: boolean }[] }

function InteriorTab({ b, editable }: { b: ColoringBookDetail; editable: boolean }) {
  const [s, setS] = useState<InteriorSettings>(b.interior);
  const [summary, setSummary] = useState<InteriorSummary | null>(null);
  useEffect(() => setS(b.interior), [JSON.stringify(b.interior)]); // eslint-disable-line react-hooks/exhaustive-deps
  const save = useBookAction(b.id, () => api.patch(`/coloring/${b.id}`, { interior: s }), 'Interior settings saved');
  const build = useAction(async () => {
    if (JSON.stringify(s) !== JSON.stringify(b.interior)) await api.patch(`/coloring/${b.id}`, { interior: s });
    return api.post<InteriorSummary>(`/coloring/${b.id}/interior`);
  }, { success: (r) => `Interior built: ${r.illustrations} illustrations on ${r.pageCount} pages`, onSuccess: setSummary, invalidate: [['coloring-book', b.id], ['project', b.projectId]] });
  const sw = (k: keyof InteriorSettings, label: string) => <label className="flex items-center gap-2 text-sm"><Switch checked={s[k] as boolean} disabled={!editable} onCheckedChange={(v) => setS({ ...s, [k]: v })} /> {label}</label>;
  const thumbs = useMemo(() => summary?.pages.slice(0, 24) ?? [], [summary]);
  return (
    <div className="grid gap-4">
      <Card>
        <CardHeader><CardTitle>Interior settings</CardTitle><CardDescription>Built deterministically from approved pages in plan order. Trim, bleed and margin minimums come from the versioned print specification — not from the image model. Illustrations: {b.approvedCount}; the page count is computed by the layout.</CardDescription></CardHeader>
        <CardContent className="grid gap-3 md:grid-cols-3">
          {sw('singleSided', 'Single-sided (blank reverse pages)')}
          {sw('rectoOnly', 'Illustrations on right-hand pages')}
          {sw('pageNumbers', 'Page numbers')}
          {sw('titlePage', 'Title page')}
          {sw('copyrightPage', 'Copyright page')}
          {sw('belongsTo', '“This book belongs to” page')}
          {sw('testPage', 'Color test page')}
          {sw('fullBleed', 'Full bleed (art to the trim edge)')}
          <Field label={`Image scale (${Math.round(s.scale * 100)}% of the live area)`} htmlFor="in-scale"><input id="in-scale" type="range" min={0.5} max={1} step={0.05} value={s.scale} disabled={!editable} onChange={(e) => setS({ ...s, scale: Number(e.target.value) })} /></Field>
          <Field label="Vertical alignment" htmlFor="in-va"><Select id="in-va" value={s.verticalAlign} disabled={!editable} onChange={(e) => setS({ ...s, verticalAlign: e.target.value as InteriorSettings['verticalAlign'] })}><option value="top">Top</option><option value="center">Center</option><option value="bottom">Bottom</option></Select></Field>
          <fieldset className="grid grid-cols-4 gap-1 md:col-span-3"><legend className="mb-1 text-sm font-medium">Margins (in) — validated against the spec minimums at build time</legend>
            {(['inside', 'outside', 'top', 'bottom'] as const).map((k) => <Input key={k} aria-label={`${k} margin`} type="number" step="0.05" min={0.125} max={2} value={s.marginsIn[k]} disabled={!editable} onChange={(e) => setS({ ...s, marginsIn: { ...s.marginsIn, [k]: Number(e.target.value) } })} />)}
          </fieldset>
          {editable && <div className="flex gap-2 md:col-span-3"><Button variant="outline" onClick={() => save.mutate(undefined)} loading={save.isPending}>Save settings</Button><Button onClick={() => build.mutate(undefined)} loading={build.isPending} disabled={!b.approvedCount}>Build interior from {b.approvedCount} approved page(s)</Button></div>}
        </CardContent>
      </Card>
      {summary && (
        <Card>
          <CardHeader><CardTitle>Interior: {summary.illustrations} illustrations → {summary.pageCount} pages</CardTitle><CardDescription>Page size {summary.pageWidthIn}″ × {summary.pageHeightIn}″. <Link className="underline" to={`/projects/${b.projectId}/interior`}>Open the full interior preview & editor</Link></CardDescription></CardHeader>
          <CardContent className="grid gap-3">
            {summary.warnings.length > 0 && <ul className="text-xs text-warning">{summary.warnings.map((w, i) => <li key={i}>{w.level}: {w.message}</li>)}</ul>}
            <div className="grid grid-cols-4 gap-2 md:grid-cols-8">
              {thumbs.map((p) => <figure key={p.index} className="grid gap-0.5 text-center text-[10px] text-muted-foreground"><img src={`/api/projects/${b.projectId}/interior/pages/${p.index + 1}/preview.png?dpi=24&guides=1`} alt={`Interior page ${p.index + 1}`} className="w-full border bg-white" loading="lazy" /><figcaption>{p.index + 1}{p.blank ? ' · blank' : ''}</figcaption></figure>)}
            </div>
            {summary.pages.length > 24 && <p className="text-xs text-muted-foreground">Showing the first 24 of {summary.pages.length} pages.</p>}
          </CardContent>
        </Card>
      )}
    </div>
  );
}

/* -------------------------------------- Cover / Preflight ----------------------------------- */

function CoverTab({ b }: { b: ColoringBookDetail }) {
  return (
    <Card>
      <CardHeader><CardTitle>Cover</CardTitle><CardDescription>Covers use the project’s cover designer: full-wrap geometry (spine from the interior page count, bleed, barcode area, safe zones) comes from the print specification; title and author are live, editable text. Use “AI art” there to generate background art with a model you choose — after confirming its estimated cost.</CardDescription></CardHeader>
      <CardContent className="flex flex-wrap gap-2">
        <Button asChild><Link to={`/projects/${b.projectId}/cover`}>Open cover designer</Link></Button>
        <p className="w-full text-xs text-muted-foreground">Build the interior first so the spine width matches the final page count.</p>
      </CardContent>
    </Card>
  );
}

interface PfRule { ruleId: string; title: string; status: string; evidence: string; suggestion: string; blocking: boolean }
interface Preflight { disclaimer: string; counts: { illustrations: number; interiorPages: number }; blocked: boolean; automated: PfRule[]; visualWarnings: { position: number; check: string; message: string; overridden: boolean }[]; manualReview: { rules: PfRule[]; coloring: string[] }; officialNeedsVerification: PfRule[]; content: PfRule[] }

function RuleRows({ rules }: { rules: PfRule[] }) {
  const tone = (s: string) => (s === 'PASS' ? 'success' : s === 'FAIL' ? 'danger' : s === 'WARNING' ? 'warning' : 'review');
  return <ul className="grid gap-1 text-xs">{rules.map((r) => <li key={r.ruleId} className="flex gap-2"><Badge tone={tone(r.status)} className="shrink-0">{r.status === 'NEEDS_HUMAN_REVIEW' ? 'REVIEW' : r.status}</Badge><span><strong>{r.title}</strong> — {r.evidence}{r.blocking ? ' (blocks final export)' : ''}</span></li>)}</ul>;
}

function PreflightTab({ b }: { b: ColoringBookDetail }) {
  const run = useAction(() => api.post<Preflight>(`/coloring/${b.id}/preflight`), { onSuccess: () => {}, invalidate: [['coloring-book', b.id]] });
  const r = run.data;
  return (
    <div className="grid gap-4">
      <div className="flex items-center gap-2"><Button onClick={() => run.mutate(undefined)} loading={run.isPending}>Run preflight</Button><span className="text-xs text-muted-foreground">Builds the interior + cover with the current settings and checks them.</span></div>
      {r && (
        <>
          <p className="rounded border border-warning/40 bg-warning/10 p-2 text-sm">{r.disclaimer}</p>
          <p className="text-sm">{r.counts.illustrations} illustrations · {r.counts.interiorPages} interior pages · {r.blocked ? <Badge tone="danger">Final export blocked</Badge> : <Badge tone="success">No blocking failures</Badge>}</p>
          <div className="grid gap-4 lg:grid-cols-2">
            <Card><CardHeader><CardTitle>Automated checks</CardTitle><CardDescription>Measured against the print specification.</CardDescription></CardHeader><CardContent><RuleRows rules={r.automated} /></CardContent></Card>
            <Card><CardHeader><CardTitle>Visual warnings (heuristic)</CardTitle><CardDescription>Pixel statistics on approved pages — signals, not verdicts.</CardDescription></CardHeader><CardContent>{r.visualWarnings.length === 0 ? <p className="text-sm text-muted-foreground">None.</p> : <ul className="grid gap-1 text-xs">{r.visualWarnings.map((w, i) => <li key={i}>Page {w.position + 1} · <strong>{w.check}</strong>: {w.message}{w.overridden ? ' (overridden)' : ''}</li>)}</ul>}</CardContent></Card>
            <Card><CardHeader><CardTitle>Manual review</CardTitle></CardHeader><CardContent className="grid gap-2"><RuleRows rules={r.manualReview.rules} /><ul className="ml-4 list-disc text-xs">{r.manualReview.coloring.map((m) => <li key={m}>{m}</li>)}</ul><Link className="text-xs underline" to={`/projects/${b.projectId}/validation`}>Record review decisions in the validation panel</Link></CardContent></Card>
            <Card><CardHeader><CardTitle>Official requirements needing verification</CardTitle><CardDescription>These rules rely on values we could not verify against a current official KDP source. Confirm them before publishing.</CardDescription></CardHeader><CardContent><RuleRows rules={r.officialNeedsVerification} /></CardContent></Card>
            {r.content.length > 0 && <Card className="lg:col-span-2"><CardHeader><CardTitle>Content & metadata findings</CardTitle></CardHeader><CardContent><RuleRows rules={r.content} /></CardContent></Card>}
          </div>
        </>
      )}
    </div>
  );
}

/* ------------------------------------- Metadata / Export ------------------------------------ */

function MetadataTab({ b, editable }: { b: ColoringBookDetail; editable: boolean }) {
  const [copy, setCopy] = useState(b.metadataExtras.backCoverCopy ?? '');
  const checks = b.metadataExtras.checklist ?? {};
  const save = useBookAction(b.id, (body: Record<string, unknown>) => api.patch(`/coloring/${b.id}`, body), 'Saved');
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card>
        <CardHeader><CardTitle>Listing metadata</CardTitle><CardDescription>Title, subtitle, description, keywords, categories and series are edited in the project’s metadata editor (with keyword evidence logging and policy checks).</CardDescription></CardHeader>
        <CardContent className="grid gap-3">
          <Button asChild variant="outline"><Link to={`/projects/${b.projectId}/metadata`}>Open metadata editor</Link></Button>
          <Field label="Back-cover copy" htmlFor="md-back" hint="Describe what is actually inside (illustration count, audience, single-sided). No reviews, rankings or demand claims."><Textarea id="md-back" rows={6} value={copy} disabled={!editable} onChange={(e) => setCopy(e.target.value)} /></Field>
          {editable && <Button disabled={copy === (b.metadataExtras.backCoverCopy ?? '')} onClick={() => save.mutate({ backCoverCopy: copy })}>Save back-cover copy</Button>}
        </CardContent>
      </Card>
      <Card>
        <CardHeader><CardTitle>Coloring book checklist</CardTitle></CardHeader>
        <CardContent>
          <ul className="grid gap-2 text-sm">
            {b.metadataChecklist.map((item, i) => (
              <li key={i}><label className="flex items-start gap-2"><input type="checkbox" className="mt-1" disabled={!editable} checked={!!checks[String(i)]} onChange={(e) => save.mutate({ checklist: { [String(i)]: e.target.checked } })} /> {item}</label></li>
            ))}
          </ul>
        </CardContent>
      </Card>
    </div>
  );
}

function ExportTab({ b, editable }: { b: ColoringBookDetail; editable: boolean }) {
  const [jobId, setJobId] = useState<string | null>(null);
  const run = useAction((kinds: string[]) => api.post<{ id: string }>(`/projects/${b.projectId}/exports`, { kinds }), { success: 'Export started', onSuccess: (j) => setJobId(j.id), invalidate: [['jobs']] });
  const job = useQuery({ queryKey: ['job', jobId], enabled: !!jobId, queryFn: () => api.get<JobSummary>(`/jobs/${jobId}`), refetchInterval: (d) => (d.state.data && ['QUEUED', 'RUNNING'].includes(d.state.data.status) ? 1500 : false) });
  const FULL = ['INTERIOR_PDF', 'COVER_PDF', 'COVER_SVG', 'INTERIOR_PROOF_PDF', 'COLORING_PAGES_ZIP', 'COLORING_PROMPT_LOG', 'COLORING_QC_REPORT', 'VALIDATION_REPORT', 'METADATA_JSON', 'METADATA_CSV', 'PROJECT_JSON'];
  const WORK = ['INTERIOR_PROOF_PDF', 'COVER_SVG', 'COLORING_PAGES_ZIP', 'COLORING_PROMPT_LOG', 'COLORING_QC_REPORT', 'VALIDATION_REPORT'];
  return (
    <Card>
      <CardHeader><CardTitle>Export package</CardTitle><CardDescription>The full package contains the print-ready interior PDF, cover PDF, editable cover SVG, proof PDF, approved page images (original + print versions), prompt/generation log, QC report, preflight report, metadata and a manifest with checksums. Final PDFs are only produced when preflight has no blocking failures and required reviews are recorded.</CardDescription></CardHeader>
      <CardContent className="grid gap-3">
        {editable && <div className="flex flex-wrap gap-2"><Button onClick={() => run.mutate(FULL)} loading={run.isPending}>Export full package</Button><Button variant="outline" onClick={() => run.mutate(WORK)}>Export working files only (no final PDFs)</Button></div>}
        {job.data && <JobCard job={job.data} compact />}
        <Link className="text-sm underline" to={`/projects/${b.projectId}/exports`}>Open the export center (downloads, manifests, history)</Link>
      </CardContent>
    </Card>
  );
}
