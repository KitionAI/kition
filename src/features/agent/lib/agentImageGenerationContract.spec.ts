import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

import {
  mergeAgentImageGenerationEvents,
  readAgentImageGenerationEvent,
} from './agentImageGenerationStream'
import { runtimeSupportsAgentImageGeneration } from '@/features/media-generation/lib/imageGenerationCapabilities'
import {
  AGENT_IMAGE_GENERATION_CAPABILITY,
  AGENT_IMAGE_GENERATION_EVENT_NAMES,
  AGENT_IMAGE_GENERATION_MAX_REFERENCES,
  AGENT_IMAGE_GENERATION_MAX_VARIANTS,
  AGENT_IMAGE_GENERATION_STATUSES,
  type AgentImageGenerationEvent,
} from '@/types/imageGeneration'

describe('Agent image-generation public boundary', () => {
  it('keeps capability, limits, surfaces, and event payloads in lockstep', () => {
    const schema = JSON.parse(readFileSync(
      resolve('contracts/runtime/agent-image-generation.schema.json'),
      'utf8',
    ))

    expect(schema.$id).toBe('https://kition.ai/contracts/runtime/agent-image-generation.schema.json')
    expect(schema['x-runtime-capability']).toBe(AGENT_IMAGE_GENERATION_CAPABILITY)
    expect(schema.oneOf).toEqual([
      { $ref: '#/$defs/intent' },
      { $ref: '#/$defs/event' },
    ])
    expect(schema.$defs.intent.properties.variants.maximum).toBe(
      AGENT_IMAGE_GENERATION_MAX_VARIANTS,
    )
    expect(schema.$defs.intent.properties.reference_paths.maxItems).toBe(
      AGENT_IMAGE_GENERATION_MAX_REFERENCES,
    )
    expect(schema.$defs.intent.properties.surface.enum).toEqual([
      'document',
      'table',
      'whiteboard',
    ])
    expect(schema.$defs.event.properties.event.enum).toEqual([
      ...AGENT_IMAGE_GENERATION_EVENT_NAMES,
    ])
    expect(schema.$defs.event.properties.status.enum).toEqual([
      ...AGENT_IMAGE_GENERATION_STATUSES,
    ])
    expect(schema.$defs.artifact.required).toContain('provenance')
  })

  it('keeps user and workspace context bounded and privacy-safe', () => {
    const schema = JSON.parse(readFileSync(
      resolve('contracts/runtime/agent-image-generation.schema.json'),
      'utf8',
    ))
    const serialized = JSON.stringify(schema)

    expect(schema.$defs.intent.properties.instruction.maxLength).toBeLessThanOrEqual(12000)
    expect(schema.$defs.intent.properties.template_variables.maxProperties).toBeLessThanOrEqual(32)
    expect(schema.$defs.tableTarget.properties.record_ids.maxItems).toBeLessThanOrEqual(100)
    expect(schema.$defs.portablePath.pattern).toContain('(?!/)')
    expect(serialized).not.toContain('api_key')
    expect(serialized).not.toContain('access_token')
    expect(serialized).not.toContain('workspace_root')
  })

  it('requires the explicit runtime capability', () => {
    expect(runtimeSupportsAgentImageGeneration()).toBe(false)
    expect(runtimeSupportsAgentImageGeneration(['documents', 'agent_whiteboard_v1'])).toBe(false)
    expect(runtimeSupportsAgentImageGeneration([
      'documents',
      AGENT_IMAGE_GENERATION_CAPABILITY,
    ])).toBe(true)
  })

  it('reads direct and persisted typed image-generation stream events', () => {
    const imageEvent = generationEvent()

    expect(readAgentImageGenerationEvent({
      type: 'image_generation_event',
      image_generation: imageEvent,
    })).toEqual(imageEvent)

    expect(readAgentImageGenerationEvent({
      type: 'agent_event',
      event: {
        id: 10,
        session_id: 7,
        user_id: 1,
        event_type: 'image_generation.progress',
        status: 'running',
        data: { image_generation: imageEvent },
        created_at: '2026-09-05T00:00:00.000Z',
      },
    })).toEqual(imageEvent)

    expect(readAgentImageGenerationEvent({
      type: 'image_generation_event',
      extra_data: { request_id: 'missing-typed-payload' },
    })).toBeNull()
  })

  it('keeps the latest progress event while retaining distinct artifacts', () => {
    const firstProgress = generationEvent()
    const latestProgress = { ...firstProgress, progress: 0.8 }
    const firstArtifact: AgentImageGenerationEvent = {
      ...firstProgress,
      event: 'image_generation.artifact',
      status: 'saving',
      artifact: {
        id: 1,
        path: 'Agent/images/one.png',
        mime_type: 'image/png',
        variant_index: 0,
        variant_count: 2,
        created_at: '2026-09-05T00:00:00.000Z',
        provenance: { request_id: firstProgress.request_id },
      },
    }
    const secondArtifact: AgentImageGenerationEvent = {
      ...firstArtifact,
      artifact: {
        ...firstArtifact.artifact!,
        id: 2,
        path: 'Agent/images/two.png',
        variant_index: 1,
      },
    }

    const events = [latestProgress, firstArtifact, secondArtifact].reduce(
      mergeAgentImageGenerationEvents,
      [firstProgress],
    )

    expect(events).toHaveLength(3)
    expect(events[0].progress).toBe(0.8)
    expect(events.slice(1).map((event) => event.artifact?.id)).toEqual([1, 2])
  })
})

function generationEvent(): AgentImageGenerationEvent {
  return {
    type: 'image_generation.event',
    schema_version: 1,
    request_id: 'image-request-1',
    event: 'image_generation.progress',
    status: 'generating',
    progress: 0.5,
  }
}
