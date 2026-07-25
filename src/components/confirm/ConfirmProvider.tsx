import React, { createContext, useCallback, useEffect, useRef, useState } from 'react'

import { ConfirmDialog } from './ConfirmDialog'
import type { ConfirmEntry, ConfirmFn, ConfirmOpts } from './types'

interface ConfirmContextValue {
  confirm: ConfirmFn
}

export const ConfirmContext = createContext<ConfirmContextValue | null>(null)

let nextId = 0

export function ConfirmProvider({ children }: { children?: React.ReactNode }) {
  const [current, setCurrent] = useState<ConfirmEntry | null>(null)
  const queueRef = useRef<ConfirmEntry[]>([])
  const currentRef = useRef<ConfirmEntry | null>(null)

  const showNext = useCallback(() => {
    if (queueRef.current.length > 0) {
      const next = queueRef.current.shift()!
      currentRef.current = next
      setCurrent(next)
    } else {
      currentRef.current = null
      setCurrent(null)
    }
  }, [])

  const confirm = useCallback<ConfirmFn>((opts: ConfirmOpts | string) => {
    const resolvedOpts: ConfirmOpts =
      typeof opts === 'string' ? { message: opts } : opts

    return new Promise<boolean>((resolve) => {
      const entry: ConfirmEntry = {
        id: nextId++,
        opts: resolvedOpts,
        resolve,
      }

      if (currentRef.current === null) {
        currentRef.current = entry
        setCurrent(entry)
      } else {
        queueRef.current.push(entry)
      }
    })
  }, [])

  useEffect(() => () => {
    currentRef.current?.resolve(false)
    queueRef.current.forEach((e) => e.resolve(false))
    queueRef.current = []
    currentRef.current = null
  }, [])

  const handleSettle = useCallback(
    (value: boolean) => {
      if (current) {
        current.resolve(value)
      }
      showNext()
    },
    [current, showNext]
  )

  return (
    <ConfirmContext.Provider value={{ confirm }}>
      {children}
      {current && (
        <ConfirmDialog
          key={current.id}
          open
          opts={current.opts}
          onSettle={handleSettle}
        />
      )}
    </ConfirmContext.Provider>
  )
}
