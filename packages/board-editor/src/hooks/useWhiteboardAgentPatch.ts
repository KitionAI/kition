import { useCallback, useMemo, useRef, useState } from 'react'

import type { AgentWhiteboardPatch } from '../lib/agentWhiteboard'

import type { BoardCommandRegistry } from '../lib/boardCommands'
import type { BoardStore } from '../lib/boardStore'
import {
  buildWhiteboardAgentPatchPreview,
  parseAgentWhiteboardPatch,
  rememberAgentRenamedIds,
  translateAgentWhiteboardPatch,
  type WhiteboardAgentPatchPreview,
} from '../lib/whiteboardAgentPatch'

export type WhiteboardAgentPreviewState = {
  /** The object ids given to the elements the patch creates, kept while it streams. */
  createdIds: Map<string, string>
  diff: ReturnType<typeof translateAgentWhiteboardPatch> | null
  error: string
  patch: AgentWhiteboardPatch | null
  preview: WhiteboardAgentPatchPreview | null
  provisional: boolean
  status: 'error' | 'idle' | 'ready' | 'streaming'
}

function createInitialState(): WhiteboardAgentPreviewState {
  return {
    createdIds: new Map(),
    diff: null,
    error: '',
    patch: null,
    preview: null,
    provisional: false,
    status: 'idle',
  }
}

export function useWhiteboardAgentPatch(input: {
  commands: BoardCommandRegistry
  store: BoardStore
}) {
  const [state, setRenderedState] = useState(createInitialState)
  /**
   * The latest state, updated as soon as it changes. Streamed chunks can arrive faster than React
   * renders, so each chunk builds on this rather than on the state of the last render.
   */
  const stateRef = useRef(state)
  /**
   * The names the agent gave to elements of accepted patches on this board, mapped to the object
   * ids the elements got. Later patches may keep using those names.
   */
  const renamedIdsRef = useRef(new Map<string, string>())

  const setState = useCallback((next: WhiteboardAgentPreviewState) => {
    stateRef.current = next
    setRenderedState(next)
  }, [])

  const receivePatch = useCallback((value: unknown, provisional: boolean) => {
    const current = stateRef.current
    try {
      let patch = parseAgentWhiteboardPatch(value)
      let createdIds = new Map<string, string>()
      if (current.patch && current.status === 'streaming') {
        createdIds = current.createdIds
        patch = parseAgentWhiteboardPatch({
          ...patch,
          operations: mergeAgentPatchOperations(
            current.patch.operations,
            patch.operations,
          ),
        })
      }
      const diff = translateAgentWhiteboardPatch({
        createdIds,
        patch,
        renamedIds: renamedIdsRef.current,
        store: input.store,
      })
      setState({
        createdIds,
        diff,
        error: '',
        patch,
        preview: buildWhiteboardAgentPatchPreview(diff),
        provisional,
        status: provisional ? 'streaming' : 'ready',
      })
    } catch (error) {
      setState({
        ...createInitialState(),
        error: error instanceof Error ? error.message : 'Invalid AI Board patch',
        status: 'error',
      })
    }
  }, [input.store, setState])

  const reject = useCallback(() => setState(createInitialState()), [setState])

  const accept = useCallback(() => {
    const current = stateRef.current
    if (!current.diff || !current.patch || current.provisional) return false
    try {
      input.commands.applyAgentDiff(
        current.patch.summary || 'Apply AI Board change',
        current.diff,
      )
      rememberAgentRenamedIds({
        createdIds: current.createdIds,
        diff: current.diff,
        renamedIds: renamedIdsRef.current,
      })
      setState(createInitialState())
      return true
    } catch (error) {
      setState({
        ...current,
        error: error instanceof Error ? error.message : 'AI Board preview could not be applied',
        status: 'error',
      })
      return false
    }
  }, [input.commands, setState])

  const getRenamedIds = useCallback(
    (): ReadonlyMap<string, string> => renamedIdsRef.current,
    [],
  )

  return useMemo(() => ({
    accept,
    cancel: reject,
    getRenamedIds,
    receivePatch,
    reject,
    state,
  }), [accept, getRenamedIds, receivePatch, reject, state])
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
