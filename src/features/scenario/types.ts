/**
 * Scenario build event contract.
 *
 * Mirrors the public runtime wire contract. When the kind string, field names,
 * or payload shapes change, update this file with the public contract.
 * Field names use lowerCamelCase JSON to match the rest of the
 * frontend conventions.
 */

/**
 * Local draft attachment used by the landing page before upload. The
 * `previewUrl` is an `URL.createObjectURL` blob URL for images (used as a
 * thumbnail source) and `null` for non-image files (rendered as a file icon).
 * Owners of these objects MUST call `URL.revokeObjectURL(previewUrl)` when
 * the chip is removed and on unmount to avoid a memory leak.
 */
export interface ScenarioDraftAttachment {
  /** Stable id (e.g. `crypto.randomUUID()`) assigned when the file is added. */
  id: string
  /** The underlying file, kept around so we can upload it later. */
  file: File
  /** Object URL for image previews, or `null` for non-image files. */
  previewUrl: string | null
}

/** Deterministic vs AI-assisted field generation. */
export type ScenarioFieldsStage = 'fields' | 'ai-fields'

export interface ScenarioBaseCreatedEvent {
  kind: 'base.created'
  baseId: string
  baseName: string
}

export interface ScenarioTableCreatedEvent {
  kind: 'table.created'
  tableId: string
  tableName: string
}

export interface ScenarioFieldsGeneratedEvent {
  kind: 'fields.generated'
  stage: ScenarioFieldsStage
  count: number
}

export interface ScenarioRecordsGeneratedEvent {
  kind: 'records.generated'
  count: number
}

export interface ScenarioViewsGeneratedEvent {
  kind: 'views.generated'
  /** Inner view category (e.g. "grid", "kanban") — distinct from the
   * top-level `kind` discriminator. */
  viewKind: string
  viewId: string
  viewName: string
}

export interface ScenarioCellAIFilledEvent {
  kind: 'cell.ai.filled'
  recordId: number
  fieldId: number
  /** AI extraction output — may be a scalar, an object, or null. Consumers
   * should look at the matching field's type to interpret it. */
  value: unknown
}

export interface ScenarioErrorEvent {
  kind: 'error'
  code: string
  message: string
}

export interface ScenarioDoneEvent {
  kind: 'done'
}

export type ScenarioBuildEvent =
  | ScenarioBaseCreatedEvent
  | ScenarioTableCreatedEvent
  | ScenarioFieldsGeneratedEvent
  | ScenarioRecordsGeneratedEvent
  | ScenarioViewsGeneratedEvent
  | ScenarioCellAIFilledEvent
  | ScenarioErrorEvent
  | ScenarioDoneEvent

export type ScenarioBuildEventKind = ScenarioBuildEvent['kind']

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const isString = (value: unknown): value is string => typeof value === 'string'
const isNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value)

/**
 * Runtime type guard. Validates enough structure to safely discriminate by
 * `kind` and access kind-specific fields without further casts.
 */
export function isScenarioBuildEvent(
  value: unknown,
): value is ScenarioBuildEvent {
  if (!isRecord(value)) return false
  const kind = value.kind
  if (!isString(kind)) return false

  switch (kind) {
    case 'base.created':
      return isString(value.baseId) && isString(value.baseName)
    case 'table.created':
      return isString(value.tableId) && isString(value.tableName)
    case 'fields.generated':
      return (
        (value.stage === 'fields' || value.stage === 'ai-fields') &&
        isNumber(value.count)
      )
    case 'records.generated':
      return isNumber(value.count)
    case 'views.generated':
      return (
        isString(value.viewKind) &&
        isString(value.viewId) &&
        isString(value.viewName)
      )
    case 'cell.ai.filled':
      // `value` field can be anything (including null) — only require it to
      // be present so consumers know the orchestrator emitted a payload.
      return (
        isNumber(value.recordId) &&
        isNumber(value.fieldId) &&
        'value' in value
      )
    case 'error':
      return isString(value.code) && isString(value.message)
    case 'done':
      return true
    default:
      return false
  }
}

/**
 * Parse a single SSE data frame into a typed event, or return null when the
 * payload is malformed (invalid JSON, missing kind, missing required field,
 * wrong type). Returning null rather than throwing lets the SSE hook log
 * unknown frames without tearing down the stream.
 */
export function parseScenarioBuildEvent(
  jsonText: string,
): ScenarioBuildEvent | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(jsonText)
  } catch {
    return null
  }
  return isScenarioBuildEvent(parsed) ? parsed : null
}

/**
 * Finite-state machine for the SSE build pipeline as observed by the
 * `useScenarioBuild` hook.
 *
 * - `idle` — initial or after `reset()`.
 * - `submitting` — POST fired, awaiting first response chunk.
 * - `streaming` — at least one SSE frame received, awaiting `done`.
 * - `done` — `done` kind frame received OR stream closed normally.
 * - `error` — `error` kind frame, HTTP failure, parse failure or network drop.
 * - `aborted` — caller invoked `abort()` / unmounted mid-stream.
 */
export type ScenarioBuildStatus =
  | 'idle'
  | 'submitting'
  | 'streaming'
  | 'done'
  | 'error'
  | 'aborted'

/**
 * Public surface returned by `useScenarioBuild`. State pieces are kept
 * primitive so the consumer can drive a progress card without further
 * subscription plumbing.
 */
export interface UseScenarioBuildResult {
  /** All events received in arrival order. Never reset by reads. */
  events: ScenarioBuildEvent[]
  /** Current finite-state-machine status. */
  status: ScenarioBuildStatus
  /** Convenience: the baseId from the first `base.created` event, or null. */
  baseId: string | null
  /** Convenience: the baseName from the first `base.created` event, or null. */
  baseName: string | null
  /** Last error message if `status === 'error'`. */
  error: string | null
  /**
   * Submit. Resolves when the stream ends (done | error | aborted). Safe to
   * call once at a time; concurrent calls reject without touching state.
   */
  submit: (prompt: string, files: File[]) => Promise<void>
  /** Abort the in-flight request. No-op if no submission active. */
  abort: () => void
  /**
   * Reset back to initial state (`events = []`, `status = 'idle'`, etc.).
   * Safe to call mid-stream — also aborts current.
   */
  reset: () => void
}
