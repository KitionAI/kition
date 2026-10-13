/**
 * The open Markdown document sessions of this window, by workspace path. Inactive tabs keep their
 * session (and so their replica and undo history) here. Kition's own writers of other documents
 * (tag rename, daily notes, new notes from links) write through `writeWorkspaceMarkdown` and
 * `updateWorkspaceMarkdown`: an open document takes the change as an edit of its replica, which
 * its session saves; any other file is written directly.
 */
import { person } from '@/lib/kdm'
import { readWorkspaceDocument, writeWorkspaceDocument } from '@/services/desktop'
import { LOCAL_PERSON, type DocumentSession } from './documentSession'

const sessions = new Map<string, DocumentSession>()
const listeners = new Set<() => void>()

function changed() {
  for (const listener of listeners) listener()
}

/** The session open on `path`, if it is ready for editing. */
export function getDocumentSession(path: string): DocumentSession | null {
  const session = sessions.get(path)
  return session && session.isReady() ? session : null
}

/** The session registered for `path`, ready or still opening. */
export function findDocumentSession(path: string): DocumentSession | null {
  return sessions.get(path) ?? null
}

export function listDocumentSessions(): DocumentSession[] {
  return [...sessions.values()]
}

export function registerDocumentSession(session: DocumentSession) {
  sessions.set(session.path, session)
  changed()
}

/** Forgets `session` (it stays as it is: dispose or discard it separately). */
export function unregisterDocumentSession(session: DocumentSession) {
  if (sessions.get(session.path) !== session) return
  sessions.delete(session.path)
  changed()
}

/** Moves the sessions under `sourcePath` (a file or a folder) to `targetPath` after a rename or move. */
export function remapDocumentSessions(sourcePath: string, targetPath: string) {
  if (!sourcePath || !targetPath || sourcePath === targetPath) return
  const moved: Array<[string, DocumentSession]> = []
  for (const [path, session] of sessions) {
    const next = path === sourcePath
      ? targetPath
      : path.startsWith(`${sourcePath}/`) ? `${targetPath}${path.slice(sourcePath.length)}` : path
    if (next !== path) moved.push([next, session])
  }
  if (!moved.length) return
  for (const [, session] of moved) sessions.delete(session.path)
  for (const [next, session] of moved) {
    session.setPath(next)
    sessions.set(next, session)
  }
  changed()
}

/** Calls `listener` when sessions are registered, removed, or moved. */
export function subscribeDocumentSessions(listener: () => void) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

const writerOrigin = (label: string) => person(LOCAL_PERSON, label)

/** The text of a Markdown file: the open document's live text when it is open, else the file. */
export async function readWorkspaceMarkdown(path: string): Promise<string> {
  const session = getDocumentSession(path)
  if (session) return session.read()
  return (await readWorkspaceDocument(path)).content ?? ''
}

/**
 * Writes the whole text of a Markdown file: into the open document (as one undoable edit, saved
 * by its session) when it is open, else to the file.
 */
export async function writeWorkspaceMarkdown(path: string, content: string, label = 'write'): Promise<void> {
  const session = getDocumentSession(path)
  if (session) {
    session.replaceText(content, writerOrigin(label))
    return
  }
  await writeWorkspaceDocument(path, content)
}

/**
 * Rewrites a Markdown file with `update` (given its current text; answer it unchanged to skip):
 * through the open document when it is open, else read and written as a file. Answers whether
 * the text changed.
 */
export async function updateWorkspaceMarkdown(path: string, update: (text: string) => string, label = 'update'): Promise<boolean> {
  const session = getDocumentSession(path)
  if (session) {
    const current = session.read()
    const next = update(current)
    if (next === current) return false
    return session.replaceText(next, writerOrigin(label))
  }
  const current = (await readWorkspaceDocument(path)).content ?? ''
  const next = update(current)
  if (next === current) return false
  await writeWorkspaceDocument(path, next)
  return true
}
