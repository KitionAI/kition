import { afterEach, describe, expect, it, vi } from 'vitest'

import { streamAgentMessage } from './agent'
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
})
