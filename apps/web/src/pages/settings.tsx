import { useQuery, useQueryClient } from '@tanstack/react-query';
import { KeyRound, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Badge, Card, CardContent, CardDescription, CardHeader, CardTitle, ErrorBox, Field, Input, PageHeader, Select, Skeleton } from '@/components/ui/basic';
import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/overlay';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { fmtDate } from '@/lib/utils';

interface Workspace { id: string; name: string; dailyCostLimitUsd: number; monthlyCostLimitUsd: number; dailyJobLimit: number; role: string; members: { id: string; role: string; email: string; name: string }[] }
interface ProviderCfg { id: string; kind: string; provider: string; model: string; baseUrl: string | null; hasApiKey: boolean; apiKeyLast4: string | null; isDefault: boolean; pricing: { inputPer1MTokensUsd: number; outputPer1MTokensUsd: number; perImageUsd: number; note?: string }; maxRequestsPerMinute: number }

export default function SettingsPage() {
  const { role } = useAuth();
  const admin = role === 'OWNER' || role === 'ADMIN';
  return (
    <>
      <PageHeader title="Settings" description="Workspace limits, AI providers, members, assets, and the audit log." />
      <Tabs defaultValue="workspace">
        <TabsList>
          <TabsTrigger value="workspace">Workspace & limits</TabsTrigger>
          <TabsTrigger value="providers">Providers</TabsTrigger>
          <TabsTrigger value="assets">Assets</TabsTrigger>
          {admin && <TabsTrigger value="audit">Audit log</TabsTrigger>}
        </TabsList>
        <TabsContent value="workspace"><WorkspaceTab admin={admin} /></TabsContent>
        <TabsContent value="providers"><ProvidersTab admin={admin} /></TabsContent>
        <TabsContent value="assets"><AssetsTab /></TabsContent>
        {admin && <TabsContent value="audit"><AuditTab /></TabsContent>}
      </Tabs>
    </>
  );
}

