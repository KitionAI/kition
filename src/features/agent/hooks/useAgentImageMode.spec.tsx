import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getImageTemplate } from '@/features/media-generation/api/imageTemplates'
import type { ImageTemplateSummary } from '@/features/media-generation/lib/imageTemplateContract'
import type { AgentImageArtifact } from '@/types/imageGeneration'
import { useAgentImageMode, type AgentImageMode } from './useAgentImageMode'

vi.mock('@/features/media-generation/api/imageTemplates', () => ({ getImageTemplate: vi.fn() }))
;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
let root: Root | undefined
let container: HTMLDivElement
let mode: AgentImageMode
let props: Parameters<typeof useAgentImageMode>[0]
function Harness() { mode = useAgentImageMode(props); return null }
async function render() { await act(async () => root!.render(<Harness />)) }
async function setup(extra: Partial<typeof props> = {}) {
  props = {
    sessionId: 25, available: true, target: { type: 'image.target.document', document_path: 'Notes.md' },
    referencePaths: [], draft: 'A calm product poster', busy: false, canSend: true,
    onSend: vi.fn(), onDraftChange: vi.fn(), ...extra,
  }
  container = document.createElement('div')
  root = createRoot(container)
  await render()
  await act(async () => mode.setEnabled(true))
}
afterEach(async () => { await act(async () => root?.unmount()); root = undefined; vi.clearAllMocks() })
const template: ImageTemplateSummary = {
  id: 'launch', version: '2', title: 'Launch poster', description: 'A calm launch.', operation: 'generate', category: 'poster',
  thumbnail: { url: 'https://kition.ai/launch.webp', width: 240, height: 320 },
  default_aspect_ratio: '3:4', default_quality: 'medium', default_resolution: '1K', default_text_mode: 'no_text',
  requires_reference_image: false, access: 'public', variables: [{ key: 'subject', label: 'Subject', required: true, multiline: false }], tags: [],
}

