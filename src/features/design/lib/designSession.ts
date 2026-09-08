import {
  readWorkspaceDocument,
  writeWorkspaceDocument,
} from '@/services/desktop'
import { registerWorkspaceEditSession } from '@/services/workspaceEditSessions'
import { DesignStore } from './designStore'
import { parseDesign, serializeDesign } from './designSerialization'
export type DesignSaveStatus =
  | 'saved'
  | 'saving'
  | 'unsaved'
  | 'conflict'
  | 'error'
  | 'recovered'
export class DesignSession {
  readonly store: DesignStore
  private savedContent: string
  private dirty = false
  private abandoned = false
  private lastDocument: ReturnType<DesignStore['getSnapshot']>['document']
  private saving: Promise<void> | null = null
  private timer: ReturnType<typeof setTimeout> | undefined
  private listeners = new Set<() => void>()
  private status: DesignSaveStatus = 'saved'
  private draftKey: string
  constructor(
    readonly root: string,
    readonly path: string,
    content: string,
  ) {
    this.savedContent = content
    this.draftKey = `kition.design.recovery.v1:${root}:${path}`
    let document = parseDesign(content)
    try {
      const raw = localStorage.getItem(this.draftKey)
      if (raw) {
        const draft = JSON.parse(raw) as { base: string; content: string }
        const recovered = parseDesign(draft.content)
        if (recovered.id === document.id && draft.content !== content) {
          document = recovered
          this.dirty = true
          this.status = draft.base === content ? 'recovered' : 'conflict'
        }
      }
    } catch {
      /* Invalid recovery data never replaces the source file. */
    }
    this.store = new DesignStore(document)
    this.lastDocument = document
  }
  getStatus = () => this.status
  subscribe = (fn: () => void) => {
    this.listeners.add(fn)
    return () => {
      this.listeners.delete(fn)
    }
  }
  private setStatus(status: DesignSaveStatus) {
    this.status = status
    this.listeners.forEach((fn) => fn())
  }
  private recordDraft() {
    localStorage.setItem(
      this.draftKey,
      JSON.stringify({
        base: this.savedContent,
        content: serializeDesign(this.store.getSnapshot().document),
      }),
    )
  }
  connect() {
    const unsubscribe = this.store.subscribe(() => {
      if (this.abandoned) return
      const document = this.store.getSnapshot().document
      if (document === this.lastDocument) return
      this.lastDocument = document
      this.dirty = true
      try {
        this.recordDraft()
      } catch {
        this.setStatus('error')
      }
      if (this.status !== 'conflict') this.setStatus('unsaved')
      clearTimeout(this.timer)
      this.timer = setTimeout(() => {
        void this.flush().catch(() => {})
      }, 400)
    })
    const unregister = registerWorkspaceEditSession(this.flush, this.path)
    return () => {
      unsubscribe()
      unregister()
      clearTimeout(this.timer)
      void this.flush().catch(() => {})
    }
  }
  flush = async (): Promise<void> => {
    clearTimeout(this.timer)
    if (this.abandoned) return
    if (this.saving) {
      await this.saving
      return this.flush()
    }
    if (this.status === 'conflict') throw new Error('DESIGN_SAVE_CONFLICT')
    if (!this.dirty) return
    const document = this.store.getSnapshot().document,
      content = serializeDesign(document)
    if (content === this.savedContent) {
      this.dirty = false
      this.setStatus('saved')
      return
    }
    this.setStatus('saving')
    this.saving = (async () => {
      try {
        await writeWorkspaceDocument(this.path, content, {
          expected_root: this.root,
          expected_content: this.savedContent,
        })
        this.savedContent = content
        if (this.store.getSnapshot().document === document) {
          this.dirty = false
          localStorage.removeItem(this.draftKey)
          this.setStatus('saved')
        } else {
          this.recordDraft()
          this.setStatus('unsaved')
        }
      } catch (error) {
        try {
          this.recordDraft()
        } catch {
          /* Keep in-memory edits available for save-a-copy. */
        }
        this.setStatus(
          String(error).includes('DESIGN_SAVE_CONFLICT') ? 'conflict' : 'error',
        )
        throw error
      }
    })()
    try {
      await this.saving
    } finally {
      this.saving = null
    }
    if (this.store.getSnapshot().document !== document) await this.flush()
  }
  async checkExternal() {
    if (this.saving || this.abandoned) return
    try {
      const current = await readWorkspaceDocument(this.path, this.root)
      if (this.abandoned || this.saving) return
      if (current.content !== this.savedContent) {
        this.recordDraft()
        this.setStatus('conflict')
      }
    } catch {
      this.setStatus('conflict')
    }
  }
  discardRecovery() {
    this.abandoned = true
    this.dirty = false
    clearTimeout(this.timer)
    localStorage.removeItem(this.draftKey)
  }
}
