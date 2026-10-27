import { FileImageIcon as FileImage, FileTextIcon as FileText, FileVideoCameraIcon as FileVideo2 } from '@kition/tessera-icons/react'
import { describe, expect, it } from 'vitest'
import { kitIconComponent } from '@/components/KitIcon'
import { getWorkspaceItemIcon, getWorkspaceItemKitIcon } from './workspace'

describe('getWorkspaceItemKitIcon', () => {
  it.each([
    ['markdown', 'note'],
    ['table', 'table'],
    ['table', 'table'],
    ['docx', 'doc'],
    ['xlsx', 'sheet'],
    ['csv', 'sheet'],
    ['pptx', 'slide'],
    ['slide', 'slide'],
    ['pdf', 'pdf'],
    ['design', 'design'],
    ['layout', 'layout'],
    ['board', 'board'],
    ['photo', 'photo'],
    ['film', 'film'],
    ['vector', 'vector'],
    ['effect', 'effect'],
    ['cad', 'cad'],
    ['html', 'html'],
    ['cube', 'cube'],
    ['fig', 'fig'],
  ] as const)('maps %s to the %s kit', (format, kit) => {
    expect(getWorkspaceItemKitIcon(format)).toBe(kit)
  })

  it.each(['image', 'video', 'audio', 'json', 'text', 'binary', undefined] as const)(
    'leaves %s without a kit',
    (format) => {
      expect(getWorkspaceItemKitIcon(format)).toBeNull()
    },
  )
})

describe('getWorkspaceItemIcon', () => {
  it('returns the small kit icon for kit formats', () => {
    expect(getWorkspaceItemIcon('pptx')).toBe(kitIconComponent('slide', { small: true }))
    expect(getWorkspaceItemIcon('markdown')).toBe(kitIconComponent('note', { small: true }))
    expect(getWorkspaceItemIcon('photo')).toBe(kitIconComponent('photo', { small: true }))
  })

  it('keeps Lucide icons for plain files', () => {
    expect(getWorkspaceItemIcon('image')).toBe(FileImage)
    expect(getWorkspaceItemIcon('video')).toBe(FileVideo2)
    expect(getWorkspaceItemIcon(undefined)).toBe(FileText)
  })
})
