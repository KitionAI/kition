import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { relative, resolve } from 'node:path'

const dir = resolve(__dirname, '../../../public/onboarding')

describe('onboarding static assets', () => {
  it('manifest references files that all exist on disk', () => {
    const manifest = JSON.parse(readFileSync(resolve(dir, 'manifest.json'), 'utf8'))
    expect(manifest.version).toBe(14)
    expect(manifest.folder).toBe('Getting Started')
    expect(typeof manifest.welcome.filename).toBe('string')
    expect(manifest.welcome.asset).toBe('welcome.md')
    expect(existsSync(resolve(dir, manifest.welcome.asset))).toBe(true)
    expect(manifest.documents).toEqual([])
    expect(manifest.tables.map((table: { filename: string; folder: string }) => [table.folder, table.filename])).toEqual([
      ['Essentials', 'Task Tracker.kitable'],
      ['Essentials', 'Reading Tracker.kitable'],
      ['Essentials', 'Contact Directory.kitable'],
      ['Workflow Examples', 'Content Pipeline.kitable'],
      ['Workflow Examples', 'Expense Review.kitable'],
      ['Workflow Examples', 'Order Fulfillment.kitable'],
    ])
    for (const table of manifest.tables) {
      expect(existsSync(resolve(dir, table.asset))).toBe(true)
      expect(typeof table.filename).toBe('string')
    }
    expect(manifest.images).toEqual([
      { asset: 'logo.png', filename: 'logo.png' },
    ])
    expect(existsSync(resolve(dir, manifest.images[0].asset))).toBe(true)
    expect(manifest.guides).toEqual({ manifest: 'guides.json', folder: 'Guides' })
    expect(existsSync(resolve(dir, manifest.guides.manifest))).toBe(true)
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
      'Essentials',
      'Guides',
      'Welcome to Kition.md',
      'Workflow Examples',
      'logo.png',
    ])
  })

  it('lists every onboarding guide directly under the onboarding root', () => {
    const manifest = JSON.parse(readFileSync(resolve(dir, 'guides.json'), 'utf8'))
    const referenced = new Set(['guides.json'])

    const receiptGuide = manifest.guides.find(
      (guide: { slug: string }) => guide.slug === 'receipt-extraction',
    )
    const emailGuide = manifest.guides.find(
      (guide: { slug: string }) => guide.slug === 'email-automation',
    )
    expect(receiptGuide?.assets).toBeUndefined()
    expect(emailGuide?.tableFile).toBe('Inbox.kitable')
    const inboxTable = readFileSync(resolve(dir, 'email-automation/Inbox.kitable'))
    expect(inboxTable.subarray(0, 16).toString('utf8')).toBe('SQLite format 3\u0000')
    expect(inboxTable.byteLength).toBeGreaterThan(100_000)
    expect(manifest.guides.map((guide: { displayName: string }) => guide.displayName)).toEqual([
      'Email Automation',
      'Lead Automation',
      'Receipt Extraction',
      'Product Content',
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

  it('ships a rich English welcome guide with a complete onboarding directory index', () => {
    const english = readFileSync(resolve(dir, 'welcome.md'), 'utf8')
    expect(english).toContain('![Kition](logo.png)')
    expect(english).toContain('```mermaid')
    expect(english).toContain('V_n = V_0(1 + r)^n')
    expect(english).toContain('| Included table | What to explore | Included pattern |')
    expect(english).toContain('## Getting Started directory')
    expect(english).toContain('> [!tip]')
    expect(english).toContain('> [!note]')
    expect(english.split('\n').length).toBeGreaterThan(150)

    for (const value of [
      'Essentials/Task Tracker.kitable',
      'Essentials/Reading Tracker.kitable',
      'Essentials/Contact Directory.kitable',
      'Workflow Examples/Content Pipeline.kitable',
      'Workflow Examples/Expense Review.kitable',
      'Workflow Examples/Order Fulfillment.kitable',
      'Guides/Email Automation/Inbox.kitable',
      'Guides/Lead Automation/Lead Follow-up.kitable',
      'Guides/Email Automation/intro.md',
      'Guides/Receipt Extraction/Receipt Archive.kitable',
      'Guides/Product Content/Product Content Studio.kitable',
    ]) {
      expect(english).toContain(value)
    }

    expect(readdirSync(dir).filter((name) => /^welcome\..+\.md$/.test(name))).toEqual([])
    const emailAutomation = readFileSync(resolve(dir, 'email-automation/intro.md'), 'utf8')
    expect(emailAutomation).toContain('# Email Automation')
    expect(emailAutomation).toContain('Getting Started/Guides/Email Automation/Inbox.kitable')
    expect(emailAutomation).toContain('imap.163.com')
    expect(emailAutomation).toContain('Select the **Document** value')
    expect(emailAutomation).toContain('`Scheduled trigger` followed by `Sync email inbox`')
  })
})
