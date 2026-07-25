import { LoaderCircle } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Button, Input } from '@/components/ui'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/registry/ui/dialog'

export function WorkspaceFolderCreateDialog({
  open,
  value,
  busy,
  onOpenChange,
  onValueChange,
  onSubmit,
}: {
  open: boolean
  value: string
  busy: boolean
  onOpenChange: (open: boolean) => void
  onValueChange: (value: string) => void
  onSubmit: () => void
}) {
  const { t } = useTranslation('workspace')
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="sm" className="gap-0 p-0">
        <form
          onSubmit={(event) => {
            event.preventDefault()
            onSubmit()
          }}
        >
          <DialogHeader className="space-y-2 border-b px-5 py-4">
            <DialogTitle>{t('folderDialog.title')}</DialogTitle>
            <DialogDescription>{t('folderDialog.description')}</DialogDescription>
          </DialogHeader>
          <div className="px-5 py-4">
            <Input
              value={value}
              onChange={(event) => onValueChange(event.target.value)}
              placeholder={t('folderDialog.placeholder')}
              autoFocus
              disabled={busy}
            />
          </div>
          <DialogFooter className="border-t px-5 py-4">
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={busy}
            >
              {t('folderDialog.cancel')}
            </Button>
            <Button type="submit" disabled={busy}>
              {busy ? <LoaderCircle className="size-4 animate-spin" /> : null}
              {t('folderDialog.create')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
