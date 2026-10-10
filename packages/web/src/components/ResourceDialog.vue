<script setup lang="ts">
import { ref, shallowRef, watch } from 'vue'
import { api, type CatalogItem, type PlanRequest, type RegistryInspection } from '../api'
import { useDialog } from '../composables/useDialog'

const props = defineProps<{ item: CatalogItem | null; project?: string; busy: boolean }>()
const emit = defineEmits<{ close: []; plan: [input: PlanRequest] }>()
const dialog = ref<HTMLElement | null>(null)
const updatePath = ref('')
const inspection = ref<RegistryInspection | null>(null)
const loading = shallowRef(false)
const error = shallowRef('')
watch(() => props.item, () => { updatePath.value = '' })
watch(() => [props.item?.name, props.project] as const, async ([name, project], _previous, onCleanup) => {
  let current = true
  onCleanup(() => { current = false })
  inspection.value = null
  error.value = ''
  loading.value = !!name
  if (!name) return
  try {
    const result = await api.inspectResource(name, project)
    if (current) inspection.value = result
  } catch (cause) {
    if (current) error.value = cause instanceof Error ? cause.message : 'Unable to inspect this resource.'
  } finally {
    if (current) loading.value = false
  }
}, { immediate: true })
useDialog(dialog, () => !!props.item, () => !props.busy, () => emit('close'))

function update() {
  if (!props.item || !updatePath.value.trim()) return
  emit('plan', { action: 'updateSkill', name: props.item.name, path: updatePath.value.trim() })
}
</script>

<template>
  <div v-if="item" class="dialog-backdrop" @click.self="!busy && emit('close')">
    <section ref="dialog" class="operation-dialog resource-dialog" role="dialog" aria-modal="true" aria-labelledby="resource-title" tabindex="-1">
      <div class="dialog-header"><div><p class="eyebrow">RESOURCE INSPECTION</p><h2 id="resource-title">{{ item.name }}</h2></div><button class="close-button" :disabled="busy" aria-label="Close resource details" @click="emit('close')">×</button></div>
      <p class="dialog-intro">{{ item.description || 'No description provided.' }}</p>
      <dl class="metadata-grid"><div><dt>Type</dt><dd>{{ item.type }}</dd></div><div><dt>Version</dt><dd>{{ item.version || 'Unversioned' }}</dd></div><div v-if="item.registeredAt"><dt>Registered</dt><dd>{{ new Date(item.registeredAt).toLocaleString() }}</dd></div><div v-if="item.source || item.path" class="metadata-wide"><dt>Managed source</dt><dd><code>{{ item.source || item.path }}</code></dd></div></dl>
      <div v-if="item.components?.length" class="resource-components"><h3>Package composition</h3><article v-for="(component, index) in item.components" :key="index" class="component-detail"><span class="tag">{{ component.type }}</span><strong>{{ component.skill || component.package || component.name || 'Project configuration' }}</strong><p v-if="component.packageManager">Package manager: {{ component.packageManager }}<template v-if="component.executable"> · Executable: {{ component.executable }}</template></p><details v-if="component.files"><summary>{{ Object.keys(component.files).length }} configuration file(s)</summary><div v-for="(content, path) in component.files" :key="path"><code>{{ path }}</code><pre>{{ content }}</pre></div></details></article></div>
      <div class="resource-components"><h3>Actual component state</h3><p class="panel-description">{{ project === 'global' ? 'Inspected for the global target' : project ? `Inspected in ${project}` : 'Inspected in the central registry' }}</p>
        <p v-if="loading" class="muted small" role="status">Inspecting resource components…</p>
        <p v-if="error" class="inline-error" role="alert">{{ error }}</p>
        <article v-for="(entry, index) in inspection?.components ?? []" :key="index" class="component-detail"><span class="tag">{{ entry.component.type }}</span> <span class="tag" :class="`tag-${entry.state}`">{{ entry.state }}</span><p>{{ entry.description }}</p><div class="inspection-paths"><code v-for="path in entry.paths" :key="path">{{ path }}</code></div></article>
        <p v-if="inspection && !inspection.components.length" class="muted small">No component inspection was returned.</p>
      </div>
      <template v-if="item.type === 'skill'">
        <div class="resource-management"><h3>Update central source</h3><p class="panel-description">Read a new local Skill directory into SKM's managed source. Existing project links may see the update; the plan reports what changes.</p><form @submit.prevent="update"><label class="field-label" for="update-path">New local Skill directory</label><div class="inline-form"><input id="update-path" v-model="updatePath" placeholder="/path/to/updated-skill" /><button class="button button-secondary button-small" :disabled="busy || !updatePath.trim()">Preview update</button></div></form></div>
        <div class="resource-management removal-management"><h3>Registry management</h3><p class="panel-description">Removing a registry entry preserves the central source and all project data. Central deletion also removes SKM's stored source and is rejected while references remain.</p><div class="management-actions"><button class="button button-secondary button-small" :disabled="busy" @click="emit('plan', { action: 'unregisterSkill', name: item.name, deleteSource: false })">Preview remove registry entry</button><button class="button button-danger button-small" :disabled="busy" @click="emit('plan', { action: 'unregisterSkill', name: item.name, deleteSource: true })">Preview central source deletion</button></div></div>
      </template>
    </section>
  </div>
</template>
