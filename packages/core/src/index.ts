import { randomUUID, randomBytes, createHmac, timingSafeEqual } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parse, stringify } from 'yaml';
import { z } from 'zod';
import { defaultAgentAdapter } from './agent-adapter.js';
import { componentAdapter } from './component-adapters.js';
import { atomicWrite, canonicalDirectory, ensureDirectory, errorMessage, exclusiveWrite, fingerprint, guard, inside, lstatOptional, missing, nonemptyPath, parentIdentities, readFile, storageDirectory, treeHash } from './filesystem.js';
import { withLock } from './lock.js';
import { recoverTransaction, runTransaction, type Journal, type TransactionStore } from './transaction.js';
import { packageSchema, projectConfigSchema, type AgentAdapter, type ApplyResult, type Component, type ComponentContext, type ComponentInspection, type ComponentPlan, type Diagnostic, type OperationPlan, type PlanStep, type ProjectConfig, type ProjectRecord, type ProjectStatus, type RegistryInspection, type RegistryItem, type SkillRecord, type SkillStatus, type ToolPackage } from './types.js';

export * from './types.js';
export { defaultAgentAdapter } from './agent-adapter.js';
export { skillComponentAdapter, configComponentAdapter, disabledCliComponentAdapter } from './component-adapters.js';

const nameSchema = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/, 'Invalid resource name');
const namesSchema = z.array(nameSchema).transform(names => [...new Set(names)]);
const registrySchema = z.array(z.union([
  z.object({ type: z.literal('skill'), name: nameSchema, description: z.string().optional(), version: z.string().optional(), source: z.string().min(1), registeredAt: z.string() }).strict(),
  packageSchema.extend({ type: z.literal('package'), registeredAt: z.string() }),
]));
const projectsSchema = z.array(z.object({ id: z.string(), path: z.string().min(1), addedAt: z.string() }).strict());
const ownershipSchema = z.record(z.object({ skill: nameSchema, source: z.string().min(1), mode: z.enum(['symlink', 'copy']), project: z.string().min(1), copyHash: z.string().optional() }).strict());
const globalSchema = z.object({ skills: namesSchema.default([]) }).strict();
const frontmatterSchema = z.object({ name: nameSchema.optional(), description: z.string().optional(), version: z.union([z.string(), z.number()]).transform(String).optional() }).passthrough();
const planSchema = z.object({
  id: z.string().uuid(), action: z.string(), args: z.record(z.unknown()), createdAt: z.string(), safe: z.boolean(), affectedProject: z.string().optional(), component: z.string().optional(),
  steps: z.array(z.object({ action: z.enum(['copy', 'replace-copy', 'symlink', 'write', 'remove', 'remove-link']), path: z.string(), source: z.string().optional(), content: z.string().optional(), expected: z.string(), description: z.string() }).strict()),
  conflicts: z.array(z.string()), preserves: z.array(z.string()), externalCommands: z.array(z.array(z.string())), assumptions: z.array(z.object({ path: z.string(), fingerprint: z.string() }).strict()),
}).strict();
const resultSchema = z.object({ planId: z.string().uuid(), success: z.boolean(), completed: z.array(z.string()), failed: z.object({ step: z.string(), error: z.string() }).optional(), rolledBack: z.boolean().optional(), retryable: z.boolean().optional(), replayed: z.boolean().optional(), warnings: z.array(z.string()).optional() }).strict();

export interface CoreOptions { dataDir?: string; agentAdapter?: AgentAdapter; homeDir?: string }
export interface Core {
  registry: {
    list(query?: string): Promise<RegistryItem[]>;
    search(query: string): Promise<RegistryItem[]>;
    inspect(name: string, project?: string): Promise<RegistryInspection>;
    registerSkill(source: string): Promise<OperationPlan>;
    updateSkill(name: string, source: string): Promise<OperationPlan>;
    removeSkill(name: string, options?: { deleteSource?: boolean }): Promise<OperationPlan>;
    registerPackage(definition: ToolPackage): Promise<OperationPlan>;
  };
  catalog: Core['registry'];
  projects: {
    add(projectPath: string): Promise<OperationPlan>;
    list(): Promise<ProjectRecord[]>;
    get(pathOrId: string): Promise<ProjectRecord & { config: ProjectConfig }>;
    status(pathOrId: string): Promise<ProjectStatus>;
    configure(pathOrId: string, config: Partial<ProjectConfig>): Promise<OperationPlan>;
  };
  packages: {
    install(name: string, project: string, options?: { mode?: 'symlink' | 'copy' }): Promise<OperationPlan>;
    remove(name: string, project: string): Promise<OperationPlan>;
    init(name: string, project: string): Promise<OperationPlan>;
    inspect(name: string, project?: string): Promise<RegistryInspection>;
  };
  operations: { plan(action: string, args: Record<string, unknown>): Promise<OperationPlan>; apply(planId: string): Promise<ApplyResult>; get(planId: string): Promise<OperationPlan> };
  global: { get(): Promise<{ skills: string[] }>; configure(config: { skills: string[] }): Promise<OperationPlan>; status(): Promise<SkillStatus[]> };
  doctor(): Promise<Diagnostic[]>;
}

