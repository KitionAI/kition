import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { relative, resolve } from 'node:path'

const dir = resolve(__dirname, '../../../public/onboarding')

describe('onboarding static assets', () => {
  it('manifest references files that all exist on disk', () => {
    const manifest = JSON.parse(readFileSync(resolve(dir, 'manifest.json'), 'utf8'))
    expect(manifest.version).toBe(18)
    expect(manifest.folder).toBe('Getting Started')
    expect(typeof manifest.welcome.filename).toBe('string')
    expect(manifest.welcome.asset).toBe('welcome.md')
    expect(existsSync(resolve(dir, manifest.welcome.asset))).toBe(true)
    expect(manifest.documents).toEqual([])
    expect(manifest.tables.map((table: { filename: string }) => table.filename)).toEqual([
      'Task Tracker.kitable',
      'YouTube & TikTok Thumbnail Generator.kitable',
      'Receipt OCR Database.kitable',
      'Email Inbox Sync.kitable',
      'Leads Landing Page.kitable',
      'SDR Cold Call Manager.kitable',
      'Product Launch Website.kitable',
      'Batch Product Designer.kitable',
      'Simple Client CRM.kitable',
      'Restaurant Operations.kitable',
      'Business Analytics Dashboard.kitable',
      'Project Gantt Planner.kitable',
    ])
    for (const table of manifest.tables) {
      const bytes = readFileSync(resolve(dir, table.asset))
      expect(bytes.subarray(0, 16).toString('utf8')).toBe('SQLite format 3\u0000')
      expect(bytes.byteLength).toBeGreaterThan(100_000)
      expect(typeof table.filename).toBe('string')
    }
    expect(manifest.images).toEqual([
      { asset: 'logo.png', filename: 'logo.png' },
    ])
    expect(existsSync(resolve(dir, manifest.images[0].asset))).toBe(true)
    expect(manifest.guides).toBeUndefined()
    expect(existsSync(resolve(dir, 'demos'))).toBe(false)
  })

  it('keeps the first-run root limited to product-facing entries', () => {
    const manifest = JSON.parse(readFileSync(resolve(dir, 'manifest.json'), 'utf8'))
    const rootEntries = new Set<string>([manifest.welcome.filename])
    for (const table of manifest.tables) {
      rootEntries.add(table.folder || table.filename)
    }
    for (const document of manifest.documents) {
      rootEntries.add(document.folder || document.filename)
    }
    if (manifest.guides?.folder) rootEntries.add(manifest.guides.folder)
    for (const image of manifest.images ?? []) rootEntries.add(image.filename)

    expect([...rootEntries].sort()).toEqual([
      'Batch Product Designer.kitable',
      'Business Analytics Dashboard.kitable',
      'Email Inbox Sync.kitable',
      'Leads Landing Page.kitable',
      'Product Launch Website.kitable',
      'Project Gantt Planner.kitable',
      'Receipt OCR Database.kitable',
      'Restaurant Operations.kitable',
      'SDR Cold Call Manager.kitable',
      'Simple Client CRM.kitable',
      'Task Tracker.kitable',
      'Welcome to Kition.md',
      'YouTube & TikTok Thumbnail Generator.kitable',
      'logo.png',
    ])
  })

  it('keeps every optional onboarding guide valid for on-demand import', () => {
    const manifest = JSON.parse(readFileSync(resolve(dir, 'guides.json'), 'utf8'))
    const referenced = new Set(['guides.json'])

    const receiptGuide = manifest.guides.find(
      (guide: { slug: string }) => guide.slug === 'receipt-extraction',
    )
    const emailGuide = manifest.guides.find(
      (guide: { slug: string }) => guide.slug === 'email-automation',
    )
    const webResearchGuide = manifest.guides.find(
      (guide: { slug: string }) => guide.slug === 'web-research',
    )
    expect(receiptGuide?.assets).toBeUndefined()
    expect(emailGuide?.tableFile).toBe('Inbox.kitable')
    expect(webResearchGuide).toEqual(expect.objectContaining({
      displayName: 'Web Research',
      intro: 'info.md',
      tableFile: null,
    }))
    const inboxTable = readFileSync(resolve(dir, 'email-automation/Inbox.kitable'))
    expect(inboxTable.subarray(0, 16).toString('utf8')).toBe('SQLite format 3\u0000')
    expect(inboxTable.byteLength).toBeGreaterThan(100_000)
    expect(manifest.guides.map((guide: { displayName: string }) => guide.displayName)).toEqual([
      'Email Automation',
      'Lead Automation',
      'Receipt Extraction',
      'Product Content',
      'Web Research',
    ])

    for (const guide of manifest.guides) {
      expect(guide.slug.toLowerCase()).not.toContain('case')
      expect(guide.displayName.toLowerCase()).not.toContain('case')
      referenced.add(`${guide.slug}/${guide.intro}`)
      expect(guide.seeds).toEqual([])
      expect(existsSync(resolve(dir, guide.slug, 'seeds'))).toBe(false)
      if (guide.tableFile) referenced.add(`${guide.slug}/${guide.tableFile}`)
      for (const seed of guide.seeds) referenced.add(`${guide.slug}/seeds/${seed}`)
      for (const asset of guide.assets ?? []) referenced.add(`${guide.slug}/assets/${asset}`)
    }

    const guideSlugs = new Set(manifest.guides.map((guide: { slug: string }) => guide.slug))
    const actual = readdirSync(dir, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => relative(dir, resolve(entry.parentPath, entry.name)))
      .filter((path) => path === 'guides.json' || guideSlugs.has(path.split('/')[0]))

    expect(actual.sort()).toEqual([...referenced].sort())
  })

  it('ships a rich English welcome guide focused on the starter files', () => {
    const english = readFileSync(resolve(dir, 'welcome.md'), 'utf8')
    expect(english).toContain('# Welcome to Kition')
    expect(english).toContain('![Kition](logo.png)')
    expect(english).toContain('```mermaid')
    expect(english).toContain('V_n = V_0(1 + r)^n')
    expect(english).toContain('Template Center')
    expect(english).toContain('Receipt OCR Database')
    expect(english).toContain('[[Restaurant Operations.kitable]]')
    expect(english).toContain('Settings > Onboarding Guides')
    expect(english).toContain('```text')
    expect(english).toContain('| Capability | What it means | What to try |')
    expect(english).toContain('> [!tip]')
    expect(english).toContain('> [!note]')
    expect(english).toContain('- [ ] Edit this page and save it.')
    expect(english.split('\n').length).toBeGreaterThan(100)
    expect(english).not.toContain('Contact Directory')
    expect(english).toContain('[[Task Tracker.kitable]]')
    expect(english).not.toContain('Workflow Examples/')
    expect(english).not.toContain('Guides/Email Automation/')

    expect(readdirSync(dir).filter((name) => /^welcome\..+\.md$/.test(name))).toEqual([])
    const emailAutomation = readFileSync(resolve(dir, 'email-automation/intro.md'), 'utf8')
    expect(emailAutomation).toContain('# Email Automation')
    expect(emailAutomation).toContain('Getting Started/Guides/Email Automation/Inbox.kitable')
    expect(emailAutomation).toContain('imap.163.com')
    expect(emailAutomation).toContain('Select the **Document** value')
    expect(emailAutomation).toContain('`Scheduled trigger` followed by `Sync email inbox`')

    const webResearch = readFileSync(resolve(dir, 'web-research/info.md'), 'utf8')
    expect(webResearch).toContain('# Web Research')
    expect(webResearch).toContain('Open youtube.com in the built-in browser')
    expect(webResearch).toContain('Replace them to reuse the same flow with another site')
    expect(webResearch).toContain('every browser task writes a table')
  })
})
