import type {
  AgentImageGenerationAspectRatio,
  AgentImageGenerationOperation,
  AgentImageGenerationQuality,
  AgentImageGenerationResolution,
  AgentImageGenerationSurface,
  AgentImageGenerationTextMode,
} from '@/types/imageGeneration'

export type ImageTemplateAccess = 'public' | 'account' | 'premium'

export type ImageTemplateSummary = {
  id: string
  version: string
  title: string
  description: string
  operation: AgentImageGenerationOperation
  category: string
  thumbnail: {
    url: string
    width: number
    height: number
    blurhash?: string
  }
  default_aspect_ratio: AgentImageGenerationAspectRatio
  default_quality: AgentImageGenerationQuality
  default_resolution: AgentImageGenerationResolution
  default_text_mode: AgentImageGenerationTextMode
  requires_reference_image: boolean
  access: ImageTemplateAccess
  variables: Array<{
    key: string
    label: string
    placeholder?: string
    required: boolean
    multiline: boolean
  }>
  tags: string[]
  source?: {
    license: string
    label: string
    url?: string
  }
}

export type ImageTemplateCatalogResponse = {
  catalog_revision: string
  total_count?: number
  next_cursor?: string
  items: ImageTemplateSummary[]
}

export type ImageTemplateCatalogQuery = {
  accessToken?: string
  cursor?: string
  endpoint?: string
  hasReferenceImage?: boolean
  hasSelectionText?: boolean
  limit?: number
  locale: string
  operation?: AgentImageGenerationOperation
  query?: string
  signal?: AbortSignal
  surface: AgentImageGenerationSurface
}
