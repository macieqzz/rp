/**
 * Duplicate detection for the library: pairs of characters that are probably the same card,
 * scored on name similarity, creator match and content overlap (Jaccard over word sets), with a
 * divergence penalty so same-name/same-creator variants with clearly different content (a male and
 * a female version, say) aren't flagged. `exact` mode only reports pairs whose card text is
 * identical across every compared field.
 */

import type { CharacterCardData } from '@/lib/characters/cardSpec'

export interface DuplicateCandidate {
  id: string
  card: CharacterCardData
  createdAt: number
}

export interface DuplicatePair {
  a: string
  b: string
  /** 0-100. */
  confidence: number
  reasons: string[]
}

export interface DuplicateGroup {
  /** Member ids, oldest first. */
  ids: string[]
  confidence: number
  reasons: string[]
}

const CONTENT_FIELDS = ['description', 'personality', 'scenario', 'first_mes', 'mes_example', 'creator_notes'] as const

function normalizeName(name: string): string {
  return name
    .toLowerCase()
    .replace(/\(.*?\)|\[.*?\]/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

function bigrams(s: string): Map<string, number> {
  const out = new Map<string, number>()
  const t = s.replace(/\s+/g, '')
  for (let i = 0; i < t.length - 1; i++) {
    const g = t.slice(i, i + 2)
    out.set(g, (out.get(g) ?? 0) + 1)
  }
  return out
}

/** Sørensen–Dice coefficient over character bigrams, 0..1. */
export function nameSimilarity(a: string, b: string): number {
  const na = normalizeName(a)
  const nb = normalizeName(b)
  if (!na || !nb) return 0
  if (na === nb) return 1
  const ga = bigrams(na)
  const gb = bigrams(nb)
  let overlap = 0
  let total = 0
  for (const [g, n] of ga) {
    overlap += Math.min(n, gb.get(g) ?? 0)
    total += n
  }
  for (const n of gb.values()) total += n
  return total ? (2 * overlap) / total : 0
}

function wordSet(card: CharacterCardData): Set<string> {
  const text = CONTENT_FIELDS.map((f) => card[f] ?? '').join(' ').toLowerCase()
  return new Set(text.match(/[a-z0-9']{3,}/g) ?? [])
}

/** Jaccard index of two sets, 0..1 (1 when both are empty). */
export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1
  let inter = 0
  const [small, large] = a.size < b.size ? [a, b] : [b, a]
  for (const w of small) if (large.has(w)) inter++
  return inter / (a.size + b.size - inter)
}

function contentKey(card: CharacterCardData): string {
  return JSON.stringify([normalizeName(card.name), ...CONTENT_FIELDS.map((f) => (card[f] ?? '').trim())])
}

/**
 * Scores one pair. Name similarity carries most of the weight, creator match and content overlap
 * the rest; strong name/creator agreement with low content overlap is penalized.
 */
export function scorePair(a: DuplicateCandidate, b: DuplicateCandidate, words?: { a: Set<string>; b: Set<string> }): DuplicatePair {
  const reasons: string[] = []
  const name = nameSimilarity(a.card.name, b.card.name)
  const creatorA = (a.card.creator ?? '').trim().toLowerCase()
  const sameCreator = !!creatorA && creatorA === (b.card.creator ?? '').trim().toLowerCase()
  const content = jaccard(words?.a ?? wordSet(a.card), words?.b ?? wordSet(b.card))
  const notesA = (a.card.creator_notes ?? '').trim()
  const sameNotes = !!notesA && notesA === (b.card.creator_notes ?? '').trim()

  let confidence = name * 45 + (sameCreator ? 15 : 0) + content * 35 + (sameNotes ? 5 : 0)
  if (name >= 0.99) reasons.push('Same name')
  else if (name >= 0.75) reasons.push(`Similar name (${Math.round(name * 100)}%)`)
  if (sameCreator) reasons.push('Same creator')
  if (sameNotes) reasons.push("Identical creator's notes")
  reasons.push(`Content overlap ${Math.round(content * 100)}%`)
  if (name >= 0.75 && content < 0.35) {
    confidence -= (0.35 - content) * 60
    reasons.push('Content differs a lot (likely a variant)')
  }
  return { a: a.id, b: b.id, confidence: Math.max(0, Math.min(100, Math.round(confidence))), reasons }
}

/**
 * Finds likely duplicate groups. `sensitivity` is the minimum confidence (0-100) for a pair; 100
 * switches to exact mode. Pairs are only compared when they share a name token, which keeps a large
 * library far from all-pairs cost.
 */
export function findDuplicates(candidates: DuplicateCandidate[], sensitivity = 60): DuplicateGroup[] {
  const pairs: DuplicatePair[] = []
  if (sensitivity >= 100) {
    const byKey = new Map<string, DuplicateCandidate[]>()
    for (const c of candidates) {
      const key = contentKey(c.card)
      byKey.set(key, [...(byKey.get(key) ?? []), c])
    }
    return [...byKey.values()]
      .filter((g) => g.length > 1)
      .map((g) => ({
        ids: [...g].sort((x, y) => x.createdAt - y.createdAt).map((c) => c.id),
        confidence: 100,
        reasons: ['Identical name and card text'],
      }))
  }
  const index = new Map<string, number[]>()
  candidates.forEach((c, i) => {
    for (const token of new Set(normalizeName(c.card.name).split(' ').filter((t) => t.length >= 2))) {
      index.set(token, [...(index.get(token) ?? []), i])
    }
  })
  const words = candidates.map((c) => wordSet(c.card))
  const seen = new Set<string>()
  for (const bucket of index.values()) {
    for (let x = 0; x < bucket.length; x++) {
      for (let y = x + 1; y < bucket.length; y++) {
        const i = bucket[x]
        const j = bucket[y]
        const key = i < j ? `${i}:${j}` : `${j}:${i}`
        if (seen.has(key)) continue
        seen.add(key)
        const pair = scorePair(candidates[i], candidates[j], { a: words[i], b: words[j] })
        if (pair.confidence >= sensitivity) pairs.push(pair)
      }
    }
  }
  // Union-find the qualifying pairs into groups.
  const parent = new Map<string, string>()
  const find = (id: string): string => {
    const p = parent.get(id) ?? id
    if (p === id) return id
    const root = find(p)
    parent.set(id, root)
    return root
  }
  for (const p of pairs) parent.set(find(p.a), find(p.b))
  const groups = new Map<string, { ids: Set<string>; confidence: number; reasons: Set<string> }>()
  for (const p of pairs) {
    const root = find(p.a)
    const g = groups.get(root) ?? { ids: new Set<string>(), confidence: 0, reasons: new Set<string>() }
    g.ids.add(p.a)
    g.ids.add(p.b)
    g.confidence = Math.max(g.confidence, p.confidence)
    p.reasons.forEach((r) => g.reasons.add(r))
    groups.set(root, g)
  }
  const created = new Map(candidates.map((c) => [c.id, c.createdAt]))
  return [...groups.values()]
    .map((g) => ({
      ids: [...g.ids].sort((x, y) => created.get(x)! - created.get(y)!),
      confidence: g.confidence,
      reasons: [...g.reasons],
    }))
    .sort((x, y) => y.confidence - x.confidence)
}
