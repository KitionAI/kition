import { describe, expect, it } from 'vitest'

import { getWorkspaceTabKit, type WorkspaceTab } from './workspace'

const tab = (fields: Record<string, unknown>) => ({ id: 't', title: 'T', path: '/w/x', ...fields }) as unknown as WorkspaceTab

describe('getWorkspaceTabKit', () => {
  it('names the kit that owns a file viewer tab', () => {
    expect(getWorkspaceTabKit(tab({ type: 'file-viewer', format: 'xlsx' }))).toBe('sheet')
    expect(getWorkspaceTabKit(tab({ type: 'file-viewer', format: 'design' }))).toBe('design')
    expect(getWorkspaceTabKit(tab({ type: 'file-viewer', format: 'board' }))).toBe('board')
  })

  it('names Kition’s own editors', () => {
    expect(getWorkspaceTabKit(tab({ type: 'file-viewer', format: 'markdown' }))).toBe('note')
    expect(getWorkspaceTabKit(tab({ type: 'workflow', tablePath: '/w/a.ktable' }))).toBe('table')
  })

  it('has no kit for plain files and tools', () => {
    expect(getWorkspaceTabKit(tab({ type: 'file-viewer', format: 'image' }))).toBeNull()
    expect(getWorkspaceTabKit(tab({ type: 'gallery', kind: 'images' }))).toBeNull()
    expect(getWorkspaceTabKit(tab({ type: 'workflow' }))).toBeNull()
  })
})
