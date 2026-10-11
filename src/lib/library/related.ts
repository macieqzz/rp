/**
 * The details modal's Related tab: scores every other character against one source character on
 * three signals — shared tags weighted by rarity (a tag only five cards carry says far more than
 * "female"), the same creator, and shared proper-noun keywords in the card text (franchise,
 * universe and place names) — and explains each match.
 */

import type { CharacterCardData } from '@/lib/characters/cardSpec'

export interface RelatedOptions {
  tags: boolean
  creator: boolean
  content: boolean
}

export interface RelatedMatch {
  id: string
  score: number
  sharedTags: { tag: string; weight: number; count: number }[]
  sameCreator: boolean
  sharedKeywords: string[]
  reasons: string[]
}

export const CREATOR_SCORE = 25
const KEYWORD_SCORE = 10
const KEYWORD_SCORE_CAP = 35
/** A shared tag on this many cards or fewer is called out as rare. */
const RARE_TAG_COUNT = 5

/**
 * Capitalized words that carry no universe signal — sentence starters, card boilerplate and generic
 * nouns that show up capitalized in headings ("Personality:", "Appearance").
 */
const SKIP_WORDS = new Set(
  (
    'the this that these those there here then than when where what which while with without from into onto upon over under ' +
    'after before about above below between through during because since until unless although however therefore also ' +
    'some many most much more very only even just still once both each every other another such same any all none ' +
    'she her hers he him his they them their theirs you your yours we our ours its it is are was were be been being ' +
    'have has had does did doing will would shall should can could may might must not never always often sometimes ' +
    'user char character characters player narrator assistant roleplay scenario personality description appearance ' +
    'background backstory behavior behaviour dialogue example examples greeting message response setting context ' +
    'notes note instructions instruction info information details detail likes dislikes like dislike hobbies hobby ' +
    'age height weight body hair eyes face skin clothing clothes outfit style speech voice gender species race ' +
    'name names world story life love family friend friends home school work city town house room day night time ' +
    'year years today tomorrow yesterday morning evening first second third last next new old young little big ' +
    'good bad great small large long short high low full main true false yes okay well oh ah hey hello please thanks ' +
    'male female woman man girl boy lady sir miss mister mr mrs ms mom dad mother father sister brother ' +
    'monday tuesday wednesday thursday friday saturday sunday january february march april june july august ' +
    'september october november december english japanese chinese korean'
  ).split(' '),
)

/** Lowercased proper-noun phrases ("genshin impact", "hogwarts") from free text. */
export function extractKeywords(text: string): Set<string> {
  const out = new Set<string>()
  const phrases = text.replace(/\{\{(user|char)\}\}/gi, ' ').match(/\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*\b/g) ?? []
  for (const phrase of phrases) {
    const words = phrase.split(/\s+/).filter((w) => !SKIP_WORDS.has(w.toLowerCase()))
    const kept = words.join(' ').toLowerCase()
    if (kept.length > 3) out.add(kept)
  }
  return out
}

/** Rarer tags weigh more: a fixed base plus an inverse-log-frequency bonus. */
export function tagWeight(count: number, total: number): number {
  const frequency = Math.max(count, 1) / Math.max(total, 1)
  return Math.round(2 + Math.max(0, -Math.log10(frequency) * 6))
}

export interface RelatedCandidate {
  id: string
  card: CharacterCardData
}

function keywordsOf(card: CharacterCardData): Set<string> {
  return extractKeywords([card.name, card.description, card.personality, card.scenario, card.first_mes].filter(Boolean).join(' \n '))
}

function lowerTags(card: CharacterCardData): string[] {
  return [...new Set((card.tags ?? []).map((t) => t.toLowerCase().trim()).filter(Boolean))]
}

/** Scores every candidate against `source`, best first; zero-score candidates are dropped. */
export function findRelated(
  source: RelatedCandidate,
  candidates: RelatedCandidate[],
  options: RelatedOptions = { tags: true, creator: true, content: true },
  limit = 40,
): RelatedMatch[] {
  const frequencies = new Map<string, number>()
  for (const c of candidates) for (const t of lowerTags(c.card)) frequencies.set(t, (frequencies.get(t) ?? 0) + 1)
  const total = candidates.length
  const sourceTags = new Set(lowerTags(source.card))
  const sourceCreator = (source.card.creator ?? '').trim().toLowerCase()
  const sourceKeywords = options.content ? keywordsOf(source.card) : new Set<string>()

  const matches: RelatedMatch[] = []
  for (const c of candidates) {
    if (c.id === source.id) continue
    let score = 0
    const reasons: string[] = []

    const sharedTags = options.tags
      ? lowerTags(c.card)
          .filter((t) => sourceTags.has(t))
          .map((tag) => ({ tag, count: frequencies.get(tag) ?? 1, weight: tagWeight(frequencies.get(tag) ?? 1, total) }))
          .sort((a, b) => b.weight - a.weight)
      : []
    if (sharedTags.length) {
      score += sharedTags.reduce((sum, t) => sum + t.weight, 0)
      const rare = sharedTags.filter((t) => t.count <= RARE_TAG_COUNT).length
      reasons.push(
        sharedTags.length === 1
          ? `Shared tag: ${sharedTags[0].tag}${rare ? ' (rare)' : ''}`
          : `${sharedTags.length} shared tags${rare ? ` (${rare} rare)` : ''}: ${sharedTags
              .slice(0, 3)
              .map((t) => t.tag)
              .join(', ')}${sharedTags.length > 3 ? '…' : ''}`,
      )
    }

    const creator = (c.card.creator ?? '').trim()
    const sameCreator = options.creator && !!sourceCreator && creator.toLowerCase() === sourceCreator
    if (sameCreator) {
      score += CREATOR_SCORE
      reasons.push(`Same creator: ${creator}`)
    }

    const sharedKeywords = options.content ? [...keywordsOf(c.card)].filter((k) => sourceKeywords.has(k)) : []
    if (sharedKeywords.length) {
      score += Math.min(sharedKeywords.length * KEYWORD_SCORE, KEYWORD_SCORE_CAP)
      reasons.push(`Shared context: ${sharedKeywords.slice(0, 3).join(', ')}`)
    }

    if (score > 0) matches.push({ id: c.id, score, sharedTags, sameCreator, sharedKeywords, reasons })
  }
  return matches.sort((a, b) => b.score - a.score).slice(0, limit)
}

/** 0-100 strength label for a score, relative to the best match in the set. */
export function matchStrength(score: number, best: number): 'strong' | 'moderate' | 'weak' {
  const ratio = best > 0 ? score / best : 0
  return ratio >= 0.66 || score >= 50 ? 'strong' : ratio >= 0.33 || score >= 25 ? 'moderate' : 'weak'
}
