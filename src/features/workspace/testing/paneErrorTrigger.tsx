/**
 * Development-only way to make an editor pane throw during render, so the
 * end-to-end suite can prove the pane boundary keeps the shell alive.
 * Open the app with `?e2e-throw=<paneId>`; production builds compile the
 * component to nothing.
 */
export function PaneErrorTrigger({ paneId }: { paneId: string }) {
  if (!import.meta.env.DEV || typeof window === 'undefined') return null
  const requested = new URLSearchParams(window.location.search).get('e2e-throw')
  if (requested !== paneId) return null
  throw new Error(`e2e: forced render error in the ${paneId} pane`)
}
