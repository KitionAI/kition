import { useSyncExternalStore } from 'react'

/** Whether the Run script dialog is open: the palette opens it, `ExtensionDialogs` shows it. */
let open = false
const listeners = new Set<() => void>()

function set(next: boolean) {
  if (open === next) return
  open = next
  for (const listener of [...listeners]) listener()
}

export const openRunScriptDialog = () => set(true)
export const closeRunScriptDialog = () => set(false)

export function useRunScriptDialogOpen() {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    () => open,
  )
}
