import { FileWarning } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { Button } from '@/components/ui'
import type { BoardFileProblem } from '@/features/whiteboard/kdm/boardKdmFile'

/** The `workspace` message explaining each reason a `.kiboard` file cannot be opened or saved. */
export const BOARD_FILE_PROBLEM_MESSAGES: Record<BoardFileProblem, string> = {
  'version-1': 'whiteboard.file.unsupported',
  'newer-version': 'whiteboard.file.newerVersion',
  'not-a-board': 'whiteboard.file.notABoard',
}

/**
 * Shown instead of the canvas when a `.kiboard` file cannot be opened. The file is never written
 * on its own; the user may replace it with a new Board, except a newer Kition's Board.
 */
export function WhiteboardFileNotice({
  busy,
  error,
  onStartNew,
  problem,
  title,
}: {
  busy: boolean
  error: string
  onStartNew: () => void
  problem: BoardFileProblem
  title: string
}) {
  const { t } = useTranslation('workspace')
  const canStartNew = problem !== 'newer-version'

  return (
    <div
      className="flex w-full max-w-md flex-col items-start gap-3 rounded-xl border bg-card p-6 text-card-foreground shadow-soft"
      role="alert"
      data-testid="whiteboard-file-notice"
      data-problem={problem}
    >
      <FileWarning aria-hidden="true" className="h-5 w-5 text-muted-foreground" />
      <div className="space-y-1">
        <h2 className="text-base font-semibold">{t('whiteboard.file.title', { title })}</h2>
        <p className="text-sm text-muted-foreground">{t(BOARD_FILE_PROBLEM_MESSAGES[problem])}</p>
      </div>
      {canStartNew ? (
        <div className="space-y-2">
          <Button disabled={busy} onClick={onStartNew} data-testid="whiteboard-file-start-new">
            {t('whiteboard.file.startNew')}
          </Button>
          <p className="text-xs text-muted-foreground">{t('whiteboard.file.startNewHint')}</p>
        </div>
      ) : null}
      {error ? <p className="text-xs text-destructive" role="status">{error}</p> : null}
    </div>
  )
}