describe('Agent image composer', () => {
  it('submits a complete template without requiring an additional chat draft', async () => {
    await setup({ draft: '' })
    vi.mocked(getImageTemplate).mockResolvedValue(template)
    await act(async () => mode.selectTemplate(template))
    await act(async () => mode.send())
    expect(props.onSend).not.toHaveBeenCalled()
    await act(async () => mode.setVariables({ subject: 'A ceramic vase' }))
    await act(async () => mode.send())
    expect(props.onSend).toHaveBeenCalledWith(expect.objectContaining({ instruction: 'Launch poster\nA ceramic vase' }))
  })

  it('blocks an empty freeform request and respects composer guards for templates', async () => {
    await setup({ draft: '' })
    await act(async () => mode.send())
    expect(props.onSend).not.toHaveBeenCalled()
    await act(async () => mode.selectTemplate({ ...template, variables: [] }))
    props = { ...props, canSend: false }
    await render()
    await act(async () => mode.send())
    expect(props.onSend).not.toHaveBeenCalled()
  })
  it.each([
    { type: 'image.target.document' as const, document_path: 'Notes.md' },
    { type: 'image.target.table' as const, data_document_id: 4, table_id: 12 },
    { type: 'image.target.whiteboard' as const, board_path: 'Ideas.kiboard' },
  ])('sends freeform review intents for $type without a catalog request', async (target) => {
    await setup({ target })
    await act(async () => mode.send())
    expect(props.onSend).toHaveBeenCalledWith(expect.objectContaining({
      instruction: props.draft, target, placement_preference: 'review', reference_paths: [],
      request_id: expect.any(String), type: 'image_generation.intent',
    }))
    expect(getImageTemplate).not.toHaveBeenCalled()
  })

  it('preserves text when toggling mode and blocks unsupported runtimes', async () => {
    await setup({ available: false })
    await act(async () => mode.send())
    expect(props.onSend).not.toHaveBeenCalled()
    expect(mode.blockedReason).toContain('updated runtime')
    await act(async () => mode.setEnabled(false))
    expect(props.onDraftChange).not.toHaveBeenCalled()
    await act(async () => mode.send())
    expect(props.onSend).toHaveBeenCalledWith()
  })

  it('requires variables and revalidates the pinned version on each send and retry', async () => {
    await setup()
    vi.mocked(getImageTemplate).mockResolvedValue(template)
    await act(async () => mode.selectTemplate(template))
    await act(async () => mode.send())
    expect(props.onSend).not.toHaveBeenCalled()
    await act(async () => mode.setVariables({ subject: 'Kition' }))
    await act(async () => mode.send())
    const intent = vi.mocked(props.onSend).mock.calls[0][0]!
    expect(intent).toMatchObject({ template_id: 'launch', template_version: '2', template_variables: { subject: 'Kition' }, aspect_ratio: '3:4' })
    await act(async () => mode.selectTemplate(undefined))
    await act(async () => mode.retry(intent.request_id))
    expect(mode.template?.version).toBe('2')
    expect(mode.variables).toEqual({ subject: 'Kition' })
    await act(async () => mode.send())
    expect(getImageTemplate).toHaveBeenCalledTimes(2)
    expect(vi.mocked(props.onSend).mock.calls[1][0]?.request_id).not.toBe(intent.request_id)
    await act(async () => mode.selectTemplate(undefined))
    props = { ...props, draft: 'A revised freeform request' }
    await render()
    await act(async () => mode.send())
    const revised = vi.mocked(props.onSend).mock.calls[2][0]!
    expect(revised.instruction).toBe('A revised freeform request')
    expect(revised.template_id).toBeUndefined()
    expect(revised.template_version).toBeUndefined()
  })

  it('keeps the draft after catalog failure and allows clearing to freeform', async () => {
    await setup()
    vi.mocked(getImageTemplate).mockRejectedValue(new Error('Offline'))
    await act(async () => mode.selectTemplate({ ...template, variables: [] }))
    await act(async () => mode.send())
    expect(mode.error).toContain('could not be verified')
    expect(props.onSend).not.toHaveBeenCalled()
    expect(props.onDraftChange).not.toHaveBeenCalled()
    await act(async () => mode.selectTemplate(undefined))
    await act(async () => mode.send())
    expect(props.onSend).toHaveBeenCalledTimes(1)
  })

  it('cancels pending template validation when the active target changes', async () => {
    await setup()
    let finish!: (value: ImageTemplateSummary) => void
    vi.mocked(getImageTemplate).mockImplementation(() => new Promise((resolve) => { finish = resolve }))
    await act(async () => mode.selectTemplate({ ...template, variables: [] }))
    let sending!: Promise<void>
    await act(async () => { sending = mode.send() })
    props = { ...props, target: { type: 'image.target.document', document_path: 'Other.md' } }
    await render()
    await act(async () => { finish(template); await sending })
    expect(props.onSend).not.toHaveBeenCalled()
    expect(mode.preparing).toBe(false)
  })

  it('references a reviewed artifact for follow-up editing', async () => {
    await setup()
    await act(async () => mode.edit({ path: 'Agent/generated.png' } as AgentImageArtifact))
    await act(async () => mode.send())
    expect(props.onSend).toHaveBeenCalledWith(expect.objectContaining({ operation: 'edit', reference_paths: ['Agent/generated.png'] }))
  })
  it('restores the original references when reusing settings and allows removing them', async () => {
    await setup({ referencePaths: ['Attachments/reference.png'] })
    await act(async () => mode.send())
    const intent = vi.mocked(props.onSend).mock.calls[0][0]!
    props = { ...props, referencePaths: [] }
    await render()
    await act(async () => mode.retry(intent.request_id))
    expect(mode.referencePaths).toEqual(['Attachments/reference.png'])
    await act(async () => mode.removeReference('Attachments/reference.png'))
    expect(mode.referencePaths).toEqual([])
  })

})
