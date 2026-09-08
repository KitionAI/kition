export const AGENT_IMAGE_GENERATION_CAPABILITY = 'agent_image_generation_v1' as const
export const AGENT_IMAGE_GENERATION_SCHEMA_VERSION = 1 as const
export const AGENT_IMAGE_GENERATION_CLIENT_CAPABILITY_VERSION = 1 as const
export const AGENT_IMAGE_GENERATION_MAX_VARIANTS = 5 as const
export const AGENT_IMAGE_GENERATION_MAX_REFERENCES = 8 as const
export const AGENT_IMAGE_GENERATION_EVENT_NAMES = [
  'image_generation.accepted',
  'image_generation.progress',
  'image_generation.artifact',
  'image_generation.completed',
  'image_generation.failed',
  'image_generation.canceled',
] as const
export const AGENT_IMAGE_GENERATION_STATUSES = [
  'queued',
  'generating',
  'saving',
  'completed',
  'failed',
  'canceled',
] as const

export type AgentImageGenerationOperation = 'generate' | 'edit'
export type AgentImageGenerationSurface = 'document' | 'table' | 'whiteboard'
export type AgentImageGenerationAspectRatio =
  | '1:1'
  | '16:9'
  | '9:16'
  | '4:3'
  | '3:4'
  | '2:3'
  | '3:2'
export type AgentImageGenerationQuality = 'low' | 'medium' | 'high'
export type AgentImageGenerationResolution = '1K' | '2K' | '4K'
export type AgentImageGenerationTextMode = 'editable_overlay' | 'baked_text' | 'no_text'
export type AgentImageGenerationPlacementPreference = 'review' | 'insert' | 'replace'

export type AgentImageDocumentTarget = {
  type: 'image.target.document'
  document_path: string
  document_format?: string
  cursor_offset?: number
  selected_image_path?: string
  target_revision?: string
}

export type AgentImageTableTarget = {
  type: 'image.target.table'
  data_document_id: number
  table_id: number
  record_ids?: number[]
  attachment_field_id?: number
  target_revision?: string
}

export type AgentImageWhiteboardTarget = {
  type: 'image.target.whiteboard'
  board_path: string
  selected_element_ids?: string[]
  replace_element_id?: string
  viewport_center?: { x: number; y: number }
  target_revision?: string
}

export type AgentImageTarget =
  | AgentImageDocumentTarget
  | AgentImageTableTarget
  | AgentImageWhiteboardTarget

export type AgentImageGenerationIntent = {
  type: 'image_generation.intent'
  schema_version: typeof AGENT_IMAGE_GENERATION_SCHEMA_VERSION
  request_id: string
  operation: AgentImageGenerationOperation
  instruction: string
  locale: string
  template_id?: string
  template_version?: string
  template_variables?: Record<string, string>
  aspect_ratio: AgentImageGenerationAspectRatio
  quality: AgentImageGenerationQuality
  resolution: AgentImageGenerationResolution
  variants: number
  text_mode: AgentImageGenerationTextMode
  exact_text?: string
  reference_paths: string[]
  surface: AgentImageGenerationSurface
  target: AgentImageTarget
  placement_preference: AgentImageGenerationPlacementPreference
  client_capability_version: typeof AGENT_IMAGE_GENERATION_CLIENT_CAPABILITY_VERSION
}

export type AgentImageArtifactProvenance = {
  request_id: string
  template_id?: string
  template_version?: string
  model_id?: string
  provider_class?: 'kition_cloud' | 'connected_provider' | 'local_provider'
  prompt_sha256?: string
  source_paths?: string[]
}

export type AgentImageArtifact = {
  id: number
  path: string
  mime_type: string
  title?: string
  width?: number
  height?: number
  variant_index: number
  variant_count: number
  created_at: string
  provenance: AgentImageArtifactProvenance
}

export type AgentImageGenerationEventName = typeof AGENT_IMAGE_GENERATION_EVENT_NAMES[number]
export type AgentImageGenerationStatus = typeof AGENT_IMAGE_GENERATION_STATUSES[number]

export type AgentImageGenerationEvent = {
  type: 'image_generation.event'
  schema_version: typeof AGENT_IMAGE_GENERATION_SCHEMA_VERSION
  request_id: string
  event: AgentImageGenerationEventName
  status: AgentImageGenerationStatus
  progress?: number
  message?: string
  artifact?: AgentImageArtifact
  artifact_count?: number
  error?: {
    code: string
    message: string
    retryable: boolean
  }
}
