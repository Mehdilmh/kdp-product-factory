import { PageTemplate } from '@kdp/core/browser';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Copy, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Badge, Card, CardContent, CardHeader, CardTitle, ErrorBox, Field, Input, PageHeader, Select, Skeleton, Textarea } from '@/components/ui/basic';
import { Button } from '@/components/ui/button';
import { api } from '@/lib/api';
import { canEdit, useAuth } from '@/lib/auth';
import { cn, titleCase } from '@/lib/utils';

type Tpl = PageTemplate & { dbId?: string; approved?: boolean };

export default function TemplatesPage() {
  const { role } = useAuth();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['templates'], queryFn: () => api.get<{ builtIn: Tpl[]; custom: Tpl[] }>('/templates') });
  const [sel, setSel] = useState<Tpl | null>(null);
  const [trim, setTrim] = useState('6x9');
  const [json, setJson] = useState('');
  const [key, setKey] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ svg: string; warnings: { code: string; message: string; level: string }[] } | null>(null);
  const [filter, setFilter] = useState('');

  useEffect(() => {
    if (!sel) return;
    const { dbId: _d, approved: _a, ...rest } = sel;
    setJson(JSON.stringify(rest, null, 2));
    setKey(sel.dbId ? sel.id : `my-${sel.id}`.slice(0, 60));
  }, [sel]);

  useEffect(() => {
    if (!json) return;
    const t = setTimeout(async () => {
      try {
        const parsed = PageTemplate.safeParse({ ...JSON.parse(json), id: '__preview' });
        if (!parsed.success) {
          setErr(parsed.error.issues.slice(0, 3).map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
          return;
        }
        setErr(null);
        setPreview(await api.post('/templates/preview', { template: parsed.data, trimId: trim }));
      } catch (e) {
        setErr((e as Error).message);
      }
    }, 350);
    return () => clearTimeout(t);
  }, [json, trim]);

  const all = [...(q.data?.custom ?? []), ...(q.data?.builtIn ?? [])].filter((t) => !filter || t.category === filter);
  const save = async () => {
    try {
      await api.post('/templates', { key, template: JSON.parse(json), approved: true });
      await qc.invalidateQueries({ queryKey: ['templates'] });
      toast.success('Template saved to your workspace library');
    } catch (e) {
      toast.error((e as Error).message);
    }
  };
  return (
    <>
      <PageHeader title="Template library" description="Typed page templates with configurable fields, predictable pagination, and printable line weights. Duplicate a built-in template to make your own." />
      {q.isLoading ? <Skeleton className="h-96" /> : q.error ? <ErrorBox error={q.error} /> : (
        <div className="grid gap-6 xl:grid-cols-[300px_minmax(0,1fr)_minmax(0,1fr)]">
          <Card className="max-h-[80vh] overflow-y-auto">
            <CardContent className="grid gap-1 p-2">
              <Select aria-label="Filter category" value={filter} onChange={(e) => setFilter(e.target.value)} className="mb-2">
                <option value="">All categories</option>
                {[...new Set([...(q.data?.builtIn ?? []), ...(q.data?.custom ?? [])].map((t) => t.category))].map((c) => <option key={c} value={c}>{titleCase(c)}</option>)}
              </Select>
              {all.map((t) => (
                <button key={(t.dbId ?? 'b') + t.id} onClick={() => setSel(t)} className={cn('rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent', sel?.id === t.id && 'bg-accent')}>
                  <span className="font-medium">{t.name}</span> {t.dbId ? <Badge tone="primary">Custom v{t.version}</Badge> : <Badge tone="muted">Built-in</Badge>}
                  <span className="block text-xs text-muted-foreground">{titleCase(t.kind)} · {titleCase(t.category)} · {t.fields.length} field(s)</span>
                </button>
              ))}
            </CardContent>
          </Card>
          {sel ? (
            <>
              <Card>
                <CardHeader><CardTitle className="flex items-center justify-between">{sel.name}{sel.dbId && canEdit(role) && <Button size="sm" variant="ghost" onClick={async () => { if (confirm('Delete this template?')) { await api.del(`/templates/${sel.dbId}`); setSel(null); await qc.invalidateQueries({ queryKey: ['templates'] }); } }}><Trash2 /> Delete</Button>}</CardTitle></CardHeader>
                <CardContent className="grid gap-3">
                  <p className="text-sm text-muted-foreground">{sel.description}</p>
                  <Field label="Definition (typed JSON — no HTML or code)" htmlFor="tj"><Textarea id="tj" rows={20} className="font-mono text-xs" value={json} onChange={(e) => setJson(e.target.value)} /></Field>
                  {err && <p className="text-xs text-destructive" role="alert">{err}</p>}
                  {canEdit(role) && (
                    <div className="flex gap-2">
                      <Input aria-label="Template key" value={key} onChange={(e) => setKey(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '-'))} />
                      <Button onClick={save} disabled={!!err || !key}><Copy /> {sel.dbId ? 'Save new version' : 'Save as custom'}</Button>
                    </div>
                  )}
                </CardContent>
              </Card>
              <Card>
                <CardHeader className="flex-row items-center justify-between space-y-0"><CardTitle>Preview</CardTitle>
                  <Select aria-label="Preview trim size" className="w-32" value={trim} onChange={(e) => setTrim(e.target.value)}>{['5x8', '5.5x8.5', '6x9', '7x10', '8.5x11', '8.25x6'].map((t) => <option key={t}>{t}</option>)}</Select>
                </CardHeader>
                <CardContent className="grid gap-2">
                  {preview && <div className="checker flex justify-center rounded-md p-4 [&>svg]:h-auto [&>svg]:max-h-[70vh] [&>svg]:w-full [&>svg]:bg-white [&>svg]:shadow" dangerouslySetInnerHTML={{ __html: preview.svg }} />}
                  {preview?.warnings.map((w, i) => <p key={i} className={cn('text-xs', w.level === 'error' ? 'text-destructive' : 'text-warning')}>{titleCase(w.code)}: {w.message}</p>)}
                </CardContent>
              </Card>
            </>
          ) : <p className="text-sm text-muted-foreground">Select a template to inspect, preview at different trim sizes, or duplicate.</p>}
        </div>
      )}
    </>
  );
}
