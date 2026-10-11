import { zodResolver } from '@hookform/resolvers/zod';
import { defaultSpecSource, resolvePrintSpec, spineWidthFor, COVER_THEMES } from '@kdp/core/browser';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, ChevronLeft, ChevronRight, Save } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useForm, type FieldPath } from 'react-hook-form';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { z } from 'zod';
import { Badge, Card, CardContent, CardDescription, CardHeader, CardTitle, ErrorBox, Field, Input, PageHeader, Select, Textarea } from '@/components/ui/basic';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/overlay';
import { api } from '@/lib/api';
import { cn, titleCase } from '@/lib/utils';

const CATEGORIES = ['BLANK_LINED_JOURNAL', 'GUIDED_JOURNAL', 'NOTEBOOK', 'PLANNER', 'LOGBOOK', 'TRACKER', 'WORKBOOK', 'ACTIVITY_BOOK', 'EDUCATIONAL', 'NONFICTION', 'ILLUSTRATED'] as const;
const CONTENT_TYPES = ['BLANK', 'LINED', 'DOT_GRID', 'STRUCTURED_FORMS', 'PLANNER', 'LOGBOOK', 'WORKBOOK', 'LONG_FORM', 'ILLUSTRATED'] as const;
const DEFAULT_CLASS: Record<string, 'LOW' | 'MEDIUM' | 'FULL'> = { BLANK_LINED_JOURNAL: 'LOW', NOTEBOOK: 'LOW', LOGBOOK: 'LOW', TRACKER: 'LOW', PLANNER: 'LOW', GUIDED_JOURNAL: 'MEDIUM', WORKBOOK: 'MEDIUM', ACTIVITY_BOOK: 'MEDIUM', EDUCATIONAL: 'FULL', NONFICTION: 'FULL', ILLUSTRATED: 'MEDIUM' };
const SUGGESTED_TYPE: Record<string, (typeof CONTENT_TYPES)[number]> = { BLANK_LINED_JOURNAL: 'LINED', GUIDED_JOURNAL: 'LINED', NOTEBOOK: 'DOT_GRID', PLANNER: 'PLANNER', LOGBOOK: 'LOGBOOK', TRACKER: 'STRUCTURED_FORMS', WORKBOOK: 'WORKBOOK', ACTIVITY_BOOK: 'WORKBOOK', EDUCATIONAL: 'LONG_FORM', NONFICTION: 'LONG_FORM', ILLUSTRATED: 'ILLUSTRATED' };
const GEN_KEYS = [
  ['outline', 'Generate outline'],
  ['content', 'Generate original content'],
  ['interior', 'Generate interior layout'],
  ['coverConcept', 'Generate cover concept'],
  ['titleSuggestions', 'Title & subtitle suggestions'],
  ['metadata', 'Description & keyword candidates'],
  ['similarity', 'Run similarity checks'],
  ['validate', 'Validate the finished product'],
] as const;

const Schema = z
  .object({
    workingTitle: z.string().trim().min(1, 'Required').max(200),
    category: z.enum(CATEGORIES),
    targetReader: z.string().trim().min(3, 'Describe the reader').max(500),
    readerProblem: z.string().trim().min(3, 'What problem or use does it serve?').max(1000),
    niche: z.string().trim().min(2, 'Required').max(200),
    differentiation: z.string().trim().min(20, 'At least 20 characters: what makes this product genuinely different?').max(2000),
    language: z.string().min(1),
    marketplace: z.string().min(1),
    authorName: z.string().trim().min(1, 'Required').max(200),
    contentStyle: z.string().max(300),
    designTheme: z.string(),
    format: z.enum(['PAPERBACK', 'HARDCOVER', 'EBOOK']),
    trimId: z.string(),
    pageMode: z.enum(['fixed', 'content']),
    targetPageCount: z.coerce.number().int().min(1).max(900),
    bleed: z.boolean(),
    ink: z.enum(['BLACK_WHITE', 'STANDARD_COLOR', 'PREMIUM_COLOR']),
    paper: z.enum(['WHITE', 'CREAM']),
    coverFinish: z.enum(['GLOSSY', 'MATTE']),
    direction: z.enum(['LTR', 'RTL']),
    contentType: z.enum(CONTENT_TYPES),
    contentClass: z.enum(['LOW', 'MEDIUM', 'FULL']),
    generation: z.object(Object.fromEntries(GEN_KEYS.map(([k]) => [k, z.boolean()])) as Record<(typeof GEN_KEYS)[number][0], z.ZodBoolean>),
    startGeneration: z.boolean(),
  })
  .refine((v) => !(v.paper === 'CREAM' && v.ink !== 'BLACK_WHITE'), { path: ['paper'], message: 'Cream paper is only available with black & white ink' });
