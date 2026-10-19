import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import { AGENT_PEER_COLOR, setDocumentCollab, setDocumentPeers, useDocumentCollab } from './collabStore'
import { PresenceAvatars } from './PresenceAvatars'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const PATH = 'Shared/Plan.kitionslide'
let root: Root | null = null
let container: HTMLDivElement

function Tab() {
  const collab = useDocumentCollab(PATH)
  return createElement(PresenceAvatars, { peers: collab?.peers ?? [] })
}

async function mount() {
  container = document.createElement('div')
  document.body.appendChild(container)
  await act(async () => {
    root = createRoot(container)
    root.render(createElement(Tab))
  })
}

const avatars = () => [...container.querySelectorAll<HTMLElement>('[data-testid="collab-peer"]')].map((avatar) => [avatar.dataset.peer, avatar.dataset.agent ?? null, avatar.style.backgroundColor])

afterEach(async () => {
  await act(async () => root?.unmount())
  root = null
  container?.remove()
  setDocumentCollab(PATH, null)
})

describe('agents in presence', () => {
  it('shows each agent editing a shared document as a peer of its own, beside the people', async () => {
    setDocumentCollab(PATH, { docId: 'd', peers: [] })
    await mount()
    const me = { principalId: 'u:me', name: 'Me', color: '#0ea5e9', state: { kit: 'kit.slide' } }
    const bob = { principalId: 'u:bob', name: 'Bob', color: '#e11d48', state: { kit: 'kit.slide', agent: { name: 'Agent', origin: 'agent' } } }
    await act(async () => setDocumentPeers(PATH, [me, bob, bob], 'u:me'))
    expect(avatars()).toEqual([
      ['Bob', null, 'rgb(225, 29, 72)'],
      ['Agent', 'true', 'rgb(86, 69, 212)'],
    ])
    expect(AGENT_PEER_COLOR).toBe('#5645d4')
    expect(container.querySelector('[data-agent="true"]')?.className).toContain('collab-presence-avatar--agent')

    // This person's own agent shows too; an agent state without a name gets the default one.
    await act(async () => setDocumentPeers(PATH, [{ ...me, state: { kit: 'kit.slide', agent: { name: '' } } }], 'u:me'))
    expect(avatars()).toEqual([['Agent', 'true', 'rgb(86, 69, 212)']])
    // The agent leaves when its presence state no longer carries it.
    await act(async () => setDocumentPeers(PATH, [me], 'u:me'))
    expect(avatars()).toEqual([])
  })
})
