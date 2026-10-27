import { describe, expect, it, vi } from 'vitest'

const runWorkflowOnRecord = vi.fn()
vi.mock('@/api/workflows', () => ({ runWorkflowOnRecord: (...args: unknown[]) => runWorkflowOnRecord(...args) }))

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
})
