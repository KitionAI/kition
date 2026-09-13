import { act, createElement, type ComponentProps } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentConversation } from './AgentConversation'

vi.mock('@/features/settings/hooks/useDesktopSettings', () => ({
  useDesktopSettings: () => ({ settings: { general: { language: 'en', debug: false } } }),
}))

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

type Props = ComponentProps<typeof AgentConversation>
const imagePath = 'Agent/images/46/Edited poster.png'
const createdAt = '2026-09-09T00:00:00.000Z'
const userMessage = {
  id: 1, session_id: 1, user_id: 1, role: 'user' as const,
  content: 'Edit the poster', status: 'completed', created_at: createdAt,
}

describe('Agent conversation image navigation', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    window.kitionDesktop = { shell: 'electron', backendOrigin: 'http://127.0.0.1:18102' }
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
    delete window.kitionDesktop
  })

  async function mount(extra: Partial<Props>) {
    const onOpenArtifact = vi.fn()
    await act(async () => root.render(createElement(AgentConversation, {
      messages: [userMessage], toolCalls: [], events: [], artifacts: [], busy: false,
      streamingText: '', onOpenPath: vi.fn(), onOpenArtifact, ...extra,
    })))
    return onOpenArtifact
  }

  it.each([false, true])('opens completed tool output in the workspace, with messages=%s', async (hasMessages) => {
    const onOpenArtifact = await mount({
      messages: hasMessages ? [userMessage] : [],
      toolCalls: [{
        id: 2, session_id: 1, user_id: 1, message_id: 1, tool_name: 'image_generation',
        status: 'completed', input_data: {}, output_data: { path: imagePath },
        created_at: createdAt, updated_at: createdAt,
      }],
    })
    const thumbnail = container.querySelector<HTMLButtonElement>('button.agent-tool-image-thumb')!
    expect(thumbnail).not.toBeNull()
    expect(thumbnail.getAttribute('type')).toBe('button')
    expect(thumbnail.querySelector('img')?.src).toBe('http://127.0.0.1:18102/workspace-files/Agent/images/46/Edited%20poster.png')
    await act(async () => thumbnail.click())
    expect(onOpenArtifact).toHaveBeenCalledExactlyOnceWith(imagePath)
    expect(container.querySelector('a.agent-tool-image-thumb')).toBeNull()
  })

  it('opens a runtime image URL using its decoded workspace path', async () => {
    const onOpenArtifact = await mount({
      toolCalls: [{
        id: 2, session_id: 1, user_id: 1, message_id: 1, tool_name: 'image_generation',
        status: 'completed', input_data: {}, output_data: { images: [{
          url: 'http://127.0.0.1:18102/workspace-files/Agent/images/46/Edited%20poster.png',
        }] }, created_at: createdAt, updated_at: createdAt,
      }],
    })
    await act(async () => container.querySelector<HTMLButtonElement>('button.agent-tool-image-thumb')!.click())
    expect(onOpenArtifact).toHaveBeenCalledExactlyOnceWith(imagePath)
  })

  it('opens artifact thumbnails through the same workspace preview callback', async () => {
    const onOpenArtifact = await mount({ artifacts: [{
      id: 3, session_id: 1, user_id: 1, path: imagePath, kind: 'image', title: 'Edited poster',
      created_at: createdAt,
    }] })
    await act(async () => container.querySelector<HTMLButtonElement>('button.agent-tool-image-thumb')!.click())
    expect(onOpenArtifact).toHaveBeenCalledExactlyOnceWith(imagePath)
  })

  it('preserves the source-page link for web image search results', async () => {
    const onOpenArtifact = await mount({ toolCalls: [{
      id: 2, session_id: 1, user_id: 1, message_id: 1, tool_name: 'image_search',
      status: 'completed', input_data: {}, output_data: { images: [{
        url: 'https://example.com/image.png', preview_url: 'https://example.com/preview.png',
        page_url: 'https://example.com/source', title: 'Source image',
      }] }, created_at: createdAt, updated_at: createdAt,
    }] })
    const thumbnail = container.querySelector<HTMLAnchorElement>('a.agent-tool-image-thumb')!
    expect(thumbnail.href).toBe('https://example.com/source')
    expect(thumbnail.target).toBe('_blank')
    expect(thumbnail.querySelector('img')?.src).toBe('https://example.com/preview.png')
    expect(container.querySelector('button.agent-tool-image-thumb')).toBeNull()
    expect(onOpenArtifact).not.toHaveBeenCalled()
  })
})
