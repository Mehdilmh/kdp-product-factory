import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { app, briefBody, H, prisma, signUp } from './helpers';

describe('authentication and sessions', () => {
  it('registers, reads the session, logs out', async () => {
    const { agent, email } = await signUp('Alice');
    const me = await agent.get('/api/auth/me');
    expect(me.status).toBe(200);
    expect(me.body.user.email).toBe(email);
    expect(me.body.workspaces[0].role).toBe('OWNER');
    expect((await agent.post('/api/auth/logout').set(H)).status).toBe(200);
    expect((await agent.get('/api/auth/me')).status).toBe(401);
  });

  it('stores only a scrypt hash and an httpOnly session cookie', async () => {
    const agent = request.agent(app);
    const email = `cookie-${Date.now()}@test.local`;
    const res = await agent.post('/api/auth/register').set(H).send({ email, name: 'C', password: 'correct horse battery' });
    expect(res.headers['set-cookie'][0]).toMatch(/kdp_session=.*HttpOnly/);
    expect(res.headers['set-cookie'][0]).toMatch(/SameSite=Lax/);
    const user = await prisma.user.findUniqueOrThrow({ where: { email } });
    expect(user.passwordHash.startsWith('scrypt$')).toBe(true);
    expect(user.passwordHash).not.toContain('correct horse');
    const session = await prisma.session.findFirstOrThrow({ where: { userId: user.id } });
    expect(res.headers['set-cookie'][0]).not.toContain(session.tokenHash);
  });

  it('rejects wrong passwords, weak passwords, and duplicate accounts', async () => {
    const { email } = await signUp('Bob');
    expect((await request(app).post('/api/auth/login').set(H).send({ email, password: 'nope-nope-nope' })).status).toBe(401);
    expect((await request(app).post('/api/auth/login').set(H).send({ email, password: 'correct horse battery' })).status).toBe(200);
    expect((await request(app).post('/api/auth/register').set(H).send({ email, name: 'B', password: 'correct horse battery' })).status).toBe(409);
    expect((await request(app).post('/api/auth/register').set(H).send({ email: 'x@y.z', name: 'B', password: 'short' })).status).toBe(400);
  });

  it('requires the CSRF header on state-changing requests', async () => {
    const { agent } = await signUp('Csrf');
    const res = await agent.post('/api/projects').send(briefBody());
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('CSRF');
  });

  it('rejects anonymous access to workspace data', async () => {
    expect((await request(app).get('/api/projects')).status).toBe(401);
  });
});

describe('workspace isolation and roles', () => {
  it('prevents access to another workspace’s projects, files, jobs, and exports', async () => {
    const a = await signUp('Owner A');
    const b = await signUp('Intruder B');
    const created = await a.agent.post('/api/projects').set(H).send(briefBody());
    expect(created.status).toBe(201);
    const pid = created.body.id;

    // Upload an asset as A.
    const png = Buffer.from('89504E470D0A1A0A0000000D4948445200000001000000010806000000', 'hex');
    const tiny = Buffer.concat([png, Buffer.alloc(40)]);
    const asset = await a.agent.post('/api/assets').set(H).attach('file', tiny, 'x.png');
    expect(asset.status).toBe(201);

    const job = await a.agent.post(`/api/projects/${pid}/validate`).set(H);
    expect(job.status).toBe(202);

    // B sees nothing and can change nothing.
    expect((await b.agent.get('/api/projects')).body.total).toBe(0);
    for (const path of [`/api/projects/${pid}`, `/api/projects/${pid}/interior`, `/api/projects/${pid}/covers`, `/api/projects/${pid}/metadata`, `/api/projects/${pid}/exports`, `/api/assets/${asset.body.id}/file`, `/api/jobs/${job.body.id}`, `/api/projects/${pid}/versions`]) {
      const r = await b.agent.get(path);
      expect(r.status, path).toBe(404);
    }
    expect((await b.agent.patch(`/api/projects/${pid}`).set(H).send({ title: 'pwned' })).status).toBe(404);
    expect((await b.agent.delete(`/api/projects/${pid}`).set(H)).status).toBe(404);
    expect((await b.agent.post(`/api/projects/${pid}/exports`).set(H).send({ kinds: ['PROJECT_JSON'] })).status).toBe(404);
    expect((await b.agent.post(`/api/jobs/${job.body.id}/cancel`).set(H)).status).toBe(404);
    // B cannot activate A's workspace.
    expect((await b.agent.post(`/api/workspaces/${a.workspaceId}/activate`).set(H)).status).toBe(404);
    expect((await prisma.project.findUniqueOrThrow({ where: { id: pid } })).title).toBe('Field Notes for New Nurses');
  });

  it('enforces role-based permissions within a workspace', async () => {
    const owner = await signUp('Owner');
    const viewer = await signUp('Viewer');
    expect((await owner.agent.post('/api/workspace/members').set(H).send({ email: viewer.email, role: 'VIEWER' })).status).toBe(200);
    expect((await viewer.agent.post(`/api/workspaces/${owner.workspaceId}/activate`).set(H)).status).toBe(200);
    const p = await owner.agent.post('/api/projects').set(H).send(briefBody());
    expect((await viewer.agent.get(`/api/projects/${p.body.id}`)).status).toBe(200);
    expect((await viewer.agent.patch(`/api/projects/${p.body.id}`).set(H).send({ title: 'x' })).status).toBe(403);
    expect((await viewer.agent.post('/api/providers').set(H).send({ kind: 'TEXT', provider: 'gemini', model: 'm' })).status).toBe(403);
    expect((await viewer.agent.patch('/api/workspace').set(H).send({ dailyJobLimit: 1 })).status).toBe(403);
  });
});

describe('provider secrets', () => {
  it('encrypts API keys at rest and never returns them', async () => {
    const { agent, workspaceId } = await signUp('Keys');
    const res = await agent.post('/api/providers').set(H).send({ kind: 'TEXT', provider: 'gemini', model: 'gemini-2.5-flash', apiKey: 'AIzaSy-super-secret-key-1234' });
    expect(res.status).toBe(201);
    expect(JSON.stringify(res.body)).not.toContain('super-secret');
    expect(res.body.hasApiKey).toBe(true);
    expect(res.body.apiKeyLast4).toBe('1234');
    const row = await prisma.providerConfig.findFirstOrThrow({ where: { workspaceId } });
    expect(row.encryptedApiKey).toMatch(/^v1:/);
    expect(row.encryptedApiKey).not.toContain('super-secret');
    const list = await agent.get('/api/providers');
    expect(JSON.stringify(list.body)).not.toContain('super-secret');
    const audit = await prisma.auditLog.findMany({ where: { workspaceId } });
    expect(JSON.stringify(audit)).not.toContain('super-secret');
  });
});

describe('uploads', () => {
  it('validates content type by magic bytes and rejects SVG/HTML', async () => {
    const { agent } = await signUp('Up');
    const svg = await agent.post('/api/assets').set(H).attach('file', Buffer.from('<svg onload="alert(1)"></svg>'), { filename: 'evil.png', contentType: 'image/png' });
    expect(svg.status).toBe(400);
    const html = await agent.post('/api/assets').set(H).attach('file', Buffer.from('<html><script>x</script></html>'), 'x.pdf');
    expect(html.status).toBe(400);
  });
});
