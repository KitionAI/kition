   
                                               
  
                                                                         
                                
   

import { useCallback, useRef } from 'react'

import type { EmbedLoader } from '@/features/document/editor/editor/extensions'
import { vaultClient, type VaultTreeItem } from '@/features/document/editor/vault/vault-client'
import { readWorkspaceDocument } from '@/services/desktop'

function flatten(items: VaultTreeItem[], out: VaultTreeItem[] = []): VaultTreeItem[] {
  for (const item of items) {
    out.push(item)
    if (item.children?.length) flatten(item.children, out)
  }
  return out
}

function stripMd(path: string): string {
  return path.replace(/\.md$/i, '')
}

function lastSegment(path: string): string {
  const idx = path.lastIndexOf('/')
  return idx >= 0 ? path.slice(idx + 1) : path
}

export function useVaultEmbedLoader(): EmbedLoader {
  const filesRef = useRef<VaultTreeItem[] | null>(null)
  const contentRef = useRef<Map<string, string>>(new Map())
  const inflight = useRef<Map<string, Promise<{ content: string; path: string } | null>>>(
    new Map(),
  )

  const ensureFiles = useCallback(async (): Promise<VaultTreeItem[]> => {
    if (filesRef.current) return filesRef.current
    const resp = await vaultClient.list()
    filesRef.current = flatten(resp.items).filter((t) => t.type === 'file' && /\.md$/i.test(t.path))
    return filesRef.current
  }, [])

  return useCallback<EmbedLoader>(async (target) => {
    const key = target.toLowerCase()
    const existing = inflight.current.get(key)
    if (existing) return existing
    const promise = (async () => {
      const files = await ensureFiles()
      const tLower = key
      let matched = files.find((f) => stripMd(f.path).toLowerCase() === tLower)
      if (!matched) {
        matched = files.find((f) => stripMd(lastSegment(f.path)).toLowerCase() === tLower)
      }
      if (!matched) return null
      const cached = contentRef.current.get(matched.path)
      if (cached != null) return { content: cached, path: matched.path }
      try {
        const doc = await readWorkspaceDocument(matched.path)
        const content = doc.content ?? ''
        contentRef.current.set(matched.path, content)
        return { content, path: matched.path }
      } catch {
        return null
      }
    })()
    inflight.current.set(key, promise)
    promise.finally(() => {
                                                     
      inflight.current.delete(key)
    })
    return promise
  }, [ensureFiles])
}
