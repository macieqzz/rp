import { describe, expect, it } from 'vitest'
import type { CharacterCardData } from '@/lib/characters/cardSpec'
import { CREATOR_SCORE, extractKeywords, findRelated, matchStrength, tagWeight, type RelatedCandidate } from './related'

function c(id: string, card: Partial<CharacterCardData>): RelatedCandidate {
  return { id, card: { name: id, description: '', personality: '', scenario: '', first_mes: '', mes_example: '', ...card } }
}

describe('tagWeight', () => {
  it('weighs rare tags above common ones', () => {
    expect(tagWeight(1, 1000)).toBeGreaterThan(tagWeight(50, 1000))
    expect(tagWeight(50, 1000)).toBeGreaterThan(tagWeight(900, 1000))
    // A tag every card has still counts for the base weight.
    expect(tagWeight(1000, 1000)).toBe(2)
  })
})

describe('extractKeywords', () => {
  it('keeps proper-noun phrases and drops boilerplate', () => {
    const k = extractKeywords('She is a student at Hogwarts. Personality: shy. {{user}} meets her in Genshin Impact.')
    expect(k.has('hogwarts')).toBe(true)
    expect(k.has('genshin impact')).toBe(true)
    expect(k.has('personality')).toBe(false)
    expect(k.has('she')).toBe(false)
  })
})

describe('findRelated', () => {
  const source = c('src', { tags: ['Witcher', 'fantasy', 'female'], creator: 'Geralt', description: 'A sorceress from Vengerberg.' })
  const filler = Array.from({ length: 20 }, (_, i) => c(`f${i}`, { tags: ['female', 'fantasy'] }))
  const sameUniverse = c('uni', { tags: ['Witcher'], description: 'Raised near Vengerberg.' })
  const sameCreator = c('cre', { creator: 'geralt' })
  const unrelated = c('none', { tags: ['robot'] })
  const pool = [source, sameUniverse, sameCreator, unrelated, ...filler]

  it('ranks the rare shared tag + shared keyword above common-tag matches', () => {
    const results = findRelated(source, pool)
    const uni = results.findIndex((m) => m.id === 'uni')
    const firstFiller = results.findIndex((m) => m.id.startsWith('f'))
    expect(uni).toBeGreaterThanOrEqual(0)
    expect(uni).toBeLessThan(firstFiller)
    expect(results[uni].sharedTags.map((t) => t.tag)).toEqual(['witcher'])
    expect(results[uni].sharedKeywords).toContain('vengerberg')
    expect(results[uni].reasons.some((r) => r.includes('rare'))).toBe(true)
  })

  it('scores the same creator case-insensitively', () => {
    const match = findRelated(source, pool).find((m) => m.id === 'cre')!
    expect(match.sameCreator).toBe(true)
    expect(match.score).toBe(CREATOR_SCORE)
  })

  it('excludes the source itself and zero-score candidates', () => {
    const ids = findRelated(source, pool).map((m) => m.id)
    expect(ids).not.toContain('src')
    expect(ids).not.toContain('none')
  })

  it('honours signal toggles', () => {
    const tagsOnly = findRelated(source, pool, { tags: true, creator: false, content: false })
    expect(tagsOnly.find((m) => m.id === 'cre')).toBeUndefined()
    expect(tagsOnly.find((m) => m.id === 'uni')!.sharedKeywords).toEqual([])
  })

  it('labels strength relative to the best match', () => {
    expect(matchStrength(40, 40)).toBe('strong')
    expect(matchStrength(15, 40)).toBe('moderate')
    expect(matchStrength(5, 40)).toBe('weak')
  })
})
