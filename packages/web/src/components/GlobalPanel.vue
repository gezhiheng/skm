<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { CatalogItem, GlobalConfig, ProjectStatus } from '../api'
import InstallationStatus from './InstallationStatus.vue'

const props = defineProps<{ catalog: CatalogItem[]; config: GlobalConfig; selected: boolean; status: ProjectStatus | null; busy: boolean }>()
const emit = defineEmits<{ select: []; saveConfig: [config: GlobalConfig] }>()
const selectedSkills = ref<string[]>([])
const skillItems = computed(() => props.catalog.filter(item => item.type === 'skill'))
watch(() => props.config, config => { selectedSkills.value = [...config.skills] }, { immediate: true })
</script>

<template>
  <section class="panel global-panel" aria-labelledby="global-heading">
    <div class="panel-heading"><div><p class="eyebrow">SHARED ACROSS PROJECTS</p><h2 id="global-heading">Global skills</h2></div><span class="count-badge">{{ config.skills.length }}</span></div>
    <p class="panel-description">Inherited by projects with global inheritance enabled. Desired selection is separate from physical installation.</p>
    <button class="project-choice global-target" :class="{ active: selected }" :aria-pressed="selected" @click="emit('select')"><span class="project-icon" aria-hidden="true">◎</span><span class="project-copy"><strong>Global install target</strong><small>Agent skills on this machine</small></span><span class="tag">{{ selected ? 'selected' : 'select' }}</span></button>
    <div class="project-preferences">
      <span class="field-label">Desired shared skills</span>
      <p v-if="!skillItems.length" class="muted small">Register a skill to select it here.</p>
      <label v-for="skill in skillItems" :key="skill.name" class="check-row"><input v-model="selectedSkills" type="checkbox" :value="skill.name" :disabled="busy" /><span>{{ skill.name }}</span></label>
      <button class="button button-secondary button-small full-width" :disabled="busy" @click="emit('saveConfig', { skills: selectedSkills })">Preview global selection</button>
    </div>
    <InstallationStatus v-if="selected" :skills="status?.skills ?? []" :loading="!status" />
  </section>
</template>
