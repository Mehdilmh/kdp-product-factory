import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ExternalLink, GitCompare, RefreshCw, Search, Star } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { Badge, Card, CardContent, CardDescription, CardHeader, CardTitle, EmptyState, ErrorBox, Field, Input, PageHeader, Select, Skeleton, Textarea } from '@/components/ui/basic';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogTrigger, Switch } from '@/components/ui/overlay';
import { AVAILABILITY, EstimateView, money, PriceLine, useModels, type GenerationRow, type ModelRow } from '@/features/image-models';
import { api } from '@/lib/api';
import { canEdit, useAuth } from '@/lib/auth';
import { useAction } from '@/lib/hooks';
import { fmtDate, titleCase } from '@/lib/utils';
import type { CostEstimate } from '@kdp/core/browser';

const FILTER_LABELS: Record<string, string> = {
  cheapest: 'Cheapest',
  'concept-drafts': 'Concept drafts',
  illustrated: 'Illustrated',
  photorealistic: 'Photorealistic',
  typography: 'Typography',
  editing: 'Editing',
  'reference-images': 'Reference images',
  'high-resolution': 'High resolution',
  'commercial-info': 'Commercial-use info',
  'text-to-image': 'Text-to-image',
  'image-to-image': 'Image-to-image',
  'line-art': 'Line art',
  vector: 'Vector',
  upscaling: 'Upscaling',
};

export default function ModelsPage() {
  const { role } = useAuth();
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState('');
  const [sort, setSort] = useState('recommended');
  const [w, setW] = useState(1024);
  const [h, setH] = useState(1024);
  const [n, setN] = useState(1);
  const [showAll, setShowAll] = useState(false);
  const [compare, setCompare] = useState<string[]>([]);
  const list = useModels({ q, filter, sort, widthPx: w, heightPx: h, numImages: n, includeUnavailable: showAll });
  const editable = canEdit(role);
  const data = list.data;

  return (
    <>
      <PageHeader
        title="Image model library"
        description="Models come from fal.ai’s official catalog (Platform API) and are only usable after verification. Prices come from fal’s pricing API or an admin-recorded source; estimates are never shown as guarantees."
        actions={data?.canAdmin && <AdminSync last={data.lastSync} falConfigured={data.falConfigured} />}
      />
      {data && !data.falConfigured && (
        <div className="mb-4 rounded-lg border border-warning/40 bg-warning/10 p-3 text-sm">FAL_KEY is not configured on the server, so catalog sync, live prices and real generation are unavailable. The offline mock models still work for testing the workflow.</div>
      )}
      <Card className="mb-4">
        <CardContent className="grid gap-3 pt-5 md:grid-cols-[1fr_auto_auto] md:items-end">
          <div className="grid gap-2 sm:grid-cols-[1fr_180px_150px]">
            <Field label="Search" htmlFor="m-q"><div className="relative"><Search className="absolute left-2 top-2.5 size-4 text-muted-foreground" aria-hidden /><Input id="m-q" className="pl-8" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Name, family or endpoint" /></div></Field>
            <Field label="Filter" htmlFor="m-f"><Select id="m-f" value={filter} onChange={(e) => setFilter(e.target.value)}><option value="">All</option>{(data?.filters ?? []).map((f) => <option key={f} value={f}>{FILTER_LABELS[f] ?? titleCase(f)}</option>)}</Select></Field>
            <Field label="Sort" htmlFor="m-s"><Select id="m-s" value={sort} onChange={(e) => setSort(e.target.value)}><option value="recommended">Recommended</option><option value="price">Price per image</option><option value="name">Name</option><option value="verified">Recently verified</option></Select></Field>
          </div>
          <fieldset className="grid grid-cols-3 gap-2">
            <legend className="mb-1 text-sm font-medium">Estimate for</legend>
            <Input aria-label="Width px" type="number" min={64} max={16384} value={w} onChange={(e) => setW(Number(e.target.value) || 1024)} />
            <Input aria-label="Height px" type="number" min={64} max={16384} value={h} onChange={(e) => setH(Number(e.target.value) || 1024)} />
            <Input aria-label="Number of images" type="number" min={1} max={1000} value={n} onChange={(e) => setN(Math.max(1, Number(e.target.value) || 1))} />
          </fieldset>
          <label className="flex items-center gap-2 text-sm"><Switch checked={showAll} onCheckedChange={setShowAll} aria-label="Show unavailable models" /> Show unavailable</label>
        </CardContent>
      </Card>
      {compare.length > 0 && (
        <div className="sticky top-2 z-10 mb-4 flex flex-wrap items-center gap-2 rounded-lg border bg-background p-2 shadow">
          <span className="text-sm">{compare.length} selected for comparison</span>
          <CompareDialog modelIds={compare} models={data?.models ?? []} onDone={() => setCompare([])} disabled={!editable} />
          <Button size="sm" variant="ghost" onClick={() => setCompare([])}>Clear</Button>
        </div>
      )}
      {list.isLoading ? <Skeleton className="h-96" /> : list.error ? <ErrorBox error={list.error} /> : !data?.models.length ? (
        <EmptyState title="No models match" description={filter === 'cheapest' ? 'No model has a verified price yet. Sync the catalog (admin) or record a price with its source.' : 'Try another filter.'} />
      ) : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {data.models.map((m) => (
            <ModelCard key={m.id} m={m} preferred={data.preferredModelId === m.id} canAdmin={data.canAdmin} editable={editable} selected={compare.includes(m.id)} onToggleCompare={() => setCompare((c) => (c.includes(m.id) ? c.filter((x) => x !== m.id) : c.length >= 8 ? c : [...c, m.id]))} />
          ))}
        </div>
      )}
      <Comparisons />
    </>
  );
}

