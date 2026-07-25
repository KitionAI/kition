import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import type { ScenarioDraftAttachment } from '@/features/scenario/types'
import { ScenarioDropZone } from '@/features/scenario/components/ScenarioDropZone'
import { ScenarioInput } from '@/features/scenario/components/ScenarioInput'

export interface ScenarioStartPageProps {
  /**
   * Called when the user clicks "Start it" (or presses ⌘/Ctrl+Enter in the
   * textarea). The page owns the draft state; the parent is responsible for
   * uploading files and starting the scenario build.
   */
  onSubmit: (prompt: string, files: File[]) => void | Promise<void>
}

let nextIdSeed = 0
/**
 * Best-effort unique id for a draft attachment. Prefer `crypto.randomUUID()`
 * when available; fall back to a monotonic counter so tests in older jsdom
 * versions still work.
 */
function newDraftId(): string {
  const c = (globalThis as any).crypto as { randomUUID?: () => string } | undefined
  if (c && typeof c.randomUUID === 'function') return c.randomUUID()
  nextIdSeed += 1
  return `draft-${Date.now()}-${nextIdSeed}`
}

function makeDraft(file: File): ScenarioDraftAttachment {
  const isImage = typeof file.type === 'string' && file.type.startsWith('image/')
  return {
    id: newDraftId(),
    file,
    previewUrl: isImage ? URL.createObjectURL(file) : null,
  }
}

/**
 * Landing page for "Start from your scenario". Owns the local draft state
 * (prompt text + file attachments) and renders the input UI inside a
 * window-level drop zone. Lifecycle:
 *   - Adding files creates blob URLs for image previews.
 *   - Removing a single attachment revokes its blob URL immediately.
 *   - Unmounting revokes all outstanding blob URLs.
 *
 * The actual build kickoff (uploading files, opening the SSE stream) is the
 * `onSubmit` prop's responsibility — Task 9 will wire it to `useScenarioBuild`.
 */
export function ScenarioStartPage({ onSubmit }: ScenarioStartPageProps) {
  const { t } = useTranslation('settings')
  const [prompt, setPrompt] = useState('')
  const [attachments, setAttachments] = useState<ScenarioDraftAttachment[]>([])
  const [submitting, setSubmitting] = useState(false)
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  // Hold the latest attachments in a ref so the unmount cleanup can revoke
  // every still-live URL without needing to be in the effect deps.
  const attachmentsRef = useRef<ScenarioDraftAttachment[]>([])
  useEffect(() => {
    attachmentsRef.current = attachments
  }, [attachments])

  useEffect(() => {
    return () => {
      for (const att of attachmentsRef.current) {
        if (att.previewUrl) URL.revokeObjectURL(att.previewUrl)
      }
    }
  }, [])

  const addFiles = useCallback((files: File[]) => {
    if (files.length === 0) return
    setAttachments((prev) => [...prev, ...files.map(makeDraft)])
  }, [])

  const removeAttachment = useCallback((id: string) => {
    setAttachments((prev) => {
      const target = prev.find((a) => a.id === id)
      if (target?.previewUrl) URL.revokeObjectURL(target.previewUrl)
      return prev.filter((a) => a.id !== id)
    })
  }, [])

  const handlePickAttachments = useCallback(() => {
    fileInputRef.current?.click()
  }, [])

  const handleFileInputChange = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      const list = event.target.files
      if (list && list.length > 0) {
        addFiles(Array.from(list))
      }
      // Reset so re-picking the same file fires another change.
      event.target.value = ''
    },
    [addFiles],
  )

  const handleSubmit = useCallback(async () => {
    if (submitting) return
    setSubmitting(true)
    try {
      await onSubmit(
        prompt,
        attachments.map((a) => a.file),
      )
    } finally {
      setSubmitting(false)
    }
  }, [attachments, onSubmit, prompt, submitting])

  return (
    <ScenarioDropZone onFiles={addFiles}>
      <div
        data-scenario-start-page=""
        className="flex min-h-screen w-full items-center justify-center bg-background px-6"
      >
        <div className="flex w-full max-w-[640px] flex-col items-stretch gap-6">
          <div className="flex items-center gap-3">
            <span
              data-scenario-logo=""
              aria-hidden
              className="inline-flex h-6 w-6 items-center justify-center rounded-md bg-foreground text-xs font-bold text-background"
            >
              K
            </span>
            <h1
              data-testid="scenario-heading"
              className="text-[28px] font-bold leading-none text-foreground"
            >
              {t('scenario.heading')}
            </h1>
          </div>
          <ScenarioInput
            prompt={prompt}
            onPromptChange={setPrompt}
            attachments={attachments}
            onRemoveAttachment={removeAttachment}
            onPickAttachments={handlePickAttachments}
            onSubmit={handleSubmit}
            submitting={submitting}
          />
        </div>
      </div>
      <input
        ref={fileInputRef}
        type="file"
        multiple
        hidden
        data-testid="scenario-file-input"
        onChange={handleFileInputChange}
      />
    </ScenarioDropZone>
  )
}
