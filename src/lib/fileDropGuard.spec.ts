import { afterEach, describe, expect, it } from 'vitest'

import { installFileDropGuard } from './fileDropGuard'

function dragEvent(type: string, types: string[]) {
  const event = new Event(type, { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'dataTransfer', { value: { types, dropEffect: 'copy' } })
  return event as DragEvent
}

let uninstall = () => {}
afterEach(() => uninstall())

describe('installFileDropGuard', () => {
  it('refuses file drops that no drop zone handled', () => {
    uninstall = installFileDropGuard()
    const over = dragEvent('dragover', ['Files'])
    window.dispatchEvent(over)
    expect(over.defaultPrevented).toBe(true)
    expect(over.dataTransfer?.dropEffect).toBe('none')
    const drop = dragEvent('drop', ['Files'])
    window.dispatchEvent(drop)
    expect(drop.defaultPrevented).toBe(true)
  })

  it('leaves handled drops and non-file drags alone', () => {
    uninstall = installFileDropGuard()
    const handled = dragEvent('dragover', ['Files'])
    handled.preventDefault()
    window.dispatchEvent(handled)
    expect(handled.dataTransfer?.dropEffect).toBe('copy')
    const text = dragEvent('dragover', ['text/plain'])
    window.dispatchEvent(text)
    expect(text.defaultPrevented).toBe(false)
  })
})
