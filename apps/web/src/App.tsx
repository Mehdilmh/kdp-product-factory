import { Loader2 } from 'lucide-react';
import { lazy, Suspense, type ReactNode } from 'react';
import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { AppLayout } from './components/layout';
import { useAuth } from './lib/auth';
import { AuthPage } from './pages/auth';
import { Dashboard } from './pages/dashboard';

const Library = lazy(() => import('./pages/library'));
const Wizard = lazy(() => import('./pages/wizard'));
const ProjectPage = lazy(() => import('./pages/project'));
const JobsPage = lazy(() => import('./pages/jobs'));
const BatchesPage = lazy(() => import('./pages/batches'));
const BatchDetail = lazy(() => import('./pages/batch-detail'));
const TemplatesPage = lazy(() => import('./pages/templates'));
const UsagePage = lazy(() => import('./pages/usage'));
const SettingsPage = lazy(() => import('./pages/settings'));
const ModelsPage = lazy(() => import('./pages/models'));
const ColoringList = lazy(() => import('./pages/coloring-list'));
const ColoringNew = lazy(() => import('./pages/coloring-new'));
const ColoringBookPage = lazy(() => import('./pages/coloring-book'));

const Spinner = () => (
  <div className="flex h-64 items-center justify-center text-muted-foreground" role="status">
    <Loader2 className="size-6 animate-spin" aria-hidden />
    <span className="sr-only">Loading</span>
  </div>
);

function RequireAuth({ children }: { children: ReactNode }) {
  const { me, loading } = useAuth();
  const loc = useLocation();
  if (loading) return <Spinner />;
  if (!me) return <Navigate to="/login" replace state={{ from: loc.pathname }} />;
  return <>{children}</>;
}

export function App() {
  return (
    <BrowserRouter>
      <Suspense fallback={<Spinner />}>
        <Routes>
          <Route path="/login" element={<AuthPage mode="login" />} />
          <Route path="/register" element={<AuthPage mode="register" />} />
          <Route
            element={
              <RequireAuth>
                <AppLayout />
              </RequireAuth>
            }
          >
            <Route index element={<Dashboard />} />
            <Route path="projects" element={<Library />} />
            <Route path="projects/new" element={<Wizard />} />
            <Route path="projects/:id/*" element={<ProjectPage />} />
            <Route path="jobs" element={<JobsPage />} />
            <Route path="batches" element={<BatchesPage />} />
            <Route path="batches/:id" element={<BatchDetail />} />
            <Route path="templates" element={<TemplatesPage />} />
            <Route path="usage" element={<UsagePage />} />
            <Route path="models" element={<ModelsPage />} />
            <Route path="coloring" element={<ColoringList />} />
            <Route path="coloring/new" element={<ColoringNew />} />
            <Route path="coloring/:id" element={<ColoringBookPage />} />
            <Route path="settings" element={<SettingsPage />} />
            <Route path="*" element={<p className="text-muted-foreground">Page not found.</p>} />
          </Route>
        </Routes>
      </Suspense>
    </BrowserRouter>
  );
}
