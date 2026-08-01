import { describe, it, expect, vi, beforeEach } from 'vitest'
import { maybeSeedOnboardingPack, type FirstRunDeps } from './maybeSeedOnboardingPack'

function makeDeps(overrides: Partial<FirstRunDeps> = {}): FirstRunDeps {
  return {
    listDocuments: vi.fn(async () => ({ items: [] as unknown[] })),
    seed: vi.fn(async () => 'Getting Started/Welcome to Kition.md'),
    isSeeded: vi.fn(() => false),
    markSeeded: vi.fn(),
    ...overrides,
  }
}

describe('maybeSeedOnboardingPack', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('seeds and marks when the workspace is empty and unseeded, returning the welcome path', async () => {
    const deps = makeDeps()
    const welcomePath = await maybeSeedOnboardingPack('/workspace/a', deps)
    expect(deps.seed).toHaveBeenCalledWith()
    expect(deps.markSeeded).toHaveBeenCalledWith('/workspace/a')
    expect(welcomePath).toBe('Getting Started/Welcome to Kition.md')
  })

  it('marks without seeding and returns empty when the workspace already has content', async () => {
    const deps = makeDeps({ listDocuments: vi.fn(async () => ({ items: [{}] })) })
    const welcomePath = await maybeSeedOnboardingPack('/workspace/b', deps)
    expect(deps.seed).not.toHaveBeenCalled()
    expect(deps.markSeeded).toHaveBeenCalledWith('/workspace/b')
    expect(welcomePath).toBe('')
  })

  it('does nothing and returns empty when already marked seeded', async () => {
    const deps = makeDeps({ isSeeded: vi.fn(() => true) })
    const welcomePath = await maybeSeedOnboardingPack('/workspace/c', deps)
    expect(deps.listDocuments).not.toHaveBeenCalled()
    expect(deps.seed).not.toHaveBeenCalled()
    expect(welcomePath).toBe('')
  })

  it('does not mark seeded when seeding fails, and rethrows', async () => {
    const deps = makeDeps({ seed: vi.fn(async () => { throw new Error('boom') }) })
    await expect(maybeSeedOnboardingPack('/workspace/d', deps)).rejects.toThrow('boom')
    expect(deps.markSeeded).not.toHaveBeenCalled()
  })
})
