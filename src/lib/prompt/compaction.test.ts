import { describe, expect, it } from 'vitest'
import { planCompaction, type CompactionTurn } from './compaction'

const exchange = (n: number, tokens = 100): CompactionTurn[] =>
  Array.from({ length: n * 2 }, (_, i) => ({ role: i % 2 === 0 ? ('user' as const) : ('char' as const), tokens: i % 2 === 0 ? tokens / 4 : tokens }))

describe('planCompaction', () => {
  it('does nothing while the window has room for the next exchange', () => {
    expect(planCompaction({ turns: exchange(10), capacity: 4000, growth: 150 })).toBe(0)
  })

  it('folds down to the low-water mark once the window is nearly full', () => {
    const turns = exchange(30) // 30 * 125 = 3750 tokens
    const fold = planCompaction({ turns, capacity: 4000, growth: 150 })
    const kept = turns.slice(fold).reduce((s, t) => s + t.tokens, 0)
    expect(fold).toBeGreaterThan(0)
    expect(kept).toBeLessThanOrEqual(4000 * 0.5 + 125)
    expect(kept).toBeGreaterThan(4000 * 0.3)
  })

  it('leaves the kept window starting on a user line', () => {
    const turns = exchange(30)
    const fold = planCompaction({ turns, capacity: 4000, growth: 150 })
    expect(turns[fold].role).toBe('user')
  })

  it('never folds below the minimum kept messages', () => {
    const turns = exchange(3, 2000)
    const fold = planCompaction({ turns, capacity: 1000, growth: 100, minKeep: 4 })
    expect(turns.length - fold).toBeGreaterThanOrEqual(4)
  })

  it('compacts rarely: a full cycle spans many exchanges, not one', () => {
    // Simulate growth of one exchange per turn and count compactions over 60 turns.
    let turns = exchange(20)
    let compactions = 0
    for (let t = 0; t < 60; t++) {
      turns = [...turns, ...exchange(1)]
      const fold = planCompaction({ turns, capacity: 4000, growth: 125 })
      if (fold > 0) {
        turns = turns.slice(fold)
        compactions++
      }
    }
    expect(compactions).toBeGreaterThan(0)
    expect(compactions).toBeLessThanOrEqual(8)
  })

  it('lower low-water means longer gaps between compactions', () => {
    const run = (lowWater: number) => {
      let turns = exchange(20)
      let n = 0
      for (let t = 0; t < 80; t++) {
        turns = [...turns, ...exchange(1)]
        const fold = planCompaction({ turns, capacity: 4000, growth: 125, lowWater })
        if (fold > 0) {
          turns = turns.slice(fold)
          n++
        }
      }
      return n
    }
    expect(run(0.35)).toBeLessThan(run(0.7))
  })

  it('handles degenerate input', () => {
    expect(planCompaction({ turns: [], capacity: 4000, growth: 100 })).toBe(0)
    expect(planCompaction({ turns: exchange(10), capacity: 0, growth: 100 })).toBe(0)
  })
})

describe('planCompaction manual mode', () => {
  it('a zero high-water folds down to the requested low-water even when the window has room', () => {
    const turns = exchange(10) // 1250 tokens, well under a 4000-token capacity
    expect(planCompaction({ turns, capacity: 4000, growth: 100 })).toBe(0)
    const fold = planCompaction({ turns, capacity: 4000, growth: 100, highWater: 0, lowWater: 0.1 })
    expect(fold).toBeGreaterThan(0)
    expect(turns.length - fold).toBeGreaterThanOrEqual(4)
  })
})
