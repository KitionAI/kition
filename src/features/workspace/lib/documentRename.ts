/**
 * Pure bookkeeping after a document moves on disk: every client-side record
 * that names the old path follows it to the new one.
 */
import { remapWorkspaceBranchPath } from '@/features/workspace/lib/workspace'

/** Snapshots under the moved path follow it; the moved document itself also takes its new name. */
export function remapSnapshotsAfterMove<T extends { path: string; name: string }>(
  snapshots: T[],
  sourcePath: string,
  targetPath: string,
  targetName: string,
): T[] {
  return snapshots.map((snapshot) => {
    const nextPath = remapWorkspaceBranchPath(snapshot.path, sourcePath, targetPath)
    if (nextPath === snapshot.path) return snapshot
    return {
      ...snapshot,
      path: nextPath,
      name: nextPath === targetPath ? targetName : nextPath.split('/').pop() || snapshot.name,
    }
  })
}

export function remapPathSetAfterMove(paths: Set<string>, sourcePath: string, targetPath: string) {
  const next = new Set<string>()
  paths.forEach((path) => next.add(remapWorkspaceBranchPath(path, sourcePath, targetPath)))
  return next
}
