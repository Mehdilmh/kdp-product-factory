import { CoverDesign, type CoverGeometry, type CoverLayer, type Paint } from '@kdp/core/browser';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowDown, ArrowUp, Copy, Eye, EyeOff, ImagePlus, Lock, Redo2, Save, Shapes, Square, Trash2, Type, Undo2, Unlock, Upload } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { create } from 'zustand';
import { Badge, Card, CardContent, CardHeader, CardTitle, EmptyState, ErrorBox, Field, Input, Select, Skeleton, Textarea } from '@/components/ui/basic';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogTrigger } from '@/components/ui/overlay';
import { api } from '@/lib/api';
import { canEdit, useAuth } from '@/lib/auth';
import type { CoverRow, ProjectDetail } from '@/lib/types';
import { cn, titleCase } from '@/lib/utils';
import { AiArtDialog } from './image-models';

/* ---------------------------------- Undo/redo store ----------------------------------------- */

interface EditorState {
  design: CoverDesign | null;
  past: CoverDesign[];
  future: CoverDesign[];
  selected: string | null;
  dirty: boolean;
  load: (d: CoverDesign) => void;
  commit: (fn: (d: CoverDesign) => CoverDesign) => void;
  undo: () => void;
  redo: () => void;
  select: (id: string | null) => void;
  markSaved: () => void;
}

const useCover = create<EditorState>((set, get) => ({
  design: null,
  past: [],
  future: [],
  selected: null,
  dirty: false,
  load: (d) => set({ design: d, past: [], future: [], selected: null, dirty: false }),
  commit: (fn) => {
    const cur = get().design;
    if (!cur) return;
    const next = fn(structuredClone(cur));
    set({ design: next, past: [...get().past.slice(-99), cur], future: [], dirty: true });
  },
  undo: () => {
    const { past, design, future } = get();
    if (!past.length || !design) return;
    set({ design: past[past.length - 1], past: past.slice(0, -1), future: [design, ...future], dirty: true });
  },
  redo: () => {
    const { past, design, future } = get();
    if (!future.length || !design) return;
    set({ design: future[0], future: future.slice(1), past: [...past, design], dirty: true });
  },
  select: (id) => set({ selected: id }),
  markSaved: () => set({ dirty: false }),
}));

const ICONS: Record<string, { d: string; w: number; h: number }> = {
  Star: { d: 'M50 0 L61 35 L98 35 L68 57 L79 91 L50 70 L21 91 L32 57 L2 35 L39 35 Z', w: 100, h: 100 },
  Heart: { d: 'M50 88 C20 65 0 45 0 25 C0 10 12 0 26 0 C37 0 46 7 50 16 C54 7 63 0 74 0 C88 0 100 10 100 25 C100 45 80 65 50 88 Z', w: 100, h: 90 },
  Leaf: { d: 'M10 90 C10 40 40 10 90 10 C90 60 60 90 10 90 Z M10 90 L60 40', w: 100, h: 100 },
  Moon: { d: 'M60 5 A45 45 0 1 0 95 70 A35 35 0 1 1 60 5 Z', w: 100, h: 100 },
  Sun: { d: 'M50 25 A25 25 0 1 1 49.9 25 Z M50 0 L54 15 L46 15 Z M50 100 L46 85 L54 85 Z M0 50 L15 46 L15 54 Z M100 50 L85 54 L85 46 Z', w: 100, h: 100 },
  Diamond: { d: 'M50 0 L100 50 L50 100 L0 50 Z', w: 100, h: 100 },
};

/* ---------------------------------------- Editor --------------------------------------------- */

