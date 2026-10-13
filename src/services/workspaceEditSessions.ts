/** Editors register durable flushes so navigation and file mutations can await them. */
type WorkspaceEditSession = {
  path: string
  /** Drops the editor's unsaved edits: it stops saving and retrying, and writes nothing more. */
  discard?: () => void
}

const sessions = new Map<() => Promise<void>, WorkspaceEditSession>()

const isUnder = (target: string, path?: string) =>
  !path || target === path || target.startsWith(`${path}/`)

export function registerWorkspaceEditSession(
  flush: () => Promise<void>,
  path: string,
  options: { discard?: () => void } = {},
) {
  sessions.set(flush, { path, discard: options.discard })
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
/** Drops the unsaved edits of the editors open on `path` that can discard them; nothing is written. */
export function discardWorkspaceEditSessions(path: string) {
  for (const session of sessions.values()) {
    if (isUnder(session.path, path)) session.discard?.()
  }
}
