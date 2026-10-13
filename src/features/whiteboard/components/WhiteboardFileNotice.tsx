import { FileWarning } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { useConfirm } from '@/components/confirm'
import { Button } from '@/components/ui'
import type { BoardDocumentProblem, BoardSaveRefusal } from '@/features/whiteboard/hooks/useBoardDocument'

/** The `workspace` message explaining each reason a `.kiboard` file cannot be opened or saved. */
export const BOARD_FILE_PROBLEM_MESSAGES: Record<BoardDocumentProblem | BoardSaveRefusal, string> = {
  'version-1': 'whiteboard.file.unsupported',
  'newer-version': 'whiteboard.file.newerVersion',
  'not-a-board': 'whiteboard.file.notABoard',
  'different-board': 'whiteboard.file.differentBoard',
  'read-failed': 'whiteboard.file.readFailed',
}

/**
 * Shown instead of the canvas when a `.kiboard` file cannot be opened. The file is never written
 * on its own: the user may replace an old or damaged file with a new Board after confirming (never
 * a newer Kition's Board), or read a file that could not be read again.
 */
export function WhiteboardFileNotice({
  busy,
  error,
  onReload,
  onStartNew,
  problem,
  title,
}: {
  busy: boolean
  error: string
  onReload: () => void
  onStartNew: () => void
  problem: BoardDocumentProblem
  title: string
}) {
  const { t } = useTranslation('workspace')
  const confirm = useConfirm()
  const canStartNew = problem === 'version-1' || problem === 'not-a-board'

  const startNew = async () => {
    const confirmed = await confirm({
      title: t('whiteboard.file.startNewConfirmTitle'),
      message: t('whiteboard.file.startNewConfirmMessage', { title }),
      confirmLabel: t('whiteboard.file.startNewConfirm'),
      variant: 'destructive',
      testId: 'whiteboard-start-new-confirm',
    })
    if (confirmed) onStartNew()
  }

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
          <Button disabled={busy} onClick={() => void startNew()} data-testid="whiteboard-file-start-new">
            {t('whiteboard.file.startNew')}
          </Button>
          <p className="text-xs text-muted-foreground">{t('whiteboard.file.startNewHint')}</p>
        </div>
      ) : null}
      {problem === 'read-failed' ? (
        <Button disabled={busy} onClick={onReload} data-testid="whiteboard-file-reload">
          {t('whiteboard.file.reload')}
        </Button>
      ) : null}
      {error ? <p className="text-xs text-destructive" role="status">{error}</p> : null}
    </div>
  )
}