export default function CoverEditor({ project }: { project: ProjectDetail }) {
  const { role } = useAuth();
  const editable = canEdit(role);
  const qc = useQueryClient();
  const data = useQuery({ queryKey: ['covers', project.id], queryFn: () => api.get<{ covers: CoverRow[]; geometry: CoverGeometry; themes: { id: string; name: string }[] }>(`/projects/${project.id}/covers`) });
  const [activeId, setActiveId] = useState<string | null>(null);
  const cover = data.data?.covers.find((c) => c.id === activeId) ?? data.data?.covers.find((c) => c.isActive) ?? data.data?.covers[0] ?? null;
  const [revision, setRevision] = useState(0);
  const { design, load, dirty, markSaved, undo, redo } = useCover();

  useEffect(() => {
    if (cover && (!dirty || useCover.getState().design === null)) {
      load(CoverDesign.parse(cover.design));
      setRevision(cover.revision);
    }
  }, [cover?.id, cover?.revision]); // eslint-disable-line react-hooks/exhaustive-deps

  const save = useCallback(async () => {
    if (!cover || !design) return;
    try {
      const r = await api.put<CoverRow>(`/projects/${project.id}/covers/${cover.id}`, { revision, design });
      setRevision(r.revision);
      markSaved();
      await qc.invalidateQueries({ queryKey: ['covers', project.id] });
      toast.success('Cover saved');
    } catch (e) {
      toast.error((e as Error).message);
    }
  }, [cover, design, revision, project.id, qc, markSaved]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      if (e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
      } else if (e.key.toLowerCase() === 's') {
        e.preventDefault();
        void save();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [undo, redo, save]);

  if (data.isLoading) return <Skeleton className="h-[600px]" />;
  if (data.error) return <ErrorBox error={data.error} title="Could not load covers" />;
  const geom = data.data!.geometry;
  if (!cover) return <NewCoverCard project={project} geometry={geom} themes={data.data!.themes} editable={editable} />;

  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <Select aria-label="Cover design" className="w-56" value={cover.id} onChange={(e) => { if (dirty && !confirm('Discard unsaved changes?')) return; markSaved(); setActiveId(e.target.value); }}>
          {data.data!.covers.map((c) => <option key={c.id} value={c.id}>{c.name}{c.isActive ? ' (used for export)' : ''}</option>)}
        </Select>
        {editable && (
          <>
            <Button size="sm" onClick={save} disabled={!dirty}><Save /> Save</Button>
            <Button size="sm" variant="ghost" aria-label="Undo" onClick={undo} disabled={!useCover.getState().past.length}><Undo2 /></Button>
            <Button size="sm" variant="ghost" aria-label="Redo" onClick={redo} disabled={!useCover.getState().future.length}><Redo2 /></Button>
            <Button size="sm" variant="outline" onClick={async () => { const c = await api.post<CoverRow>(`/projects/${project.id}/covers/${cover.id}/duplicate`); await qc.invalidateQueries({ queryKey: ['covers', project.id] }); setActiveId(c.id); toast.success('Design duplicated'); }}><Copy /> Duplicate</Button>
            {!cover.isActive && <Button size="sm" variant="outline" onClick={async () => { await api.post(`/projects/${project.id}/covers/${cover.id}/activate`); await qc.invalidateQueries({ queryKey: ['covers', project.id] }); toast.success('This design will be used for exports'); }}>Use for export</Button>}
            <OfficialTemplateDialog project={project} geometry={geom} />
            <NewCoverDialog project={project} themes={data.data!.themes} onCreated={(id) => setActiveId(id)} />
            {geom.source !== 'UNRESOLVED' && design && (
              <AiArtDialog
                projectId={project.id}
                onUse={(assetId, scope) => {
                  // Same placement as the server's apply-art: art spans the area incl. bleed, below all text.
                  const b = geom.bleedIn;
                  const f = geom.panels.front;
                  const layer = (scope === 'wrap'
                    ? { id: 'cover-art', name: 'Cover art (AI)', type: 'image', anchor: 'canvas', x: 0, y: 0, w: geom.widthIn, h: geom.heightIn, assetId, fit: 'cover', rotation: 0, opacity: 1, locked: false, hidden: false }
                    : { id: 'cover-art', name: 'Cover art (AI)', type: 'image', anchor: 'front', x: geom.direction === 'RTL' ? -b : 0, y: -b, w: f.w + b, h: f.h + 2 * b, assetId, fit: 'cover', rotation: 0, opacity: 1, locked: false, hidden: false }) as unknown as CoverLayer;
                  useCover.getState().commit((d) => ({ ...d, layers: [layer, ...d.layers.filter((l) => l.id !== 'cover-art')] }));
                }}
              />
            )}
          </>
        )}
        {dirty && <Badge tone="warning">Unsaved changes</Badge>}
        <Badge tone="muted" className="ml-auto">{geom.format === 'EBOOK' ? 'eBook front cover 1600×2560 px' : `${geom.widthIn}" × ${geom.heightIn}" · spine ${geom.spineWidthIn}" · ${geom.pageCount} pages`}</Badge>
      </div>
      {geom.source === 'UNRESOLVED' ? (
        <ErrorBox title="Hardcover geometry required" error={new Error('Enter the official KDP cover calculator values (or import the official template PDF) to design a hardcover cover.')} />
      ) : design ? (
        <CoverWorkspace project={project} coverId={cover.id} geometry={geom} editable={editable} />
      ) : null}
    </div>
  );
}

