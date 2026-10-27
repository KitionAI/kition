import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

import type { AgentSessionEventsSessionEvent } from '@/api/generated/agent-session-events'
import { expectMatchesContract } from '@/test/contracts'
import imageComposerTurns from './__fixtures__/imageComposerTurns.json'
import { imageJobOf } from './agentImageJob'
import { applySessionEvent, emptyAgentSessionView } from './agentSessionView'
import { runtimeSupportsAgentImageGeneration } from '@/features/media-generation/lib/imageGenerationCapabilities'
import {
  AGENT_IMAGE_GENERATION_CAPABILITY,
  AGENT_IMAGE_GENERATION_CHAT_CAPABILITY,
  AGENT_IMAGE_GENERATION_MAX_REFERENCES,
  AGENT_IMAGE_GENERATION_MAX_VARIANTS,
} from '@/types/imageGeneration'

describe('Agent image-generation public boundary', () => {
  it('keeps capability, limits, surfaces, and event payloads in lockstep', () => {
    const schema = JSON.parse(readFileSync(
      resolve('contracts/runtime/agent-image-generation.schema.json'),
      'utf8',
    ))

    expect(schema.$id).toBe('https://kition.ai/contracts/runtime/agent-image-generation.schema.json')
    expect(schema['x-runtime-capability']).toBe(AGENT_IMAGE_GENERATION_CAPABILITY)
    expect(schema['x-chat-runtime-capability']).toBe(AGENT_IMAGE_GENERATION_CHAT_CAPABILITY)
    expect(schema.oneOf).toEqual([
      { $ref: '#/$defs/intent' },
      { $ref: '#/$defs/variantCall' },
      { $ref: '#/$defs/variantMeta' },
    ])
    expect(schema.$defs.intent.properties.variants.maximum).toBe(
      AGENT_IMAGE_GENERATION_MAX_VARIANTS,
    )
    expect(schema.$defs.intent.properties.reference_paths.maxItems).toBe(
      AGENT_IMAGE_GENERATION_MAX_REFERENCES,
    )
    expect(schema.$defs.intent.properties.surface.enum).toEqual([
      'document',
      'chat',
    ])
    expect(schema.$defs.variantMeta.properties.kind.const).toBe('image_generation.variant')
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
    expect(schema.$defs.portablePath.pattern).toContain('(?!/)')
    expect(serialized).not.toContain('api_key')
    expect(serialized).not.toContain('access_token')
    expect(serialized).not.toContain('workspace_root')
  })

  it('requires the explicit runtime capability', () => {
    expect(runtimeSupportsAgentImageGeneration()).toBe(false)
    expect(runtimeSupportsAgentImageGeneration(['documents', 'tables'])).toBe(false)
    expect(runtimeSupportsAgentImageGeneration([
      'documents',
      AGENT_IMAGE_GENERATION_CAPABILITY,
    ])).toBe(true)
  })

  it('logs each saved variant as the contract artifact', () => {
    const turns = (imageComposerTurns as AgentSessionEventsSessionEvent[])
      .reduce(applySessionEvent, emptyAgentSessionView()).turns
    const job = turns.map(imageJobOf).find(Boolean)
    expect(job?.artifacts.length).toBeGreaterThan(0)
    for (const artifact of job?.artifacts ?? []) {
      expectMatchesContract(artifact, 'agent-image-generation', 'artifact')
    }
  })
})
