/**
 * Leaving the desktop window: closing it, quitting Kition, or reloading the page. Each would drop
 * the edits that live only in open editors (a kit document's unsaved edits), so the shell asks the
 * renderer first and the screen that holds those editors registers a guard that may ask the
 * person. Without a guard the window leaves at once.
 */
export type DesktopLeave = 'close' | 'quit' | 'reload'

/** Answers whether the window may leave now (`true`), after asking the person when it must. */
export type DesktopLeaveGuard = (leave: DesktopLeave) => Promise<boolean>

let guard: DesktopLeaveGuard | null = null

/** Registers the guard asked before the window leaves; answers its withdrawal. */
export function setDesktopLeaveGuard(next: DesktopLeaveGuard) {
  guard = next
  return () => {
    if (guard === next) guard = null
  }
}

/** Whether the window may leave now; a guard that fails keeps it (the edits are worth more). */
export async function mayLeaveDesktop(leave: DesktopLeave) {
  if (!guard) return true
  try {
    return await guard(leave)
  } catch (error) {
    console.warn('[desktop] could not ask before leaving; staying', error)
    return false
  }
}

/** The menu actions the shell sends the renderer for leaving (`src-tauri/src/menu.rs`). */
export const LEAVE_MENU_ACTIONS: Readonly<Record<string, Exclude<DesktopLeave, 'close'>>> = { quit: 'quit', 'reload-window': 'reload' }
