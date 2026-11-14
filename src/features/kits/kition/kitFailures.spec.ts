import { beforeAll, describe, expect, it } from 'vitest'

import { i18nReady } from '@/i18n'
import { openFailureKind, openFailureLimit, saveFailureText } from './kitFailures'

beforeAll(async () => {
  await i18nReady
})

function failed(status: number, message: string) {
  return Object.assign(new Error(message), { response: { status, data: { message } } })
}

describe('openFailureKind', () => {
  it('tells a file service that cannot be reached from a damaged file', () => {
    expect(openFailureKind('Failed to fetch')).toBe('unreachable')
    expect(openFailureKind('NetworkError when attempting to fetch resource.')).toBe('unreachable')
    expect(openFailureKind('Load failed')).toBe('unreachable')
  })

  it("tells an editor engine that could not start from a damaged file", () => {
    expect(openFailureKind("failed to fetch Wasm: 500 Internal Server Error fetching 'http://127.0.0.1/kits/slide-ui/engine/kition_slide_kit_bg.wasm'")).toBe('engine')
    expect(openFailureKind('CompileError: WebAssembly.instantiate(): expected magic word')).toBe('engine')
  })

  it('tells a file larger than the kit opens from a damaged file, and reads the limit', () => {
    const reason = 'too-large: the page is 11.3 MB; the HTML kit opens pages of at most 8 MB'
    expect(openFailureKind(reason)).toBe('tooLarge')
    expect(openFailureLimit(reason)).toBe('8')
    expect(openFailureKind('too-large: the drawing is over the limit')).toBe('tooLarge')
    expect(openFailureLimit('too-large: the drawing is over the limit')).toBeUndefined()
  })

  it('takes any other reason as the file itself', () => {
    expect(openFailureKind('not a valid zip package: invalid Zip archive: Could not find EOCD')).toBe('damaged')
    expect(openFailureKind('file is not a database')).toBe('damaged')
  })
})

describe('saveFailureText', () => {
  it('says the disk is full in plain words, without the system error', () => {
    const text = saveFailureText(failed(507, 'No space left on device (os error 28)'))
    expect(text).toBe('There is no space left on this disk. Free up some space, then save again.')
  })

  it('says the file cannot be written when the system refuses it', () => {
    expect(saveFailureText(failed(500, 'Permission denied (os error 13)'))).toBe('Kition is not allowed to write this file. Check its permissions, then save again.')
    expect(saveFailureText(failed(403, 'Access denied'))).toBe('Kition is not allowed to write this file. Check its permissions, then save again.')
  })

  it("says Kition's file service cannot be reached", () => {
    expect(saveFailureText(new TypeError('Failed to fetch'))).toBe("Kition can't reach its file service right now. Your changes are kept; save again in a moment.")
  })

  it('falls back to a plain message for any other failure', () => {
    expect(saveFailureText(failed(500, 'Internal server error'))).toBe('The file could not be saved. Your changes are kept; try saving again.')
  })
})
