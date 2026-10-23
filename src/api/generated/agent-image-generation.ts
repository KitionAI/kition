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
 * Place generated images on one design artboard. The client sizes the image to the artboard and, for editable_overlay text, adds the exact text as a separate text layer.
 */
export type AgentImageGenerationDesignTarget = {
  type: "image.target.design"
  design_path: AgentImageGenerationPortablePath
  artboard?: {
    width: number
    height: number
  }
  replace_layer_id?: AgentImageGenerationIdentifier
  target_revision?: string
}

/**
 * Generate and edit operations use the provider's configured image-capable model independently of the conversation's runtime_model.model_name. Clients keep the selected chat model unchanged; selecting a text-only chat model must not prevent image generation or editing.
 */
export type AgentImageGenerationIntent = (unknown) & (unknown) & (unknown) & (unknown)

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
  call_id: string
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

/**
 * The arguments of the image_generation tool/call for one variant of a request.
 */
export type AgentImageGenerationVariantCall = {
  request_id: AgentImageGenerationIdentifier
  intent_sha256: string
  variant_index: number
  variant_count: number
  size: string
  quality: "low" | "medium" | "high"
  template_id?: AgentImageGenerationIdentifier
  reference_count: number
}

/**
 * The meta of a successful image_generation tool/result: the saved variant.
 */
export type AgentImageGenerationVariantMeta = {
  kind: "image_generation.variant"
  request_id: AgentImageGenerationIdentifier
  artifact: AgentImageGenerationArtifact
}

/**
 * Typed image-generation intents shared by Agent conversations across documents, Boards, designs, and chat, and how the runtime logs them: an image composer request is one session turn (agent-session-events.schema.json) whose variant i is a tool/call named image_generation with variantCall arguments and call id img_<first 24 hex of sha256(request_id)>_<i>, settled by a tool/result whose value is the artifact and whose meta is variantMeta (success, followed by deliverables/presented), or by a tool/result with isError whose content is the message and the error as JSON. A request id names one set of settings and is handled once: a repeat with the same settings changes nothing, even when the earlier attempt failed or was cancelled (retry with a new request id), and other settings are refused with HTTP 409.
 */
export type AgentImageGenerationContract = AgentImageGenerationIntent | AgentImageGenerationVariantCall | AgentImageGenerationVariantMeta
