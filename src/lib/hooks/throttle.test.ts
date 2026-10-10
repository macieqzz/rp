import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTrailingThrottle } from './throttle'

describe('createTrailingThrottle', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('runs the first call right away and coalesces a burst into one trailing call with the latest value', () => {
    const t = createTrailingThrottle(100)
    const seen: number[] = []
    for (let i = 1; i <= 5; i++) t.schedule(() => seen.push(i))
    vi.advanceTimersByTime(0)
    expect(seen).toEqual([5])
    t.schedule(() => seen.push(6))
    t.schedule(() => seen.push(7))
    vi.advanceTimersByTime(99)
    expect(seen).toEqual([5])
    vi.advanceTimersByTime(1)
    expect(seen).toEqual([5, 7])
  })

  it('flush runs the pending call immediately and cancel drops it', () => {
    const t = createTrailingThrottle(100)
    const seen: string[] = []
    t.schedule(() => seen.push('a'))
    vi.advanceTimersByTime(0)
    t.schedule(() => seen.push('b'))
    t.flush()
    expect(seen).toEqual(['a', 'b'])
    t.schedule(() => seen.push('c'))
    t.cancel()
    vi.advanceTimersByTime(500)
    expect(seen).toEqual(['a', 'b'])
  })
})
