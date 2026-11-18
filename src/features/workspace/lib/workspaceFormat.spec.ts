import { expect, it } from 'vitest'
import { inferWorkspaceItemFormat } from './workspace'

it('reads .md and .markdown as notes, and a file of no known kind as binary, as the desktop shell does', () => {
  expect(inferWorkspaceItemFormat('notes/Plan.md')).toBe('markdown')
  expect(inferWorkspaceItemFormat('Readme.MARKDOWN')).toBe('markdown')
  for (const path of ['archive.zip', 'data.bin', 'Makefile', 'notes/.hidden']) expect(inferWorkspaceItemFormat(path), path).toBe('binary')
})