function ModelCard({ m, preferred, canAdmin, editable, selected, onToggleCompare }: { m: ModelRow; preferred: boolean; canAdmin: boolean; editable: boolean; selected: boolean; onToggleCompare: () => void }) {
  const qc = useQueryClient();
  const prefer = useAction(() => api.post('/image-models/preferred', { modelId: m.id }), { success: `${m.displayName} is now the workspace default`, invalidate: [['image-models']] });
  const av = AVAILABILITY[m.availability];
  const caps = m.capabilities;
  const sizes = caps ? [caps.imageSize?.presets?.length ? `${caps.imageSize.presets.length} size presets` : null, caps.imageSize?.allowsCustom ? `custom size up to ${caps.imageSize.maxDimension ?? '?'}px` : null, caps.aspectRatio?.values.length ? `ratios ${caps.aspectRatio.values.join(', ')}` : null, caps.resolution?.values.length ? `resolution ${caps.resolution.values.join('/')}` : null, caps.negativePromptParam ? 'negative prompt' : null].filter(Boolean) : [];
  return (
    <Card className={selected ? 'ring-2 ring-primary' : undefined}>
      <CardHeader>
        <div className="flex items-start gap-3">
          {m.thumbnailUrl ? <img src={m.thumbnailUrl} alt="" className="size-16 shrink-0 rounded object-cover" loading="lazy" referrerPolicy="no-referrer" /> : <div className="grid size-16 shrink-0 place-items-center rounded bg-muted text-[10px] text-muted-foreground">no sample</div>}
          <div className="min-w-0">
            <CardTitle className="flex items-center gap-1">{m.displayName}{preferred && <Star className="size-4 fill-current text-warning" aria-label="Preferred model" />}</CardTitle>
            <CardDescription className="truncate font-mono text-xs" title={m.endpointId}>{m.provider} · {m.endpointId}</CardDescription>
            <div className="mt-1 flex flex-wrap gap-1"><Badge tone={av.tone}>{av.label}</Badge>{m.enabled ? null : <Badge tone="muted">Disabled</Badge>}</div>
          </div>
        </div>
      </CardHeader>
      <CardContent className="grid gap-2 text-sm">
        {m.description && <p className="line-clamp-2 text-muted-foreground">{m.description}</p>}
        <div className="flex flex-wrap gap-1">{m.tasks.map((t) => <Badge key={t} tone="primary">{t}</Badge>)}{m.editorialTags.map((t) => <Badge key={t} tone="muted">{FILTER_LABELS[t] ?? t}</Badge>)}</div>
        {sizes.length > 0 && <p className="text-xs text-muted-foreground">{sizes.join(' · ')}</p>}
        <PriceLine m={m} />
        {m.price && !m.price.isBuiltIn && <EstimateView e={m.estimate} compact />}
        {m.knownLimitations && <p className="text-xs text-muted-foreground"><strong>Limitations:</strong> {m.knownLimitations}</p>}
        <p className="text-xs">
          {m.commercialUseUrl ? <a className="inline-flex items-center gap-1 underline" href={m.commercialUseUrl} target="_blank" rel="noreferrer">Commercial-use terms <ExternalLink className="size-3" /></a> : m.commercialUseNote ? m.commercialUseNote : <span className="text-muted-foreground">No commercial-use information recorded — check the model page.</span>}
          {m.modelUrl && <> · <a className="underline" href={m.modelUrl} target="_blank" rel="noreferrer">Model page</a></>}
        </p>
        <p className="text-xs text-muted-foreground">Last verified: {m.capabilitiesVerifiedAt ? fmtDate(m.capabilitiesVerifiedAt) : m.availability === 'OFFLINE_MOCK' ? 'built in' : 'never'}{m.lastSyncError ? ` · ${m.lastSyncError}` : ''}{m.lastPriceError ? ` · Price: ${m.lastPriceError}` : ''}</p>
        <div className="flex flex-wrap gap-2 pt-1">
          <Button size="sm" disabled={!m.usable || !editable || preferred} onClick={() => prefer.mutate(undefined)} loading={prefer.isPending}>{preferred ? 'Selected' : 'Select'}</Button>
          <Button size="sm" variant="outline" disabled={!m.usable} onClick={onToggleCompare} aria-pressed={selected}><GitCompare /> {selected ? 'Remove' : 'Compare'}</Button>
          {canAdmin && <AdminModelDialog m={m} onSaved={() => void qc.invalidateQueries({ queryKey: ['image-models'] })} />}
        </div>
        {!m.usable && m.availability === 'CANDIDATE_UNVERIFIED' && <p className="text-xs text-muted-foreground">Listed as a candidate; it becomes selectable only after a catalog sync confirms the endpoint and its input schema.</p>}
      </CardContent>
    </Card>
  );
}

