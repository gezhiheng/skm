#!/usr/bin/env node
import { Command } from 'commander';
import { buildServer } from '@skm/api/server';
import { createCore, type OperationPlan, type RegistryInspection, type RegistryItem, type ToolPackage } from '@skm/core';

const program = new Command();
let core = createCore();

program
  .name('skm')
  .description('Manage AI coding skills and tool packages')
  .version('0.1.0')
  .option('--json', 'print machine-readable JSON')
  .option('--data-dir <path>', 'SKM data directory (defaults to ~/.skm)');

program.hook('preAction', () => {
  const dataDir = program.opts().dataDir as string | undefined;
  if (dataDir) core = createCore({ dataDir });
});

const wantsJson = (command: Command) => command.optsWithGlobals().json === true;
const output = (value: unknown, json: boolean) => {
  process.stdout.write(json ? `${JSON.stringify(value, null, 2)}\n` : `${String(value)}\n`);
};
const rows = (items: Array<{ name: string; type?: string; description?: string }>) =>
  items.length ? items.map(item => `${item.type ? `${item.type}: ` : ''}${item.name}${item.description ? ` — ${item.description}` : ''}`).join('\n') : 'No results.';
const resourceText = (item: RegistryItem) => [
  `${item.type}: ${item.name}`,
  ...(item.version ? [`Version: ${item.version}`] : []),
  ...(item.description ? [`Description: ${item.description}`] : []),
  `Registered: ${item.registeredAt}`,
  ...(item.type === 'skill' ? [`Managed source: ${item.source}`] : ['Components:', ...item.components.map(component => `  - ${JSON.stringify(component)}`)]),
].join('\n');
const inspectionText = (inspection: RegistryInspection) => [
  resourceText(inspection.item),
  'Inspection:',
  ...inspection.components.map(component => `  - ${component.state}: ${component.description}${component.paths.length ? ` (${component.paths.join(', ')})` : ''}`),
].join('\n');
const planText = (plan: OperationPlan) => [
  `Plan ${plan.id} (${plan.action})`,
  `Safe to apply: ${plan.safe ? 'yes' : 'no'}`,
  ...(plan.affectedProject ? [`Project: ${plan.affectedProject}`] : []),
  ...(plan.steps.length ? ['Steps:', ...plan.steps.map(step => `  - ${step.description}`)] : ['No changes required.']),
  ...(plan.externalCommands.length ? ['External commands:', ...plan.externalCommands.map(command => `  - ${command.map(part => JSON.stringify(part)).join(' ')}`)] : []),
  ...(plan.preserves.length ? ['Preserved:', ...plan.preserves.map(item => `  - ${item}`)] : []),
  ...(plan.conflicts.length ? ['Conflicts:', ...plan.conflicts.map(item => `  - ${item}`)] : []),
  plan.safe ? 'Apply with: skm apply ' + plan.id : 'Resolve the conflicts, then create a new plan.',
].join('\n');
const makePlan = async (command: Command, plan: Promise<OperationPlan>) => {
  const result = await plan;
  output(wantsJson(command) ? result : planText(result), wantsJson(command));
};
const fail = (message: string): never => { throw new Error(message); };
const targetProject = (options: { project?: string; global?: boolean }) => {
  if (options.project && options.global) fail('Choose either --project or --global');
  return options.global ? 'global' : options.project ?? fail('Provide --project <path> or --global');
};
const parseJson = <T>(text: string): T => {
  try { return JSON.parse(text) as T; }
  catch { return fail(`Invalid JSON: ${text}`); }
};

program.command('list')
  .description('List registered skills and packages')
  .argument('[query]', 'optional name or description filter')
  .action(async (query: string | undefined, _options: unknown, command: Command) => {
    const result = await core.registry.list(query);
    output(wantsJson(command) ? result : rows(result), wantsJson(command));
  });

program.command('search')
  .description('Search registered skills and packages')
  .argument('<query>')
  .action(async (query: string, _options: unknown, command: Command) => {
    const result = await core.registry.search(query);
    output(wantsJson(command) ? result : rows(result), wantsJson(command));
  });

program.command('inspect').description('View a registered resource and its component metadata')
  .argument('<name>')
  .option('-p, --project <path>', 'inspect components in a registered project')
  .option('--global', 'inspect global Skill components')
  .action(async (name: string, options: { project?: string; global?: boolean }, command: Command) => {
    const target = options.project || options.global ? targetProject(options) : undefined;
    const inspection = await core.registry.inspect(name, target);
    output(wantsJson(command) ? inspection : inspectionText(inspection), wantsJson(command));
  });

const skill = program.command('skill').description('Manage registered and installed skills');
skill.command('register').description('Register a local Skill directory')
  .argument('<path>')
  .action((path: string, _options: unknown, command: Command) => makePlan(command, core.registry.registerSkill(path)));
skill.command('update').description('Update a centrally managed Skill from a local directory')
  .argument('<name>')
  .argument('<path>')
  .action((name: string, path: string, _options: unknown, command: Command) => makePlan(command, core.registry.updateSkill(name, path)));
