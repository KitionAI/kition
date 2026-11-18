import type { ExtensionService } from './extensionService'
import { announcedService } from './serviceAnnouncement'

/**
 * Loads the extension service module and answers its service once the module has run to its end.
 * The module's graph holds WebAssembly modules with top-level await, and WebKit can settle a
 * dynamic `import()` of such a module before its body has run (its bindings still uninitialized);
 * so the module announces itself from its last statement, and callers wait for that instead.
 */
let loading: Promise<ExtensionService> | null = null

export function loadExtensionService(): Promise<ExtensionService> {
  loading ??= Promise.race([
    import('./extensionService').then(() => new Promise<never>(() => undefined)),
    announcedService.then((service) => service() as ExtensionService),
  ])
  return loading
}
