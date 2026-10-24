/** Editors register durable flushes so navigation and file mutations can await them. */
const sessions = new Map<() => Promise<void>, { path: string }>()

const isUnder = (target: string, path?: string) =>
  !path || target === path || target.startsWith(`${path}/`)

export function registerWorkspaceEditSession(flush: () => Promise<void>, path: string) {
  sessions.set(flush, { path })
  return () => {
    sessions.delete(flush)
  }
}
export async function flushWorkspaceEditSessions(path?: string) {
  await Promise.all(
    Array.from(sessions)
      .filter(([, session]) => isUnder(session.path, path))
      .map(([flush]) => flush()),
  )
}
