import { checkMetadata, MetadataDraft, type KeywordEvidence } from '@kdp/core/browser';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Sparkles, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Badge, Card, CardContent, CardDescription, CardHeader, CardTitle, ErrorBox, Field, Input, Select, Skeleton, Textarea } from '@/components/ui/basic';
import { Button } from '@/components/ui/button';
import { api } from '@/lib/api';
import { canEdit, useAuth } from '@/lib/auth';
import { StatusBadge } from '@/lib/status';
import type { ProjectDetail } from '@/lib/types';
import { useRefreshAfterJobs } from '@/lib/hooks';

interface MetaResponse {
  data: MetadataDraft;
  suggestions: { concept?: { titleIdeas: { title: string; subtitle: string }[]; differentiationAssessment?: { score: number; notes: string }; risks?: string[] }; metadata?: { titles: { title: string; subtitle: string }[]; description: string; keywords: { keyword: string; rationale: string }[]; categories: string[] } } | null;
}

export default function MetadataEditor({ project }: { project: ProjectDetail }) {
  const { role } = useAuth();
  const editable = canEdit(role);
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['metadata', project.id], queryFn: () => api.get<MetaResponse>(`/projects/${project.id}/metadata`) });
  useRefreshAfterJobs(project, [['metadata', project.id]]);
  const [m, setM] = useState<MetadataDraft | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (q.data && !dirty) setM(q.data.data);
  }, [q.data, dirty]);
  // Same deterministic checks as the server, live while typing.
  const findings = useMemo(() => (m ? checkMetadata(MetadataDraft.parse(m)) : []), [m]);
  if (q.isLoading || !m) return <Skeleton className="h-96" />;
  if (q.error) return <ErrorBox error={q.error} />;
  const set = (patch: Partial<MetadataDraft>) => {
    setM({ ...m, ...patch });
    setDirty(true);
  };
  const setKw = (i: number, patch: Partial<KeywordEvidence>) => set({ keywords: m.keywords.map((k, j) => (j === i ? { ...k, ...patch } : k)) });
  const save = async () => {
    setSaving(true);
    try {
      await api.put(`/projects/${project.id}/metadata`, { data: m });
      setDirty(false);
      await qc.invalidateQueries({ queryKey: ['metadata', project.id] });
      await qc.invalidateQueries({ queryKey: ['project', project.id] });
      toast.success('Metadata saved. Nothing is published automatically.');
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  };
  const suggest = async () => {
    try {
      await api.post(`/projects/${project.id}/metadata/suggest`);
      toast.success('Generating suggestions in the background');
      await qc.invalidateQueries({ queryKey: ['project', project.id] });
    } catch (e) {
      toast.error((e as Error).message);
    }
  };
  const fieldFindings = (f: string) => findings.filter((x) => x.field === f);
  const today = new Date().toISOString().slice(0, 10);
  const sug = q.data?.suggestions;

  return (
    <div className="grid gap-6 xl:grid-cols-3">
      <Card className="xl:col-span-2">
        <CardHeader className="flex-row items-start justify-between space-y-0">
          <div>
            <CardTitle>Metadata draft</CardTitle>
            <CardDescription>Everything is editable and saved as a draft — copy it into KDP yourself when ready.</CardDescription>
          </div>
          {editable && (
            <div className="flex gap-2">
              <Button variant="outline" onClick={suggest}><Sparkles /> Suggest with AI</Button>
              <Button onClick={save} loading={saving} disabled={!dirty}>Save</Button>
            </div>
          )}
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2">
          <Field label={`Title (${m.title.length + (m.subtitle ? m.subtitle.length + 2 : 0)}/200 with subtitle)`} htmlFor="t" className="sm:col-span-2"><Input id="t" disabled={!editable} value={m.title} onChange={(e) => set({ title: e.target.value })} /></Field>
          <Findings items={fieldFindings('title')} />
          <Field label="Subtitle" htmlFor="st" className="sm:col-span-2"><Input id="st" disabled={!editable} value={m.subtitle} onChange={(e) => set({ subtitle: e.target.value })} /></Field>
          <Findings items={fieldFindings('subtitle')} />
          <Field label="Author" htmlFor="a"><Input id="a" disabled={!editable} value={m.author} onChange={(e) => set({ author: e.target.value })} /></Field>
          <Field label="Imprint" htmlFor="imp"><Input id="imp" disabled={!editable} value={m.imprint} onChange={(e) => set({ imprint: e.target.value })} /></Field>
          <Field label="Contributors (Name:ROLE, one per line)" htmlFor="contrib" className="sm:col-span-2" hint="Roles: EDITOR, ILLUSTRATOR, TRANSLATOR, FOREWORD, INTRODUCTION, PREFACE, PHOTOGRAPHER">
            <Textarea id="contrib" rows={2} disabled={!editable} value={m.contributors.map((c) => `${c.name}:${c.role}`).join('\n')} onChange={(e) => set({ contributors: e.target.value.split('\n').filter((l) => l.includes(':')).map((l) => ({ name: l.split(':')[0].trim(), role: (l.split(':')[1].trim().toUpperCase() || 'EDITOR') as 'EDITOR' })) })} />
          </Field>
          <Field label={`Description (${m.description.length}/4000)`} htmlFor="d" className="sm:col-span-2" hint="Allowed HTML: b, i, u, em, strong, br, p, ul, ol, li, h4–h6."><Textarea id="d" rows={7} disabled={!editable} value={m.description} onChange={(e) => set({ description: e.target.value })} /></Field>
          <Findings items={fieldFindings('description')} />
          <Field label="Categories (one per line)" htmlFor="cat" className="sm:col-span-2"><Textarea id="cat" rows={2} disabled={!editable} value={m.categories.join('\n')} onChange={(e) => set({ categories: e.target.value.split('\n').filter(Boolean) })} /></Field>
          <Field label="Language" htmlFor="lang"><Input id="lang" disabled={!editable} value={m.language} onChange={(e) => set({ language: e.target.value })} /></Field>
          <Field label="Edition" htmlFor="ed"><Input id="ed" disabled={!editable} value={m.edition} onChange={(e) => set({ edition: e.target.value })} /></Field>
          <Field label="Series name" htmlFor="sn"><Input id="sn" disabled={!editable} value={m.seriesName} onChange={(e) => set({ seriesName: e.target.value })} /></Field>
          <Field label="Series number" htmlFor="snum"><Input id="snum" type="number" disabled={!editable} value={m.seriesNumber ?? ''} onChange={(e) => set({ seriesNumber: e.target.value ? Number(e.target.value) : null })} /></Field>
          <Field label="Reading age (min–max)" htmlFor="ra">
            <div className="flex gap-2">
              <Input id="ra" aria-label="Minimum reading age" type="number" min={0} max={18} disabled={!editable} value={m.readingAgeMin ?? ''} onChange={(e) => set({ readingAgeMin: e.target.value ? Number(e.target.value) : null })} />
              <Input aria-label="Maximum reading age" type="number" min={0} max={18} disabled={!editable} value={m.readingAgeMax ?? ''} onChange={(e) => set({ readingAgeMax: e.target.value ? Number(e.target.value) : null })} />
            </div>
          </Field>
          <Field label="ISBN (only one you own, or leave blank)" htmlFor="isbn" hint="Never invent ISBNs. Low-content books can be published without one."><Input id="isbn" disabled={!editable} value={m.isbn} onChange={(e) => set({ isbn: e.target.value })} /></Field>
          <Findings items={[...fieldFindings('isbn'), ...fieldFindings('series'), ...fieldFindings('readingAge'), ...fieldFindings('author'), ...fieldFindings('categories')]} />
          <label className="flex items-center gap-2 text-sm sm:col-span-2"><input type="checkbox" disabled={!editable} checked={m.lowContent} onChange={(e) => set({ lowContent: e.target.checked })} /> Low-content book</label>
        </CardContent>
      </Card>
      <div className="grid content-start gap-6">
        <Card>
          <CardHeader>
            <CardTitle>Keyword research ({m.keywords.length}/7)</CardTitle>
            <CardDescription>Record where each keyword came from and your evidence. No search volumes are invented, and no private Amazon data is used.</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-3">
            {m.keywords.map((k, i) => (
              <div key={i} className="grid gap-2 rounded-md border p-2">
                <div className="flex gap-2">
                  <Input aria-label="Keyword" disabled={!editable} value={k.keyword} maxLength={50} onChange={(e) => setKw(i, { keyword: e.target.value })} />
                  {editable && <Button size="icon" variant="ghost" aria-label="Remove keyword" onClick={() => set({ keywords: m.keywords.filter((_, j) => j !== i) })}><Trash2 /></Button>}
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <Select aria-label="Source" disabled={!editable} value={k.source} onChange={(e) => setKw(i, { source: e.target.value })}>
                    {[k.source, 'Amazon search autocomplete (manual)', 'Competitor listing review (manual)', 'Reader survey / interviews', 'Category browsing (manual)', 'AI suggestion (unverified)', 'Other'].filter((v, j, arr) => arr.indexOf(v) === j).map((s) => <option key={s}>{s}</option>)}
                  </Select>
                  <Input aria-label="Date recorded" type="date" disabled={!editable} value={k.recordedAt || ''} onChange={(e) => setKw(i, { recordedAt: e.target.value })} />
                </div>
                <Textarea aria-label="Evidence" rows={2} disabled={!editable} placeholder="What did you observe? (e.g. appears in autocomplete for “nurse journal”)" value={k.evidence} onChange={(e) => setKw(i, { evidence: e.target.value })} />
              </div>
            ))}
            {editable && m.keywords.length < 15 && <Button size="sm" variant="outline" onClick={() => set({ keywords: [...m.keywords, { keyword: '', source: 'Amazon search autocomplete (manual)', recordedAt: today, evidence: '' }] })}><Plus /> Add keyword</Button>}
            <Findings items={fieldFindings('keywords')} />
          </CardContent>
        </Card>
        {sug && (
          <Card>
            <CardHeader><CardTitle>AI suggestions</CardTitle><CardDescription>Drafts to consider — apply, then edit.</CardDescription></CardHeader>
            <CardContent className="grid gap-3 text-sm">
              {[...(sug.metadata?.titles ?? []), ...(sug.concept?.titleIdeas ?? [])].slice(0, 6).map((t, i) => (
                <div key={i} className="flex items-start justify-between gap-2">
                  <span><strong>{t.title}</strong>{t.subtitle && <> — {t.subtitle}</>}</span>
                  {editable && <Button size="sm" variant="ghost" onClick={() => set({ title: t.title, subtitle: t.subtitle })}>Use</Button>}
                </div>
              ))}
              {sug.metadata?.description && editable && <Button size="sm" variant="outline" onClick={() => set({ description: sug.metadata!.description })}>Use suggested description</Button>}
              {sug.concept?.differentiationAssessment && <p className="text-xs text-muted-foreground">Differentiation score {sug.concept.differentiationAssessment.score}/10: {sug.concept.differentiationAssessment.notes}</p>}
              {sug.concept?.risks?.map((r, i) => <p key={i} className="text-xs text-warning">Risk: {r}</p>)}
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}

function Findings({ items }: { items: { status: string; message: string; evidence: string }[] }) {
  if (!items.length) return null;
  return (
    <ul className="grid gap-1 sm:col-span-2" aria-live="polite">
      {items.map((f, i) => (
        <li key={i} className="flex items-start gap-2 text-xs">
          <StatusBadge status={f.status} /> <span>{f.message}{f.evidence && <Badge tone="muted" className="ml-1">{f.evidence.slice(0, 60)}</Badge>}</span>
        </li>
      ))}
    </ul>
  );
}