type Values = z.infer<typeof Schema>;

const STEPS: { title: string; fields: FieldPath<Values>[] }[] = [
  { title: 'Product concept', fields: ['workingTitle', 'category', 'targetReader', 'readerProblem', 'niche', 'differentiation', 'language', 'marketplace', 'authorName', 'contentStyle', 'designTheme'] },
  { title: 'Book format', fields: ['format', 'trimId', 'targetPageCount', 'bleed', 'ink', 'paper', 'coverFinish', 'direction'] },
  { title: 'Content type', fields: ['contentType', 'contentClass'] },
  { title: 'Generation settings', fields: ['generation', 'startGeneration'] },
];

const DEFAULTS: Values = {
  workingTitle: '',
  category: 'GUIDED_JOURNAL',
  targetReader: '',
  readerProblem: '',
  niche: '',
  differentiation: '',
  language: 'English',
  marketplace: 'Amazon.com',
  authorName: '',
  contentStyle: '',
  designTheme: 'midnight',
  format: 'PAPERBACK',
  trimId: '6x9',
  pageMode: 'fixed',
  targetPageCount: 100,
  bleed: false,
  ink: 'BLACK_WHITE',
  paper: 'WHITE',
  coverFinish: 'MATTE',
  direction: 'LTR',
  contentType: 'LINED',
  contentClass: 'MEDIUM',
  generation: { outline: true, content: true, interior: true, coverConcept: true, titleSuggestions: true, metadata: true, similarity: true, validate: true },
  startGeneration: true,
};

