export type ConfirmOpts = {
  title?: string
  message: string
  confirmLabel?: string
  cancelLabel?: string
  variant?: 'default' | 'destructive'
  /** Optional `data-testid` placed on the dialog content. Lets feature-specific
   *  confirms (e.g. `kitable-table-delete-confirm`) be targeted by e2e tests
   *  without matching by visible text. */
  testId?: string
}

export type ConfirmFn = (opts: ConfirmOpts | string) => Promise<boolean>

export interface ConfirmEntry {
  id: number
  opts: ConfirmOpts
  resolve: (value: boolean) => void
}
