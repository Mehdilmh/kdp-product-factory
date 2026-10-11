import { BUILT_IN_TEMPLATES, Chapter, InteriorDocument, PageElementSchema, type FlowBlock, type PageElement, type PageInstance } from '@kdp/core/browser';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, ArrowDown, ArrowUp, Copy, Eye, EyeOff, Lock, Plus, Repeat, Settings2, Trash2, Unlock, ZoomIn, ZoomOut } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { z } from 'zod';
import { Badge, Card, CardContent, CardHeader, CardTitle, EmptyState, ErrorBox, Field, Input, Select, Skeleton, Textarea } from '@/components/ui/basic';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogTrigger, Switch } from '@/components/ui/overlay';
import { api, ApiError } from '@/lib/api';
import { canEdit, useAuth } from '@/lib/auth';
import type { LayoutSummary, PageTemplate, ProjectDetail } from '@/lib/types';
import { cn, titleCase } from '@/lib/utils';

type Section = 'front' | 'body' | 'back';

/** Pixel density for print-size previews: screen density × zoom, capped at print resolution. */
const previewDpi = (zoom: number) => Math.min(300, Math.max(48, Math.round(96 * zoom * (window.devicePixelRatio || 1))));
interface DocResponse {
  doc: InteriorDocument;
  revision: number;
}

const ELEMENT_DEFAULTS: Record<string, Record<string, unknown>> = {
  heading: { type: 'heading', text: 'Heading' },
  text: { type: 'text', text: 'Text' },
  lines: { type: 'lines', spacingPt: 24 },
  dotGrid: { type: 'dotGrid' },
  grid: { type: 'grid' },
  checklist: { type: 'checklist', count: 5 },
  table: { type: 'table', columns: [{ header: 'Column A', width: 1 }, { header: 'Column B', width: 1 }], rows: 8 },
  fields: { type: 'fields', fields: [{ label: 'Date', width: 1 }] },
  box: { type: 'box', label: 'Notes', linesInside: 20, height: { mode: 'fixed', pt: 120 } },
  image: { type: 'image', assetId: '' },
  spacer: { type: 'spacer' },
  divider: { type: 'divider' },
};

function useInterior(projectId: string) {
  return useQuery({ queryKey: ['interior', projectId], queryFn: () => api.get<DocResponse>(`/projects/${projectId}/interior`) });
}
function useLayout(projectId: string, enabled: boolean) {
  return useQuery({ queryKey: ['layout', projectId], queryFn: () => api.get<LayoutSummary>(`/projects/${projectId}/interior/layout`), enabled });
}

