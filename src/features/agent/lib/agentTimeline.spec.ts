import { describe, expect, it } from 'vitest'

import type { AgentEvent, AgentToolCall } from '@/api/agent'
import {
  buildAgentRunLogItems,
  formatAgentRunLogExpandedDetail,
  getAgentModifiedDocumentPaths,
} from './agentTimeline'

function event(eventType: string, overrides: Partial<AgentEvent> = {}): AgentEvent {
  return {
    id: overrides.id ?? Math.floor(Math.random() * 1_000_000),
    session_id: 1,
    user_id: 1,
    event_type: eventType,
    status: 'completed',
    created_at: '2026-05-29T00:00:00.000Z',
    ...overrides,
  }
}

function toolCall(overrides: Partial<AgentToolCall> = {}): AgentToolCall {
  return {
    id: overrides.id ?? 1,
    session_id: 1,
    user_id: 1,
    tool_name: 'document_read',
    status: 'completed',
    created_at: '2026-05-29T00:00:01.000Z',
    updated_at: '2026-05-29T00:00:01.000Z',
    ...overrides,
  }
}

describe('getAgentModifiedDocumentPaths', () => {
  it('collects every file changed by a completed patch', () => {
    const paths = getAgentModifiedDocumentPaths([
      toolCall({
        tool_name: 'apply_patch',
        output_data: {
          file_ops: [{ path: 'Docs/Article.md' }],
          changes: [
            { path: 'Docs/Article.md' },
            { path: 'Docs/Notes.md' },
          ],
        },
      }),
    ])

    expect(Array.from(paths)).toEqual(['Docs/Article.md', 'Docs/Notes.md'])
  })

  it('ignores failed patches so stale drafts are not discarded', () => {
    const paths = getAgentModifiedDocumentPaths([
      toolCall({
        tool_name: 'apply_patch',
        status: 'failed',
        output_data: { file_ops: [{ path: 'Docs/Article.md' }] },
      }),
    ])

    expect(paths.size).toBe(0)
  })

  it('collects a kitable created by the table creation tool', () => {
    const paths = getAgentModifiedDocumentPaths([
      toolCall({
        tool_name: 'data_table_create',
        output_data: {
          path: 'Admissions/Low-threshold samples.kitable',
          document_id: 42,
          table_id: 7,
        },
      }),
    ])

    expect(Array.from(paths)).toEqual(['Admissions/Low-threshold samples.kitable'])
  })
})

describe('buildAgentRunLogItems debug filtering', () => {
  const events: AgentEvent[] = [
    event('task.started', { id: 1 }),
    event('prompt.sent', { id: 2 }),
    event('model.turn.started', { id: 3 }),
    event('model.tool_call.ready', { id: 4, data: { tool_name: 'document_read' } }),
    event('model.turn.completed', { id: 5 }),
    event('task.completed', { id: 6, label: 'Task completed' }),
  ]
  const toolCalls = [toolCall()]

  it('hides model-protocol events when debug is off (en-US)', () => {
    const items = buildAgentRunLogItems({
      events,
      toolCalls,
      artifacts: [],
      busy: false,
      streamingText: '',
      locale: 'en-US',
    })

    const titles = items.map((item) => item.title)
    expect(titles).toContain('Task completed')
    expect(items.some((item) => item.kind === 'tool')).toBe(true)
    expect(titles).not.toContain('Task understood')
    expect(titles).not.toContain('Send model request')
    expect(titles).not.toContain('AI backend called')
    expect(titles).not.toContain('AI backend turn completed')
  })

  it('keeps model-protocol events when debug is on (en-US)', () => {
    const items = buildAgentRunLogItems({
      events,
      toolCalls,
      artifacts: [],
      busy: false,
      streamingText: '',
      debug: true,
      locale: 'en-US',
    })

    const titles = items.map((item) => item.title)
    expect(titles).toContain('Task understood')
    expect(titles).toContain('Send model request')
    expect(titles).toContain('AI backend called')
  })
})

describe('buildAgentRunLogItems locale switching', () => {
  const events: AgentEvent[] = [event('task.started', { id: 1 })]
  const toolCalls = [toolCall()]

  it('emits an English model-thinking title under en-US', () => {
    const items = buildAgentRunLogItems({
      events,
      toolCalls,
      artifacts: [],
      busy: true,
      streamingText: '',
      locale: 'en-US',
    })
    const modelItem = items.find((item) => item.kind === 'model')
    expect(modelItem).toBeDefined()
    expect(modelItem?.title).toBe('Processing tool results')
    expect(modelItem?.detail).toContain('Read Document')
  })

  it('defaults to en-US when no locale is provided', () => {
    const items = buildAgentRunLogItems({
      events,
      toolCalls,
      artifacts: [],
      busy: true,
      streamingText: '',
    })
    const modelItem = items.find((item) => item.kind === 'model')
    expect(modelItem?.title).toBe('Processing tool results')
  })
})

describe('formatAgentRunLogExpandedDetail', () => {
  it('returns English natural language for model kind instead of raw JSON', () => {
    const items = buildAgentRunLogItems({
      events: [],
      toolCalls: [toolCall()],
      artifacts: [],
      busy: true,
      streamingText: '',
      locale: 'en-US',
    })
    const modelItem = items.find((item) => item.kind === 'model')
    expect(modelItem).toBeDefined()
    const expanded = formatAgentRunLogExpandedDetail(modelItem!, 'en-US')
    expect(expanded).not.toContain('processing_tool_result')
    expect(expanded).not.toContain('"state"')
    expect(expanded).not.toContain('"latest_tool"')
    expect(expanded).toContain('Read Document')
  })

  it('uses English section labels for tool kind', () => {
    const items = buildAgentRunLogItems({
      events: [],
      toolCalls: [
        toolCall({
          id: 7,
          input_data: { path: '/docs/a.md' },
          output_data: { path: '/docs/a.md', text: 'hello' },
        }),
      ],
      artifacts: [],
      busy: false,
      streamingText: '',
      locale: 'en-US',
    })
    const toolItem = items.find((item) => item.kind === 'tool')
    const expanded = formatAgentRunLogExpandedDetail(toolItem!, 'en-US')
    expect(expanded).toContain('Tool')
    expect(expanded).toContain('Input')
    expect(expanded).toContain('Output')
  })
})
