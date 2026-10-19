import type { KitEngineInfo, KitSdkManifest } from '@kition/kit-ui'

/** The commands that write only comment threads (kit.json `collaboration.comments.commands`): a commenter runs them. */
export const COMMENT_COMMANDS = ['comment.add', 'comment.reply', 'comment.resolve', 'comment.delete'] as const

/** The engine, a TypeScript one (`ts-worker`), from this package's own folder. */
export function engineManifest(): KitSdkManifest {
  return {
    kitId: 'kit.document',
    base: new URL('./engine/', document.baseURI).href,
    module: 'kition_document_engine',
    documentClass: 'MarkdownDocument',
    runtime: 'ts-worker',
    commentCommands: COMMENT_COMMANDS,
  }
}

/** What the shell reads from the engine's `inspect()`; the editor reads its own replica. */
export type DocumentInfo = { characters: number; openThreads: number }

export function describe(info: KitEngineInfo): DocumentInfo {
  const inspected = info.inspected as Partial<DocumentInfo>
  return { characters: inspected.characters ?? 0, openThreads: inspected.openThreads ?? 0 }
}
