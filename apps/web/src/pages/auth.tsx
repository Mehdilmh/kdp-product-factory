import { zodResolver } from '@hookform/resolvers/zod';
import { FileStack } from 'lucide-react';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { Link, Navigate, useLocation, useNavigate } from 'react-router-dom';
import { z } from 'zod';
import { Card, CardContent, CardDescription, CardHeader, CardTitle, ErrorBox, Field, Input } from '@/components/ui/basic';
import { Button } from '@/components/ui/button';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';

const LoginSchema = z.object({ email: z.string().email('Enter a valid email'), password: z.string().min(1, 'Enter your password') });
const RegisterSchema = z.object({ name: z.string().trim().min(1, 'Enter your name'), email: z.string().email('Enter a valid email'), password: z.string().min(10, 'Use at least 10 characters'), workspaceName: z.string().trim().max(100).optional() });

export function AuthPage({ mode }: { mode: 'login' | 'register' }) {
  const { me, refresh } = useAuth();
  const nav = useNavigate();
  const loc = useLocation();
  const [error, setError] = useState<unknown>(null);
  const schema = mode === 'login' ? LoginSchema : RegisterSchema;
  const { register, handleSubmit, formState } = useForm<z.infer<typeof RegisterSchema>>({ resolver: zodResolver(schema as typeof RegisterSchema) });
  if (me) return <Navigate to={(loc.state as { from?: string } | null)?.from ?? '/'} replace />;

  const onSubmit = handleSubmit(async (values) => {
    setError(null);
    try {
      await api.post(mode === 'login' ? '/auth/login' : '/auth/register', values);
      await refresh();
      nav('/');
    } catch (e) {
      setError(e);
    }
  });

  return (
    <div className="flex min-h-screen items-center justify-center bg-muted/40 px-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <div className="mb-2 flex items-center gap-2 text-primary">
            <FileStack className="size-6" aria-hidden />
            <span className="font-semibold text-foreground">KDP Product Factory</span>
          </div>
          <CardTitle>{mode === 'login' ? 'Sign in' : 'Create your account'}</CardTitle>
          <CardDescription>{mode === 'login' ? 'Welcome back.' : 'A personal workspace is created for you.'}</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={onSubmit} className="grid gap-4" noValidate>
            {mode === 'register' && (
              <Field label="Name" htmlFor="name" error={formState.errors.name?.message}>
                <Input id="name" autoComplete="name" {...register('name')} aria-invalid={!!formState.errors.name} />
              </Field>
            )}
            <Field label="Email" htmlFor="email" error={formState.errors.email?.message}>
              <Input id="email" type="email" autoComplete="email" {...register('email')} aria-invalid={!!formState.errors.email} />
            </Field>
            <Field label="Password" htmlFor="password" error={formState.errors.password?.message} hint={mode === 'register' ? 'At least 10 characters.' : undefined}>
              <Input id="password" type="password" autoComplete={mode === 'login' ? 'current-password' : 'new-password'} {...register('password')} aria-invalid={!!formState.errors.password} />
            </Field>
            {mode === 'register' && (
              <Field label="Workspace name (optional)" htmlFor="workspaceName">
                <Input id="workspaceName" {...register('workspaceName')} />
              </Field>
            )}
            <ErrorBox error={error} title={mode === 'login' ? 'Sign-in failed' : 'Could not create account'} />
            <Button type="submit" loading={formState.isSubmitting}>
              {mode === 'login' ? 'Sign in' : 'Create account'}
            </Button>
            <p className="text-center text-sm text-muted-foreground">
              {mode === 'login' ? (
                <>
                  No account? <Link className="text-primary underline-offset-4 hover:underline" to="/register">Create one</Link>
                </>
              ) : (
                <>
                  Already registered? <Link className="text-primary underline-offset-4 hover:underline" to="/login">Sign in</Link>
                </>
              )}
            </p>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
