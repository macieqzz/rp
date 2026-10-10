import { describe, expect, it } from 'vitest'
import { factSimilarity, pickFactsToRetire, planFactWrite } from './factMemory'
import type { ChatFact } from '@/lib/types'

let n = 0
const fact = (text: string, over: Partial<ChatFact> = {}): ChatFact => ({
  id: `f${n++}`,
  chatId: 'c',
  text,
  active: true,
  createdAt: n,
  ...over,
})
const fresh = (text: string, importance = 0.5) => ({ text, importance, valence: 0, unresolved: false })

describe('factSimilarity', () => {
  it('scores a rephrased fact high and an unrelated one low', () => {
    expect(factSimilarity('Prefers plain tea without sugar', 'Sumire prefers her tea plain, no sugar')).toBeGreaterThan(0.6)
    expect(factSimilarity('Prefers plain tea without sugar', 'Her father calls on Sundays')).toBeLessThan(0.2)
  })
})

describe('planFactWrite', () => {
  it('creates a genuinely new fact', () => {
    expect(planFactWrite(fresh('Has a younger brother named Ren'), [fact('Prefers plain tea')]).action).toBe('create')
  })

  it('merges a near-duplicate into the existing fact and nudges its importance up', () => {
    const existing = fact('Likes plain tea', { importance: 0.4 })
    const plan = planFactWrite(fresh('Likes plain tea with no sugar at all', 0.5), [existing])
    expect(plan.action).toBe('merge')
    if (plan.action === 'merge') {
      expect(plan.targetId).toBe(existing.id)
      expect(plan.patch.importance).toBeCloseTo(0.55)
      expect(plan.patch.text).toBe('Likes plain tea with no sugar at all')
    }
  })

  it('ignores retired facts when looking for a duplicate', () => {
    expect(planFactWrite(fresh('Likes plain tea'), [fact('Likes plain tea', { active: false })]).action).toBe('create')
  })

  it('keeps an open thread open when merging', () => {
    const plan = planFactWrite(fresh('Forgot her birthday'), [fact('Forgot her birthday entirely', { unresolved: true })])
    expect(plan.action === 'merge' && plan.patch.unresolved).toBe(true)
  })
})

describe('pickFactsToRetire', () => {
  const many = (count: number) => Array.from({ length: count }, (_, i) => fact(`trivia number ${i}`, { importance: 0.3, createdAt: 1000 + i }))

  it('does nothing under the cap', () => {
    expect(pickFactsToRetire(many(40), 60)).toEqual([])
  })

  it('trims back below the cap with headroom, oldest and least important first', () => {
    const facts = many(70)
    const retire = pickFactsToRetire(facts, 60)
    expect(retire).toHaveLength(70 - 50)
    expect(retire).toContain(facts[0].id)
    expect(retire).not.toContain(facts[69].id)
  })

  it('never retires an open thread or a weighty fact, however old', () => {
    const keep1 = fact('an open wound', { unresolved: true, createdAt: 1, importance: 0.1 })
    const keep2 = fact('reshaped everything', { importance: 0.9, createdAt: 2 })
    const retire = pickFactsToRetire([keep1, keep2, ...many(70)], 60)
    expect(retire).not.toContain(keep1.id)
    expect(retire).not.toContain(keep2.id)
  })
})
