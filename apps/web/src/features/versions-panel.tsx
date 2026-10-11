import { useQuery, useQueryClient } from '@tanstack/react-query';
import { History, RotateCcw } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { Card, CardContent, CardDescription, CardHeader, CardTitle, EmptyState, Input, Skeleton } from '@/components/ui/basic';
import { Button } from '@/components/ui/button';
import { api } from '@/lib/api';
import { canEdit, useAuth } from '@/lib/auth';
import type { ProjectDetail } from '@/lib/types';
import { fmtDate } from '@/lib/utils';

export default function VersionsPanel({ project }: { project: ProjectDetail }) {
  const { role } = useAuth();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['versions', project.id], queryFn: () => api.get<{ id: string; version: number; label: string; createdAt: string }[]>(`/projects/${project.id}/versions`) });
  const [label, setLabel] = useState('');
  const save = async () => {
    try {
      await api.post(`/projects/${project.id}/versions`, { label });
      setLabel('');
      await q.refetch();
      toast.success('Version saved');
    } catch (e) {
      toast.error((e as Error).message);
    }
  };
  const restore = async (id: string, v: number) => {
    if (!confirm(`Restore version ${v}? Your current state is saved as a new version first, so this can be undone.`)) return;
    try {
      await api.post(`/projects/${project.id}/versions/${id}/restore`);
      await qc.invalidateQueries();
      toast.success(`Restored version ${v}`);
    } catch (e) {
      toast.error((e as Error).message);
    }
  };
  return (
    <div className="grid gap-6 lg:grid-cols-3">
      <Card>
        <CardHeader><CardTitle>Save a version</CardTitle><CardDescription>Snapshots include the brief, format, interior, covers, and metadata. Assets are referenced, not copied.</CardDescription></CardHeader>
        <CardContent className="flex gap-2">
          <Input aria-label="Version label" placeholder="e.g. Before proof changes" value={label} onChange={(e) => setLabel(e.target.value)} />
          <Button onClick={save} disabled={!label.trim() || !canEdit(role)}>Save</Button>
        </CardContent>
      </Card>
      <Card className="lg:col-span-2">
        <CardHeader><CardTitle>History</CardTitle></CardHeader>
        <CardContent>
          {q.isLoading ? <Skeleton className="h-40" /> : !q.data?.length ? <EmptyState icon={<History />} title="No versions yet" /> : (
            <ul className="divide-y">
              {q.data.map((v) => (
                <li key={v.id} className="flex items-center gap-3 py-2 text-sm">
                  <span className="w-10 font-mono text-muted-foreground">v{v.version}</span>
                  <span className="flex-1">{v.label}</span>
                  <span className="text-xs text-muted-foreground">{fmtDate(v.createdAt)}</span>
                  {canEdit(role) && <Button size="sm" variant="ghost" onClick={() => restore(v.id, v.version)}><RotateCcw /> Restore</Button>}
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
