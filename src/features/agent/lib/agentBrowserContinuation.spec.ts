import { describe, expect, it } from 'vitest'
import type { AgentEvent } from '@/api/agent'
import {
  buildAgentBrowserPageContextRequest,
  findLatestBrowserContinuationRequest,
  readBrowserOpenRequest,
} from './agentBrowserContinuation'

describe('agent browser continuation', () => {
  it('reads extraction hints and bounded retry metadata from a browser handoff', () => {
    const event = {
      id: 42,
      session_id: 7,
      user_id: 1,
      event_type: 'browser.open_required',
      stage: 'browser',
      status: 'completed',
      label: 'Browser required',
      message: 'Use the loaded page.',
      data: {
        action: 'open_embedded_browser',
        provider: 'generic-web',
        adapter: 'youtube',
        command: 'extract-list',
        entity_type: 'video',
        host: 'youtube.com',
        url: 'https://www.youtube.com/',
        client_auto_continue: true,
        client_auto_continue_attempt: 2,
        client_original_request: 'Collect the loaded video cards.',
      },
      created_at: '2026-07-26T00:00:00.000Z',
    } satisfies AgentEvent

    expect(readBrowserOpenRequest(event)).toEqual({
      action: 'open_embedded_browser',
      provider: 'generic-web',
      adapter: 'youtube',
      command: 'extract-list',
      entityType: 'video',
      host: 'youtube.com',
      url: 'https://www.youtube.com/',
      query: undefined,
      message: 'Use the loaded page.',
      autoContinue: true,
      autoContinueAttempt: 2,
      autoContinueExhausted: false,
      originalRequest: 'Collect the loaded video cards.',
    })
  })

  it('forwards runtime extraction hints to the current BrowserView session', () => {
    expect(buildAgentBrowserPageContextRequest(
      {
        provider: 'generic-web',
        profileId: 'primary',
        host: 'youtube.com',
      },
      {
        action: 'open_embedded_browser',
        adapter: 'youtube',
        command: 'extract-list',
        entityType: 'video',
        query: 'recommended',
        host: 'youtube.com',
      },
    )).toEqual({
      provider: 'generic-web',
      profile_id: 'primary',
      host: 'youtube.com',
      adapter: 'youtube',
      command: 'extract-list',
      query: 'recommended',
      entity_type: 'video',
    })
  })

  it('recovers an unmarked handoff left by the previous one-shot continuation', () => {
    const firstEvent = {
      id: 51,
      session_id: 7,
      user_id: 1,
      event_type: 'browser.open_required',
      stage: 'browser',
      status: 'completed',
      label: 'Browser required',
      message: 'Open the page.',
      data: {
        action: 'open_embedded_browser',
        adapter: 'youtube',
        command: 'extract-list',
        entity_type: 'video',
        host: 'youtube.com',
        client_auto_continue: true,
        client_auto_continue_attempt: 1,
        client_original_request: 'Collect every loaded video card.',
      },
      created_at: '2026-07-26T00:00:00.000Z',
    } satisfies AgentEvent
    const staleSecondEvent = {
      ...firstEvent,
      id: 52,
      data: {
        action: 'open_embedded_browser',
        adapter: 'youtube',
        command: 'extract-list',
        entity_type: 'video',
        host: 'youtube.com',
      },
    } satisfies AgentEvent

    expect(findLatestBrowserContinuationRequest([
      firstEvent,
      staleSecondEvent,
    ])).toEqual({
      eventId: 52,
      request: expect.objectContaining({
        adapter: 'youtube',
        command: 'extract-list',
        entityType: 'video',
        autoContinue: true,
        autoContinueAttempt: 2,
        autoContinueExhausted: false,
        originalRequest: 'Collect every loaded video card.',
      }),
    })
  })
})
