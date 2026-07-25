import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Search } from 'lucide-react'
import type { SearchHit } from '../types'
import type { SearchService } from '../service/searchService'
import { SearchResultItem } from './SearchResultItem'

type Props = {
  service: SearchService
  ready: boolean
  open: boolean
  onClose: () => void
  onPick: (hit: SearchHit) => void
}

const MAX = 50

export function SearchCommandPalette({ service, ready, open, onClose, onPick }: Props) {
  const { t } = useTranslation('settings')
  const [input, setInput] = useState('')
  const [hits, setHits] = useState<SearchHit[]>([])
  const [cursor, setCursor] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!open) return
    setInput(''); setHits([]); setCursor(0)
    inputRef.current?.focus()
  }, [open])

  useEffect(() => {
    if (!ready) { setHits([]); return }
    const trimmed = input.trim()
    if (!trimmed) { setHits([]); return }
    const id = setTimeout(() => {
      service.query(trimmed, MAX).then(h => { setHits(h); setCursor(0) }).catch(() => setHits([]))
    }, 250)
    return () => clearTimeout(id)
  }, [input, ready, service])

  useEffect(() => {
    if (!open) return
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') { e.preventDefault(); onClose(); return }
      if (e.key === 'ArrowDown') { e.preventDefault(); setCursor(c => Math.min(c + 1, hits.length - 1)); return }
      if (e.key === 'ArrowUp')   { e.preventDefault(); setCursor(c => Math.max(c - 1, 0)); return }
      if (e.key === 'Enter')     { e.preventDefault(); if (hits[cursor]) { onPick(hits[cursor]); onClose() } return }
                                 
      if ((e.metaKey || e.ctrlKey) && e.key >= '1' && e.key <= '9') {
        const idx = Number(e.key) - 1
        if (hits[idx]) { e.preventDefault(); onPick(hits[idx]); onClose() }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, hits, cursor, onClose, onPick])

  if (!open) return null

  const trimmed = input.trim()

  return (
    <div
      className="search-palette-backdrop"
      data-testid="search-palette-backdrop"
      onClick={onClose}
    >
      <div
        className="search-palette"
        data-testid="search-palette"
        onClick={e => e.stopPropagation()}
      >
        <header className="flex items-center justify-between border-b px-3 py-2">
          <span className="inline-flex items-center gap-1.5 rounded-md bg-accent px-2 py-0.5 text-xs font-semibold uppercase tracking-wide text-accent-foreground">
            <Search className="size-3" /> {t('search.title')}
          </span>
          <span className="text-[11px] text-muted-foreground">
            {t('search.paletteHint')}
          </span>
        </header>
        <input
          ref={inputRef}
          className="search-palette-input"
          placeholder={t('search.palettePlaceholder')}
          value={input}
          disabled={!ready}
          onChange={e => setInput(e.target.value)}
          data-testid="search-palette-input"
        />
        <div className="search-palette-list">
          {hits.map((h, i) => (
            <div
              key={h.id}
              className={'search-palette-row ' + (i === cursor ? 'is-active' : '')}
              data-testid="search-palette-row"
              onMouseEnter={() => setCursor(i)}
            >
              {i < 9
                ? <kbd className="search-palette-shortcut">⌘{i + 1}</kbd>
                : <span className="search-palette-shortcut is-empty" />}
              <SearchResultItem hit={h} onClick={() => { onPick(h); onClose() }} />
            </div>
          ))}
          {!ready ? (
            <div className="search-palette-empty" role="status">
              {t('common:actions.loading')}
            </div>
          ) : trimmed && hits.length === 0 ? (
            <div className="search-palette-empty" data-testid="search-palette-empty">
              {t('search.noMatches')}
            </div>
          ) : null}
          {ready && !trimmed ? (
            <div className="search-palette-empty">{t('search.emptyPrompt')}</div>
          ) : null}
          {hits.length >= MAX && (
            <div className="search-palette-overflow">{t('search.moreResults')}</div>
          )}
        </div>
      </div>
    </div>
  )
}
