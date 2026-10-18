import type { ReactNode } from 'react'
import { TableDataSourceProvider } from '@kition/table-editor'
import { TableHostProvider } from '@kition/table-editor'
import { httpTableDataSource } from './httpTableDataSource'
import { kitionTableHost } from './kitionTableHost'

/** Gives the table and dashboard editors Kition's runtime data and app services. */
export function KitionTableProviders({ children }: { children: ReactNode }) {
  return (
    <TableDataSourceProvider value={httpTableDataSource}>
      <TableHostProvider value={kitionTableHost}>{children}</TableHostProvider>
    </TableDataSourceProvider>
  )
}
