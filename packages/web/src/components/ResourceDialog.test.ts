import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import ResourceDialog from './ResourceDialog.vue'

const wrappers: VueWrapper[] = []
afterEach(() => {
  wrappers.forEach(wrapper => wrapper.unmount())
  wrappers.length = 0
  vi.unstubAllGlobals()
})

const item = { name: 'linting', type: 'skill', source: '/central/linting' }

describe('ResourceDialog', () => {
  it('shows API component state and paths, and emits distinct update and removal previews', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ item, components: [{ component: { type: 'skill', skill: 'linting' }, state: 'broken-link', description: 'The managed link target is missing.', paths: ['/project/.agents/skills/linting'] }] }))))
    const wrapper = mount(ResourceDialog, { props: { item, project: '/project', busy: false } })
    wrappers.push(wrapper)
    await flushPromises()

    expect(wrapper.text()).toContain('broken-link')
    expect(wrapper.text()).toContain('The managed link target is missing.')
    expect(wrapper.get('.inspection-paths').text()).toContain('/project/.agents/skills/linting')
    await wrapper.get('#update-path').setValue('  /tmp/new skill  ')
    await wrapper.get('form').trigger('submit')
    await wrapper.findAll('.management-actions button')[0].trigger('click')
    await wrapper.findAll('.management-actions button')[1].trigger('click')
    expect(wrapper.emitted('plan')).toEqual([
      [{ action: 'updateSkill', name: 'linting', path: '/tmp/new skill' }],
      [{ action: 'unregisterSkill', name: 'linting', deleteSource: false }],
      [{ action: 'unregisterSkill', name: 'linting', deleteSource: true }],
    ])
  })

  it('shows an actionable inspection error without disabling safe registry controls', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: 'Project is not registered. Register it before inspection.' }), { status: 404 })))
    const wrapper = mount(ResourceDialog, { props: { item, busy: false } })
    wrappers.push(wrapper)
    await flushPromises()

    expect(wrapper.get('[role="alert"]').text()).toContain('Register it before inspection')
    expect(wrapper.get('.management-actions button').attributes('disabled')).toBeUndefined()
  })
})
