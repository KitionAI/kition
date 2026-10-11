import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { notify } from '@/lib/notify'
import type { KitCommand } from '../sdk/kitSdk'
import type { RasterRect } from '../sdk/rasterViewport'
import type { useKitDocument } from '../sdk/useKitDocument'
import { useKitBridge } from './useKitBridge'

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
  // The agent edits this document live while it is open here (Kit AI bridge).
  const { agentEdited } = useKitBridge(document)

  const refreshCommands = useCallback(() => {
    listCommands().then(setCommands, () => undefined)
  }, [listCommands])

  // Enabled states follow the document: at once when it opens, then at most every 250 ms while
  // it changes. A throttle, not a debounce: playback changes it every frame and must not starve it.
  const pending = useRef<number | undefined>(undefined)
  useEffect(() => {
    if (doc) refreshCommands()
  }, [doc, refreshCommands])
  useEffect(() => {
    if (!doc || !change.revision || pending.current !== undefined) return
    pending.current = window.setTimeout(() => {
      pending.current = undefined
      refreshCommands()
    }, COMMAND_REFRESH_MS)
  }, [change.revision, doc, refreshCommands])
  useEffect(() => () => window.clearTimeout(pending.current), [])

  /**
   * Runs a kit command and returns its JSON result; a refusal shows a notice and returns null
   * instead of throwing. `damage` limits the repaint.
   */
  const run = useCallback(async (command: string, params: Record<string, unknown> = {}, damage: RasterRect | null = null): Promise<string | null> => {
    try {
      return (await runCommand(command, params, damage)) ?? 'null'
    } catch (error) {
      notify.error(t('kitEditor.commandFailed'), { description: errorText(error) })
      return null
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

  /**
   * Runs the command a shortcut names if the engine says it can run now. The menus' enabled
   * states lag a change by a moment; a key pressed right after (select, then Delete) must not.
   */
  const runShortcut = useCallback(async (id: string) => {
    const fresh = await listCommands().catch(() => null)
    if (fresh) setCommands(fresh)
    if (fresh?.find((command) => command.id === id)?.enabled) await run(id)
  }, [listCommands, run])

  /** The agent edits the file on disk, so unsaved edits are saved first. */
  const askAgent = useCallback(async () => {
    if (dirty && !(await save())) return
    options.onOpenAgent?.()
  }, [dirty, options, save])

  return { commands, refreshCommands, run, runShortcut, save, askAgent, canAskAgent: Boolean(options.onOpenAgent), agentEdited }
}
