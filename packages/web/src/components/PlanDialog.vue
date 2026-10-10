<script setup lang="ts">
import { ref } from 'vue'
import type { OperationResult, Plan } from '../api'
import { useDialog } from '../composables/useDialog'

const props = defineProps<{
  plan: Plan | null
  operation: OperationResult | null
  busy: boolean
  error: string
}>()
const emit = defineEmits<{ apply: []; close: [] }>()
const dialog = ref<HTMLElement | null>(null)
useDialog(dialog, () => !!props.plan, () => !props.busy, () => emit('close'))

function actionLabel(action?: string) {
  if (action === 'skill:register') return 'Register skill'
  if (action === 'project:add') return 'Register project'
  if (action === 'project:configure') return 'Update project settings'
  if (action === 'installSkill' || action === 'skill:install') return 'Install skill'
  if (action === 'removeSkill' || action === 'skill:remove') return 'Uninstall skill'
  if (action === 'installPackage' || action === 'package:install') return 'Install package'
  if (action === 'package:remove') return 'Uninstall package'
  if (action === 'initPackage' || action === 'package:init') return 'Initialize project configuration'
  if (action === 'configureProject') return 'Update project settings'
  if (action === 'global:configure') return 'Update global selection'
  if (action === 'skill:update') return 'Update central Skill source'
  if (action === 'skill:remove-registry') return 'Remove from central registry'
  if (action === 'package:register') return 'Register package definition'
  return 'Review operation'
}
</script>

<template>
  <div v-if="plan" class="dialog-backdrop" @click.self="!busy && emit('close')">
    <section ref="dialog" class="operation-dialog" role="dialog" aria-modal="true" aria-labelledby="operation-title" aria-describedby="operation-description" tabindex="-1">
      <div class="dialog-header"><div><p class="eyebrow">SAFE OPERATION</p><h2 id="operation-title">{{ operation ? 'Operation result' : actionLabel(plan.action) }}</h2></div>
        <button v-if="!busy" class="close-button" aria-label="Close preview" @click="emit('close')">×</button></div>
      <template v-if="!operation">
        <p id="operation-description" class="dialog-intro">Review the proposed changes to <strong>{{ plan.name || plan.component || plan.action }}</strong>{{ plan.project || plan.affectedProject ? ` in ${plan.project || plan.affectedProject}` : '' }} before applying them.</p>
        <div class="plan-meta"><span>PLAN ID</span><code>{{ plan.id }}</code></div>
        <div v-if="plan.safe === false || plan.conflicts?.length" class="warning-box conflict-box"><strong>{{ plan.safe === false ? 'This plan has conflicts and cannot be applied safely.' : 'Potential conflicts' }}</strong><ul><li v-for="conflict in plan.conflicts" :key="conflict">{{ conflict }}</li></ul></div>
        <div class="plan-steps-heading">Planned changes <span>{{ plan.steps.length }}</span></div>
        <ol class="plan-steps">
          <li v-for="(step, index) in plan.steps" :key="`${step.label}:${step.target}:${index}`">
            <span class="step-number">{{ String(index + 1).padStart(2, '0') }}</span>
            <span><strong>{{ step.label || step.description || 'Resource change' }}</strong><small v-if="step.source || step.target || step.path">{{ step.source || '—' }}<span v-if="step.source && (step.target || step.path)"> → </span>{{ step.target || step.path }}</small></span>
            <span v-if="step.status" class="tag">{{ step.status }}</span>
          </li>
          <li v-if="!plan.steps.length" class="empty-plan">{{ plan.externalCommands?.length ? 'No local filesystem steps. Review the external commands below.' : 'The API returned an empty plan. There are no changes to apply.' }}</li>
        </ol>
        <div v-if="plan.externalCommands?.length" class="warning-box command-box"><strong>External commands to run</strong><ul><li v-for="(command, index) in plan.externalCommands" :key="index"><code>{{ command.join(' ') }}</code></li></ul></div>
        <div v-if="plan.warnings?.length" class="warning-box"><strong>Review warnings</strong><ul><li v-for="warning in plan.warnings" :key="warning">{{ warning }}</li></ul></div>
        <div v-if="plan.preserves?.length" class="preservation-box"><strong>Preserved resources</strong><ul><li v-for="path in plan.preserves" :key="path">{{ path }}</li></ul></div>
        <p v-if="error" class="inline-error" role="alert">{{ error }}</p>
        <div class="dialog-actions"><button class="button button-secondary" :disabled="busy" @click="emit('close')">Cancel</button>
          <button class="button button-primary" :disabled="busy || (!plan.steps.length && !plan.externalCommands?.length) || plan.safe === false || !!plan.conflicts?.length" @click="emit('apply')">{{ busy ? 'Applying…' : 'Apply this change' }} <span aria-hidden="true">→</span></button></div>
        <p class="confirmation-hint">Applying is a separate, explicit step. Nothing changes until you confirm.</p>
      </template>
      <template v-else>
        <div class="result-banner" :class="operation.success ? 'result-success' : 'result-failure'">
          <span>{{ operation.success ? '✓' : '!' }}</span><div><strong>{{ operation.success ? 'Verified complete' : 'Operation failed' }}</strong><p>{{ operation.summary || (operation.success ? 'The operation completed.' : 'SKM could not complete the requested operation.') }}</p></div>
        </div>
        <div v-if="operation.steps?.length" class="result-steps"><div v-for="(step, index) in operation.steps" :key="`${step.label}:${index}`" class="result-step">
          <span :class="step.status === 'failed' || step.status === 'error' ? 'result-failure-text' : 'result-success-text'">{{ step.status === 'failed' || step.status === 'error' ? '!' : '✓' }}</span><div><strong>{{ step.label || 'Operation step' }}</strong><small v-if="step.message">{{ step.message }}</small></div><span class="tag">{{ step.status || 'done' }}</span>
        </div></div>
        <p v-if="operation.diagnostics?.length" class="inline-error" role="alert">{{ operation.diagnostics.map(item => item.message).join(' ') }}</p>
        <p v-if="error" class="inline-error" role="alert">{{ error }}</p>
        <div class="dialog-actions"><button class="button button-primary" @click="emit('close')">Done</button></div>
      </template>
    </section>
  </div>
</template>
