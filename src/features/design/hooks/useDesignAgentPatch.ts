import { useCallback, useMemo, useState } from 'react'
import type { AgentDesignPatch } from '@/types/designAgent'
import { parseDesignAgentPatch, reduceDesignAgentPatch } from '../lib/designAgentPatch'
import type { DesignStore } from '../lib/designStore'
import type { DesignDocument } from '../lib/designTypes'

export type DesignAgentPreviewState = {
  status: 'idle' | 'streaming' | 'ready' | 'error'
  patch: AgentDesignPatch | null
  proposed: DesignDocument | null
  error: string
}

const IDLE: DesignAgentPreviewState = { status: 'idle', patch: null, proposed: null, error: '' }

/**
 * Turns Agent patches into a live preview on the store: the canvas shows the
 * proposed document while the user decides. Accept commits it as one undo
 * step; reject or cancel drops it. A patch that fails validation or
 * references a missing layer shows an error instead of a preview.
 */
export function useDesignAgentPatch(store: DesignStore) {
  const [state, setState] = useState<DesignAgentPreviewState>(IDLE)

  const receivePatch = useCallback(
    (value: unknown, provisional: boolean) => {
      const parsed = parseDesignAgentPatch(value)
      if (parsed.ok === false) {
        store.cancel()
        setState({ ...IDLE, status: 'error', error: parsed.error })
        return
      }
      try {
        const proposed = reduceDesignAgentPatch(store.getSnapshot().view, parsed.patch)
        store.showPreview(proposed)
        setState({ status: provisional ? 'streaming' : 'ready', patch: parsed.patch, proposed, error: '' })
      } catch (error) {
        store.cancel()
        setState({ ...IDLE, status: 'error', error: error instanceof Error ? error.message : String(error) })
      }
    },
    [store],
  )

  const reject = useCallback(() => {
    store.cancel()
    setState(IDLE)
  }, [store])

  const accept = useCallback(() => {
    if (state.status !== 'ready' || !state.proposed) return
    store.commit(state.proposed)
    setState(IDLE)
  }, [state, store])

  return useMemo(() => ({ state, receivePatch, accept, reject }), [state, receivePatch, accept, reject])
}
