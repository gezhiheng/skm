import type { CliComponent, ComponentAdapter, ComponentContext, ComponentInspection, ComponentPlan, ConfigComponent, SkillComponent } from './types.js';

const empty = (): ComponentPlan => ({ steps: [], conflicts: [], preserves: [], externalCommands: [] });

export const skillComponentAdapter: ComponentAdapter<SkillComponent> = {
  type: 'skill',
  inspect: (component, context) => context.inspectSkill(component.skill),
  plan(component, action, context) {
    return action === 'init' ? Promise.resolve(empty()) : context.planSkill(component.skill, action);
  },
  install: (component, context) => context.planSkill(component.skill, 'install'),
  uninstall: (component, context) => context.planSkill(component.skill, 'uninstall'),
};

export const configComponentAdapter: ComponentAdapter<ConfigComponent> = {
  type: 'project-config',
  inspect: (component, context) => context.inspectConfig(component.files),
  plan(component, action, context) {
    if (action === 'init') return context.planConfig(component.files);
    const plan = empty();
    plan.preserves.push(action === 'install' ? 'Project configuration requires a separate explicit initialization plan.' : 'Generated project configuration is preserved during uninstall.');
    return Promise.resolve(plan);
  },
  install(component, context) { return this.plan(component, 'install', context); },
  uninstall(component, context) { return this.plan(component, 'uninstall', context); },
};

function reviewCommand(component: CliComponent, uninstall: boolean): string[] | undefined {
  if (!/^(?:@[a-z0-9._-]+\/)?[a-z0-9][a-z0-9._-]*$/i.test(component.package)) return undefined;
  switch (component.packageManager) {
    case 'npm': return ['npm', uninstall ? 'uninstall' : 'install', '--global', component.package];
    case 'pnpm': return ['pnpm', uninstall ? 'remove' : 'add', '--global', component.package];
    case 'pipx': return ['pipx', uninstall ? 'uninstall' : 'install', component.package];
    case 'brew': return ['brew', uninstall ? 'uninstall' : 'install', component.package];
    default: return undefined;
  }
}

export const disabledCliComponentAdapter: ComponentAdapter<CliComponent> = {
  type: 'cli-tool',
  async inspect(component): Promise<ComponentInspection> {
    return { component, state: 'disabled', description: `External lifecycle for ${component.package} is disabled until its installation and ownership can be verified.`, paths: [] };
  },
  async plan(component, action) {
    const plan = empty();
    if (action === 'init') return plan;
    const command = reviewCommand(component, action === 'uninstall');
    if (command) plan.externalCommands.push(command);
    plan.conflicts.push(`External CLI ${action} for ${component.package} is disabled until a verified component adapter is implemented. Commands are review-only and will not execute.`);
    return plan;
  },
  install(component, context) { return this.plan(component, 'install', context); },
  uninstall(component, context) { return this.plan(component, 'uninstall', context); },
};

export function componentAdapter(type: 'skill'): ComponentAdapter<SkillComponent>;
export function componentAdapter(type: 'project-config'): ComponentAdapter<ConfigComponent>;
export function componentAdapter(type: 'cli-tool'): ComponentAdapter<CliComponent>;
export function componentAdapter(type: string): ComponentAdapter<any> {
  if (type === 'skill') return skillComponentAdapter;
  if (type === 'project-config') return configComponentAdapter;
  if (type === 'cli-tool') return disabledCliComponentAdapter;
  throw new Error(`Unsupported component type: ${type}`);
}
