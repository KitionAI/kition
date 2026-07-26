import { describe, expect, it, vi } from 'vitest'
import type { WorkspaceDocumentTreeItem } from '@/services/desktop'
import {
  EMAIL_AUTOMATION_TABLE_PATH,
  WEB_RESEARCH_INFO_PATH,
  upgradeOnboardingPack,
} from './upgradeOnboardingPack'

function folder(path: string, children: WorkspaceDocumentTreeItem[] = []): WorkspaceDocumentTreeItem {
  return { type: 'folder', path, name: path.split('/').pop() || path, children }
}

function file(path: string, format: 'table' | 'markdown' = 'table'): WorkspaceDocumentTreeItem {
  return { type: 'file', path, name: path.split('/').pop() || path, format }
}

function makeDeps(items: WorkspaceDocumentTreeItem[]) {
  return {
    listDocuments: vi.fn(async () => ({ items })),
    fetchBinary: vi.fn(async () => new Uint8Array([1, 2, 3])),
    fetchText: vi.fn(async () => '# Web Research'),
    createFolder: vi.fn(async () => {}),
    importFile: vi.fn(async () => {}),
    writeDocument: vi.fn(async () => {}),
  }
}

describe('upgradeOnboardingPack', () => {
  it('adds the inbox table and Web Research guide to an existing onboarding pack', async () => {
    const deps = makeDeps([
      folder('Getting Started', [
        folder('Getting Started/Guides', [
          folder('Getting Started/Guides/Email Automation', [
            file('Getting Started/Guides/Email Automation/intro.md'),
          ]),
        ]),
      ]),
    ])

    await expect(upgradeOnboardingPack(deps)).resolves.toBe(EMAIL_AUTOMATION_TABLE_PATH)
    expect(deps.fetchBinary).toHaveBeenCalledWith('/onboarding/email-automation/Inbox.kitable')
    expect(deps.importFile).toHaveBeenCalledWith(expect.objectContaining({
      folder: 'Getting Started/Guides/Email Automation',
      filename: 'Inbox.kitable',
    }))
    expect(deps.createFolder).toHaveBeenCalledWith({
      parent_folder: 'Getting Started/Guides',
      name: 'Web Research',
    })
    expect(deps.fetchText).toHaveBeenCalledWith('/onboarding/web-research/info.md')
    expect(deps.writeDocument).toHaveBeenCalledWith(
      WEB_RESEARCH_INFO_PATH,
      '# Web Research',
    )
  })

  it('does not overwrite existing onboarding assets', async () => {
    const deps = makeDeps([
      folder('Getting Started', [
        folder('Getting Started/Guides', [
          folder('Getting Started/Guides/Email Automation', [file(EMAIL_AUTOMATION_TABLE_PATH)]),
          folder('Getting Started/Guides/Web Research', [
            file(WEB_RESEARCH_INFO_PATH, 'markdown'),
          ]),
        ]),
      ]),
    ])

    await expect(upgradeOnboardingPack(deps)).resolves.toBe('')
    expect(deps.fetchBinary).not.toHaveBeenCalled()
    expect(deps.fetchText).not.toHaveBeenCalled()
    expect(deps.createFolder).not.toHaveBeenCalled()
    expect(deps.importFile).not.toHaveBeenCalled()
    expect(deps.writeDocument).not.toHaveBeenCalled()
  })

  it('adds only the missing Web Research guide when the inbox table already exists', async () => {
    const deps = makeDeps([
      folder('Getting Started', [
        folder('Getting Started/Guides', [
          folder('Getting Started/Guides/Email Automation', [file(EMAIL_AUTOMATION_TABLE_PATH)]),
        ]),
      ]),
    ])

    await expect(upgradeOnboardingPack(deps)).resolves.toBe(WEB_RESEARCH_INFO_PATH)
    expect(deps.fetchBinary).not.toHaveBeenCalled()
    expect(deps.importFile).not.toHaveBeenCalled()
    expect(deps.createFolder).toHaveBeenCalledWith({
      parent_folder: 'Getting Started/Guides',
      name: 'Web Research',
    })
    expect(deps.writeDocument).toHaveBeenCalledWith(
      WEB_RESEARCH_INFO_PATH,
      '# Web Research',
    )
  })

  it('does not add starter content to an unrelated workspace', async () => {
    const deps = makeDeps([folder('Projects')])

    await expect(upgradeOnboardingPack(deps)).resolves.toBe('')
    expect(deps.fetchText).not.toHaveBeenCalled()
    expect(deps.createFolder).not.toHaveBeenCalled()
    expect(deps.importFile).not.toHaveBeenCalled()
    expect(deps.writeDocument).not.toHaveBeenCalled()
  })
})
