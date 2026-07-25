import { describe, it, expect, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import {
  invalidateVaultWikilinkResolver,
  matchWikilinkTarget,
  useVaultWikilinkResolver,
} from './useVaultWikilinkResolver'
import {
  clearVaultFileCache,
  loadVaultLinkableFiles,
} from '@/features/document/editor/vault/vault-files'

vi.mock('@/features/document/editor/vault/vault-files', () => {
  const filesByCall: any[][] = []
  let callIndex = 0
  return {
    loadVaultLinkableFiles: vi.fn(async () => {
      const next = filesByCall[Math.min(callIndex, filesByCall.length - 1)] ?? []
      callIndex += 1
      return next
    }),
                                                  
                                                      
    clearVaultFileCache: vi.fn(),
    pickRandomMarkdownFile: vi.fn(),
    __setVaultFilesByCall: (lists: any[][]) => {
      filesByCall.length = 0
      filesByCall.push(...lists)
      callIndex = 0
    },
  }
})

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const files = [
  { path: 'Notes/Test1.md' },
  { path: 'Folder/Other.md' },
  { path: 'subdir/note.md' },
]

describe('matchWikilinkTarget', () => {
  it('matches by basename, case-insensitive', () => {
    expect(matchWikilinkTarget(files, 'test1')).toBe('Notes/Test1.md')
    expect(matchWikilinkTarget(files, 'TEST1')).toBe('Notes/Test1.md')
  })

  it('matches by full path without .md', () => {
    expect(matchWikilinkTarget(files, 'notes/test1')).toBe('Notes/Test1.md')
  })

  it('accepts target with .md suffix', () => {
    expect(matchWikilinkTarget(files, 'Test1.md')).toBe('Notes/Test1.md')
  })

  it('matches a .kitable table by basename and full path', () => {
    const withTable = [...files, { path: 'Getting Started/Reading List.kitable' }]
    expect(matchWikilinkTarget(withTable, 'Reading List')).toBe('Getting Started/Reading List.kitable')
    expect(matchWikilinkTarget(withTable, 'Reading List.kitable')).toBe('Getting Started/Reading List.kitable')
    expect(matchWikilinkTarget(withTable, 'getting started/reading list')).toBe(
      'Getting Started/Reading List.kitable',
    )
  })

  it('resolves a path-qualified target relative to the current document', () => {
    const onboardingFiles = [
      { path: 'Getting Started/Welcome to Kition.md' },
      { path: 'Getting Started/Guides/Email Automation/Inbox.kitable' },
    ]
    expect(matchWikilinkTarget(
      onboardingFiles,
      'Guides/Email Automation/Inbox.kitable',
      'Getting Started/Welcome to Kition.md',
    )).toBe('Getting Started/Guides/Email Automation/Inbox.kitable')
  })

  it('prefers a same-folder basename match when a source path is available', () => {
    const duplicateFiles = [
      { path: 'Archive/Inbox.kitable' },
      { path: 'Projects/Inbox.kitable' },
    ]
    expect(matchWikilinkTarget(
      duplicateFiles,
      'Inbox.kitable',
      'Projects/Overview.md',
    )).toBe('Projects/Inbox.kitable')
  })

  it('keeps a leading slash anchored to the workspace root', () => {
    const rootedFiles = [
      { path: 'Inbox.kitable' },
      { path: 'Projects/Inbox.kitable' },
    ]
    expect(matchWikilinkTarget(
      rootedFiles,
      '/Inbox.kitable',
      'Projects/Overview.md',
    )).toBe('Inbox.kitable')
  })

  it('returns null when no match', () => {
    expect(matchWikilinkTarget(files, 'missing')).toBeNull()
  })

  it('prefers exact path over basename when both could match', () => {
    const more = [...files, { path: 'Test1.md' }]
                                                           
    expect(matchWikilinkTarget(more, 'test1')).toBe('Notes/Test1.md')
                  
    expect(matchWikilinkTarget(more, '/Test1')).toBe('Test1.md')
  })
})

describe('useVaultWikilinkResolver', () => {
                                                         
                                                                   
                                                           
  it('returns a referentially stable object across renders when store snapshot is unchanged', async () => {
    const snapshots: ReturnType<typeof useVaultWikilinkResolver>[] = []
    function Harness() {
      snapshots.push(useVaultWikilinkResolver())
      return null
    }

    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    await act(async () => {
      root.render(createElement(Harness))
    })
                                                        
                                                
    await act(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 0))
    })

    const baseline = snapshots.length
    await act(async () => {
      root.render(createElement(Harness))
    })
    await act(async () => {
      root.render(createElement(Harness))
    })

    const afterRerenders = snapshots.slice(baseline - 1)
    expect(afterRerenders.length).toBeGreaterThanOrEqual(3)
    const first = afterRerenders[0]
    for (const next of afterRerenders.slice(1)) {
      expect(next).toBe(first)
      expect(next.resolve).toBe(first.resolve)
      expect(next.resolvePath).toBe(first.resolvePath)
    }

    await act(async () => {
      root.unmount()
    })
    container.remove()
  })

                                                                          
                                                       
                                                          
                                                   
  it('re-fetches the vault file list when kition:workspace-reload fires (vault switch)', async () => {
    const vaultFiles = await import('@/features/document/editor/vault/vault-files') as any
    vaultFiles.__setVaultFilesByCall([
      [{ path: 'old-vault-only.md' }],
      [{ path: 'new-vault-only.md' }],
    ])
    ;(loadVaultLinkableFiles as any).mockClear?.()
    ;(clearVaultFileCache as any).mockClear?.()

                                                              
    invalidateVaultWikilinkResolver()
    await new Promise<void>((resolve) => setTimeout(resolve, 0))

    let lastResolve: ((t: string) => boolean) | null = null
    function Harness() {
      const r = useVaultWikilinkResolver()
      lastResolve = r.resolve
      return null
    }

    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    await act(async () => {
      root.render(createElement(Harness))
    })
    await act(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 0))
    })
    expect(lastResolve!('old-vault-only')).toBe(true)
    expect(lastResolve!('new-vault-only')).toBe(false)

    await act(async () => {
      window.dispatchEvent(new Event('kition:workspace-reload'))
      await new Promise<void>((resolve) => setTimeout(resolve, 0))
    })

    expect(clearVaultFileCache).toHaveBeenCalled()
    expect(lastResolve!('new-vault-only')).toBe(true)
    expect(lastResolve!('old-vault-only')).toBe(false)

    await act(async () => {
      root.unmount()
    })
    container.remove()
  })
})
