// src/features/search/ui/navigateToHit.ts
import i18n from '@/i18n'
import type { SearchHit } from '../types'

export type NavigateAdapters = {
  openVaultPath: (vaultPath: string) => Promise<void>
  getCmViewForPath: (vaultPath: string) => { dispatchFlash: (line: number, ch: number, length: number) => void } | null
  showToast: (message: string) => void
}

export async function navigateToHit(hit: SearchHit, adapters: NavigateAdapters): Promise<void> {
  const doc = hit.doc
  try {
    await adapters.openVaultPath(doc.vaultPath)
  } catch {
    adapters.showToast(i18n.t('common:search.fileMissing'))
    return
  }

  if (doc.anchor.kind === 'note') {
    const cm = adapters.getCmViewForPath(doc.vaultPath)
    if (cm) {
      const matchLen = hit.matches[0] ? hit.matches[0].end - hit.matches[0].start : Math.max(1, doc.body.length)
      cm.dispatchFlash(doc.anchor.line, doc.anchor.ch, matchLen)
    }
    return
  }

  // A table record or field opens its table file in the Table kit, which shows the table.
}
