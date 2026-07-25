import { describe, expect, it } from 'vitest'
import {
  normalizeRuntimeLabel,
  runtimeLabelForResolutionSource,
} from './runtime-label.mjs'

describe('desktop runtime label', () => {
  it('labels explicit local binaries separately from downloaded development runtimes', () => {
    expect(runtimeLabelForResolutionSource('explicit')).toBe('local-runtime')
    expect(runtimeLabelForResolutionSource('cache')).toBe('dev-runtime')
    expect(runtimeLabelForResolutionSource('download')).toBe('dev-runtime')
  })

  it('only exposes supported development labels', () => {
    expect(normalizeRuntimeLabel('local-runtime')).toBe('local-runtime')
    expect(normalizeRuntimeLabel('DEV-RUNTIME')).toBe('dev-runtime')
    expect(normalizeRuntimeLabel('production')).toBe('')
    expect(normalizeRuntimeLabel(undefined)).toBe('')
  })
})