function CoverWorkspace({ project, coverId, geometry: g, editable }: { project: ProjectDetail; coverId: string; geometry: CoverGeometry; editable: boolean }) {
  const { design, commit, selected, select } = useCover();
  const [guides, setGuides] = useState(true);
  const [view, setView] = useState<'wrap' | 'front'>('wrap');
  const [check, setCheck] = useState<{ svg: string; warnings: { code: string; level: string; message: string; layerId?: string }[] } | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(900);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth - 32));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Server-side layout keeps typography identical to the PDF; debounced while editing.
  useEffect(() => {
    if (!design) return;
    const t = setTimeout(async () => {
      try {
        setCheck(await api.post(`/projects/${project.id}/covers/${coverId}/check`, { design, guides }));
      } catch (e) {
        toast.error((e as Error).message);
      }
    }, 300);
    return () => clearTimeout(t);
  }, [design, guides, project.id, coverId]);

  if (!design) return null;
  const front = g.panels.front;
  const viewRect = view === 'front' ? { x: front.x - g.bleedIn, y: 0, w: front.w + 2 * g.bleedIn, h: g.heightIn } : { x: 0, y: 0, w: g.widthIn, h: g.heightIn };
  const scale = Math.min(width / viewRect.w, 640 / viewRect.h); // px per inch
  const sel = design.layers.find((l) => l.id === selected) ?? null;
  const anchorOrigin = (l: CoverLayer) => (l.anchor === 'canvas' ? { x: 0, y: 0 } : g.panels[l.anchor]);

  const updateLayer = (id: string, patch: Partial<CoverLayer>) => commit((d) => ({ ...d, layers: d.layers.map((l) => (l.id === id ? ({ ...l, ...patch } as CoverLayer) : l)) }));

  const onPointerDown = (e: React.PointerEvent, l: CoverLayer, mode: 'move' | 'resize') => {
    if (!editable || l.locked) return;
    e.preventDefault();
    e.stopPropagation();
    select(l.id);
    const start = { x: e.clientX, y: e.clientY, lx: l.x, ly: l.y, lw: l.w, lh: l.h };
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    let last = { x: l.x, y: l.y, w: l.w, h: l.h };
    const move = (ev: PointerEvent) => {
      const dx = (ev.clientX - start.x) / scale;
      const dy = (ev.clientY - start.y) / scale;
      last = mode === 'move' ? { x: round(start.lx + dx), y: round(start.ly + dy), w: l.w, h: l.h } : { x: l.x, y: l.y, w: Math.max(0.1, round(start.lw + dx)), h: Math.max(0.1, round(start.lh + dy)) };
      const box = (el.closest('[data-layer]') ?? el) as HTMLElement;
      const o = anchorOrigin(l);
      box.style.left = `${(o.x + last.x - viewRect.x) * scale}px`;
      box.style.top = `${(o.y + last.y - viewRect.y) * scale}px`;
      box.style.width = `${last.w * scale}px`;
      box.style.height = `${last.h * scale}px`;
    };
    const up = () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      if (last.x !== l.x || last.y !== l.y || last.w !== l.w || last.h !== l.h) updateLayer(l.id, last);
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!sel || !editable || sel.locked) return;
    const step = e.shiftKey ? 0.1 : 0.01;
    const moves: Record<string, [number, number]> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
    if (moves[e.key]) {
      e.preventDefault();
      updateLayer(sel.id, { x: round(sel.x + moves[e.key][0]), y: round(sel.y + moves[e.key][1]) });
    } else if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      commit((d) => ({ ...d, layers: d.layers.filter((l) => l.id !== sel.id) }));
      select(null);
    } else if (e.key === 'Escape') select(null);
  };

  return (
    <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_340px]">
      <div className="grid gap-2">
        <div className="flex flex-wrap items-center gap-2">
          {g.format !== 'EBOOK' && (
            <div className="inline-flex rounded-lg bg-muted p-1" role="tablist" aria-label="View">
              {(['wrap', 'front'] as const).map((v) => <button key={v} role="tab" aria-selected={view === v} onClick={() => setView(v)} className={cn('rounded-md px-3 py-1 text-sm', view === v ? 'bg-background font-medium shadow-sm' : 'text-muted-foreground')}>{v === 'wrap' ? 'Full wrap' : 'Front cover'}</button>)}
            </div>
          )}
          <Button size="sm" variant="ghost" onClick={() => setGuides(!guides)} aria-pressed={guides}>{guides ? <Eye /> : <EyeOff />} Guides</Button>
          {editable && <AddLayerMenu geometry={g} projectId={project.id} />}
          <span className="text-xs text-muted-foreground">Drag to move · corner to resize · arrows nudge (Shift ×10) · Ctrl+Z / Ctrl+Shift+Z</span>
        </div>
        <div ref={containerRef} className="checker overflow-hidden rounded-lg border p-4" onKeyDown={onKeyDown} tabIndex={0} aria-label="Cover canvas. Use arrow keys to nudge the selected layer." onPointerDown={() => select(null)}>
          <div className="relative mx-auto overflow-hidden bg-white page-shadow" style={{ width: viewRect.w * scale, height: viewRect.h * scale }}>
            {check ? (
              <div
                className="pointer-events-none absolute [&>svg]:h-full [&>svg]:w-full"
                style={{ left: -viewRect.x * scale, top: -viewRect.y * scale, width: g.widthIn * scale, height: g.heightIn * scale }}
                // Server-generated SVG: all text and attributes are XML-escaped and path data is allow-listed.
                dangerouslySetInnerHTML={{ __html: check.svg.replace(/^<\?xml[^>]*>/, '') }}
              />
            ) : <Skeleton className="absolute inset-0" />}
            {design.layers.map((l) => {
              if (l.hidden) return null;
              const o = anchorOrigin(l);
              return (
                <div
                  key={l.id}
                  data-layer={l.id}
                  role="button"
                  aria-label={`${titleCase(l.type)} layer ${l.name || l.id}`}
                  aria-pressed={selected === l.id}
                  className={cn('absolute cursor-move border border-transparent hover:border-primary/60', selected === l.id && 'border-primary ring-1 ring-primary', l.locked && 'cursor-not-allowed')}
                  style={{ left: (o.x + l.x - viewRect.x) * scale, top: (o.y + l.y - viewRect.y) * scale, width: l.w * scale, height: l.h * scale, transform: l.rotation ? `rotate(${l.rotation}deg)` : undefined }}
                  onPointerDown={(e) => onPointerDown(e, l, 'move')}
                >
                  {selected === l.id && editable && !l.locked && <span className="absolute -bottom-1.5 -right-1.5 size-3 cursor-nwse-resize rounded-sm bg-primary" onPointerDown={(e) => onPointerDown(e, l, 'resize')} aria-hidden />}
                </div>
              );
            })}
          </div>
        </div>
        {check && check.warnings.length > 0 && (
          <Card>
            <CardHeader className="pb-2"><CardTitle className="text-sm">Cover checks</CardTitle></CardHeader>
            <CardContent className="grid gap-1 text-sm">
              {check.warnings.map((w, i) => (
                <button key={i} className={cn('text-left', w.level === 'error' ? 'text-destructive' : 'text-warning')} onClick={() => w.layerId && select(w.layerId)}>
                  <strong>{titleCase(w.code)}</strong>: {w.message}
                </button>
              ))}
            </CardContent>
          </Card>
        )}
      </div>
      <div className="grid content-start gap-4">
        <LayersPanel editable={editable} />
        {sel ? <PropertiesPanel layer={sel} editable={editable} projectId={project.id} geometry={g} update={(p) => updateLayer(sel.id, p)} /> : <DesignPanel editable={editable} projectId={project.id} />}
      </div>
    </div>
  );
}

