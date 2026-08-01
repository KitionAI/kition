import { EventEmitter } from 'node:events'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BackendSupervisor, validateRuntimeInfo, workspaceIDFromDirectory, workspaceIDFromPath } from './backend-supervisor.mjs'

afterEach(() => {
  vi.useRealTimers()
})

describe('backend runtime compatibility', () => {
  it('derives the same stable short workspace hash contract as the Go runtime', () => {
    expect(workspaceIDFromPath('/Users/alice/Documents/kition-workspace')).toBe('e3b07878c7578421')
    expect(workspaceIDFromPath('/Users/alice/Documents/kition-workspace')).toHaveLength(16)
  })

  it('prefers the portable workspace manifest identity', async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'kition-workspace-'))
    await fs.mkdir(path.join(workspace, '.kition'), { recursive: true })
    await fs.writeFile(path.join(workspace, '.kition', 'workspace.json'), JSON.stringify({
      schema_version: 1,
      storage_version: 1,
      workspace_id: '0123456789abcdef',
    }))
    await expect(workspaceIDFromDirectory(workspace)).resolves.toBe('0123456789abcdef')
    await fs.rm(workspace, { recursive: true, force: true })
  })

  it('accepts a compatible runtime info payload', () => {
    const info = {
      pid: 123,
      workspace_id: 'e3b07878c7578421',
      runtime_version: '1.0.0',
      protocol_version: 1,
      build_commit: 'abc123',
      capabilities: ['documents', 'agent'],
    }
    expect(validateRuntimeInfo(info, 1)).toBe(info)
  })

  it('rejects incompatible protocol versions', () => {
    expect(() => validateRuntimeInfo({
      pid: 123,
      workspace_id: 'e3b07878c7578421',
      runtime_version: '1.0.0',
      protocol_version: 2,
      build_commit: 'abc123',
      capabilities: [],
    }, 1)).toThrow('runtime protocol 2 is incompatible with client protocol 1')
  })
})

describe('backend runtime shutdown', () => {
  it('waits for the child to exit after escalating to SIGKILL', async () => {
    vi.useFakeTimers()
    const child = new EventEmitter() as EventEmitter & {
      exitCode: number | null
      signalCode: NodeJS.Signals | null
      killed: boolean
      kill: ReturnType<typeof vi.fn>
    }
    child.exitCode = null
    child.signalCode = null
    child.killed = false
    child.kill = vi.fn((signal: NodeJS.Signals) => {
      child.killed = true
      if (signal === 'SIGKILL') {
        queueMicrotask(() => {
          child.signalCode = 'SIGKILL'
          child.emit('exit', null, 'SIGKILL')
        })
      }
      return true
    })

    const supervisor = new BackendSupervisor({
      backend_url: 'http://127.0.0.1:18101',
      log_file: '',
    })
    supervisor.child = child

    const stopping = supervisor.stop()
    await vi.advanceTimersByTimeAsync(5000)
    await stopping

    expect(child.kill).toHaveBeenNthCalledWith(1, 'SIGTERM')
    expect(child.kill).toHaveBeenNthCalledWith(2, 'SIGKILL')
    expect(child.signalCode).toBe('SIGKILL')
    expect(supervisor.child).toBeNull()
  })
})
