import { useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { Card, CardContent, CardDescription, CardHeader, CardTitle, ErrorBox, Field, Input, PageHeader, Select, Skeleton, Textarea } from '@/components/ui/basic';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/overlay';
import { StyleControls } from '@/features/coloring-style';
import type { Presets, StyleProfile } from '@/features/coloring-types';
import { ModelSelect, useModels } from '@/features/image-models';
import { api } from '@/lib/api';

const STEPS = ['Concept', 'Art direction', 'Format & budget'] as const;

export default function ColoringNew() {
  const nav = useNavigate();
  const presets = useQuery({ queryKey: ['coloring-presets'], queryFn: () => api.get<Presets>('/coloring/presets') });
  const saved = useQuery({ queryKey: ['coloring-styles'], queryFn: () => api.get<{ id: string; name: string; profile: StyleProfile }[]>('/coloring-styles') });
  const models = useModels({});
  const [step, setStep] = useState(0);
  const [busy, setBusy] = useState(false);
  const [f, setF] = useState({ title: '', subtitle: '', author: '', audience: 'KIDS', theme: 'farm', description: '', language: 'English', ageRange: '', difficulty: '', illustrationTarget: 30, seriesName: '', seriesNumber: '', trimId: '8.5x11', budgetCapUsd: '', modelId: '' as string, planFromTheme: true, concepts: '' });
  const [style, setStyle] = useState<StyleProfile | null>(null);
  const [saveStyleAs, setSaveStyleAs] = useState('');
  const [singleSided, setSingleSided] = useState(true);
  const aud = presets.data?.audiences.find((a) => a.id === f.audience);
  useEffect(() => {
    if (aud) setStyle((s) => ({ ...aud.style, extraDirection: s?.extraDirection ?? '', referenceAssetIds: s?.referenceAssetIds ?? [] }));
  }, [aud?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const concepts = useMemo(() => f.concepts.split('\n').map((s) => s.trim()).filter((s) => s.length > 1), [f.concepts]);
  const step0ok = f.title.trim() && f.author.trim() && f.illustrationTarget > 0;

  if (presets.isLoading) return <Skeleton className="h-96" />;
  if (presets.error) return <ErrorBox error={presets.error} />;
  const p = presets.data!;

  const submit = async () => {
    setBusy(true);
    try {
      if (saveStyleAs.trim() && style) await api.post('/coloring-styles', { name: saveStyleAs.trim(), profile: style });
      const b = await api.post<{ id: string }>('/coloring', {
        title: f.title,
        subtitle: f.subtitle,
        author: f.author,
        audience: f.audience,
        theme: f.theme,
        description: f.description,
        language: f.language,
        ageRange: f.ageRange || undefined,
        difficulty: f.difficulty || undefined,
        illustrationTarget: Number(f.illustrationTarget),
        seriesName: f.seriesName,
        seriesNumber: f.seriesNumber ? Number(f.seriesNumber) : null,
        trimId: f.trimId,
        interior: { singleSided },
        style: style ?? undefined,
        modelId: f.modelId || null,
        budgetCapUsd: f.budgetCapUsd ? Number(f.budgetCapUsd) : null,
        concepts: concepts.length ? concepts : undefined,
      });
      if (f.planFromTheme && f.theme && concepts.length < Number(f.illustrationTarget)) await api.post(`/coloring/${b.id}/pages`, { fromTheme: { theme: f.theme, count: Number(f.illustrationTarget) - concepts.length } });
      toast.success('Coloring book created. Review the page plan next.');
      nav(`/coloring/${b.id}`);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <PageHeader title="New coloring book" description="Nothing is generated until you review the page plan and confirm the estimated cost." />
      <ol className="mb-4 flex gap-2 text-sm" aria-label="Steps">
        {STEPS.map((s, i) => <li key={s} className={i === step ? 'font-semibold text-primary' : 'text-muted-foreground'}>{i + 1}. {s}{i < STEPS.length - 1 ? ' →' : ''}</li>)}
      </ol>
      {step === 0 && (
        <Card>
          <CardHeader><CardTitle>Concept</CardTitle><CardDescription>Audience presets set sensible art-direction defaults you can change in the next step.</CardDescription></CardHeader>
          <CardContent className="grid gap-3 md:grid-cols-2">
            <Field label="Title" htmlFor="c-title"><Input id="c-title" value={f.title} onChange={set('title')} /></Field>
            <Field label="Subtitle" htmlFor="c-sub"><Input id="c-sub" value={f.subtitle} onChange={set('subtitle')} /></Field>
            <Field label="Author / illustrator name" htmlFor="c-auth"><Input id="c-auth" value={f.author} onChange={set('author')} /></Field>
            <Field label="Audience" htmlFor="c-aud"><Select id="c-aud" value={f.audience} onChange={set('audience')}>{p.audiences.map((a) => <option key={a.id} value={a.id}>{a.label} ({a.ageRange})</option>)}</Select></Field>
            <Field label="Theme preset" htmlFor="c-theme" hint="Used to suggest page concepts; you can edit every concept."><Select id="c-theme" value={f.theme} onChange={set('theme')}><option value="">Custom (enter concepts below)</option>{p.themes.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}</Select></Field>
            <Field label="Language" htmlFor="c-lang"><Input id="c-lang" value={f.language} onChange={set('language')} /></Field>
            <Field label="Age range" htmlFor="c-age" hint={aud ? `Preset: ${aud.ageRange}` : undefined}><Input id="c-age" value={f.ageRange} onChange={set('ageRange')} placeholder={aud?.ageRange} /></Field>
            <Field label="Difficulty" htmlFor="c-diff"><Select id="c-diff" value={f.difficulty} onChange={set('difficulty')}><option value="">Preset ({aud?.difficulty})</option><option value="EASY">Easy</option><option value="MEDIUM">Medium</option><option value="HARD">Hard</option></Select></Field>
            <Field label="Number of illustrations" htmlFor="c-n" hint={singleSided ? 'Single-sided: the interior will have about twice as many pages (blank reverses).' : undefined}><Input id="c-n" type="number" min={1} max={300} value={f.illustrationTarget} onChange={(e) => setF({ ...f, illustrationTarget: Number(e.target.value) || 1 })} /></Field>
            <div className="grid grid-cols-[1fr_100px] gap-2">
              <Field label="Series (optional)" htmlFor="c-series"><Input id="c-series" value={f.seriesName} onChange={set('seriesName')} /></Field>
              <Field label="No." htmlFor="c-sno"><Input id="c-sno" type="number" min={1} value={f.seriesNumber} onChange={set('seriesNumber')} /></Field>
            </div>
            <Field label="Description" htmlFor="c-desc" className="md:col-span-2"><Textarea id="c-desc" rows={3} value={f.description} onChange={set('description')} placeholder="What makes this book useful and different for its readers?" /></Field>
            <Field label="Page concepts (one per line, optional)" htmlFor="c-concepts" className="md:col-span-2" hint={`${concepts.length} concept(s). Remaining pages come from the theme preset if enabled.`}><Textarea id="c-concepts" rows={4} value={f.concepts} onChange={set('concepts')} /></Field>
            <label className="flex items-center gap-2 text-sm md:col-span-2"><Switch checked={f.planFromTheme} onCheckedChange={(v) => setF({ ...f, planFromTheme: v })} /> Fill the rest of the plan from the theme preset</label>
          </CardContent>
        </Card>
      )}
      {step === 1 && style && (
        <Card>
          <CardHeader><CardTitle>Art direction</CardTitle><CardDescription>Saved as this book’s style profile; every prompt is built from it deterministically.</CardDescription></CardHeader>
          <CardContent className="grid gap-4">
            {saved.data && saved.data.length > 0 && (
              <Field label="Start from a saved style profile" htmlFor="c-saved"><Select id="c-saved" value="" onChange={(e) => { const s = saved.data!.find((x) => x.id === e.target.value); if (s) setStyle(s.profile); }}><option value="">—</option>{saved.data.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</Select></Field>
            )}
            <StyleControls style={style} styles={p.styles} onChange={setStyle} />
            <Field label="Save as reusable profile (optional)" htmlFor="c-saveas"><Input id="c-saveas" value={saveStyleAs} onChange={(e) => setSaveStyleAs(e.target.value)} placeholder="e.g. Preschool bold animals" /></Field>
          </CardContent>
        </Card>
      )}
      {step === 2 && (
        <Card>
          <CardHeader><CardTitle>Format & budget</CardTitle></CardHeader>
          <CardContent className="grid gap-3 md:grid-cols-2">
            <Field label="Trim size" htmlFor="c-trim"><Select id="c-trim" value={f.trimId} onChange={set('trimId')}>{p.trims.map((t) => <option key={t.id} value={t.id}>{t.label}{t.verification === 'UNVERIFIED' ? ' (spec unverified)' : ''}</option>)}</Select></Field>
            <label className="flex items-center gap-2 self-end text-sm"><Switch checked={singleSided} onCheckedChange={setSingleSided} /> Single-sided pages (blank reverse after each illustration)</label>
            <Field label="Default image model" hint="You can change it per batch. Only verified models are listed.">
              <ModelSelect value={f.modelId || null} onChange={(id) => setF({ ...f, modelId: id })} models={models.data?.models ?? []} />
            </Field>
            <Field label="Budget cap for this book (USD, optional)" htmlFor="c-budget" hint="Generation stops before a page would exceed it."><Input id="c-budget" type="number" min={0} step="0.01" value={f.budgetCapUsd} onChange={set('budgetCapUsd')} /></Field>
          </CardContent>
        </Card>
      )}
      <div className="mt-4 flex gap-2">
        {step > 0 && <Button key="back" variant="outline" onClick={() => setStep(step - 1)}>Back</Button>}
        {step < STEPS.length - 1 ? <Button key="next" disabled={!step0ok} onClick={() => setStep(step + 1)}>Next</Button> : <Button key="create" onClick={submit} loading={busy} disabled={!step0ok}>Create book & page plan</Button>}
      </div>
    </>
  );
}
