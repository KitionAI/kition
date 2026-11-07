import { describe, expect, it, vi } from 'vitest'

const runWorkflowOnRecord = vi.fn()
vi.mock('@/api/workflows', () => ({ runWorkflowOnRecord: (...args: unknown[]) => runWorkflowOnRecord(...args) }))
const settings = { models: { activeProvider: 'kition_console' } }
vi.mock('@/services/desktopSettings', () => ({ loadDesktopSettings: async () => settings }))
const restorePortalAccountSession = vi.fn()
vi.mock('@/services/portalAccount', () => ({ restorePortalAccountSession: () => restorePortalAccountSession() }))

describe('kitionActions', () => {
  it('runs a workflow on a record of the kit\'s document', async () => {
    const { kitionActions } = await import('./kitActions')
    runWorkflowOnRecord.mockResolvedValue({ ok: true })
    await expect(kitionActions('crm/Leads.ktable')['workflow.run']({ workflowId: 'w1', tableId: 1, recordId: 7 })).resolves.toEqual({ done: true })
    expect(runWorkflowOnRecord).toHaveBeenCalledWith('w1', { documentPath: 'crm/Leads.ktable', tableId: '1', recordId: '7' })
    runWorkflowOnRecord.mockResolvedValue({ ok: false, error: 'no mail account' })
    await expect(kitionActions('crm/Leads.ktable')['workflow.run']({ workflowId: 'w1', tableId: 1, recordId: 7 })).resolves.toEqual({ done: false, message: 'no mail account' })
    await expect(kitionActions('crm/Leads.ktable')['workflow.run']({ tableId: 1 })).rejects.toMatchObject({ code: -32000, data: { reason: 'failed' } })
  })

  it('opens Settings where the person sets up AI: Account when Kition Cloud needs a sign-in, else Models', async () => {
    const { kitionActions } = await import('./kitActions')
    const opened: unknown[] = []
    const listen = (event: Event) => opened.push((event as CustomEvent).detail)
    window.addEventListener('kition:settings:open', listen)
    try {
      restorePortalAccountSession.mockResolvedValue(null)
      await expect(kitionActions('a.ktable')['settings.open']({ section: 'ai' })).resolves.toEqual({ done: true })
      restorePortalAccountSession.mockResolvedValue({ token: 't' })
      await kitionActions('a.ktable')['settings.open']({ section: 'ai' })
      settings.models.activeProvider = 'openai'
      restorePortalAccountSession.mockResolvedValue(null)
      await kitionActions('a.ktable')['settings.open']({ section: 'ai' })
      await kitionActions('a.ktable')['settings.open']({ section: 'account' })
      expect(opened).toEqual([{ section: 'account' }, { section: 'models' }, { section: 'models' }, { section: 'account' }])
      await expect(kitionActions('a.ktable')['settings.open']({ section: 'developer' })).rejects.toMatchObject({ code: -32000, data: { reason: 'not-allowed' } })
      expect(opened).toHaveLength(4)
    } finally {
      window.removeEventListener('kition:settings:open', listen)
    }
  })
})
