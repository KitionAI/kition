import { getWorkspaceStorageKey } from './workspaceStorageKey'

function markerKey(workspacePath: string): string {
  return getWorkspaceStorageKey(workspacePath, 'seeded')
}

export function isWorkspaceSeeded(workspacePath: string): boolean {
  try {
    return localStorage.getItem(markerKey(workspacePath)) === '1'
  } catch {
    return false
  }
}

export function markWorkspaceSeeded(workspacePath: string): void {
  try {
    localStorage.setItem(markerKey(workspacePath), '1')
  } catch {
    // ignore storage failures — workspace is non-empty on next open, so the
    // mark-without-seed branch runs and no duplicate seed happens
  }
}
