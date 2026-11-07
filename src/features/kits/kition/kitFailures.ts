import { getI18nInstance } from '@/i18n'

/**
 * Why a kit could not open its file, from the reason it gave: Kition's file service did not answer
 * (`unreachable`), the kit's engine could not be fetched or compiled (`engine`), the file is larger
 * than the kit opens (`tooLarge`: the kit's reason starts with `too-large:`), or the file itself
 * (`damaged`). Only the last one is the file's fault.
 */
export type OpenFailureKind = 'unreachable' | 'engine' | 'tooLarge' | 'damaged'

const TOO_LARGE = /^too-large:/i
const ENGINE = /\bwasm\b|webassembly|compileerror|linkerror/i
const UNREACHABLE = /failed to fetch|networkerror|load failed|network request failed|err_connection|connection refused/i

export function openFailureKind(reason: string): OpenFailureKind {
  if (TOO_LARGE.test(reason.trim())) return 'tooLarge'
  if (ENGINE.test(reason)) return 'engine'
  if (UNREACHABLE.test(reason)) return 'unreachable'
  return 'damaged'
}

/** The size limit a `too-large:` reason names ("at most 8 MB"), in megabytes, when it names one. */
export function openFailureLimit(reason: string): string | undefined {
  return /\bat most (\d+(?:\.\d+)?) MB\b/i.exec(reason)?.[1]
}

const DISK_FULL = /no space left|os error 28|disk (is )?full|enospc/i
const NOT_ALLOWED = /permission denied|os error 13|read-only file system|os error 30|access denied|eacces|erofs/i

/**
 * What a kit tells the person when Kition could not save its file (`host/write` failed): the cause
 * in plain words and what to do, never the system's error (it stays in the console).
 */
export function saveFailureText(error: unknown) {
  const t = getI18nInstance().t
  const status = (error as { response?: { status?: number } } | null)?.response?.status
  const reason = error instanceof Error ? error.message : String(error)
  console.warn('[kit save] failed:', reason)
  if (status === 507 || DISK_FULL.test(reason)) return t('workspace:kitEditor.saveFailed.diskFull')
  if (status === 403 || NOT_ALLOWED.test(reason)) return t('workspace:kitEditor.saveFailed.notAllowed')
  if (!status && openFailureKind(reason) === 'unreachable') return t('workspace:kitEditor.saveFailed.unreachable')
  return t('workspace:kitEditor.saveFailed.other')
}
