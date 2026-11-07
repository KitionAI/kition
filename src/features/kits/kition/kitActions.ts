import { runWorkflowOnRecord } from '@/api/workflows'
import { loadDesktopSettings } from '@/services/desktopSettings'
import { restorePortalAccountSession } from '@/services/portalAccount'
import { KitRpcError } from '../host/protocol'

/** A refusal of `host/action` (Kit UI protocol section 7j), with its reason. */
function refuse(reason: string, message: string): never {
  throw new KitRpcError(-32000, message, { reason })
}

function text(value: unknown) {
  return typeof value === 'string' || typeof value === 'number' ? String(value).trim() : ''
}

/**
 * The Settings section `settings.open` shows for `section`: `ai` is wherever the person sets up the
 * model a kit's generation needs (Account while Kition Cloud is the active provider and nobody is
 * signed in, else Models); `models` and `account` name theirs. Anything else is not a kit's to open.
 */
async function settingsSection(section: unknown): Promise<'models' | 'account'> {
  if (section === 'models' || section === 'account') return section
  if (section !== 'ai') refuse('not-allowed', `a kit may not open the Settings section ${JSON.stringify(section)}`)
  const settings = await loadDesktopSettings()
  if (settings.models.activeProvider !== 'kition_console') return 'models'
  return (await restorePortalAccountSession().catch(() => null)) ? 'models' : 'account'
}

/**
 * The host actions Kition serves a kit editing `path` (Kit UI protocol 2.2 section 7j,
 * capabilities `action:<id>`): `workflow.run` runs one of Kition's workflows on a record of the
 * document (a table's button field); `settings.open` (`{ section: 'ai' | 'models' | 'account' }`)
 * opens Settings where the person sets up AI, the next step of a `host/generate` refused as
 * `unavailable`.
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
    'settings.open': async (params: Record<string, unknown>) => {
      const section = await settingsSection(params.section)
      window.dispatchEvent(new CustomEvent('kition:settings:open', { detail: { section } }))
      return { done: true }
    },
  }
}
