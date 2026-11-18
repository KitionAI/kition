/**
 * Pure bookkeeping after a document moves on disk: every client-side record
 * that names the old path follows it to the new one.
 */
import { remapWorkspaceBranchPath } from '@/features/workspace/lib/workspace'

export function remapPathSetAfterMove(paths: Set<string>, sourcePath: string, targetPath: string) {
  const next = new Set<string>()
  paths.forEach((path) => next.add(remapWorkspaceBranchPath(path, sourcePath, targetPath)))
  return next
}
