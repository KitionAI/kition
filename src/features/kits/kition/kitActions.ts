import { runWorkflowOnRecord } from '@/api/workflows'
import { KitRpcError } from '../host/protocol'

/** A refusal of `host/action` (Kit UI protocol section 7j), with its reason. */
function refuse(reason: string, message: string): never {
  throw new KitRpcError(-32000, message, { reason })
}

function text(value: unknown) {
  return typeof value === 'string' || typeof value === 'number' ? String(value).trim() : ''
}

/**
 * The host actions Kition serves a kit editing `path` (Kit UI protocol 2.2 section 7j,
 * capabilities `action:<id>`): `workflow.run` runs one of Kition's workflows on a record of the
 * document (a table's button field).
 */
export function kitionActions(path: string) {
  return {
    'workflow.run': async (params: Record<string, unknown>) => {
      const workflowId = text(params.workflowId)
      const tableId = text(params.tableId)
      const recordId = text(params.recordId)
      if (!workflowId || !tableId || !recordId) refuse('failed', 'workflow.run needs workflowId, tableId, and recordId')
      const answer = await runWorkflowOnRecord(workflowId, { documentPath: path, tableId, recordId }).catch((error: unknown) => {
        const status = (error as { response?: { status?: number } } | null)?.response?.status
        refuse(status === 404 ? 'not-found' : 'failed', error instanceof Error ? error.message : String(error))
      })
      return answer.ok ? { done: true } : { done: false, ...(answer.error ? { message: answer.error } : {}) }
    },
  }
}
