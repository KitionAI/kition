import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

import type { AgentEvent } from '@/api/agent'
import {
  modelSupportsHostedWebSearch,
  readLatestAgentTurnCapabilities,
  resolveAgentHostedWebSearchState,
} from '@/features/agent/lib/agentTurnCapabilities'

describe('agent turn capabilities contract', () => {
  it('keeps the public schema stable and privacy-safe', () => {
    const schema = JSON.parse(readFileSync(
      resolve('contracts/runtime/agent-turn-capabilities.schema.json'),
      'utf8',
    ))

    expect(schema.$id).toBe('https://kition.ai/contracts/runtime/agent-turn-capabilities.schema.json')
    expect(schema.required).toEqual([
      'available_tools',
      'hosted_web_search',
      'browser_search',
    ])
    expect(JSON.stringify(schema)).not.toContain('api_key')
    expect(JSON.stringify(schema)).not.toContain('access_token')
  })

  it('defines turn-scoped read-only local analysis folders', () => {
    const schema = JSON.parse(readFileSync(
      resolve('contracts/runtime/agent-local-sources.schema.json'),
      'utf8',
    ))

    expect(schema.$id).toBe('https://kition.ai/contracts/runtime/agent-local-sources.schema.json')
    expect(schema.maxItems).toBe(8)
    expect(schema.items.properties.access.const).toBe('read')
    expect(schema.items.required).toContain('root_path')
    expect(JSON.stringify(schema)).not.toContain('write_root')
    expect(schema.description).toContain('read-only Git history')
    expect(schema.description).toContain('must not be persisted')
  })

  it('defines bounded privacy-safe model reconnect progress', () => {
    const schema = JSON.parse(readFileSync(
      resolve('contracts/runtime/agent-model-reconnect.schema.json'),
      'utf8',
    ))

    expect(schema.$id).toBe('https://kition.ai/contracts/runtime/agent-model-reconnect.schema.json')
    expect(schema.properties.max_retries.const).toBe(5)
    expect(schema.properties.attempt.maximum).toBe(5)
    expect(schema.properties.delay_ms.maximum).toBe(8000)
    expect(schema.required).toEqual(['turn', 'attempt', 'max_retries', 'delay_ms', 'reason'])
    expect(JSON.stringify(schema)).not.toContain('base_url')
    expect(JSON.stringify(schema)).not.toContain('endpoint')
    expect(JSON.stringify(schema)).not.toContain('access_token')
  })

  it('reads the latest authoritative runtime capability event', () => {
    const events = [
      event(1, false),
      event(2, true),
    ]

    expect(readLatestAgentTurnCapabilities(events)?.hosted_web_search).toEqual({
      available: true,
      reason: 'available',
    })
  })

  it('ignores stale capability events from a previously selected model', () => {
    const stale = event(1, false)
    stale.data = { ...stale.data, model_id: 'deepseek:deepseek-chat' }

    expect(readLatestAgentTurnCapabilities([stale], 'openai:gpt-test')).toBeUndefined()
  })

  it('recognizes supported hosted-search model routes before the first turn', () => {
    expect(modelSupportsHostedWebSearch(model('kition_console', 'responses', 'gpt-test'))).toBe(true)
    expect(modelSupportsHostedWebSearch(model('openai', 'responses', 'gpt-test'))).toBe(true)
    expect(modelSupportsHostedWebSearch(model('anthropic', 'anthropic_messages', 'claude-test'))).toBe(true)
    expect(modelSupportsHostedWebSearch(model('deepseek', 'responses', 'deepseek-chat'))).toBe(false)
  })

  it('prefers the runtime result over model inference', () => {
    expect(resolveAgentHostedWebSearchState({
      capabilities: event(1, false).data?.turn_capabilities,
      model: model('openai', 'responses', 'gpt-test'),
    })).toEqual({
      available: false,
      reason: 'task_mode_restricted',
      source: 'runtime',
    })
  })
})

function event(id: number, available: boolean): AgentEvent {
  return {
    id,
    session_id: 1,
    user_id: 1,
    event_type: 'prompt.sent',
    data: {
      turn_capabilities: {
        available_tools: available ? ['document_read', 'web_search'] : ['document_read'],
        hosted_web_search: {
          available,
          reason: available ? 'available' : 'task_mode_restricted',
        },
        browser_search: {
          available: false,
          reason: 'browser_disabled',
        },
      },
    },
    created_at: new Date().toISOString(),
  }
}

function model(
  providerKind: 'openai' | 'anthropic' | 'deepseek' | 'kition_console',
  wireAPI: 'responses' | 'anthropic_messages',
  modelName: string,
): any {
  return {
    providerKind,
    runtimeModel: {
      provider_type: providerKind,
      provider_label: providerKind,
      model_name: modelName,
      base_url: '',
      api_key: '',
      wire_api: wireAPI,
    },
  }
}
