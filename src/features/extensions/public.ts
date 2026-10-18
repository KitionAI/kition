/**
 * Extensions in Kition (`KitExtensions 1.0`): installed from the workspace into the app's own
 * storage, run sandboxed against open kit documents, with their commands in the command palette;
 * and workspace scripts run the same way. Everything here loads the extension host lazily, so a
 * window without extensions does not load it.
 */
import { createElement, lazy, Suspense, useEffect, useState } from 'react'
import type { ExtensionService } from './extensionService'
import type { InstalledExtension } from './extensionStore'
import { closeRunScriptDialog, openRunScriptDialog, useRunScriptDialogOpen } from './runScriptDialogState'

export type { InstalledExtension } from './extensionStore'

const RunScriptDialog = lazy(() => import('./RunScriptDialog'))

/** What Settings > Extensions shows and does. */
export type ExtensionsApi = {
  ready: boolean
  installed: InstalledExtension[]
  install: ExtensionService['install']
  setEnabled: ExtensionService['setEnabled']
  remove: ExtensionService['remove']
}

/** The installed extensions and how to change them; `null` while the extension host loads. */
export function useExtensions(): ExtensionsApi | null {
  const [api, setApi] = useState<ExtensionsApi | null>(null)
  useEffect(() => {
    let live = true
    let unsubscribe = () => {}
    void import('./extensionService').then(({ extensionService }) => {
      if (!live) return
      const service = extensionService()
      const read = () =>
        setApi({ ...service.getSnapshot(), install: (path) => service.install(path), setEnabled: (id, enabled) => service.setEnabled(id, enabled), remove: (id) => service.remove(id) })
      unsubscribe = service.subscribe(read)
      read()
    })
    return () => {
      live = false
      unsubscribe()
    }
  }, [])
  return api
}

/** The extension dialogs (Run script), mounted once by the shell. */
export function ExtensionDialogs() {
  const open = useRunScriptDialogOpen()
  return open ? createElement(Suspense, { fallback: null }, createElement(RunScriptDialog, { onClose: closeRunScriptDialog })) : null
}

/** Starts the extension host when an installed extension is enabled (so it can activate on open). */
export async function startInstalledExtensions() {
  const { listInstalledExtensions } = await import('./extensionStore')
  const installed = await listInstalledExtensions().catch(() => [])
  if (!installed.some((extension) => extension.enabled)) return
  ;(await import('./extensionService')).extensionService()
}

/** One command palette entry. */
export type ExtensionPaletteItem = { key: string; title: string; hint: string; run: () => void }

/**
 * The palette's extension entries for the kit document shown now: the commands enabled extensions
 * contribute to it, and Run script. Empty when no kit document is shown.
 */
export function useExtensionPaletteItems(labels: { runScript: string; runScriptHint: string }): ExtensionPaletteItem[] {
  const [items, setItems] = useState<ExtensionPaletteItem[]>([])
  useEffect(() => {
    let live = true
    void import('./extensionService').then(async ({ extensionService }) => {
      const service = extensionService()
      await service.ready
      if (!live || !service.activeDocument()) return
      const commands = service.paletteCommands().map((command) => ({
        key: `extension:${command.extension}:${command.id}`,
        title: command.title,
        hint: command.description ?? command.extensionName,
        run: () => void service.runCommand(command),
      }))
      setItems([...commands, { key: 'run-script', title: labels.runScript, hint: labels.runScriptHint, run: openRunScriptDialog }])
    })
    return () => {
      live = false
    }
  }, [labels.runScript, labels.runScriptHint])
  return items
}
