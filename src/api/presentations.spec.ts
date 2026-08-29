import { beforeEach, describe, expect, it, vi } from 'vitest'

import request from './request'
import { inspectPresentation, renderPresentation } from './presentations'
import {
  PRESENTATION_DOCUMENT_TYPE,
  PRESENTATION_DOCUMENT_VERSION,
  PRESENTATION_MIME_TYPE,
  PRESENTATION_WIDE_SIZE,
  runtimeSupportsPresentationOOXML,
} from '@/features/presentation/lib/presentationTypes'
import type { PresentationDocument } from '@/features/presentation/lib/presentationTypes'

vi.mock('./request', () => ({
  default: {
    post: vi.fn(),
  },
}))

const document: PresentationDocument = {
  type: PRESENTATION_DOCUMENT_TYPE,
  schema_version: PRESENTATION_DOCUMENT_VERSION,
  title: 'Roadmap',
  slide_size: { ...PRESENTATION_WIDE_SIZE },
  slides: [{ id: 'slide:1', name: 'Slide 1', index: 0, elements: [] }],
  assets: [],
}

describe('presentation API', () => {
  beforeEach(() => vi.clearAllMocks())

  it('inspects a workspace PPTX using the versioned presentation endpoint', async () => {
    const response = { document, warnings: [] }
    vi.mocked(request.post).mockResolvedValue({ data: response })

    await expect(inspectPresentation({ workspace_path: 'Decks/Roadmap.pptx' }))
      .resolves.toEqual(response)
    expect(request.post).toHaveBeenCalledWith('/v1/presentations/inspect', {
      workspace_path: 'Decks/Roadmap.pptx',
    })
  })

  it('renders a semantic presentation document to a workspace PPTX', async () => {
    const response = {
      path: 'Decks/Roadmap.pptx',
      mime_type: PRESENTATION_MIME_TYPE,
      slide_count: 1,
      warnings: [],
    }
    vi.mocked(request.post).mockResolvedValue(response)

    await expect(renderPresentation({
      document,
      target_path: 'Decks/Roadmap.pptx',
    })).resolves.toEqual(response)
    expect(request.post).toHaveBeenCalledWith('/v1/presentations/render', {
      document,
      target_path: 'Decks/Roadmap.pptx',
    })
  })

  it('gates OOXML behavior behind the runtime capability', () => {
    expect(runtimeSupportsPresentationOOXML()).toBe(false)
    expect(runtimeSupportsPresentationOOXML(['presentation_ooxml_v1'])).toBe(true)
  })
})
