import { describe, expect, it, vi } from 'vitest'
import type { WorkspaceDocumentTreeItem } from '@/services/desktop'
import {
  EMAIL_AUTOMATION_TABLE_PATH,
  upgradeOnboardingPack,
} from './upgradeOnboardingPack'

function folder(path: string, children: WorkspaceDocumentTreeItem[] = []): WorkspaceDocumentTreeItem {
  return { type: 'folder', path, name: path.split('/').pop() || path, children }
}

function file(path: string): WorkspaceDocumentTreeItem {
  return { type: 'file', path, name: path.split('/').pop() || path, format: 'table' }
}

function makeDeps(items: WorkspaceDocumentTreeItem[]) {
  return {
    listDocuments: vi.fn(async () => ({ items })),
    fetchBinary: vi.fn(async () => new Uint8Array([1, 2, 3])),
    importFile: vi.fn(async () => {}),
  }
}

describe('upgradeOnboardingPack', () => {
  it('adds the inbox table to an existing Email Automation guide', async () => {
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
  })

  it('does not overwrite an existing inbox table', async () => {
    const deps = makeDeps([
      folder('Getting Started/Guides/Email Automation', [file(EMAIL_AUTOMATION_TABLE_PATH)]),
    ])

    await expect(upgradeOnboardingPack(deps)).resolves.toBe('')
    expect(deps.fetchBinary).not.toHaveBeenCalled()
    expect(deps.importFile).not.toHaveBeenCalled()
  })

  it('does not add starter content to an unrelated workspace', async () => {
    const deps = makeDeps([folder('Projects')])

    await expect(upgradeOnboardingPack(deps)).resolves.toBe('')
    expect(deps.importFile).not.toHaveBeenCalled()
  })
})