const round = (v: number) => Math.round(v * 1000) / 1000;
const newId = (p: string) => `${p}-${Date.now().toString(36)}`;

function AddLayerMenu({ geometry: g, projectId }: { geometry: CoverGeometry; projectId: string }) {
  const { commit, select } = useCover();
  const f = g.panels.front;
  const add = (layer: Record<string, unknown>) => {
    const l = { anchor: 'front', x: f.w * 0.2, y: f.h * 0.4, w: f.w * 0.6, h: 1, rotation: 0, opacity: 1, locked: false, hidden: false, name: '', ...layer } as CoverLayer;
    commit((d) => ({ ...d, layers: [...d.layers, l] }));
    select(l.id);
  };
  const fileRef = useRef<HTMLInputElement>(null);
  return (
    <div className="flex flex-wrap gap-1">
      <Button size="sm" variant="outline" onClick={() => add({ id: newId('text'), type: 'text', text: 'New text', name: 'Text', sizePt: 24, role: 'other', font: 'serif', color: '#000000', align: 'center', valign: 'top', lineHeight: 1.15, bold: false, italic: false })}><Type /> Text</Button>
      <Button size="sm" variant="outline" onClick={() => add({ id: newId('rect'), type: 'rect', name: 'Shape', fill: { type: 'solid', color: '#E8C26A' }, stroke: null, strokeWidthPt: 0, radiusIn: 0, h: 0.5 })}><Square /> Shape</Button>
      <Select aria-label="Add icon" className="h-8 w-28" value="" onChange={(e) => { const ic = ICONS[e.target.value]; if (ic) add({ id: newId('icon'), type: 'path', name: e.target.value, d: ic.d, viewBoxW: ic.w, viewBoxH: ic.h, fill: '#E8C26A', stroke: null, strokeWidthPt: 0, w: 1, h: 1 }); }}>
        <option value="" disabled>Icon…</option>
        {Object.keys(ICONS).map((k) => <option key={k}>{k}</option>)}
      </Select>
      <Button size="sm" variant="outline" onClick={() => fileRef.current?.click()}><ImagePlus /> Image</Button>
      <input
        ref={fileRef}
        type="file"
        accept="image/png,image/jpeg"
        className="hidden"
        onChange={async (e) => {
          const file = e.target.files?.[0];
          if (!file) return;
          const fd = new FormData();
          fd.append('file', file);
          fd.append('projectId', projectId);
          const note = prompt('License / permission note for this image (required for third-party images):', '') ?? '';
          fd.append('licenseNote', note);
          try {
            const a = await api.upload<{ id: string; widthPx: number; heightPx: number }>('/assets', fd);
            const w = f.w;
            add({ id: newId('img'), type: 'image', name: file.name, assetId: a.id, fit: 'cover', x: 0, y: 0, w, h: (w * a.heightPx) / a.widthPx });
            toast.success('Image added. Check its print resolution in the cover checks.');
          } catch (err) {
            toast.error((err as Error).message);
          }
          e.target.value = '';
        }}
      />
    </div>
  );
}

function LayersPanel({ editable }: { editable: boolean }) {
  const { design, commit, selected, select } = useCover();
  if (!design) return null;
  const move = (i: number, dir: -1 | 1) => commit((d) => {
    const l = [...d.layers];
    const j = i + dir;
    if (j < 0 || j >= l.length) return d;
    [l[i], l[j]] = [l[j], l[i]];
    return { ...d, layers: l };
  });
  return (
    <Card>
      <CardHeader className="pb-2"><CardTitle className="text-sm">Layers (top first)</CardTitle></CardHeader>
      <CardContent className="grid gap-1">
        {[...design.layers].reverse().map((l) => {
          const i = design.layers.indexOf(l);
          return (
            <div key={l.id} className={cn('flex items-center gap-1 rounded-md px-1.5 py-1 text-sm', selected === l.id && 'bg-accent')}>
              <button className="min-w-0 flex-1 truncate text-left" onClick={() => select(l.id)}>
                <span className="text-xs text-muted-foreground">{titleCase(l.type)}</span> {l.name || ('text' in l ? l.text.slice(0, 24) : l.id)}
              </button>
              {editable && (
                <>
                  <Button size="icon" variant="ghost" className="size-7" aria-label="Bring forward" onClick={() => move(i, 1)}><ArrowUp /></Button>
                  <Button size="icon" variant="ghost" className="size-7" aria-label="Send backward" onClick={() => move(i, -1)}><ArrowDown /></Button>
                  <Button size="icon" variant="ghost" className="size-7" aria-label={l.hidden ? 'Show' : 'Hide'} onClick={() => commit((d) => ({ ...d, layers: d.layers.map((x) => (x.id === l.id ? { ...x, hidden: !x.hidden } : x)) }))}>{l.hidden ? <EyeOff /> : <Eye />}</Button>
                  <Button size="icon" variant="ghost" className="size-7" aria-label={l.locked ? 'Unlock' : 'Lock'} onClick={() => commit((d) => ({ ...d, layers: d.layers.map((x) => (x.id === l.id ? { ...x, locked: !x.locked } : x)) }))}>{l.locked ? <Lock /> : <Unlock />}</Button>
                </>
              )}
            </div>
          );
        })}
        {design.layers.length === 0 && <p className="text-sm text-muted-foreground">No layers. Add text, shapes, icons, or images.</p>}
      </CardContent>
    </Card>
  );
}

