import { z } from 'zod';

export const skillComponentSchema = z.object({ type: z.literal('skill'), skill: z.string().min(1) }).strict();
export const cliComponentSchema = z.object({
  type: z.literal('cli-tool'),
  package: z.string().min(1),
  packageManager: z.enum(['npm', 'pnpm', 'pipx', 'brew']).optional(),
  executable: z.string().optional(),
}).strict();
export const configComponentSchema = z.object({
  type: z.literal('project-config'),
  files: z.record(z.string()),
}).strict();
export const componentSchema = z.discriminatedUnion('type', [skillComponentSchema, cliComponentSchema, configComponentSchema]);

export const packageSchema = z.object({
  name: z.string().min(1),
  version: z.string().optional(),
  description: z.string().optional(),
  components: z.array(componentSchema).min(1),
}).strict();

export const projectConfigSchema = z.object({
  version: z.literal(1).default(1),
  inheritGlobal: z.boolean().default(true),
  skills: z.array(z.string()).default([]),
}).strict();

export type SkillComponent = z.infer<typeof skillComponentSchema>;
export type CliComponent = z.infer<typeof cliComponentSchema>;
export type ConfigComponent = z.infer<typeof configComponentSchema>;
export type Component = z.infer<typeof componentSchema>;
export type ToolPackage = z.infer<typeof packageSchema>;
export type ProjectConfig = z.infer<typeof projectConfigSchema>;

export interface SkillRecord {
  type: 'skill';
  name: string;
  description?: string;
  version?: string;
  source: string;
  registeredAt: string;
}

export interface PackageRecord extends ToolPackage { type: 'package'; registeredAt: string }
export type RegistryItem = SkillRecord | PackageRecord;
export interface ProjectRecord { id: string; path: string; addedAt: string }

export interface PlanStep {
  action: 'copy' | 'replace-copy' | 'symlink' | 'write' | 'remove' | 'remove-link';
  path?: string;
  source?: string;
  content?: string;
  expected?: string;
  description: string;
}

export interface OperationPlan {
  id: string;
  action: string;
  args: Record<string, unknown>;
  createdAt: string;
  safe: boolean;
  affectedProject?: string;
  component?: string;
  steps: PlanStep[];
  conflicts: string[];
  preserves: string[];
  externalCommands: string[][];
  assumptions: { path: string; fingerprint: string }[];
}

export interface ApplyResult {
  planId: string;
  success: boolean;
  completed: string[];
  failed?: { step: string; error: string };
  rolledBack?: boolean;
  retryable?: boolean;
  replayed?: boolean;
  warnings?: string[];
}

export interface SkillStatus {
  name: string;
  expected: string[];
  actual: string[];
  state: 'installed' | 'missing' | 'broken-link' | 'conflict' | 'drift';
  desired?: boolean;
  reason?: string;
}
export interface ProjectStatus { project: ProjectRecord; config: ProjectConfig; skills: SkillStatus[]; }
export interface Diagnostic { severity: 'error' | 'warning'; code: string; message: string; path?: string; }
export interface AgentAdapter { id: string; skillDirectory(projectPath: string): string; }

export interface ComponentInspection {
  component: Component;
  state: 'installed' | 'missing' | 'disabled' | 'ready' | 'drift' | 'conflict' | 'broken-link';
  description: string;
  paths: string[];
}
export interface RegistryInspection { item: RegistryItem; components: ComponentInspection[] }
export type ComponentAction = 'install' | 'uninstall' | 'init';
export interface ComponentPlan {
  steps: PlanStep[];
  conflicts: string[];
  preserves: string[];
  externalCommands: string[][];
}
export interface ComponentContext {
  projectPath?: string;
  mode: 'symlink' | 'copy';
  inspectSkill(name: string): Promise<ComponentInspection>;
  planSkill(name: string, action: 'install' | 'uninstall'): Promise<ComponentPlan>;
  inspectConfig(files: Record<string, string>): Promise<ComponentInspection>;
  planConfig(files: Record<string, string>): Promise<ComponentPlan>;
}
// Lifecycle methods produce plans; only Core.operations.apply mutates files.
export interface ComponentAdapter<C extends Component = Component> {
  type: C['type'];
  inspect(component: C, context: ComponentContext): Promise<ComponentInspection>;
  plan(component: C, action: ComponentAction, context: ComponentContext): Promise<ComponentPlan>;
  install(component: C, context: ComponentContext): Promise<ComponentPlan>;
  uninstall(component: C, context: ComponentContext): Promise<ComponentPlan>;
}
