import { describe, expect, it } from 'vitest'

import { checkParameterSchema } from './kitParameterSchema.mjs'

describe('KHP agent parameter schemas', () => {
  it.each(['read', 'create', 'write'])('accepts a file with %s access', (access) => {
    expect(() => checkParameterSchema({ type: 'file', access, required: true }, 'file.import.path', true)).not.toThrow()
  })

  it.each([undefined, '', 'read-write', true, ['read']])('rejects invalid file access %j', (access) => {
    expect(() => checkParameterSchema({ type: 'file', access }, 'file.import.path', true)).toThrow('a file states access read, create, or write')
  })

  it('validates file access within arrays, objects and union branches', () => {
    const schema = {
      type: 'object', additionalProperties: false,
      properties: { sources: { type: 'array', items: { oneOf: [{ type: 'null' }, { type: 'file', access: 'read' }] } } },
    }
    expect(() => checkParameterSchema(schema, 'document.import', true)).not.toThrow()
    schema.properties.sources.items.oneOf[1].access = 'invalid'
    expect(() => checkParameterSchema(schema, 'document.import', true)).toThrow('document.import.sources[].oneOf[1]')
  })

  it('continues to reject unknown types and malformed required flags and objects', () => {
    expect(() => checkParameterSchema({ type: 'path', access: 'read' }, 'input', true)).toThrow('unknown type path')
    expect(() => checkParameterSchema({ type: 'string', required: false }, 'input', true)).toThrow('required must be true')
    expect(() => checkParameterSchema({ type: 'object' }, 'input', true)).toThrow('objects state additionalProperties')
    expect(() => checkParameterSchema({ oneOf: [{ type: 'string' }] }, 'input', true)).toThrow('oneOf needs two branches')
  })
})
