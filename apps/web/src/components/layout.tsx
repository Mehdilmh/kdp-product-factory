import { useQueryClient } from '@tanstack/react-query';
import { BookOpen, Boxes, Images, Palette, ChevronsUpDown, FileStack, Gauge, LayoutDashboard, LayoutTemplate, ListChecks, LogOut, Moon, PlusCircle, Settings, Sun } from 'lucide-react';
import { useState } from 'react';
import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useJobs } from '@/lib/hooks';
import { useTheme } from '@/lib/theme';
import { cn } from '@/lib/utils';

const NAV = [
  { to: '/', label: 'Overview', icon: LayoutDashboard, end: true },
  { to: '/projects', label: 'Product library', icon: BookOpen },
  { to: '/projects/new', label: 'New product', icon: PlusCircle },
  { to: '/coloring', label: 'Coloring Studio', icon: Palette },
  { to: '/batches', label: 'Batches', icon: Boxes },
  { to: '/jobs', label: 'Jobs', icon: ListChecks },
  { to: '/templates', label: 'Templates', icon: LayoutTemplate },
  { to: '/models', label: 'Image models', icon: Images },
  { to: '/usage', label: 'AI usage & cost', icon: Gauge },
  { to: '/settings', label: 'Settings', icon: Settings },
];

export function AppLayout() {
  const { me, refresh } = useAuth();
  const { dark, toggle } = useTheme();
  const nav = useNavigate();
  const qc = useQueryClient();
  const jobs = useJobs({});
  const running = jobs.data?.filter((j) => j.status === 'RUNNING' || j.status === 'QUEUED').length ?? 0;
  const [mobileOpen, setMobileOpen] = useState(false);
  const active = me?.workspaces.find((w) => w.id === me.activeWorkspaceId);

  const sidebar = (
    <nav aria-label="Main" className="flex h-full flex-col gap-1 p-3">
      <div className="mb-3 flex items-center gap-2 px-2 py-1">
        <FileStack className="size-6 text-primary" aria-hidden />
        <div className="leading-tight">
          <p className="text-sm font-semibold">KDP Product Factory</p>
          <p className="text-xs text-muted-foreground">Original books, carefully made</p>
        </div>
      </div>
      {me && me.workspaces.length > 1 ? (
        <label className="mb-2 flex items-center gap-2 rounded-md border px-2 py-1.5 text-sm">
          <ChevronsUpDown className="size-4 text-muted-foreground" aria-hidden />
          <span className="sr-only">Workspace</span>
          <select
            className="w-full bg-transparent"
            value={me.activeWorkspaceId ?? ''}
            onChange={async (e) => {
              await api.post(`/workspaces/${e.target.value}/activate`);
              qc.clear();
              await refresh();
              nav('/');
            }}
          >
            {me.workspaces.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name} ({w.role.toLowerCase()})
              </option>
            ))}
          </select>
        </label>
      ) : (
        <p className="mb-2 truncate px-2 text-xs text-muted-foreground">{active?.name}</p>
      )}
      {NAV.map((n) => (
        <NavLink
          key={n.to}
          to={n.to}
          end={n.end}
          onClick={() => setMobileOpen(false)}
          className={({ isActive }) => cn('flex items-center gap-2.5 rounded-md px-2.5 py-2 text-sm font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground', isActive && 'bg-accent text-foreground')}
        >
          <n.icon className="size-4" aria-hidden />
          <span className="flex-1">{n.label}</span>
          {n.to === '/jobs' && running > 0 && (
            <span className="rounded-full bg-primary px-1.5 text-[10px] font-semibold text-primary-foreground" aria-label={`${running} active jobs`}>
              {running}
            </span>
          )}
        </NavLink>
      ))}
      <div className="mt-auto flex items-center gap-2 border-t pt-3">
        <div className="min-w-0 flex-1 px-1">
          <p className="truncate text-sm font-medium">{me?.user.name}</p>
          <p className="truncate text-xs text-muted-foreground">{me?.user.email}</p>
        </div>
        <Button variant="ghost" size="icon" onClick={toggle} aria-label={dark ? 'Switch to light theme' : 'Switch to dark theme'}>
          {dark ? <Sun /> : <Moon />}
        </Button>
        <Button
          variant="ghost"
          size="icon"
          aria-label="Sign out"
          onClick={async () => {
            await api.post('/auth/logout');
            qc.clear();
            await refresh();
            nav('/login');
          }}
        >
          <LogOut />
        </Button>
      </div>
    </nav>
  );

  return (
    <div className="flex min-h-screen">
      <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-50 focus:rounded focus:bg-background focus:px-3 focus:py-2">
        Skip to content
      </a>
      <aside className="sticky top-0 hidden h-screen w-64 shrink-0 border-r bg-card lg:block">{sidebar}</aside>
      {mobileOpen && (
        <div className="fixed inset-0 z-40 lg:hidden" role="dialog" aria-modal="true" aria-label="Navigation">
          <div className="absolute inset-0 bg-black/40" onClick={() => setMobileOpen(false)} />
          <aside className="absolute inset-y-0 left-0 w-72 border-r bg-card">{sidebar}</aside>
        </div>
      )}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center gap-3 border-b px-4 py-2 lg:hidden">
          <Button variant="outline" size="sm" onClick={() => setMobileOpen(true)} aria-label="Open navigation">
            Menu
          </Button>
          <span className="text-sm font-semibold">KDP Product Factory</span>
        </header>
        <main id="main" className="mx-auto w-full max-w-[1500px] flex-1 px-4 py-6 lg:px-8">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
