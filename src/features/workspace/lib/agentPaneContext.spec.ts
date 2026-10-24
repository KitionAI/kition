/**
 * Locks in the WorkspaceTab → AgentPaneContext mapping. Two call sites
 * in WorkspaceScreen consume this — empty-state copy + buildAgentTurnContext
 * — and if they drift apart the agent backend's system-prompt addendum
 * stops matching what the user sees on the empty-state card. That's
 * exactly the desync docs/workflow-ai-chat-ux-review.md P1-2 calls out.
 */
import { describe, expect, it } from 'vitest'

import type { WorkspaceTab } from '@/features/workspace/lib/workspace'

import {
  deriveAgentPaneContext,
  resolveAgentActiveDocument,
} from './agentPaneContext'

describe('deriveAgentPaneContext', () => {
  it('returns document when no tab is active so the empty state has sensible default copy', () => {
    expect(deriveAgentPaneContext(null)).toBe('document')
    expect(deriveAgentPaneContext(undefined)).toBe('document')
  })

  it('file-viewer tab → document (file preview is still a doc-like read surface)', () => {
    const tab: WorkspaceTab = {
      id: 'fv1',
      type: 'file-viewer',
      title: 'doc.pdf',
      path: 'doc.pdf',
      format: 'pdf',
    }
    expect(deriveAgentPaneContext(tab)).toBe('document')
  })

  it('file-viewer media formats → gallery so "summarize this document" doesn\'t show next to a PNG', () => {
    // Single-file preview of a PNG/MP4/MP3 should reuse the gallery
    // suggestion set (Describe each / Pick the hero / Group by topic) —
    // those suggestions were made media-agnostic in iter 10 so they read
    // correctly for a single asset too.
    for (const format of ['image', 'video', 'audio'] as const) {
      const tab: WorkspaceTab = {
        id: `fv-${format}`,
        type: 'file-viewer',
        title: `asset.${format}`,
        path: `asset.${format}`,
        format,
      }
      expect(deriveAgentPaneContext(tab), `format=${format}`).toBe('gallery')
    }
  })

  it('file-viewer prose / data formats stay on the document pane', () => {
    // These formats are doc-like reads — keep the document suggestion set.
    for (const format of ['markdown', 'docx', 'xlsx', 'pptx', 'csv', 'json', 'text', 'html', 'binary', 'table'] as const) {
      const tab: WorkspaceTab = {
        id: `fv-${format}`,
        type: 'file-viewer',
        title: `file.${format}`,
        path: `file.${format}`,
        format,
      }
      expect(deriveAgentPaneContext(tab), `format=${format}`).toBe('document')
    }
  })

  it('workflow tab → workflow', () => {
    const tab: WorkspaceTab = {
      id: 'w1',
      type: 'workflow',
      title: 'Email on lead',
    }
    expect(deriveAgentPaneContext(tab)).toBe('workflow')
  })

  it('gallery tab → gallery', () => {
    const tab: WorkspaceTab = {
      id: 'g1',
      type: 'gallery',
      title: 'Images',
      kind: 'images',
    }
    expect(deriveAgentPaneContext(tab)).toBe('gallery')
  })
})

describe('resolveAgentActiveDocument', () => {
  it('returns the path and format for file tabs', () => {
    expect(resolveAgentActiveDocument({
      id: 'file-viewer:Docs/Plan.md',
      type: 'file-viewer',
      title: 'Plan',
      path: 'Docs/Plan.md',
      format: 'markdown',
    })).toEqual({ path: 'Docs/Plan.md', format: 'markdown' })

    expect(resolveAgentActiveDocument({
      id: 'file:Reports/Quarter.pdf',
      type: 'file-viewer',
      title: 'Quarter',
      path: 'Reports/Quarter.pdf',
      format: 'pdf',
    })).toEqual({ path: 'Reports/Quarter.pdf', format: 'pdf' })
  })

  it('binds a workflow tab to its table file', () => {
    expect(resolveAgentActiveDocument({
      id: 'workflow:Sales/Leads.ktable',
      type: 'workflow',
      title: 'Leads',
      tablePath: 'Sales/Leads.ktable',
    })).toEqual({ path: 'Sales/Leads.ktable', format: 'table' })
    expect(resolveAgentActiveDocument({
      id: 'workflow',
      type: 'workflow',
      title: 'Workflows',
    })).toEqual({ path: '', format: undefined })
  })
})
