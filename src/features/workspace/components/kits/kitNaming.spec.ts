import { describe, expect, it } from 'vitest'
import sdks from '../../../../../kits/sdks.json'
import { creatableKits } from './kitEditors'

describe('kit identities across the workspace and engine registry', () => {
  for (const entry of creatableKits()) {
    const name = entry.embedded.kitId.slice('kit.'.length)
    it(`${name} creates files with the identity its engine is built with`, () => {
      const registry = sdks[name as keyof typeof sdks] as { repository: string; crate: string; module: string; class: string }
      expect(registry).toBeDefined()
      expect(entry.create.id).toBe(name)
      expect(entry.embedded.dir).toBe(`${name}-ui`)
      expect(entry.engine.kitId).toBe(entry.embedded.kitId)
      expect(entry.engine.module).toBe(registry.module)
      expect(entry.engine.documentClass).toBe(registry.class)
      expect(registry.repository).toBe(`KitionAI/kition-${name}`)
      expect(registry.crate).toBe(`kition-${name}-sdk`)
      const noun = ['pdf', 'cad', 'html'].includes(name) ? name.toUpperCase() : name
      expect(entry.create.baseName).toBe(`Untitled ${noun}`)
    })
  }
  it('has a single create identity for each kit', () => {
    const ids = creatableKits().map(({ create }) => create.id)
    expect(new Set(ids).size).toBe(ids.length)
  })
})
