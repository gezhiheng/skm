<script setup lang="ts">
import type { SkillStatus } from '../api'

defineProps<{ skills: SkillStatus[]; loading?: boolean }>()

function guidance(state: string) {
  if (state === 'missing') return 'Preview an install from the catalog to create the missing managed files.'
  if (state === 'broken-link') return 'Inspect the linked source. Preview an update or remove and reinstall only after the plan verifies ownership.'
  if (state === 'conflict') return 'Inspect the existing path and move unmanaged files yourself before retrying. SKM will preserve them.'
  if (state === 'drift') return 'Desired and actual files differ. Inspect local changes first; changed copies are preserved until ownership can be verified.'
  return ''
}
</script>

<template>
  <div class="installed-heading"><span>EFFECTIVE SKILLS &amp; ACTUAL FILES</span><span>{{ skills.length }}</span></div>
  <div v-if="skills.length" class="installation-list">
    <details v-for="skill in skills" :key="skill.name" class="installation-detail">
      <summary class="installation-row"><span class="check-mark" aria-hidden="true">{{ skill.state === 'installed' ? '✓' : '!' }}</span><span class="installation-name">{{ skill.name }}</span><span class="tag" :class="`tag-${skill.state}`">{{ skill.state }}</span><span class="chevron" aria-hidden="true">›</span></summary>
      <div class="installation-paths"><span class="field-label">Expected locations</span><code v-for="path in skill.expected" :key="path">{{ path }}</code><p v-if="!skill.expected?.length" class="muted small">Not selected in desired configuration.</p>
        <span class="field-label">Actual locations</span><code v-for="path in skill.actual" :key="path">{{ path }}</code><p v-if="!skill.actual?.length" class="muted small">No installation found.</p>
        <p v-if="guidance(skill.state)" class="repair-guidance">{{ guidance(skill.state) }}</p>
      </div>
    </details>
  </div>
  <p v-else class="muted small status-placeholder">{{ loading ? 'Loading installation status…' : 'No desired or installed skills found.' }}</p>
</template>
