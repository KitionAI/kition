import { afterEach, describe, expect, it, vi } from 'vitest'
import { expectMatchesContract } from '@/test/contracts'

import { streamAgentMessage } from './agent'
import type { RuntimeWritingModel } from '@/types'
import type { AgentImageGenerationIntent } from '@/types/imageGeneration'

vi.mock('@/services/desktop', () => ({
  getApiBaseURL: () => 'http://runtime.test',
  resolveApiURL: (path: string) => `http://runtime.test${path}`,
}))

const idle = JSON.stringify({ jsonrpc: '2.0', method: 'session.status', params: { sessionId: 'agent:7', status: 'idle' } })

/** A logged image variant notification. */
function variantResult(requestId: string) {
  return {
    jsonrpc: '2.0',
    method: 'session.event',
    params: {
      sessionId: 'agent:9',
      event: {
        seq: 5, at: 1, type: 'tool/result', callId: 'img_1_0', name: 'image_generation', isError: false,
        content: [{ type: 'text', text: 'Generated image 1: Agent/images/generated.png' }],
        value: { call_id: 'img_1_0', path: 'Agent/images/generated.png' },
        meta: { kind: 'image_generation.variant', request_id: requestId, artifact: { call_id: 'img_1_0' } },
      },
    },
  }
}

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('streamAgentMessage', () => {
  it('rejects a refused turn with the HTTP status', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      '{"code":409,"message":"This session is still answering."}',
      { status: 409 },
    )))

    await expect(streamAgentMessage({ sessionId: 7, content: 'again' })).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining('still answering'),
    })
  })

  it('forwards a typed cross-surface image-generation intent', async () => {
    const imageGenerationIntent: AgentImageGenerationIntent = {
      type: 'image_generation.intent',
      schema_version: 1,
      request_id: 'image-request-1',
      operation: 'generate',
      instruction: 'Create a calm launch image.',
      locale: 'en-US',
      template_id: 'surreal-city-poster',
      template_version: '2026-09-05.1',
      template_variables: { subject: 'Kition launch' },
      aspect_ratio: '16:9',
      quality: 'medium',
      resolution: '1K',
      variants: 2,
      text_mode: 'no_text',
      reference_paths: [],
      surface: 'document',
      target: {
        type: 'image.target.document',
        document_path: 'Docs/Launch.md',
        document_format: 'markdown',
        cursor_offset: 42,
      },
      placement_preference: 'review',
      client_capability_version: 1,
    }
    const fetchMock = vi.fn(async (
      _input: RequestInfo | URL,
      _init?: RequestInit,
    ) => new Response(`${idle}\n`, { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    await streamAgentMessage({
      sessionId: 8,
      content: imageGenerationIntent.instruction,
      imageGenerationIntent,
      paneContext: 'document',
    })

    const [, init] = fetchMock.mock.calls[0]!
    expect(JSON.parse(String(init?.body))).toMatchObject({
      content: imageGenerationIntent.instruction,
      image_generation_intent: imageGenerationIntent,
      pane_context: 'document',
    })
  })

  it('edits reference images without changing the selected chat model', async () => {
    const runtimeModel: RuntimeWritingModel = Object.freeze({
      provider_type: 'kition_console',
      provider_label: 'Kition',
      model_name: 'gpt-5.5',
      base_url: '',
      api_key: '',
    })
    const imageGenerationIntent: AgentImageGenerationIntent = {
      type: 'image_generation.intent',
      schema_version: 1,
      request_id: 'image-edit-1',
      operation: 'edit',
      instruction: 'Remove the feet from this image.',
      locale: 'en-US',
      aspect_ratio: '1:1',
      quality: 'medium',
      resolution: '1K',
      variants: 1,
      text_mode: 'no_text',
      reference_paths: ['Agent/images/original.png'],
      surface: 'document',
      target: { type: 'image.target.document', document_path: 'Agent/images/original.png' },
      placement_preference: 'review',
      client_capability_version: 1,
    }
    const notification = variantResult(imageGenerationIntent.request_id)
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response([
      JSON.stringify(notification),
      idle,
      '',
    ].join('\n'), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const onNotification = vi.fn()

    await streamAgentMessage({
      sessionId: 8,
      content: imageGenerationIntent.instruction,
      imageGenerationIntent,
      runtimeModel,
      onNotification,
    })

    expect(fetchMock).toHaveBeenCalledOnce()
    const [, init] = fetchMock.mock.calls[0]!
    expectMatchesContract(imageGenerationIntent, 'agent-image-generation', 'intent')
    expect(JSON.parse(String(init?.body))).toMatchObject({
      image_generation_intent: imageGenerationIntent,
      runtime_model: runtimeModel,
    })
    expect(runtimeModel.model_name).toBe('gpt-5.5')
    expect(onNotification).toHaveBeenCalledWith(notification)
  })

  it('keeps a slow image stream open beyond ordinary request timeouts', async () => {
    vi.useFakeTimers()
    const onNotification = vi.fn()
    const abort = new AbortController()
    const encoder = new TextEncoder()
    const running = JSON.stringify({ jsonrpc: '2.0', method: 'session.status', params: { sessionId: 'agent:10', status: 'running' } })
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode(`${running}\n`))
          setTimeout(() => {
            controller.enqueue(encoder.encode([JSON.stringify(variantResult('slow-image')), idle, ''].join('\n')))
            controller.close()
          }, 9 * 60_000)
        },
      }),
    ))
    vi.stubGlobal('fetch', fetchMock)

    const completed = vi.fn()
    const streaming = streamAgentMessage({
      sessionId: 10, content: 'Generate a detailed image', signal: abort.signal, onNotification,
    }).then(completed)
    await vi.advanceTimersByTimeAsync(8 * 60_000)
    expect(completed).not.toHaveBeenCalled()
    expect(onNotification).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0][1]?.signal).toBe(abort.signal)
    expect(abort.signal.aborted).toBe(false)

    await vi.advanceTimersByTimeAsync(60_000)
    await streaming
    expect(completed).toHaveBeenCalledOnce()
    expect(onNotification).toHaveBeenCalledWith(variantResult('slow-image'))
  })

  it('sends a command approval by the paused call id', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(`${idle}\n`, { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const shellApproval = { call_id: 'call_1', decision: 'allow_once' as const }
    expectMatchesContract(shellApproval, 'agent-shell-approval', 'response')

    await streamAgentMessage({ sessionId: 7, content: 'Approved', hideUserMessage: true, shellApproval })

    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toMatchObject({
      hide_user_message: true,
      shell_approval: shellApproval,
    })
  })
})
