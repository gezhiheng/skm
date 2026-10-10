<script setup lang="ts">
import { ref } from 'vue'
import type { PackageDefinition } from '../api'

defineProps<{ busy: boolean }>()
const emit = defineEmits<{ register: [definition: PackageDefinition] }>()
const definition = ref('')
const error = ref('')
const example = '{\n  "name": "example-package",\n  "description": "My local package",\n  "components": [\n    { "type": "skill", "skill": "registered-skill-name" },\n    { "type": "project-config", "files": { "example.txt": "Example content" } }\n  ]\n}'

function submit() {
  error.value = ''
  try {
    const parsed: unknown = JSON.parse(definition.value)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Enter a JSON object for the package definition.')
    emit('register', parsed as PackageDefinition)
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : 'Enter a valid JSON package definition.'
  }
}
</script>

<template>
  <details class="package-registration">
    <summary>Register a package definition <span aria-hidden="true">+</span></summary>
    <form @submit.prevent="submit">
      <p class="panel-description">Compose registered skills, CLI tools, and project configuration. The API validates the definition and returns a plan.</p>
      <label class="field-label" for="package-definition">Full package definition (JSON)</label>
      <textarea id="package-definition" v-model="definition" rows="8" :placeholder="example" :disabled="busy" spellcheck="false" required aria-describedby="package-definition-help"></textarea>
      <p id="package-definition-help" class="configuration-hint">Skills must already exist in the registry. A CLI tool component can specify package, packageManager, and executable; project-config components specify a files object.</p>
      <p v-if="error" class="inline-error" role="alert">{{ error }}</p>
      <button class="button button-secondary button-small" :disabled="busy || !definition.trim()">Preview package registration</button>
    </form>
  </details>
</template>