function AdminSync({ last, falConfigured }: { last: { startedAt: string; verified: string[]; notFound: string[]; discovered: string[]; priced: string[]; priceMissing: string[]; errors: string[] } | null; falConfigured: boolean }) {
  const [discover, setDiscover] = useState(false);
  const sync = useAction(() => api.post<{ verified: string[]; errors: string[] }>('/admin/image-models/sync', { discover, pricing: true }), { success: (r) => `Sync finished: ${r.verified.length} verified${r.errors.length ? `, ${r.errors.length} error(s)` : ''}`, invalidate: [['image-models']] });
  return (
    <div className="flex flex-wrap items-center gap-2 text-sm">
      <label className="flex items-center gap-1"><input type="checkbox" checked={discover} onChange={(e) => setDiscover(e.target.checked)} /> discover new models</label>
      <Button size="sm" variant="outline" disabled={!falConfigured} onClick={() => sync.mutate(undefined)} loading={sync.isPending}><RefreshCw /> Sync catalog & prices</Button>
      {last && (
        <span className="text-xs text-muted-foreground" title={last.errors.join('\n')}>
          Last sync {fmtDate(last.startedAt)}: {last.verified.length} verified, {last.notFound.length} not found, {last.priced.length} priced{last.errors.length ? `, ${last.errors.length} error(s)` : ''}
        </span>
      )}
    </div>
  );
}

