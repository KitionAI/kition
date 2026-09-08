import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { AgentArtifact, AgentToolCall } from '@/api/agent'
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
      agentArtifacts: {},
      agentBusySessions: new Set([7]),
      agentToolCalls: {},
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
    const existingArtifact = imageArtifact(1, 'Agent/existing.png')
    const generatedArtifact = imageArtifact(2, 'Agent/generated.png')
    const initialProps = {
      activeSessionId: 7,
      agentArtifacts: { 7: [existingArtifact] },
      agentBusySessions: new Set<number>(),
      agentToolCalls: {},
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
      agentArtifacts: { 7: [existingArtifact, generatedArtifact] },
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

  it('delivers completed image tool output when the stream has no artifact frame', async () => {
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
    const generatedToolCall = imageGenerationToolCall(12, 'Agent/generated-from-tool.png')
    const baseProps = {
      activeSessionId: 7,
      agentArtifacts: {},
      agentBusySessions: new Set<number>(),
      agentToolCalls: {},
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
      agentToolCalls: { 7: [generatedToolCall] },
    })

    expect(receiveImageGenerationArtifacts).toHaveBeenCalledWith({
      paths: ['Agent/generated-from-tool.png'],
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

function imageArtifact(id: number, path: string): AgentArtifact {
  return {
    id,
    session_id: 7,
    user_id: 1,
    kind: 'image',
    path,
    mime_type: 'image/png',
    created_at: '2026-09-03T00:00:00.000Z',
  }
}

function imageGenerationToolCall(id: number, path: string): AgentToolCall {
  return {
    id,
    session_id: 7,
    user_id: 1,
    tool_name: 'image_generation',
    output_data: { path, mime_type: 'image/png' },
    status: 'completed',
    created_at: '2026-09-03T00:00:00.000Z',
    updated_at: '2026-09-03T00:00:00.000Z',
  }
}
