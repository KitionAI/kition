import { useEffect, useState } from 'react'

import { openDataDocumentByPath } from '@/api/dataDocuments'
import type { EmailSyncTableOption } from './EmailSyncTableSelect'

export function useEmailSyncTableOptions(tablePath: string) {
  const [options, setOptions] = useState<EmailSyncTableOption[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    const normalizedPath = tablePath.trim()
    if (!normalizedPath.endsWith('.kitable')) {
      setOptions([])
      setLoading(false)
      setError('Select a Kitable before choosing a destination table.')
      return
    }
    let active = true
    setLoading(true)
    setError('')
    void openDataDocumentByPath({ path: normalizedPath }).then((document) => {
      if (!active) return
      const tables = (document.tables || []).map((table) => ({
        id: table.id,
        name: table.name,
        title: table.title || table.name || `Table ${table.id}`,
      }))
      setOptions(tables)
      setError(tables.length ? '' : 'This Kitable has no data tables.')
    }).catch((requestError) => {
      if (!active) return
      setOptions([])
      setError(requestError instanceof Error ? requestError.message : 'Failed to load tables from this Kitable.')
    }).finally(() => {
      if (active) setLoading(false)
    })
    return () => { active = false }
  }, [tablePath])

  return { options, loading, error }
}
