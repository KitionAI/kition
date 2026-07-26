import { describe, expect, it } from 'vitest'

import {
  analyzeAgentBrowserIntent,
  buildBrowserAutoContinuePrompt,
  buildBrowserUnavailablePrompt,
  extractAgentWebTarget,
} from './agentBrowserIntent'

describe('analyzeAgentBrowserIntent', () => {
  it('enables the browser and auto-continues a combined web capture task', () => {
    const intent = analyzeAgentBrowserIntent(
      'Open youtube.com in the built-in browser, collect every video card currently loaded on the homepage, and write the results into a new structured table file.',
    )

    expect(intent).toEqual({
      browserEnabled: true,
      continueAfterOpen: true,
    })
  })

  it('auto-continues a non-YouTube page summary task', () => {
    expect(
      analyzeAgentBrowserIntent('Open docs.example.org and summarize the current page'),
    ).toEqual({
      browserEnabled: true,
      continueAfterOpen: true,
    })
  })

  it('enables the browser for a direct research task without an open verb', () => {
    expect(analyzeAgentBrowserIntent('Research example.com and compare its plans')).toEqual({
      browserEnabled: true,
      continueAfterOpen: true,
    })
  })

  it('keeps an open-site request browser-only', () => {
    expect(analyzeAgentBrowserIntent('Open youtube.com')).toEqual({
      browserEnabled: true,
      continueAfterOpen: false,
    })
  })

  it('does not enable browser tools for a table-only instruction', () => {
    expect(analyzeAgentBrowserIntent('Write the supplied data into the table')).toEqual({
      browserEnabled: false,
      continueAfterOpen: false,
    })
  })
})

describe('extractAgentWebTarget', () => {
  it('normalizes a bare domain for browser preflight', () => {
    expect(extractAgentWebTarget('Open youtube.com and summarize the page')).toEqual({
      host: 'youtube.com',
      url: 'https://youtube.com/',
    })
  })

  it('preserves an explicit URL path and removes sentence punctuation', () => {
    expect(extractAgentWebTarget('Inspect https://docs.example.org/guide/start.')).toEqual({
      host: 'docs.example.org',
      url: 'https://docs.example.org/guide/start',
    })
  })

  it('returns null when the prompt has no website target', () => {
    expect(extractAgentWebTarget('Summarize the active document')).toBeNull()
  })
})

describe('buildBrowserAutoContinuePrompt', () => {
  it('preserves the original request in the hidden continuation', () => {
    const prompt = buildBrowserAutoContinuePrompt('Summarize the current documentation page.')

    expect(prompt).toContain('current browser page')
    expect(prompt).toContain('original request as the source of truth')
    expect(prompt).not.toContain('unique key')
    expect(prompt).not.toContain('collected rows')
    expect(prompt).toContain('Original request: Summarize the current documentation page.')
  })

  it('builds an explicit blocker handoff when extraction is unavailable', () => {
    const prompt = buildBrowserUnavailablePrompt('Collect the loaded video cards.')

    expect(prompt).toContain('Report this as a blocker')
    expect(prompt).toContain('Do not fabricate results')
    expect(prompt).toContain('Original request: Collect the loaded video cards.')
  })
})
