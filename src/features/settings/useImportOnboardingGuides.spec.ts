import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  importOnboardingGuide,
  onboardingGuideFolderExists,
  type ImportDeps,
  type OnboardingGuide,
} from './useImportOnboardingGuides'
import { ONBOARDING_GUIDE_BASE } from '@/features/onboarding/onboardingGuideManifest'

vi.mock('@/services/desktop', () => ({
  createWorkspaceFolder: vi.fn(async () => ({ root_path: '', items: [], created_path: 'ok' })),
  importWorkspaceFile: vi.fn(async () => ({ root_path: '', items: [], imported_path: 'ok' })),
  listWorkspaceDocuments: vi.fn(async () => ({ root_path: '', items: [] })),
  writeWorkspaceDocument: vi.fn(async () => ({
    path: 'ok', name: 'ok', content: '', format: 'markdown', updated_at: '', size: 0,
  })),
}))

import {
  createWorkspaceFolder,
  importWorkspaceFile,
  writeWorkspaceDocument,
} from '@/services/desktop'

const sampleGuide: OnboardingGuide = {
  slug: 'lead-automation',
  displayName: 'Lead Automation',
  summary: 'Build a workflow from a prompt.',
  intro: 'intro.md',
  seeds: ['orders.csv', 'prompts.md'],
  assets: ['reference.jpg'],
  tableFile: 'Lead Follow-up.kitable',
}

describe('onboardingGuideFolderExists', () => {
  it('returns false on an empty workspace', () => {
    expect(onboardingGuideFolderExists([], sampleGuide.displayName)).toBe(false)
  })

  it('finds a guide under Getting Started/Guides', () => {
    const items = [{
      path: 'Getting Started',
      name: 'Getting Started',
      type: 'folder' as const,
      children: [{
        path: 'Getting Started/Guides',
        name: 'Guides',
        type: 'folder' as const,
        children: [{
          path: 'Getting Started/Guides/Lead Automation',
          name: 'Lead Automation',
          type: 'folder' as const,
        }],
      }],
    }]

    expect(onboardingGuideFolderExists(items, sampleGuide.displayName)).toBe(true)
  })

  it('ignores a same-named folder outside Getting Started', () => {
    const items = [{
      path: 'Projects/Lead Automation',
      name: 'Lead Automation',
      type: 'folder' as const,
    }]

    expect(onboardingGuideFolderExists(items, sampleGuide.displayName)).toBe(false)
  })
})

describe('importOnboardingGuide', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  const deps: ImportDeps = {
    fetchText: vi.fn(async (url) => `markdown for ${url}`),
    fetchBinary: vi.fn(async () => new Uint8Array([0xff, 0xd8, 0xff, 0xe0])),
  }

  it('creates the guide under Getting Started/Guides and imports every file', async () => {
    await importOnboardingGuide(ONBOARDING_GUIDE_BASE, sampleGuide, deps)

    expect(createWorkspaceFolder).toHaveBeenNthCalledWith(1, {
      parent_folder: '',
      name: 'Getting Started',
    })
    expect(createWorkspaceFolder).toHaveBeenNthCalledWith(2, {
      parent_folder: 'Getting Started',
      name: 'Guides',
    })
    expect(createWorkspaceFolder).toHaveBeenNthCalledWith(3, {
      parent_folder: 'Getting Started/Guides',
      name: 'Lead Automation',
    })
    expect(createWorkspaceFolder).toHaveBeenNthCalledWith(4, {
      parent_folder: 'Getting Started/Guides/Lead Automation',
      name: 'seeds',
    })
    expect(createWorkspaceFolder).toHaveBeenNthCalledWith(5, {
      parent_folder: 'Getting Started/Guides/Lead Automation',
      name: 'assets',
    })

    expect(writeWorkspaceDocument).toHaveBeenCalledWith(
      'Getting Started/Guides/Lead Automation/intro.md',
      'markdown for /onboarding/lead-automation/intro.md',
    )

    expect(importWorkspaceFile).toHaveBeenCalledTimes(4)
    const importCalls = (importWorkspaceFile as ReturnType<typeof vi.fn>).mock.calls
    const byFilename = new Map<string, { folder: string; hasContent: boolean }>()
    for (const call of importCalls) {
      byFilename.set(call[0].filename, {
        folder: call[0].folder,
        hasContent: typeof call[0].base64_content === 'string' && call[0].base64_content.length > 0,
      })
    }
    expect([...byFilename.keys()].sort()).toEqual([
      'Lead Follow-up.kitable', 'orders.csv', 'prompts.md', 'reference.jpg',
    ])
    for (const seed of ['orders.csv', 'prompts.md']) {
      expect(byFilename.get(seed)).toEqual({
        folder: 'Getting Started/Guides/Lead Automation/seeds',
        hasContent: true,
      })
    }
    expect(byFilename.get('Lead Follow-up.kitable')).toEqual({
      folder: 'Getting Started/Guides/Lead Automation',
      hasContent: true,
    })
    expect(byFilename.get('reference.jpg')).toEqual({
      folder: 'Getting Started/Guides/Lead Automation/assets',
      hasContent: true,
    })
  })

  it('skips the table-file import when the guide has none', async () => {
    await importOnboardingGuide(ONBOARDING_GUIDE_BASE, { ...sampleGuide, tableFile: null }, deps)

    const filenames = (importWorkspaceFile as ReturnType<typeof vi.fn>).mock.calls
      .map((call) => call[0].filename)
    expect(filenames).not.toContain('Lead Follow-up.kitable')
    expect(importWorkspaceFile).toHaveBeenCalledTimes(3)
  })

  it('skips optional folders when a guide has no seeds or assets', async () => {
    await importOnboardingGuide(
      ONBOARDING_GUIDE_BASE,
      { ...sampleGuide, seeds: [], assets: [] },
      deps,
    )

    const calls = (createWorkspaceFolder as ReturnType<typeof vi.fn>).mock.calls
    expect(calls).toHaveLength(3)
    expect(calls.map((call) => call[0].name)).toEqual([
      'Getting Started',
      'Guides',
      'Lead Automation',
    ])
  })

  it('rejects when a file fetch fails', async () => {
    const failingDeps: ImportDeps = {
      fetchText: vi.fn(async () => 'md'),
      fetchBinary: vi.fn(async () => { throw new Error('boom') }),
    }

    await expect(
      importOnboardingGuide(ONBOARDING_GUIDE_BASE, sampleGuide, failingDeps),
    ).rejects.toThrow(/boom/)
  })
})
