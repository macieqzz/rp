// Write-side hygiene for remembered facts: skip or merge near-duplicates and keep the store bounded.
import type { ChatFact } from '@/lib/types'

/** Active facts kept per chat before the least valuable are retired. */
export const MAX_ACTIVE_FACTS = 60
/** Retiring stops this far under the cap, so a chat doesn't trim on every single new fact. */
const RETIRE_HEADROOM = 10

const STOPWORDS = new Set(
  'a an and are as at be but by for from had has have her his in into is it its of on or she that the their them they this to was were with you your'.split(' '),
)

function words(text: string): Set<string> {
  const out = new Set<string>()
  for (const w of text.toLowerCase().match(/[a-z0-9À-￿']+/g) ?? []) {
    if (w.length > 2 && !STOPWORDS.has(w)) out.add(w)
  }
  return out
}

/** 0-1 overlap between two fact texts: the larger of Jaccard and how much of the shorter one the longer contains. */
export function factSimilarity(a: string, b: string): number {
  const wa = words(a)
  const wb = words(b)
  if (wa.size === 0 || wb.size === 0) return 0
  let shared = 0
  for (const w of wa) if (wb.has(w)) shared++
  const jaccard = shared / (wa.size + wb.size - shared)
  const containment = shared / Math.min(wa.size, wb.size)
  return Math.max(jaccard, containment * 0.9)
}

export type FactWrite =
  | { action: 'create' }
  | { action: 'merge'; targetId: string; patch: Partial<Pick<ChatFact, 'importance' | 'valence' | 'unresolved' | 'text'>> }

export interface NewFact {
  text: string
  importance: number
  valence: number
  unresolved: boolean
}

const DUPLICATE_THRESHOLD = 0.7

/** A fact already on record is strengthened rather than written twice: its importance rises, and a longer phrasing replaces a terser one. */
export function planFactWrite(fact: NewFact, existing: ChatFact[]): FactWrite {
  let best: ChatFact | undefined
  let bestScore = 0
  for (const e of existing) {
    if (!e.active) continue
    const score = factSimilarity(fact.text, e.text)
    if (score > bestScore) {
      best = e
      bestScore = score
    }
  }
  if (!best || bestScore < DUPLICATE_THRESHOLD) return { action: 'create' }
  const importance = Math.min(1, Math.max(best.importance ?? 0.5, fact.importance) + 0.05)
  return {
    action: 'merge',
    targetId: best.id,
    patch: {
      importance,
      // Never silently reopen a thread the story already closed.
      unresolved: best.unresolved ? true : undefined,
      ...(fact.text.length > best.text.length ? { text: fact.text } : {}),
    },
  }
}

/** How much a fact is worth keeping when the store is full: open threads and weighty facts outlast old trivia. */
function keepScore(f: ChatFact, newest: number, oldest: number): number {
  const recency = newest > oldest ? (f.createdAt - oldest) / (newest - oldest) : 1
  return (f.importance ?? 0.5) * 0.6 + recency * 0.3 + (f.unresolved ? 0.6 : 0)
}

/** Ids to retire so no more than `cap` stay active. Facts at importance 0.8+ and open threads are never chosen. */
export function pickFactsToRetire(active: ChatFact[], cap: number = MAX_ACTIVE_FACTS): string[] {
  if (active.length <= cap) return []
  const target = Math.max(1, cap - RETIRE_HEADROOM)
  const times = active.map((f) => f.createdAt)
  const newest = Math.max(...times)
  const oldest = Math.min(...times)
  const removable = active
    .filter((f) => !f.unresolved && (f.importance ?? 0.5) < 0.8)
    .sort((a, b) => keepScore(a, newest, oldest) - keepScore(b, newest, oldest))
  return removable.slice(0, active.length - target).map((f) => f.id)
}
