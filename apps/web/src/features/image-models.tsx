import { describePrice, type CostEstimate, type ModelCapabilities, type ModelPrice } from '@kdp/core/browser';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, ImageIcon, Sparkles } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Badge, ErrorBox, Field, Input, Select, Skeleton, Textarea } from '@/components/ui/basic';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogTrigger } from '@/components/ui/overlay';
import { api, ApiError } from '@/lib/api';
import { useJob } from '@/lib/hooks';
import { fmtDate } from '@/lib/utils';

export interface ModelRow {
  id: string;
  provider: string;
  endpointId: string;
  displayName: string;
  family: string;
  category: string;
  description: string;
  availability: 'VERIFIED' | 'CANDIDATE_UNVERIFIED' | 'NOT_FOUND' | 'DEPRECATED' | 'OFFLINE_MOCK';
  enabled: boolean;
  usable: boolean;
  tasks: string[];
  capabilities: ModelCapabilities | null;
  thumbnailUrl: string;
  modelUrl: string;
  commercialUseUrl: string;
  commercialUseNote: string;
  commercialInfoAvailable: boolean;
  editorialTags: string[];
  knownLimitations: string;
  adminNotes: string;
  capabilitiesVerifiedAt: string | null;
  lastSyncedAt: string | null;
  lastSyncError: string | null;
  lastPriceError: string | null;
  price: (ModelPrice & { isBuiltIn: boolean; id: string }) | null;
  estimate: CostEstimate;
}

export interface ModelList {
  models: ModelRow[];
  preferredModelId: string | null;
  lastSync: { startedAt: string; verified: string[]; notFound: string[]; discovered: string[]; priced: string[]; priceMissing: string[]; errors: string[] } | null;
  falConfigured: boolean;
  canAdmin: boolean;
  filters: string[];
}

export interface ImageRequest {
  prompt: string;
  negativePrompt?: string | null;
  widthPx?: number | null;
  heightPx?: number | null;
  aspect?: number | null;
  aspectRatio?: string | null;
  resolution?: string | null;
  numImages?: number;
  seed?: number | null;
  sourceAssetId?: string | null;
  referenceAssetIds?: string[];
}

export const money = (v: number | null | undefined, currency = 'USD') => (v === null || v === undefined ? '—' : `${currency === 'USD' ? '$' : currency + ' '}${v < 0.01 && v > 0 ? v.toFixed(4) : v.toFixed(v < 1 ? 3 : 2)}`);

const STATUS_LABEL: Record<CostEstimate['status'], { label: string; tone: 'success' | 'warning' | 'danger' | 'muted' }> = {
  OK: { label: 'Verified price', tone: 'success' },
  STALE: { label: 'Price may be outdated', tone: 'warning' },
  UNAVAILABLE: { label: 'Price unavailable', tone: 'danger' },
  NEEDS_ASSUMPTIONS: { label: 'Cannot estimate', tone: 'warning' },
  UNKNOWN_DIMENSIONS: { label: 'Output size unknown', tone: 'warning' },
};

export const AVAILABILITY: Record<ModelRow['availability'], { label: string; tone: 'success' | 'warning' | 'danger' | 'muted' }> = {
  VERIFIED: { label: 'Verified in fal catalog', tone: 'success' },
  CANDIDATE_UNVERIFIED: { label: 'Candidate — not verified', tone: 'warning' },
  NOT_FOUND: { label: 'Not found in catalog', tone: 'danger' },
  DEPRECATED: { label: 'Deprecated', tone: 'muted' },
  OFFLINE_MOCK: { label: 'Offline mock (not AI)', tone: 'muted' },
};

export function PriceLine({ m }: { m: ModelRow }) {
  if (m.price?.isBuiltIn) return <span className="text-sm">Free (offline mock)</span>;
  return (
    <span className="text-sm">
      <span className="font-medium">{describePrice(m.price)}</span>
      {m.price && <span className="text-xs text-muted-foreground"> · {m.price.source === 'FAL_PRICING_API' ? 'fal pricing API' : 'admin-entered'} · {fmtDate(m.price.retrievedAt)}</span>}
    </span>
  );
}

