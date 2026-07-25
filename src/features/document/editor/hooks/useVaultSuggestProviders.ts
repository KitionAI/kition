   
                                                    
  
                                                        
                                             
                                 
                                         
  
                                                   
                
   

import { useCallback, useEffect, useMemo, useRef } from 'react'

import { parseBlockIds } from '@/features/document/editor/lib/block-id-parser'
import { parseTags } from '@/features/document/editor/lib/tag-parser'
import { vaultClient, type VaultTreeItem } from '@/features/document/editor/vault/vault-client'
import { parseOutlineHeadings } from '@/features/document/editor/components/DocumentOutlinePanel'
import { listRecentFiles } from '@/features/document/editor/hooks/useRecentFiles'
import type {
  AnchorSuggestion,
  BlockIdSuggestion,
  SuggestProviders,
  TagSuggestion,
  WikilinkSuggestion,
} from '@/features/document/editor/editor/extensions'
import { readWorkspaceDocument } from '@/services/desktop'

function flattenTree(items: VaultTreeItem[], out: VaultTreeItem[] = []): VaultTreeItem[] {
  for (const item of items) {
    out.push(item)
    if (item.children?.length) flattenTree(item.children, out)
  }
  return out
}

function stripMdExtension(path: string): string {
  return path.replace(/\.md$/i, '')
}

function lastSegment(path: string): string {
  const idx = path.lastIndexOf('/')
  return idx >= 0 ? path.slice(idx + 1) : path
}

export function useVaultSuggestProviders(): SuggestProviders {
  const filesRef = useRef<VaultTreeItem[] | null>(null)
  const tagsRef = useRef<Map<string, number> | null>(null)
  const fileContentRef = useRef<Map<string, string>>(new Map())
  const loadingRef = useRef<Promise<void> | null>(null)

  const loadFiles = useCallback(async (): Promise<VaultTreeItem[]> => {
    if (filesRef.current) return filesRef.current
    if (!loadingRef.current) {
      loadingRef.current = (async () => {
        const resp = await vaultClient.list()
        const all = flattenTree(resp.items).filter(
          (t) => t.type === 'file' && /\.md$/i.test(t.path),
        )
        filesRef.current = all
      })()
    }
    await loadingRef.current
    loadingRef.current = null
    return filesRef.current ?? []
  }, [])

  const readFile = useCallback(async (path: string): Promise<string> => {
    const cached = fileContentRef.current.get(path)
    if (cached != null) return cached
    try {
      const doc = await readWorkspaceDocument(path)
      const content = doc.content ?? ''
      fileContentRef.current.set(path, content)
      return content
    } catch {
      return ''
    }
  }, [])

  const resolveTarget = useCallback(async (target: string): Promise<string | null> => {
    if (!target) return null
    const files = await loadFiles()
    const targetLower = target.toLowerCase()
                    
    const exact = files.find((f) => stripMdExtension(f.path).toLowerCase() === targetLower)
    if (exact) return exact.path
            
    const byName = files.find((f) => stripMdExtension(lastSegment(f.path)).toLowerCase() === targetLower)
    return byName ? byName.path : null
  }, [loadFiles])

  const loadTags = useCallback(async (): Promise<Map<string, number>> => {
    if (tagsRef.current) return tagsRef.current
    const files = await loadFiles()
    const counter = new Map<string, number>()
    const limit = Math.min(files.length, 200)
    for (let i = 0; i < limit; i++) {
      const content = await readFile(files[i].path)
      const tags = parseTags(content)
      for (const t of tags) {
        counter.set(t.name, (counter.get(t.name) ?? 0) + 1)
      }
    }
    tagsRef.current = counter
    return counter
  }, [loadFiles, readFile])

                            
  useEffect(() => {
    filesRef.current = null
    tagsRef.current = null
    fileContentRef.current = new Map()
  }, [])

  const wikilinks = useCallback(
    async (query: string): Promise<WikilinkSuggestion[]> => {
      const files = await loadFiles()
      const q = query.toLowerCase()
                   
      const recents = listRecentFiles()
      const recentRank = new Map<string, number>()
      recents.forEach((r, i) => recentRank.set(stripMdExtension(r.path).toLowerCase(), i))
      const matched = files
        .map((f) => ({
          target: stripMdExtension(f.path),
          label: stripMdExtension(lastSegment(f.path)),
          detail: stripMdExtension(f.path),
        }))
        .filter((s) => !q || s.label.toLowerCase().includes(q) || s.target.toLowerCase().includes(q))
        .map((s) => {
          const r = recentRank.get(s.target.toLowerCase())
          const recencyBoost = r != null ? Math.max(0, 50 - r) : 0
                                  
          const lbl = s.label.toLowerCase()
          let score = 0
          if (q) {
            if (lbl === q) score = 1000
            else if (lbl.startsWith(q)) score = 500
            else if (lbl.includes(q)) score = 200
            else score = 50
          }
          return { suggestion: s, score: score + recencyBoost }
        })
        .sort((a, b) => b.score - a.score)
        .slice(0, 50)
        .map((s) => s.suggestion)
      return matched
    },
    [loadFiles],
  )

  const headingsOf = useCallback(
    async (target: string): Promise<AnchorSuggestion[]> => {
      const path = await resolveTarget(target)
      if (!path) return []
      const content = await readFile(path)
      return parseOutlineHeadings(content).map((h) => ({ text: h.text, level: h.level }))
    },
    [resolveTarget, readFile],
  )

  const blockIdsOf = useCallback(
    async (target: string): Promise<BlockIdSuggestion[]> => {
      const path = await resolveTarget(target)
      if (!path) return []
      const content = await readFile(path)
      const lines = content.split(/\r?\n/)
      const blocks = parseBlockIds(content)
      return blocks.map((b) => ({
        id: b.blockId,
        preview: lines[b.line]?.trim().slice(0, 60),
      }))
    },
    [resolveTarget, readFile],
  )

  const tags = useCallback(
    async (query: string): Promise<TagSuggestion[]> => {
      const map = await loadTags()
      const q = query.toLowerCase()
      const results: TagSuggestion[] = []
      for (const [name, count] of map.entries()) {
        if (!q || name.toLowerCase().includes(q)) {
          results.push({ name, count })
        }
      }
      results.sort((a, b) => (b.count ?? 0) - (a.count ?? 0))
      return results.slice(0, 50)
    },
    [loadTags],
  )

                                                                              
                                                           
                                                                                 
                                                 
  return useMemo<SuggestProviders>(
    () => ({ wikilinks, headingsOf, blockIdsOf, tags }),
    [wikilinks, headingsOf, blockIdsOf, tags],
  )
}
