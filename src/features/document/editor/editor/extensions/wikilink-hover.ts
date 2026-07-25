   
                         
  
                                                        
                                        
  
                               
   

import { hoverTooltip } from '@codemirror/view'
import i18next from 'i18next'

import { readWorkspaceDocument } from '@/services/desktop'

import { parseWikilinks } from '../../lib/wikilink-parser'
import { loadVaultMarkdownFiles } from '../../vault/vault-files'

const CACHE_TTL_MS = 30_000
const MAX_PREVIEW_LENGTH = 240

type CacheEntry = { content: string; expiresAt: number }
const cache = new Map<string, CacheEntry>()

                                                     
                                               
if (typeof window !== 'undefined') {
  window.addEventListener('kition:workspace-reload', () => {
    cache.clear()
  })
}

async function getPreview(target: string): Promise<{ ok: true; path: string; preview: string } | { ok: false; reason: string }> {
  const lowered = target.toLowerCase().replace(/\.md$/i, '')
  const files = await loadVaultMarkdownFiles()
  let path: string | undefined
  for (const f of files) {
    const lp = f.path.toLowerCase().replace(/\.md$/i, '')
    const base = (f.path.split('/').pop() ?? '').toLowerCase().replace(/\.md$/i, '')
    if (lp === lowered || base === lowered) {
      path = f.path
      break
    }
  }
  if (!path) return { ok: false, reason: i18next.getFixedT(null, 'document')('editor.extensions.wikilink.unresolved') }
  const cached = cache.get(path)
  if (cached && cached.expiresAt > Date.now()) {
    return { ok: true, path, preview: cached.content }
  }
  try {
    const doc = await readWorkspaceDocument(path)
    const content = (doc.content ?? '').trim()
                            
    let body = content
    if (body.startsWith('---')) {
      const end = body.indexOf('\n---', 3)
      if (end > 0) body = body.slice(end + 4).trimStart()
    }
    const preview = body.length > MAX_PREVIEW_LENGTH
      ? body.slice(0, MAX_PREVIEW_LENGTH - 1) + '…'
      : body
    cache.set(path, { content: preview, expiresAt: Date.now() + CACHE_TTL_MS })
    return { ok: true, path, preview }
  } catch (e) {
    return { ok: false, reason: String((e as Error)?.message ?? e) }
  }
}

export function wikilinkHoverPreviewExtension() {
  return hoverTooltip((view, pos, _side) => {
    const line = view.state.doc.lineAt(pos)
    const links = parseWikilinks(line.text)
    const relInLine = pos - line.from
    const hit = links.find((l) => !l.embed && relInLine >= l.from && relInLine <= l.to)
    if (!hit) return null
    return {
      pos: line.from + hit.from,
      end: line.from + hit.to,
      above: true,
      create: () => {
        const t = i18next.getFixedT(null, 'document')
        const dom = document.createElement('div')
        dom.className = 'cm-wikilink-preview'
        dom.style.cssText = [
          'max-width: 360px',
          'padding: 8px 10px',
          'border-radius: 6px',
          'background: var(--popover, rgba(0,0,0,0.9))',
          'color: var(--popover-foreground, white)',
          'font-size: 12px',
          'line-height: 1.45',
          'white-space: pre-wrap',
          'box-shadow: 0 4px 18px rgba(0,0,0,0.18)',
        ].join(';')
        dom.textContent = t('editor.extensions.wikilink.loading', { target: hit.target })
        void getPreview(hit.target).then((res) => {
          if (res.ok === false) {
            dom.textContent = `[[${hit.target}]] ${res.reason}`
            dom.style.fontStyle = 'italic'
            dom.style.opacity = '0.8'
            return
          }
          const meta = document.createElement('div')
          meta.style.cssText = 'opacity:0.7; font-size:10px; margin-bottom:4px;'
          meta.textContent = res.path
          const body = document.createElement('div')
          body.textContent = res.preview || t('editor.extensions.wikilink.emptyDoc')
          dom.replaceChildren(meta, body)
        })
        return { dom }
      },
    }
  }, { hideOn: () => false })
}
