import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

import { runtimeSupportsWhiteboard } from './whiteboardCapabilities'
import {
  AGENT_WHITEBOARD_CAPABILITY,
  AGENT_WHITEBOARD_PATCH_OPERATION_LIMIT,
} from '@/types/whiteboardAgent'

describe('AI Whiteboard public boundary', () => {
  it('keeps the capability and patch limit in lockstep with the public schema', () => {
    const schema = JSON.parse(readFileSync(
      resolve('contracts/runtime/agent-whiteboard.schema.json'),
      'utf8',
    ))

    expect(schema['x-runtime-capability']).toBe(AGENT_WHITEBOARD_CAPABILITY)
    expect(schema.$defs.patch.properties.operations.maxItems).toBe(
      AGENT_WHITEBOARD_PATCH_OPERATION_LIMIT,
    )
    expect(schema.oneOf).toEqual([
      { $ref: '#/$defs/context' },
      { $ref: '#/$defs/patch' },
    ])
  })

  it('keeps context bounded and privacy-safe', () => {
    const schema = JSON.parse(readFileSync(
      resolve('contracts/runtime/agent-whiteboard.schema.json'),
      'utf8',
    ))
    const serialized = JSON.stringify(schema)

    expect(schema.$defs.context.properties.elements.maxItems).toBeLessThanOrEqual(500)
    expect(schema.$defs.context.properties.source_refs.maxItems).toBeLessThanOrEqual(100)
    expect(schema.$defs.portablePath.pattern).toContain('(?!/)')
    expect(serialized).not.toContain('api_key')
    expect(serialized).not.toContain('access_token')
    expect(serialized).not.toContain('root_path')
  })

  it('requires the explicit runtime capability', () => {
    expect(runtimeSupportsWhiteboard()).toBe(false)
    expect(runtimeSupportsWhiteboard(['documents', 'workflow'])).toBe(false)
    expect(runtimeSupportsWhiteboard([
      'documents',
      AGENT_WHITEBOARD_CAPABILITY,
    ])).toBe(true)
  })
})
