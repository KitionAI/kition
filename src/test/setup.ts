import { afterEach, vi } from 'vitest'
import 'fake-indexeddb/auto'

// Initialize i18next with bundled resources so any code path that calls
// `i18next.getFixedT(...)` or `i18next.t(...)` during a test has a working
// `overloadTranslationOptionHandler` on its options. Without this, i18next 26
// throws `TypeError: this.options.overloadTranslationOptionHandler is not a
// function` from `fixedT` when callers pass undefined as the second arg.
// Tests use the North American English product locale.
import i18next from 'i18next'
import '@/i18n'

void i18next.changeLanguage('en-US')

class ResizeObserverMock {
  observe() {}
  unobserve() {}
  disconnect() {}
}

class IntersectionObserverMock {
  observe() {}
  unobserve() {}
  disconnect() {}
}

vi.stubGlobal('ResizeObserver', ResizeObserverMock)
vi.stubGlobal('IntersectionObserver', IntersectionObserverMock)

Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: vi.fn().mockImplementation((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })),
})

Object.defineProperty(window, 'scrollTo', {
  writable: true,
  value: vi.fn(),
})

const emptyDOMRect = {
  x: 0,
  y: 0,
  width: 0,
  height: 0,
  top: 0,
  right: 0,
  bottom: 0,
  left: 0,
  toJSON: () => ({}),
} as DOMRect

Object.defineProperty(Range.prototype, 'getClientRects', {
  configurable: true,
  value: () => [],
})

Object.defineProperty(Range.prototype, 'getBoundingClientRect', {
  configurable: true,
  value: () => emptyDOMRect,
})

afterEach(() => {
  vi.clearAllMocks()
})