export function EstimateView({ e, compact, mock }: { e: CostEstimate; compact?: boolean; mock?: boolean }) {
  const s = mock ? { label: 'Free offline mock (not AI)', tone: 'muted' as const } : STATUS_LABEL[e.status];
  return (
    <div className="grid gap-1 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={s.tone}>{s.label}</Badge>
        {e.total !== null && <span className="font-semibold tabular-nums">{money(e.total, e.currency)}</span>}
        {e.perImage !== null && <span className="text-xs text-muted-foreground tabular-nums">({money(e.perImage, e.currency)} per image at these settings)</span>}
      </div>
      {!compact && <p className="text-xs text-muted-foreground">{e.explanation}</p>}
      {!compact && e.table.some((r) => r.total !== null) && (
        <table className="mt-1 w-full max-w-sm text-xs">
          <thead className="text-muted-foreground"><tr><th className="text-left font-normal">Images</th>{e.table.map((r) => <th key={r.quantity} className="text-right font-normal">{r.quantity}</th>)}</tr></thead>
          <tbody><tr><td>Est.</td>{e.table.map((r) => <td key={r.quantity} className="text-right tabular-nums">{money(r.total, e.currency)}</td>)}</tr></tbody>
        </table>
      )}
      {!compact && (e.breakdown.length > 0 || e.assumptions.length > 0) && (
        <details className="text-xs text-muted-foreground">
          <summary className="cursor-pointer">How this is calculated</summary>
          <ul className="ml-4 list-disc">{[...e.breakdown, ...e.assumptions.map((a) => `Assumption: ${a}`)].map((x, i) => <li key={i}>{x}</li>)}</ul>
        </details>
      )}
    </div>
  );
}

export function useModels(params: Record<string, string | number | boolean | undefined> = {}) {
  const qs = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined && v !== '').map(([k, v]) => [k, String(v)])).toString();
  return useQuery({ queryKey: ['image-models', qs], queryFn: () => api.get<ModelList>(`/image-models${qs ? '?' + qs : ''}`) });
}

/** Live estimate for a model + request (server validates against the model's own schema). */
export function useEstimate(modelId: string | null, request: ImageRequest | null) {
  const [debounced, setDebounced] = useState(request);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(request), 300);
    return () => clearTimeout(t);
  }, [JSON.stringify(request)]); // eslint-disable-line react-hooks/exhaustive-deps
  return useQuery({
    queryKey: ['image-estimate', modelId, debounced],
    enabled: !!modelId && !!debounced?.prompt,
    queryFn: () => api.post<{ estimate: CostEstimate; errors: string[]; model: ModelRow }>('/image-models/estimate', { modelId, request: debounced }),
  });
}

/**
 * Confirmation block: shows the estimate and only enables the action once the user has
 * explicitly confirmed (and, without a verified price, accepted an unverified cost).
 */
export function ConfirmCost({ estimate, errors, onConfirm, busy, label = 'Generate', mock }: { estimate: CostEstimate | undefined; errors?: string[]; onConfirm: (c: { acceptedEstimateUsd: number | null; acceptUnverifiedCost: boolean }) => void; busy?: boolean; label?: string; mock?: boolean }) {
  const [ack, setAck] = useState(false);
  useEffect(() => setAck(false), [estimate?.total, estimate?.status]);
  if (!estimate) return <Skeleton className="h-16" />;
  const unverified = estimate.status !== 'OK';
  return (
    <div className="grid gap-3 rounded-lg border p-3">
      <EstimateView e={estimate} mock={mock} />
      {errors && errors.length > 0 && (
        <ul className="rounded bg-destructive/10 p-2 text-xs text-destructive">{errors.map((x) => <li key={x}>{x}</li>)}</ul>
      )}
      <label className="flex items-start gap-2 text-sm">
        <input type="checkbox" className="mt-0.5" checked={ack} onChange={(e) => setAck(e.target.checked)} />
        <span>{unverified ? <><AlertTriangle className="mr-1 inline size-4 text-warning" />No verified price is available. I accept that the actual cost is unknown and will be charged by the provider.</> : <>I confirm the estimated cost of <strong>{money(estimate.total, estimate.currency)}</strong>. Actual cost is reported by the provider when available.</>}</span>
      </label>
      <Button disabled={!ack || !!errors?.length} loading={busy} onClick={() => onConfirm({ acceptedEstimateUsd: estimate.total, acceptUnverifiedCost: unverified })}>
        <Sparkles /> {label}
      </Button>
    </div>
  );
}

