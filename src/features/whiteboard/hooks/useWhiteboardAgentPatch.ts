import { useCallback, useMemo, useState } from 'react'

import type { AgentWhiteboardPatch } from '@/types/whiteboardAgent'

import type { BoardCommandRegistry } from '../lib/boardCommands'
import type { BoardStore } from '../lib/boardStore'
import {
  buildWhiteboardAgentPatchPreview,
  parseAgentWhiteboardPatch,
  translateAgentWhiteboardPatch,
  type WhiteboardAgentPatchPreview,
} from '../lib/whiteboardAgentPatch'

export type WhiteboardAgentPreviewState = {
  diff: ReturnType<typeof translateAgentWhiteboardPatch> | null
  error: string
  patch: AgentWhiteboardPatch | null
  preview: WhiteboardAgentPatchPreview | null
  provisional: boolean
  status: 'error' | 'idle' | 'ready' | 'streaming'
}

const INITIAL_STATE: WhiteboardAgentPreviewState = {
  diff: null,
  error: '',
  patch: null,
  preview: null,
  provisional: false,
  status: 'idle',
}

export function useWhiteboardAgentPatch(input: {
  commands: BoardCommandRegistry
  store: BoardStore
}) {
  const [state, setState] = useState<WhiteboardAgentPreviewState>(INITIAL_STATE)

  const receivePatch = useCallback((value: unknown, provisional: boolean) => {
    try {
      let patch = parseAgentWhiteboardPatch(value)
      if (state.patch && state.status === 'streaming') {
        patch = parseAgentWhiteboardPatch({
          ...patch,
          operations: mergeAgentPatchOperations(
            state.patch.operations,
            patch.operations,
          ),
        })
      }
      const diff = translateAgentWhiteboardPatch({ patch, store: input.store })
      setState({
        diff,
        error: '',
        patch,
        preview: buildWhiteboardAgentPatchPreview(diff),
        provisional,
        status: provisional ? 'streaming' : 'ready',
      })
    } catch (error) {
      setState({
        ...INITIAL_STATE,
        error: error instanceof Error ? error.message : 'Invalid AI Board patch',
        status: 'error',
      })
    }
  }, [input.store, state.patch, state.status])

  const reject = useCallback(() => setState(INITIAL_STATE), [])

  const accept = useCallback(() => {
    if (!state.diff || !state.patch || state.provisional) return false
    try {
      input.commands.applyAgentDiff(
        state.patch.summary || 'Apply AI Board change',
        state.diff,
      )
      setState(INITIAL_STATE)
      return true
    } catch (error) {
      setState((current) => ({
        ...current,
        error: error instanceof Error ? error.message : 'AI Board preview could not be applied',
        status: 'error',
      }))
      return false
    }
  }, [input.commands, state.diff, state.patch, state.provisional])

  return useMemo(() => ({
    accept,
    cancel: reject,
    receivePatch,
    reject,
    state,
  }), [accept, receivePatch, reject, state])
}

function mergeAgentPatchOperations(
  current: AgentWhiteboardPatch['operations'],
  incoming: AgentWhiteboardPatch['operations'],
) {
  const merged = [...current]
  const serialized = new Set(current.map((operation) => JSON.stringify(operation)))
  for (const operation of incoming) {
    const value = JSON.stringify(operation)
    if (serialized.has(value)) continue
    const identity = getCreateOperationIdentity(operation)
    if (identity) {
      const existingIndex = merged.findIndex((candidate) => (
        getCreateOperationIdentity(candidate) === identity
      ))
      if (existingIndex >= 0) {
        merged[existingIndex] = operation
        continue
      }
    }
    merged.push(operation)
    serialized.add(value)
  }
  return merged
}

function getCreateOperationIdentity(
  operation: AgentWhiteboardPatch['operations'][number],
) {
  if (operation.op === 'element.create') return `${operation.op}:${operation.element.id}`
  if (operation.op === 'connector.create') return `${operation.op}:${operation.connector.id}`
  if (operation.op === 'element.group') return `${operation.op}:${operation.container_id}`
  return ''
}
