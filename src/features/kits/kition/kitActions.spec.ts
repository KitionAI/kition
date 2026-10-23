import { describe, expect, it, vi } from 'vitest'

const runWorkflowOnRecord = vi.fn()
const requestDesignFromRecord = vi.fn()
vi.mock('@/api/workflows', () => ({ runWorkflowOnRecord: (...args: unknown[]) => runWorkflowOnRecord(...args) }))
vi.mock('@/services/workspaceDesignActions', () => ({ requestDesignFromRecord: (...args: unknown[]) => requestDesignFromRecord(...args) }))

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

  it('starts a design from a record, linked back to its cell', async () => {
    const { kitionActions } = await import('./kitActions')
    expect(kitionActions('Shop.ktable')['design.fromRecord']({ title: 'Mug', fields: { Name: 'Mug' }, record: { tableId: 2, recordId: 9, field: 'Designs' } })).toEqual({ done: true })
    expect(requestDesignFromRecord).toHaveBeenCalledWith({ title: 'Mug', fields: { Name: 'Mug' }, record: { path: 'Shop.ktable', tableId: '2', recordId: '9', field: 'Designs' } })
  })
})
