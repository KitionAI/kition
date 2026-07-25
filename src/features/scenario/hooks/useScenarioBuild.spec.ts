import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { beforeEach, describe, expect, it, vi } from 'vitest'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('@/services/desktop', () => ({
  resolveApiURL: (path: string) => `/api${path.startsWith('/') ? path : `/${path}`}`,
}))

vi.mock('@/i18n', () => ({
  getCurrentLocale: () => 'en-US',
}))

import { useScenarioBuild } from './useScenarioBuild'
import type { UseScenarioBuildResult } from '@/features/scenario/types'

/**
 * Build a fetch Response whose body streams `chunks` one ReadableStream
 * pull at a time. The chunks are emitted in order; `controller.close()`
 * fires after the last chunk so the consumer sees a normal EOF.
 */
function streamFromChunks(chunks: string[], init: ResponseInit = {}): Response {
  const encoder = new TextEncoder()
  let i = 0
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i >= chunks.length) {
        controller.close()
        return
      }
      controller.enqueue(encoder.encode(chunks[i]!))
      i++
    },
  })
  return new Response(body, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
    ...init,
  })
}

function jsonFrame(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`
}

const HAPPY_PATH_PAYLOADS = [
  { kind: 'base.created', baseId: 'base_abc', baseName: 'Receipts' },
  { kind: 'table.created', tableId: 'tbl_xyz', tableName: 'Receipts' },
  { kind: 'fields.generated', stage: 'fields', count: 4 },
  { kind: 'fields.generated', stage: 'ai-fields', count: 2 },
  { kind: 'records.generated', count: 5 },
  { kind: 'views.generated', viewKind: 'grid', viewId: 'vw_g', viewName: 'Grid' },
  { kind: 'cell.ai.filled', recordId: 1, fieldId: 1, value: 'total' },
  { kind: 'done' },
] as const

/**
 * Tiny harness that captures the latest result from the hook into a closure.
 * Mirrors the convention used by `useWorkspaceAgent.spec.ts`.
 */
async function mountHook(): Promise<{
  get: () => UseScenarioBuildResult
  unmount: () => Promise<void>
}> {
  let latest: UseScenarioBuildResult | null = null

  function Harness() {
    latest = useScenarioBuild()
    return null
  }

  const container = document.createElement('div')
  document.body.appendChild(container)
  let root: Root | null = null
  await act(async () => {
    root = createRoot(container)
    root.render(createElement(Harness))
  })

  return {
    get: () => {
      if (!latest) throw new Error('hook not mounted')
      return latest
    },
    unmount: async () => {
      await act(async () => {
        root?.unmount()
      })
      container.remove()
    },
  }
}

/**
 * Wait for `predicate` to become true, polling between vi microtasks.
 * Used to flush the async reader loop without sleeping.
 */
async function waitFor(
  predicate: () => boolean,
  options: { timeout?: number; tag?: string } = {},
): Promise<void> {
  const { timeout = 1000, tag = 'condition' } = options
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeout) {
      throw new Error(`waitFor timeout: ${tag}`)
    }
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
  }
}

describe('useScenarioBuild — initial state', () => {
  it('renders with idle status and empty state', async () => {
    const harness = await mountHook()
    const result = harness.get()
    expect(result.status).toBe('idle')
    expect(result.events).toEqual([])
    expect(result.baseId).toBeNull()
    expect(result.baseName).toBeNull()
    expect(result.error).toBeNull()
    await harness.unmount()
  })
})

describe('useScenarioBuild — happy path', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('streams the 8-event pipeline and reaches done', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      streamFromChunks(HAPPY_PATH_PAYLOADS.map((p) => jsonFrame(p))),
    )
    const harness = await mountHook()

    let submission: Promise<void> | undefined
    act(() => {
      submission = harness.get().submit('build a receipt tracker', [])
    })

    await act(async () => {
      await submission
    })

    const result = harness.get()
    expect(result.events).toHaveLength(8)
    expect(result.status).toBe('done')
    expect(result.baseId).toBe('base_abc')
    expect(result.baseName).toBe('Receipts')
    expect(result.error).toBeNull()
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    const call = fetchSpy.mock.calls[0]!
    expect(call[0]).toBe('/api/v1/scenarios/build')
    const init = call[1] as RequestInit
    expect(init.method).toBe('POST')
    const body = init.body as FormData
    expect(body).toBeInstanceOf(FormData)
    expect(body.get('prompt')).toBe('build a receipt tracker')

    await harness.unmount()
  })

  it('captures baseId from the first base.created and ignores later overrides', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      streamFromChunks([
        jsonFrame({ kind: 'base.created', baseId: 'base_first', baseName: 'First' }),
        jsonFrame({ kind: 'base.created', baseId: 'base_second', baseName: 'Second' }),
        jsonFrame({ kind: 'done' }),
      ]),
    )
    const harness = await mountHook()
    let submission: Promise<void> | undefined
    act(() => {
      submission = harness.get().submit('p', [])
    })
    await act(async () => {
      await submission
    })
    expect(harness.get().baseId).toBe('base_first')
    expect(harness.get().baseName).toBe('First')
    await harness.unmount()
  })

  it('transitions idle -> submitting -> streaming -> done', async () => {
    const encoder = new TextEncoder()
    let pushChunk: ((s: string) => void) | undefined
    let closeStream: (() => void) | undefined
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        pushChunk = (s) => controller.enqueue(encoder.encode(s))
        closeStream = () => controller.close()
      },
    })
    let resolveFetch: ((r: Response) => void) | undefined
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          resolveFetch = resolve
        }),
    )
    const harness = await mountHook()

    let submission: Promise<void> | undefined
    act(() => {
      submission = harness.get().submit('p', [])
    })
    await waitFor(() => harness.get().status === 'submitting', { tag: 'submitting' })

    act(() => {
      resolveFetch!(
        new Response(body, {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        }),
      )
    })
    await act(async () => {
      pushChunk!(jsonFrame({ kind: 'base.created', baseId: 'b', baseName: 'B' }))
    })
    await waitFor(() => harness.get().status === 'streaming', { tag: 'streaming' })

    await act(async () => {
      pushChunk!(jsonFrame({ kind: 'done' }))
      closeStream!()
      await submission
    })
    expect(harness.get().status).toBe('done')
    await harness.unmount()
  })
})

describe('useScenarioBuild — framing', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('parses two events delivered in a single chunk', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      streamFromChunks([
        jsonFrame({ kind: 'base.created', baseId: 'b', baseName: 'B' }) +
          jsonFrame({ kind: 'done' }),
      ]),
    )
    const harness = await mountHook()
    let submission: Promise<void> | undefined
    act(() => {
      submission = harness.get().submit('p', [])
    })
    await act(async () => {
      await submission
    })
    expect(harness.get().events.map((e) => e.kind)).toEqual([
      'base.created',
      'done',
    ])
    expect(harness.get().status).toBe('done')
    await harness.unmount()
  })

  it('reassembles a single event split across two chunks', async () => {
    const frame = jsonFrame({ kind: 'base.created', baseId: 'b', baseName: 'B' })
    const split = Math.floor(frame.length / 2)
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      streamFromChunks([frame.slice(0, split), frame.slice(split), jsonFrame({ kind: 'done' })]),
    )
    const harness = await mountHook()
    let submission: Promise<void> | undefined
    act(() => {
      submission = harness.get().submit('p', [])
    })
    await act(async () => {
      await submission
    })
    expect(harness.get().baseId).toBe('b')
    expect(harness.get().status).toBe('done')
    await harness.unmount()
  })

  it('tolerates CRLF framing', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      streamFromChunks([
        `data: ${JSON.stringify({ kind: 'base.created', baseId: 'b', baseName: 'B' })}\r\n\r\n`,
        `data: ${JSON.stringify({ kind: 'done' })}\r\n\r\n`,
      ]),
    )
    const harness = await mountHook()
    let submission: Promise<void> | undefined
    act(() => {
      submission = harness.get().submit('p', [])
    })
    await act(async () => {
      await submission
    })
    expect(harness.get().status).toBe('done')
    expect(harness.get().baseId).toBe('b')
    await harness.unmount()
  })

  it('ignores comment frames', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      streamFromChunks([
        `: heartbeat\n\n`,
        jsonFrame({ kind: 'base.created', baseId: 'b', baseName: 'B' }),
        `: another comment\n\n`,
        jsonFrame({ kind: 'done' }),
      ]),
    )
    const harness = await mountHook()
    let submission: Promise<void> | undefined
    act(() => {
      submission = harness.get().submit('p', [])
    })
    await act(async () => {
      await submission
    })
    expect(harness.get().events).toHaveLength(2)
    expect(harness.get().status).toBe('done')
    await harness.unmount()
  })

  it('flushes a final event without trailing blank line at EOF', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      streamFromChunks([
        jsonFrame({ kind: 'base.created', baseId: 'b', baseName: 'B' }),
        // No trailing "\n\n"
        `data: ${JSON.stringify({ kind: 'done' })}\n`,
      ]),
    )
    const harness = await mountHook()
    let submission: Promise<void> | undefined
    act(() => {
      submission = harness.get().submit('p', [])
    })
    await act(async () => {
      await submission
    })
    expect(harness.get().status).toBe('done')
    expect(harness.get().events).toHaveLength(2)
    await harness.unmount()
  })

  it('accepts data lines with leading space after the colon', async () => {
    // jsonFrame already uses "data: {...}" with the space, so this also
    // covers the no-space variant which we exercise here.
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      streamFromChunks([
        `data:${JSON.stringify({ kind: 'base.created', baseId: 'b', baseName: 'B' })}\n\n`,
        jsonFrame({ kind: 'done' }),
      ]),
    )
    const harness = await mountHook()
    let submission: Promise<void> | undefined
    act(() => {
      submission = harness.get().submit('p', [])
    })
    await act(async () => {
      await submission
    })
    expect(harness.get().baseId).toBe('b')
    expect(harness.get().status).toBe('done')
    await harness.unmount()
  })
})

describe('useScenarioBuild — errors', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('transitions to error on HTTP 500 with body', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('something blew up', {
        status: 500,
        headers: { 'Content-Type': 'text/plain' },
      }),
    )
    const harness = await mountHook()
    let submission: Promise<void> | undefined
    act(() => {
      submission = harness.get().submit('p', [])
    })
    await act(async () => {
      await submission
    })
    expect(harness.get().status).toBe('error')
    expect(harness.get().error).toContain('something blew up')
    await harness.unmount()
  })

  it('falls back to "Request failed" message when HTTP body is empty', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('', { status: 503 }),
    )
    const harness = await mountHook()
    let submission: Promise<void> | undefined
    act(() => {
      submission = harness.get().submit('p', [])
    })
    await act(async () => {
      await submission
    })
    expect(harness.get().status).toBe('error')
    expect(harness.get().error).toMatch(/503/)
    await harness.unmount()
  })

  it('transitions to error on inline error event and ignores subsequent frames', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      streamFromChunks([
        jsonFrame({ kind: 'base.created', baseId: 'b', baseName: 'B' }),
        jsonFrame({ kind: 'error', code: 'inference', message: 'llm refused' }),
        jsonFrame({ kind: 'done' }),
      ]),
    )
    const harness = await mountHook()
    let submission: Promise<void> | undefined
    act(() => {
      submission = harness.get().submit('p', [])
    })
    await act(async () => {
      await submission
    })
    expect(harness.get().status).toBe('error')
    expect(harness.get().error).toBe('llm refused')
    // base.created and error captured; trailing done not appended.
    const kinds = harness.get().events.map((e) => e.kind)
    expect(kinds).toEqual(['base.created', 'error'])
    await harness.unmount()
  })

  it('warns and skips when a data line is not valid JSON (does NOT error)', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      streamFromChunks([
        `data: not-json\n\n`,
        jsonFrame({ kind: 'done' }),
      ]),
    )
    const harness = await mountHook()
    let submission: Promise<void> | undefined
    act(() => {
      submission = harness.get().submit('p', [])
    })
    await act(async () => {
      await submission
    })
    // warn+skip: stream continues and reaches done
    expect(harness.get().status).toBe('done')
    expect(harness.get().error).toBeNull()
    expect(warnSpy).toHaveBeenCalled()
    warnSpy.mockRestore()
    await harness.unmount()
  })

  it('errors when fetch itself throws (network drop)', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('connection refused'))
    const harness = await mountHook()
    let submission: Promise<void> | undefined
    act(() => {
      submission = harness.get().submit('p', [])
    })
    await act(async () => {
      await submission
    })
    expect(harness.get().status).toBe('error')
    expect(harness.get().error).toBe('connection refused')
    await harness.unmount()
  })
})

describe('useScenarioBuild — abort and reset', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('transitions to aborted when abort() called mid-stream', async () => {
    const encoder = new TextEncoder()
    let pushChunk: ((s: string) => void) | undefined
    let streamController: ReadableStreamDefaultController<Uint8Array> | undefined
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        streamController = controller
        pushChunk = (s) => controller.enqueue(encoder.encode(s))
      },
    })
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      const signal = (init as RequestInit | undefined)?.signal
      if (signal) {
        signal.addEventListener('abort', () => {
          streamController?.error(
            Object.assign(new Error('aborted'), { name: 'AbortError' }),
          )
        })
      }
      return new Response(body, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      })
    })
    const harness = await mountHook()
    let submission: Promise<void> | undefined
    act(() => {
      submission = harness.get().submit('p', [])
    })
    await act(async () => {
      pushChunk!(jsonFrame({ kind: 'base.created', baseId: 'b', baseName: 'B' }))
    })
    await waitFor(() => harness.get().status === 'streaming', { tag: 'streaming' })

    act(() => {
      harness.get().abort()
    })
    await act(async () => {
      await submission
    })
    expect(harness.get().status).toBe('aborted')
    // events captured before abort are kept.
    expect(harness.get().events).toHaveLength(1)
    await harness.unmount()
  })

  it('reset() clears events, status, error, baseId, baseName', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      streamFromChunks(HAPPY_PATH_PAYLOADS.map((p) => jsonFrame(p))),
    )
    const harness = await mountHook()
    let submission: Promise<void> | undefined
    act(() => {
      submission = harness.get().submit('p', [])
    })
    await act(async () => {
      await submission
    })
    expect(harness.get().status).toBe('done')

    act(() => {
      harness.get().reset()
    })
    const result = harness.get()
    expect(result.status).toBe('idle')
    expect(result.events).toEqual([])
    expect(result.baseId).toBeNull()
    expect(result.baseName).toBeNull()
    expect(result.error).toBeNull()
    await harness.unmount()
  })

  it('does not setState after unmount mid-stream', async () => {
    const encoder = new TextEncoder()
    let pushChunk: ((s: string) => void) | undefined
    let streamController: ReadableStreamDefaultController<Uint8Array> | undefined
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        streamController = controller
        pushChunk = (s) => controller.enqueue(encoder.encode(s))
      },
    })
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      const signal = (init as RequestInit | undefined)?.signal
      if (signal) {
        signal.addEventListener('abort', () => {
          streamController?.error(
            Object.assign(new Error('aborted'), { name: 'AbortError' }),
          )
        })
      }
      return new Response(body, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      })
    })
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const harness = await mountHook()
    let submission: Promise<void> | undefined
    act(() => {
      submission = harness.get().submit('p', [])
    })
    await act(async () => {
      pushChunk!(jsonFrame({ kind: 'base.created', baseId: 'b', baseName: 'B' }))
    })
    await waitFor(() => harness.get().status === 'streaming', { tag: 'streaming' })
    await harness.unmount()
    // Resolve the submission promise after unmount.
    await act(async () => {
      await submission
    })
    expect(errorSpy).not.toHaveBeenCalled()
    errorSpy.mockRestore()
  })
})

describe('useScenarioBuild — FormData / headers', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('sends repeated attachments field and X-Locale header', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      streamFromChunks([jsonFrame({ kind: 'done' })]),
    )
    const harness = await mountHook()

    const file1 = new File(['a'], 'receipt1.pdf', { type: 'application/pdf' })
    const file2 = new File(['b'], 'receipt2.jpg', { type: 'image/jpeg' })

    let submission: Promise<void> | undefined
    act(() => {
      submission = harness.get().submit('build a receipt tracker', [file1, file2])
    })
    await act(async () => {
      await submission
    })

    const init = fetchSpy.mock.calls[0]![1] as RequestInit
    const body = init.body as FormData

    // Fix 4a — attachments repeated field
    const attachments = body.getAll('attachments')
    expect(attachments).toHaveLength(2)
    expect(attachments[0]).toBeInstanceOf(File)
    expect(attachments[1]).toBeInstanceOf(File)
    expect((attachments[0] as File).name).toBe('receipt1.pdf')
    expect((attachments[1] as File).name).toBe('receipt2.jpg')

    // Fix 4b — X-Locale header
    const headers = init.headers as Record<string, string>
    expect(headers['X-Locale']).toBe('en-US')

    await harness.unmount()
  })
})

describe('useScenarioBuild — concurrent submit rejection', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('rejects a second concurrent submit with "in flight" and does not regress status', async () => {
    // Fix 4c
    let resolveFetch: ((r: Response) => void) | undefined
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          resolveFetch = resolve
        }),
    )
    const harness = await mountHook()

    let firstSubmission: Promise<void> | undefined
    act(() => {
      firstSubmission = harness.get().submit('first', [])
    })
    await waitFor(() => harness.get().status === 'submitting', { tag: 'submitting' })

    // Second concurrent call must reject
    let secondError: Error | undefined
    await act(async () => {
      try {
        await harness.get().submit('second', [])
      } catch (e) {
        secondError = e as Error
      }
    })

    expect(secondError).toBeDefined()
    expect(secondError!.message).toMatch(/in.?flight|in.?progress/i)

    // Status must NOT regress from submitting
    expect(harness.get().status).toBe('submitting')

    // Clean up by resolving the first request
    act(() => {
      resolveFetch!(
        streamFromChunks([jsonFrame({ kind: 'done' })]),
      )
    })
    await act(async () => {
      await firstSubmission
    })
    await harness.unmount()
  })
})

describe('useScenarioBuild — reset() mid-stream stays idle', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('status stays idle (not aborted) after reset() called while streaming', async () => {
    // Fix 4d
    const encoder = new TextEncoder()
    let pushChunk: ((s: string) => void) | undefined
    let streamController: ReadableStreamDefaultController<Uint8Array> | undefined
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        streamController = controller
        pushChunk = (s) => controller.enqueue(encoder.encode(s))
      },
    })
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      const signal = (init as RequestInit | undefined)?.signal
      if (signal) {
        signal.addEventListener('abort', () => {
          streamController?.error(
            Object.assign(new Error('aborted'), { name: 'AbortError' }),
          )
        })
      }
      return new Response(body, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      })
    })
    const harness = await mountHook()

    let submission: Promise<void> | undefined
    act(() => {
      submission = harness.get().submit('p', [])
    })
    await act(async () => {
      pushChunk!(jsonFrame({ kind: 'base.created', baseId: 'b', baseName: 'B' }))
    })
    await waitFor(() => harness.get().status === 'streaming', { tag: 'streaming' })

    // Call reset() while streaming
    act(() => {
      harness.get().reset()
    })

    // Await the submission promise (it should settle now)
    await act(async () => {
      await submission
    })

    // Status must be idle, NOT aborted
    expect(harness.get().status).toBe('idle')
    expect(harness.get().events).toEqual([])
    expect(harness.get().error).toBeNull()

    await harness.unmount()
  })
})

describe('useScenarioBuild — unknown SSE frame tolerance', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('warns and skips unknown event kinds, continuing to process known frames', async () => {
    // Fix 4e
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      streamFromChunks([
        jsonFrame({ kind: 'base.created', baseId: 'b', baseName: 'B' }),
        jsonFrame({ kind: 'progress.tick', value: 42 }),
        jsonFrame({ kind: 'table.created', tableId: 't', tableName: 'T' }),
        jsonFrame({ kind: 'done' }),
      ]),
    )
    const harness = await mountHook()
    let submission: Promise<void> | undefined
    act(() => {
      submission = harness.get().submit('p', [])
    })
    await act(async () => {
      await submission
    })

    expect(harness.get().status).toBe('done')
    const kinds = harness.get().events.map((e) => e.kind)
    // Unknown frame NOT in events
    expect(kinds).not.toContain('progress.tick')
    // Known frames after the unknown frame are present
    expect(kinds).toContain('table.created')
    expect(kinds).toContain('done')
    // console.warn was called for the unknown frame
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('[useScenarioBuild]'),
      expect.anything(),
    )

    warnSpy.mockRestore()
    await harness.unmount()
  })

  it('skips empty data: lines silently and continues stream', async () => {
    // Fix 4f
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      streamFromChunks([
        jsonFrame({ kind: 'base.created', baseId: 'b', baseName: 'B' }),
        `data:\n\n`,
        jsonFrame({ kind: 'done' }),
      ]),
    )
    const harness = await mountHook()
    let submission: Promise<void> | undefined
    act(() => {
      submission = harness.get().submit('p', [])
    })
    await act(async () => {
      await submission
    })

    expect(harness.get().status).toBe('done')
    // Only 2 real events (base.created + done), empty frame skipped
    expect(harness.get().events).toHaveLength(2)

    await harness.unmount()
  })
})
