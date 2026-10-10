export type CatalogItem = {
  name: string
  type: 'skill' | 'package' | 'tool' | string
  description?: string
  version?: string
  components?: Array<{ name?: string; skill?: string; package?: string; packageManager?: string; executable?: string; files?: Record<string, string>; type: string }>
  path?: string
  source?: string
  registeredAt?: string
}

export type PackageComponent =
  | { type: 'skill'; skill: string }
  | { type: 'cli-tool'; package: string; packageManager?: 'npm' | 'pnpm' | 'pipx' | 'brew'; executable?: string }
  | { type: 'project-config'; files: Record<string, string> }
export type PackageDefinition = { name: string; version?: string; description?: string; components: PackageComponent[] }
export type RegistryInspection = {
  item: CatalogItem
  components: Array<{ component: PackageComponent; state: string; description: string; paths: string[] }>
}
export type GlobalConfig = { skills: string[] }
export type SkillStatus = { name: string; expected?: string[]; actual?: string[]; state: string }

export type Project = {
  id: string
  name: string
  path: string
  inheritGlobal?: boolean
  skills?: string[]
}

export type Diagnostic = {
  severity?: 'error' | 'warning' | 'info' | string
  message: string
  project?: string
  path?: string
}

export type Installation = {
  name: string
  status: string
  method?: string
  path?: string
  type?: string
}

export type SystemStatus = {
  health?: string | boolean
  counts?: Record<string, number>
  diagnostics?: Diagnostic[]
  [key: string]: unknown
}

export type ProjectStatus = {
  project?: Project
  config?: { inheritGlobal: boolean; skills: string[] }
  skills?: SkillStatus[]
  installations?: Installation[]
  diagnostics?: Diagnostic[]
}

export type PlanAction = 'installSkill' | 'installPackage' | 'removeSkill' | 'initPackage' | 'configureProject' | 'unregisterSkill' | 'updateSkill'

export type PlanRequest = {
  action: PlanAction
  name?: string
  project?: string
  mode?: 'symlink' | 'copy'
  inheritGlobal?: boolean
  skills?: string[]
  path?: string
  deleteSource?: boolean
}

export type Plan = Omit<PlanRequest, 'action'> & {
  id: string
  action: string
  args?: Record<string, unknown>
  safe?: boolean
  conflicts?: string[]
  preserves?: string[]
  affectedProject?: string
  component?: string
  steps: Array<{ label?: string; description?: string; source?: string; target?: string; path?: string; status?: string; [key: string]: unknown }>
  externalCommands?: string[][]
  warnings?: string[]
  createdAt?: string
}

export type OperationResult = {
  planId?: string
  success: boolean
  summary?: string
  completed?: string[]
  failed?: { step: string; error: string }
  steps?: Array<{ label?: string; description?: string; status?: string; message?: string }>
  diagnostics?: Diagnostic[]
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response
  try {
    response = await fetch(path, {
      ...init,
      headers: { 'content-type': 'application/json', ...init?.headers },
    })
  } catch {
    throw new Error('Cannot reach the SKM API. Start the local API server and try again.')
  }

  const body: unknown = await response.json().catch(() => null)
  if (!response.ok) {
    const record = body && typeof body === 'object' ? body as Record<string, unknown> : {}
    const message = typeof record.error === 'string' ? record.error : `Request failed (${response.status})`
    const details = typeof record.details === 'string' ? `: ${record.details}` : ''
    throw new Error(`${message}${details}`)
  }
  return body as T
}

function itemsFrom<T>(body: { items?: T[] } | T[]): T[] {
  return Array.isArray(body) ? body : body.items ?? []
}

const json = (value: unknown): RequestInit => ({ method: 'POST', body: JSON.stringify(value) })

export const api = {
  async health() {
    return request<{ status?: string; [key: string]: unknown }>('/api/health')
  },
  async catalog(query = '') {
    const params = query ? `?q=${encodeURIComponent(query)}` : ''
    const body = await request<{ items?: CatalogItem[] } | CatalogItem[]>(`/api/catalog${params}`)
    return itemsFrom(body)
  },
  inspectResource(name: string, project?: string) {
    const params = project ? `?project=${encodeURIComponent(project)}` : ''
    return request<RegistryInspection>(`/api/catalog/${encodeURIComponent(name)}${params}`)
  },
  async projects() {
    const body = await request<{ items?: Project[] } | Project[]>('/api/projects')
    return itemsFrom(body).map(project => ({
      ...project,
      name: project.name || project.path.split(/[\\/]/).filter(Boolean).at(-1) || project.path,
    }))
  },
  status() {
    return request<SystemStatus>('/api/status')
  },
  projectStatus(id: string) {
    return request<ProjectStatus>(`/api/projects/${encodeURIComponent(id)}/status`)
  },
  registerSkill(path: string) {
    return request<Plan>('/api/skills/register', json({ path }))
  },
  registerPackage(definition: PackageDefinition) {
    return request<Plan>('/api/packages/register', json(definition))
  },
  globalConfig() {
    return request<GlobalConfig>('/api/global/config')
  },
  globalStatus() {
    return request<ProjectStatus>('/api/global/status')
  },
  updateGlobalConfig(config: GlobalConfig) {
    return request<Plan>('/api/global/config', { method: 'PUT', body: JSON.stringify(config) })
  },
  registerProject(path: string) {
    return request<Plan>('/api/projects', json({ path }))
  },
  updateProjectConfig(id: string, config: { inheritGlobal: boolean; skills: string[] }) {
    return request<Plan>(`/api/projects/${encodeURIComponent(id)}/config`, {
      method: 'PUT', body: JSON.stringify(config), headers: { 'content-type': 'application/json' },
    })
  },
  createPlan(input: PlanRequest) {
    return request<Plan>('/api/plans', json(input))
  },
  applyPlan(id: string) {
    return request<OperationResult>(`/api/plans/${encodeURIComponent(id)}/apply`, json({ confirmed: true }))
  },
}