function PaintEditor({ paint, onChange, disabled }: { paint: Paint | null; onChange: (p: Paint | null) => void; disabled?: boolean }) {
  const p = paint ?? { type: 'solid' as const, color: '#ffffff' };
  return (
    <div className="grid gap-2">
      <Select aria-label="Fill type" disabled={disabled} value={paint ? p.type : 'none'} onChange={(e) => onChange(e.target.value === 'none' ? null : e.target.value === 'solid' ? { type: 'solid', color: p.type === 'solid' ? p.color : p.stops[0].color } : { type: 'linear', angle: 90, stops: [{ offset: 0, color: p.type === 'solid' ? p.color : '#1B2541' }, { offset: 1, color: '#0B1020' }] })}>
        <option value="none">No fill</option><option value="solid">Solid color</option><option value="linear">Linear gradient</option>
      </Select>
      {paint?.type === 'solid' && <Input aria-label="Fill color" type="color" disabled={disabled} value={paint.color} onChange={(e) => onChange({ type: 'solid', color: e.target.value })} />}
      {paint?.type === 'linear' && (
        <div className="grid grid-cols-3 gap-2">
          <Input aria-label="Gradient start color" type="color" disabled={disabled} value={paint.stops[0].color} onChange={(e) => onChange({ ...paint, stops: [{ ...paint.stops[0], color: e.target.value }, ...paint.stops.slice(1)] })} />
          <Input aria-label="Gradient end color" type="color" disabled={disabled} value={paint.stops.at(-1)!.color} onChange={(e) => onChange({ ...paint, stops: [...paint.stops.slice(0, -1), { ...paint.stops.at(-1)!, color: e.target.value }] })} />
          <Input aria-label="Gradient angle" type="number" disabled={disabled} value={paint.angle} onChange={(e) => onChange({ ...paint, angle: Number(e.target.value) })} />
        </div>
      )}
    </div>
  );
}

function AlignButtons({ layer: l, geometry: g, update, disabled }: { layer: CoverLayer; geometry: CoverGeometry; update: (p: Partial<CoverLayer>) => void; disabled: boolean }) {
  // Align within the anchor panel's safe area (canvas-anchored layers align to the full canvas).
  const panel = l.anchor === 'canvas' ? { x: 0, y: 0, w: g.widthIn, h: g.heightIn } : g.panels[l.anchor];
  const safe = l.anchor === 'canvas' ? panel : g.safe[l.anchor];
  const sx = safe.x - panel.x;
  const sy = safe.y - panel.y;
  const r = (v: number) => Math.round(v * 1000) / 1000;
  const btn = (label: string, patch: Partial<CoverLayer>) => (
    <Button key={label} size="sm" variant="outline" className="h-7 px-2 text-xs" disabled={disabled || safe.w <= 0} onClick={() => update(patch)}>{label}</Button>
  );
  return (
    <div className="grid gap-1">
      <span className="text-xs text-muted-foreground">Align to safe area</span>
      <div className="flex flex-wrap gap-1">
        {btn('Left', { x: r(sx) })}
        {btn('Center', { x: r(sx + (safe.w - l.w) / 2) })}
        {btn('Right', { x: r(sx + safe.w - l.w) })}
        {btn('Top', { y: r(sy) })}
        {btn('Middle', { y: r(sy + (safe.h - l.h) / 2) })}
        {btn('Bottom', { y: r(sy + safe.h - l.h) })}
        {btn('Fill width', { x: r(sx), w: r(safe.w) })}
      </div>
    </div>
  );
}

