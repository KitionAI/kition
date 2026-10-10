import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { notify } from '@/lib/notify'
import type { KitCommand } from '../sdk/kitSdk'
import type { RasterRect } from '../sdk/rasterViewport'
import type { useKitDocument } from '../sdk/useKitDocument'

type KitDocument = ReturnType<typeof useKitDocument<unknown>>

const COMMAND_REFRESH_MS = 250

function errorText(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

/**
 * What every kit editor does the same way on top of its document: running
 * commands with a notice when they fail, saving with a notice, the command
 * menus, and saving before the agent works on the file.
 */
export function useKitEditor(document: KitDocument, options: { onOpenAgent?: () => void } = {}) {
  const { t } = useTranslation('workspace')
  const [commands, setCommands] = useState<KitCommand[]>([])
  const { doc, run: runCommand, save: saveDocument, commands: listCommands, dirty, change } = document

  const refreshCommands = useCallback(() => {
    listCommands().then(setCommands, () => undefined)
  }, [listCommands])

  // Enabled states follow the document: after it opens and shortly after each change.
  useEffect(() => {
    if (!doc) return undefined
    const timer = window.setTimeout(refreshCommands, change.revision ? COMMAND_REFRESH_MS : 0)
    return () => window.clearTimeout(timer)
  }, [change.revision, doc, refreshCommands])

  /** Runs a kit command; a refusal shows a notice instead of throwing. `damage` limits the repaint. */
  const run = useCallback(async (command: string, params: Record<string, unknown> = {}, damage: RasterRect | null = null) => {
    try {
      await runCommand(command, params, damage)
      return true
    } catch (error) {
      notify.error(t('kitEditor.commandFailed'), { description: errorText(error) })
      return false
    }
  }, [runCommand, t])

  const save = useCallback(async () => {
    try {
      await saveDocument()
      notify.success(t('kitEditor.saved'))
      return true
    } catch (error) {
      notify.error(t('kitEditor.saveFailed'), { description: errorText(error) })
      return false
    }
  }, [saveDocument, t])

  /** The agent edits the file on disk, so unsaved edits are saved first. */
  const askAgent = useCallback(async () => {
    if (dirty && !(await save())) return
    options.onOpenAgent?.()
  }, [dirty, options, save])

  return { commands, refreshCommands, run, save, askAgent, canAskAgent: Boolean(options.onOpenAgent) }
}
