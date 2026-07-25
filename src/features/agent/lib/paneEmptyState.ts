// Empty-state copy varies by pane because "Summarize this document"
// makes no sense when the right pane is a workflow editor or a table.
// The strings live under agent.json's `emptyState.<pane>` namespace
// (one suggestion key per card); we materialise them through a t() callable
// so locale switches actually update the panel.
//
// This module is split out from AgentChatPanel.tsx so the per-pane
// suggestion set can be unit-tested without rendering the whole panel.

import type { AgentPaneContext } from '@/api/agent'

// Re-export so existing imports (`from './paneEmptyState'`) keep working
// without changing every call site that resolves AgentPaneContext from
// the UI layer.
export type { AgentPaneContext }

export type AgentEmptySuggestion = { label: string; prompt: string }
export type AgentEmptyStateConfig = { description: string; suggestions: AgentEmptySuggestion[] }

// PANE_SUGGESTIONS is the source of truth for which suggestion cards each pane
// renders. Updating a pane's suggestion set means changing this map AND
// adding the matching `emptyState.<pane>.suggestions.<key>.{label,prompt}`
// keys in agent.json — the unit test in paneEmptyState.spec.ts verifies
// both halves stay in sync.
export const PANE_SUGGESTIONS: Record<AgentPaneContext, readonly string[]> = {
  document: ['summarize', 'launchPlan', 'checklist'],
  workflow: ['emailOnRecord', 'remindOnDate', 'refine'],
  table: ['addStatusColumn', 'summarizeTable', 'fillCells'],
  browser: ['summarizePage', 'extractTable', 'saveAsNote'],
  // browserSites is the browser sites list (no page loaded), so the
  // page-action suggestions that work for the 'browser' pane don't fit.
  // These suggestions are about discovering / managing browser sessions.
  browserSites: ['addSite', 'showConnected', 'setupCustom'],
  gallery: ['describeEach', 'groupByTopic', 'pickHero'],
}

export function emptyStateForPane(
  pane: AgentPaneContext,
  t: (key: string, opts?: Record<string, unknown>) => string,
): AgentEmptyStateConfig {
  const suggestionKeys = PANE_SUGGESTIONS[pane] || PANE_SUGGESTIONS.document
  const suggestions: AgentEmptySuggestion[] = suggestionKeys.map((key) => ({
    label: t(`emptyState.${pane}.suggestions.${key}.label`),
    prompt: t(`emptyState.${pane}.suggestions.${key}.prompt`),
  }))
  return {
    description: t(`emptyState.${pane}.description`),
    suggestions,
  }
}
