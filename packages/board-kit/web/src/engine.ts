import type { KitEngineInfo, KitSdkManifest } from '@kition/kit-ui'

/** The engine, a TypeScript one (`ts-worker`), from this package's own folder. */
export function engineManifest(): KitSdkManifest {
  return {
    kitId: 'kit.board',
    base: new URL('./engine/', document.baseURI).href,
    module: 'kition_board_engine',
    documentClass: 'BoardDocument',
    runtime: 'ts-worker',
  }
}

/** What the shell reads from the engine's `inspect()`; the board editor reads its own replica. */
export type BoardInfo = { title: string; elements: number }

export function describe(info: KitEngineInfo): BoardInfo {
  const inspected = info.inspected as Partial<BoardInfo>
  return { title: inspected.title ?? '', elements: inspected.elements ?? 0 }
}
