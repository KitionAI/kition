// djb2 keeps local-only workspace markers short and avoids storing workspace paths.
export function getWorkspaceStorageKey(workspacePath: string, suffix: string): string {
  let hash = 5381
  for (let index = 0; index < workspacePath.length; index += 1) {
    hash = ((hash << 5) + hash + workspacePath.charCodeAt(index)) | 0
  }
  return `kition.workspace.${(hash >>> 0).toString(36)}.${suffix}`
}
