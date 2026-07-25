/**
 * Locks in the per-pane empty-state mapping and the i18n key-path
 * contract. Without this, a rename of a suggestion key in agent.json or in
 * the source map would silently regress to the document fallback —
 * exactly the bug docs/workflow-ai-chat-ux-review.md P1-2 called out.
 */
import { describe, expect, it } from 'vitest'

import enUS from '@/i18n/locales/en-US/agent.json'

import {
  type AgentPaneContext,
  PANE_SUGGESTIONS,
  emptyStateForPane,
} from './paneEmptyState'

const PANES: AgentPaneContext[] = ['document', 'workflow', 'table', 'browser', 'browserSites', 'gallery']

describe('PANE_SUGGESTIONS', () => {
  it('covers every pane the panel can render', () => {
    for (const pane of PANES) {
      expect(PANE_SUGGESTIONS[pane], `missing suggestion set for ${pane}`).toBeDefined()
    }
  })

  it('gives each pane exactly three suggestion cards so the empty-state grid stays balanced', () => {
    for (const pane of PANES) {
      expect(PANE_SUGGESTIONS[pane], `pane ${pane}`).toHaveLength(3)
    }
  })

  it('suggestion keys map one-to-one to agent.json en-US emptyState entries', () => {
    for (const pane of PANES) {
      const json = (enUS as any).emptyState?.[pane]
      expect(json, `emptyState.${pane} missing in en-US`).toBeDefined()
      expect(typeof json.description, `emptyState.${pane}.description`).toBe('string')
      const starterEntries = json.suggestions ?? {}
      for (const key of PANE_SUGGESTIONS[pane]) {
        const card = starterEntries[key]
        expect(card, `emptyState.${pane}.suggestions.${key} missing in en-US`).toBeDefined()
        expect(typeof card.label, `${pane}.${key}.label`).toBe('string')
        expect(typeof card.prompt, `${pane}.${key}.prompt`).toBe('string')
        expect(card.label.length, `${pane}.${key}.label not empty`).toBeGreaterThan(0)
        expect(card.prompt.length, `${pane}.${key}.prompt not empty`).toBeGreaterThan(0)
      }
    }
  })

  // Galleries can hold images OR videos (WorkspaceMediaKind = 'images' |
                                                                       
  // as a bug when the user is on a videos gallery. Lock in
  // media-neutral phrasing for the gallery pane only — other panes are
  // free to use document/table/etc. terminology where appropriate.
  it('gallery copy stays media-agnostic so videos galleries don\'t read like a bug', () => {
    const gallery = (enUS as any).emptyState.gallery
    const blob = JSON.stringify(gallery)
    for (const re of [/\bimage(s)?\b/i, /\bphoto(s)?\b/i]) {
      expect(re.test(blob), `gallery copy still contains media-specific wording (${re}): ${blob}`).toBe(false)
    }
  })

  // The 'Configure a model' CTA replaces the suggestion grid when the
  // user has no text model configured (iter 22). Without this key in
  // both locales the panel would render the i18n key path verbatim —
  // a 'emptyState.needsModelConfig.label'-shaped button. Locking it in
  // here means a translation drop / rename fails the spec instead of
  // shipping a broken empty state.
  it('needsModelConfig CTA label exists in the default locale', () => {
    const label = (enUS as any).emptyState?.needsModelConfig?.label
    expect(typeof label, 'en-US emptyState.needsModelConfig.label type').toBe('string')
    expect(label.length, 'en-US emptyState.needsModelConfig.label not empty').toBeGreaterThan(0)
    expect(label, 'en-US CTA label leaked i18n key').not.toContain('.')
  })
})

describe('emptyStateForPane', () => {
  it('resolves description + every suggestion through the t() callable using the expected key paths', () => {
    const calls: string[] = []
    const t = (key: string) => {
      calls.push(key)
      return `RESOLVED:${key}`
    }
    const cfg = emptyStateForPane('workflow', t)
    expect(cfg.description).toBe('RESOLVED:emptyState.workflow.description')
    expect(cfg.suggestions).toHaveLength(3)
    expect(cfg.suggestions.map((s) => s.label)).toEqual([
      'RESOLVED:emptyState.workflow.suggestions.emailOnRecord.label',
      'RESOLVED:emptyState.workflow.suggestions.remindOnDate.label',
      'RESOLVED:emptyState.workflow.suggestions.refine.label',
    ])
    expect(cfg.suggestions.map((s) => s.prompt)).toEqual([
      'RESOLVED:emptyState.workflow.suggestions.emailOnRecord.prompt',
      'RESOLVED:emptyState.workflow.suggestions.remindOnDate.prompt',
      'RESOLVED:emptyState.workflow.suggestions.refine.prompt',
    ])
    expect(calls).toContain('emptyState.workflow.description')
  })

  it('falls back to the document suggestion set for unknown pane strings', () => {
    const t = (key: string) => key
    const cfg = emptyStateForPane('unknown-pane' as AgentPaneContext, t)
    // The document pane has 3 suggestions, and unknown panes should
    // borrow those keys (not workflow / table / browser / gallery's).
    expect(cfg.suggestions).toHaveLength(3)
    // The keys themselves come from PANE_SUGGESTIONS.document — they are
    // requested under the unknown pane's namespace (so a refactor that
    // shifts the fallback to a different namespace gets noticed here).
    expect(cfg.suggestions[0].label).toBe('emptyState.unknown-pane.suggestions.summarize.label')
  })

  it('produces a distinct suggestion set for each pane (no accidental shadowing)', () => {
    const t = (key: string) => key
    const labelSets = PANES.map((pane) =>
      emptyStateForPane(pane, t)
        .suggestions.map((s) => s.label)
        .join('|'),
    )
    expect(new Set(labelSets).size).toBe(PANES.length)
  })
})
