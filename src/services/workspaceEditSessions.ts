/** Editors register durable flushes so navigation and file mutations can await them. */
const sessions = new Map<() => Promise<void>, string>()
export function registerWorkspaceEditSession(
  flush: () => Promise<void>,
  path: string,
) {
  sessions.set(flush, path)
  return () => {
    sessions.delete(flush)
  }
}
export async function flushWorkspaceEditSessions(path?: string) {
  await Promise.all(
    Array.from(sessions)
      .filter(
        ([, target]) =>
          !path || target === path || target.startsWith(`${path}/`),
      )
      .map(([flush]) => flush()),
  )
}
