<script setup lang="ts">
import type { Diagnostic, SystemStatus } from '../api'

defineProps<{ status: SystemStatus | null; diagnostics: Diagnostic[]; loading: boolean }>()
defineEmits<{ refresh: [] }>()

function severityLabel(severity?: string) {
  return severity === 'error' ? 'Error' : severity === 'warning' ? 'Warning' : 'Info'
}
</script>

<template>
  <section class="status-panel panel" aria-labelledby="health-heading">
    <div class="panel-heading"><div><p class="eyebrow">SYSTEM CHECK</p><h2 id="health-heading">Health &amp; diagnostics</h2></div>
      <button class="quiet-button" :disabled="loading" aria-label="Refresh status" @click="$emit('refresh')">↻ <span>Refresh</span></button>
    </div>
    <div class="health-summary">
      <span class="health-mark" :class="status?.health === 'unhealthy' ? 'unhealthy' : status?.health === 'attention' ? 'needs-attention' : 'healthy'">{{ status ? status.health === 'unhealthy' ? '!' : status.health === 'attention' ? '△' : '✓' : '·' }}</span>
      <div><strong>{{ status ? status.health === 'unhealthy' || status.health === 'attention' ? 'Needs attention' : 'System ready' : 'Checking system…' }}</strong><small>Local SKM service status</small></div>
      <span class="connection-label">{{ status ? 'CONNECTED' : 'WAITING' }}</span>
    </div>
    <div class="diagnostics-header"><span>DIAGNOSTICS</span><span>{{ diagnostics.length }} {{ diagnostics.length === 1 ? 'item' : 'items' }}</span></div>
    <div v-if="diagnostics.length" class="diagnostic-list" aria-live="polite">
      <div v-for="(diagnostic, index) in diagnostics" :key="`${diagnostic.message}:${index}`" class="diagnostic-row">
        <span class="severity-icon" :class="`severity-${diagnostic.severity || 'info'}`">{{ diagnostic.severity === 'error' ? '!' : diagnostic.severity === 'warning' ? '△' : 'i' }}</span>
        <div><span class="severity-name">{{ severityLabel(diagnostic.severity) }}</span><p>{{ diagnostic.message }}</p><small v-if="diagnostic.path || diagnostic.project">{{ diagnostic.project }}{{ diagnostic.project && diagnostic.path ? ' · ' : '' }}{{ diagnostic.path }}</small></div>
      </div>
    </div>
    <div v-else class="all-clear"><span>✓</span><div><strong>{{ status ? 'No diagnostics found' : 'Diagnostics unavailable' }}</strong><p>{{ status ? 'Your registered resources look good.' : 'Status will appear when the API responds.' }}</p></div></div>
  </section>
</template>
