import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import type { TFunction } from 'i18next'
import { describe, expect, it } from 'vitest'

import { getBuiltinKitableTemplates } from './kitableTemplates'

const t = ((key: string) => key) as TFunction<'table'>

describe('table template cover assets', () => {
  it('ships a generated WebP cover for every built-in template', () => {
    for (const template of getBuiltinKitableTemplates(t)) {
      const bytes = readFileSync(resolve('public', template.coverImage.replace(/^\//, '')))

      expect(bytes.byteLength).toBeGreaterThan(10_000)
      expect(bytes.subarray(0, 4).toString('ascii')).toBe('RIFF')
      expect(bytes.subarray(8, 12).toString('ascii')).toBe('WEBP')
    }
  })
})
