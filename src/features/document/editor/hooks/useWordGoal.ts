   
                               
  
                                               
             
   

import { useCallback, useEffect, useState } from 'react'

const STORAGE_KEY = 'kition.document.wordGoals'
const BROADCAST_EVENT = 'kition:document:word-goals-changed'

type GoalMap = Record<string, number>

function read(): GoalMap {
  if (typeof window === 'undefined') return {}
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as GoalMap
    return {}
  } catch {
    return {}
  }
}

function write(map: GoalMap) {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(map))
    window.dispatchEvent(new CustomEvent(BROADCAST_EVENT))
  } catch {
    /* quota / disabled */
  }
}

export function setWordGoal(path: string, goal: number | null): void {
  if (!path) return
  const map = read()
  if (goal === null || goal <= 0) {
    delete map[path]
  } else {
    map[path] = Math.floor(goal)
  }
  write(map)
}

export function getWordGoal(path: string): number | null {
  return read()[path] ?? null
}

export function useWordGoal(path: string | undefined): {
  goal: number | null
  setGoal: (goal: number | null) => void
} {
  const [goal, setGoalState] = useState<number | null>(() => (path ? getWordGoal(path) : null))
  useEffect(() => {
    function onChange() {
      setGoalState(path ? getWordGoal(path) : null)
    }
    onChange()
    window.addEventListener(BROADCAST_EVENT, onChange)
    window.addEventListener('storage', onChange)
    return () => {
      window.removeEventListener(BROADCAST_EVENT, onChange)
      window.removeEventListener('storage', onChange)
    }
  }, [path])
  const setGoal = useCallback(
    (next: number | null) => {
      if (!path) return
      setWordGoal(path, next)
    },
    [path],
  )
  return { goal, setGoal }
}
