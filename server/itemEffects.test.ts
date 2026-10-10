import { describe, expect, it } from 'vitest'
import { ITEM_MOODS, normalizeItemEffect } from './itemEffects.ts'
import { MOOD_VOCAB } from '../src/lib/prompt/mindGuidance.ts'

const flags = new Set(['first_date', 'promise'])

describe('normalizeItemEffect', () => {
  it('keeps the mood list in step with the app vocabulary', () => {
    expect([...ITEM_MOODS].sort()).toEqual([...MOOD_VOCAB].sort())
  })

  it('keeps a multi effect with every valid part', () => {
    const out = normalizeItemEffect(
      { kind: 'multi', effects: [{ kind: 'relationship', dimension: 'trust', amount: 2 }, { kind: 'mood', mood: 'content' }] },
      flags,
    )
    expect(out).toEqual({
      kind: 'multi',
      effects: [{ kind: 'relationship', dimension: 'trust', amount: 2 }, { kind: 'mood', mood: 'content' }],
    })
  })

  it('collapses a one-part multi and drops nested multis', () => {
    expect(normalizeItemEffect({ kind: 'multi', effects: [{ kind: 'currency', amount: 5 }] }, flags)).toEqual({ kind: 'currency', amount: 5 })
    const out = normalizeItemEffect(
      { kind: 'multi', effects: [{ kind: 'multi', effects: [] }, { kind: 'currency', amount: 3 }, { kind: 'flag', flag: 'promise' }] },
      flags,
    )
    expect(out).toEqual({ kind: 'multi', effects: [{ kind: 'currency', amount: 3 }, { kind: 'flag', flag: 'promise' }] })
  })

  it('accepts a known mood and rejects an unknown one', () => {
    expect(normalizeItemEffect({ kind: 'mood', mood: 'relieved' }, flags)).toEqual({ kind: 'mood', mood: 'relieved' })
    expect(normalizeItemEffect({ kind: 'mood', mood: 'ecstatic' }, flags)).toEqual({ kind: 'relationship', dimension: 'affection', amount: 1 })
  })

  it('still handles the original kinds', () => {
    expect(normalizeItemEffect({ kind: 'flag', flag: 'nope' }, flags).kind).toBe('relationship')
    expect(normalizeItemEffect({ kind: 'currency', amount: -4 }, flags)).toEqual({ kind: 'currency', amount: 0 })
    expect(normalizeItemEffect({ kind: 'relationship', dimension: 'trust', amount: 40 }, flags)).toEqual({ kind: 'relationship', dimension: 'trust', amount: 10 })
  })
})
