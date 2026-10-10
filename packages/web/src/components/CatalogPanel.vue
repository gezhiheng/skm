<script setup lang="ts">
import { computed, ref } from 'vue'
import type { CatalogItem, PackageDefinition, PlanRequest, Project } from '../api'
import PackageRegistration from './PackageRegistration.vue'

const props = defineProps<{ items: CatalogItem[]; projects: Project[]; selectedProjectId: string; query: string; busy: boolean }>()
const emit = defineEmits<{
  search: [query: string]
  plan: [input: PlanRequest]
  inspect: [item: CatalogItem]
  register: [path: string]
  registerPackage: [definition: PackageDefinition]
}>()

const registerPath = ref('')
const category = ref<'all' | 'skill' | 'package'>('all')
const mode = ref<'symlink' | 'copy'>('symlink')
const skills = computed(() => props.items.filter(item => item.type === 'skill'))
const packages = computed(() => props.items.filter(item => item.type !== 'skill'))
const visible = computed(() => category.value === 'skill' ? skills.value : category.value === 'package' ? packages.value : props.items)

function register() {
  const value = registerPath.value.trim()
  if (!value) return
  emit('register', value)
  registerPath.value = ''
}
</script>

<template>
  <section class="panel catalog-panel" aria-labelledby="catalog-heading">
    <div class="panel-heading catalog-title-row">
      <div><p class="eyebrow">MANAGED RESOURCES</p><h2 id="catalog-heading">Skills &amp; packages</h2></div>
      <div class="resource-total"><strong>{{ items.length }}</strong><span>in registry</span></div>
    </div>
    <div class="catalog-toolbar">
      <label class="search-box"><span aria-hidden="true" class="search-icon">⌕</span><span class="sr-only">Search skills and packages</span>
        <input :value="query" placeholder="Search catalog…" @input="emit('search', ($event.target as HTMLInputElement).value)" />
      </label>
      <div class="segmented" aria-label="Filter catalog">
        <button v-for="tab in (['all', 'skill', 'package'] as const)" :key="tab" :class="{ active: category === tab }" @click="category = tab">{{ tab === 'all' ? 'All' : tab === 'skill' ? 'Skills' : 'Packages' }}</button>
      </div>
    </div>
    <div class="install-toolbar"><p>Install target: <strong>{{ selectedProjectId === 'global' ? 'Global agent skills' : projects.find(project => project.id === selectedProjectId)?.name || 'Select a project' }}</strong></p><label>Install mode <select v-model="mode" :disabled="busy"><option value="symlink">Symlink (default)</option><option value="copy">Copy</option></select></label></div>
    <div v-if="visible.length" class="catalog-grid">
      <article v-for="item in visible" :key="`${item.type}:${item.name}`" class="resource-card">
        <div class="resource-card-top"><span class="resource-icon" :class="item.type === 'skill' ? 'skill-symbol' : 'package-symbol'">{{ item.type === 'skill' ? '✳' : '▧' }}</span><span class="type-label">{{ item.type }}</span></div>
        <h3><button class="resource-title-button" @click="emit('inspect', item)">{{ item.name }}</button></h3>
        <p class="resource-description">{{ item.description || (item.type === 'skill' ? 'Reusable agent skill' : 'Package with managed components') }}</p>
        <div v-if="item.components?.length" class="component-summary"><span v-for="component in item.components" :key="`${component.type}:${component.name || component.skill || component.package}`">{{ component.type }}<template v-if="component.name || component.skill || component.package"> · {{ component.name || component.skill || component.package }}</template></span></div>
        <div class="resource-card-footer"><span class="version-label">{{ item.version ? `v${item.version}` : 'Local source' }}</span>
          <div class="resource-actions">
            <button v-if="item.type === 'skill' && selectedProjectId" class="button button-secondary button-small" :disabled="busy" @click="emit('plan', { action: 'removeSkill', name: item.name, project: selectedProjectId })">Uninstall</button>
            <button v-if="item.type !== 'skill'" class="button button-secondary button-small" :disabled="busy || !selectedProjectId || selectedProjectId === 'global'" @click="emit('plan', { action: 'initPackage', name: item.name, project: selectedProjectId })">Init config</button>
            <button class="button button-primary button-small" :disabled="busy || !selectedProjectId" @click="emit('plan', { action: item.type === 'skill' ? 'installSkill' : 'installPackage', name: item.name, project: selectedProjectId, mode })">{{ item.type === 'skill' ? 'Install' : 'Install package' }} <span aria-hidden="true">↗</span></button>
          </div>
        </div>
      </article>
    </div>
    <div v-else class="empty-state catalog-empty"><span class="empty-icon">⌕</span><strong>{{ items.length ? 'No matching resources' : 'Your registry is empty' }}</strong><p>{{ items.length ? 'Try a different search or filter.' : 'Register a local skill directory to begin building your catalog.' }}</p></div>
    <div class="register-strip"><div><strong>Register a local skill</strong><small>Add a directory containing a SKILL.md file</small></div>
      <form class="inline-form register-form" @submit.prevent="register"><label class="sr-only" for="skill-path">Skill directory path</label><input id="skill-path" v-model="registerPath" placeholder="/path/to/skill" />
        <button class="button button-secondary button-small" :disabled="busy || !registerPath.trim()">Register</button></form>
    </div>
    <p class="configuration-hint">Inspect a resource by selecting its name. Uninstall only removes a managed installation from the chosen target.</p>
    <PackageRegistration :busy="busy" @register="emit('registerPackage', $event)" />
  </section>
</template>