function PropertiesPanel({ layer: l, editable, update, projectId, geometry }: { layer: CoverLayer; editable: boolean; update: (p: Partial<CoverLayer>) => void; projectId: string; geometry: CoverGeometry }) {
  const { commit, select } = useCover();
  const d = !editable || l.locked;
  const num = (k: keyof CoverLayer, label: string, step = 0.01) => (
    <Field label={label} htmlFor={`p-${String(k)}`}>
      <Input id={`p-${String(k)}`} type="number" step={step} disabled={d} value={Number(l[k] as number)} onChange={(e) => update({ [k]: Number(e.target.value) } as Partial<CoverLayer>)} />
    </Field>
  );
  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between space-y-0 pb-2">
        <CardTitle className="text-sm">{titleCase(l.type)} properties</CardTitle>
        {editable && (
          <div className="flex gap-1">
            <Button size="icon" variant="ghost" aria-label="Duplicate layer" onClick={() => commit((dd) => ({ ...dd, layers: [...dd.layers, { ...structuredClone(l), id: newId(l.type), x: l.x + 0.1, y: l.y + 0.1, locked: false }] }))}><Copy /></Button>
            <Button size="icon" variant="ghost" aria-label="Delete layer" disabled={l.locked} onClick={() => { commit((dd) => ({ ...dd, layers: dd.layers.filter((x) => x.id !== l.id) })); select(null); }}><Trash2 /></Button>
          </div>
        )}
      </CardHeader>
      <CardContent className="grid gap-3">
        {l.locked && <p className="text-xs text-muted-foreground">Locked. Unlock it in the layer list to edit.</p>}
        <Field label="Name" htmlFor="p-name"><Input id="p-name" disabled={d} value={l.name} onChange={(e) => update({ name: e.target.value })} /></Field>
        <Field label="Anchored to" htmlFor="p-anchor" hint="Positions are relative to this panel’s trim edge, so spine changes don’t move your front-cover layout.">
          <Select id="p-anchor" disabled={d} value={l.anchor} onChange={(e) => update({ anchor: e.target.value as CoverLayer['anchor'] })}>{['front', 'back', 'spine', 'canvas'].map((a) => <option key={a}>{a}</option>)}</Select>
        </Field>
        <div className="grid grid-cols-2 gap-2">{num('x', 'X (in)')}{num('y', 'Y (in)')}{num('w', 'Width (in)')}{num('h', 'Height (in)')}{num('rotation', 'Rotation (°)', 1)}{num('opacity', 'Opacity', 0.05)}</div>
        <AlignButtons layer={l} geometry={geometry} update={update} disabled={d} />
        {l.type === 'text' && (
          <>
            <Field label="Text" htmlFor="p-text"><Textarea id="p-text" rows={3} disabled={d} value={l.text} onChange={(e) => update({ text: e.target.value })} /></Field>
            <div className="grid grid-cols-2 gap-2">
              <Field label="Role" htmlFor="p-role"><Select id="p-role" disabled={d} value={l.role} onChange={(e) => update({ role: e.target.value as typeof l.role })}>{['title', 'subtitle', 'author', 'spine', 'back', 'tagline', 'other'].map((r) => <option key={r}>{r}</option>)}</Select></Field>
              <Field label="Font" htmlFor="p-font"><Select id="p-font" disabled={d} value={l.font} onChange={(e) => update({ font: e.target.value as 'serif' | 'sans' })}><option value="serif">Caladea (serif)</option><option value="sans">Carlito (sans)</option></Select></Field>
              <Field label="Size (pt)" htmlFor="p-size"><Input id="p-size" type="number" disabled={d} value={l.sizePt} onChange={(e) => update({ sizePt: Number(e.target.value) })} /></Field>
              <Field label="Color" htmlFor="p-color"><Input id="p-color" type="color" disabled={d} value={l.color} onChange={(e) => update({ color: e.target.value })} /></Field>
              <Field label="Align" htmlFor="p-align"><Select id="p-align" disabled={d} value={l.align} onChange={(e) => update({ align: e.target.value as 'left' })}>{['left', 'center', 'right'].map((a) => <option key={a}>{a}</option>)}</Select></Field>
              <Field label="Vertical" htmlFor="p-valign"><Select id="p-valign" disabled={d} value={l.valign} onChange={(e) => update({ valign: e.target.value as 'top' })}>{['top', 'middle', 'bottom'].map((a) => <option key={a}>{a}</option>)}</Select></Field>
              <Field label="Line height" htmlFor="p-lh"><Input id="p-lh" type="number" step="0.05" disabled={d} value={l.lineHeight} onChange={(e) => update({ lineHeight: Number(e.target.value) })} /></Field>
              <div className="flex items-end gap-3 pb-2 text-sm">
                <label className="flex items-center gap-1"><input type="checkbox" disabled={d} checked={l.bold} onChange={(e) => update({ bold: e.target.checked })} /> Bold</label>
                <label className="flex items-center gap-1"><input type="checkbox" disabled={d} checked={l.italic} onChange={(e) => update({ italic: e.target.checked })} /> Italic</label>
              </div>
            </div>
          </>
        )}
        {(l.type === 'rect' || l.type === 'ellipse') && (
          <>
            <Field label="Fill" htmlFor="p-fill"><PaintEditor paint={l.fill} disabled={d} onChange={(fill) => update({ fill } as Partial<CoverLayer>)} /></Field>
            <div className="grid grid-cols-2 gap-2">
              <Field label="Stroke" htmlFor="p-stroke"><Input id="p-stroke" type="color" disabled={d} value={l.stroke ?? '#000000'} onChange={(e) => update({ stroke: e.target.value } as Partial<CoverLayer>)} /></Field>
              <Field label="Stroke width (pt)" htmlFor="p-sw"><Input id="p-sw" type="number" disabled={d} value={l.strokeWidthPt} onChange={(e) => update({ strokeWidthPt: Number(e.target.value), stroke: l.stroke ?? '#000000' } as Partial<CoverLayer>)} /></Field>
            </div>
          </>
        )}
        {l.type === 'path' && <Field label="Fill" htmlFor="p-pfill"><Input id="p-pfill" type="color" disabled={d} value={l.fill ?? '#000000'} onChange={(e) => update({ fill: e.target.value } as Partial<CoverLayer>)} /></Field>}
        {l.type === 'image' && (
          <>
            <Field label="Fit" htmlFor="p-fit"><Select id="p-fit" disabled={d} value={l.fit} onChange={(e) => update({ fit: e.target.value as 'cover' })}><option value="cover">Cover (crop)</option><option value="contain">Contain</option></Select></Field>
            <a className="text-xs text-primary hover:underline" href={`/api/assets/${l.assetId}/file`} target="_blank" rel="noreferrer">Open original image</a>
            <AssetLicense assetId={l.assetId} projectId={projectId} />
          </>
        )}
      </CardContent>
    </Card>
  );
}

