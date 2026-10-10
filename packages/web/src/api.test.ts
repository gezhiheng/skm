import { afterEach, describe, expect, it, vi } from 'vitest'
import { api } from './api'

afterEach(() => vi.unstubAllGlobals())

describe('web API client', () => {
  it('encodes catalog search and unwraps the API items envelope', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ items: [{ name: 'file skill', type: 'skill' }] })))
    vi.stubGlobal('fetch', fetchMock)

    await expect(api.catalog('file skill & tools')).resolves.toEqual([{ name: 'file skill', type: 'skill' }])
    expect(fetchMock.mock.calls[0][0]).toBe('/api/catalog?q=file%20skill%20%26%20tools')
  })

  it('requests registration as a plan and applies only with explicit confirmation', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 'plan-1', action: 'skill:register', safe: true, steps: [] })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ planId: 'plan-1', success: true, completed: [] })))
    vi.stubGlobal('fetch', fetchMock)

    const plan = await api.registerSkill('/tmp/example-skill')
    await api.applyPlan(plan.id)
    expect(fetchMock.mock.calls[0][0]).toBe('/api/skills/register')
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ path: '/tmp/example-skill' })
    expect(fetchMock.mock.calls[1][0]).toBe('/api/plans/plan-1/apply')
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({ confirmed: true })
  })

  it('turns API errors into actionable messages', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: 'Project is not registered' }), { status: 404 })))
    await expect(api.projects()).rejects.toThrow('Project is not registered')
  })

  it('encodes resource inspection names and the optional project path', async () => {
    const inspection = { item: { name: 'my skill', type: 'skill' }, components: [] }
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(inspection)))
    vi.stubGlobal('fetch', fetchMock)

    await expect(api.inspectResource('my skill', '/tmp/project & tools')).resolves.toEqual(inspection)
    expect(fetchMock.mock.calls[0][0]).toBe('/api/catalog/my%20skill?project=%2Ftmp%2Fproject%20%26%20tools')
    await api.inspectResource('my skill')
    expect(fetchMock.mock.calls[1][0]).toBe('/api/catalog/my%20skill')
  })

  it('reads global state and previews global config before applying', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ skills: ['linting'] })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ skills: [{ name: 'linting', state: 'missing', expected: ['/global/linting'], actual: [] }] })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 'global-1', action: 'global:configure', steps: [] })))
    vi.stubGlobal('fetch', fetchMock)

    await expect(api.globalConfig()).resolves.toEqual({ skills: ['linting'] })
    expect((await api.globalStatus()).skills?.[0].state).toBe('missing')
    await api.updateGlobalConfig({ skills: ['linting'] })
    expect(fetchMock.mock.calls.map(call => call[0])).toEqual(['/api/global/config', '/api/global/status', '/api/global/config'])
    expect(fetchMock.mock.calls[2][1].method).toBe('PUT')
    expect(JSON.parse(fetchMock.mock.calls[2][1].body)).toEqual({ skills: ['linting'] })
  })

  it('keeps source updates, registry removal, and central deletion as distinct plan requests', async () => {
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(new Response(JSON.stringify({ id: 'resource-1', steps: [] }))))
    vi.stubGlobal('fetch', fetchMock)

    const requests = [
      { action: 'updateSkill' as const, name: 'linting', path: '/tmp/new linting' },
      { action: 'unregisterSkill' as const, name: 'linting', deleteSource: false },
      { action: 'unregisterSkill' as const, name: 'linting', deleteSource: true },
    ]
    for (const input of requests) await api.createPlan(input)
    expect(fetchMock.mock.calls.map(call => JSON.parse(call[1].body))).toEqual(requests)
    expect(fetchMock.mock.calls.every(call => call[0] === '/api/plans')).toBe(true)
  })

  it('previews composite package registration through the shared API', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ id: 'package-1', action: 'package:register', steps: [] })))
    vi.stubGlobal('fetch', fetchMock)
    const definition = { name: 'example-toolkit', components: [{ type: 'skill' as const, skill: 'linting' }, { type: 'project-config' as const, files: { 'example.md': 'Example only' } }] }

    await api.registerPackage(definition)
    expect(fetchMock.mock.calls[0][0]).toBe('/api/packages/register')
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual(definition)
  })
})
