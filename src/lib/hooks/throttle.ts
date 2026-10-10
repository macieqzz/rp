// Trailing throttle: runs the latest scheduled callback at most once per interval, flush() runs it now.
export function createTrailingThrottle(intervalMs: number) {
  let timer: ReturnType<typeof setTimeout> | null = null
  let pending: (() => void) | null = null
  let lastRun = Number.NEGATIVE_INFINITY

  const run = () => {
    timer = null
    const fn = pending
    pending = null
    lastRun = Date.now()
    fn?.()
  }

  return {
    schedule(fn: () => void) {
      pending = fn
      if (timer) return
      const wait = Math.max(0, lastRun + intervalMs - Date.now())
      timer = setTimeout(run, wait)
    },
    flush() {
      if (timer) clearTimeout(timer)
      run()
    },
    cancel() {
      if (timer) clearTimeout(timer)
      timer = null
      pending = null
    },
  }
}
