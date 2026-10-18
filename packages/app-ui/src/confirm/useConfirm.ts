import { useContext } from 'react'

import { ConfirmContext } from './ConfirmProvider'
import type { ConfirmFn } from './types'

export function useConfirm(): ConfirmFn {
  const ctx = useContext(ConfirmContext)
  if (!ctx) {
    throw new Error('useConfirm must be used inside <ConfirmProvider>')
  }
  return ctx.confirm
}
