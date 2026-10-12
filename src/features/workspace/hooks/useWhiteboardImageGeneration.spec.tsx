import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { AgentSessionEventsSessionEvent } from '@/api/generated/agent-session-events'
import { applySessionEvent, emptyAgentSessionView, type AgentSessionView } from '@/features/agent/public'
import type { WhiteboardAgentBridge } from '@/features/whiteboard/lib/whiteboardAgentBridge'
import type { WhiteboardImageGenerationRequest } from '@/features/whiteboard/lib/whiteboardImageGeneration'

import { useWhiteboardImageGeneration } from './useWhiteboardImageGeneration'

let container: HTMLDivElement
let root: Root | null = null

const request: WhiteboardImageGenerationRequest = {
  aspectRatio: '16:9',
  boardPath: 'Boards/Launch.kiboard',
  prompt: 'Create a calm product launch image.',
  quality: 'medium',
  requestId: 'request-1',
  resolution: '1K',
  sourceImagePaths: [],
  templateId: 'surreal-city-poster',
  textMode: 'editable_overlay',
  variants: 1,
}

describe('useWhiteboardImageGeneration', () => {
  it('uses a fresh session when the active Agent session is busy', async () => {
    const sendAgentAction = vi.fn()
    const setActiveSessionId = vi.fn()
    const hook = await renderImageGenerationHook({
      activeSessionId: 7,
      agentBusySessions: new Set([7]),
      agentSessionViews: {},
      available: true,
      bridgesRef: { current: {} },
      createAgentChat: vi.fn().mockResolvedValue({ id: 8 }),
      modelAvailable: true,
      sendAgentAction,
      setActiveSessionId,
    })

    await act(async () => {
      expect(await hook.ref.current?.(request)).toEqual({ accepted: true })
    })

    expect(setActiveSessionId).toHaveBeenCalledWith(8)
    expect(sendAgentAction).toHaveBeenCalledWith(8, {
      content: expect.stringContaining('image_generation tool'),
    })
  })

  it('delivers only new image artifacts and completes the matching request', async () => {
    const receiveImageGenerationArtifacts = vi.fn()
    const completeImageGeneration = vi.fn()
    const bridgesRef = {
      current: {
        [request.boardPath]: {
          available: true,
          buildContext: () => undefined,
          cancelPreview: vi.fn(),
          completeImageGeneration,
          receiveImageGenerationArtifacts,
          receivePatch: vi.fn(),
        } satisfies WhiteboardAgentBridge,
      },
    }
    const initialProps = {
      activeSessionId: 7,
      agentBusySessions: new Set<number>(),
      agentSessionViews: { 7: delivered(['Agent/existing.png']) },
    }
    const baseProps = {
      ...initialProps,
      available: true,
      bridgesRef,
      createAgentChat: vi.fn(),
      modelAvailable: true,
      sendAgentAction: vi.fn(),
      setActiveSessionId: vi.fn(),
    }
    const hook = await renderImageGenerationHook(baseProps)

    await act(async () => {
      expect(await hook.ref.current?.(request)).toEqual({ accepted: true })
    })
    await hook.rerender({
      ...baseProps,
      agentBusySessions: new Set([7]),
    })
    await hook.rerender({
      ...baseProps,
      agentSessionViews: { 7: delivered(['Agent/existing.png', 'Agent/notes.md', 'Agent/generated.png']) },
      agentBusySessions: new Set<number>(),
    })

    expect(receiveImageGenerationArtifacts).toHaveBeenCalledWith({
      paths: ['Agent/generated.png'],
      requestId: request.requestId,
    })
    expect(completeImageGeneration).toHaveBeenCalledWith({
      error: undefined,
      requestId: request.requestId,
    })
  })
})

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
})

afterEach(async () => {
  await act(async () => root?.unmount())
  root = null
  container.remove()
  vi.restoreAllMocks()
})

async function renderImageGenerationHook(
  initialInput: Parameters<typeof useWhiteboardImageGeneration>[0],
) {
  let input = initialInput
  const ref: { current: ReturnType<typeof useWhiteboardImageGeneration> | null } = {
    current: null,
  }
  function Harness() {
    ref.current = useWhiteboardImageGeneration(input)
    return null
  }
  root = createRoot(container)
  await act(async () => root?.render(createElement(Harness)))
  return {
    ref,
    rerender: async (nextInput: typeof initialInput) => {
      input = nextInput
      await act(async () => root?.render(createElement(Harness)))
    },
  }
}

/** A session whose turns delivered `paths`, one call each. */
function delivered(paths: string[]): AgentSessionView {
  const events: AgentSessionEventsSessionEvent[] = [{ seq: 1, at: 1, type: 'turn/start', turn: 1 }]
  paths.forEach((path, index) => events.push({
    seq: index + 2, at: index + 2, type: 'deliverables/presented', turn: 1, callId: `c${index}`, files: [{ path }],
  }))
  return events.reduce(applySessionEvent, emptyAgentSessionView())
}
