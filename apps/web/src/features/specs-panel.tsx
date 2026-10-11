import { defaultSpecSource, type Verification } from '@kdp/core/browser';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ExternalLink } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { Card, CardContent, CardDescription, CardHeader, CardTitle, ErrorBox, Field, Select, Skeleton } from '@/components/ui/basic';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/overlay';
import { api } from '@/lib/api';
import { canEdit, useAuth } from '@/lib/auth';
import { StatusBadge } from '@/lib/status';
import type { CoverGeometry, LayoutSummary, ProjectDetail } from '@/lib/types';

const Row = ({ k, v, ver }: { k: string; v: React.ReactNode; ver?: Verification }) => (
  <div className="flex items-center justify-between gap-4 border-b py-1.5 text-sm last:border-0">
    <span className="text-muted-foreground">{k}</span>
    <span className="flex items-center gap-2 text-right font-medium tabular-nums">{v}{ver && <StatusBadge status={ver.status} />}</span>
  </div>
);

export default function SpecsPanel({ project }: { project: ProjectDetail }) {
  const { role } = useAuth();
  const qc = useQueryClient();
  const isPrint = project.format.format !== 'EBOOK';
  const layout = useQuery({ queryKey: ['layout', project.id], queryFn: () => api.get<LayoutSummary>(`/projects/${project.id}/interior/layout`), enabled: isPrint });
  const covers = useQuery({ queryKey: ['covers', project.id], queryFn: () => api.get<{ geometry: CoverGeometry }>(`/projects/${project.id}/covers`) });
  const lib = defaultSpecSource.getLibrary();
  const [f, setF] = useState(project.format);
  const trims = lib.trimSizes.filter((t) => f.format !== 'EBOOK' && t.formats.includes(f.format as 'PAPERBACK' | 'HARDCOVER'));
  const save = async () => {
    try {
      await api.patch(`/projects/${project.id}`, { format: { format: f.format, trimId: f.trimId, ink: f.ink, paper: f.paper, bleed: f.bleed, coverFinish: f.coverFinish, direction: f.direction } });
      for (const k of [['project', project.id], ['layout', project.id], ['covers', project.id], ['interior', project.id]]) await qc.invalidateQueries({ queryKey: k });
      toast.success('Format updated — layout and cover geometry regenerated.');
    } catch (e) {
      toast.error((e as Error).message);
    }
  };
  const g = covers.data?.geometry;
  const s = layout.data?.spec;
  return (
    <div className="grid gap-6 xl:grid-cols-3">
      <Card>
        <CardHeader><CardTitle>Format</CardTitle><CardDescription>Changing trim, paper, or bleed regenerates the layout deterministically.</CardDescription></CardHeader>
        <CardContent className="grid gap-3">
          <Field label="Format" htmlFor="sf"><Select id="sf" disabled={!canEdit(role)} value={f.format} onChange={(e) => setF({ ...f, format: e.target.value as typeof f.format })}><option value="PAPERBACK">Paperback</option><option value="HARDCOVER">Hardcover</option><option value="EBOOK">Kindle eBook</option></Select></Field>
          {f.format !== 'EBOOK' && (
            <>
              <Field label="Trim size" htmlFor="st"><Select id="st" disabled={!canEdit(role)} value={f.trimId} onChange={(e) => setF({ ...f, trimId: e.target.value })}>{trims.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}</Select></Field>
              <Field label="Ink" htmlFor="si"><Select id="si" disabled={!canEdit(role)} value={f.ink} onChange={(e) => setF({ ...f, ink: e.target.value })}><option value="BLACK_WHITE">Black & white</option><option value="STANDARD_COLOR">Standard color</option><option value="PREMIUM_COLOR">Premium color</option></Select></Field>
              <Field label="Paper" htmlFor="sp"><Select id="sp" disabled={!canEdit(role)} value={f.paper} onChange={(e) => setF({ ...f, paper: e.target.value })}><option value="WHITE">White</option><option value="CREAM">Cream</option></Select></Field>
              <Field label="Cover finish" htmlFor="sfin"><Select id="sfin" disabled={!canEdit(role)} value={f.coverFinish} onChange={(e) => setF({ ...f, coverFinish: e.target.value })}><option value="MATTE">Matte</option><option value="GLOSSY">Glossy</option></Select></Field>
              <Field label="Reading direction" htmlFor="sd"><Select id="sd" disabled={!canEdit(role)} value={f.direction} onChange={(e) => setF({ ...f, direction: e.target.value as 'LTR' })}><option value="LTR">Left to right</option><option value="RTL">Right to left</option></Select></Field>
              <label className="flex items-center gap-2 text-sm"><Switch disabled={!canEdit(role)} checked={f.bleed} onCheckedChange={(c) => setF({ ...f, bleed: c })} /> Bleed</label>
            </>
          )}
          {canEdit(role) && <Button onClick={save}>Apply format</Button>}
        </CardContent>
      </Card>
      <Card>
        <CardHeader><CardTitle>Interior specification</CardTitle><CardDescription>Spec {s?.version ?? lib.version} — resolved for the current page count.</CardDescription></CardHeader>
        <CardContent>
          {!isPrint ? (
            <p className="text-sm text-muted-foreground">Reflowable EPUB: trim, margins, bleed, and page counts do not apply. Cover image {lib.ebook.coverIdealWidthPx} × {lib.ebook.coverIdealHeightPx} px <StatusBadge status={lib.ebook.verification.status} />.</p>
          ) : layout.isLoading ? <Skeleton className="h-64" /> : layout.error ? <ErrorBox error={layout.error} /> : s && layout.data && (
            <>
              <Row k="Trim" v={`${s.trim.widthIn}" × ${s.trim.heightIn}"`} ver={s.trim.verification} />
              <Row k="PDF page size" v={`${s.pageWidthIn}" × ${s.pageHeightIn}"`} />
              <Row k="Bleed (outside / top / bottom)" v={`${s.bleed.outsideIn}" / ${s.bleed.topIn}" / ${s.bleed.bottomIn}"`} />
              <Row k="Page count" v={`${layout.data.pageCount}${s.pageCountLimit ? ` (allowed ${s.pageCountLimit.minPages}–${s.pageCountLimit.maxPages})` : ''}`} ver={s.pageCountLimit?.verification} />
              <Row k="Inside margin / gutter" v={`${layout.data.margins.insideIn}" (min ${s.minMargins.insideIn}")`} />
              <Row k="Outside margin" v={`${layout.data.margins.outsideIn}" (min ${s.minMargins.outsideIn}")`} />
              <Row k="Top / bottom margins" v={`${layout.data.margins.topIn}" / ${layout.data.margins.bottomIn}"`} />
              <Row k="Safe content area" v={`${(s.trim.widthIn - layout.data.margins.insideIn - layout.data.margins.outsideIn).toFixed(3)}" × ${(s.trim.heightIn - layout.data.margins.topIn - layout.data.margins.bottomIn).toFixed(3)}"`} />
              <Row k="Numbered pages" v={layout.data.pages.filter((p) => p.displayNumber).length} />
              {s.issues.map((i) => <p key={i.code} className="mt-2 rounded bg-destructive/10 p-2 text-xs text-destructive">{i.message}</p>)}
            </>
          )}
        </CardContent>
      </Card>
      <Card>
        <CardHeader><CardTitle>Cover geometry</CardTitle><CardDescription>Computed only from the final page count, binding, paper, and trim.</CardDescription></CardHeader>
        <CardContent>
          {!g ? <Skeleton className="h-64" /> : (
            <>
              <Row k="Source" v={<StatusBadge status={g.source === 'FORMULA' ? 'CORROBORATED' : g.source === 'OFFICIAL_TEMPLATE' ? 'OFFICIAL_TEMPLATE' : 'UNVERIFIED'} />} />
              {g.format !== 'EBOOK' && <Row k="Full wrap" v={`${g.widthIn}" × ${g.heightIn}"`} />}
              {g.format !== 'EBOOK' && <Row k={g.format === 'HARDCOVER' ? 'Wrap' : 'Bleed'} v={`${g.bleedIn}"`} />}
              {g.format !== 'EBOOK' && <Row k="Spine width" v={`${g.spineWidthIn}"`} />}
              {g.format !== 'EBOOK' && <Row k="Spine text" v={g.spineTextAllowed ? 'Allowed' : 'Not allowed (too few pages)'} />}
              <Row k="Front panel" v={`${g.panels.front.w}" × ${g.panels.front.h}"`} />
              {g.barcode && <Row k="Barcode area" v={`${g.barcode.w}" × ${g.barcode.h}"`} />}
              {g.hinges.length > 0 && <Row k="Hinge" v={`${g.hinges[0].w}"`} />}
              {g.issues.map((i) => <p key={i.code} className="mt-2 rounded bg-warning/10 p-2 text-xs text-warning">{i.message}</p>)}
              <div className="mt-3 grid gap-1">
                {[...new Map(g.verifications.map((v) => [v.source + v.status, v])).values()].map((v, i) => (
                  <p key={i} className="flex items-start gap-2 text-xs text-muted-foreground"><StatusBadge status={v.status} /> <span>{v.note ?? ''} {v.source.startsWith('http') ? <a className="inline-flex items-center gap-0.5 text-primary hover:underline" href={v.source} target="_blank" rel="noreferrer">source <ExternalLink className="size-3" /></a> : v.source} · checked {v.lastVerified}</span></p>
                ))}
              </div>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
