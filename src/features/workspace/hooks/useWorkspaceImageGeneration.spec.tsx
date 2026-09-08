import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { getDesktopBackendStatus } from '@/services/desktop'
import { useWorkspaceImageGeneration } from './useWorkspaceImageGeneration'

vi.mock('@/features/settings/hooks/useDesktopSettings', () => ({ useDesktopSettings: () => ({ settings: { providers: {} } }) }))
vi.mock('@/services/desktop', () => ({ getDesktopBackendStatus: vi.fn() }))
;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
afterEach(() => { vi.useRealTimers(); vi.clearAllMocks() })

it('refreshes capabilities after a backend restart and stops polling on unmount', async () => {
  vi.useFakeTimers()
  vi.mocked(getDesktopBackendStatus).mockResolvedValue({ capabilities: [] } as any)
  let available = false
  function Harness() { available = useWorkspaceImageGeneration('/test/workspace').available; return null }
  const root = createRoot(document.createElement('div'))
  await act(async () => root.render(<Harness />))
  expect(available).toBe(false)
  vi.mocked(getDesktopBackendStatus).mockResolvedValue({ capabilities: ['agent_image_generation_v1'] } as any)
  await act(async () => { window.dispatchEvent(new Event('focus')) })
  expect(available).toBe(true)
  vi.mocked(getDesktopBackendStatus).mockResolvedValue({ capabilities: [] } as any)
  await act(async () => { await vi.advanceTimersByTimeAsync(10000) })
  expect(available).toBe(false)
  await act(async () => root.unmount())
  const calls = vi.mocked(getDesktopBackendStatus).mock.calls.length
  await vi.advanceTimersByTimeAsync(20000)
  window.dispatchEvent(new Event('focus'))
  expect(getDesktopBackendStatus).toHaveBeenCalledTimes(calls)
})
