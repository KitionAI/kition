   
                 
  
                                                  
                               
                                                                                                 
                                                    
  
                                
   

import { EditorSelection } from '@codemirror/state'
import type { EditorView } from '@codemirror/view'

import { renderDocumentTemplatePlaceholders } from '@/features/document/lib/documentTemplates'
import { readWorkspaceDocument } from '@/services/desktop'

import { loadVaultMarkdownFiles } from './vault-files'

const TEMPLATE_DIR_PREFIX = 'Templates/'

export type TemplateEntry = {
  path: string
  name: string
}

export async function listTemplates(): Promise<TemplateEntry[]> {
  const files = await loadVaultMarkdownFiles()
  return files
    .filter((f) => f.path.startsWith(TEMPLATE_DIR_PREFIX))
    .map((f) => ({ path: f.path, name: f.name.replace(/\.md$/i, '') }))
    .sort((a, b) => a.name.localeCompare(b.name))
}

export async function loadTemplateContent(templatePath: string, title: string): Promise<string | null> {
  try {
    const document = await readWorkspaceDocument(templatePath)
    return renderDocumentTemplatePlaceholders(document.content ?? '', title).replace('{{cursor}}', '')
  } catch {
    return null
  }
}

export async function applyTemplate(view: EditorView, templatePath: string, currentPath?: string): Promise<boolean> {
  let body: string
  try {
    const doc = await readWorkspaceDocument(templatePath)
    body = doc.content ?? ''
  } catch {
    return false
  }
  const title = currentPath
    ? (currentPath.split('/').pop() ?? '').replace(/\.md$/i, '')
    : ''
  const rendered = renderDocumentTemplatePlaceholders(body, title)
  const cursorMarker = '{{cursor}}'
  const cursorIdx = rendered.indexOf(cursorMarker)
  const finalText = cursorIdx < 0 ? rendered : rendered.replace(cursorMarker, '')

  const sel = view.state.selection.main
  view.dispatch({
    changes: { from: sel.from, to: sel.to, insert: finalText },
    selection: EditorSelection.cursor(
      sel.from + (cursorIdx >= 0 ? cursorIdx : finalText.length),
    ),
  })
  view.focus()
  return true
}
