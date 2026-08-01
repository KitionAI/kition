import { describe, expect, it, vi } from 'vitest'
import type { WorkspaceDocumentListResponse, WorkspaceDocumentTreeItem } from '@/services/desktop'
import { reconcileOnboardingWelcome, type ReconcileOnboardingWelcomeDeps } from './reconcileOnboardingWelcome'

function workspace(items: WorkspaceDocumentTreeItem[]): WorkspaceDocumentListResponse {
  return { root_path: '/workspace', items }
}

function makeDeps(overrides: Partial<ReconcileOnboardingWelcomeDeps> = {}): ReconcileOnboardingWelcomeDeps {
  return {
    listDocuments: vi.fn(async () => workspace([])),
    moveDocument: vi.fn(async () => ({
      path: 'Getting Started/Welcome to Kition.md',
      name: 'Welcome to Kition.md',
      content: '',
    })),
    readDocument: vi.fn(async (path: string) => ({
      path,
      name: 'Welcome to Kition.md',
      content: '![Kition](Getting Started/logo.png)\n\n# Welcome to Kition',
    })),
    writeDocument: vi.fn(async (path: string, content: string) => ({
      path,
      name: 'Welcome to Kition.md',
      content,
    })),
    ...overrides,
  }
}

describe('reconcileOnboardingWelcome', () => {
  it('moves the legacy root guide and makes the logo path relative', async () => {
    const deps = makeDeps({
      listDocuments: vi.fn(async () => workspace([
        { type: 'folder', path: 'Getting Started', name: 'Getting Started', children: [] },
        { type: 'file', path: 'Welcome to Kition.md', name: 'Welcome to Kition.md', format: 'markdown' },
      ])),
    })

    await expect(reconcileOnboardingWelcome(deps))
      .resolves.toBe('Getting Started/Welcome to Kition.md')
    expect(deps.moveDocument).toHaveBeenCalledWith({
      path: 'Welcome to Kition.md',
      target_folder: 'Getting Started',
    })
    expect(deps.writeDocument).toHaveBeenCalledWith(
      'Getting Started/Welcome to Kition.md',
      '![Kition](logo.png)\n\n# Welcome to Kition',
    )
  })

  it('repairs an existing nested guide without moving it', async () => {
    const deps = makeDeps({
      listDocuments: vi.fn(async () => workspace([{
        type: 'folder',
        path: 'Getting Started',
        name: 'Getting Started',
        children: [{
          type: 'file',
          path: 'Getting Started/Welcome to Kition.md',
          name: 'Welcome to Kition.md',
          format: 'markdown',
        }],
      }])),
    })

    await expect(reconcileOnboardingWelcome(deps))
      .resolves.toBe('Getting Started/Welcome to Kition.md')
    expect(deps.moveDocument).not.toHaveBeenCalled()
    expect(deps.writeDocument).toHaveBeenCalled()
  })

  it('leaves unrelated workspaces unchanged', async () => {
    const deps = makeDeps()

    await expect(reconcileOnboardingWelcome(deps)).resolves.toBe('')
    expect(deps.moveDocument).not.toHaveBeenCalled()
    expect(deps.readDocument).not.toHaveBeenCalled()
  })

  it('does not move a user-owned root document with the same filename', async () => {
    const deps = makeDeps({
      listDocuments: vi.fn(async () => workspace([
        { type: 'file', path: 'Welcome to Kition.md', name: 'Welcome to Kition.md', format: 'markdown' },
      ])),
      readDocument: vi.fn(async () => ({
        path: 'Welcome to Kition.md',
        name: 'Welcome to Kition.md',
        content: '# Team welcome',
      })),
    })

    await expect(reconcileOnboardingWelcome(deps)).resolves.toBe('')
    expect(deps.moveDocument).not.toHaveBeenCalled()
  })
})
