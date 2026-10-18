// Copied from kition-sdk packages/extensions/src/gate.ts by scripts/sync-kit-host.mjs; change it there, not here.
/**
 * What each object-model call needs (`KitExtensions 1.0` permissions). The host checks every
 * call from an extension's worker here before it reaches the document.
 */
import type { BatchRequest } from '../kdm'
import type { KitCommandInfo } from '../sdk'
import { hasPermission, type Permission } from './manifest'
import { ExtensionError } from './rpc'

/** The object model's read operations: none; every operation but `command` writes. */
const COMMAND_OP = 'command'

export function permissionDenied(extension: string, permission: Permission, what: string): ExtensionError {
  return new ExtensionError('permission-denied', `${extension} may not ${what}: it does not have the ${permission} permission`, { permission })
}

export function requirePermission(extension: string, permissions: readonly string[], permission: Permission, what: string) {
  if (!hasPermission(permissions, permission)) throw permissionDenied(extension, permission, what)
}

/**
 * Checks a `model/batch` against `permissions`. Loads need `model.read`; every operation but a
 * command needs `model.write`; a command needs `commands.run`, and `model.write` too unless the
 * kit's catalogue says it does not mutate (`catalogue` answers it; only asked for when the batch
 * has commands).
 */
export async function checkBatch(extension: string, permissions: readonly string[], request: BatchRequest, catalogue: () => Promise<KitCommandInfo[]>) {
  if (!request || typeof request !== 'object') throw new ExtensionError('invalid', 'a batch is an object')
  const ops = Array.isArray(request.ops) ? request.ops : []
  if (request.load?.length) requirePermission(extension, permissions, 'model.read', 'read the document')
  const commands = ops.filter((op) => op?.op === COMMAND_OP)
  if (ops.length > commands.length) requirePermission(extension, permissions, 'model.write', 'change the document')
  if (!commands.length) return
  requirePermission(extension, permissions, 'commands.run', 'run commands')
  if (hasPermission(permissions, 'model.write')) return
  const known = new Map((await catalogue()).map((command) => [command.id, command]))
  for (const op of commands) {
    const command = known.get(String(op.id))
    if (command?.mutates !== false) throw permissionDenied(extension, 'model.write', `run ${String(op.id)}, which changes the document`)
  }
}
