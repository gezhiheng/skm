import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import PlanDialog from './PlanDialog.vue'

describe('PlanDialog', () => {
  it('previews changes and emits apply only after the explicit apply button is pressed', async () => {
    const wrapper = mount(PlanDialog, {
      props: {
        plan: { id: 'p-1', action: 'installSkill', name: 'linting', project: 'app', steps: [{ description: 'Link linting', path: '/app/.agents/skills/linting' }] },
        operation: null,
        busy: false,
        error: '',
      },
    })

    expect(wrapper.text()).toContain('Review the proposed changes')
    expect(wrapper.text()).toContain('Link linting')
    expect(wrapper.emitted('apply')).toBeUndefined()
    await wrapper.get('button.button-primary').trigger('click')
    expect(wrapper.emitted('apply')).toHaveLength(1)
  })

  it('disables apply when the server marks the plan unsafe', () => {
    const wrapper = mount(PlanDialog, {
      props: { plan: { id: 'p-2', action: 'removeSkill', name: 'unsafe', safe: false, conflicts: ['Target changed'], steps: [{ description: 'Remove' }] }, operation: null, busy: false, error: '' },
    })
    expect(wrapper.get('button.button-primary').attributes('disabled')).toBeDefined()
    expect(wrapper.text()).toContain('cannot be applied safely')
  })
})
