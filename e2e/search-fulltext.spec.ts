import { test } from '@playwright/test'

// Phase J — Task 35 follow-up
//
// The plan called for three Playwright specs covering:
//   1. full-text search happy path (notes + Kitable)
//   2. operator coverage (file:/kitable:/field:/task-todo:/regex:)
//   3. vault switch isolation
//
// Implementing them required infrastructure that does NOT yet exist:
//   - openDemoVault helper (no markdown vault fixture in e2e/)
//   - two-vault switch plumbing (no spec exercises SetActiveVault)
//   - sidebar-tab-search interaction helpers
//
// All search components now carry data-testid attributes so a future
// follow-up PR only needs to build the vault fixture + helpers, not
// also retrofit selectors.
//
// Tracking: see PR description "Deferred follow-ups" section.

test.skip('search-fulltext suite (deferred — see file header)', () => {})
