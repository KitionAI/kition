   
                 
  
                                             
                     
   

import { Plus, Trash2 } from 'lucide-react'
import { useEffect, useState } from 'react'
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

import { addSnippet, removeSnippet, useSnippets } from '../hooks/useSnippets'

export type DocumentSnippetsDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function DocumentSnippetsDialog({ open, onOpenChange }: DocumentSnippetsDialogProps) {
  const { t } = useTranslation('document')
  const items = useSnippets()
  const [trigger, setTrigger] = useState('')
  const [expansion, setExpansion] = useState('')

  useEffect(() => {
    if (!open) {
      setTrigger('')
      setExpansion('')
    }
  }, [open])

  const handleAdd = () => {
    if (!trigger.trim()) return
    addSnippet(trigger.trim(), expansion)
    setTrigger('')
    setExpansion('')
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t('dialog.snippets.title')}</DialogTitle>
          <DialogDescription>{t('dialog.snippets.description')}</DialogDescription>
        </DialogHeader>
        <div className="max-h-72 space-y-1 overflow-auto">
          {items.length === 0 ? (
            <div className="px-1 py-4 text-center text-xs text-muted-foreground">
              {t('dialog.snippets.empty')}
            </div>
          ) : (
            items.map((it) => (
              <div
                key={it.trigger}
                className="flex items-start gap-2 rounded border border-border/40 px-2 py-1.5 text-sm"
              >
                <code className="rounded bg-accent/40 px-1.5 py-0.5 text-xs font-mono">
                  {it.trigger}
                </code>
                <span className="text-muted-foreground">→</span>
                <code className="flex-1 whitespace-pre-wrap break-all text-xs font-mono">
                  {it.expansion}
                </code>
                <button
                  type="button"
                  onClick={() => removeSnippet(it.trigger)}
                  className="text-muted-foreground hover:text-destructive"
                  title={t('dialog.snippets.remove')}
                >
                  <Trash2 className="size-3.5" />
                </button>
              </div>
            ))
          )}
        </div>
        <div className="space-y-2 border-t border-border/40 pt-3">
          <div className="text-xs font-medium">{t('dialog.snippets.addHeading')}</div>
          <Input
            placeholder={t('dialog.snippets.triggerPlaceholder')}
            value={trigger}
            onChange={(e) => setTrigger(e.target.value)}
          />
          <textarea
            placeholder={t('dialog.snippets.expansionPlaceholder')}
            className="w-full rounded-md border border-input bg-background px-3 py-1.5 text-sm font-mono"
            rows={3}
            value={expansion}
            onChange={(e) => setExpansion(e.target.value)}
          />
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            {t('dialog.snippets.close')}
          </Button>
          <Button onClick={handleAdd} disabled={!trigger.trim()}>
            <Plus className="mr-1 size-4" />
            {t('dialog.snippets.add')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