skill.command('add').description('Add a Skill or package to a project')
  .argument('<name>')
  .option('-p, --project <path>', 'registered project path or ID')
  .option('--global', 'install into the current user agent directory')
  .option('--mode <mode>', 'installation mode', 'symlink')
  .action((name: string, options: { project?: string; global?: boolean; mode: 'symlink' | 'copy' }, command: Command) => {
    if (!['symlink', 'copy'].includes(options.mode)) fail('--mode must be symlink or copy');
    return makePlan(command, core.packages.install(name, targetProject(options), { mode: options.mode }));
  });
skill.command('remove').description('Remove an installed Skill from a project')
  .alias('uninstall')
  .argument('<name>')
  .option('-p, --project <path>', 'registered project path or ID')
  .option('--global', 'uninstall from the current user agent directory')
  .action((name: string, options: { project?: string; global?: boolean }, command: Command) => makePlan(command, core.packages.remove(name, targetProject(options))));
skill.command('unregister').description('Remove a Skill registry entry; source is preserved unless --delete-source is set')
  .argument('<name>')
  .option('--delete-source', 'also delete the managed source when safe')
  .action((name: string, options: { deleteSource?: boolean }, command: Command) => makePlan(command, core.registry.removeSkill(name, { deleteSource: options.deleteSource })));

const project = program.command('project').description('Manage registered projects');
project.command('add').description('Register a project directory')
  .argument('<path>')
  .action((path: string, _options: unknown, command: Command) => makePlan(command, core.projects.add(path)));
project.command('list').description('List registered projects')
  .action(async (_options: unknown, command: Command) => {
    const result = await core.projects.list();
    output(wantsJson(command) ? result : result.length ? result.map(item => `${item.path} (${item.id})`).join('\n') : 'No projects registered.', wantsJson(command));
  });
project.command('status').description('Inspect a project and its installed Skills')
  .argument('<path-or-id>')
  .action(async (path: string, _options: unknown, command: Command) => {
    const result = await core.projects.status(path);
    output(wantsJson(command) ? result : [result.project.path, ...result.skills.map(item => `${item.state.padEnd(11)} ${item.name}${item.expected[0] ? ` → ${item.expected[0]}` : ''}${item.reason ? `\n  ${item.reason}` : ''}`)].join('\n'), wantsJson(command));
  });
project.command('config').description('Show or update project configuration')
  .argument('<path-or-id>')
  .option('--inherit-global <boolean>', 'inherit globally selected Skills (true or false)')
  .option('--skills <names>', 'comma-separated desired Skill names')
  .action(async (path: string, options: { inheritGlobal?: string; skills?: string }, command: Command) => {
    const config: { inheritGlobal?: boolean; skills?: string[] } = {};
    if (options.inheritGlobal !== undefined) {
      if (!['true', 'false'].includes(options.inheritGlobal)) fail('--inherit-global must be true or false');
      config.inheritGlobal = options.inheritGlobal === 'true';
    }
    if (options.skills !== undefined) config.skills = options.skills.split(',').map(name => name.trim()).filter(Boolean);
    if (!Object.keys(config).length) {
      const result = await core.projects.get(path);
      output(wantsJson(command) ? result.config : JSON.stringify(result.config, null, 2), wantsJson(command));
    } else await makePlan(command, core.projects.configure(path, config));
  });

const packageCommand = program.command('package').description('Manage composite tool packages');
packageCommand.command('install').description('Install a package into a project')
  .argument('<name>')
  .option('-p, --project <path>', 'registered project path or ID')
  .option('--global', 'install Skill components into the current user agent directory')
  .option('--mode <mode>', 'Skill installation mode', 'symlink')
  .action((name: string, options: { project?: string; global?: boolean; mode: 'symlink' | 'copy' }, command: Command) => {
    if (!['symlink', 'copy'].includes(options.mode)) fail('--mode must be symlink or copy');
    return makePlan(command, core.packages.install(name, targetProject(options), { mode: options.mode }));
  });
packageCommand.command('remove').alias('uninstall').description('Remove managed package installations while preserving source and initialized project files')
  .argument('<name>')
  .option('-p, --project <path>', 'registered project path or ID')
  .option('--global', 'uninstall global Skill components')
  .action((name: string, options: { project?: string; global?: boolean }, command: Command) => makePlan(command, core.packages.remove(name, targetProject(options))));
packageCommand.command('init').description('Initialize a package in a project')
  .argument('<name>')
  .requiredOption('-p, --project <path>', 'registered project path or ID')
  .action((name: string, options: { project: string }, command: Command) => makePlan(command, core.packages.init(name, options.project)));
packageCommand.command('register').description('Register a package definition from a JSON file')
  .argument('<file>')
  .action(async (file: string, _options: unknown, command: Command) => {
    const { readFile } = await import('node:fs/promises');
    const definition = parseJson<ToolPackage>(await readFile(file, 'utf8'));
    await makePlan(command, core.registry.registerPackage(definition));
  });

