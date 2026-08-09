import { describe, expect, it } from 'vitest'

import { commandItemVariants } from './command'

describe('commandItemVariants', () => {
  it('shows a pointer cursor for interactive command items', () => {
    expect(commandItemVariants()).toContain('cursor-pointer')
    expect(commandItemVariants()).not.toContain('cursor-default')
  })
})
