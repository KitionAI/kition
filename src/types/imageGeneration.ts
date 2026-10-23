import type { AgentImageGenerationArtifact } from '@/api/generated/agent-image-generation'

export const AGENT_IMAGE_GENERATION_CAPABILITY = 'agent_image_generation_v1' as const
export const AGENT_IMAGE_GENERATION_CHAT_CAPABILITY = 'agent_image_generation_chat_v1' as const
export const AGENT_IMAGE_GENERATION_SCHEMA_VERSION = 1 as const
export const AGENT_IMAGE_GENERATION_CLIENT_CAPABILITY_VERSION = 1 as const
export const AGENT_IMAGE_GENERATION_MAX_VARIANTS = 5 as const
export const AGENT_IMAGE_GENERATION_MAX_REFERENCES = 8 as const

export type AgentImageGenerationOperation = 'generate' | 'edit'
export type AgentImageGenerationSurface = 'document' | 'whiteboard' | 'design' | 'chat'
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

export type AgentImageWhiteboardTarget = {
  type: 'image.target.whiteboard'
  board_path: string
  selected_element_ids?: string[]
  replace_element_id?: string
  viewport_center?: { x: number; y: number }
  target_revision?: string
}

type AgentImageDesignTarget = {
  type: 'image.target.design'
  design_path: string
  artboard?: { width: number; height: number }
  replace_layer_id?: string
  target_revision?: string
}

export type AgentImageTarget =
  | { type: 'image.target.chat' }
  | AgentImageDocumentTarget
  | AgentImageWhiteboardTarget
  | AgentImageDesignTarget

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

/** A saved image variant (`agent-image-generation.schema.json#/$defs/artifact`). */
export type AgentImageArtifact = AgentImageGenerationArtifact