export function ModelSelect({ value, onChange, task, models }: { value: string | null; onChange: (id: string) => void; task?: string; models: ModelRow[] }) {
  const usable = models.filter((m) => m.usable && (!task || m.tasks.includes(task)));
  return (
    <Select aria-label="Image model" value={value ?? ''} onChange={(e) => onChange(e.target.value)}>
      <option value="" disabled>Choose a model…</option>
      {usable.map((m) => (
        <option key={m.id} value={m.id}>
          {m.displayName} — {m.price?.isBuiltIn ? 'free mock' : describePrice(m.price)}
        </option>
      ))}
    </Select>
  );
}

export interface GenerationRow {
  id: string;
  status: string;
  assetIds: string[];
  error: string | null;
  estimatedCostUsd: string | null;
  actualCostUsd: string | null;
  actualCostSource: string | null;
  model?: { displayName: string };
  settings: Record<string, unknown>;
  createdAt: string;
}

/** Polls a generation job and shows its resulting images with a "use" action. */
export function JobImages({ jobId, onUse, onRevise, useLabel = 'Use this image' }: { jobId: string; onUse?: (assetId: string) => void; onRevise?: (assetId: string) => void; useLabel?: string }) {
  const job = useJob(jobId);
  const done = job.data && !['QUEUED', 'RUNNING'].includes(job.data.status);
  const gens = useQuery({ queryKey: ['image-generations', jobId, done], queryFn: () => api.get<{ generations: GenerationRow[] }>(`/image-generations?jobId=${jobId}`), enabled: !!done });
  if (!job.data) return <Skeleton className="h-24" />;
  if (!done) return <p className="text-sm text-muted-foreground" role="status">Generating… ({job.data.stage}). You can close this dialog; the job keeps running in the background.</p>;
  if (job.data.status !== 'SUCCEEDED') return <ErrorBox title="Generation failed" error={new Error(job.data.error ?? job.data.status)} />;
  return (
    <div className="grid gap-2">
      {gens.data?.generations.map((g) => (
        <div key={g.id} className="grid gap-2">
          <p className="text-xs text-muted-foreground">
            {g.model?.displayName} · estimated {money(g.estimatedCostUsd === null ? null : Number(g.estimatedCostUsd))} · actual {g.actualCostUsd === null ? 'not reported by provider' : money(Number(g.actualCostUsd))}
          </p>
          <div className="grid grid-cols-2 gap-2">
            {g.assetIds.map((a) => (
              <figure key={a} className="grid gap-1">
                <img src={`/api/assets/${a}/file`} alt="Generated result" className="max-h-64 w-full rounded border object-contain" />
                <div className="flex flex-wrap gap-1">
                  {onUse && <Button size="sm" variant="outline" onClick={() => onUse(a)}>{useLabel}</Button>}
                  {onRevise && <Button size="sm" variant="ghost" onClick={() => onRevise(a)}>Revise</Button>}
                </div>
              </figure>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * Cover-art studio: brief → model → estimate → confirm → generate → preview → place. The art
 * target comes from the verified cover geometry; the model never decides print dimensions.
 */
export function AiArtDialog({ projectId, onUse }: { projectId: string; onUse: (assetId: string, scope: 'front' | 'wrap') => void }) {
  const [open, setOpen] = useState(false);
  const [scope, setScope] = useState<'front' | 'wrap'>('front');
  const [modelId, setModelId] = useState<string | null>(null);
  const [prompt, setPrompt] = useState('');
  const [sourceAssetId, setSourceAssetId] = useState<string | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const qc = useQueryClient();
  const models = useModels({ includeMock: true });
  const target = useQuery({ queryKey: ['cover-art-target', projectId, scope], queryFn: () => api.get<{ widthIn: number; heightIn: number; aspect: number; idealWidthPx: number; idealHeightPx: number }>(`/projects/${projectId}/cover-art/target?scope=${scope}`), enabled: open });
  useEffect(() => {
    if (!modelId && models.data) setModelId(models.data.preferredModelId && models.data.models.some((m) => m.id === models.data.preferredModelId && m.usable) ? models.data.preferredModelId : (models.data.models.find((m) => m.usable)?.id ?? null));
  }, [models.data]); // eslint-disable-line react-hooks/exhaustive-deps
  const t = target.data;
  const scale = t ? Math.min(1, 2048 / t.idealWidthPx, 2048 / t.idealHeightPx) : 1;
  const request: ImageRequest | null = t && prompt ? { prompt: /no text/i.test(prompt) ? prompt : `${prompt}. Background artwork only: no text, no letters, no numbers, no logos.`, aspect: t.aspect, widthPx: Math.round((t.idealWidthPx * scale) / 8) * 8, heightPx: Math.round((t.idealHeightPx * scale) / 8) * 8, sourceAssetId } : null;
  const est = useEstimate(modelId, request);
  const model = models.data?.models.find((m) => m.id === modelId);
  const go = async (c: { acceptedEstimateUsd: number | null; acceptUnverifiedCost: boolean }) => {
    setBusy(true);
    try {
      const r = await api.post<{ jobId: string }>(`/projects/${projectId}/cover-art`, { modelId, scope, request: { ...request, prompt }, confirmation: c });
      setJobId(r.jobId);
      await qc.invalidateQueries({ queryKey: ['jobs'] });
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'Could not start generation');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild><Button size="sm" variant="outline"><ImageIcon /> AI art</Button></DialogTrigger>
      <DialogContent wide title="Generate cover background art" description="The art area and aspect come from the verified cover geometry. Title, subtitle, author and spine text stay editable text layers above the art — the image model never renders them or decides trim, bleed, spine, barcode or safe areas.">
        {models.isLoading ? <Skeleton className="h-40" /> : models.error ? <ErrorBox error={models.error} /> : (
          <div className="grid gap-4 md:grid-cols-2">
            <div className="grid content-start gap-3">
              <Field label="Art area" htmlFor="art-scope" hint={t ? `${t.widthIn.toFixed(3)}" × ${t.heightIn.toFixed(3)}" incl. bleed · 300 DPI needs ${t.idealWidthPx}×${t.idealHeightPx}px` : undefined}>
                <Select id="art-scope" value={scope} onChange={(e) => setScope(e.target.value as 'front' | 'wrap')}>
                  <option value="front">Front panel + bleed</option>
                  <option value="wrap">Full wrap (back, spine, front)</option>
                </Select>
              </Field>
              <Field label="Model" hint={model ? <a className="underline" href="/models" target="_blank" rel="noreferrer">Compare models in the library</a> : 'No usable models — sync the catalog in the model library.'}>
                <ModelSelect value={modelId} onChange={setModelId} models={models.data?.models ?? []} />
              </Field>
              <Field label="Art direction (no text in the image)" htmlFor="art-prompt">
                <Textarea id="art-prompt" rows={4} value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="Watercolor forest at dawn, soft greens, generous empty space in the upper third for the title" />
              </Field>
              {sourceAssetId && (
                <p className="text-xs">Revising image <code>{sourceAssetId.slice(-6)}</code> (image-to-image). <button className="underline" onClick={() => setSourceAssetId(null)}>Start fresh</button></p>
              )}
              {model?.price?.isBuiltIn && <p className="text-xs text-muted-foreground">The offline mock draws procedural shapes; it is for testing the workflow, not real artwork.</p>}
              {request ? <ConfirmCost estimate={est.data?.estimate} errors={est.data?.errors} busy={busy} onConfirm={go} mock={model?.price?.isBuiltIn} /> : <p className="text-sm text-muted-foreground">Describe the artwork to see the estimate.</p>}
            </div>
            <div className="grid content-start gap-2">
              {jobId ? (
                <JobImages
                  jobId={jobId}
                  onRevise={(a) => {
                    setSourceAssetId(a);
                    setJobId(null);
                    const edit = models.data?.models.find((m) => m.usable && (m.tasks.includes('edit') || m.tasks.includes('image-to-image')));
                    if (model && !model.tasks.some((x) => x === 'edit' || x === 'image-to-image') && edit) setModelId(edit.id);
                  }}
                  onUse={(a) => {
                    onUse(a, scope);
                    toast.success('Art placed under your text layers. Save the design to keep it.');
                    setOpen(false);
                  }}
                />
              ) : <p className="text-sm text-muted-foreground">Results appear here.</p>}
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