function AssetLicense({ assetId, projectId }: { assetId: string; projectId: string }) {
  const q = useQuery({ queryKey: ['assets', projectId], queryFn: () => api.get<{ id: string; licenseNote: string; source: string }[]>('/assets') });
  const a = q.data?.find((x) => x.id === assetId);
  const [note, setNote] = useState(a?.licenseNote ?? '');
  useEffect(() => setNote(a?.licenseNote ?? ''), [a?.licenseNote]);
  if (!a) return null;
  return (
    <Field label={`License / permission note (${titleCase(a.source)})`} htmlFor="lic">
      <div className="flex gap-2">
        <Input id="lic" value={note} onChange={(e) => setNote(e.target.value)} />
        <Button size="sm" variant="outline" onClick={async () => { await api.patch(`/assets/${a.id}`, { licenseNote: note }); await q.refetch(); toast.success('Saved'); }}>Save</Button>
      </div>
    </Field>
  );
}

function DesignPanel({ editable, projectId }: { editable: boolean; projectId: string }) {
  const { design, commit } = useCover();
  const fileRef = useRef<HTMLInputElement>(null);
  if (!design) return null;
  return (
    <Card>
      <CardHeader className="pb-2"><CardTitle className="text-sm">Design</CardTitle></CardHeader>
      <CardContent className="grid gap-3">
        <Field label="Background" htmlFor="bg"><PaintEditor paint={design.background} disabled={!editable} onChange={(p) => commit((d) => ({ ...d, background: p ?? { type: 'solid', color: '#FFFFFF' } }))} /></Field>
        <Field label="Barcode" htmlFor="bc" hint="Never invent ISBNs or barcodes. With KDP’s barcode, keep the white area clear.">
          <Select id="bc" disabled={!editable} value={design.barcode} onChange={(e) => commit((d) => ({ ...d, barcode: e.target.value as CoverDesign['barcode'] }))}>
            <option value="KDP_BARCODE">KDP adds the barcode — keep area clear</option>
            <option value="OWN_BARCODE">I placed my own barcode image</option>
            <option value="NOT_APPLICABLE">Not applicable (e.g. eBook)</option>
          </Select>
        </Field>
        <Field label="Official template guide (PNG)" htmlFor="tg" hint="Shown as a non-printing overlay to check geometry.">
          <div className="flex gap-2">
            <Button size="sm" variant="outline" disabled={!editable} onClick={() => fileRef.current?.click()}><Upload /> Upload guide</Button>
            {design.templateGuide && <Button size="sm" variant="ghost" onClick={() => commit((d) => ({ ...d, templateGuide: null }))}>Remove</Button>}
          </div>
          <input ref={fileRef} type="file" accept="image/png,image/jpeg" className="hidden" onChange={async (e) => {
            const f = e.target.files?.[0];
            if (!f) return;
            const fd = new FormData();
            fd.append('file', f);
            fd.append('projectId', projectId);
            fd.append('kind', 'TEMPLATE');
            fd.append('licenseNote', 'Official KDP cover template (guide only, not printed)');
            try {
              const a = await api.upload<{ id: string }>('/assets', fd);
              commit((d) => ({ ...d, templateGuide: { assetId: a.id, opacity: 0.5 } }));
            } catch (err) {
              toast.error((err as Error).message);
            }
          }} />
        </Field>
        <p className="text-xs text-muted-foreground">Select a layer on the canvas or in the list to edit it. Title, subtitle, author, and spine text are always live text — never baked into images.</p>
      </CardContent>
    </Card>
  );
}

