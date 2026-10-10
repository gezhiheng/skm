import { execFile as execFileCallback } from 'node:child_process';
import { access, lstat, mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import type { ApplyResult, OperationPlan, ProjectStatus, RegistryInspection } from '@skm/core';

const execFile = promisify(execFileCallback);
const binary = fileURLToPath(new URL('../dist/index.js', import.meta.url));
const tempDirs: string[] = [];

async function temporaryDirectory() {
  const dir = await realpath(await mkdtemp(path.join(tmpdir(), 'skm-cli-')));
  tempDirs.push(dir);
  return dir;
}

async function run(dataDir: string, ...args: string[]) {
  const { stdout } = await execFile(process.execPath, [binary, '--data-dir', dataDir, ...args]);
  return stdout.trim();
}

const json = async <T>(dataDir: string, ...args: string[]) => JSON.parse(await run(dataDir, '--json', ...args)) as T;

async function apply(dataDir: string, ...args: string[]) {
  const plan = await json<OperationPlan>(dataDir, ...args);
  expect(plan.safe).toBe(true);
  expect(await json<ApplyResult>(dataDir, 'apply', plan.id)).toMatchObject({ planId: plan.id, success: true });
  return plan;
}

async function fixture() {
  const root = await temporaryDirectory();
  const dataDir = path.join(root, 'state');
  const project = path.join(root, 'project with spaces');
  const source = path.join(root, 'local skill');
  await Promise.all([mkdir(project), mkdir(source)]);
  await writeFile(path.join(source, 'SKILL.md'), '---\nname: demo-skill\ndescription: Test skill\nversion: 1.0.0\n---\n\nUse this test skill.\n');
  await apply(dataDir, 'skill', 'register', source);
  await apply(dataDir, 'project', 'add', project);
  return { root, dataDir, project, source };
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

describe('skm CLI', () => {
  it('plans project registration, applies by ID, and reports the registered project as JSON', async () => {
    const dataDir = await temporaryDirectory();
    const project = path.join(dataDir, 'project');
    await mkdir(project);

    const plan = JSON.parse(await run(dataDir, '--json', 'project', 'add', project)) as { id: string; steps: unknown[] };
    expect(plan.steps).toHaveLength(2);
    expect(await json(dataDir, 'show-plan', plan.id)).toEqual(plan);

    const applied = JSON.parse(await run(dataDir, '--json', 'apply', plan.id)) as { success: boolean };
    expect(applied.success).toBe(true);
    expect(await json<ApplyResult>(dataDir, 'apply', plan.id)).toMatchObject({ success: true, replayed: true });

    const projects = JSON.parse(await run(dataDir, '--json', 'project', 'list')) as Array<{ path: string }>;
    expect(projects.map(item => item.path)).toEqual([project]);
  });

  it('copies a selected Skill, reports real status, and safely removes it without affecting another project or its sources', async () => {
    const { root, dataDir, project, source } = await fixture();
    const otherProject = path.join(root, 'other project');
    await mkdir(otherProject);
    await apply(dataDir, 'project', 'add', otherProject);
    await apply(dataDir, 'project', 'config', project, '--inherit-global', 'false', '--skills', 'demo-skill');

    const record = (await json<RegistryInspection>(dataDir, 'inspect', 'demo-skill')).item;
    expect(record).toMatchObject({ type: 'skill', name: 'demo-skill', description: 'Test skill', version: '1.0.0' });
    if (record.type !== 'skill') throw new Error('Expected the registered Skill');
    const target = path.join(project, '.agents', 'skills', 'demo-skill');
    const plan = await apply(dataDir, 'skill', 'add', 'demo-skill', '--project', project, '--mode', 'copy');
    expect(plan.steps[0].action).toBe('copy');
    expect((await lstat(target)).isSymbolicLink()).toBe(false);
    const status = await json<ProjectStatus>(dataDir, 'project', 'status', project);
    expect(status.skills).toEqual([expect.objectContaining({ name: 'demo-skill', state: 'installed', expected: [target], actual: [target] })]);
    expect((await json<ProjectStatus>(dataDir, 'project', 'status', otherProject)).skills).toEqual([]);
    await expect(access(path.join(otherProject, '.agents', 'skills', 'demo-skill'))).rejects.toThrow();

    await apply(dataDir, 'skill', 'remove', 'demo-skill', '--project', project);
    await expect(access(target)).rejects.toThrow();
    expect(await readFile(path.join(record.source, 'SKILL.md'), 'utf8')).toBe(await readFile(path.join(source, 'SKILL.md'), 'utf8'));
    expect((await json<ProjectStatus>(dataDir, 'project', 'status', project)).skills[0].state).toBe('missing');
    await apply(dataDir, 'project', 'config', project, '--skills', '');
    expect((await json<ProjectStatus>(dataDir, 'project', 'status', project)).skills).toEqual([]);
  });

  it('keeps package initialization separate and preserves initialized files during package uninstall', async () => {
    const { root, dataDir, project } = await fixture();
    const definition = path.join(root, 'package.json');
    await writeFile(definition, JSON.stringify({ name: 'demo-suite', components: [{ type: 'skill', skill: 'demo-skill' }, { type: 'project-config', files: { 'demo-config.json': '{"enabled":true}\n' } }] }));
    await apply(dataDir, 'package', 'register', definition);
    const inspected = await json<RegistryInspection>(dataDir, 'inspect', 'demo-suite');
    expect(inspected.components).toHaveLength(2);
    const install = await apply(dataDir, 'package', 'install', 'demo-suite', '--project', project, '--mode', 'copy');
    expect(install.preserves.join('\n')).toMatch(/explicit initialization/);
    await expect(access(path.join(project, 'demo-config.json'))).rejects.toThrow();
    await apply(dataDir, 'package', 'init', 'demo-suite', '--project', project);
    await apply(dataDir, 'package', 'uninstall', 'demo-suite', '--project', project);
    expect(await readFile(path.join(project, 'demo-config.json'), 'utf8')).toBe('{"enabled":true}\n');
    await expect(access(path.join(project, '.agents', 'skills', 'demo-skill'))).rejects.toThrow();
  });

  it('updates a managed Skill through a reviewed plan and inspects its installed symlink', async () => {
    const { root, dataDir, project, source } = await fixture();
    await apply(dataDir, 'project', 'config', project, '--skills', 'demo-skill');
    await apply(dataDir, 'skill', 'add', 'demo-skill', '--project', project);
    const target = path.join(project, '.agents', 'skills', 'demo-skill');
    expect((await lstat(target)).isSymbolicLink()).toBe(true);
    const inspected = await json<RegistryInspection>(dataDir, 'inspect', 'demo-skill', '--project', project);
    expect(inspected.components).toEqual([expect.objectContaining({ state: 'installed', paths: [target] })]);

    const updateSource = path.join(root, 'updated skill');
    await mkdir(updateSource);
    await writeFile(path.join(updateSource, 'SKILL.md'), '---\nname: demo-skill\ndescription: Updated skill\nversion: 2.0.0\n---\n\nUse this updated test skill.\n');
    const update = await json<OperationPlan>(dataDir, 'skill', 'update', 'demo-skill', updateSource);
    expect(update.safe).toBe(true);
    expect(await readFile(path.join(target, 'SKILL.md'), 'utf8')).toContain('version: 1.0.0');
    expect(await json<ApplyResult>(dataDir, 'apply', update.id)).toMatchObject({ success: true });
    expect((await json<RegistryInspection>(dataDir, 'inspect', 'demo-skill')).item).toMatchObject({ version: '2.0.0', description: 'Updated skill' });
    expect(await readFile(path.join(target, 'SKILL.md'), 'utf8')).toContain('version: 2.0.0');
    expect(await readFile(path.join(source, 'SKILL.md'), 'utf8')).toContain('version: 1.0.0');
  });

  it('keeps global desired selection separate and applies project inheritance settings', async () => {
    const { dataDir, project } = await fixture();
    expect(await json(dataDir, 'global', 'config')).toEqual({ skills: [] });
    await apply(dataDir, 'global', 'config', '--skills', 'demo-skill');
    expect(await json(dataDir, 'global', 'config')).toEqual({ skills: ['demo-skill'] });
    expect((await json<ProjectStatus>(dataDir, 'project', 'status', project)).skills).toEqual([expect.objectContaining({ name: 'demo-skill', state: 'missing' })]);
    expect(await json(dataDir, 'project', 'config', project)).toMatchObject({ skills: [], inheritGlobal: true });
    await apply(dataDir, 'project', 'config', project, '--inherit-global', 'false');
    expect((await json<ProjectStatus>(dataDir, 'project', 'status', project)).skills).toEqual([]);
  });

  it('reports invalid project configuration and rejects unsafe target selection', async () => {
    const { dataDir, project } = await fixture();
    await writeFile(path.join(project, '.skm.yaml'), 'version: 1\ninheritGlobal: wrong\nskills: []\n');
    await expect(run(dataDir, 'project', 'status', project)).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('Invalid .skm.yaml') });
    await expect(run(dataDir, 'package', 'install', 'demo-skill', '--project', project, '--global')).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('Choose either --project or --global') });
    await expect(run(dataDir, 'plan', 'skill:install', '--args', '{bad json')).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('Invalid JSON') });
    await expect(run(dataDir, 'ui', '--host', '0.0.0.0')).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('SKM is a local service') });
  });

  it('returns a failed JSON result for a stale plan and preserves the conflicting directory', async () => {
    const { dataDir, project } = await fixture();
    const plan = await json<OperationPlan>(dataDir, 'skill', 'add', 'demo-skill', '--project', project);
    const target = path.join(project, '.agents', 'skills', 'demo-skill');
    await mkdir(target, { recursive: true });
    await writeFile(path.join(target, 'unmanaged.txt'), 'keep me');
    let result: ApplyResult | undefined;
    try { await run(dataDir, '--json', 'apply', plan.id); }
    catch (error) {
      const failed = error as { code: number; stdout: string };
      expect(failed.code).toBe(1);
      result = JSON.parse(failed.stdout) as ApplyResult;
    }
    expect(result).toMatchObject({ success: false, completed: [] });
    expect(result?.failed?.error).toMatch(/stale|changed/i);
    expect(await readFile(path.join(target, 'unmanaged.txt'), 'utf8')).toBe('keep me');
  });
});