export function createCore(options: CoreOptions = {}): Core {
  const requestedData = nonemptyPath(options.dataDir ?? process.env.SKM_HOME ?? path.join(os.homedir(), '.skm'), 'Data directory');
  const requestedHome = nonemptyPath(options.homeDir ?? os.homedir(), 'Home directory');
  const agent = options.agentAdapter ?? defaultAgentAdapter;
  // ponytail: one data-directory lock serializes operations; split by project only if throughput requires it.
  let initialized: Promise<{ root: string; home: string }> | undefined;
  const initialize = async () => {
    const state = await (initialized ??= (async () => {
    const root = await storageDirectory(requestedData), home = await canonicalDirectory(requestedHome, 'Home');
    await ensureDirectory(path.join(root, 'plans'), root);
    await ensureDirectory(path.join(root, 'results'), root);
    await ensureDirectory(path.join(root, 'journals'), root);
    return { root, home };
    })().catch(error => { initialized = undefined; throw error; }));
    if (await canonicalDirectory(state.root, 'Data') !== state.root || await canonicalDirectory(state.home, 'Home') !== state.home) throw new Error('An authorized storage or home directory now resolves through a changed symlink parent');
    await guard(state.root, state.root);
    return state;
  };
  const storePath = (root: string, name: string) => path.join(root, name);
  const registryPath = (root: string) => storePath(root, 'registry.yaml');
  const projectsPath = (root: string) => storePath(root, 'projects.yaml');
  const globalPath = (root: string) => storePath(root, 'global.yaml');
  const ownershipPath = (root: string) => storePath(root, 'ownership.yaml');
  const resourcesPath = (root: string) => storePath(root, 'resources/skills');
  async function readYaml<T>(file: string, boundary: string, schema: z.ZodType<T, z.ZodTypeDef, any>, fallback: T): Promise<T> {
    try { return schema.parse(parse(await readFile(file, boundary)) ?? fallback); }
    catch (error) { if (missing(error)) return fallback; throw new Error(`Invalid ${path.basename(file)}: ${errorMessage(error)}`); }
  }
  async function readRegistry() { const { root } = await initialize(); return readYaml(registryPath(root), root, registrySchema, []) as Promise<RegistryItem[]>; }
  async function readProjects() { const { root } = await initialize(); return readYaml(projectsPath(root), root, projectsSchema, []); }
  async function readOwnership() { const { root } = await initialize(); return readYaml(ownershipPath(root), root, ownershipSchema, {}); }
  async function readGlobal() { const { root } = await initialize(); return readYaml(globalPath(root), root, globalSchema, { skills: [] }); }
  async function readConfig(projectPath: string) {
    await guard(projectPath, projectPath);
    return readYaml(path.join(projectPath, '.skm.yaml'), projectPath, projectConfigSchema, projectConfigSchema.parse({}));
  }
  function skillSource(item: SkillRecord, root: string) {
    if (item.source !== path.join(resourcesPath(root), item.name)) throw new Error(`Unsafe centrally managed source for ${item.name}: ${item.source}`);
    return item.source;
  }
  function skillTarget(projectPath: string, name: string) {
    nameSchema.parse(name);
    const directory = path.resolve(agent.skillDirectory(projectPath));
    if (!inside(projectPath, directory)) throw new Error(`Agent ${agent.id} returned a Skill directory outside the target project: ${directory}`);
    return path.join(directory, name);
  }
  async function findProject(value: unknown, projects?: ProjectRecord[]) {
    if (typeof value !== 'string' || !value.trim()) throw new Error('Project path or ID must be nonempty');
    const rows = projects ?? await readProjects();
    const byId = rows.find(project => project.id === value);
    if (byId) {
      if (await canonicalDirectory(byId.path, 'Registered project') !== byId.path) throw new Error(`Registered project resolves through a changed symlink parent: ${byId.path}`);
      await guard(byId.path, byId.path); return byId;
    }
    const canonical = await canonicalDirectory(value, 'Project');
    const found = rows.find(project => project.path === canonical);
    if (!found) throw new Error(`Project is not registered: ${value}`);
    return found;
  }
  async function resolveProject(value: string) {
    const project = await findProject(value);
    return { ...project, config: await readConfig(project.path) };
  }
  async function targetProject(value: unknown, projects?: ProjectRecord[]) {
    const { home } = await initialize();
    return value === 'global' ? { id: 'global', path: home, addedAt: '' } : findProject(value, projects);
  }
  function boundaryFor(plan: OperationPlan, root: string, home: string, target: string): string {
    if (!path.isAbsolute(target)) throw new Error(`Plan contains a non-absolute path: ${target}`);
    if (inside(root, target)) return root;
    if (plan.affectedProject && inside(plan.affectedProject, target)) return plan.affectedProject;
    if (plan.args.project === 'global' && inside(home, target)) return home;
    if ((plan.action === 'skill:register' || plan.action === 'skill:update') && typeof plan.args.source === 'string' && inside(plan.args.source, target, true)) return plan.args.source;
    throw new Error(`Plan path is outside its authorized boundaries: ${target}`);
  }
  async function metadata(source: unknown) {
    const directory = await canonicalDirectory(source, 'Skill');
    const content = await readFile(path.join(directory, 'SKILL.md'), directory).catch(error => { throw new Error(`Skill directory must contain a regular SKILL.md: ${directory} (${errorMessage(error)})`); });
    const match = content.match(/^---\s*\r?\n([\s\S]*?)\r?\n---/);
    const data = match ? frontmatterSchema.parse(parse(match[1]) ?? {}) : {};
    return { source: directory, name: data.name ?? nameSchema.parse(path.basename(directory)), description: data.description, version: data.version };
  }
  async function makePlan(action: string, input: Record<string, unknown>, id: string, createdAt: string): Promise<OperationPlan> {
    const { root, home } = await initialize();
    const args = JSON.parse(JSON.stringify(input)) as Record<string, unknown>;
    const steps: PlanStep[] = [], conflicts: string[] = [], preserves: string[] = [], externalCommands: string[][] = [];
    const assumptions = new Map<string, string>();
    let affectedProject: string | undefined, component: string | undefined;
    const observe = async (target: string, boundary: string): Promise<string> => {
      for (const parent of await parentIdentities(target, boundary)) assumptions.set(parent.path, parent.fingerprint);
      const value = await fingerprint(target, boundary);
      assumptions.set(target, value);
      return value;
    };
    const trackedRead = async <T>(target: string, schema: z.ZodType<T, z.ZodTypeDef, any>, fallback: T, boundary = root): Promise<T> => {
      await observe(target, boundary);
      return readYaml(target, boundary, schema, fallback);
    };
    const registry = await trackedRead(registryPath(root), registrySchema, []) as RegistryItem[];
    const projects = await trackedRead(projectsPath(root), projectsSchema, []);
    const ownership = await trackedRead(ownershipPath(root), ownershipSchema, {});
    const global = await trackedRead(globalPath(root), globalSchema, { skills: [] });
    const getConfig = (projectPath: string) => trackedRead(path.join(projectPath, '.skm.yaml'), projectConfigSchema, projectConfigSchema.parse({}), projectPath);
    const write = async (target: string, value: unknown, description: string, boundary = root) => steps.push({ action: 'write', path: target, content: stringify(value), expected: await observe(target, boundary), description });
    const getSkill = (name: unknown) => {
      const parsed = nameSchema.parse(name), item = registry.find((item): item is SkillRecord => item.type === 'skill' && item.name === parsed);
      if (!item) throw new Error(`Skill is not registered: ${parsed}`);
      skillSource(item, root);
      return item;
    };
    const validateSkills = (names: string[]) => { for (const name of names) getSkill(name); };
    let ownershipChanged = false;
    const planSkill = async (project: ProjectRecord, name: string, lifecycle: 'install' | 'uninstall', mode: 'symlink' | 'copy'): Promise<ComponentPlan> => {
      const target = skillTarget(project.path, name), owner = ownership[target];
      const skill = lifecycle === 'uninstall' && !registry.some(item => item.type === 'skill' && item.name === name)
        ? { name, source: path.join(resourcesPath(root), name) }
        : getSkill(name);
      const result: ComponentPlan = { steps: [], conflicts: [], preserves: [], externalCommands: [] };
      const before = await observe(target, project.path);
      const owns = owner?.skill === name && owner.project === project.path && owner.source === skill.source;
      const unchanged = owns && (owner.mode === 'symlink' ? before === `link:${owner.source}` : Boolean(owner.copyHash) && before === `dir:${owner.copyHash}`);
      if (lifecycle === 'uninstall') {
        if (!owns) { result.conflicts.push(`Refusing to remove unowned resource: ${target}`); result.preserves.push(target); return result; }
        if (before === 'missing') result.preserves.push(`Managed installation is already absent: ${target}`);
        else if (!unchanged) { result.conflicts.push(`Managed target has changed; preserving it: ${target}`); result.preserves.push(target); return result; }
        else result.steps.push({ action: owner.mode === 'symlink' ? 'remove-link' : 'remove', path: target, expected: before, description: `Remove managed ${owner.mode} ${target}` });
        delete ownership[target]; ownershipChanged = true;
        return result;
      }
      const sourceFingerprint = await observe(skill.source, root);
      if (!sourceFingerprint.startsWith('dir:')) throw new Error(`Registered Skill source is missing or invalid: ${skill.source}`);
      if (before !== 'missing') {
        if (!unchanged) { result.conflicts.push(`Unmanaged or changed installation target will be preserved: ${target}`); result.preserves.push(target); return result; }
        if (owner.mode === 'symlink' || owner.copyHash === sourceFingerprint.slice(4)) { result.preserves.push(`Already installed: ${target}`); return result; }
        result.steps.push({ action: 'replace-copy', path: target, source: skill.source, expected: before, description: `Refresh managed copy of ${name}` });
        ownership[target] = { ...owner, copyHash: sourceFingerprint.slice(4) }; ownershipChanged = true;
        return result;
      }
      result.steps.push({ action: mode, path: target, source: skill.source, expected: 'missing', description: `${mode === 'copy' ? 'Copy' : 'Link'} ${name} into ${project.path}` });
      ownership[target] = { skill: name, source: skill.source, mode, project: project.path, ...(mode === 'copy' ? { copyHash: sourceFingerprint.slice(4) } : {}) };
      ownershipChanged = true;
      return result;
    };
    const merge = (result: ComponentPlan) => { steps.push(...result.steps); conflicts.push(...result.conflicts); preserves.push(...result.preserves); externalCommands.push(...result.externalCommands); };
    switch (action) {
      case 'project:add': {
        const projectPath = await canonicalDirectory(args.path, 'Project'); args.path = projectPath; affectedProject = projectPath;
        if (projects.some(project => project.path === projectPath)) { conflicts.push(`Project is already registered: ${projectPath}`); break; }
        const configPath = path.join(projectPath, '.skm.yaml'), before = await observe(configPath, projectPath);
        if (before !== 'missing') { await getConfig(projectPath); preserves.push(`Existing valid project configuration: ${configPath}`); }
        await write(projectsPath(root), [...projects, { id, path: projectPath, addedAt: createdAt }], `Register project ${projectPath}`);
        if (before === 'missing') await write(configPath, projectConfigSchema.parse({}), 'Create .skm.yaml project configuration', projectPath);
        break;
      }
      case 'project:configure': {
        const project = await findProject(args.project, projects); affectedProject = project.path;
        const config = projectConfigSchema.partial().parse(args.config);
        const next = projectConfigSchema.parse({ ...await getConfig(project.path), ...config }); next.skills = namesSchema.parse(next.skills); validateSkills(next.skills);
        await write(path.join(project.path, '.skm.yaml'), next, `Update desired skills for ${project.path}`, project.path);
        break;
      }
      case 'global:configure': {
        const config = globalSchema.parse(args.config); validateSkills(config.skills);
        await write(globalPath(root), config, 'Update global skills');
        break;
      }
      case 'skill:register':
      case 'skill:update': {
        const data = await metadata(args.source); args.source = data.source;
        const name = action === 'skill:update' ? nameSchema.parse(args.name) : data.name;
        if (action === 'skill:update' && data.name !== name) throw new Error(`Updated Skill name ${data.name} must match registered name ${name}`);
        const previous = registry.find(item => item.name === name), target = path.join(resourcesPath(root), name);
        if (action === 'skill:register' && previous) throw new Error(`A resource is already registered with the name: ${name}`);
        if (action === 'skill:update' && previous?.type !== 'skill') throw new Error(`Skill is not registered: ${name}`);
        if (inside(target, data.source, true)) throw new Error('Update source must be outside the centrally managed Skill directory');
        await observe(data.source, data.source);
        const before = await observe(target, root);
        if (action === 'skill:register' && before !== 'missing') throw new Error(`Managed Skill destination exists: ${target}`);
        if (action === 'skill:update' && previous?.type === 'skill') skillSource(previous, root);
        if (action === 'skill:update' && !before.startsWith('dir:')) throw new Error(`Managed source is missing or invalid: ${target}`);
        steps.push({ action: action === 'skill:update' ? 'replace-copy' : 'copy', path: target, source: data.source, expected: before, description: `${action === 'skill:update' ? 'Update' : 'Copy'} ${name} in the central registry` });
        const record: SkillRecord = { type: 'skill', name, source: target, registeredAt: previous?.registeredAt ?? createdAt, ...(data.description !== undefined ? { description: data.description } : {}), ...(data.version !== undefined ? { version: data.version } : {}) };
        await write(registryPath(root), action === 'skill:update' ? registry.map(item => item.name === name ? record : item) : [...registry, record], `Register Skill metadata for ${name}`); component = name;
        break;
      }
      case 'package:register': {
        const definition = packageSchema.parse(args.definition); nameSchema.parse(definition.name);
        if (registry.some(item => item.name === definition.name)) throw new Error(`A resource is already registered with the name: ${definition.name}`);
        const componentSkills = definition.components.filter(component => component.type === 'skill').map(component => component.skill); validateSkills(componentSkills);
        if (new Set(componentSkills).size !== componentSkills.length) throw new Error('Package contains duplicate Skill components');
        for (const config of definition.components) if (config.type === 'project-config') for (const relative of Object.keys(config.files)) configTarget(home, relative);
        await write(registryPath(root), [...registry, { ...definition, type: 'package', registeredAt: createdAt }], `Register package ${definition.name}`); component = definition.name;
        break;
      }
      case 'skill:remove-registry': {
        const item = getSkill(args.name), name = item.name; component = name;
        if (args.deleteSource === true) {
          const used = global.skills.includes(name) || registry.some(item => item.type === 'package' && item.components.some(component => component.type === 'skill' && component.skill === name));
          const projectConfigs = await Promise.all(projects.map(project => getConfig(project.path)));
          if (used || projectConfigs.some(config => config.skills.includes(name))) throw new Error(`Cannot delete ${name}; it is referenced by a project, global config, or package`);
          if (Object.values(ownership).some(owner => owner.skill === name)) throw new Error(`Cannot delete ${name}; it has managed installations`);
          const before = await observe(item.source, root);
          if (!before.startsWith('dir:')) throw new Error(`Managed source is missing or invalid: ${item.source}`);
          steps.push({ action: 'remove', path: item.source, expected: before, description: `Delete centrally managed source for ${name}` });
        } else preserves.push(`Centrally managed source is retained: ${item.source}`);
        await write(registryPath(root), registry.filter(record => record.name !== name), `Remove registry entry for ${name}`);
        break;
      }
      case 'skill:install':
      case 'skill:remove':
      case 'package:install':
      case 'package:remove':
      case 'package:init': {
        const project = await targetProject(args.project, projects); affectedProject = project.path;
        if (project.id !== 'global') await getConfig(project.path);
        const name = nameSchema.parse(args.name), mode = z.enum(['symlink', 'copy']).parse(args.mode ?? 'symlink'); component = name;
        if (action.startsWith('skill:')) merge(await planSkill(project, name, action === 'skill:install' ? 'install' : 'uninstall', mode));
        else {
          const pkg = registry.find(item => item.type === 'package' && item.name === name);
          if (!pkg || pkg.type !== 'package') throw new Error(`Package is not registered: ${name}`);
          const lifecycle = action === 'package:init' ? 'init' : action === 'package:install' ? 'install' : 'uninstall';
          if (lifecycle === 'init' && project.id === 'global') throw new Error('Project initialization requires a registered project');
          if (lifecycle === 'init' && !pkg.components.some(component => component.type === 'project-config')) throw new Error(`Package ${name} has no project configuration component`);
          const pending = new Set<string>();
          const context: ComponentContext = {
            projectPath: project.path, mode,
            inspectSkill: async skill => ({ component: { type: 'skill', skill }, state: 'ready', description: skill, paths: [] }),
            planSkill: (skill, action) => planSkill(project, skill, action, mode),
            inspectConfig: async files => ({ component: { type: 'project-config', files }, state: 'ready', description: 'Project configuration', paths: [] }),
            planConfig: async files => {
              const result: ComponentPlan = { steps: [], conflicts: [], preserves: [], externalCommands: [] };
              for (const [relative, content] of Object.entries(files)) {
                const target = configTarget(project.path, relative), before = await observe(target, project.path);
                if (pending.has(target)) { result.conflicts.push(`Package initialization has duplicate destination: ${target}`); continue; }
                pending.add(target);
                if (before !== 'missing') { result.conflicts.push(`Existing project file will be preserved: ${target}`); result.preserves.push(target); }
                else result.steps.push({ action: 'write', path: target, content, expected: before, description: `Initialize ${relative} from ${name}` });
              }
              return result;
            },
          };
          for (const part of pkg.components) merge(await componentAdapter(part.type as 'skill').plan(part as any, lifecycle, context));
        }
        if (ownershipChanged) await write(ownershipPath(root), ownership, 'Record managed Skill ownership');
        break;
      }
      default: throw new Error(`Unsupported operation: ${action}`);
    }
    return { id, action, args, createdAt, safe: conflicts.length === 0, ...(affectedProject ? { affectedProject } : {}), ...(component ? { component } : {}), steps, conflicts, preserves, externalCommands, assumptions: [...assumptions].map(([path, fingerprint]) => ({ path, fingerprint })) };
  }
  function configTarget(projectPath: string, relative: string) {
    if (!relative.trim() || relative.includes('\0') || relative.includes('\\') || path.isAbsolute(relative) || relative.split('/').some(segment => !segment || segment === '.' || segment === '..')) throw new Error(`Unsafe package configuration path: ${relative}`);
    const target = path.resolve(projectPath, relative);
    if (!inside(projectPath, target) || ['.skm.yaml', '.agents', '.skm', '.git'].includes(relative.split('/')[0])) throw new Error(`Unsafe package configuration path: ${relative}`);
    return target;
  }
  async function integrityKey(root: string) {
    const file = path.join(root, '.plan-key');
    if (!await lstatOptional(file)) await exclusiveWrite(file, randomBytes(32).toString('hex'), root);
    const key = await readFile(file, root);
    if (!/^[a-f0-9]{64}$/.test(key)) throw new Error('Invalid operation plan authentication key');
    return key;
  }
  const mac = (content: string, key: string) => createHmac('sha256', key).update(content).digest('hex');
  function validId(id: string) { return z.string().uuid().parse(id); }
  async function getPlan(id: string): Promise<OperationPlan> {
    validId(id);
    const { root } = await initialize(), file = path.join(root, 'plans', `${id}.json`);
    try {
      const content = await readFile(file, root), signature = await readFile(`${file}.mac`, root), expected = mac(content, await integrityKey(root));
      if (!/^[a-f0-9]{64}$/.test(signature) || !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) throw new Error('Operation plan integrity check failed; create a new plan');
      const plan = planSchema.parse(JSON.parse(content)) as OperationPlan;
      if (plan.id !== id) throw new Error('Operation plan ID mismatch');
      return plan;
    } catch (error) { if (missing(error)) throw new Error(`Operation plan not found: ${id}`); throw error; }
  }
  async function signedRead<T>(file: string, root: string, schema: z.ZodType<T, z.ZodTypeDef, any>): Promise<T | undefined> {
    try {
      const envelope = z.object({ content: z.string(), signature: z.string() }).strict().parse(JSON.parse(await readFile(file, root)));
      const { content, signature } = envelope, expected = mac(content, await integrityKey(root));
      if (!/^[a-f0-9]{64}$/.test(signature) || !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) throw new Error(`Operation state integrity check failed: ${file}`);
      return schema.parse(JSON.parse(content));
    } catch (error) { if (missing(error)) return undefined; throw error; }
  }
  async function signedWrite(file: string, root: string, value: unknown) {
    const content = JSON.stringify(value), signature = mac(content, await integrityKey(root));
    // A single atomic envelope keeps journal content and authentication together across interruption.
    await atomicWrite(file, JSON.stringify({ content, signature }), root);
  }
  const journalSchema = z.object({ planId: z.string().uuid(), entries: z.array(z.object({ index: z.number().int().nonnegative(), target: z.string(), boundary: z.string(), before: z.string(), after: z.string(), backup: z.string(), stage: z.string(), reservationInode: z.number().optional() }).strict()), directories: z.array(z.object({ path: z.string(), boundary: z.string() }).strict()) }).strict();
  function transactionStore(root: string): TransactionStore {
    return {
      writeJournal: journal => signedWrite(path.join(root, 'journals', `${journal.planId}.json`), root, journal),
      async deleteJournal(id) { for (const suffix of ['.json', '.json.mac']) await fs.unlink(path.join(root, 'journals', `${validId(id)}${suffix}`)).catch(error => { if (!missing(error)) throw error; }); },
      saveResult: result => signedWrite(path.join(root, 'results', `${result.planId}.json`), root, result),
    };
  }
  async function recover(root: string, home: string) {
    await guard(path.join(root, 'journals'), root);
    for (const filename of await fs.readdir(path.join(root, 'journals'))) {
      if (!filename.endsWith('.json')) continue;
      const id = validId(filename.slice(0, -5)), plan = await getPlan(id);
      const journal = await signedRead(path.join(root, 'journals', filename), root, journalSchema) as Journal | undefined;
      if (!journal) throw new Error(`Missing recovery journal ${filename}`);
      const result = await signedRead(path.join(root, 'results', `${id}.json`), root, resultSchema);
      await recoverTransaction(journal, plan, Boolean(result?.success), transactionStore(root), target => boundaryFor(plan, root, home, target));
    }
  }
  async function savePlan(action: string, args: Record<string, unknown>) {
    const { root, home } = await initialize();
    return withLock(root, async () => {
      await recover(root, home);
      const plan = await makePlan(action, args, randomUUID(), new Date().toISOString()), content = JSON.stringify(plan, null, 2), file = path.join(root, 'plans', `${plan.id}.json`);
      const key = await integrityKey(root);
      await exclusiveWrite(file, content, root); await exclusiveWrite(`${file}.mac`, mac(content, key), root);
      return plan;
    });
  }
  async function apply(id: string): Promise<ApplyResult> {
    try {
      validId(id);
      const { root, home } = await initialize();
      return await withLock(root, async () => {
        let plan: OperationPlan;
        try { plan = await getPlan(id); await recover(root, home); }
        catch (error) { return { planId: id, success: false, completed: [], failed: { step: 'integrity', error: errorMessage(error) } }; }
        const previous = await signedRead(path.join(root, 'results', `${id}.json`), root, resultSchema);
        if (previous?.success) return { ...previous, replayed: true };
        if (previous && previous.retryable === false) return { ...previous, replayed: true };
        if (!plan.safe) return { planId: id, success: false, completed: [], failed: { step: 'validation', error: plan.conflicts.join('; ') }, retryable: false };
        try {
          const fresh = await makePlan(plan.action, plan.args, plan.id, plan.createdAt);
          if (JSON.stringify(fresh) !== JSON.stringify(plan)) throw new Error('Plan is stale or paths changed; create a new plan before applying');
          for (const assumption of plan.assumptions) {
            if (assumption.fingerprint.startsWith('parent:')) continue;
            await fingerprint(assumption.path, boundaryFor(plan, root, home, assumption.path));
          }
        } catch (error) { return { planId: id, success: false, completed: [], failed: { step: 'revalidation', error: `Plan is stale or invalid: ${errorMessage(error)}` }, retryable: false }; }
        return runTransaction(plan, target => boundaryFor(plan, root, home, target), transactionStore(root));
      });
    } catch (error) { return { planId: id, success: false, completed: [], failed: { step: 'revalidation', error: errorMessage(error) }, retryable: false }; }
  }
  async function statuses(project: ProjectRecord, config: ProjectConfig): Promise<SkillStatus[]> {
    const { root } = await initialize(), registry = await readRegistry(), global = await readGlobal(), ownership = await readOwnership();
    const desired = new Set([...(config.inheritGlobal ? global.skills : []), ...config.skills]);
    const names = new Set(desired);
    for (const [target, owner] of Object.entries(ownership)) if (owner.project === project.path && target === skillTarget(project.path, owner.skill)) names.add(owner.skill);
    const directory = path.dirname(skillTarget(project.path, 'placeholder'));
    try { await guard(directory, project.path); if ((await lstatOptional(directory))?.isDirectory()) for (const name of await fs.readdir(directory)) if (nameSchema.safeParse(name).success) names.add(name); }
    catch (error) { return [...names].map(name => ({ name, expected: [skillTarget(project.path, name)], actual: [], state: 'conflict', desired: desired.has(name), reason: errorMessage(error) })); }
    return Promise.all([...names].map(async name => {
      const target = skillTarget(project.path, name), skill = registry.find((item): item is SkillRecord => item.type === 'skill' && item.name === name), owner = ownership[target];
      const wanted = desired.has(name), actual: string[] = [];
      let state: SkillStatus['state'] = 'missing', reason = '';
      try {
        const before = await fingerprint(target, project.path);
        if (before !== 'missing') {
          actual.push(target);
          const owns = owner?.skill === name && owner.project === project.path;
          if (before.startsWith('link:') && !await fs.stat(target).catch(() => undefined)) { state = 'broken-link'; reason = 'Symbolic link target is unavailable'; }
          else if (!owns) { state = 'conflict'; reason = 'The installation has no matching SKM ownership record'; }
          else if (!wanted) { state = 'drift'; reason = 'Owned installation is not selected in desired configuration'; }
          else if (!skill) { state = 'drift'; reason = 'Installed Skill is no longer registered'; }
          else {
            const source = skillSource(skill, root), sourceFp = await fingerprint(source, root);
            if (!sourceFp.startsWith('dir:')) { state = 'drift'; reason = 'Registered source is missing'; }
            else if (owner.source !== source || (owner.mode === 'symlink' ? before !== `link:${source}` : before !== `dir:${owner.copyHash}` || before !== sourceFp)) { state = 'drift'; reason = 'Managed installation or registered source has changed'; }
            else state = 'installed';
          }
        } else if (!wanted && owner) { state = 'drift'; reason = 'Ownership record remains for an undesired missing installation'; }
        if (!skill && wanted) reason = 'Desired Skill is not registered';
      } catch (error) { state = 'conflict'; reason = errorMessage(error); }
      return { name, expected: [target], actual, state, desired: wanted, ...(reason ? { reason } : {}) };
    }));
  }
  async function inspect(name: string, projectValue?: string): Promise<RegistryInspection> {
    const { root } = await initialize(), item = (await readRegistry()).find(item => item.name === name);
    if (!item) throw new Error(`Resource is not registered: ${name}`);
    const project = projectValue ? await targetProject(projectValue) : undefined;
    const components: Component[] = item.type === 'skill' ? [{ type: 'skill', skill: item.name }] : item.components;
    const context: ComponentContext = {
      projectPath: project?.path, mode: 'symlink',
      async inspectSkill(skillName) {
        const component: Component = { type: 'skill', skill: skillName };
        const skill = (await readRegistry()).find((item): item is SkillRecord => item.type === 'skill' && item.name === skillName);
        if (!skill) return { component, state: 'missing', description: `Skill is not registered: ${skillName}`, paths: [] };
        if (!project) {
          try { const source = skillSource(skill, root); return { component, state: (await fingerprint(source, root)).startsWith('dir:') ? 'ready' : 'missing', description: `Centrally managed Skill ${skillName}`, paths: [source] }; }
          catch (error) { return { component, state: 'conflict', description: errorMessage(error), paths: [skill.source] }; }
        }
        const config = project.id === 'global' ? projectConfigSchema.parse({ inheritGlobal: false, skills: (await readGlobal()).skills }) : await readConfig(project.path);
        const status = (await statuses(project, config)).find(status => status.name === skillName);
        return status ? { component, state: status.state, description: status.reason ?? `${skillName} is ${status.state}`, paths: status.expected } : { component, state: 'missing', description: `${skillName} is not installed`, paths: [skillTarget(project.path, skillName)] };
      },
      async inspectConfig(files) {
        const component: Component = { type: 'project-config', files };
        if (!project) return { component, state: 'ready', description: 'Project configuration requires explicit initialization', paths: Object.keys(files) };
        const paths: string[] = []; let state: ComponentInspection['state'] = 'installed';
        for (const [relative, content] of Object.entries(files)) {
          const target = configTarget(project.path, relative); paths.push(target);
          try { const existing = await readFile(target, project.path); if (existing !== content) state = 'drift'; }
          catch (error) { if (missing(error) && state === 'installed') state = 'missing'; else if (!missing(error)) state = 'conflict'; }
        }
        return { component, state, description: `Project configuration is ${state}; initialization never overwrites existing files`, paths };
      },
      planSkill: async () => { throw new Error('Inspection cannot mutate Skills'); }, planConfig: async () => { throw new Error('Inspection cannot mutate project configuration'); },
    };
    return { item, components: await Promise.all(components.map(part => componentAdapter(part.type as 'skill').inspect(part as any, context))) };
  }
  const filterRows = (rows: RegistryItem[], query: string) => { const q = query.toLowerCase(); return rows.filter(item => `${item.name} ${item.type} ${item.description ?? ''}`.toLowerCase().includes(q)); };
  const registry: Core['registry'] = {
    async list(query) { const rows = await readRegistry(); return query ? filterRows(rows, query) : rows; },
    async search(query) { return filterRows(await readRegistry(), query); }, inspect,
    registerSkill: source => savePlan('skill:register', { source }), updateSkill: (name, source) => savePlan('skill:update', { name, source }),
    removeSkill: (name, options = {}) => savePlan('skill:remove-registry', { name, deleteSource: options.deleteSource ?? false }),
    registerPackage: definition => savePlan('package:register', { definition }),
  };
  const core: Core = {
    registry, catalog: registry,
    projects: {
      add: projectPath => savePlan('project:add', { path: projectPath }), list: readProjects, get: resolveProject,
      async status(value) { const resolved = await resolveProject(value), { config, ...project } = resolved; return { project, config, skills: await statuses(project, config) }; },
      configure: (project, config) => savePlan('project:configure', { project, config }),
    },
    packages: {
      async install(name, project, options = {}) { const type = (await readRegistry()).find(item => item.name === name)?.type; return savePlan(type === 'package' ? 'package:install' : 'skill:install', { name, project, mode: options.mode ?? 'symlink' }); },
      async remove(name, project) { const type = (await readRegistry()).find(item => item.name === name)?.type; return savePlan(type === 'package' ? 'package:remove' : 'skill:remove', { name, project }); },
      init: (name, project) => savePlan('package:init', { name, project }), inspect,
    },
    operations: { plan: savePlan, get: getPlan, apply },
    global: {
      get: readGlobal, configure: config => savePlan('global:configure', { config }),
      async status() { const project = await targetProject('global'); return statuses(project, projectConfigSchema.parse({ inheritGlobal: false, skills: (await readGlobal()).skills })); },
    },
    async doctor() {
      const diagnostics: Diagnostic[] = [];
      const check = async <T>(code: string, operation: () => Promise<T>, fallback: T, target?: string): Promise<T> => {
        try { return await operation(); } catch (error) { diagnostics.push({ severity: 'error', code, message: errorMessage(error), ...(target ? { path: target } : {}) }); return fallback; }
      };
      const initialized = await check('invalid-storage', initialize, undefined);
      if (!initialized) return diagnostics;
      const { root } = initialized, rows = await check('invalid-registry', readRegistry, []), projects = await check('invalid-projects', readProjects, []);
      await check('invalid-ownership', readOwnership, {}); await check('invalid-global-config', readGlobal, { skills: [] });
      for (const item of rows) if (item.type === 'skill') await check('missing-skill-source', async () => {
        const source = skillSource(item, root); if (!(await fingerprint(source, root)).startsWith('dir:')) throw new Error(`Registered Skill source is missing: ${item.name}`);
      }, undefined, item.source);
      for (const project of projects) {
        await check('missing-project-directory', async () => { if (!(await lstatOptional(project.path))?.isDirectory()) throw new Error(`Registered project directory is missing or unsafe: ${project.path}`); }, undefined, project.path);
        if (!await lstatOptional(path.join(project.path, '.skm.yaml'))) diagnostics.push({ severity: 'warning', code: 'missing-project-config', message: 'Project .skm.yaml is missing; default desired configuration is being used.', path: path.join(project.path, '.skm.yaml') });
        const status = await check('invalid-project-config', () => core.projects.status(project.id), undefined, path.join(project.path, '.skm.yaml'));
        if (status) for (const skill of status.skills) if (skill.state !== 'installed') diagnostics.push({ severity: 'warning', code: skill.state, message: `${skill.name} is ${skill.state} in ${project.path}${skill.reason ? `: ${skill.reason}` : ''}`, path: skill.expected[0] });
      }
      const globalStatus = await check('invalid-global-status', () => core.global.status(), []);
      for (const skill of globalStatus) if (skill.state !== 'installed') diagnostics.push({ severity: 'warning', code: skill.state, message: `${skill.name} is ${skill.state} globally${skill.reason ? `: ${skill.reason}` : ''}`, path: skill.expected[0] });
      return diagnostics;
    },
  };
  return core;
}
