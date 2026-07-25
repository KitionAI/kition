// Minimal types for the surface used by the canvas grid.

export interface IUser {
  id: string
  name: string
  avatar?: string | null
  email?: string
}

export interface IRecord {
  id: string
  fields?: Record<string, unknown>
  [key: string]: unknown
}

export interface IButtonClickStatusHook {
  checkLoading?: (fieldId: string, recordId: string) => boolean
  buttonClick: (payload: {
    tableId?: string
    recordId: string
    fieldId: string
    name?: string
    confirm?: { title?: string; description?: string; confirmText?: string } | null
    record?: IRecord
  }) => void | Promise<void>
}