export default function InteriorEditor({ project }: { project: ProjectDetail }) {
  const { role } = useAuth();
  const editable = canEdit(role);
  const qc = useQueryClient();
  const interior = useInterior(project.id);
  const isPrint = project.format.format !== 'EBOOK';
  const layout = useLayout(project.id, isPrint);
  const templates = useQuery({ queryKey: ['templates'], queryFn: () => api.get<{ builtIn: PageTemplate[]; custom: (PageTemplate & { dbId: string })[] }>('/templates') });
  const allTemplates = useMemo(() => [...(templates.data?.custom ?? []), ...(templates.data?.builtIn ?? BUILT_IN_TEMPLATES)], [templates.data]);
  const [section, setSection] = useState<Section>('body');
  const [selected, setSelected] = useState<string | null>(null);
  const [zoom, setZoom] = useState(0.9);
  const [guides, setGuides] = useState(true);
  const [busy, setBusy] = useState(false);
  const jobRunning = project.jobs.some((j) => j.status === 'RUNNING' || j.status === 'QUEUED');

  // Editors refresh once a background job finishes.
  useEffect(() => {
    if (!jobRunning) {
      qc.invalidateQueries({ queryKey: ['interior', project.id] });
      qc.invalidateQueries({ queryKey: ['layout', project.id] });
    }
  }, [jobRunning, project.id, qc]);

  const doc = interior.data?.doc;
  const pages: PageInstance[] = !doc ? [] : section === 'front' ? doc.frontMatter : section === 'back' ? doc.backMatter : doc.body.kind === 'pages' ? doc.body.pages : [];
  const current = pages.find((p) => p.id === selected) ?? pages[0] ?? null;
  const layoutPage = layout.data?.pages.find((lp) => lp.source.instanceId === current?.id) ?? null;
  const pageWarnings = layout.data?.warnings.filter((w) => layoutPage && w.pageIndex === layoutPage.index) ?? [];

  const runOps = async (ops: unknown[]) => {
    if (!interior.data) return;
    setBusy(true);
    try {
      const r = await api.post<{ revision: number; document: InteriorDocument }>(`/projects/${project.id}/interior/ops`, { revision: interior.data.revision, ops });
      qc.setQueryData(['interior', project.id], { doc: r.document, revision: r.revision });
      await qc.invalidateQueries({ queryKey: ['layout', project.id] });
    } catch (e) {
      if (e instanceof ApiError && e.status === 409 && (e.details as { revision?: number })?.revision !== undefined) {
        toast.error('The document changed elsewhere (e.g. a generation job). Reloaded the latest version.');
        await qc.invalidateQueries({ queryKey: ['interior', project.id] });
      } else toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (interior.isLoading) return <Skeleton className="h-[600px]" />;
  if (interior.error || !doc) return <ErrorBox error={interior.error} title="Could not load the interior" />;
  if (doc.body.kind === 'flow' && section === 'body') return <FlowEditor project={project} data={interior.data!} setSection={setSection} layout={layout.data} editable={editable} />;

  const idx = current ? pages.findIndex((p) => p.id === current.id) : -1;
  const tplOf = (p: PageInstance) => allTemplates.find((t) => t.id === p.templateId);
  const errors = layout.data?.warnings.filter((w) => w.level === 'error') ?? [];

  return (
    <div className="grid gap-4">
      <Toolbar
        section={section}
        setSection={(s) => {
          setSection(s);
          setSelected(null);
        }}
        flow={doc.body.kind === 'flow'}
        layout={layout.data}
        zoom={zoom}
        setZoom={setZoom}
        guides={guides}
        setGuides={setGuides}
        extra={
          editable && (
            <>
              <AddPage templates={allTemplates} section={section} onAdd={(templateId) => runOps([{ op: 'add', section, at: idx + 1, templateId }])} busy={busy} />
              <SequenceDialog templates={allTemplates.filter((t) => t.kind === 'body')} onInsert={(templateIds, repeat) => runOps([{ op: 'sequence', section, templateIds, repeat }])} />
              <SettingsDialog project={project} data={interior.data!} />
            </>
          )
        }
      />
      {errors.length > 0 && (
        <div className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/5 p-2 text-sm text-destructive" role="alert">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
          <span>{errors.length} layout error(s) (overflow, clipping, missing glyphs or assets). Pages with issues are outlined in red.</span>
        </div>
      )}
      <div className="grid gap-4 lg:grid-cols-[220px_minmax(0,1fr)_340px]">
        <Card className="max-h-[78vh] overflow-y-auto">
          <CardContent className="grid gap-2 p-2">
            {pages.length === 0 && <p className="p-3 text-sm text-muted-foreground">No {section} pages.</p>}
            {pages.map((p, i) => {
              const lp = layout.data?.pages.find((x) => x.source.instanceId === p.id);
              const hasErr = lp && layout.data?.warnings.some((w) => w.pageIndex === lp.index && w.level === 'error');
              return (
                <button key={p.id} type="button" onClick={() => setSelected(p.id)} className={cn('flex items-center gap-2 rounded-md border p-1.5 text-left text-xs transition-colors hover:bg-accent', current?.id === p.id && 'border-primary ring-1 ring-primary', hasErr && 'border-destructive')} aria-current={current?.id === p.id}>
                  {lp && isPrint ? <img src={`/api/projects/${project.id}/interior/pages/${lp.pageNumber}/preview.png?guides=0&dpi=16&r=${interior.data!.revision}`} alt="" loading="lazy" className="h-14 w-10 shrink-0 border bg-white object-contain" /> : <div className="h-14 w-10 shrink-0 border bg-muted" />}
                  <span className="min-w-0">
                    <span className="block truncate font-medium">{i + 1}. {tplOf(p)?.name ?? (p.elements ? 'Custom page' : p.blank ? 'Blank' : 'Page')}</span>
                    <span className="text-muted-foreground">{lp ? `p.${lp.pageNumber}${lp.displayNumber ? ` (#${lp.displayNumber})` : ''}` : ''}</span>
                    {p.locked && <Lock className="ml-1 inline size-3" aria-label="Locked" />}
                  </span>
                </button>
              );
            })}
          </CardContent>
        </Card>
        <div className="checker flex min-h-[60vh] items-start justify-center overflow-auto rounded-lg border p-6">
          {!isPrint ? (
            <p className="text-sm text-muted-foreground">eBooks are reflowable; preview them via the EPUB export.</p>
          ) : layoutPage ? (
            <img
              src={`/api/projects/${project.id}/interior/pages/${layoutPage.pageNumber}/preview.png?guides=${guides ? 1 : 0}&dpi=${previewDpi(zoom)}&r=${interior.data!.revision}`}
              alt={`Preview of page ${layoutPage.pageNumber}`}
              className="page-shadow bg-white"
              style={{ width: `${(layout.data!.spec.pageWidthIn * zoom).toFixed(3)}in` }}
            />
          ) : layout.isLoading ? (
            <Skeleton className="h-[9in] w-[6in]" />
          ) : (
            <EmptyState title="Select a page" />
          )}
        </div>
        <div className="grid content-start gap-4">
          {current && (
            <Card>
              <CardHeader className="flex-row items-center justify-between space-y-0 pb-2">
                <CardTitle className="text-sm">Page {idx + 1}</CardTitle>
                {editable && (
                  <div className="flex gap-1">
                    <Button size="icon" variant="ghost" aria-label="Move up" disabled={idx === 0 || busy} onClick={() => runOps([{ op: 'move', section, pageId: current.id, to: idx - 1 }])}><ArrowUp /></Button>
                    <Button size="icon" variant="ghost" aria-label="Move down" disabled={idx === pages.length - 1 || busy} onClick={() => runOps([{ op: 'move', section, pageId: current.id, to: idx + 1 }])}><ArrowDown /></Button>
                    <Button size="icon" variant="ghost" aria-label="Duplicate page" disabled={busy} onClick={() => runOps([{ op: 'duplicate', section, pageId: current.id }])}><Copy /></Button>
                    <Button size="icon" variant="ghost" aria-label={current.locked ? 'Unlock page' : 'Lock (approve) page'} disabled={busy} onClick={() => runOps([{ op: 'lock', section, pageId: current.id, locked: !current.locked }])}>{current.locked ? <Unlock /> : <Lock />}</Button>
                    <Button size="icon" variant="ghost" aria-label="Delete page" disabled={busy || current.locked} onClick={() => { if (confirm('Delete this page?')) runOps([{ op: 'remove', section, pageId: current.id }]); setSelected(null); }}><Trash2 /></Button>
                  </div>
                )}
              </CardHeader>
              <CardContent>
                <PageInspector key={`${current.id}:${interior.data!.revision}`} page={current} template={tplOf(current)} templates={allTemplates} disabled={!editable || current.locked || busy} onApply={(patch) => runOps([{ op: 'update', section, pageId: current.id, ...patch }])} projectId={project.id} />
              </CardContent>
            </Card>
          )}
          {pageWarnings.length > 0 && (
            <Card>
              <CardHeader className="pb-2"><CardTitle className="text-sm">Issues on this page</CardTitle></CardHeader>
              <CardContent className="grid gap-1 text-xs">
                {pageWarnings.map((w, i) => (
                  <p key={i} className={cn(w.level === 'error' ? 'text-destructive' : w.level === 'warning' ? 'text-warning' : 'text-muted-foreground')}>
                    <strong>{titleCase(w.code)}</strong>{w.elementId && !w.elementId.startsWith('__') ? ` [${w.elementId}]` : ''}: {w.message}
                  </p>
                ))}
              </CardContent>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}

function Toolbar({ section, setSection, flow, layout, zoom, setZoom, guides, setGuides, extra }: { section: Section; setSection: (s: Section) => void; flow: boolean; layout?: LayoutSummary; zoom: number; setZoom: (z: number) => void; guides: boolean; setGuides: (g: boolean) => void; extra?: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="inline-flex rounded-lg bg-muted p-1" role="tablist" aria-label="Section">
        {(['front', 'body', 'back'] as const).map((s) => (
          <button key={s} role="tab" aria-selected={section === s} onClick={() => setSection(s)} className={cn('rounded-md px-3 py-1 text-sm', section === s ? 'bg-background font-medium shadow-sm' : 'text-muted-foreground')}>
            {s === 'front' ? 'Front matter' : s === 'back' ? 'Back matter' : flow ? 'Chapters' : 'Body'}
          </button>
        ))}
      </div>
      {extra}
      <div className="ml-auto flex items-center gap-1">
        {layout && <Badge tone="muted">{layout.pageCount} pages · gutter {layout.margins.insideIn}"</Badge>}
        <Button size="icon" variant="ghost" aria-label="Zoom out" onClick={() => setZoom(Math.max(0.3, zoom - 0.15))}><ZoomOut /></Button>
        <span className="w-12 text-center text-xs tabular-nums">{Math.round(zoom * 100)}%</span>
        <Button size="icon" variant="ghost" aria-label="Zoom in" onClick={() => setZoom(Math.min(2, zoom + 0.15))}><ZoomIn /></Button>
        <Button size="sm" variant="ghost" onClick={() => setGuides(!guides)} aria-pressed={guides}>{guides ? <Eye /> : <EyeOff />} Guides</Button>
      </div>
    </div>
  );
}

function AddPage({ templates, section, onAdd, busy }: { templates: PageTemplate[]; section: Section; onAdd: (id: string | null) => void; busy: boolean }) {
  const [tpl, setTpl] = useState('');
  const list = templates.filter((t) => (section === 'body' ? t.kind === 'body' : true));
  return (
    <div className="flex items-center gap-1">
      <Select aria-label="Template for new page" className="h-8 w-48" value={tpl} onChange={(e) => setTpl(e.target.value)}>
        <option value="">Blank custom page</option>
        {list.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
      </Select>
      <Button size="sm" onClick={() => onAdd(tpl || null)} loading={busy}><Plus /> Add page</Button>
    </div>
  );
}

function SequenceDialog({ templates, onInsert }: { templates: PageTemplate[]; onInsert: (ids: string[], repeat: number) => void }) {
  const [open, setOpen] = useState(false);
  const [ids, setIds] = useState<string[]>([templates[0]?.id ?? 'lined-journal']);
  const [repeat, setRepeat] = useState(10);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild><Button size="sm" variant="outline"><Repeat /> Repeat sequence</Button></DialogTrigger>
      <DialogContent title="Insert a repeated page sequence" description="E.g. a weekly planner followed by seven daily pages, repeated 12 times.">
        <div className="grid gap-2">
          {ids.map((id, i) => (
            <div key={i} className="flex gap-2">
              <Select aria-label={`Sequence page ${i + 1}`} value={id} onChange={(e) => setIds(ids.map((x, j) => (j === i ? e.target.value : x)))}>
                {templates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
              </Select>
              <Button variant="ghost" size="icon" aria-label="Remove" onClick={() => setIds(ids.filter((_, j) => j !== i))} disabled={ids.length === 1}><Trash2 /></Button>
            </div>
          ))}
          <Button variant="outline" size="sm" onClick={() => setIds([...ids, ids.at(-1)!])} disabled={ids.length >= 20}><Plus /> Add page to sequence</Button>
          <Field label="Repeat" htmlFor="rep"><Input id="rep" type="number" min={1} max={500} value={repeat} onChange={(e) => setRepeat(Number(e.target.value))} /></Field>
          <p className="text-xs text-muted-foreground">Adds {ids.length * repeat} pages to the end of this section.</p>
          <Button onClick={() => { onInsert(ids, repeat); setOpen(false); }} disabled={repeat < 1 || ids.length * repeat > 1000}>Insert</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function SettingsDialog({ project, data }: { project: ProjectDetail; data: DocResponse }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [s, setS] = useState(data.doc.settings);
  useEffect(() => setS(data.doc.settings), [data]);
  const save = async () => {
    try {
      await api.patch(`/projects/${project.id}/interior/settings`, { revision: data.revision, settings: s });
      await qc.invalidateQueries({ queryKey: ['interior', project.id] });
      await qc.invalidateQueries({ queryKey: ['layout', project.id] });
      toast.success('Document settings saved; layout regenerated.');
      setOpen(false);
    } catch (e) {
      toast.error((e as Error).message);
    }
  };
  const num = (v: string) => Number(v);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild><Button size="sm" variant="outline"><Settings2 /> Document settings</Button></DialogTrigger>
      <DialogContent wide title="Document settings" description="Margins below the KDP minimum for the final page count are raised automatically (and reported).">
        <div className="grid gap-4 sm:grid-cols-4">
          {(['insideIn', 'outsideIn', 'topIn', 'bottomIn'] as const).map((k) => (
            <Field key={k} label={`${titleCase(k.replace('In', ''))} margin (in)`} htmlFor={k}>
              <Input id={k} type="number" step="0.0625" min={0} max={3} value={s.margins[k]} onChange={(e) => setS({ ...s, margins: { ...s.margins, [k]: num(e.target.value) } })} />
            </Field>
          ))}
          <Field label="Body font" htmlFor="bf"><Select id="bf" value={s.bodyStyle.font} onChange={(e) => setS({ ...s, bodyStyle: { ...s.bodyStyle, font: e.target.value as 'serif' | 'sans' } })}><option value="serif">Serif (Caladea)</option><option value="sans">Sans (Carlito)</option></Select></Field>
          <Field label="Body size (pt)" htmlFor="bs"><Input id="bs" type="number" min={6} max={24} step={0.5} value={s.bodyStyle.sizePt} onChange={(e) => setS({ ...s, bodyStyle: { ...s.bodyStyle, sizePt: num(e.target.value) } })} /></Field>
          <Field label="Line height" htmlFor="lh"><Input id="lh" type="number" min={1} max={2.5} step={0.05} value={s.bodyStyle.lineHeight} onChange={(e) => setS({ ...s, bodyStyle: { ...s.bodyStyle, lineHeight: num(e.target.value) } })} /></Field>
          <Field label="Alignment" htmlFor="al"><Select id="al" value={s.bodyStyle.align} onChange={(e) => setS({ ...s, bodyStyle: { ...s.bodyStyle, align: e.target.value as 'left' } })}>{['left', 'justify', 'center', 'right'].map((a) => <option key={a}>{a}</option>)}</Select></Field>
          <Field label="Book title (for templates)" htmlFor="tt" className="sm:col-span-2"><Input id="tt" value={s.title} onChange={(e) => setS({ ...s, title: e.target.value })} /></Field>
          <Field label="Author" htmlFor="au" className="sm:col-span-2"><Input id="au" value={s.author} onChange={(e) => setS({ ...s, author: e.target.value })} /></Field>
          <label className="flex items-center gap-2 text-sm sm:col-span-2"><Switch checked={s.pageNumbers.enabled} onCheckedChange={(c) => setS({ ...s, pageNumbers: { ...s.pageNumbers, enabled: c } })} /> Page numbers</label>
          <Field label="Number position" htmlFor="np"><Select id="np" value={s.pageNumbers.position} onChange={(e) => setS({ ...s, pageNumbers: { ...s.pageNumbers, position: e.target.value as 'center' } })}><option value="center">Centered</option><option value="outside">Outside edge</option></Select></Field>
          <Field label="Number size (pt)" htmlFor="ns"><Input id="ns" type="number" min={6} max={14} value={s.pageNumbers.sizePt} onChange={(e) => setS({ ...s, pageNumbers: { ...s.pageNumbers, sizePt: num(e.target.value) } })} /></Field>
          <label className="flex items-center gap-2 text-sm sm:col-span-2"><Switch checked={s.runningHeader.enabled} onCheckedChange={(c) => setS({ ...s, runningHeader: { ...s.runningHeader, enabled: c } })} /> Running headers</label>
          <Field label="Verso header" htmlFor="vh" hint="{{title}}, {{author}}, {{section}}"><Input id="vh" value={s.runningHeader.verso} onChange={(e) => setS({ ...s, runningHeader: { ...s.runningHeader, verso: e.target.value } })} /></Field>
          <Field label="Recto header" htmlFor="rh"><Input id="rh" value={s.runningHeader.recto} onChange={(e) => setS({ ...s, runningHeader: { ...s.runningHeader, recto: e.target.value } })} /></Field>
          <label className="flex items-center gap-2 text-sm sm:col-span-2"><Switch checked={s.chapterStartRecto} onCheckedChange={(c) => setS({ ...s, chapterStartRecto: c })} /> Chapters start on a right-hand page</label>
          <label className="flex items-center gap-2 text-sm sm:col-span-2"><Switch checked={s.padToEven} onCheckedChange={(c) => setS({ ...s, padToEven: c })} /> Pad to an even page count</label>
        </div>
        <Button onClick={save}>Save and regenerate layout</Button>
      </DialogContent>
    </Dialog>
  );
}

const ElementsSchema = z.array(PageElementSchema);

function PageInspector({ page, template, templates, disabled, onApply, projectId }: { page: PageInstance; template?: PageTemplate; templates: PageTemplate[]; disabled: boolean; onApply: (patch: Record<string, unknown>) => void; projectId: string }) {
  const [fields, setFields] = useState<Record<string, string | number | boolean>>({ ...Object.fromEntries((template?.fields ?? []).map((f) => [f.key, f.default])), ...page.fields });
  const elements = page.elements;
  const [json, setJson] = useState(() => JSON.stringify(elements ?? template?.elements ?? [], null, 2));
  const [jsonErr, setJsonErr] = useState<string | null>(null);
  const [mode, setMode] = useState<'form' | 'json'>('form');
  const assets = useQuery({ queryKey: ['assets', projectId], queryFn: () => api.get<{ id: string; filename: string; mimeType: string; widthPx: number | null }[]>(`/assets`) });

  const applyElements = (els: unknown[]) => {
    const r = ElementsSchema.safeParse(els);
    if (!r.success) {
      setJsonErr(r.error.issues.slice(0, 3).map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
      return;
    }
    setJsonErr(null);
    onApply({ elements: els });
  };

  return (
    <div className="grid gap-3">
      <Field label="Template" htmlFor="tplsel">
        <Select id="tplsel" value={page.templateId ?? ''} disabled={disabled} onChange={(e) => onApply({ templateId: e.target.value || null })}>
          <option value="">— Custom page —</option>
          {templates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
        </Select>
      </Field>
      {template && template.fields.length > 0 && !elements && (
        <form className="grid gap-2" onSubmit={(e) => { e.preventDefault(); onApply({ fields }); }}>
          {template.fields.map((f) => (
            <Field key={f.key} label={f.label} htmlFor={`f-${f.key}`}>
              {f.type === 'boolean' ? (
                <Switch id={`f-${f.key}`} checked={!!fields[f.key]} disabled={disabled} onCheckedChange={(c) => setFields({ ...fields, [f.key]: c })} />
              ) : f.type === 'number' ? (
                <Input id={`f-${f.key}`} type="number" disabled={disabled} value={String(fields[f.key] ?? '')} onChange={(e) => setFields({ ...fields, [f.key]: Number(e.target.value) })} />
              ) : String(fields[f.key] ?? '').length > 60 || /body|intro|bio|instructions|prompt|extra/i.test(f.key) ? (
                <Textarea id={`f-${f.key}`} rows={3} disabled={disabled} value={String(fields[f.key] ?? '')} onChange={(e) => setFields({ ...fields, [f.key]: e.target.value })} />
              ) : (
                <Input id={`f-${f.key}`} disabled={disabled} value={String(fields[f.key] ?? '')} onChange={(e) => setFields({ ...fields, [f.key]: e.target.value })} />
              )}
            </Field>
          ))}
          <Button type="submit" size="sm" disabled={disabled}>Apply fields</Button>
        </form>
      )}
      <div className="flex items-center justify-between border-t pt-3">
        <p className="text-sm font-medium">Elements {elements ? '' : template ? '(from template)' : ''}</p>
        <div className="flex gap-1">
          <Button size="sm" variant={mode === 'form' ? 'secondary' : 'ghost'} onClick={() => setMode('form')}>Form</Button>
          <Button size="sm" variant={mode === 'json' ? 'secondary' : 'ghost'} onClick={() => setMode('json')}>JSON</Button>
        </div>
      </div>
      {!elements && template && (
        <Button size="sm" variant="outline" disabled={disabled} onClick={() => onApply({ elements: template.elements })}>Customise this page’s elements</Button>
      )}
      {mode === 'json' ? (
        <div className="grid gap-2">
          <Textarea aria-label="Elements JSON" rows={14} className="font-mono text-xs" value={json} disabled={disabled || (!elements && !!template)} onChange={(e) => setJson(e.target.value)} />
          {jsonErr && <p className="text-xs text-destructive" role="alert">{jsonErr}</p>}
          <Button size="sm" disabled={disabled || (!elements && !!template)} onClick={() => { try { applyElements(JSON.parse(json)); } catch (e) { setJsonErr((e as Error).message); } }}>Apply JSON</Button>
          <p className="text-xs text-muted-foreground">Only typed elements are allowed (heading, text, lines, dotGrid, grid, checklist, table, fields, box, image, spacer, divider, columns). No HTML or code.</p>
        </div>
      ) : elements ? (
        <ElementList elements={elements} disabled={disabled} assets={assets.data ?? []} onChange={applyElements} />
      ) : (
        <ul className="grid gap-1 text-xs text-muted-foreground">{(template?.elements ?? []).map((e) => <li key={e.id}>{titleCase(e.type)} <code>{e.id}</code></li>)}</ul>
      )}
    </div>
  );
}

function ElementList({ elements, disabled, assets, onChange }: { elements: PageElement[]; disabled: boolean; assets: { id: string; filename: string; mimeType: string }[]; onChange: (els: unknown[]) => void }) {
  const [els, setEls] = useState<Record<string, unknown>[]>(() => elements.map((e) => ({ ...e })));
  const set = (i: number, patch: Record<string, unknown>) => setEls(els.map((e, j) => (j === i ? { ...e, ...patch } : e)));
  const [newType, setNewType] = useState('text');
  return (
    <div className="grid gap-2">
      {els.map((e, i) => {
        const locked = !!e.locked;
        const d = disabled || locked;
        const style = (e.style ?? {}) as Record<string, unknown>;
        const height = (e.height ?? {}) as { mode?: string; pt?: number; weight?: number };
        return (
          <details key={String(e.id) + i} className="rounded-md border p-2" open={i === els.length - 1 && els.length < 3}>
            <summary className="flex cursor-pointer items-center gap-2 text-sm">
              <span className="font-medium">{titleCase(String(e.type))}</span>
              <code className="text-xs text-muted-foreground">{String(e.id)}</code>
              {locked && <Lock className="size-3" aria-label="Locked element" />}
            </summary>
            <div className="mt-2 grid gap-2">
              {(e.type === 'heading' || e.type === 'text') && <Textarea aria-label="Text" rows={3} disabled={d} value={String(e.text ?? '')} onChange={(x) => set(i, { text: x.target.value })} />}
              {(e.type === 'heading' || e.type === 'text') && (
                <div className="grid grid-cols-3 gap-2">
                  <Input aria-label="Font size (pt)" type="number" disabled={d} value={Number(style.sizePt ?? 11)} onChange={(x) => set(i, { style: { ...style, sizePt: Number(x.target.value) } })} />
                  <Select aria-label="Alignment" disabled={d} value={String(style.align ?? 'left')} onChange={(x) => set(i, { style: { ...style, align: x.target.value } })}>{['left', 'center', 'right', 'justify'].map((a) => <option key={a}>{a}</option>)}</Select>
                  <Select aria-label="Font" disabled={d} value={String(style.font ?? 'serif')} onChange={(x) => set(i, { style: { ...style, font: x.target.value } })}><option value="serif">Serif</option><option value="sans">Sans</option></Select>
                </div>
              )}
              {(e.type === 'lines' || e.type === 'dotGrid' || e.type === 'grid') && <Field label="Spacing (pt)" htmlFor={`sp${i}`}><Input id={`sp${i}`} type="number" disabled={d} value={Number(e.spacingPt ?? 24)} onChange={(x) => set(i, { spacingPt: Number(x.target.value) })} /></Field>}
              {['lines', 'grid', 'table', 'checklist', 'fields', 'box', 'divider'].includes(String(e.type)) && <Field label="Line weight (pt)" htmlFor={`lw${i}`} hint="≥ 0.5pt prints reliably."><Input id={`lw${i}`} type="number" step="0.1" min={0.25} disabled={d} value={Number(e.weightPt ?? 0.6)} onChange={(x) => set(i, { weightPt: Number(x.target.value) })} /></Field>}
              {e.type === 'checklist' && <Field label="Items (one per line; empty = blank rows)" htmlFor={`it${i}`}><Textarea id={`it${i}`} rows={3} disabled={d} value={((e.items as string[]) ?? []).join('\n')} onChange={(x) => set(i, { items: x.target.value.split('\n').filter(Boolean) })} /></Field>}
              {e.type === 'checklist' && <Field label="Blank rows (0 = fill)" htmlFor={`ct${i}`}><Input id={`ct${i}`} type="number" min={0} disabled={d} value={Number(e.count ?? 0)} onChange={(x) => set(i, { count: Number(x.target.value) })} /></Field>}
              {e.type === 'table' && <Field label="Columns (Header:width, …)" htmlFor={`co${i}`}><Input id={`co${i}`} disabled={d} value={((e.columns as { header: string; width: number }[]) ?? []).map((c) => `${c.header}:${c.width}`).join(', ')} onChange={(x) => set(i, { columns: x.target.value.split(',').map((s) => s.trim()).filter(Boolean).map((s) => ({ header: s.split(':')[0], width: Number(s.split(':')[1] ?? 1) || 1 })) })} /></Field>}
              {e.type === 'table' && <Field label="Rows (0 = fill)" htmlFor={`rw${i}`}><Input id={`rw${i}`} type="number" min={0} disabled={d} value={Number(e.rows ?? 0)} onChange={(x) => set(i, { rows: Number(x.target.value) })} /></Field>}
              {e.type === 'fields' && <Field label="Labels (Label:width, …)" htmlFor={`fl${i}`}><Input id={`fl${i}`} disabled={d} value={((e.fields as { label: string; width: number }[]) ?? []).map((c) => `${c.label}:${c.width}`).join(', ')} onChange={(x) => set(i, { fields: x.target.value.split(',').map((s) => s.trim()).filter(Boolean).map((s) => ({ label: s.split(':')[0], width: Number(s.split(':')[1] ?? 1) || 1 })) })} /></Field>}
              {e.type === 'box' && <Field label="Label" htmlFor={`bl${i}`}><Input id={`bl${i}`} disabled={d} value={String(e.label ?? '')} onChange={(x) => set(i, { label: x.target.value })} /></Field>}
              {e.type === 'image' && (
                <Field label="Image asset" htmlFor={`im${i}`} hint="Upload images in Settings → Assets or the Cover tab.">
                  <Select id={`im${i}`} disabled={d} value={String(e.assetId ?? '')} onChange={(x) => set(i, { assetId: x.target.value })}>
                    <option value="">Select…</option>
                    {assets.filter((a) => a.mimeType.startsWith('image/')).map((a) => <option key={a.id} value={a.id}>{a.filename}</option>)}
                  </Select>
                </Field>
              )}
              <div className="grid grid-cols-3 gap-2">
                <Select aria-label="Height mode" disabled={d} value={height.mode ?? 'auto'} onChange={(x) => set(i, { height: x.target.value === 'fixed' ? { mode: 'fixed', pt: 72 } : x.target.value === 'fill' ? { mode: 'fill', weight: 1 } : { mode: 'auto' } })}>
                  <option value="auto">Auto height</option><option value="fixed">Fixed height</option><option value="fill">Fill space</option>
                </Select>
                {height.mode === 'fixed' && <Input aria-label="Height (pt)" type="number" disabled={d} value={height.pt ?? 72} onChange={(x) => set(i, { height: { mode: 'fixed', pt: Number(x.target.value) } })} />}
                {height.mode === 'fill' && <Input aria-label="Fill weight" type="number" step="0.5" disabled={d} value={height.weight ?? 1} onChange={(x) => set(i, { height: { mode: 'fill', weight: Number(x.target.value) } })} />}
              </div>
              <div className="flex flex-wrap gap-1">
                <Button size="sm" variant="ghost" disabled={disabled || i === 0} onClick={() => { const n = [...els]; [n[i - 1], n[i]] = [n[i], n[i - 1]]; setEls(n); }}><ArrowUp /> Up</Button>
                <Button size="sm" variant="ghost" disabled={disabled || i === els.length - 1} onClick={() => { const n = [...els]; [n[i + 1], n[i]] = [n[i], n[i + 1]]; setEls(n); }}><ArrowDown /> Down</Button>
                <Button size="sm" variant="ghost" disabled={disabled} onClick={() => set(i, { locked: !locked })}>{locked ? <Unlock /> : <Lock />} {locked ? 'Unlock' : 'Lock'}</Button>
                <Button size="sm" variant="ghost" disabled={d} onClick={() => setEls(els.filter((_, j) => j !== i))}><Trash2 /> Remove</Button>
              </div>
            </div>
          </details>
        );
      })}
      <div className="flex gap-2">
        <Select aria-label="Element type to add" value={newType} onChange={(e) => setNewType(e.target.value)} disabled={disabled}>
          {Object.keys(ELEMENT_DEFAULTS).map((k) => <option key={k} value={k}>{titleCase(k)}</option>)}
        </Select>
        <Button size="sm" variant="outline" disabled={disabled} onClick={() => setEls([...els, { ...ELEMENT_DEFAULTS[newType], id: `${newType}${Date.now().toString(36)}` }])}><Plus /> Add</Button>
      </div>
      <Button size="sm" disabled={disabled} onClick={() => onChange(els)}>Save elements</Button>
    </div>
  );
}

/* ---------------------------------- Long-form chapters ------------------------------------ */

function FlowEditor({ project, data, setSection, layout, editable }: { project: ProjectDetail; data: DocResponse; setSection: (s: Section) => void; layout?: LayoutSummary; editable: boolean }) {
  const qc = useQueryClient();
  const initial = data.doc.body.kind === 'flow' ? data.doc.body.chapters : [];
  const [chapters, setChapters] = useState<Chapter[]>(initial);
  const [sel, setSel] = useState(0);
  const [dirty, setDirty] = useState(false);
  const [page, setPage] = useState(1);
  const isPrint = project.format.format !== 'EBOOK';
  useEffect(() => {
    if (!dirty) setChapters(data.doc.body.kind === 'flow' ? data.doc.body.chapters : []);
  }, [data, dirty]);
  const ch = chapters[sel];
  const update = (patch: Partial<Chapter>) => {
    setChapters(chapters.map((c, i) => (i === sel ? { ...c, ...patch } : c)));
    setDirty(true);
  };
  const setBlock = (i: number, b: FlowBlock) => update({ blocks: ch.blocks.map((x, j) => (j === i ? b : x)) });
  const save = async () => {
    const parsed = z.array(Chapter).safeParse(chapters);
    if (!parsed.success) return toast.error(parsed.error.issues[0].message);
    try {
      await api.put(`/projects/${project.id}/interior/chapters`, { revision: data.revision, chapters: parsed.data });
      setDirty(false);
      await qc.invalidateQueries({ queryKey: ['interior', project.id] });
      await qc.invalidateQueries({ queryKey: ['layout', project.id] });
      toast.success('Chapters saved; layout regenerated.');
    } catch (e) {
      toast.error((e as Error).message);
    }
  };
  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <div className="inline-flex rounded-lg bg-muted p-1">
          {(['front', 'body', 'back'] as const).map((s) => (
            <button key={s} onClick={() => setSection(s)} className={cn('rounded-md px-3 py-1 text-sm', s === 'body' ? 'bg-background font-medium shadow-sm' : 'text-muted-foreground')}>{s === 'front' ? 'Front matter' : s === 'back' ? 'Back matter' : 'Chapters'}</button>
          ))}
        </div>
        {editable && <Button size="sm" onClick={save} disabled={!dirty}>Save chapters</Button>}
        {dirty && <Badge tone="warning">Unsaved changes</Badge>}
        {layout && <Badge tone="muted" className="ml-auto">{layout.pageCount} pages</Badge>}
      </div>
      <div className="grid gap-4 lg:grid-cols-[220px_minmax(0,1fr)_minmax(0,0.9fr)]">
        <Card>
          <CardContent className="grid gap-1 p-2">
            {chapters.map((c, i) => (
              <button key={c.id} onClick={() => setSel(i)} className={cn('rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent', i === sel && 'bg-accent font-medium')}>{i + 1}. {c.title || 'Untitled'}</button>
            ))}
            {editable && <Button size="sm" variant="outline" onClick={() => { setChapters([...chapters, { id: `c${Date.now().toString(36)}`, title: 'New chapter', blocks: [{ type: 'paragraph', text: '' }], notes: [] }]); setSel(chapters.length); setDirty(true); }}><Plus /> Chapter</Button>}
          </CardContent>
        </Card>
        {ch ? (
          <Card>
            <CardContent className="grid gap-3 p-4">
              <Field label="Chapter title" htmlFor="ctitle"><Input id="ctitle" disabled={!editable} value={ch.title} onChange={(e) => update({ title: e.target.value })} /></Field>
              {ch.blocks.map((b, i) => (
                <div key={i} className="grid gap-1 rounded-md border p-2">
                  <div className="flex items-center gap-2">
                    <Select aria-label="Block type" className="h-8 w-40" disabled={!editable} value={b.type} onChange={(e) => {
                      const t = e.target.value;
                      const text = 'text' in b ? b.text : '';
                      setBlock(i, t === 'list' ? { type: 'list', items: text ? [text] : [''], ordered: false } : t === 'heading' ? { type: 'heading', text, level: 2 } : t === 'sectionBreak' || t === 'pageBreak' ? ({ type: t } as FlowBlock) : ({ type: t, text } as FlowBlock));
                    }}>
                      {['paragraph', 'heading', 'quote', 'list', 'sectionBreak', 'pageBreak'].map((t) => <option key={t} value={t}>{titleCase(t)}</option>)}
                    </Select>
                    <span className="flex-1" />
                    {editable && <Button size="icon" variant="ghost" aria-label="Move block up" disabled={i === 0} onClick={() => { const n = [...ch.blocks]; [n[i - 1], n[i]] = [n[i], n[i - 1]]; update({ blocks: n }); }}><ArrowUp /></Button>}
                    {editable && <Button size="icon" variant="ghost" aria-label="Delete block" onClick={() => update({ blocks: ch.blocks.filter((_, j) => j !== i) })}><Trash2 /></Button>}
                  </div>
                  {'text' in b && <Textarea aria-label="Block text" rows={b.type === 'paragraph' ? 4 : 2} disabled={!editable} value={b.text} onChange={(e) => setBlock(i, { ...b, text: e.target.value })} />}
                  {b.type === 'list' && <Textarea aria-label="List items, one per line" rows={3} disabled={!editable} value={b.items.join('\n')} onChange={(e) => setBlock(i, { ...b, items: e.target.value.split('\n') })} />}
                </div>
              ))}
              {editable && <Button size="sm" variant="outline" onClick={() => update({ blocks: [...ch.blocks, { type: 'paragraph', text: '' }] })}><Plus /> Paragraph</Button>}
              <Field label="Endnotes (one per line; reference with [^1] in text)" htmlFor="notes"><Textarea id="notes" rows={3} disabled={!editable} value={ch.notes.join('\n')} onChange={(e) => update({ notes: e.target.value.split('\n').filter(Boolean) })} /></Field>
              {editable && <Button size="sm" variant="ghost" className="justify-self-start text-destructive" onClick={() => { if (confirm('Delete this chapter?')) { setChapters(chapters.filter((_, i) => i !== sel)); setSel(0); setDirty(true); } }}><Trash2 /> Delete chapter</Button>}
            </CardContent>
          </Card>
        ) : <EmptyState title="No chapters" />}
        <div className="checker grid content-start justify-items-center gap-2 overflow-auto rounded-lg border p-4">
          {isPrint && layout ? (
            <>
              <div className="flex items-center gap-2">
                <Button size="sm" variant="ghost" onClick={() => setPage(Math.max(1, page - 1))} aria-label="Previous page"><ArrowUp className="-rotate-90" /></Button>
                <span className="text-xs tabular-nums">Page {page} / {layout.pageCount}</span>
                <Button size="sm" variant="ghost" onClick={() => setPage(Math.min(layout.pageCount, page + 1))} aria-label="Next page"><ArrowDown className="-rotate-90" /></Button>
              </div>
              <img src={`/api/projects/${project.id}/interior/pages/${page}/preview.png?dpi=110&r=${data.revision}`} alt={`Page ${page}`} className="page-shadow w-full max-w-[5in] bg-white" />
            </>
          ) : <p className="p-6 text-sm text-muted-foreground">Kindle eBooks reflow on the reader's device. Export the EPUB to preview.</p>}
        </div>
      </div>
    </div>
  );
}
