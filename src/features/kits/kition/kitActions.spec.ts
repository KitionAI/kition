import { describe, expect, it, vi } from 'vitest'

const settings = { models: { activeProvider: 'kition_console' } }
vi.mock('@/services/desktopSettings', () => ({ loadDesktopSettings: async () => settings }))
const restorePortalAccountSession = vi.fn()
vi.mock('@/services/portalAccount', () => ({ restorePortalAccountSession: () => restorePortalAccountSession() }))

describe('kitionActions', () => {
  it('opens Settings where the person sets up AI: Account when Kition Cloud needs a sign-in, else Models', async () => {
    const { kitionActions } = await import('./kitActions')
    const opened: unknown[] = []
    const listen = (event: Event) => opened.push((event as CustomEvent).detail)
    window.addEventListener('kition:settings:open', listen)
    try {
      restorePortalAccountSession.mockResolvedValue(null)
      await expect(kitionActions()['settings.open']({ section: 'ai' })).resolves.toEqual({ done: true })
      restorePortalAccountSession.mockResolvedValue({ token: 't' })
      await kitionActions()['settings.open']({ section: 'ai' })
      settings.models.activeProvider = 'openai'
      restorePortalAccountSession.mockResolvedValue(null)
      await kitionActions()['settings.open']({ section: 'ai' })
      await kitionActions()['settings.open']({ section: 'account' })
      expect(opened).toEqual([{ section: 'account' }, { section: 'models' }, { section: 'models' }, { section: 'account' }])
      await expect(kitionActions()['settings.open']({ section: 'developer' })).rejects.toMatchObject({ code: -32000, data: { reason: 'not-allowed' } })
      expect(opened).toHaveLength(4)
    } finally {
      window.removeEventListener('kition:settings:open', listen)
    }
  })
})
