import { afterEach, describe, expect, it, vi } from 'vitest';
import { promises as filesystem } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, writeFile, lstat, symlink, rename, realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createCore } from './index.js';

const roots: string[] = [];
async function temp() { const p = await realpath(await mkdtemp(path.join(os.tmpdir(), 'skm-core-'))); roots.push(p); return p; }
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(p => rm(p, { recursive: true, force: true }))); });

async function skill(dir: string, name = 'hello') {
  const source = path.join(dir, 'skills', name);
  await mkdir(source, { recursive: true });
  await writeFile(path.join(source, 'SKILL.md'), `---\nname: ${name}\ndescription: test skill\n---\n# ${name}\n`);
  await writeFile(path.join(source, 'helper.txt'), 'supporting file');
  return source;
}
async function apply(core: ReturnType<typeof createCore>, plan: Awaited<ReturnType<typeof core.operations.plan>>) {
  expect(plan.safe).toBe(true);
  const result = await core.operations.apply(plan.id);
  expect(result.success).toBe(true);
  return result;
}

describe('filesystem core', () => {
  it('registers a Skill, installs it for one project, inspects it, and safely uninstalls it', async () => {
    const root = await temp(), projectA = path.join(root, 'project A'), projectB = path.join(root, 'project B');
    await mkdir(projectA); await mkdir(projectB);
    const core = createCore({ dataDir: path.join(root, 'data') });
    const source = await skill(root);
    await apply(core, await core.registry.registerSkill(source));
    await apply(core, await core.projects.add(projectA));
    await apply(core, await core.projects.add(projectB));
    await apply(core, await core.projects.configure(projectA, { skills: ['hello'] }));
    await apply(core, await core.packages.install('hello', projectA));
    const link = path.join(projectA, '.agents', 'skills', 'hello');
    expect((await lstat(link)).isSymbolicLink()).toBe(true);
    expect((await core.projects.status(projectA)).skills[0].state).toBe('installed');
    expect((await core.projects.status(projectB)).skills).toEqual([]);
    await apply(core, await core.packages.remove('hello', projectA));
    expect(await lstat(link).catch(() => undefined)).toBeUndefined();
    expect(await readFile(path.join(source, 'SKILL.md'), 'utf8')).toContain('name: hello');
  });

  it('preserves an unmanaged target and reports the conflict', async () => {
    const root = await temp(), project = path.join(root, 'project'); await mkdir(project);
    const core = createCore({ dataDir: path.join(root, 'data') });
    await apply(core, await core.registry.registerSkill(await skill(root)));
    await apply(core, await core.projects.add(project));
    const target = path.join(project, '.agents', 'skills', 'hello');
    await mkdir(target, { recursive: true }); await writeFile(path.join(target, 'keep.txt'), 'keep');
    const plan = await core.packages.install('hello', project);
    expect(plan.safe).toBe(false);
    expect(plan.conflicts[0]).toContain('preserved');
    expect((await core.operations.apply(plan.id)).success).toBe(false);
    expect(await readFile(path.join(target, 'keep.txt'), 'utf8')).toBe('keep');
  });

  it('supports explicit copy installs and refuses to delete copied content after it changes', async () => {
    const root = await temp(), project = path.join(root, 'project'); await mkdir(project);
    const core = createCore({ dataDir: path.join(root, 'data') });
    await apply(core, await core.registry.registerSkill(await skill(root)));
    await apply(core, await core.projects.add(project));
    const plan = await core.packages.install('hello', project, { mode: 'copy' }); await apply(core, plan);
    const target = path.join(project, '.agents', 'skills', 'hello');
    await writeFile(path.join(target, 'helper.txt'), 'user edited');
    const removal = await core.packages.remove('hello', project);
    expect(removal.safe).toBe(false);
    expect((await core.operations.apply(removal.id)).success).toBe(false);
    expect(await readFile(path.join(target, 'helper.txt'), 'utf8')).toBe('user edited');
  });

  it('revalidates plans and refuses central source deletion while referenced', async () => {
    const root = await temp(), project = path.join(root, 'project'); await mkdir(project);
    const core = createCore({ dataDir: path.join(root, 'data') });
    await apply(core, await core.registry.registerSkill(await skill(root)));
    await apply(core, await core.projects.add(project));
    const config = await core.projects.configure(project, { skills: ['hello'] }); await apply(core, config);
    await expect(core.registry.removeSkill('hello', { deleteSource: true })).rejects.toThrow('referenced');
    const unreferenced = await core.projects.configure(project, { skills: [] }); await apply(core, unreferenced);
    const another = path.join(root, 'another'); await mkdir(another);
    const plan = await core.projects.add(another);
    await writeFile(path.join(another, '.skm.yaml'), 'version: 1\ninheritGlobal: false\nskills: []\n');
    expect((await core.operations.apply(plan.id)).failed?.step).toBe('revalidation');
  });

  it('resolves global inheritance into project status and detects broken links', async () => {
    const root = await temp(), project = path.join(root, 'project'); await mkdir(project);
    const core = createCore({ dataDir: path.join(root, 'data') });
    await apply(core, await core.registry.registerSkill(await skill(root)));
    await apply(core, await core.projects.add(project));
    await apply(core, await core.global.configure({ skills: ['hello'] }));
    expect((await core.projects.status(project)).skills.map(s => s.name)).toEqual(['hello']);
    const target = path.join(project, '.agents', 'skills', 'hello');
    await mkdir(path.dirname(target), { recursive: true }); await import('node:fs/promises').then(({ symlink }) => symlink(path.join(root, 'missing'), target));
    expect((await core.projects.status(project)).skills[0].state).toBe('broken-link');
  });

  it('plans multiple skill components in a composite package', async () => {
    const root = await temp(), project = path.join(root, 'project'); await mkdir(project);
    const core = createCore({ dataDir: path.join(root, 'data') });
    await apply(core, await core.registry.registerSkill(await skill(root, 'one')));
    await apply(core, await core.registry.registerSkill(await skill(root, 'two')));
    await apply(core, await core.projects.add(project));
    await apply(core, await core.registry.registerPackage({ name: 'combo', components: [{ type: 'skill', skill: 'one' }, { type: 'skill', skill: 'two' }] }));
    const plan = await core.packages.install('combo', project);
    expect(plan.steps.filter(s => s.action === 'symlink')).toHaveLength(2);
    await apply(core, plan);
  });
});