function OfficialTemplateDialog({ project, geometry }: { project: ProjectDetail; geometry: CoverGeometry }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [vals, setVals] = useState({ fullWidthIn: '', fullHeightIn: '', spineWidthIn: '', wrapIn: '', hingeIn: '' });
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true);
    try {
      let assetId: string | undefined;
      if (file) {
        const fd = new FormData();
        fd.append('file', file);
        fd.append('projectId', project.id);
        fd.append('kind', 'TEMPLATE');
        assetId = (await api.upload<{ id: string }>('/assets', fd)).id;
      }
      const n = (s: string) => (s ? Number(s) : undefined);
      await api.post(`/projects/${project.id}/official-template`, { assetId, fullWidthIn: n(vals.fullWidthIn), fullHeightIn: n(vals.fullHeightIn), spineWidthIn: Number(vals.spineWidthIn), wrapIn: n(vals.wrapIn), hingeIn: n(vals.hingeIn), pageCount: geometry.pageCount });
      await qc.invalidateQueries({ queryKey: ['covers', project.id] });
      await qc.invalidateQueries({ queryKey: ['project', project.id] });
      toast.success('Official geometry recorded');
      setOpen(false);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  if (geometry.format === 'EBOOK') return null;
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild><Button size="sm" variant="outline"><Shapes /> Official template</Button></DialogTrigger>
      <DialogContent title="Official KDP cover geometry" description={`Generate the template on KDP’s cover calculator for exactly ${geometry.pageCount} pages, then upload the template PDF (dimensions are read from it) or type the values. ${geometry.format === 'HARDCOVER' ? 'Hardcover geometry is required and never derived from paperback formulas.' : 'Official values take precedence over the formula.'}`}>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Template PDF (optional)" htmlFor="tpdf" className="sm:col-span-2"><Input id="tpdf" type="file" accept="application/pdf" onChange={(e) => setFile(e.target.files?.[0] ?? null)} /></Field>
          {!file && <Field label="Full width (in)" htmlFor="fw"><Input id="fw" type="number" step="0.001" value={vals.fullWidthIn} onChange={(e) => setVals({ ...vals, fullWidthIn: e.target.value })} /></Field>}
          {!file && <Field label="Full height (in)" htmlFor="fh"><Input id="fh" type="number" step="0.001" value={vals.fullHeightIn} onChange={(e) => setVals({ ...vals, fullHeightIn: e.target.value })} /></Field>}
          <Field label="Spine width (in)" htmlFor="sw"><Input id="sw" type="number" step="0.001" value={vals.spineWidthIn} onChange={(e) => setVals({ ...vals, spineWidthIn: e.target.value })} /></Field>
          {geometry.format === 'HARDCOVER' && <Field label="Wrap (in)" htmlFor="wr"><Input id="wr" type="number" step="0.001" value={vals.wrapIn} onChange={(e) => setVals({ ...vals, wrapIn: e.target.value })} /></Field>}
          {geometry.format === 'HARDCOVER' && <Field label="Hinge (in)" htmlFor="hi"><Input id="hi" type="number" step="0.001" value={vals.hingeIn} onChange={(e) => setVals({ ...vals, hingeIn: e.target.value })} /></Field>}
        </div>
        <Button onClick={submit} loading={busy} disabled={!vals.spineWidthIn || (!file && (!vals.fullWidthIn || !vals.fullHeightIn))}>Save official geometry</Button>
      </DialogContent>
    </Dialog>
  );
}

function NewCoverDialog({ project, themes, onCreated }: { project: ProjectDetail; themes: { id: string; name: string }[]; onCreated: (id: string) => void }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [theme, setTheme] = useState(themes[0]?.id ?? 'midnight');
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild><Button size="sm" variant="outline">New design</Button></DialogTrigger>
      <DialogContent title="New starter design" description="Creates editable text layers from your metadata on a themed background.">
        <Field label="Theme" htmlFor="th"><Select id="th" value={theme} onChange={(e) => setTheme(e.target.value)}>{themes.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</Select></Field>
        <Button onClick={async () => { try { const c = await api.post<CoverRow>(`/projects/${project.id}/covers`, { themeId: theme, name: `Design (${theme})` }); await qc.invalidateQueries({ queryKey: ['covers', project.id] }); onCreated(c.id); setOpen(false); } catch (e) { toast.error((e as Error).message); } }}>Create</Button>
      </DialogContent>
    </Dialog>
  );
}

function NewCoverCard({ project, geometry, themes, editable }: { project: ProjectDetail; geometry: CoverGeometry; themes: { id: string; name: string }[]; editable: boolean }) {
  const qc = useQueryClient();
  const [theme, setTheme] = useState(themes[0]?.id ?? 'midnight');
  return (
    <div className="grid gap-4">
      {geometry.source === 'UNRESOLVED' && (
        <div className="flex flex-wrap items-center gap-3 rounded-md border border-warning/40 bg-warning/5 p-3 text-sm">
          <span>Hardcover covers need the official KDP calculator values for {geometry.pageCount} pages.</span>
          {editable && <OfficialTemplateDialog project={project} geometry={geometry} />}
        </div>
      )}
      <EmptyState
        icon={<Shapes />}
        title="No cover design yet"
        description="Start from a themed design with live, editable text (title, subtitle, author, spine), or generate cover art with AI from the Generate menu."
        action={
          editable && geometry.source !== 'UNRESOLVED' ? (
            <div className="flex gap-2">
              <Select aria-label="Theme" value={theme} onChange={(e) => setTheme(e.target.value)} className="w-40">{themes.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</Select>
              <Button onClick={async () => { try { await api.post(`/projects/${project.id}/covers`, { themeId: theme }); await qc.invalidateQueries({ queryKey: ['covers', project.id] }); } catch (e) { toast.error((e as Error).message); } }}>Create starter cover</Button>
            </div>
          ) : undefined
        }
      />
    </div>
  );
}
