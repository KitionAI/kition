import { updateWorkspaceMarkdown, writeWorkspaceMarkdown } from '@/features/document/kdm/documentSessions'
import { readWorkspaceDocument } from '@/services/desktop'

export type DailyNoteOptions = {

  folder?: string

  template?: string
}

function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n)
}

function todayString(): string {
  const now = new Date()
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}

export function dateString(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

export function dailyNotePath(options: DailyNoteOptions = {}): string {
  const folder = (options.folder ?? 'Daily Notes').replace(/^\/+|\/+$/g, '')
  const file = todayString()
  return `${folder}/${file}.md`
}

export function dailyNotePathFor(date: Date, options: DailyNoteOptions = {}): string {
  const folder = (options.folder ?? 'Daily Notes').replace(/^\/+|\/+$/g, '')
  return `${folder}/${dateString(date)}.md`
}

const DEFAULT_TEMPLATE = '# {{date}}\n\n- '

export async function ensureDailyNote(options: DailyNoteOptions = {}): Promise<string> {
  const path = dailyNotePath(options)
  try {
    const existing = await readWorkspaceDocument(path)
    if (existing && existing.content != null) return path
  } catch {
    // fall through to create
  }
  const template = (options.template ?? DEFAULT_TEMPLATE).replace(/\{\{date\}\}/g, todayString())
  try {
    await writeWorkspaceMarkdown(path, template, 'daily note')
  } catch {
    // Return the path even if writing fails so the caller can still try opening it.
  }
  return path
}

export async function ensureDailyNoteFor(date: Date, options: DailyNoteOptions = {}): Promise<string> {
  const path = dailyNotePathFor(date, options)
  try {
    const existing = await readWorkspaceDocument(path)
    if (existing && existing.content != null) return path
  } catch {
    // fall through to create
  }
  const template = (options.template ?? DEFAULT_TEMPLATE).replace(/\{\{date\}\}/g, dateString(date))
  try {
    await writeWorkspaceMarkdown(path, template, 'daily note')
  } catch {
    /* tolerate */
  }
  return path
}

export async function appendToDailyNote(line: string, options: DailyNoteOptions = {}): Promise<string> {
  const path = await ensureDailyNote(options)
  try {
    // Through the open daily note when it is open, so the editor keeps both the line and its own edits.
    await updateWorkspaceMarkdown(path, (prev) => {
      const needsNewline = prev.length > 0 && !prev.endsWith('\n')
      return prev + (needsNewline ? '\n' : '') + line + '\n'
    }, 'append to daily note')
  } catch {
    /* tolerate */
  }
  return path
}
