import { describe, expect, it } from 'vitest'

import {
  inferWorkspaceDocumentFormat,
  isEditableWorkspaceDocument,
  isSupportedWorkspaceDocument,
  isTextWorkspaceDocument,
} from './workspace-document-formats.mjs'

describe('workspace document formats', () => {
  it('treats .kiboard as a supported editable text document', () => {
    expect(inferWorkspaceDocumentFormat('Planning/Product.kiboard')).toBe('board')
    expect(isSupportedWorkspaceDocument('Planning/Product.kiboard')).toBe(true)
    expect(isTextWorkspaceDocument('Planning/Product.kiboard')).toBe(true)
    expect(isEditableWorkspaceDocument('Planning/Product.kiboard')).toBe(true)
  })

  it('keeps unsupported executable files outside the workspace document boundary', () => {
    expect(inferWorkspaceDocumentFormat('tool.bin')).toBe('binary')
    expect(isSupportedWorkspaceDocument('tool.bin')).toBe(false)
    expect(isTextWorkspaceDocument('tool.bin')).toBe(false)
    expect(isEditableWorkspaceDocument('tool.bin')).toBe(false)
  })
})

it('recognizes native Design as an editable, supported text document', () => {
  expect(inferWorkspaceDocumentFormat('Posters/Launch.KIDESIGN')).toBe('design')
  expect(isEditableWorkspaceDocument('Posters/Launch.kidesign')).toBe(true)
  expect(isTextWorkspaceDocument('Posters/Launch.kidesign')).toBe(true)
  expect(isSupportedWorkspaceDocument('Posters/Launch.kidesign')).toBe(true)
})