async function managedFixture() {
  const root = await temp(), project = path.join(root, 'project'), home = path.join(root, 'home'), dataDir = path.join(root, 'data');
  await mkdir(project); await mkdir(home);
  const core = createCore({ dataDir, homeDir: home }), source = await skill(root);
  await apply(core, await core.registry.registerSkill(source));
  await apply(core, await core.projects.add(project));
  return { root, project, home, dataDir, source, core, target: path.join(project, '.agents', 'skills', 'hello') };
}

describe('operation safety and recovery', () => {
  it('rejects altered saved plan steps before writing and validates plan IDs', async () => {
    const { core, project, dataDir, root } = await managedFixture();
    const plan = await core.packages.install('hello', project), file = path.join(dataDir, 'plans', `${plan.id}.json`);
    const saved = JSON.parse(await readFile(file, 'utf8'));
    saved.steps[0].path = path.join(root, 'unapproved');
    await writeFile(file, JSON.stringify(saved));
    expect(await core.operations.apply(plan.id)).toMatchObject({ success: false, completed: [], failed: { step: 'integrity' } });
    expect(await lstat(path.join(root, 'unapproved')).catch(() => undefined)).toBeUndefined();
    await expect(core.operations.get('../../outside')).rejects.toThrow();
  });

  it('catches malformed configuration during apply revalidation as a failed result', async () => {
    const { core, project, target } = await managedFixture();
    const plan = await core.packages.install('hello', project);
    await writeFile(path.join(project, '.skm.yaml'), 'version: 1\ninheritGlobal: nope\n');
    expect(await core.operations.apply(plan.id)).toMatchObject({ success: false, failed: { step: 'revalidation' } });
    expect(await lstat(target).catch(() => undefined)).toBeUndefined();
  });

  it('serializes concurrent applies and persistently replays a successful result', async () => {
    const { core, project, home, dataDir, target } = await managedFixture();
    const plan = await core.packages.install('hello', project);
    const another = createCore({ dataDir, homeDir: home });
    const results = await Promise.all([core.operations.apply(plan.id), another.operations.apply(plan.id)]);
    expect(results.every(result => result.success)).toBe(true);
    expect(results.filter(result => result.replayed)).toHaveLength(1);
    expect((await lstat(target)).isSymbolicLink()).toBe(true);
    expect(await createCore({ dataDir, homeDir: home }).operations.apply(plan.id)).toMatchObject({ success: true, replayed: true });
  });

  it('rolls back a partially installed package and safely retries the same plan', async () => {
    const { core, root, project } = await managedFixture();
    await apply(core, await core.registry.registerSkill(await skill(root, 'second')));
    await apply(core, await core.registry.registerPackage({ name: 'pair', components: [{ type: 'skill', skill: 'hello' }, { type: 'skill', skill: 'second' }] }));
    const plan = await core.packages.install('pair', project), original = filesystem.symlink.bind(filesystem);
    vi.spyOn(filesystem, 'symlink').mockImplementationOnce(original).mockRejectedValueOnce(new Error('Injected symlink failure; retry using copy mode if unsupported'));
    const failed = await core.operations.apply(plan.id);
    expect(failed).toMatchObject({ success: false, rolledBack: true, retryable: true });
    expect(failed.completed).toHaveLength(1);
    expect(await lstat(path.join(project, '.agents')).catch(() => undefined)).toBeUndefined();
    vi.restoreAllMocks();
    await apply(core, plan);
    expect((await lstat(path.join(project, '.agents', 'skills', 'second'))).isSymbolicLink()).toBe(true);
  });

  it('supports copy as the safe fallback after a symlink failure', async () => {
    const { core, project, target } = await managedFixture();
    const plan = await core.packages.install('hello', project);
    vi.spyOn(filesystem, 'symlink').mockRejectedValueOnce(Object.assign(new Error('Links are unavailable'), { code: 'EPERM' }));
    expect(await core.operations.apply(plan.id)).toMatchObject({ success: false, rolledBack: true });
    vi.restoreAllMocks();
    await apply(core, await core.packages.install('hello', project, { mode: 'copy' }));
    expect((await lstat(target)).isDirectory()).toBe(true);
    await apply(core, await core.packages.remove('hello', project));
    expect(await lstat(target).catch(() => undefined)).toBeUndefined();
  });

  it('rejects symlinked target, config and storage parents without modifying their destinations', async () => {
    const { core, project, root, dataDir } = await managedFixture();
    const outside = path.join(root, 'outside'); await mkdir(outside);
    await symlink(outside, path.join(project, '.agents'));
    await expect(core.packages.install('hello', project)).rejects.toThrow(/symlink/);
    expect(await filesystem.readdir(outside)).toEqual([]);
    await rm(path.join(project, '.agents'));
    const externalConfig = path.join(outside, 'config.yaml'); await writeFile(externalConfig, 'version: 1\ninheritGlobal: true\nskills: []\n');
    await rm(path.join(project, '.skm.yaml')); await symlink(externalConfig, path.join(project, '.skm.yaml'));
    await expect(core.projects.configure(project, { skills: [] })).rejects.toThrow(/symlink/);
    expect(await readFile(externalConfig, 'utf8')).toContain('inheritGlobal: true');
    await rename(dataDir, path.join(root, 'original-state')); await symlink(outside, dataDir);
    await expect(core.registry.list()).rejects.toThrow(/symlink/);
    expect(await filesystem.readdir(outside)).toEqual(['config.yaml']);
  });

  it('canonicalizes project aliases, rejects empty paths and detects swapped project ancestors by ID', async () => {
    const { core, project, root } = await managedFixture();
    const alias = path.join(root, 'project-alias'); await symlink(project, alias);
    expect((await core.projects.get(alias)).path).toBe(project);
    await expect(core.projects.add('')).rejects.toThrow(/nonempty/);
    await expect(core.registry.registerSkill('  ')).rejects.toThrow(/nonempty/);
    const nestedParent = path.join(root, 'nested'), nested = path.join(nestedParent, 'project');
    await mkdir(nested, { recursive: true }); await apply(core, await core.projects.add(nested));
    const id = (await core.projects.list()).find(item => item.path === nested)!.id;
    const elsewhere = path.join(root, 'elsewhere'); await mkdir(path.join(elsewhere, 'project'), { recursive: true });
    await rename(nestedParent, path.join(root, 'saved-nested')); await symlink(elsewhere, nestedParent);
    await expect(core.projects.get(id)).rejects.toThrow(/changed symlink parent/);
    expect(await filesystem.readdir(path.join(elsewhere, 'project'))).toEqual([]);
  });
});

