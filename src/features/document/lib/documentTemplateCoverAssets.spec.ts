import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import type { TFunction } from 'i18next'
import { describe, expect, it } from 'vitest'

import { getBuiltinDocumentTemplates } from './documentTemplates'

const t = ((key: string) => key) as TFunction<'document'>

describe('document template cover assets', () => {
  it('ships a generated 960 by 540 WebP cover for every built-in template', () => {
    for (const template of getBuiltinDocumentTemplates(t)) {
      const bytes = readFileSync(resolve('public', template.coverImage.replace(/^\//, '')))

      expect(bytes.byteLength).toBeGreaterThan(10_000)
      expect(bytes.subarray(0, 4).toString('ascii')).toBe('RIFF')
      expect(bytes.subarray(8, 12).toString('ascii')).toBe('WEBP')
      expect(bytes.subarray(12, 16).toString('ascii')).toBe('VP8 ')
      expect(bytes.readUInt16LE(26) & 0x3fff).toBe(960)
      expect(bytes.readUInt16LE(28) & 0x3fff).toBe(540)
    }
  })
})
