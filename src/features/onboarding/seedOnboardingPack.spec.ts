import { describe, it, expect, vi } from 'vitest'
import { seedOnboardingPack, type SeedDeps } from './seedOnboardingPack'
import type { OnboardingManifest } from './onboardingManifest'
import type { OnboardingGuideManifest } from './onboardingGuideManifest'

const guideManifest: OnboardingGuideManifest = {
  version: 1,
  guides: [
    {
      slug: 'lead-workflow',
      displayName: 'Lead workflow',
      summary: 'Build a workflow from a prompt.',
      intro: 'info.md',
      seeds: ['leads.csv'],
      assets: ['reference.jpg'],
      tableFile: 'Lead Follow-up.kitable',
    },
  ],
}

const manifest: OnboardingManifest = {
  version: 1,
  folder: 'Getting Started',
  welcome: {
    filename: 'Welcome to Kition.md',
    asset: 'welcome.md',
    folder: '',
  },
  documents: [
    { asset: 'email-setup.md', filename: 'Email Setup.md', folder: 'Guides' },
  ],
  tables: [
    { asset: 'TaskTracker.kitable', filename: 'Task Tracker.kitable', folder: 'Essentials' },
    { asset: 'ReadingTracker.kitable', filename: 'Reading Tracker.kitable', folder: 'Essentials' },
  ],
  guides: { manifest: 'guides.json', folder: 'Guides' },
}

function makeDeps(overrides: Partial<SeedDeps> = {}): SeedDeps {
  return {
    fetchText: vi.fn(async (url: string) => {
      if (url === '/onboarding/manifest.json') return JSON.stringify(manifest)
      if (url === '/onboarding/guides.json') return JSON.stringify(guideManifest)
      return '# hi'
    }),
    fetchBinary: vi.fn(async () => new Uint8Array([1, 2, 3])),
    createFolder: vi.fn(async () => {}),
    writeDocument: vi.fn(async () => {}),
    importFile: vi.fn(async () => {}),
    ...overrides,
  }
}

describe('seedOnboardingPack', () => {
  it('creates product folders, writes English documents, and imports each table', async () => {
    const deps = makeDeps()
    const welcomePath = await seedOnboardingPack(deps)

    expect(deps.createFolder).toHaveBeenCalledWith({ parent_folder: '', name: 'Getting Started' })
    expect(deps.writeDocument).toHaveBeenCalledWith('Welcome to Kition.md', '# hi')
    expect(deps.writeDocument).toHaveBeenCalledWith('Getting Started/Guides/Email Setup.md', '# hi')
    expect(deps.importFile).toHaveBeenCalledTimes(5)
    expect(deps.importFile).toHaveBeenCalledWith(
      expect.objectContaining({ folder: 'Getting Started/Essentials', filename: 'Task Tracker.kitable' }),
    )
    expect(deps.importFile).toHaveBeenCalledWith(
      expect.objectContaining({ folder: 'Getting Started/Essentials', filename: 'Reading Tracker.kitable' }),
    )
    expect(deps.createFolder).toHaveBeenCalledWith({
      parent_folder: 'Getting Started/Guides',
      name: 'Lead workflow',
    })
    expect(deps.writeDocument).toHaveBeenCalledWith(
      'Getting Started/Guides/Lead workflow/info.md',
      '# hi',
    )
    expect(deps.importFile).toHaveBeenCalledWith(expect.objectContaining({
      folder: 'Getting Started/Guides/Lead workflow/assets',
      filename: 'reference.jpg',
    }))
    expect(welcomePath).toBe('Welcome to Kition.md')
  })

  it('fetches the single English welcome body and document assets', async () => {
    const fetchText = vi.fn(async (url: string) => {
      if (url === '/onboarding/manifest.json') return JSON.stringify(manifest)
      if (url === '/onboarding/guides.json') return JSON.stringify(guideManifest)
      return '# Hello'
    })
    const deps = makeDeps({ fetchText })
    await seedOnboardingPack(deps)

    expect(fetchText).toHaveBeenCalledWith('/onboarding/welcome.md')
    expect(fetchText).toHaveBeenCalledWith('/onboarding/email-setup.md')
    expect(deps.writeDocument).toHaveBeenCalledWith('Welcome to Kition.md', '# Hello')
  })
})
