<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { CatalogItem, Project, ProjectStatus } from '../api'
import InstallationStatus from './InstallationStatus.vue'

const props = defineProps<{
  projects: Project[]
  catalog: CatalogItem[]
  selectedId: string
  status: ProjectStatus | null
  busy: boolean
}>()
const emit = defineEmits<{
  select: [id: string]
  register: [path: string]
  saveConfig: [id: string, config: { inheritGlobal: boolean; skills: string[] }]
}>()

const path = ref('')
const inheritGlobal = ref(true)
const selectedSkills = ref<string[]>([])
const project = computed(() => props.projects.find(item => item.id === props.selectedId) ?? null)
const skillItems = computed(() => props.catalog.filter(item => item.type === 'skill'))
const installations = computed(() => props.status?.skills ?? props.status?.installations?.map(skill => ({ name: skill.name, state: skill.status, expected: [], actual: skill.path ? [skill.path] : [] })) ?? [])

watch(() => [project.value, props.status?.config] as const, ([value, config]) => {
  inheritGlobal.value = config?.inheritGlobal ?? value?.inheritGlobal ?? true
  selectedSkills.value = [...(config?.skills ?? value?.skills ?? [])]
}, { immediate: true })

function addProject() {
  const next = path.value.trim()
  if (!next) return
  emit('register', next)
  path.value = ''
}

function save() {
  if (!project.value) return
  emit('saveConfig', project.value.id, { inheritGlobal: inheritGlobal.value, skills: selectedSkills.value })
}
</script>

<template>
  <section class="panel project-panel" aria-labelledby="projects-heading">
    <div class="panel-heading">
      <div><p class="eyebrow">WORKSPACES</p><h2 id="projects-heading">Projects</h2></div>
      <span class="count-badge">{{ projects.length }}</span>
    </div>

    <form class="inline-form" @submit.prevent="addProject">
      <label class="sr-only" for="project-path">Project directory path</label>
      <input id="project-path" v-model="path" placeholder="/path/to/project" autocomplete="off" />
      <button class="icon-button" :disabled="busy || !path.trim()" title="Register project" aria-label="Register project">+</button>
    </form>

    <div v-if="projects.length" class="project-list" role="listbox" aria-label="Registered projects">
      <button v-for="item in projects" :key="item.id" class="project-choice" :class="{ active: item.id === selectedId }"
        role="option" :aria-selected="item.id === selectedId" @click="emit('select', item.id)">
        <span class="project-icon" aria-hidden="true">⌂</span>
        <span class="project-copy"><strong>{{ item.name }}</strong><small>{{ item.path }}</small></span>
        <span class="chevron" aria-hidden="true">›</span>
      </button>
    </div>
    <div v-else class="empty-state compact"><span class="empty-icon">⌂</span><strong>No projects yet</strong><p>Add a local project path to get started.</p></div>

    <template v-if="project">
      <div class="section-divider"></div>
      <div class="selected-project-heading"><div><p class="eyebrow">SELECTED PROJECT</p><h3>{{ project.name }}</h3></div><span class="status-dot" aria-label="Project selected"></span></div>
      <p class="path-line">{{ project.path }}</p>
      <div class="project-preferences">
        <label class="toggle-row">
          <span><strong>Inherit global skills</strong><small>Include shared skills automatically</small></span>
          <input v-model="inheritGlobal" type="checkbox" :disabled="busy" />
        </label>
        <div class="skill-selection">
          <span class="field-label">Project skills</span>
          <p v-if="!skillItems.length" class="muted small">Register a skill to select it here.</p>
          <label v-for="skill in skillItems" :key="skill.name" class="check-row">
            <input v-model="selectedSkills" type="checkbox" :value="skill.name" :disabled="busy" />
            <span>{{ skill.name }}</span>
          </label>
        </div>
        <button class="button button-secondary button-small full-width" :disabled="busy" @click="save">Preview settings change</button>
      </div>
      <p class="configuration-hint">Saving desired selection does not install or remove files. Use the catalog actions to preview physical changes.</p>
      <InstallationStatus :skills="installations" :loading="!status" />
    </template>
  </section>
</template>
