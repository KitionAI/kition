   
                 
  
                                                  
                               
                                                                                                 
                                                    
  
                                
   

import { EditorSelection } from '@codemirror/state'
import type { EditorView } from '@codemirror/view'

import { readWorkspaceDocument } from '@/services/desktop'

import { loadVaultMarkdownFiles } from './vault-files'

const TEMPLATE_DIR_PREFIX = 'Templates/'

export type TemplateEntry = {
  path: string
  name: string
}

function pad(n: number, w = 2): string {
  return n.toString().padStart(w, '0')
}

function renderPlaceholders(body: string, title: string): string {
  const now = new Date()
  const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
  const time = `${pad(now.getHours())}:${pad(now.getMinutes())}`
  return body
    .replace(/\{\{date\}\}/g, date)
    .replace(/\{\{time\}\}/g, time)
    .replace(/\{\{title\}\}/g, title)
}

export async function listTemplates(): Promise<TemplateEntry[]> {
  const files = await loadVaultMarkdownFiles()
  return files
    .filter((f) => f.path.startsWith(TEMPLATE_DIR_PREFIX))
    .map((f) => ({ path: f.path, name: f.name.replace(/\.md$/i, '') }))
    .sort((a, b) => a.name.localeCompare(b.name))
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
  const rendered = renderPlaceholders(body, title)
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
