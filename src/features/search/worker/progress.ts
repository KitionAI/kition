import type { WorkerProgress, WorkerOutbound } from '../types'

export function makeProgressEmitter(post: (msg: WorkerOutbound) => void, throttleEvery = 50) {
  const counters = { note: 0, kitable: 0, persist: 0 }
  const totals: Record<WorkerProgress['phase'], number> = { note: 1, kitable: 1, persist: 1 }
  let pending = 0
  return {
    setTotal(phase: WorkerProgress['phase'], total: number) { totals[phase] = Math.max(1, total) },
    tick(phase: WorkerProgress['phase'], n = 1) {
      counters[phase] += n
      pending += n
      if (pending >= throttleEvery) {
        post({ type: 'progress', phase, done: counters[phase], total: totals[phase] })
        pending = 0
      }
    },
    flush(phase: WorkerProgress['phase']) {
      post({ type: 'progress', phase, done: counters[phase], total: totals[phase] })
      pending = 0
    },
  }
}
