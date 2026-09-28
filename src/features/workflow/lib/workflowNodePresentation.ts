/**
 * How a node on the canvas presents itself: its status light and the
 * inline error under the action node, with server issues folded in. Pure
 * so the precedence rules are testable.
 */
import type { NodeIssue, WorkflowDefinition } from '@/api/workflows'
import type { NodeStatus } from '@/features/workflow/canvas/NodeCard'
import type { GraphNode } from '@/features/workflow/hooks/useWorkflowGraph'
import type { WorkflowRunRecord } from '@/features/workflow/hooks/useWorkflowRuns'
import { statusForPhase, type AiBuildPhase } from '@/features/workflow/lib/aiBuildPreview'
import {
  actionInlineError,
  actionStatus,
  filterNodeStatus,
  triggerStatus,
  type ValidationErrors,
  type WorkflowDraft,
} from '@/features/workflow/lib/workflowDraft'

export type NodeInlineError = { message: string; fixLabel?: string; onFix?: () => void; severity?: 'error' | 'warning' }

const isError = (issue: NodeIssue) => (issue.level ?? 'error') === 'error'
const isWarning = (issue: NodeIssue) => issue.level === 'warning'

/**
 * Status light for a node. While the AI build streams, trigger and action
 * follow the build phase; otherwise server errors force red, server
 * warnings lift a non-red status to amber, and the local derivation wins.
 */
export function deriveNodeStatus(input: {
  node: GraphNode
  selected: WorkflowDefinition
  draft: WorkflowDraft
  validation: ValidationErrors
  latestRun: WorkflowRunRecord | null
  issues: readonly NodeIssue[]
  /** Set while the streaming preview locks the editor. */
  streamingPhase: AiBuildPhase | null
}): NodeStatus {
  const { node } = input
  if (input.streamingPhase && node.kind !== 'filter') {
    return statusForPhase(input.streamingPhase, node.kind === 'trigger' ? 'trigger' : 'action')
  }
  const base = node.kind === 'trigger'
    ? triggerStatus(input.selected, input.validation)
    : node.kind === 'filter'
      ? filterNodeStatus(node)
      : actionStatus(input.draft, input.validation, input.latestRun)
  if (input.issues.some(isError)) return 'red'
  if (input.issues.some(isWarning) && base !== 'red') return 'amber'
  return base
}

/**
 * The action node's inline error. A missing connection is reported locally
 * even when the server phrases it differently; otherwise server errors come
 * first, then local validation, then server warnings as advisory text.
 * Local issues on a disabled workflow are warnings: the user is still
 * composing and nothing will run.
 */
export function resolveActionInlineError(input: {
  draft: WorkflowDraft
  validation: ValidationErrors
  latestRun: WorkflowRunRecord | null
  enabled: boolean
  issues: readonly NodeIssue[]
  t: (key: string) => string
  onFix: () => void
}): NodeInlineError | null {
  const { draft, latestRun, issues } = input
  const serverError = issues.find(isError)
  const serverWarning = issues.find(isWarning)
  const existing = actionInlineError({ draft, validation: input.validation, latestRun, t: input.t })
  const localError: NodeInlineError | null = existing
    ? {
        ...existing,
        fixLabel: 'Fix',
        severity: latestRun?.status === 'error' || input.enabled ? 'error' : 'warning',
        onFix: input.onFix,
      }
    : null
  if (draft.actionType === 'send_email' && !draft.connectionId && localError) return localError
  if (serverError) return { message: serverError.message, fixLabel: 'Fix', severity: 'error', onFix: input.onFix }
  if (localError) return localError
  if (serverWarning) return { message: serverWarning.message, severity: 'warning' }
  return null
}

/** The hint, else the message, of the first issue with one of `codes`. */
export function issueMessageFor(issues: readonly NodeIssue[], codes: readonly string[]): string | undefined {
  const issue = issues.find((candidate) => codes.includes(candidate.code))
  return issue?.hint || issue?.message
}
