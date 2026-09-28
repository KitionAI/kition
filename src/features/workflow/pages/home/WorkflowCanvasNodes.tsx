import { useTranslation } from 'react-i18next'

import type { ConnectionView } from '@/api/connections'
import type { NodeIssue, WorkflowDefinition } from '@/api/workflows'
import type { TableSchema } from '@/features/workflow/components/BodyTemplateEditor.types'
import { NodeCard } from '@/features/workflow/canvas/NodeCard'
import type { GraphNode } from '@/features/workflow/hooks/useWorkflowGraph'
import type { WorkflowRunRecord } from '@/features/workflow/hooks/useWorkflowRuns'
import type { AiBuildPhase } from '@/features/workflow/lib/aiBuildPreview'
import { publishWorkflowNodeAskAI } from '@/features/workflow/lib/askAiBridge'
import {
  actionNodeDescription,
  actionTitleI18nKey,
  filterNodeDescription,
  filterNodeTitle,
  triggerTitleI18nKey,
  type TableLabel,
  type ValidationErrors,
  type WorkflowDraft,
} from '@/features/workflow/lib/workflowDraft'
import { deriveNodeStatus, resolveActionInlineError } from '@/features/workflow/lib/workflowNodePresentation'

export type WorkflowCanvasNodesProps = {
  graphNodes: GraphNode[]
  selected: WorkflowDefinition
  draft: WorkflowDraft
  validation: ValidationErrors
  issuesByNode: Record<string, NodeIssue[]>
  latestRun: WorkflowRunRecord | null
  /** The AI build phase while the editor is locked by a streaming preview. */
  streamingPhase: AiBuildPhase | null
  selectedNodeId: string
  connections: ConnectionView[]
  tableLabels: Record<string, TableLabel>
  triggerLabel: string
  schema: TableSchema | null
  onSelectNode: (nodeId: string) => void
  onDuplicateNode: (nodeId: string) => void
  onDeleteNode: (nodeId: string) => void
  onToggleDisabledNode: (nodeId: string, disabled: boolean) => void
}

/** The node cards on the canvas, in chain order. */
export function WorkflowCanvasNodes(props: WorkflowCanvasNodesProps) {
  const { t } = useTranslation('workflow')
  const { graphNodes, selected, draft, validation, latestRun, onSelectNode } = props
  return (
    <>
      {graphNodes.map((node, index) => {
        const isTrigger = node.kind === 'trigger'
        const isFilter = node.kind === 'filter'
        const issues = props.issuesByNode[node.nodeId] || []
        const stepIndex = index + 1
        return (
          <NodeCard
            key={node.nodeId}
            kind={node.kind}
            rowLabel={
              isTrigger
                ? t('panels.home.nodeCard.triggerLabel')
                : isFilter
                  ? t('panels.home.nodeCard.stepFilter', { index: stepIndex })
                  : draft.actionType === 'add_record'
                    ? t('panels.home.nodeCard.stepActionAddRecord', { index: stepIndex })
                    : t('panels.home.nodeCard.stepActionGeneric', { index: stepIndex })
            }
            title={isTrigger ? t(triggerTitleI18nKey(selected.trigger.type)) : isFilter ? filterNodeTitle(node) : t(actionTitleI18nKey(draft.actionType))}
            description={isTrigger ? props.triggerLabel : isFilter ? filterNodeDescription(node) : actionNodeDescription(draft, props.connections, props.tableLabels, t)}
            status={deriveNodeStatus({ node, selected, draft, validation, latestRun, issues, streamingPhase: props.streamingPhase })}
            disabled={node.disabled}
            selected={props.selectedNodeId === node.nodeId}
            onSelect={() => onSelectNode(node.nodeId)}
            onAskAI={isFilter ? undefined : () => publishWorkflowNodeAskAI({
              workflow: { id: selected.id, name: selected.name },
              nodeId: node.nodeId,
              nodeKind: isTrigger ? 'trigger' : 'action',
              nodeConfig: node.config,
              tableSchema: props.schema,
            })}
            onDuplicate={isFilter ? () => props.onDuplicateNode(node.nodeId) : undefined}
            onDelete={isTrigger ? undefined : () => props.onDeleteNode(node.nodeId)}
            onToggleDisabled={isFilter ? (next) => props.onToggleDisabledNode(node.nodeId, next) : undefined}
            inlineError={node.kind === 'action'
              ? resolveActionInlineError({ draft, validation, latestRun, enabled: selected.enabled, issues, t, onFix: () => onSelectNode(node.nodeId) })
              : null}
            dataRole={node.kind}
          />
        )
      })}
    </>
  )
}
