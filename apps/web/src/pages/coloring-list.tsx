import { useQuery } from '@tanstack/react-query';
import { Archive, ArchiveRestore, Copy, Palette, Plus, Search } from 'lucide-react';
import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Badge, Card, CardContent, EmptyState, ErrorBox, Input, PageHeader, Progress, Select, Skeleton } from '@/components/ui/basic';
import { Button } from '@/components/ui/button';
import { STAGE_LABEL } from '@/features/coloring-types';
import { money } from '@/features/image-models';
import { api } from '@/lib/api';
import { canEdit, useAuth } from '@/lib/auth';
import { useAction } from '@/lib/hooks';
import { fmtDate, titleCase } from '@/lib/utils';

interface Row {
  id: string;
  projectId: string;
  title: string;
  trimId: string;
  audience: string;
  theme: string;
  stage: string;
  archived: boolean;
  illustrationTarget: number;
  pages: number;
  approved: number;
  counts: Record<string, number>;
  estimatedCostUsd: number;
  actualCostUsd: number;
  budgetCapUsd: number | null;
  progress: number;
  updatedAt: string;
}

export default function ColoringList() {
  const { role } = useAuth();
  const nav = useNavigate();
  const [q, setQ] = useState('');
  const [stage, setStage] = useState('');
  const [sort, setSort] = useState('updated');
  const [archived, setArchived] = useState(false);
  const qs = new URLSearchParams({ q, stage, sort, archived: String(archived) }).toString();
  const list = useQuery({ queryKey: ['coloring', qs], queryFn: () => api.get<Row[]>(`/coloring?${qs}`), refetchInterval: 15000 });
  const dup = useAction((id: string) => api.post<{ id: string }>(`/coloring/${id}/duplicate`), { success: 'Duplicated (plan and settings, no images)', invalidate: [['coloring']], onSuccess: (r) => nav(`/coloring/${r.id}`) });
  const arch = useAction((v: { id: string; archived: boolean }) => api.post(`/coloring/${v.id}/archive`, { archived: v.archived }), { success: (_) => 'Updated', invalidate: [['coloring']] });
  const editable = canEdit(role);
  return (
    <>
      <PageHeader title="Coloring Book Studio" description="Plan, generate, review and assemble original coloring books. Every generation shows its estimated cost first; approval by Amazon KDP is never guaranteed." actions={editable && <Button asChild><Link to="/coloring/new"><Plus /> New coloring book</Link></Button>} />
      <div className="mb-4 flex flex-wrap gap-2" role="search">
        <div className="relative min-w-[220px] flex-1">
          <Search className="absolute left-2.5 top-2.5 size-4 text-muted-foreground" aria-hidden />
          <Input aria-label="Search titles" placeholder="Search titles…" className="pl-8" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <Select aria-label="Stage" className="w-44" value={stage} onChange={(e) => setStage(e.target.value)}>
          <option value="">All stages</option>
          {Object.entries(STAGE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </Select>
        <Select aria-label="Sort" className="w-44" value={sort} onChange={(e) => setSort(e.target.value)}>
          <option value="updated">Recently updated</option>
          <option value="created">Newest</option>
          <option value="title">Title A–Z</option>
          <option value="approved">Most approved pages</option>
        </Select>
        <Button variant={archived ? 'secondary' : 'outline'} onClick={() => setArchived((a) => !a)} aria-pressed={archived}><Archive /> {archived ? 'Showing archived' : 'Archived'}</Button>
      </div>
      <ErrorBox error={list.error} />
      {list.isLoading ? <Skeleton className="h-64" /> : !list.data?.length ? (
        <EmptyState icon={<Palette className="size-8" />} title={archived ? 'No archived coloring books' : 'No coloring books yet'} description="Start with an audience and theme; you can review every page before it goes into the book." action={editable && !archived ? <Button asChild><Link to="/coloring/new">New coloring book</Link></Button> : undefined} />
      ) : (
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {list.data.map((b) => (
            <Card key={b.id}>
              <CardContent className="grid gap-2 pt-5">
                <div className="flex items-start gap-2">
                  <Link to={`/coloring/${b.id}`} className="font-semibold hover:underline">{b.title}</Link>
                  <Badge tone="primary" className="ml-auto shrink-0">{STAGE_LABEL[b.stage] ?? b.stage}</Badge>
                </div>
                <p className="text-xs text-muted-foreground">{titleCase(b.audience)} · {b.theme || 'custom theme'} · {b.trimId} · updated {fmtDate(b.updatedAt)}</p>
                <Progress value={b.progress} label="Approved pages" />
                <p className="text-sm"><strong>{b.approved}</strong> / {b.illustrationTarget} approved · {b.pages} in plan{b.counts.NEEDS_REVIEW ? ` · ${b.counts.NEEDS_REVIEW} to review` : ''}{b.counts.FAILED ? ` · ${b.counts.FAILED} failed` : ''}</p>
                <p className="text-xs text-muted-foreground">Estimated {money(b.estimatedCostUsd)} · actual reported {money(b.actualCostUsd)}{b.budgetCapUsd !== null ? ` · budget ${money(b.budgetCapUsd)}` : ''}</p>
                {editable && (
                  <div className="flex gap-2">
                    <Button size="sm" variant="outline" onClick={() => dup.mutate(b.id)} loading={dup.isPending}><Copy /> Duplicate</Button>
                    <Button size="sm" variant="ghost" onClick={() => arch.mutate({ id: b.id, archived: !b.archived })}>{b.archived ? <><ArchiveRestore /> Restore</> : <><Archive /> Archive</>}</Button>
                  </div>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </>
  );
}
