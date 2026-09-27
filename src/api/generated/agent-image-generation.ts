/* eslint-disable */
/**
 * GENERATED FILE. Do not edit.
 * Source: contracts/runtime/agent-image-generation.schema.json
 * Regenerate with: pnpm run contracts:generate
 */

export type AgentImageGenerationIdentifier = string

export type AgentImageGenerationPortablePath = string

export type AgentImageGenerationLocale = string

export type AgentImageGenerationAspectRatio = "1:1" | "16:9" | "9:16" | "4:3" | "3:4" | "2:3" | "3:2"

/**
 * Review generated images in the current Agent session without an open editor. Requires agent_image_generation_chat_v1 and placement_preference=review.
 */
export type AgentImageGenerationChatTarget = {
  type: "image.target.chat"
}

export type AgentImageGenerationDocumentTarget = {
  type: "image.target.document"
  document_path: AgentImageGenerationPortablePath
  document_format?: string
  cursor_offset?: number
  selected_image_path?: AgentImageGenerationPortablePath
  target_revision?: string
}

export type AgentImageGenerationTableTarget = {
  type: "image.target.table"
  data_document_id: number
  table_id: number
  record_ids?: number[]
  attachment_field_id?: number
  target_revision?: string
}

export type AgentImageGenerationWhiteboardTarget = {
  type: "image.target.whiteboard"
  board_path: AgentImageGenerationPortablePath
  selected_element_ids?: AgentImageGenerationIdentifier[]
  replace_element_id?: AgentImageGenerationIdentifier
  viewport_center?: {
    x: number
    y: number
  }
  target_revision?: string
}

/**
 * Generate and edit operations use the provider's configured image-capable model independently of the conversation's runtime_model.model_name. Clients keep the selected chat model unchanged; selecting a text-only chat model must not prevent image generation or editing.
 */
export type AgentImageGenerationIntent = (unknown) & (unknown) & (unknown) & (unknown) & (unknown)

export type AgentImageGenerationProvenance = {
  request_id: AgentImageGenerationIdentifier
  template_id?: AgentImageGenerationIdentifier
  template_version?: AgentImageGenerationIdentifier
  model_id?: string
  provider_class?: "kition_cloud" | "connected_provider" | "local_provider"
  prompt_sha256?: string
  source_paths?: AgentImageGenerationPortablePath[]
}

export type AgentImageGenerationArtifact = {
  id: number
  path: AgentImageGenerationPortablePath
  mime_type: string
  title?: string
  width?: number
  height?: number
  variant_index: number
  variant_count: number
  created_at: string
  provenance: AgentImageGenerationProvenance
}

export type AgentImageGenerationError = {
  code: string
  message: string
  retryable: boolean
}

export type AgentImageGenerationEvent = (unknown) & (unknown) & (unknown)

/**
 * Typed image-generation intents and stream events shared by Agent conversations across documents, tables, and Boards.
 */
export type AgentImageGenerationContract = AgentImageGenerationIntent | AgentImageGenerationEvent