export default function Wizard() {
  const [step, setStep] = useState(0);
  const [error, setError] = useState<unknown>(null);
  const nav = useNavigate();
  const qc = useQueryClient();
  const presets = useQuery({ queryKey: ['presets'], queryFn: () => api.get<{ id: string; name: string; data: Partial<Values> }[]>('/presets') });
  const form = useForm<Values>({ resolver: zodResolver(Schema), defaultValues: DEFAULTS, mode: 'onTouched' });
  const { register, watch, setValue, formState, trigger, handleSubmit, reset } = form;
  const v = watch();
  const lib = defaultSpecSource.getLibrary();
  const trims = lib.trimSizes.filter((t) => v.format !== 'EBOOK' && t.formats.includes(v.format as 'PAPERBACK' | 'HARDCOVER'));

  const spec = useMemo(() => {
    if (v.format === 'EBOOK') return null;
    try {
      const s = resolvePrintSpec({ format: v.format, trimId: v.trimId, pageCount: Number(v.targetPageCount) || 24, ink: v.ink, paper: v.paper, bleed: v.bleed });
      const spine = spineWidthFor(v.ink, v.paper, Number(v.targetPageCount) || 24);
      return { s, spine };
    } catch {
      return null;
    }
  }, [v.format, v.trimId, v.targetPageCount, v.ink, v.paper, v.bleed]);

  const next = async () => {
    if (await trigger(STEPS[step].fields)) setStep((s) => s + 1);
  };

  const onSubmit = handleSubmit(async (values) => {
    if (step !== STEPS.length - 1) return;
    setError(null);
    try {
      const p = await api.post<{ id: string }>('/projects', {
        brief: { workingTitle: values.workingTitle, category: values.category, targetReader: values.targetReader, readerProblem: values.readerProblem, niche: values.niche, differentiation: values.differentiation, language: values.language, marketplace: values.marketplace, authorName: values.authorName, contentStyle: values.contentStyle, designTheme: values.designTheme, contentType: values.contentType, contentClass: values.contentClass },
        format: { format: values.format, trimId: values.trimId, ink: values.ink, paper: values.paper, bleed: values.bleed, coverFinish: values.coverFinish, direction: values.direction, targetPageCount: values.pageMode === 'fixed' ? values.targetPageCount : null },
        generation: values.generation,
      });
      if (values.startGeneration && Object.values(values.generation).some(Boolean)) {
        try {
          await api.post(`/projects/${p.id}/generate`, { settings: values.generation });
          toast.success('Project created — generation started in the background.');
        } catch (e) {
          toast.error(`Project created, but generation could not start: ${(e as Error).message}`);
        }
      } else toast.success('Project created.');
      await qc.invalidateQueries({ queryKey: ['projects'] });
      nav(`/projects/${p.id}`);
    } catch (e) {
      setError(e);
    }
  });

  const savePreset = async () => {
    const name = prompt('Preset name');
    if (!name) return;
    const { workingTitle: _w, ...data } = form.getValues();
    await api.post('/presets', { name, data });
    await presets.refetch();
    toast.success('Preset saved');
  };

  const err = (k: FieldPath<Values>) => (formState.errors as Record<string, { message?: string }>)[k]?.message;

  return (
    <>
      <PageHeader
        title="Create a new product"
        description="Describe a specific reader and a real difference. The app does not mass-produce near-identical books."
        actions={
          <>
            {presets.data && presets.data.length > 0 && (
              <Select aria-label="Load preset" className="w-48" defaultValue="" onChange={(e) => { const p = presets.data!.find((x) => x.id === e.target.value); if (p) reset({ ...DEFAULTS, ...p.data, workingTitle: form.getValues('workingTitle') }); }}>
                <option value="" disabled>Load preset…</option>
                {presets.data.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </Select>
            )}
            <Button variant="outline" onClick={savePreset}><Save /> Save as preset</Button>
          </>
        }
      />
      <ol className="mb-6 flex flex-wrap gap-2" aria-label="Wizard steps">
        {STEPS.map((s, i) => (
          <li key={s.title}>
            <button type="button" onClick={() => i < step && setStep(i)} className={cn('flex items-center gap-2 rounded-full border px-3 py-1.5 text-sm', i === step ? 'border-primary bg-primary/10 font-medium text-primary' : i < step ? 'text-foreground' : 'text-muted-foreground')} aria-current={i === step ? 'step' : undefined}>
              <span className={cn('flex size-5 items-center justify-center rounded-full text-xs', i < step ? 'bg-success text-white' : 'bg-muted')}>{i < step ? <Check className="size-3" /> : i + 1}</span>
              {s.title}
            </button>
          </li>
        ))}
      </ol>
      <form onSubmit={onSubmit} onKeyDown={(e) => { if (e.key === 'Enter' && step < STEPS.length - 1 && (e.target as HTMLElement).tagName === 'INPUT') { e.preventDefault(); void next(); } }} noValidate className="grid gap-6 xl:grid-cols-3">
        <Card className="xl:col-span-2">
          <CardHeader>
            <CardTitle>{STEPS[step].title}</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-4 sm:grid-cols-2">
            {step === 0 && (
              <>
                <Field label="Working title" htmlFor="wt" error={err('workingTitle')} className="sm:col-span-2"><Input id="wt" {...register('workingTitle')} aria-invalid={!!err('workingTitle')} /></Field>
                <Field label="Product category" htmlFor="cat">
                  <Select id="cat" {...register('category', { onChange: (e) => { setValue('contentClass', DEFAULT_CLASS[e.target.value]); setValue('contentType', SUGGESTED_TYPE[e.target.value]); } })}>
                    {CATEGORIES.map((c) => <option key={c} value={c}>{titleCase(c)}</option>)}
                  </Select>
                </Field>
                <Field label="Niche" htmlFor="niche" error={err('niche')}><Input id="niche" placeholder="e.g. first-year nursing reflection" {...register('niche')} /></Field>
                <Field label="Target reader" htmlFor="tr" error={err('targetReader')} className="sm:col-span-2"><Input id="tr" placeholder="Who exactly is this for?" {...register('targetReader')} /></Field>
                <Field label="Reader problem or intended use" htmlFor="rp" error={err('readerProblem')} className="sm:col-span-2"><Textarea id="rp" rows={2} {...register('readerProblem')} /></Field>
                <Field label="Differentiation statement" htmlFor="diff" error={err('differentiation')} hint="Required. Explain the structure or content that makes it more useful than existing books — not just a new title or colour." className="sm:col-span-2"><Textarea id="diff" rows={3} {...register('differentiation')} /></Field>
                <Field label="Author or imprint name" htmlFor="author" error={err('authorName')}><Input id="author" {...register('authorName')} /></Field>
                <Field label="Content style" htmlFor="style" hint="Tone, reading level, voice."><Input id="style" {...register('contentStyle')} /></Field>
                <Field label="Language" htmlFor="lang"><Select id="lang" {...register('language')}>{['English', 'Spanish', 'French', 'German', 'Italian', 'Portuguese', 'Dutch', 'Japanese', 'Arabic', 'Hebrew'].map((l) => <option key={l}>{l}</option>)}</Select></Field>
                <Field label="Marketplace" htmlFor="mk"><Select id="mk" {...register('marketplace')}>{['Amazon.com', 'Amazon.co.uk', 'Amazon.de', 'Amazon.fr', 'Amazon.es', 'Amazon.it', 'Amazon.co.jp', 'Amazon.ca', 'Amazon.com.au'].map((m) => <option key={m}>{m}</option>)}</Select></Field>
                <Field label="Design theme" htmlFor="theme"><Select id="theme" {...register('designTheme')}>{COVER_THEMES.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</Select></Field>
              </>
            )}
            {step === 1 && (
              <>
                <Field label="Format" htmlFor="fmt">
                  <Select id="fmt" {...register('format', { onChange: (e) => { if (e.target.value === 'HARDCOVER' && !['5.5x8.5', '6x9', '6.14x9.21', '7x10', '8.25x11'].includes(v.trimId)) setValue('trimId', '6x9'); } })}>
                    <option value="PAPERBACK">Paperback</option>
                    <option value="HARDCOVER">Hardcover (case laminate)</option>
                    <option value="EBOOK">Kindle eBook (reflowable)</option>
                  </Select>
                </Field>
                {v.format !== 'EBOOK' ? (
                  <>
                    <Field label="Trim size" htmlFor="trim" hint="Landscape trims (e.g. 8.25 × 6) set the orientation.">
                      <Select id="trim" {...register('trimId')}>{trims.map((t) => <option key={t.id} value={t.id}>{t.label}{t.verification.status === 'UNVERIFIED' ? ' (verify availability)' : ''}</option>)}</Select>
                    </Field>
                    <Field label="Pagination" htmlFor="pm">
                      <Select id="pm" {...register('pageMode')}><option value="fixed">Target page count</option><option value="content">Content-driven</option></Select>
                    </Field>
                    {v.pageMode === 'fixed' && <Field label="Target page count" htmlFor="pc" error={err('targetPageCount')}><Input id="pc" type="number" min={1} max={900} {...register('targetPageCount')} /></Field>}
                    <Field label="Interior ink" htmlFor="ink"><Select id="ink" {...register('ink')}><option value="BLACK_WHITE">Black & white</option><option value="STANDARD_COLOR">Standard color</option><option value="PREMIUM_COLOR">Premium color</option></Select></Field>
                    <Field label="Paper" htmlFor="paper" error={err('paper')}><Select id="paper" {...register('paper')}><option value="WHITE">White</option><option value="CREAM">Cream</option></Select></Field>
                    <Field label="Cover finish" htmlFor="finish"><Select id="finish" {...register('coverFinish')}><option value="MATTE">Matte</option><option value="GLOSSY">Glossy</option></Select></Field>
                    <Field label="Reading direction" htmlFor="dir"><Select id="dir" {...register('direction')}><option value="LTR">Left to right</option><option value="RTL">Right to left</option></Select></Field>
                    <div className="flex items-center gap-3 sm:col-span-2">
                      <Switch id="bleed" checked={v.bleed} onCheckedChange={(c) => setValue('bleed', c)} />
                      <label htmlFor="bleed" className="text-sm">Bleed (artwork runs to the page edge — raises outside margins to 0.375")</label>
                    </div>
                  </>
                ) : (
                  <p className="text-sm text-muted-foreground sm:col-span-2">Kindle eBooks are reflowable: the EPUB adapts to the reader’s screen, so print trim sizes, margins, and page counts do not apply. The eBook cover is exported at 1600 × 2560 px.</p>
                )}
              </>
            )}
            {step === 2 && (
              <>
                <Field label="Content type" htmlFor="ct" hint="Determines the starter interior and the generation workflow.">
                  <Select id="ct" {...register('contentType')}>{CONTENT_TYPES.map((c) => <option key={c} value={c}>{titleCase(c)}</option>)}</Select>
                </Field>
                <Field label="Content class" htmlFor="cc" hint="Drives which validation rules apply (e.g. low-content limitations).">
                  <Select id="cc" {...register('contentClass')}><option value="LOW">Low-content (journals, logbooks, notebooks)</option><option value="MEDIUM">Medium-content (guided, workbooks, planners with guidance)</option><option value="FULL">Full-content (prose, educational, illustrated story)</option></Select>
                </Field>
                {v.format === 'EBOOK' && v.contentClass === 'LOW' && <p className="rounded-md border border-warning/40 bg-warning/5 p-2 text-sm text-warning sm:col-span-2">Low-content products are not suitable as reflowable eBooks — readers cannot write in them. Preflight will flag this.</p>}
              </>
            )}
            {step === 3 && (
              <>
                {GEN_KEYS.map(([k, label]) => (
                  <div key={k} className="flex items-center gap-3">
                    <Switch id={`g-${k}`} checked={v.generation[k]} onCheckedChange={(c) => setValue(`generation.${k}`, c)} />
                    <label htmlFor={`g-${k}`} className="text-sm">{label}</label>
                  </div>
                ))}
                <div className="flex items-center gap-3 border-t pt-4 sm:col-span-2">
                  <Switch id="start" checked={v.startGeneration} onCheckedChange={(c) => setValue('startGeneration', c)} />
                  <label htmlFor="start" className="text-sm font-medium">Start generation right after creating the project</label>
                </div>
                <p className="text-xs text-muted-foreground sm:col-span-2">Generation runs as a background job. AI output is a draft: you review and edit everything, and AI usage is recorded for KDP's disclosure questions.</p>
              </>
            )}
          </CardContent>
          <div className="flex items-center justify-between border-t p-4">
            <Button type="button" variant="ghost" onClick={() => setStep((s) => Math.max(0, s - 1))} disabled={step === 0}><ChevronLeft /> Back</Button>
            {step < STEPS.length - 1 ? (
              // Distinct keys: React must not reuse the "Next" <button> as the submit button, or the
              // click that advances to the last step would also submit the form.
              <Button key="next" type="button" onClick={next}>Next <ChevronRight /></Button>
            ) : (
              <Button key="submit" type="submit" loading={formState.isSubmitting}>Create project</Button>
            )}
          </div>
          <div className="px-4 pb-4"><ErrorBox error={error} title="Could not create the project" /></div>
        </Card>
        <Card className="h-fit">
          <CardHeader>
            <CardTitle>Specification preview</CardTitle>
            <CardDescription>From spec library {lib.version}. Final values are recomputed from the real page count.</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-2 text-sm">
            {v.format === 'EBOOK' ? (
              <p>Reflowable EPUB · cover {lib.ebook.coverIdealWidthPx} × {lib.ebook.coverIdealHeightPx} px</p>
            ) : spec ? (
              <>
                <Row k="Page size" v={`${spec.s.pageWidthIn}" × ${spec.s.pageHeightIn}"`} />
                <Row k="Minimum gutter" v={`${spec.s.minMargins.insideIn}"`} />
                <Row k="Minimum outside margins" v={`${spec.s.minMargins.outsideIn}"`} />
                <Row k="Page-count range" v={spec.s.pageCountLimit ? `${spec.s.pageCountLimit.minPages}–${spec.s.pageCountLimit.maxPages}` : 'unknown'} />
                {v.format === 'PAPERBACK' && spec.spine && <Row k="Estimated spine" v={`${spec.spine.widthIn}"`} />}
                {v.format === 'HARDCOVER' && <p className="text-xs text-muted-foreground">Hardcover cover geometry comes from KDP’s official cover calculator; you’ll enter it once the page count is final.</p>}
                {spec.s.issues.map((i) => (
                  <p key={i.code} className={cn('rounded-md p-2 text-xs', i.severity === 'FAIL' ? 'bg-destructive/10 text-destructive' : 'bg-review/10 text-review')}>{i.message}</p>
                ))}
                <div className="flex flex-wrap gap-1 pt-1">
                  {[...new Set(spec.s.verifications.map((x) => x.status))].map((s) => <Badge key={s} tone={s === 'UNVERIFIED' ? 'warning' : 'primary'}>{titleCase(s)}</Badge>)}
                </div>
              </>
            ) : (
              <p className="text-muted-foreground">Select a valid trim size.</p>
            )}
          </CardContent>
        </Card>
      </form>
    </>
  );
}

const Row = ({ k, v }: { k: string; v: string }) => (
  <div className="flex justify-between gap-4">
    <span className="text-muted-foreground">{k}</span>
    <span className="font-medium tabular-nums">{v}</span>
  </div>
);