describe('desired state, package lifecycle and diagnostics', () => {
  it('reports undesired owned installations, global drift and unmanaged collisions', async () => {
    const { core, project, home } = await managedFixture();
    await apply(core, await core.packages.install('hello', project));
    expect((await core.projects.status(project)).skills[0]).toMatchObject({ state: 'drift', desired: false });
    await mkdir(path.join(project, '.agents', 'skills', 'unmanaged'));
    expect((await core.projects.status(project)).skills.find(item => item.name === 'unmanaged')).toMatchObject({ state: 'conflict', desired: false });
    await apply(core, await core.packages.install('hello', 'global'));
    expect(await core.global.get()).toEqual({ skills: [] });
    expect((await core.global.status())[0]).toMatchObject({ state: 'drift', desired: false, expected: [path.join(home, '.agents', 'skills', 'hello')] });
    await apply(core, await core.global.configure({ skills: ['hello'] }));
    expect((await core.global.status())[0].state).toBe('installed');
    await apply(core, await core.projects.configure(project, { inheritGlobal: false }));
    expect((await core.projects.status(project)).skills[0]).toMatchObject({ state: 'drift', desired: false });
    await apply(core, await core.packages.remove('hello', 'global'));
  });

  it('updates Skill metadata and sources, detects old copies and refreshes only unchanged owned copies', async () => {
    const { core, project, source, target } = await managedFixture();
    await apply(core, await core.projects.configure(project, { skills: ['hello'] }));
    await apply(core, await core.packages.install('hello', project, { mode: 'copy' }));
    await writeFile(path.join(source, 'SKILL.md'), '---\nname: hello\nversion: 2\n---\nUpdated Skill\n');
    await apply(core, await core.registry.updateSkill('hello', source));
    expect((await core.registry.list())[0].version).toBe('2');
    expect((await core.projects.status(project)).skills[0].state).toBe('drift');
    const refresh = await core.packages.install('hello', project, { mode: 'copy' });
    expect(refresh.steps[0].action).toBe('replace-copy'); await apply(core, refresh);
    expect((await core.projects.status(project)).skills[0].state).toBe('installed');
    expect(await readFile(path.join(target, 'SKILL.md'), 'utf8')).toContain('Updated Skill');
    await writeFile(path.join(target, 'helper.txt'), Buffer.from([0xff]));
    const removal = await core.packages.remove('hello', project); expect(removal.safe).toBe(false);
    const reinstall = await core.packages.install('hello', project, { mode: 'copy' }); expect(reinstall.safe).toBe(false);
    await writeFile(path.join(source, 'SKILL.md'), '---\nname: renamed\n---\nDifferent Skill\n');
    await expect(core.registry.updateSkill('hello', source)).rejects.toThrow(/must match/);
  });

  it('hashes binary Skill assets without collapsing invalid UTF-8 bytes', async () => {
    const { core, project, source, target } = await managedFixture();
    await writeFile(path.join(source, 'asset.bin'), Buffer.from([0xff]));
    await apply(core, await core.registry.updateSkill('hello', source));
    await apply(core, await core.packages.install('hello', project, { mode: 'copy' }));
    await writeFile(path.join(target, 'asset.bin'), Buffer.from([0xfe]));
    expect((await core.packages.remove('hello', project)).safe).toBe(false);
  });

  it('allows safe owned uninstall after removing a registry entry', async () => {
    const { core, project, target, dataDir } = await managedFixture();
    await apply(core, await core.packages.install('hello', project));
    await apply(core, await core.registry.removeSkill('hello'));
    await apply(core, await core.packages.remove('hello', project));
    expect(await lstat(target).catch(() => undefined)).toBeUndefined();
    expect(await readFile(path.join(dataDir, 'resources', 'skills', 'hello', 'SKILL.md'), 'utf8')).toContain('hello');
  });

  it('inspects mixed package components and keeps configuration initialization explicit', async () => {
    const { core, project } = await managedFixture();
    const definition = { name: 'mixed', components: [{ type: 'skill' as const, skill: 'hello' }, { type: 'project-config' as const, files: { 'config/setup.txt': 'initialized' } }] };
    await apply(core, await core.registry.registerPackage(definition));
    const install = await core.packages.install('mixed', project); expect(install.preserves.join(' ')).toContain('explicit initialization'); await apply(core, install);
    expect(await lstat(path.join(project, 'config/setup.txt')).catch(() => undefined)).toBeUndefined();
    const inspection = await core.registry.inspect('mixed', project); expect(inspection.item.name).toBe('mixed'); expect(inspection.components).toHaveLength(2); expect(inspection.components[1].state).toBe('missing');
    await apply(core, await core.packages.init('mixed', project));
    expect((await core.packages.inspect('mixed', project)).components[1].state).toBe('installed');
    await apply(core, await core.packages.remove('mixed', project)); expect(await readFile(path.join(project, 'config/setup.txt'), 'utf8')).toBe('initialized');
    expect((await core.packages.init('mixed', project)).safe).toBe(false);
    await apply(core, await core.registry.registerPackage({ name: 'external', components: [{ type: 'cli-tool', package: '@fixture/tool', packageManager: 'npm' }] }));
    expect((await core.registry.inspect('external')).components[0].state).toBe('disabled');
    const external = await core.packages.install('external', project); expect(external.safe).toBe(false); expect(external.externalCommands).toEqual([['npm', 'install', '--global', '@fixture/tool']]);
    expect((await core.operations.apply(external.id)).success).toBe(false);
  });

  it('reports malformed and missing config through doctor without throwing', async () => {
    const { core, project, dataDir } = await managedFixture();
    await writeFile(path.join(project, '.skm.yaml'), 'version: 1\nunsupported: true\n');
    expect((await core.doctor()).map(item => item.code)).toContain('invalid-project-config');
    await rm(path.join(project, '.skm.yaml'));
    expect((await core.doctor()).map(item => item.code)).toContain('missing-project-config');
    await writeFile(path.join(dataDir, 'global.yaml'), 'skills: wrong\n');
    expect((await core.doctor()).map(item => item.code)).toContain('invalid-global-config');
    await writeFile(path.join(dataDir, 'registry.yaml'), 'not: a registry\n');
    expect((await core.doctor()).map(item => item.code)).toContain('invalid-registry');
  });
});
