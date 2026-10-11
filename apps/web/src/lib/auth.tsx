import { useQuery, useQueryClient } from '@tanstack/react-query';
import { createContext, useContext, type ReactNode } from 'react';
import { api, ApiError } from './api';
import type { Me } from './types';

const Ctx = createContext<{ me: Me | null; loading: boolean; refresh: () => Promise<void>; role: Me['workspaces'][number]['role'] | null }>({ me: null, loading: true, refresh: async () => {}, role: null });

export function AuthProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ['me'],
    queryFn: async () => {
      try {
        return await api.get<Me>('/auth/me');
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) return null;
        throw e;
      }
    },
    staleTime: 60_000,
  });
  const me = q.data ?? null;
  const role = me?.workspaces.find((w) => w.id === me.activeWorkspaceId)?.role ?? null;
  return <Ctx.Provider value={{ me, loading: q.isLoading, role, refresh: async () => void (await qc.invalidateQueries()) }}>{children}</Ctx.Provider>;
}

export const useAuth = () => useContext(Ctx);
export const canEdit = (role: string | null) => role === 'OWNER' || role === 'ADMIN' || role === 'EDITOR';
