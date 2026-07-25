   
                             
  
                                         
          
                                 
         
  
                                                  
   

import { Plus, Trash2 } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Button } from '@/registry/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/registry/ui/dialog'
import { Input } from '@/registry/ui/input'

import { parseFrontmatter } from '../lib/frontmatter-parser'
import {
  applyFrontmatter,
  fieldsFromParsed,
  type EditableField,
} from '../lib/frontmatter-serialize'

export type DocumentPropertiesDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  source: string
  onApply: (nextSource: string) => void
}

type FieldKind = 'text' | 'list'

function kindOf(value: EditableField['value']): FieldKind {
  return Array.isArray(value) ? 'list' : 'text'
}

export function DocumentPropertiesDialog({
  open,
  onOpenChange,
  source,
  onApply,
}: DocumentPropertiesDialogProps) {
  const { t } = useTranslation('document')
  const parsed = useMemo(() => parseFrontmatter(source), [source])
  const [fields, setFields] = useState<EditableField[]>(() =>
    parsed ? fieldsFromParsed(parsed.fields) : [],
  )

  useEffect(() => {
    if (!open) return
    setFields(parsed ? fieldsFromParsed(parsed.fields) : [])
  }, [open, parsed])

  const setKey = (i: number, key: string) => {
    setFields((prev) => prev.map((f, idx) => (idx === i ? { ...f, key } : f)))
  }
  const setValueText = (i: number, value: string) => {
    setFields((prev) => prev.map((f, idx) => (idx === i ? { ...f, value } : f)))
  }
  const setValueListItem = (i: number, j: number, item: string) => {
    setFields((prev) =>
      prev.map((f, idx) => {
        if (idx !== i || !Array.isArray(f.value)) return f
        const next = [...f.value]
        next[j] = item
        return { ...f, value: next }
      }),
    )
  }
  const addListItem = (i: number) => {
    setFields((prev) =>
      prev.map((f, idx) => {
        if (idx !== i || !Array.isArray(f.value)) return f
        return { ...f, value: [...f.value, ''] }
      }),
    )
  }
  const removeListItem = (i: number, j: number) => {
    setFields((prev) =>
      prev.map((f, idx) => {
        if (idx !== i || !Array.isArray(f.value)) return f
        return { ...f, value: f.value.filter((_, k) => k !== j) }
      }),
    )
  }
  const setKind = (i: number, kind: FieldKind) => {
    setFields((prev) =>
      prev.map((f, idx) => {
        if (idx !== i) return f
        if (kind === 'list' && !Array.isArray(f.value)) {
          return { ...f, value: f.value ? [f.value] : [] }
        }
        if (kind === 'text' && Array.isArray(f.value)) {
          return { ...f, value: f.value.join(', ') }
        }
        return f
      }),
    )
  }
  const addField = () => {
    setFields((prev) => [...prev, { key: '', value: '' }])
  }
  const removeField = (i: number) => {
    setFields((prev) => prev.filter((_, idx) => idx !== i))
  }

  const handleSave = () => {
    const cleaned = fields
      .map((f) => ({ key: f.key.trim(), value: f.value }))
      .filter((f) => f.key)
    const next = applyFrontmatter(source, cleaned, parsed ? { from: parsed.from, to: parsed.to } : null)
    onApply(next)
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t('dialog.properties.title')}</DialogTitle>
          <DialogDescription>{t('dialog.properties.description')}</DialogDescription>
        </DialogHeader>
        <div className="max-h-[55vh] space-y-2 overflow-auto">
          {fields.length === 0 ? (
            <div className="px-1 py-4 text-center text-xs text-muted-foreground">
              {t('dialog.properties.empty')}
            </div>
          ) : (
            fields.map((f, i) => {
              const kind = kindOf(f.value)
              return (
                <div
                  key={i}
                  className="space-y-1 rounded border border-border/40 p-2"
                >
                  <div className="flex items-center gap-2">
                    <Input
                      value={f.key}
                      onChange={(e) => setKey(i, e.target.value)}
                      placeholder={t('dialog.properties.keyPlaceholder')}
                      className="h-7 w-44 text-xs"
                    />
                    <div className="flex items-center gap-0.5 text-[11px]">
                      <button
                        type="button"
                        onClick={() => setKind(i, 'text')}
                        className={
                          'rounded px-2 py-0.5 '
                          + (kind === 'text' ? 'bg-accent/60' : 'hover:bg-accent/40')
                        }
                      >
                        {t('dialog.properties.typeText')}
                      </button>
                      <button
                        type="button"
                        onClick={() => setKind(i, 'list')}
                        className={
                          'rounded px-2 py-0.5 '
                          + (kind === 'list' ? 'bg-accent/60' : 'hover:bg-accent/40')
                        }
                      >
                        {t('dialog.properties.typeList')}
                      </button>
                    </div>
                    <button
                      type="button"
                      onClick={() => removeField(i)}
                      className="ml-auto text-muted-foreground hover:text-destructive"
                      title={t('dialog.properties.removeField')}
                    >
                      <Trash2 className="size-3.5" />
                    </button>
                  </div>
                  {Array.isArray(f.value) ? (
                    <div className="space-y-1 pl-3">
                      {f.value.map((item, j) => (
                        <div key={j} className="flex items-center gap-1.5">
                          <span className="text-muted-foreground">-</span>
                          <Input
                            value={item}
                            onChange={(e) => setValueListItem(i, j, e.target.value)}
                            className="h-7 flex-1 text-xs"
                          />
                          <button
                            type="button"
                            onClick={() => removeListItem(i, j)}
                            className="text-muted-foreground hover:text-destructive"
                            title={t('dialog.properties.removeItem')}
                          >
                            <Trash2 className="size-3" />
                          </button>
                        </div>
                      ))}
                      <button
                        type="button"
                        onClick={() => addListItem(i)}
                        className="ml-3 rounded px-2 py-0.5 text-[11px] text-muted-foreground hover:bg-accent/40"
                      >
                        {t('dialog.properties.addListItem')}
                      </button>
                    </div>
                  ) : (
                    <Input
                      value={f.value}
                      onChange={(e) => setValueText(i, e.target.value)}
                      placeholder={t('dialog.properties.valuePlaceholder')}
                      className="h-7 text-xs"
                    />
                  )}
                </div>
              )
            })
          )}
        </div>
        <DialogFooter className="flex justify-between sm:justify-between">
          <Button variant="outline" onClick={addField} size="xs">
            <Plus className="mr-1 size-3.5" />
            {t('dialog.properties.addField')}
          </Button>
          <div className="flex gap-2">
            <Button variant="ghost" onClick={() => onOpenChange(false)}>
              {t('dialog.properties.cancel')}
            </Button>
            <Button onClick={handleSave}>{t('dialog.properties.save')}</Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
