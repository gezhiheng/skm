import { mkdtemp, mkdir, readFile, readlink, realpath, lstat, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildServer } from './server.js';
import { createCore } from '@skm/core';

const roots: string[] = [];
async function tempDir() {
  const dir = await realpath(await mkdtemp(path.join(tmpdir(), 'skm-api-')));
  roots.push(dir);
  return dir;
}
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe('Fastify API over shared Core', () => {
  it('plans and applies project-scoped skill installation through Core', async () => {
    const root = await tempDir();
    const dataDir = path.join(root, 'state');
    const source = path.join(root, 'source');
    const projectA = path.join(root, 'project-a');
    const projectB = path.join(root, 'project-b');
    await Promise.all([mkdir(source), mkdir(projectA), mkdir(projectB)]);
    await writeFile(path.join(source, 'SKILL.md'), '---\nname: api-review\ndescription: Test fixture\n---\nReview carefully.\n');
    const app = await buildServer({ dataDir, serveWeb: false });
    try {
      const registration = await app.inject({ method: 'POST', url: '/api/skills/register', payload: { path: source } });
      expect(registration.statusCode).toBe(201);
      const registrationPlan = registration.json();
      const registrationApply = await app.inject({ method: 'POST', url: `/api/plans/${registrationPlan.id}/apply`, payload: { confirmed: true } });
      expect(registrationApply.json().success).toBe(true);

      const addProject = await app.inject({ method: 'POST', url: '/api/projects', payload: { path: projectA } });
      const projectApply = await app.inject({ method: 'POST', url: `/api/plans/${addProject.json().id}/apply`, payload: { confirmed: true } });
      expect(projectApply.json().success).toBe(true);
      const secondProject = await app.inject({ method: 'POST', url: '/api/projects', payload: { path: projectB } });
      expect((await app.inject({ method: 'POST', url: `/api/plans/${secondProject.json().id}/apply`, payload: { confirmed: true } })).json().success).toBe(true);

      const projectList = await app.inject({ method: 'GET', url: '/api/projects' });
      expect(projectList.json().items).toHaveLength(2);
      const projectId = projectList.json().items[0].id as string;
      const configPlan = await app.inject({ method: 'PUT', url: `/api/projects/${projectId}/config`, payload: { inheritGlobal: false, skills: ['api-review'] } });
      expect((await app.inject({ method: 'POST', url: `/api/plans/${configPlan.json().id}/apply`, payload: { confirmed: true } })).json().success).toBe(true);
      const plan = await app.inject({ method: 'POST', url: '/api/plans', payload: { action: 'installSkill', name: 'api-review', project: projectA } });
      expect(plan.statusCode).toBe(201);
      expect(plan.json().steps.some((step: { action: string }) => step.action === 'symlink')).toBe(true);
      const missingConfirmation = await app.inject({ method: 'POST', url: `/api/plans/${plan.json().id}/apply`, payload: {} });
      expect(missingConfirmation.statusCode).toBe(400);
      const applied = await app.inject({ method: 'POST', url: `/api/plans/${plan.json().id}/apply`, payload: { confirmed: true } });
      expect(applied.json().success).toBe(true);
      expect(await readlink(path.join(projectA, '.agents', 'skills', 'api-review'))).toBe(path.join(dataDir, 'resources', 'skills', 'api-review'));
      const projectStatus = await app.inject({ method: 'GET', url: `/api/projects/${projectId}/status` });
      expect(projectStatus.statusCode).toBe(200);
      expect(projectStatus.json().skills[0].state).toBe('installed');
      const inspection = await app.inject({ url: `/api/catalog/api-review?project=${encodeURIComponent(projectA)}` });
      expect(inspection.statusCode).toBe(200);
      expect(inspection.json()).toMatchObject({ item: { type: 'skill', name: 'api-review' }, components: [{ state: 'installed' }] });
      expect(inspection.json().components[0].paths).toContain(path.join(projectA, '.agents', 'skills', 'api-review'));

      const status = await app.inject({ method: 'GET', url: '/api/status' });
      expect(status.statusCode).toBe(200);
      expect(status.json().counts.projects).toBe(2);
      expect(projectStatus.json().project.path).toBe(projectA);
      expect(await lstat(path.join(projectB, '.agents', 'skills', 'api-review')).catch(() => undefined)).toBeUndefined();

      // The API and other consumers can apply each other's plans without translation.
      const core = createCore({ dataDir });
      const removal = await core.packages.remove('api-review', projectA);
      expect((await app.inject({ method: 'POST', url: `/api/plans/${removal.id}/apply`, payload: { confirmed: true } })).json().success).toBe(true);
      expect(await readFile(path.join(dataDir, 'resources', 'skills', 'api-review', 'SKILL.md'), 'utf8')).toContain('api-review');
    } finally {
      await app.close();
    }
  });

  it('rejects cross-origin, DNS-rebinding, remote, and non-JSON mutations', async () => {
    const app = await buildServer({ dataDir: path.join(await tempDir(), 'state'), serveWeb: false });
    try {
      expect((await app.inject({ url: '/api/health', headers: { host: 'localhost:4318', origin: 'http://localhost:4318' } })).statusCode).toBe(200);
      expect((await app.inject({ url: '/api/health', headers: { host: 'attacker.example' } })).statusCode).toBe(403);
      expect((await app.inject({ url: '/api/health', headers: { origin: 'https://attacker.example' } })).statusCode).toBe(403);
      expect((await app.inject({ url: '/api/health', headers: { origin: 'null' } })).statusCode).toBe(403);
      expect((await app.inject({ url: '/api/health', remoteAddress: '192.0.2.1' })).statusCode).toBe(403);
      expect((await app.inject({ url: '/api/health', headers: { 'sec-fetch-site': 'cross-site' } })).statusCode).toBe(403);
      expect((await app.inject({ method: 'POST', url: '/api/projects', payload: 'path=/tmp', headers: { 'content-type': 'text/plain' } })).statusCode).toBe(415);
      expect((await app.inject({ method: 'POST', url: '/api/plans', payload: { action: 'arbitraryShell', command: 'echo dangerous' } })).statusCode).toBe(400);
      expect((await app.inject({ method: 'POST', url: '/api/projects', payload: '{', headers: { 'content-type': 'application/json' } })).statusCode).toBe(400);
    } finally { await app.close(); }
  });

  it('allows only explicitly configured development origins', async () => {
    const app = await buildServer({ dataDir: path.join(await tempDir(), 'state'), serveWeb: false, allowedOrigins: ['http://localhost:5173'] });
    try {
      const response = await app.inject({ url: '/api/health', headers: { host: '127.0.0.1:4318', origin: 'http://localhost:5173' } });
      expect(response.statusCode).toBe(200);
      expect(response.headers['access-control-allow-origin']).toBeUndefined();
      expect((await app.inject({ url: '/api/health', headers: { origin: 'http://localhost:5174' } })).statusCode).toBe(403);
    } finally { await app.close(); }
  });

  it('shares desired global config, updates local Skill sources, and keeps package initialization explicit', async () => {
    const root = await tempDir(), dataDir = path.join(root, 'state'), source = path.join(root, 'source'), project = path.join(root, 'project');
    await Promise.all([mkdir(source), mkdir(project)]);
    await writeFile(path.join(source, 'SKILL.md'), '---\nname: workflow\nversion: "1"\n---\nfirst');
    const app = await buildServer({ dataDir, serveWeb: false });
    const core = createCore({ dataDir });
    const apply = async (plan: { id: string }) => expect((await app.inject({ method: 'POST', url: `/api/plans/${plan.id}/apply`, payload: { confirmed: true } })).json().success).toBe(true);
    try {
      await apply((await app.inject({ method: 'POST', url: '/api/skills/register', payload: { path: source } })).json());
      await apply(await core.projects.add(project));
      await apply((await app.inject({ method: 'PUT', url: '/api/global/config', payload: { skills: ['workflow'] } })).json());
      expect((await app.inject({ url: '/api/global/config' })).json()).toEqual({ skills: ['workflow'] });
      expect((await core.projects.status(project)).skills.map(skill => skill.name)).toEqual(['workflow']);
      await writeFile(path.join(source, 'SKILL.md'), '---\nname: workflow\nversion: "2"\n---\nupdated');
      await apply((await app.inject({ method: 'POST', url: '/api/plans', payload: { action: 'updateSkill', name: 'workflow', path: source } })).json());
      expect((await core.registry.list())[0].version).toBe('2');
      const definition = { name: 'local-suite', components: [{ type: 'skill', skill: 'workflow' }, { type: 'project-config', files: { 'notes/setup.md': 'fixture initialization' } }] };
      await apply((await app.inject({ method: 'POST', url: '/api/packages/register', payload: definition })).json());
      const inspection = await app.inject({ url: `/api/catalog/local-suite?project=${encodeURIComponent(project)}` });
      expect(inspection.statusCode).toBe(200);
      expect(inspection.json().components.map((entry: { component: { type: string } }) => entry.component.type)).toEqual(['skill', 'project-config']);
      await apply((await app.inject({ method: 'POST', url: '/api/plans', payload: { action: 'installPackage', name: 'local-suite', project, mode: 'copy' } })).json());
      expect(await lstat(path.join(project, 'notes/setup.md')).catch(() => undefined)).toBeUndefined();
      await apply((await app.inject({ method: 'POST', url: '/api/plans', payload: { action: 'initPackage', name: 'local-suite', project } })).json());
      expect(await readFile(path.join(project, 'notes/setup.md'), 'utf8')).toBe('fixture initialization');
      expect((await app.inject({ method: 'PUT', url: `/api/projects/${(await core.projects.list())[0].id}/config`, payload: { inheritGlobal: true, skills: [], undocumented: true } })).statusCode).toBe(400);
    } finally { await app.close(); }
  });
});
