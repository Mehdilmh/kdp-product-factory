import { useQuery } from '@tanstack/react-query';
import { BookOpen, Search } from 'lucide-react';
import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { EmptyState, ErrorBox, Input, PageHeader, Select, Skeleton } from '@/components/ui/basic';
import { Button } from '@/components/ui/button';
import { api } from '@/lib/api';
import { FORMAT_LABEL, StatusBadge } from '@/lib/status';
import { STATUS_ORDER, type ProjectListItem } from '@/lib/types';
import { fmtDate, titleCase } from '@/lib/utils';

export default function Library() {
  const [sp, setSp] = useSearchParams();
  const [q, setQ] = useState(sp.get('q') ?? '');
  const params = Object.fromEntries(sp.entries());
  const qs = new URLSearchParams({ ...params, take: '100' }).toString();
  const list = useQuery({ queryKey: ['projects', params], queryFn: () => api.get<{ items: ProjectListItem[]; total: number }>(`/projects?${qs}`) });
  const set = (k: string, v: string) => {
    const n = new URLSearchParams(sp);
    if (v) n.set(k, v);
    else n.delete(k);
    setSp(n);
  };

  return (
    <>
      <PageHeader title="Product library" description={list.data ? `${list.data.total} product(s)` : undefined} actions={<Button asChild><Link to="/projects/new">New product</Link></Button>} />
      <form
        className="mb-4 flex flex-wrap gap-2"
        role="search"
        onSubmit={(e) => {
          e.preventDefault();
          set('q', q);
        }}
      >
        <div className="relative min-w-[220px] flex-1">
          <Search className="absolute left-2.5 top-2.5 size-4 text-muted-foreground" aria-hidden />
          <Input aria-label="Search titles and niches" placeholder="Search titles and niches…" className="pl-8" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <Select aria-label="Status" className="w-44" value={sp.get('status') ?? ''} onChange={(e) => set('status', e.target.value)}>
          <option value="">All statuses</option>
          {STATUS_ORDER.map((s) => <option key={s} value={s}>{titleCase(s)}</option>)}
        </Select>
        <Select aria-label="Format" className="w-40" value={sp.get('format') ?? ''} onChange={(e) => set('format', e.target.value)}>
          <option value="">All formats</option>
          <option value="PAPERBACK">Paperback</option>
          <option value="HARDCOVER">Hardcover</option>
          <option value="EBOOK">Kindle eBook</option>
        </Select>
        <Select aria-label="Sort" className="w-40" value={sp.get('sort') ?? 'updated'} onChange={(e) => set('sort', e.target.value)}>
          <option value="updated">Recently updated</option>
          <option value="created">Newest</option>
          <option value="title">Title A–Z</option>
        </Select>
        <Button type="submit" variant="secondary">Search</Button>
      </form>
      <ErrorBox error={list.error} />
      {list.isLoading ? (
        <div className="grid gap-2">{Array.from({ length: 6 }, (_, i) => <Skeleton key={i} className="h-14" />)}</div>
      ) : list.data?.items.length === 0 ? (
        <EmptyState icon={<BookOpen />} title="No matching products" description="Try clearing filters, or create a new product." />
      ) : (
        <div className="overflow-x-auto rounded-lg border">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-left text-xs text-muted-foreground">
              <tr>
                <th className="px-3 py-2 font-medium">Title</th>
                <th className="px-3 py-2 font-medium">Format</th>
                <th className="px-3 py-2 font-medium">Category</th>
                <th className="px-3 py-2 font-medium">Content</th>
                <th className="px-3 py-2 font-medium">Validation</th>
                <th className="px-3 py-2 font-medium">Status</th>
                <th className="px-3 py-2 font-medium">Updated</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {list.data?.items.map((p) => (
                <tr key={p.id} className="hover:bg-accent/40">
                  <td className="px-3 py-2">
                    <Link className="font-medium hover:underline" to={`/projects/${p.id}`}>{p.title}</Link>
                    {p.jobs[0] && <span className="ml-2 text-xs text-primary">{titleCase(p.jobs[0].stage)} {p.jobs[0].progress}%</span>}
                  </td>
                  <td className="px-3 py-2">{FORMAT_LABEL[p.format?.format ?? '']} {p.format?.format !== 'EBOOK' && <span className="text-muted-foreground">{p.format?.trimId}</span>}</td>
                  <td className="px-3 py-2">{titleCase(p.category)}</td>
                  <td className="px-3 py-2">{titleCase(p.contentClass)}</td>
                  <td className="px-3 py-2">{p.validationReports[0] ? <StatusBadge status={p.validationReports[0].blocked ? 'BLOCKED' : 'PASSED'} /> : <span className="text-xs text-muted-foreground">Not run</span>}</td>
                  <td className="px-3 py-2"><StatusBadge status={p.status} /></td>
                  <td className="px-3 py-2 text-muted-foreground">{fmtDate(p.updatedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
