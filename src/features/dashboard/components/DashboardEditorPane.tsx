import { KitionTableProviders } from '@/features/table/public'
import { DashboardEditor } from './DashboardEditor'

/** A dashboard tab in Kition: the dashboard editor on Kition's runtime. */
export function DashboardEditorPane(props: { dashboardId: string; documentPath: string }) {
  return (
    <KitionTableProviders>
      <DashboardEditor {...props} />
    </KitionTableProviders>
  )
}
