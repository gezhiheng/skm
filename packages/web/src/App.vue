<script setup lang="ts">
import { computed, ref } from 'vue'
import CatalogPanel from './components/CatalogPanel.vue'
import PlanDialog from './components/PlanDialog.vue'
import ProjectPanel from './components/ProjectPanel.vue'
import StatusPanel from './components/StatusPanel.vue'
import GlobalPanel from './components/GlobalPanel.vue'
import ResourceDialog from './components/ResourceDialog.vue'
import { useDashboard } from './composables/useDashboard'
import type { CatalogItem, PlanRequest } from './api'

const dashboard = useDashboard()
const activeView = ref<'overview' | 'projects'>('overview')
const projectCountLabel = computed(() => String(dashboard.projects.value.length).padStart(2, '0'))
const inspectedResource = ref<CatalogItem | null>(null)

function createPlan(input: PlanRequest) {
  inspectedResource.value = null
  void dashboard.startPlan(input)
}

</script>

<template>
  <div class="app-shell">
    <aside class="sidebar">
      <a class="brand" href="#overview" @click.prevent="activeView = 'overview'">
        <span class="brand-mark">S</span><span><strong>skm</strong><small>skill manager</small></span>
      </a>
      <div class="sidebar-group"><p class="sidebar-label">WORKSPACE</p>
        <nav aria-label="Main navigation">
          <button class="nav-item" :class="{ selected: activeView === 'overview' }" @click="activeView = 'overview'"><span>◫</span>Overview</button>
          <button class="nav-item" :class="{ selected: activeView === 'projects' }" @click="activeView = 'projects'"><span>⌂</span>Projects <b>{{ projectCountLabel }}</b></button>
        </nav>
      </div>
      <div class="sidebar-bottom"><span class="sidebar-status-dot"></span><div><strong>Local workspace</strong><small>Private to this machine</small></div></div>
    </aside>
    <main class="main-area">
      <header class="topbar"><div class="breadcrumbs"><span>SKM</span><span>/</span><strong>{{ activeView === 'overview' ? 'Overview' : 'Projects' }}</strong></div>
        <button class="topbar-button" :disabled="dashboard.loading.value" @click="dashboard.refresh"><span aria-hidden="true">↻</span> Refresh data</button></header>
      <div class="content-wrap">
        <div class="welcome-row"><div><p class="eyebrow">LOCAL-FIRST RESOURCE MANAGEMENT</p><h1>{{ activeView === 'overview' ? 'Your agent workspace' : 'Project workspaces' }}</h1><p class="page-subtitle">{{ activeView === 'overview' ? 'A clear view of the skills and tools your coding agents can use.' : 'Choose a project and manage its skill configuration.' }}</p></div>
          <div class="service-chip" :class="dashboard.systemStatus.value ? 'online' : 'offline'"><span></span>{{ dashboard.systemStatus.value ? 'API connected' : 'Connecting' }}</div></div>

        <div v-if="dashboard.error.value" class="notice error-notice" role="alert"><span>!</span><div><strong>Could not load SKM data</strong><p>{{ dashboard.error.value }}</p></div><button class="quiet-button" @click="dashboard.refresh">Retry</button></div>
        <div v-if="dashboard.message.value" class="notice success-notice" role="status"><span>✓</span><p>{{ dashboard.message.value }}</p><button aria-label="Dismiss notification" @click="dashboard.message.value = ''">×</button></div>

        <div class="summary-grid" aria-label="Workspace summary">
          <article class="summary-card"><span class="summary-icon icon-catalog">✳</span><div><span>Registry items</span><strong>{{ dashboard.catalog.value.length.toString().padStart(2, '0') }}</strong></div><span class="summary-caption">Skills &amp; packages</span></article>
          <article class="summary-card"><span class="summary-icon icon-projects">⌂</span><div><span>Projects</span><strong>{{ projectCountLabel }}</strong></div><span class="summary-caption">Registered workspaces</span></article>
          <article class="summary-card"><span class="summary-icon icon-diagnostics">⌁</span><div><span>Diagnostics</span><strong>{{ dashboard.diagnostics.value.length.toString().padStart(2, '0') }}</strong></div><span class="summary-caption">{{ dashboard.diagnostics.value.length ? 'Needs review' : 'All checks passed' }}</span></article>
        </div>

        <div v-if="dashboard.loading.value" class="loading-bar" role="status"><span></span>Loading your local workspace…</div>
        <div class="dashboard-grid">
          <div class="main-column">
            <CatalogPanel :items="dashboard.catalog.value" :projects="dashboard.projects.value" :selected-project-id="dashboard.selectedProjectId.value" :query="dashboard.query.value" :busy="dashboard.busy.value" @search="dashboard.query.value = $event" @plan="createPlan" @inspect="inspectedResource = $event" @register="dashboard.registerSkill" @register-package="dashboard.registerPackage" />
            <StatusPanel :status="dashboard.systemStatus.value" :diagnostics="dashboard.diagnostics.value" :loading="dashboard.loading.value" @refresh="dashboard.refresh" />
          </div>
          <div class="workspace-column"><ProjectPanel :projects="dashboard.projects.value" :catalog="dashboard.catalog.value" :selected-id="dashboard.selectedProjectId.value" :status="dashboard.selectedProjectId.value === 'global' ? null : dashboard.projectStatus.value" :busy="dashboard.busy.value" @select="dashboard.selectedProjectId.value = $event" @register="dashboard.registerProject" @save-config="dashboard.updateProjectConfig" />
            <GlobalPanel :catalog="dashboard.catalog.value" :config="dashboard.globalConfig.value" :selected="dashboard.selectedProjectId.value === 'global'" :status="dashboard.selectedProjectId.value === 'global' ? dashboard.projectStatus.value : null" :busy="dashboard.busy.value" @select="dashboard.selectedProjectId.value = 'global'" @save-config="dashboard.updateGlobalConfig" /></div>
        </div>
        <footer class="page-footer"><span>SKM <span aria-hidden="true">·</span> Local-first skill management</span><span>Business operations are handled by the local SKM API.</span></footer>
      </div>
    </main>
    <PlanDialog :plan="dashboard.plan.value" :operation="dashboard.operation.value" :busy="dashboard.busy.value" :error="dashboard.planError.value" @apply="dashboard.applyPlan" @close="dashboard.closePlan" />
    <ResourceDialog :item="inspectedResource" :project="dashboard.selectedProjectId.value === 'global' ? 'global' : dashboard.selectedProject.value?.path" :busy="dashboard.busy.value" @close="inspectedResource = null" @plan="createPlan" />
  </div>
</template>
