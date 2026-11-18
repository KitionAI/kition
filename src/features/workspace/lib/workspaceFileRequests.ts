/**
 * Requests a pane makes of the workspace around it: a kit editor or viewer
 * that wrote a new file (an exported movie, a project made from a clip) asks
 * for it to appear in the tree, and to be opened.
 */
const SHOW_FILE = 'kition:workspace:show-file'

type ShowFileRequest = { path: string; open: boolean }

/** Refreshes the tree to include `path`, and opens it when `open`. */
export function requestShowWorkspaceFile(path: string, open = false) {
  window.dispatchEvent(new CustomEvent<ShowFileRequest>(SHOW_FILE, { detail: { path, open } }))
}

/** Handles show-file requests; returns the cleanup. */
export function onShowWorkspaceFile(handle: (request: ShowFileRequest) => void) {
  const listener = (event: Event) => {
    const detail = (event as CustomEvent<ShowFileRequest>).detail
    if (detail?.path) handle(detail)
  }
  window.addEventListener(SHOW_FILE, listener)
  return () => window.removeEventListener(SHOW_FILE, listener)
}
