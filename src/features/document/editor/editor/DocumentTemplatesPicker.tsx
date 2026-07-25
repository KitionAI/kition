   
                          
  
                                                    
   

import type { EditorView } from '@codemirror/view'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/registry/ui/command'

import { applyTemplate, listTemplates, type TemplateEntry } from '../vault/templates'

export type DocumentTemplatesPickerProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  getView: () => EditorView | null
  currentPath?: string
}

export function DocumentTemplatesPicker({
  open,
  onOpenChange,
  getView,
  currentPath,
}: DocumentTemplatesPickerProps) {
  const { t } = useTranslation('document')
  const [items, setItems] = useState<TemplateEntry[] | null>(null)
  const [query, setQuery] = useState('')

  useEffect(() => {
    if (!open) {
      setQuery('')
      return
    }
    let cancelled = false
    void (async () => {
      try {
        const list = await listTemplates()
        if (!cancelled) setItems(list)
      } catch {
        if (!cancelled) setItems([])
      }
    })()
    return () => {
      cancelled = true
    }
  }, [open])

  const onSelect = (path: string) => {
    onOpenChange(false)
    queueMicrotask(() => {
      const view = getView()
      if (!view) return
      void applyTemplate(view, path, currentPath)
    })
  }

  return (
    <CommandDialog open={open} onOpenChange={onOpenChange}>
      <CommandInput placeholder={t('command.templates.placeholder')} value={query} onValueChange={setQuery} />
      <CommandList>
        <CommandEmpty>
          {items === null
            ? t('command.templates.loading')
            : items.length === 0
              ? t('command.templates.emptyHint')
              : t('command.templates.noMatches')}
        </CommandEmpty>
        {items && items.length > 0 ? (
          <CommandGroup heading={t('command.templates.groupHeading')}>
            {items.map((it) => (
              <CommandItem key={it.path} value={it.name} onSelect={() => onSelect(it.path)}>
                <span className="flex-1">{it.name}</span>
                <span className="text-[10px] text-muted-foreground">{it.path}</span>
              </CommandItem>
            ))}
          </CommandGroup>
        ) : null}
      </CommandList>
    </CommandDialog>
  )
}
