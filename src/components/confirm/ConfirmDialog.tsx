import React, { useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/registry/ui/dialog'
import { buttonVariants } from '@/registry/ui/button'
import { cn } from '@/lib/utils'

import type { ConfirmOpts } from './types'

interface ConfirmDialogProps {
  open: boolean
  opts: ConfirmOpts
  onSettle: (value: boolean) => void
}

export function ConfirmDialog({ open, opts, onSettle }: ConfirmDialogProps) {
  const { t } = useTranslation('common')
  const {
    title,
    message,
    confirmLabel,
    cancelLabel,
    variant = 'default',
    testId,
  } = opts
  const resolvedConfirmLabel = confirmLabel ?? t('actions.confirm')
  const resolvedCancelLabel = cancelLabel ?? t('actions.cancel')

  const confirmRef = useRef<HTMLButtonElement>(null)
  const cancelRef = useRef<HTMLButtonElement>(null)
  const settledRef = useRef(false)

  const settleOnce = (value: boolean) => {
    if (settledRef.current) return
    settledRef.current = true
    onSettle(value)
  }

  // Focus management: destructive → cancel, default → confirm
  useEffect(() => {
    if (!open) return
    const targetRef = variant === 'destructive' ? cancelRef : confirmRef
    // Use a short timeout to allow Radix portal to finish mounting
    const id = setTimeout(() => {
      targetRef.current?.focus()
    }, 0)
    return () => clearTimeout(id)
  }, [open, variant])

  const handleConfirm = () => settleOnce(true)
  const handleCancel = () => settleOnce(false)

  return (
    <Dialog
      open={open}
      onOpenChange={(isOpen) => {
        // overlay click or Esc via Radix triggers onOpenChange(false)
        if (!isOpen) settleOnce(false)
      }}
    >
      <DialogContent
        hideClose
        disableAutoFocus
        size="sm"
        data-testid={testId}
        onEscapeKeyDown={() => {
          // Radix will call onOpenChange(false) which routes to settleOnce(false)
          // No preventDefault needed — let Radix handle the close
        }}
      >
        <DialogHeader>
          <DialogTitle className={title ? undefined : 'sr-only'}>
            {title ?? message}
          </DialogTitle>
          <DialogDescription data-testid="confirm-message">
            {message}
          </DialogDescription>
        </DialogHeader>

        <DialogFooter>
          <button
            ref={cancelRef}
            data-testid="cancel-btn"
            type="button"
            className={cn(buttonVariants({ variant: 'secondary' }))}
            onClick={handleCancel}
          >
            {resolvedCancelLabel}
          </button>
          <button
            ref={confirmRef}
            data-testid="confirm-btn"
            type="button"
            className={cn(
              buttonVariants({
                variant: variant === 'destructive' ? 'destructive' : 'default',
              })
            )}
            onClick={handleConfirm}
          >
            {resolvedConfirmLabel}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
