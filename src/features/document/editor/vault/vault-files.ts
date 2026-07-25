   
                  
  
                                                    
                                
   

import { vaultClient, type VaultTreeItem } from '@/features/document/editor/vault/vault-client'

const TTL_MS = 10_000

type CacheEntry = {
  fetchedAt: number
  files: VaultTreeItem[]
}

let cache: CacheEntry | null = null
let inflight: Promise<VaultTreeItem[]> | null = null
let linkableCache: CacheEntry | null = null
let linkableInflight: Promise<VaultTreeItem[]> | null = null

function flatten(items: VaultTreeItem[], out: VaultTreeItem[] = []): VaultTreeItem[] {
  for (const item of items) {
    out.push(item)
    if (item.children?.length) flatten(item.children, out)
  }
  return out
}

export async function loadVaultMarkdownFiles(): Promise<VaultTreeItem[]> {
  const now = Date.now()
  if (cache && now - cache.fetchedAt < TTL_MS) return cache.files
  if (inflight) return inflight
  inflight = (async () => {
    try {
      const resp = await vaultClient.list()
      const all = flatten(resp.items).filter((t) => t.type === 'file' && /\.md$/i.test(t.path))
      cache = { fetchedAt: Date.now(), files: all }
      return all
    } finally {
      inflight = null
    }
  })()
  return inflight
}

export function clearVaultFileCache(): void {
  cache = null
  linkableCache = null
}

   
                                                     
                                                   
                                                      
                                                     
   
export async function loadVaultLinkableFiles(): Promise<VaultTreeItem[]> {
  const now = Date.now()
  if (linkableCache && now - linkableCache.fetchedAt < TTL_MS) return linkableCache.files
  if (linkableInflight) return linkableInflight
  linkableInflight = (async () => {
    try {
      const resp = await vaultClient.list()
      const all = flatten(resp.items).filter(
        (t) => t.type === 'file' && /\.(md|kitable)$/i.test(t.path),
      )
      linkableCache = { fetchedAt: Date.now(), files: all }
      return all
    } finally {
      linkableInflight = null
    }
  })()
  return linkableInflight
}

export async function pickRandomMarkdownFile(excludePath?: string): Promise<string | null> {
  const files = await loadVaultMarkdownFiles()
  const pool = excludePath ? files.filter((f) => f.path !== excludePath) : files
  if (pool.length === 0) return null
  return pool[Math.floor(Math.random() * pool.length)].path
}