program.command('init').description('Initialize a package in a project (alias for package init)')
  .argument('<name>')
  .requiredOption('-p, --project <path>', 'registered project path or ID')
  .action((name: string, options: { project: string }, command: Command) => makePlan(command, core.packages.init(name, options.project)));

program.command('global').description('Manage globally inherited Skills')
  .addCommand(new Command('install').description('Install a Skill or package into the default agent directory for the current user')
    .argument('<name>')
    .option('--mode <mode>', 'installation mode', 'symlink')
    .action((name: string, options: { mode: 'symlink' | 'copy' }, command: Command) => {
      if (!['symlink', 'copy'].includes(options.mode)) fail('--mode must be symlink or copy');
      return makePlan(command, core.packages.install(name, 'global', { mode: options.mode }));
    }))
  .addCommand(new Command('remove').alias('uninstall').description('Uninstall a globally installed Skill or package')
    .argument('<name>')
    .action((name: string, _options: unknown, command: Command) => makePlan(command, core.packages.remove(name, 'global'))))
  .addCommand(new Command('status').description('Show globally installed Skill status').action(async (_opts: unknown, command: Command) => {
    const result = await core.global.status();
    output(wantsJson(command) ? result : result.length ? result.map(item => `${item.state.padEnd(11)} ${item.name}${item.reason ? `\n  ${item.reason}` : ''}`).join('\n') : 'No global Skills selected.', wantsJson(command));
  }))
  .addCommand(new Command('config').description('Show or set globally selected Skills')
    .option('--skills <names>', 'comma-separated Skill names')
    .action(async (options: { skills?: string }, command: Command) => {
      if (options.skills === undefined) {
        const config = await core.global.get();
        output(wantsJson(command) ? config : JSON.stringify(config, null, 2), wantsJson(command));
      } else await makePlan(command, core.global.configure({ skills: options.skills.split(',').map(name => name.trim()).filter(Boolean) }));
    }));

program.command('plan').description('Create a plan from a Core operation and JSON arguments')
  .argument('<action>', 'Core action, for example skill:install or project:configure')
  .option('--args <json>', 'operation arguments as a JSON object', '{}')
  .action((action: string, options: { args: string }, command: Command) => makePlan(command, core.operations.plan(action, parseJson<Record<string, unknown>>(options.args))));

program.command('show-plan').description('Review a previously saved operation plan')
  .argument('<plan-id>')
  .action((planId: string, _options: unknown, command: Command) => makePlan(command, core.operations.get(planId)));

program.command('apply').description('Apply a previously reviewed operation plan')
  .argument('<plan-id>')
  .action(async (planId: string, _options: unknown, command: Command) => {
    const result = await core.operations.apply(planId);
    const message = [
      result.success ? `Applied plan ${planId}.` : `Plan ${planId} failed.`,
      ...(result.replayed ? ['This plan was already applied; the saved result is shown.'] : []),
      ...(result.completed.length ? [result.rolledBack ? 'Executed steps before rollback:' : 'Completed steps:', ...result.completed.map(step => `  ✓ ${step}`)] : ['No steps completed.']),
      ...(result.rolledBack ? ['Recoverable changes were rolled back.'] : []),
      ...(result.warnings?.length ? ['Warnings:', ...result.warnings.map(warning => `  - ${warning}`)] : []),
      ...(result.failed ? [`Failed step: ${result.failed.step}`, `Error: ${result.failed.error}`, 'Inspect status, resolve the error, and create a new plan before retrying.'] : []),
    ].join('\n');
    output(wantsJson(command) ? result : message, wantsJson(command));
    if (!result.success) process.exitCode = 1;
  });

program.command('doctor').description('Run registry and project diagnostics')
  .action(async (_options: unknown, command: Command) => {
    const result = await core.doctor();
    output(wantsJson(command) ? result : result.length ? result.map(item => `${item.severity.toUpperCase()} ${item.code}: ${item.message}${item.path ? ` (${item.path})` : ''}`).join('\n') : 'No issues found.', wantsJson(command));
    if (result.some(item => item.severity === 'error')) process.exitCode = 1;
  });

program.command('ui').description('Start the local SKM API and Web UI')
  .option('--host <host>', 'loopback bind address', '127.0.0.1')
  .option('-p, --port <port>', 'port', '4318')
  .action(async (options: { host: string; port: string }) => {
    if (!['localhost', '127.0.0.1', '::1'].includes(options.host)) fail('--host must be localhost, 127.0.0.1, or ::1; SKM is a local service');
    const port = Number(options.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) fail('Port must be an integer from 1 to 65535');
    const dataDir = program.opts().dataDir as string | undefined;
    const server = await buildServer({ dataDir });
    await server.listen({ host: options.host, port });
    output(`SKM is available at http://${options.host === '::1' ? '[::1]' : options.host}:${port}`, false);
  });

program.parseAsync(process.argv).catch((error: unknown) => {
  process.stderr.write(`skm: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
