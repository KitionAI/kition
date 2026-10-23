import { useEffect, useState } from 'react'

import { isTableFilePath, listTableFiles } from '@/api/kitTables'
import type { EmailSyncTableOption } from './EmailSyncTableSelect'

export function useEmailSyncTableOptions(tablePath: string) {
  const [options, setOptions] = useState<EmailSyncTableOption[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    const normalizedPath = tablePath.trim()
    if (!isTableFilePath(normalizedPath)) {
      setOptions([])
      setLoading(false)
      setError('Select a table file before choosing a destination table.')
      return
    }
    let active = true
    setLoading(true)
    setError('')
    void listTableFiles().then(({ files }) => {
      if (!active) return
      const file = files.find((candidate) => candidate.path === normalizedPath)
      const tables = (file?.tables || []).map((table) => ({
        id: Number(table.id),
        name: table.name,
        title: table.title || table.name || `Table ${table.id}`,
      }))
      setOptions(tables)
      setError(tables.length ? '' : 'This table file has no tables.')
    }).catch((requestError) => {
      if (!active) return
      setOptions([])
      setError(requestError instanceof Error ? requestError.message : 'Failed to load the tables of this file.')
    }).finally(() => {
      if (active) setLoading(false)
    })
    return () => { active = false }
  }, [tablePath])

  return { options, loading, error }
}
