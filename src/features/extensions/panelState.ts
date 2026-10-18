import { useSyncExternalStore } from 'react'

/** A contributed panel open next to a kit document's editor. */
export type OpenPanel = { extension: string; panel: string }

/**
 * The extension panel open beside each kit document (by workspace path): the palette opens one,
 * `ExtensionPanelSlot` shows it, its close button (or the extension going away) closes it. One
 * panel per document; opening another replaces it.
 */
const open = new Map<string, OpenPanel>()
const listeners = new Set<() => void>()

function changed() {
  for (const listener of [...listeners]) listener()
}

export function openExtensionPanel(path: string, panel: OpenPanel) {
  const known = open.get(path)
  if (known?.extension === panel.extension && known.panel === panel.panel) return
  open.set(path, { ...panel })
  changed()
}

export function closeExtensionPanel(path: string) {
  if (open.delete(path)) changed()
}

export function useOpenExtensionPanel(path: string): OpenPanel | null {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    () => open.get(path) ?? null,
  )
}
