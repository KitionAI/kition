import { afterEach, describe, expect, it, vi } from 'vitest'

import { streamAgentMessage } from './agent'
import type {
  AgentImageGenerationEvent,
  AgentImageGenerationIntent,
} from '@/types/imageGeneration'
import type { AgentWhiteboardContext } from '@/types/whiteboardAgent'

vi.mock('@/services/desktop', () => ({
  getApiBaseURL: () => 'http://runtime.test',
  resolveApiURL: (path: string) => `http://runtime.test${path}`,
}))

afterEach(() => {
  vi.restoreAllMocks()
})

describe('streamAgentMessage', () => {
  it('forwards compact Whiteboard context on the public wire field', async () => {
    const whiteboardContext: AgentWhiteboardContext = {
      type: 'whiteboard.context',
      schema_version: 1,
      board: { id: 'home', path: 'Whiteboards/Home.kiboard', title: 'Home' },
      scope: 'viewport',
      viewport: { x: 0, y: 0, width: 1200, height: 800, zoom: 1 },
      selected_element_ids: [],
      elements: [],
      clusters: [],
      recent_operations: [],
      source_refs: [],
      current_page: { id: 'page:main', name: 'Home' },
      current_tool: 'select',
      active_style: {},
      lint_findings: [],
    }
    const fetchMock = vi.fn(async (
      _input: RequestInfo | URL,
      _init?: RequestInit,
    ) => new Response(
      `${JSON.stringify({ type: 'done', done: true })}\n`,
      { status: 200 },
    ))
    vi.stubGlobal('fetch', fetchMock)

    await streamAgentMessage({
      sessionId: 7,
      content: 'Organize this board',
      paneContext: 'whiteboard',
      whiteboardContext,
    })

    expect(fetchMock).toHaveBeenCalledOnce()
    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe('http://runtime.test/v1/agent/sessions/7/messages/stream')
    expect(JSON.parse(String(init?.body))).toMatchObject({
      pane_context: 'whiteboard',
      whiteboard_context: whiteboardContext,
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
    ) => new Response(
      `${JSON.stringify({ type: 'done', done: true })}\n`,
      { status: 200 },
    ))
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

  it('delivers typed image-generation events to the stream consumer', async () => {
    const imageEvent: AgentImageGenerationEvent = {
      type: 'image_generation.event',
      schema_version: 1,
      request_id: 'image-request-2',
      event: 'image_generation.artifact',
      status: 'saving',
      artifact: {
        id: 91,
        path: 'Agent/images/generated.png',
        mime_type: 'image/png',
        variant_index: 0,
        variant_count: 1,
        created_at: '2026-09-05T00:00:00.000Z',
        provenance: { request_id: 'image-request-2' },
      },
    }
    const onEvent = vi.fn()
    vi.stubGlobal('fetch', vi.fn(async () => new Response([
      JSON.stringify({
        type: 'image_generation_event',
        image_generation: imageEvent,
      }),
      JSON.stringify({ type: 'done', done: true }),
      '',
    ].join('\n'), { status: 200 })))

    await streamAgentMessage({
      sessionId: 9,
      content: 'Generate an image',
      onEvent,
    })

    expect(onEvent).toHaveBeenCalledWith(expect.objectContaining({
      type: 'image_generation_event',
      image_generation: imageEvent,
    }))
  })
})
