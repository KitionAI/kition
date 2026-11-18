import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { CreditUsageBadge } from './CreditUsageBadge'

let container: HTMLDivElement
let root: Root | null = null

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
})

afterEach(async () => {
  await act(async () => {
    root?.unmount()
  })
  root = null
  container.remove()
})

describe('CreditUsageBadge', () => {
  it('keeps the compact balance visible without the credits unit', async () => {
    await act(async () => {
      root = createRoot(container)
      root.render(createElement(CreditUsageBadge, {
        creditBalance: 1_995_883,
        creditTotal: 2_000_200,
        variant: 'compact',
      }))
      await Promise.resolve()
    })

    expect(container.querySelector('.credit-usage-card__amount')?.textContent).toBe('1,995,883')
    expect(container.querySelector('.credit-usage-card__unit')).toBeNull()
  })
})
