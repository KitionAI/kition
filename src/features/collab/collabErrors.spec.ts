import { beforeAll, describe, expect, it } from 'vitest'

import { getI18nInstance, i18nReady } from '@/i18n'
import { SyncRpcError } from '@/lib/sync/protocol'
import { collabErrorText } from './collabErrors'
import { CollabUnavailableError } from './syncConnection'

beforeAll(async () => {
  await i18nReady
})

const text = (error: unknown) => collabErrorText(error, getI18nInstance().getFixedT(null, 'workspace'))
const rpc = (code: string, message = 'room/open failed') => new SyncRpcError(-32000, message, { code })

describe('collabErrorText', () => {
  it('names what co-editing needs and an unreachable server', () => {
    expect(text(new CollabUnavailableError('off'))).toBe('Co-editing needs a Kition account and a sync server.')
    expect(text(new CollabUnavailableError('unreachable'))).toBe('The sync server cannot be reached. Check your connection and try again.')
    expect(text(rpc('forbidden'))).toBe('Co-editing needs a Kition account and a sync server.')
  })

  it('says a link that is wrong or gone does not lead to a document', () => {
    expect(text(rpc('not-found'))).toBe('This link does not lead to a shared document.')
    expect(text(rpc('invalid', 'shareLink: not a share link'))).toBe('This link does not lead to a shared document.')
  })

  it('says the server is busy rather than repeating its error', () => {
    expect(text(rpc('unavailable'))).toBe('The sync server cannot be reached. Check your connection and try again.')
    expect(text(rpc('rate-limited'))).toBe('The sync server is busy. Wait a moment, then try again.')
  })

  it('says this build cannot open the kind of document a link leads to', () => {
    expect(text(new Error('this build cannot open kit.scene documents'))).toBe('This version of Kition cannot open this kind of document.')
  })

  it('never shows a raw error', () => {
    const shown = text(new TypeError("Cannot read properties of undefined (reading 'docId')"))
    expect(shown).toBe('Something went wrong. Try again.')
    expect(shown).not.toMatch(/undefined|docId|Error/)
  })
})