function WorkspaceTab({ admin }: { admin: boolean }) {
  const { refresh } = useAuth();
  const q = useQuery({ queryKey: ['workspace'], queryFn: () => api.get<Workspace>('/workspace') });
  const [w, setW] = useState<Workspace | null>(null);
  const [member, setMember] = useState({ email: '', role: 'EDITOR' });
  useEffect(() => { if (q.data) setW(q.data); }, [q.data]);
  if (!w) return <Skeleton className="h-64" />;
  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <Card>
        <CardHeader><CardTitle>Workspace</CardTitle><CardDescription>There is no arbitrary product-count limit; spending and job volume are capped by these quotas.</CardDescription></CardHeader>
        <CardContent className="grid gap-3">
          <Field label="Name" htmlFor="wn"><Input id="wn" disabled={!admin} value={w.name} onChange={(e) => setW({ ...w, name: e.target.value })} /></Field>
          <Field label="Daily AI budget (USD)" htmlFor="dl"><Input id="dl" type="number" min={0} step="0.5" disabled={!admin} value={w.dailyCostLimitUsd} onChange={(e) => setW({ ...w, dailyCostLimitUsd: Number(e.target.value) })} /></Field>
          <Field label="Monthly AI budget (USD)" htmlFor="ml"><Input id="ml" type="number" min={0} step="1" disabled={!admin} value={w.monthlyCostLimitUsd} onChange={(e) => setW({ ...w, monthlyCostLimitUsd: Number(e.target.value) })} /></Field>
          <Field label="Jobs per 24 hours" htmlFor="jl"><Input id="jl" type="number" min={1} disabled={!admin} value={w.dailyJobLimit} onChange={(e) => setW({ ...w, dailyJobLimit: Number(e.target.value) })} /></Field>
          {admin && <Button onClick={async () => { try { await api.patch('/workspace', { name: w.name, dailyCostLimitUsd: w.dailyCostLimitUsd, monthlyCostLimitUsd: w.monthlyCostLimitUsd, dailyJobLimit: w.dailyJobLimit }); await refresh(); toast.success('Saved'); } catch (e) { toast.error((e as Error).message); } }}>Save</Button>}
        </CardContent>
      </Card>
      <Card>
        <CardHeader><CardTitle>Members</CardTitle></CardHeader>
        <CardContent className="grid gap-3">
          <ul className="divide-y text-sm">{w.members.map((m) => <li key={m.id} className="flex justify-between py-1.5"><span>{m.name} <span className="text-muted-foreground">{m.email}</span></span><Badge>{m.role.toLowerCase()}</Badge></li>)}</ul>
          {admin && (
            <div className="flex gap-2">
              <Input aria-label="Member email" placeholder="registered user email" value={member.email} onChange={(e) => setMember({ ...member, email: e.target.value })} />
              <Select aria-label="Role" className="w-32" value={member.role} onChange={(e) => setMember({ ...member, role: e.target.value })}><option value="EDITOR">Editor</option><option value="VIEWER">Viewer</option><option value="ADMIN">Admin</option></Select>
              <Button onClick={async () => { try { await api.post('/workspace/members', member); await q.refetch(); toast.success('Member added'); } catch (e) { toast.error((e as Error).message); } }}>Add</Button>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function ProvidersTab({ admin }: { admin: boolean }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['providers'], queryFn: () => api.get<{ configs: ProviderCfg[]; available: { text: string[]; image: string[] } }>('/providers') });
  const [form, setForm] = useState({ kind: 'TEXT', provider: 'gemini', model: 'gemini-2.5-flash', baseUrl: '', apiKey: '', maxRequestsPerMinute: 30, inputPer1MTokensUsd: '', outputPer1MTokensUsd: '', perImageUsd: '' });
  const [testResult, setTestResult] = useState<string | null>(null);
  if (q.isLoading) return <Skeleton className="h-64" />;
  if (q.error) return <ErrorBox error={q.error} />;
  const providers = form.kind === 'TEXT' ? q.data!.available.text : q.data!.available.image;
  const add = async () => {
    try {
      const pricing = form.inputPer1MTokensUsd || form.outputPer1MTokensUsd || form.perImageUsd ? { inputPer1MTokensUsd: Number(form.inputPer1MTokensUsd || 0), outputPer1MTokensUsd: Number(form.outputPer1MTokensUsd || 0), perImageUsd: Number(form.perImageUsd || 0) } : undefined;
      await api.post('/providers', { kind: form.kind, provider: form.provider, model: form.model, baseUrl: form.baseUrl || undefined, apiKey: form.apiKey || undefined, isDefault: true, maxRequestsPerMinute: form.maxRequestsPerMinute, pricing });
      setForm({ ...form, apiKey: '' });
      await qc.invalidateQueries({ queryKey: ['providers'] });
      toast.success('Provider saved. The key is encrypted on the server and never shown again.');
    } catch (e) {
      toast.error((e as Error).message);
    }
  };
  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <Card>
        <CardHeader><CardTitle>Configured providers</CardTitle><CardDescription>Without a configuration the deterministic mock providers are used (no cost, generic output).</CardDescription></CardHeader>
        <CardContent className="grid gap-2">
          {q.data!.configs.length === 0 && <p className="text-sm text-muted-foreground">Using mock providers.</p>}
          {q.data!.configs.map((c) => (
            <div key={c.id} className="flex flex-wrap items-center gap-2 rounded-md border p-2 text-sm">
              <Badge tone={c.kind === 'TEXT' ? 'primary' : 'review'}>{c.kind}</Badge>
              <span className="font-medium">{c.provider}</span><span className="text-muted-foreground">{c.model}</span>
              {c.isDefault && <Badge tone="success">default</Badge>}
              <span className="text-xs text-muted-foreground">{c.hasApiKey ? <><KeyRound className="inline size-3" /> ••••{c.apiKeyLast4}</> : 'server env key'} · {c.maxRequestsPerMinute}/min</span>
              <span className="text-xs text-muted-foreground">${c.pricing.inputPer1MTokensUsd}/${c.pricing.outputPer1MTokensUsd} per 1M tokens{c.pricing.perImageUsd ? ` · $${c.pricing.perImageUsd}/image` : ''}</span>
              {admin && <Button size="icon" variant="ghost" className="ml-auto" aria-label="Remove provider" onClick={async () => { await api.del(`/providers/${c.id}`); await q.refetch(); }}><Trash2 /></Button>}
            </div>
          ))}
          {admin && <Button variant="outline" onClick={async () => { setTestResult(null); try { const r = await api.post<{ model: string; latencyMs: number }>('/providers/test'); setTestResult(`OK — ${r.model} responded in ${r.latencyMs} ms`); } catch (e) { setTestResult(`Failed: ${(e as Error).message}`); } }}>Test default text provider</Button>}
          {testResult && <p className="text-sm" role="status">{testResult}</p>}
        </CardContent>
      </Card>
      {admin && (
        <Card>
          <CardHeader><CardTitle>Add provider</CardTitle><CardDescription>API keys are sent once over HTTPS, encrypted at rest (AES-256-GCM), and never returned to the browser.</CardDescription></CardHeader>
          <CardContent className="grid gap-3 sm:grid-cols-2">
            <Field label="Kind" htmlFor="pk"><Select id="pk" value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value, provider: e.target.value === 'TEXT' ? 'gemini' : 'fal', model: e.target.value === 'TEXT' ? 'gemini-2.5-flash' : 'fal-ai/flux/schnell' })}><option value="TEXT">Text</option><option value="IMAGE">Image</option></Select></Field>
            <Field label="Provider" htmlFor="pp"><Select id="pp" value={form.provider} onChange={(e) => setForm({ ...form, provider: e.target.value })}>{providers.map((p) => <option key={p}>{p}</option>)}</Select></Field>
            <Field label="Model" htmlFor="pm"><Input id="pm" value={form.model} onChange={(e) => setForm({ ...form, model: e.target.value })} /></Field>
            {form.provider === 'openai-compatible' && <Field label="Base URL" htmlFor="pb"><Input id="pb" placeholder="https://api.openai.com/v1" value={form.baseUrl} onChange={(e) => setForm({ ...form, baseUrl: e.target.value })} /></Field>}
            <Field label="API key (optional if set in server env)" htmlFor="pkey" className="sm:col-span-2"><Input id="pkey" type="password" autoComplete="off" value={form.apiKey} onChange={(e) => setForm({ ...form, apiKey: e.target.value })} /></Field>
            <Field label="Requests per minute" htmlFor="rpm"><Input id="rpm" type="number" min={1} value={form.maxRequestsPerMinute} onChange={(e) => setForm({ ...form, maxRequestsPerMinute: Number(e.target.value) })} /></Field>
            <Field label="$ / 1M input tokens" htmlFor="pi" hint="Your own estimate"><Input id="pi" type="number" step="0.01" value={form.inputPer1MTokensUsd} onChange={(e) => setForm({ ...form, inputPer1MTokensUsd: e.target.value })} /></Field>
            <Field label="$ / 1M output tokens" htmlFor="po"><Input id="po" type="number" step="0.01" value={form.outputPer1MTokensUsd} onChange={(e) => setForm({ ...form, outputPer1MTokensUsd: e.target.value })} /></Field>
            <Field label="$ / image" htmlFor="pimg"><Input id="pimg" type="number" step="0.001" value={form.perImageUsd} onChange={(e) => setForm({ ...form, perImageUsd: e.target.value })} /></Field>
            <Button className="sm:col-span-2" onClick={add} disabled={!form.model}>Save as default {form.kind.toLowerCase()} provider</Button>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function AssetsTab() {
  const q = useQuery({ queryKey: ['assets', 'all'], queryFn: () => api.get<{ id: string; filename: string; mimeType: string; widthPx: number | null; heightPx: number | null; source: string; licenseNote: string; createdAt: string; sizeBytes: number }[]>('/assets') });
  const [busy, setBusy] = useState(false);
  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between space-y-0"><div><CardTitle>Assets</CardTitle><CardDescription>PNG, JPEG, or PDF (official templates). File type is checked by content, not extension.</CardDescription></div>
        <label className="cursor-pointer"><span className="sr-only">Upload asset</span><input type="file" accept="image/png,image/jpeg,application/pdf" className="text-sm" disabled={busy} onChange={async (e) => { const f = e.target.files?.[0]; if (!f) return; setBusy(true); const fd = new FormData(); fd.append('file', f); fd.append('licenseNote', prompt('License / permission note:', '') ?? ''); try { await api.upload('/assets', fd); await q.refetch(); toast.success('Uploaded'); } catch (err) { toast.error((err as Error).message); } finally { setBusy(false); e.target.value = ''; } }} /></label>
      </CardHeader>
      <CardContent>
        {q.isLoading ? <Skeleton className="h-40" /> : (
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-6">
            {q.data?.map((a) => (
              <div key={a.id} className="grid gap-1 rounded-md border p-2 text-xs">
                {a.mimeType.startsWith('image/') ? <img src={`/api/assets/${a.id}/file`} alt={a.filename} className="aspect-square w-full rounded bg-muted object-contain" loading="lazy" /> : <div className="flex aspect-square items-center justify-center rounded bg-muted">PDF</div>}
                <span className="truncate font-medium">{a.filename}</span>
                <span className="text-muted-foreground">{a.widthPx ? `${a.widthPx}×${a.heightPx}px · ` : ''}{a.source.toLowerCase()}</span>
                <span className={a.licenseNote ? 'text-muted-foreground' : 'text-warning'}>{a.licenseNote || 'No license note'}</span>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function AuditTab() {
  const q = useQuery({ queryKey: ['audit'], queryFn: () => api.get<{ id: string; action: string; entityType: string; entityId: string | null; createdAt: string; userId: string | null; details: unknown }[]>('/audit-logs?limit=200') });
  if (q.isLoading) return <Skeleton className="h-64" />;
  return (
    <Card>
      <CardContent className="overflow-x-auto p-0">
        <table className="w-full text-sm"><thead className="bg-muted/50 text-left text-xs text-muted-foreground"><tr><th className="px-3 py-2">When</th><th className="px-3 py-2">Action</th><th className="px-3 py-2">Entity</th><th className="px-3 py-2">Details</th></tr></thead>
          <tbody className="divide-y">{q.data?.map((l) => <tr key={l.id}><td className="px-3 py-1.5 text-muted-foreground">{fmtDate(l.createdAt)}</td><td className="px-3 py-1.5 font-mono text-xs">{l.action}</td><td className="px-3 py-1.5">{l.entityType}</td><td className="max-w-md truncate px-3 py-1.5 text-xs text-muted-foreground">{l.details ? JSON.stringify(l.details) : ''}</td></tr>)}</tbody>
        </table>
      </CardContent>
    </Card>
  );
}
