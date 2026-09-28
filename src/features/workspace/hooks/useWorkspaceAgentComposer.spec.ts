import { act, createElement, useEffect } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mockChooseDirectory = vi.fn()
vi.mock('@/services/desktop', () => ({
  chooseAgentAnalysisDirectory: (...args: unknown[]) => mockChooseDirectory(...args),
  getApiBaseURL: () => '',
}))

import type { AgentLocalSource, AgentSession } from '@/api/agent'

import { useWorkspaceAgentComposer } from './useWorkspaceAgentComposer'

type Options = Parameters<typeof useWorkspaceAgentComposer>[0]
type Api = ReturnType<typeof useWorkspaceAgentComposer>

const session = { id: 7, title: 'Chat' } as AgentSession
const folder: AgentLocalSource = { id: 'src-1', label: 'reports', root_path: '/data/reports', access: 'read' }

let container: HTMLDivElement
let root: Root | null = null

function Harness({ options, onReady }: { options: Options; onReady: (api: Api) => void }) {
  const api = useWorkspaceAgentComposer(options)
  useEffect(() => onReady(api), [api, onReady])
  return null
}

async function mount(overrides: Partial<Options> = {}) {
  const calls = { addAgentLocalSource: vi.fn(), sendAiComposerMessage: vi.fn(), setError: vi.fn() }
  const options: Options = {
    activeSession: session,
    agentDrafts: { 7: 'Summarize /data/reports please' },
    agentLocalSources: {},
    ...calls,
    ...overrides,
  }
  let api: Api | null = null
  await act(async () => {
    root!.render(createElement(Harness, { options, onReady: (value) => { api = value } }))
  })
  return { api: api!, calls }
}

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  mockChooseDirectory.mockReset()
})

afterEach(async () => {
  await act(async () => root?.unmount())
  root = null
  container.remove()
})

describe('useWorkspaceAgentComposer', () => {
  it('asks for the referenced folder and sends with it attached', async () => {
    mockChooseDirectory.mockResolvedValue(folder)
    const { api, calls } = await mount()

    await act(async () => { await api.sendMessage(7) })

    expect(mockChooseDirectory).toHaveBeenCalledWith('/data/reports')
    expect(calls.addAgentLocalSource).toHaveBeenCalledWith(7, folder)
    expect(calls.sendAiComposerMessage).toHaveBeenCalledWith(7, [folder], undefined)
  })

  it('drops the send when the user cancels the folder picker', async () => {
    mockChooseDirectory.mockResolvedValue(null)
    const { api, calls } = await mount()

    await act(async () => { await api.sendMessage(7) })

    expect(calls.sendAiComposerMessage).not.toHaveBeenCalled()
  })

  it('sends plainly when a source is already attached or nothing is referenced', async () => {
    const attached = await mount({ agentLocalSources: { 7: [folder] } })
    await act(async () => { await attached.api.sendMessage(7, { instruction: 'draw' } as never) })
    expect(mockChooseDirectory).not.toHaveBeenCalled()
    expect(attached.calls.sendAiComposerMessage).toHaveBeenCalledWith(7, undefined, { instruction: 'draw' })

    const plain = await mount({ agentDrafts: { 7: 'hello' } })
    await act(async () => { await plain.api.sendMessage(7) })
    expect(plain.calls.sendAiComposerMessage).toHaveBeenCalledWith(7, undefined, undefined)
  })

  it('reports picker failures and ignores the request without a session', async () => {
    mockChooseDirectory.mockRejectedValue(new Error('denied'))
    const failing = await mount()
    await act(async () => { expect(await failing.api.addLocalAnalysisSource()).toBeNull() })
    expect(failing.calls.setError).toHaveBeenCalledWith('denied')

    const noSession = await mount({ activeSession: null })
    await act(async () => { expect(await noSession.api.addLocalAnalysisSource()).toBeNull() })
  })
})
