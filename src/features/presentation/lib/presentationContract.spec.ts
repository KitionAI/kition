import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

import {
  PRESENTATION_DOCUMENT_TYPE,
  PRESENTATION_DOCUMENT_VERSION,
  PRESENTATION_OOXML_CAPABILITY,
  PRESENTATION_WIDE_SIZE,
} from './presentationTypes'

describe('presentation OOXML contract', () => {
  it('keeps the client constants aligned with the public runtime schema', () => {
    const schema = JSON.parse(readFileSync(
      resolve('contracts/runtime/presentation-ooxml.schema.json'),
      'utf8',
    ))

    expect(schema.$id).toBe('https://kition.ai/contracts/runtime/presentation-ooxml.schema.json')
    expect(schema['x-runtime-capability']).toBe(PRESENTATION_OOXML_CAPABILITY)
    expect(schema.$defs.document.properties.type.const).toBe(PRESENTATION_DOCUMENT_TYPE)
    expect(schema.$defs.document.properties.schema_version.const)
      .toBe(PRESENTATION_DOCUMENT_VERSION)
    expect(schema.$defs.renderResponse.properties.mime_type.const)
      .toContain('presentationml.presentation')
    expect(PRESENTATION_WIDE_SIZE).toEqual({ width: 12_192_000, height: 6_858_000 })
  })

  it('reserves structural element kinds needed for future PPTX import fidelity', () => {
    const schema = JSON.parse(readFileSync(
      resolve('contracts/runtime/presentation-ooxml.schema.json'),
      'utf8',
    ))
    expect(schema.$defs.element.properties.kind.enum).toEqual(expect.arrayContaining([
      'shape',
      'text',
      'image',
      'connector',
      'freeform',
      'group',
      'table',
      'chart',
      'media',
      'unsupported',
    ]))
  })
})
