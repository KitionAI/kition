import request from './request'
import type { DataDocument } from '@/types/dataDocument'

export type TemplateResourceKind = 'app' | 'automation' | 'dashboard' | 'table'

export type InstantiateTemplatePayload = {
  workspace_root: string
  path: string
  include_data?: boolean
}

export type InstantiatedTemplateResource = {
  source_id: string
  target_id: string
  kind: TemplateResourceKind
  title: string
  path?: string
  dashboard_id?: string
  table_id?: number
}

export type InstantiateTemplateResult = {
  template_id: string
  snapshot_version: number
  document: DataDocument
  default_resource: InstantiatedTemplateResource
  resources: InstantiatedTemplateResource[]
}

function unwrapResponseData<T>(response: T | { data?: T }) {
  return (response as { data?: T })?.data ?? (response as T)
}

export function instantiateTemplatePackage(templateId: string, payload: InstantiateTemplatePayload) {
  return request
    .post<InstantiateTemplateResult | { data?: InstantiateTemplateResult }>(
      `/v1/templates/${encodeURIComponent(templateId)}/instantiate`,
      payload,
    )
    .then(unwrapResponseData<InstantiateTemplateResult>)
}
