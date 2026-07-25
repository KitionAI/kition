   
                                
  
                                                              
                                             
                                                        
                                   
                                                  
                                                              
                                                       
                          
                                                          
  
                                                     
                              
   
import { useEffect, useRef } from 'react'
import { cn } from '@/lib/utils'
import {
  clearDraftTitle,
  setDraftTitle,
} from '@/features/workspace/lib/draftTitleStore'

type WorkspaceDocumentInlineTitleProps = {
  documentPath: string
  value: string
  onCommit: (next: string) => void
                                           
  onFocusEditor?: () => void
  disabled?: boolean
}

export function WorkspaceDocumentInlineTitle({
  documentPath,
  value,
  onCommit,
  onFocusEditor,
  disabled = false,
}: WorkspaceDocumentInlineTitleProps) {
  const ref = useRef<HTMLDivElement | null>(null)
  const composingRef = useRef(false)
  const lastCommittedRef = useRef(value)
  const lastBroadcastRef = useRef<string | null>(null)

  // Sync textContent from props only when not focused / not composing.
  // lastCommittedRef is always updated so that Escape restores the latest
  // server value even when a rename arrives while the element is focused.
  useEffect(() => {
    lastCommittedRef.current = value
    const el = ref.current
    if (!el) return
    if (document.activeElement === el) return
    if (composingRef.current) return
    if (el.textContent !== value) el.textContent = value
  }, [value])

  // Deduplicated broadcast helper — skips the call when the value hasn't
  // changed, which prevents the IME double-broadcast that occurs because
  // Chrome fires a synthetic `input` event after `compositionend`.
  const broadcast = () => {
    const el = ref.current
    if (!el) return
    const next = el.textContent ?? ''
    if (lastBroadcastRef.current === next) return
    lastBroadcastRef.current = next
    setDraftTitle(documentPath, next)
  }

  // Reset draft store on document switch / unmount.
  useEffect(() => {
    return () => {
      clearDraftTitle()
    }
  }, [documentPath])

  const commit = () => {
    const el = ref.current
    if (!el) return
    const next = el.textContent ?? ''
    clearDraftTitle()
    lastBroadcastRef.current = null
    if (next === lastCommittedRef.current) return
    lastCommittedRef.current = next
    onCommit(next)
  }

  const cancel = () => {
    const el = ref.current
    if (!el) return
    el.textContent = lastCommittedRef.current
    clearDraftTitle()
    lastBroadcastRef.current = null
    el.blur()
  }

  return (
    <div
      ref={(node) => {
        ref.current = node
        if (node && node.textContent !== value && document.activeElement !== node) {
          node.textContent = value
        }
      }}
      data-testid="workspace-document-inline-title"
      className={cn(
        'workspace-document-inline-title',
        'inline-title',
      )}
      role="textbox"
      contentEditable={disabled ? 'false' : 'true'}
      suppressContentEditableWarning
      spellCheck
      tabIndex={-1}
      onCompositionStart={() => { composingRef.current = true }}
      onCompositionEnd={() => {
        composingRef.current = false
        // Most browsers (Chrome, Edge, Firefox, Safari) fire a synthetic `input`
        // event synchronously after `compositionend`; onInput carries the broadcast.
        // queueMicrotask is a fallback for browsers that don't fire that event.
        // `broadcast()` deduplicates, so if `input` already fired first this is a no-op.
        queueMicrotask(broadcast)
      }}
      onInput={() => {
        if (composingRef.current) return
        broadcast()
      }}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.preventDefault()
          commit()
          onFocusEditor?.()
        } else if (event.key === 'Escape') {
          event.preventDefault()
          cancel()
        }
      }}
      onPaste={(event) => {
        event.preventDefault()
        const text = event.clipboardData.getData('text/plain')
        document.execCommand('insertText', false, text.replace(/\r?\n/g, ' '))
      }}
    />
  )
}