function AdminModelDialog({ m, onSaved }: { m: ModelRow; onSaved: () => void }) {
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ enabled: m.enabled, knownLimitations: m.knownLimitations, commercialUseUrl: m.commercialUseUrl, commercialUseNote: m.commercialUseNote, adminNotes: m.adminNotes, editorialTags: m.editorialTags.join(', ') });
  const [price, setPrice] = useState({ unitPrice: '', unitRaw: 'image', sourceUrl: '', tokensPerImage: '' });
  const save = useAction(() => api.patch(`/admin/image-models/${m.id}`, { ...form, editorialTags: form.editorialTags.split(',').map((s) => s.trim()).filter(Boolean) }), { success: 'Model updated', onSuccess: onSaved });
  const savePrice = useAction(
    () => api.post(`/admin/image-models/${m.id}/price`, { unitPrice: Number(price.unitPrice), unitRaw: price.unitRaw, sourceUrl: price.sourceUrl, assumptions: price.tokensPerImage ? { tokensPerImage: Number(price.tokensPerImage) } : {} }),
    { success: 'Price recorded (previous price kept in history)', onSuccess: onSaved },
  );
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild><Button size="sm" variant="ghost">Admin</Button></DialogTrigger>
      <DialogContent wide title={`Manage ${m.displayName}`} description="Changes apply to every workspace. Only verified models can be enabled.">
        <div className="grid gap-4 md:grid-cols-2">
          <div className="grid content-start gap-3">
            <label className="flex items-center gap-2 text-sm"><Switch checked={form.enabled} onCheckedChange={(v) => setForm({ ...form, enabled: v })} disabled={!(m.availability === 'VERIFIED' || m.availability === 'OFFLINE_MOCK')} /> Enabled for generation</label>
            <Field label="Editorial tags (comma separated)" htmlFor="adm-tags" hint="concept-drafts, illustrated, photorealistic, typography, editing, reference-images, high-resolution, line-art, vector, upscaling"><Input id="adm-tags" value={form.editorialTags} onChange={(e) => setForm({ ...form, editorialTags: e.target.value })} /></Field>
            <Field label="Known limitations" htmlFor="adm-lim"><Textarea id="adm-lim" rows={2} value={form.knownLimitations} onChange={(e) => setForm({ ...form, knownLimitations: e.target.value })} /></Field>
            <Field label="Commercial-use link (https)" htmlFor="adm-cu"><Input id="adm-cu" value={form.commercialUseUrl} onChange={(e) => setForm({ ...form, commercialUseUrl: e.target.value })} /></Field>
            <Field label="Commercial-use note" htmlFor="adm-cn"><Input id="adm-cn" value={form.commercialUseNote} onChange={(e) => setForm({ ...form, commercialUseNote: e.target.value })} /></Field>
            <Button onClick={() => save.mutate(undefined)} loading={save.isPending}>Save</Button>
          </div>
          <div className="grid content-start gap-3">
            <p className="text-sm font-medium">Record a verified price</p>
            <p className="text-xs text-muted-foreground">Use only when fal’s pricing API does not return this endpoint. A source URL is required; the previous price stays in history.</p>
            <div className="grid grid-cols-2 gap-2">
              <Field label="Unit price (USD)" htmlFor="p-up"><Input id="p-up" type="number" step="0.0001" min={0} value={price.unitPrice} onChange={(e) => setPrice({ ...price, unitPrice: e.target.value })} /></Field>
              <Field label="Unit" htmlFor="p-u" hint="e.g. image, megapixels, 1M tokens"><Input id="p-u" value={price.unitRaw} onChange={(e) => setPrice({ ...price, unitRaw: e.target.value })} /></Field>
            </div>
            <Field label="Source URL (https)" htmlFor="p-src"><Input id="p-src" value={price.sourceUrl} onChange={(e) => setPrice({ ...price, sourceUrl: e.target.value })} /></Field>
            <Field label="Tokens per image (token-priced models only)" htmlFor="p-tpi" hint="Without this assumption, token-priced models show “Cannot estimate”."><Input id="p-tpi" type="number" min={0} value={price.tokensPerImage} onChange={(e) => setPrice({ ...price, tokensPerImage: e.target.value })} /></Field>
            <Button variant="outline" disabled={!price.unitPrice || !price.sourceUrl.startsWith('https://')} onClick={() => savePrice.mutate(undefined)} loading={savePrice.isPending}>Record price</Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

