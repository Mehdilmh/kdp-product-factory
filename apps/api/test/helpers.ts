import request from 'supertest';
import { createApp, syncRules } from '../src/app';
import { prisma } from '../src/db';
import { InlineRunner, getRunner } from '../src/jobs/runner';

export const app = createApp();
let rulesSynced = false;

export type Agent = ReturnType<typeof request.agent>;

/** A signed-in agent (session cookie). Mutations must add the CSRF header via `H`. */
export async function signUp(name = 'User'): Promise<{ agent: Agent; userId: string; workspaceId: string; email: string }> {
  if (!rulesSynced) {
    await syncRules();
    rulesSynced = true;
  }
  const agent = request.agent(app);
  const email = `${name.toLowerCase().replace(/\W/g, '')}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@test.local`;
  const res = await agent.post('/api/auth/register').set('x-requested-with', 'kdp-factory').send({ email, name, password: 'correct horse battery' });
  if (res.status !== 201) throw new Error(`register failed: ${res.status} ${JSON.stringify(res.body)}`);
  return { agent, userId: res.body.user.id, workspaceId: res.body.activeWorkspaceId, email };
}

export const H = { 'x-requested-with': 'kdp-factory' };

export const briefBody = (over: Record<string, unknown> = {}, format: Record<string, unknown> = {}) => ({
  brief: {
    workingTitle: 'Field Notes for New Nurses',
    category: 'GUIDED_JOURNAL',
    targetReader: 'Newly qualified nurses in their first year',
    readerProblem: 'Processing difficult shifts and tracking what they learn',
    niche: 'nursing reflection',
    differentiation: 'Prompts follow the structure of a clinical debrief and include a weekly competency check-in specific to first-year nurses.',
    authorName: 'Jordan Reyes',
    contentType: 'LINED',
    ...over,
  },
  format: { format: 'PAPERBACK', trimId: '6x9', ink: 'BLACK_WHITE', paper: 'WHITE', bleed: false, targetPageCount: 100, ...format },
});

export async function drainJobs() {
  await (getRunner() as InlineRunner).drain();
}

export async function waitForJob(agent: Agent, jobId: string) {
  await drainJobs();
  const res = await agent.get(`/api/jobs/${jobId}`);
  return res.body as { status: string; error: string | null; logs: { message: string }[]; attempts: number; result: Record<string, unknown> };
}

export { prisma };
