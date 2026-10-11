import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api } from './api';
import type { JobDetail, JobSummary, ProjectDetail } from './types';

const ACTIVE = new Set(['QUEUED', 'RUNNING']);

export function useProject(id: string) {
  return useQuery({
    queryKey: ['project', id],
    queryFn: () => api.get<ProjectDetail>(`/projects/${id}`),
    // Poll while a job is running so status and progress stay current without blocking the UI.
    refetchInterval: (q) => (q.state.data?.jobs.some((j) => ACTIVE.has(j.status)) ? 1500 : false),
  });
}

export function useJobs(params: { projectId?: string; status?: string } = {}) {
  const qs = new URLSearchParams(Object.entries(params).filter(([, v]) => v) as [string, string][]).toString();
  return useQuery({
    queryKey: ['jobs', params],
    queryFn: () => api.get<JobSummary[]>(`/jobs${qs ? '?' + qs : ''}`),
    refetchInterval: (q) => (q.state.data?.some((j) => ACTIVE.has(j.status)) ? 1500 : 10_000),
  });
}

export function useJob(id: string | null) {
  return useQuery({
    queryKey: ['job', id],
    queryFn: () => api.get<JobDetail>(`/jobs/${id}`),
    enabled: !!id,
    refetchInterval: (q) => (q.state.data && ACTIVE.has(q.state.data.status) ? 1000 : false),
  });
}

/** Mutation helper with consistent toasts and cache invalidation. */
export function useAction<TVars, TOut>(fn: (v: TVars) => Promise<TOut>, opts: { success?: string | ((o: TOut) => string); invalidate?: unknown[][]; onSuccess?: (o: TOut) => void } = {}) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: async (out) => {
      if (opts.success) toast.success(typeof opts.success === 'function' ? opts.success(out) : opts.success);
      for (const k of opts.invalidate ?? []) await qc.invalidateQueries({ queryKey: k });
      opts.onSuccess?.(out);
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

export const isActive = (s: string) => ACTIVE.has(s);

/** Re-fetch editor data once background jobs for this project finish. */
import { useEffect, useRef } from 'react';
export function useRefreshAfterJobs(project: { id: string; jobs: { status: string }[] }, keys: unknown[][]) {
  const qc = useQueryClient();
  const running = project.jobs.some((j) => ACTIVE.has(j.status));
  const was = useRef(running);
  useEffect(() => {
    if (was.current && !running) for (const k of keys) void qc.invalidateQueries({ queryKey: k });
    was.current = running;
  }, [running]); // eslint-disable-line react-hooks/exhaustive-deps
}