interface CompareEstimate {
  items: { modelId: string; displayName: string; usable: boolean; errors: string[]; estimate: CostEstimate }[];
  knownTotalUsd: number;
  unverifiedCount: number;
}

function CompareDialog({ modelIds, models, onDone, disabled }: { modelIds: string[]; models: ModelRow[]; onDone: () => void; disabled: boolean }) {
  const [open, setOpen] = useState(false);
  const [prompt, setPrompt] = useState('');
  const [size, setSize] = useState(1024);
  const [ack, setAck] = useState(false);
  const qc = useQueryClient();
  const request = { prompt, widthPx: size, heightPx: size, numImages: 1 };
  const est = useQuery({ queryKey: ['compare-estimate', modelIds, prompt, size], enabled: open && prompt.length > 2, queryFn: () => api.post<CompareEstimate>('/image-compare/estimate', { modelIds, request }) });
  const run = useAction(() => api.post<{ comparisonId: string }>('/image-compare', { name: prompt.slice(0, 60), modelIds, request, confirmation: { acceptedTotalUsd: est.data!.knownTotalUsd, acceptUnverifiedCost: est.data!.unverifiedCount > 0 } }), {
    success: 'Comparison started',
    onSuccess: () => {
      setOpen(false);
      onDone();
      void qc.invalidateQueries({ queryKey: ['comparisons'] });
    },
  });
  const blocked = est.data?.items.some((i) => !i.usable || i.errors.length);
  return (
    <Dialog open={open} onOpenChange={(o) => { setOpen(o); setAck(false); }}>
      <DialogTrigger asChild><Button size="sm" disabled={disabled}><GitCompare /> Compare with one brief</Button></DialogTrigger>
      <DialogContent wide title="Compare models" description="Each selected model generates one image from the same brief and settings, so the cost stays predictable.">
        <div className="grid gap-3">
          <Field label="Brief" htmlFor="cmp-p"><Textarea id="cmp-p" rows={3} value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="A friendly fox in a forest, clean black outlines on white, coloring page" /></Field>
          <Field label="Size (square, px)" htmlFor="cmp-s"><Select id="cmp-s" value={size} onChange={(e) => setSize(Number(e.target.value))}><option value={1024}>1024 × 1024</option><option value={1536}>1536 × 1536</option><option value={2048}>2048 × 2048</option></Select></Field>
          {est.isFetching && <Skeleton className="h-20" />}
          {est.error && <ErrorBox error={est.error} />}
          {est.data && (
            <>
              <ul className="divide-y rounded border text-sm">
                {est.data.items.map((i) => (
                  <li key={i.modelId} className="grid gap-1 p-2">
                    <span className="font-medium">{i.displayName ?? models.find((m) => m.id === i.modelId)?.displayName}</span>
                    <EstimateView e={i.estimate} compact />
                    {i.errors.length > 0 && <span className="text-xs text-destructive">{i.errors.join('; ')}</span>}
                  </li>
                ))}
              </ul>
              <p className="text-sm">Known total: <strong>{money(est.data.knownTotalUsd)}</strong>{est.data.unverifiedCount > 0 && <span className="text-warning"> + {est.data.unverifiedCount} model(s) with no verified price</span>}</p>
              <label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} /> <span>I confirm this estimated cost{est.data.unverifiedCount > 0 ? ' and accept unverified costs for the models without a price' : ''}.</span></label>
              <Button disabled={!ack || blocked} onClick={() => run.mutate(undefined)} loading={run.isPending}>Run comparison ({est.data.items.length} images)</Button>
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

interface Comparison {
  id: string;
  name: string;
  status: string;
  modelIds: string[];
  ratings: Record<string, { rating: number; notes: string }> | null;
  createdAt: string;
  generations: (GenerationRow & { modelId: string; model: { displayName: string; endpointId: string }; durationMs: number | null })[];
}

function Comparisons() {
  const list = useQuery({ queryKey: ['comparisons'], queryFn: () => api.get<{ id: string; name: string; status: string; createdAt: string }[]>('/image-compare'), refetchInterval: 10000 });
  const [open, setOpen] = useState<string | null>(null);
  if (!list.data?.length) return null;
  return (
    <section className="mt-8">
      <h2 className="mb-2 text-lg font-semibold">Comparisons</h2>
      <ul className="grid gap-2">
        {list.data.map((c) => (
          <li key={c.id} className="rounded border p-2">
            <button className="flex w-full items-center gap-2 text-left text-sm" onClick={() => setOpen(open === c.id ? null : c.id)} aria-expanded={open === c.id}>
              <span className="font-medium">{c.name}</span><Badge tone={c.status === 'COMPLETED' ? 'success' : c.status === 'FAILED' ? 'danger' : 'muted'}>{titleCase(c.status)}</Badge><span className="ml-auto text-xs text-muted-foreground">{fmtDate(c.createdAt)}</span>
            </button>
            {open === c.id && <ComparisonDetail id={c.id} />}
          </li>
        ))}
      </ul>
    </section>
  );
}

function ComparisonDetail({ id }: { id: string }) {
  const q = useQuery({ queryKey: ['comparison', id], queryFn: () => api.get<Comparison>(`/image-compare/${id}`), refetchInterval: (d) => (d.state.data?.status === 'RUNNING' ? 3000 : false) });
  const qc = useQueryClient();
  const prefer = useAction((modelId: string) => api.post('/image-models/preferred', { modelId }), { success: 'Preferred model set', invalidate: [['image-models']] });
  const rate = useAction((v: { modelId: string; rating: number }) => api.post(`/image-compare/${id}/rate`, { ...v, notes: '' }), { onSuccess: () => void qc.invalidateQueries({ queryKey: ['comparison', id] }) });
  if (!q.data) return <Skeleton className="mt-2 h-32" />;
  return (
    <div className="mt-2 grid gap-3 md:grid-cols-2 xl:grid-cols-4">
      {q.data.generations.map((g) => (
        <figure key={g.id} className="grid content-start gap-1 rounded border p-2 text-xs">
          <figcaption className="font-medium">{g.model.displayName}</figcaption>
          {g.assetIds[0] ? <img src={`/api/assets/${g.assetIds[0]}/file`} alt={`Result from ${g.model.displayName}`} className="aspect-square w-full rounded object-contain" /> : <div className="grid aspect-square place-items-center rounded bg-muted p-2 text-center">{g.status === 'FAILED' ? g.error : 'Waiting…'}</div>}
          <span>Est. {money(g.estimatedCostUsd === null ? null : Number(g.estimatedCostUsd))} · Actual {g.actualCostUsd === null ? 'not reported' : money(Number(g.actualCostUsd))}{g.durationMs ? ` · ${(g.durationMs / 1000).toFixed(1)}s` : ''}</span>
          <div className="flex items-center gap-1">
            {[1, 2, 3, 4, 5].map((r) => <button key={r} aria-label={`Rate ${r}`} onClick={() => rate.mutate({ modelId: g.modelId, rating: r })}><Star className={`size-4 ${(q.data.ratings?.[g.modelId]?.rating ?? 0) >= r ? 'fill-current text-warning' : 'text-muted-foreground'}`} /></button>)}
            <Button size="sm" variant="ghost" className="ml-auto" onClick={() => prefer.mutate(g.modelId)}>Set preferred</Button>
          </div>
        </figure>
      ))}
    </div>
  );
}

