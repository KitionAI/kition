import { Check, Copy } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

import { Button } from '@/components/ui'
import { cn } from '@/lib/utils'

export function CopyableEmailSyncError({
  message,
  className,
  testId,
}: {
  message: string
  className?: string
  testId?: string
}) {
  const [copied, setCopied] = useState(false)
  const resetTimer = useRef<number | null>(null)

  useEffect(() => () => {
    if (resetTimer.current !== null) window.clearTimeout(resetTimer.current)
  }, [])

  async function copyError() {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(message)
      } else {
        copyWithTextArea(message)
      }
      setCopied(true)
      if (resetTimer.current !== null) window.clearTimeout(resetTimer.current)
      resetTimer.current = window.setTimeout(() => setCopied(false), 2000)
    } catch {
      setCopied(false)
    }
  }

  return (
    <div
      className={cn('flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive', className)}
      data-testid={testId}
      role="alert"
    >
      <p className="min-w-0 flex-1 whitespace-pre-wrap break-words">{message}</p>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="size-7 shrink-0 text-destructive hover:bg-destructive/10 hover:text-destructive"
        aria-label={copied ? 'Error copied' : 'Copy error'}
        title={copied ? 'Copied' : 'Copy error'}
        onClick={() => void copyError()}
      >
        {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
      </Button>
    </div>
  )
}

function copyWithTextArea(value: string) {
  const textArea = document.createElement('textarea')
  textArea.value = value
  textArea.setAttribute('readonly', '')
  textArea.style.position = 'fixed'
  textArea.style.opacity = '0'
  document.body.appendChild(textArea)
  textArea.select()
  const copied = document.execCommand('copy')
  textArea.remove()
  if (!copied) throw new Error('Copy command failed')
}
