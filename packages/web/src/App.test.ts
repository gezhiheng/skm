import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import App from './App.vue'

const wrappers: VueWrapper[] = []
afterEach(() => {
  wrappers.forEach(wrapper => wrapper.unmount())
  wrappers.length = 0
  vi.unstubAllGlobals()
})

function mockServer(applySuccess = true) {
  let installed = false
  const skill = { type: 'skill', name: 'linting', description: 'Check project conventions', source: '/central/linting' }
  const projects = [{ id: 'project-b', path: '/tmp/project B' }, { id: 'project-a', path: '/tmp/project A' }]
  const requests: Array<{ path: string; method: string; body?: unknown }> = []
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input)
    const method = init?.method ?? 'GET'
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined
    requests.push({ path, method, body })
    let data: unknown
    if (path === '/api/catalog') data = { items: [skill] }
    else if (path === '/api/projects') data = { items: projects }
    else if (path === '/api/status') data = { health: 'healthy', diagnostics: [] }
    else if (path === '/api/global/config' && method === 'GET') data = { skills: ['linting'] }
    else if (path === '/api/global/status') data = { skills: [] }
    else if (path.startsWith('/api/projects/') && path.endsWith('/status')) {
      const forA = path.includes('project-a')
      data = { config: { inheritGlobal: false, skills: ['linting'] }, skills: [{ name: 'linting', state: installed && forA ? 'installed' : 'missing', expected: [`/tmp/project ${forA ? 'A' : 'B'}/.agents/skills/linting`], actual: installed && forA ? ['/tmp/project A/.agents/skills/linting'] : [] }] }
    } else if (path.startsWith('/api/catalog/linting')) {
      data = { item: skill, components: [{ component: { type: 'skill', skill: 'linting' }, state: 'missing', description: 'Skill is not installed in this target.', paths: ['/tmp/project A/.agents/skills/linting'] }] }
    } else if (path === '/api/plans') {
      data = { id: 'install-plan', action: 'skill:install', safe: true, args: body, component: 'linting', affectedProject: '/tmp/project A', steps: [{ description: 'Link linting', source: '/central/linting', path: '/tmp/project A/.agents/skills/linting' }] }
    } else if (path === '/api/global/config' && method === 'PUT') {
      data = { id: 'global-plan', action: 'global:configure', safe: true, steps: [{ description: 'Write global desired selection' }] }
    } else if (path === '/api/plans/install-plan/apply') {
      installed = applySuccess
      data = applySuccess
        ? { planId: 'install-plan', success: true, completed: ['Link linting'] }
        : { planId: 'install-plan', success: false, completed: ['Preserve existing configuration'], failed: { step: 'Link linting', error: 'The target changed. Create a fresh preview before retrying.' } }
    } else throw new Error(`Unexpected request: ${method} ${path}`)
    return new Response(JSON.stringify(data))
  })
  vi.stubGlobal('fetch', fetchMock)
  return requests
}

describe('App workflows', () => {
  it('browses a skill, selects its project, previews, explicitly applies, and shows the verified installation', async () => {
    const requests = mockServer()
    const wrapper = mount(App)
    wrappers.push(wrapper)
    await flushPromises()

    expect(wrapper.findAll('.resource-card')).toHaveLength(1)
    await wrapper.findAll('[role="option"]')[1].trigger('click')
    await flushPromises()
    expect(wrapper.get('.install-toolbar').text()).toContain('project A')
    await wrapper.get('.resource-title-button').trigger('click')
    await flushPromises()
    expect(wrapper.get('.resource-dialog').text()).toContain('Skill is not installed in this target.')
    expect(wrapper.get('.inspection-paths').text()).toContain('/tmp/project A/.agents/skills/linting')
    expect(requests).toContainEqual({ path: '/api/catalog/linting?project=%2Ftmp%2Fproject%20A', method: 'GET', body: undefined })
    await wrapper.get('[aria-label="Close resource details"]').trigger('click')

    await wrapper.get('.resource-card .button-primary').trigger('click')
    await flushPromises()
    expect(requests).toContainEqual({ path: '/api/plans', method: 'POST', body: { action: 'installSkill', name: 'linting', project: 'project-a', mode: 'symlink' } })
    expect(wrapper.get('.operation-dialog').text()).toContain('Review the proposed changes')
    expect(wrapper.get('#operation-title').text()).toBe('Install skill')
    expect(requests.some(request => request.path.endsWith('/apply'))).toBe(false)

    await wrapper.get('.operation-dialog .button-primary').trigger('click')
    await flushPromises()
    expect(requests).toContainEqual({ path: '/api/plans/install-plan/apply', method: 'POST', body: { confirmed: true } })
    expect(wrapper.get('.operation-dialog').text()).toContain('Verified complete')
    expect(wrapper.get('.operation-dialog').text()).toContain('Link linting')
    expect(wrapper.get('.project-panel .installation-row').text()).toContain('installed')
    expect(wrapper.get('.project-panel .installation-paths').text()).toContain('/tmp/project A/.agents/skills/linting')
  })

  it('previews global desired selection and sends explicit copy installs to the global target', async () => {
    const requests = mockServer()
    const wrapper = mount(App)
    wrappers.push(wrapper)
    await flushPromises()

    await wrapper.get('.global-panel input[type="checkbox"]').setValue(false)
    await wrapper.get('.global-panel .full-width').trigger('click')
    await flushPromises()
    expect(requests).toContainEqual({ path: '/api/global/config', method: 'PUT', body: { skills: [] } })
    expect(requests.some(request => request.path.endsWith('/apply'))).toBe(false)
    await wrapper.get('[aria-label="Close preview"]').trigger('click')

    await wrapper.get('.global-target').trigger('click')
    await wrapper.get('.install-toolbar select').setValue('copy')
    await flushPromises()
    expect(wrapper.get('.install-toolbar').text()).toContain('Global agent skills')
    await wrapper.get('.resource-title-button').trigger('click')
    await flushPromises()
    expect(requests).toContainEqual({ path: '/api/catalog/linting?project=global', method: 'GET', body: undefined })
    expect(wrapper.get('.resource-dialog').text()).toContain('Inspected for the global target')
    await wrapper.get('[aria-label="Close resource details"]').trigger('click')
    await wrapper.get('.resource-card .button-primary').trigger('click')
    await flushPromises()
    expect(requests).toContainEqual({ path: '/api/plans', method: 'POST', body: { action: 'installSkill', name: 'linting', project: 'global', mode: 'copy' } })
  })

  it('reports completed and failed steps without claiming a partial operation succeeded', async () => {
    mockServer(false)
    const wrapper = mount(App)
    wrappers.push(wrapper)
    await flushPromises()

    await wrapper.get('.resource-card .button-primary').trigger('click')
    await flushPromises()
    await wrapper.get('.operation-dialog .button-primary').trigger('click')
    await flushPromises()

    expect(wrapper.get('.operation-dialog').text()).toContain('Operation failed')
    expect(wrapper.get('.operation-dialog').text()).toContain('Preserve existing configuration')
    expect(wrapper.get('.operation-dialog').text()).toContain('Create a fresh preview before retrying')
    expect(wrapper.get('.operation-dialog').text()).not.toContain('Verified complete')
    expect(wrapper.get('.project-panel .installation-row').text()).toContain('missing')
    expect(wrapper.find('.success-notice').exists()).toBe(false)
  })
})
