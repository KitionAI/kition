import request from '@/api/request'

export const CONNECTIONS_CHANGED_EVENT = 'kition:connections:changed'

function notifyConnectionsChanged(detail: { connectionId?: string; source: string }) {
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(CONNECTIONS_CHANGED_EVENT, { detail }))
  }
}

export type ChannelField = {
  key: string
  label: string
  type: 'text' | 'number' | 'select' | 'secret' | 'email' | string
  required?: boolean
  default?: unknown
  options?: Array<{ value: string; label: string }>
  helpText?: string
}

export type ChannelSchema = {
  channel: string
  label: string
  icon: string
  description: string
  auth: string
  fields: ChannelField[]
}

export type ConnectionView = {
  id: string
  channel: string
  name: string
  settings: Record<string, unknown>
  status: 'pending' | 'active' | 'invalid' | string
  lastVerifiedAt?: string
  lastErrorCode?: string
  lastErrorMessage?: string
  usedByCount?: number
  createdAt: string
  updatedAt: string
}

export type SaveConnectionInput = {
  channel: string
  name: string
  settings: Record<string, unknown>
  secrets?: Record<string, string>
}

export type TestConnectionResult = {
  ok: boolean
  latencyMs?: number
  message?: string
  errorCode?: string
}

export function listChannels() {
  return request.get<ChannelSchema[]>('/v1/channels').then((response) => (
    Array.isArray(response) ? response : []
  ))
}

export function listConnections() {
  return request.get<{ items?: ConnectionView[] }>('/v1/connections').then((response) => (
    Array.isArray(response?.items) ? response.items : []
  ))
}

export function createConnection(input: SaveConnectionInput) {
  return request.post<ConnectionView>('/v1/connections', input).then((connection) => {
    notifyConnectionsChanged({ connectionId: connection.id, source: 'create' })
    return connection
  })
}

export function updateConnection(id: string, input: Partial<SaveConnectionInput>) {
  return request.patch<ConnectionView>(`/v1/connections/${id}`, input).then((connection) => {
    notifyConnectionsChanged({ connectionId: connection.id || id, source: 'update' })
    return connection
  })
}

export function deleteConnection(id: string, options?: { force?: boolean }) {
  const qs = options?.force ? '?force=true' : ''
  return request.delete<void>(`/v1/connections/${id}${qs}`).then((result) => {
    notifyConnectionsChanged({ connectionId: id, source: 'delete' })
    return result
  })
}

export function testConnection(id: string) {
  return request.post<TestConnectionResult>(`/v1/connections/${id}/test`, {}).then((result) => {
    notifyConnectionsChanged({ connectionId: id, source: 'test' })
    return result
  })
}
