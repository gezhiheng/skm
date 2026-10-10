import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { api, type CatalogItem, type Diagnostic, type GlobalConfig, type OperationResult, type PackageDefinition, type Plan, type PlanRequest, type Project, type ProjectStatus, type SystemStatus } from '../api'

export function useDashboard() {
  const catalog = ref<CatalogItem[]>([])
  const projects = ref<Project[]>([])
  const systemStatus = ref<SystemStatus | null>(null)
  const projectStatus = ref<ProjectStatus | null>(null)
  const globalConfig = ref<GlobalConfig>({ skills: [] })
  const selectedProjectId = ref('')
  const query = ref('')
  const loading = ref(true)
  const busy = ref(false)
  const error = ref('')
  const message = ref('')
  const plan = ref<Plan | null>(null)
  const operation = ref<OperationResult | null>(null)
  const planError = ref('')

  const selectedProject = computed(() => projects.value.find(project => project.id === selectedProjectId.value) ?? null)
  const diagnostics = computed<Diagnostic[]>(() => [
    ...(systemStatus.value?.diagnostics ?? []),
    ...(projectStatus.value?.diagnostics ?? []),
  ])

  async function loadBase() {
    loading.value = true
    error.value = ''
    try {
      const [items, registeredProjects, status, global] = await Promise.all([api.catalog(query.value), api.projects(), api.status(), api.globalConfig()])
      catalog.value = items
      projects.value = registeredProjects
      systemStatus.value = status
      globalConfig.value = global
      if (selectedProjectId.value !== 'global' && !registeredProjects.some(project => project.id === selectedProjectId.value)) {
        selectedProjectId.value = registeredProjects[0]?.id ?? 'global'
      }
    } catch (cause) {
      error.value = cause instanceof Error ? cause.message : 'Unable to load SKM data.'
    } finally {
      loading.value = false
    }
  }

  let statusRequest = 0
  async function loadProjectStatus() {
    const requestId = ++statusRequest
    const target = selectedProjectId.value
    projectStatus.value = null
    if (!target) return
    try {
      const result = target === 'global' ? await api.globalStatus() : await api.projectStatus(target)
      if (requestId === statusRequest) projectStatus.value = result
    } catch (cause) {
      error.value = cause instanceof Error ? cause.message : 'Unable to inspect this project.'
    }
  }

  let searchTimer: ReturnType<typeof setTimeout> | undefined
  watch(query, () => {
    clearTimeout(searchTimer)
    searchTimer = setTimeout(() => { void loadCatalog() }, 220)
  })
  watch(selectedProjectId, () => { void loadProjectStatus() })
  onUnmounted(() => { clearTimeout(searchTimer) })

  async function loadCatalog() {
    try {
      catalog.value = await api.catalog(query.value)
    } catch (cause) {
      error.value = cause instanceof Error ? cause.message : 'Unable to search the catalog.'
    }
  }

  async function refresh() {
    await loadBase()
    await loadProjectStatus()
  }

  async function startPlan(input: PlanRequest) {
    await preview(() => api.createPlan(input))
  }

  async function applyPlan() {
    if (!plan.value || busy.value) return
    busy.value = true
    planError.value = ''
    try {
      operation.value = await api.applyPlan(plan.value.id)
      operation.value.summary ||= operation.value.success
        ? `Completed ${operation.value.completed?.length ?? 0} planned step${operation.value.completed?.length === 1 ? '' : 's'}.`
        : operation.value.failed?.error || 'Some steps were not completed.'
      operation.value.steps ||= [
        ...(operation.value.completed ?? []).map(description => ({ description, label: description, status: 'done' })),
        ...(operation.value.failed ? [{ label: operation.value.failed.step, description: operation.value.failed.error, status: 'failed', message: operation.value.failed.error }] : []),
      ]
      if (operation.value.success) {
        message.value = operation.value.summary || 'Operation completed and verified.'
      }
      await refresh()
    } catch (cause) {
      planError.value = cause instanceof Error ? cause.message : 'The operation did not complete.'
    } finally {
      busy.value = false
    }
  }

  async function preview(makePlan: () => Promise<Plan>) {
    if (busy.value) return
    planError.value = ''
    error.value = ''
    operation.value = null
    plan.value = null
    busy.value = true
    try { plan.value = await makePlan() }
    catch (cause) { planError.value = error.value = cause instanceof Error ? cause.message : 'Unable to preview this operation.' }
    finally { busy.value = false }
  }

  async function registerSkill(path: string) {
    await preview(() => api.registerSkill(path))
  }

  async function registerProject(path: string) {
    await preview(() => api.registerProject(path))
  }

  async function registerPackage(definition: PackageDefinition) {
    await preview(() => api.registerPackage(definition))
  }

  async function updateGlobalConfig(config: GlobalConfig) {
    await preview(() => api.updateGlobalConfig(config))
  }

  async function updateProjectConfig(id: string, config: { inheritGlobal: boolean; skills: string[] }) {
    await preview(() => api.updateProjectConfig(id, config))
  }

  function closePlan() {
    plan.value = null
    operation.value = null
    planError.value = ''
    void loadProjectStatus()
  }

  onMounted(() => { void refresh() })

  return {
    catalog, projects, systemStatus, projectStatus, globalConfig, selectedProjectId, selectedProject,
    query, loading, busy, error, message, plan, operation, planError, diagnostics,
    refresh, startPlan, applyPlan, closePlan, registerSkill, registerPackage, registerProject, updateProjectConfig, updateGlobalConfig,
  }
}
