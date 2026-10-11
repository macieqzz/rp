/**
 * Field-level card diffs for the Character Library: the Edit tab's change tracking/preview, the
 * Versions tab's snapshot comparison, and provider card-update checks all describe "what changed"
 * with the same `FieldDiff` list, rendered by `CardDiffView`.
 */

import type { CharacterCardData } from '@/lib/characters/cardSpec'

/** The card fields the library compares/edits, in display order. */
export const DIFF_FIELDS = [
  'name',
  'description',
  'personality',
  'scenario',
  'first_mes',
  'alternate_greetings',
  'mes_example',
  'creator_notes',
  'system_prompt',
  'post_history_instructions',
  'tags',
  'creator',
  'character_version',
  'character_book',
] as const satisfies readonly (keyof CharacterCardData)[]

export type DiffField = (typeof DIFF_FIELDS)[number]

export const FIELD_LABELS: Record<DiffField, string> = {
  name: 'Name',
  description: 'Description',
  personality: 'Personality',
  scenario: 'Scenario',
  first_mes: 'First message',
  alternate_greetings: 'Alternate greetings',
  mes_example: 'Example dialogue',
  creator_notes: "Creator's notes",
  system_prompt: 'System prompt',
  post_history_instructions: 'Post-history instructions',
  tags: 'Tags',
  creator: 'Creator',
  character_version: 'Version',
  character_book: 'Embedded lorebook',
}

export type FieldDiff =
  | { field: DiffField; kind: 'text'; before: string; after: string }
  | { field: 'tags'; kind: 'tags'; added: string[]; removed: string[]; kept: string[] }
  | { field: 'alternate_greetings'; kind: 'list'; before: string[]; after: string[] }
  | { field: 'character_book'; kind: 'lorebook'; beforeEntries: number; afterEntries: number; before: string; after: string }

function text(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

function strings(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string') : []
}

/** Every field whose value differs between two cards; unchanged fields are omitted. */
export function diffCards(before: CharacterCardData, after: CharacterCardData): FieldDiff[] {
  const out: FieldDiff[] = []
  for (const field of DIFF_FIELDS) {
    if (field === 'tags') {
      const a = strings(before.tags)
      const b = strings(after.tags)
      const aSet = new Set(a.map((t) => t.toLowerCase()))
      const bSet = new Set(b.map((t) => t.toLowerCase()))
      const added = b.filter((t) => !aSet.has(t.toLowerCase()))
      const removed = a.filter((t) => !bSet.has(t.toLowerCase()))
      if (added.length || removed.length) out.push({ field, kind: 'tags', added, removed, kept: b.filter((t) => aSet.has(t.toLowerCase())) })
    } else if (field === 'alternate_greetings') {
      const a = strings(before.alternate_greetings)
      const b = strings(after.alternate_greetings)
      if (a.length !== b.length || a.some((g, i) => g !== b[i])) out.push({ field, kind: 'list', before: a, after: b })
    } else if (field === 'character_book') {
      const a = before.character_book ? JSON.stringify(before.character_book.entries ?? [], null, 1) : ''
      const b = after.character_book ? JSON.stringify(after.character_book.entries ?? [], null, 1) : ''
      if (a !== b) {
        out.push({
          field,
          kind: 'lorebook',
          beforeEntries: before.character_book?.entries?.length ?? 0,
          afterEntries: after.character_book?.entries?.length ?? 0,
          before: a,
          after: b,
        })
      }
    } else {
      const a = text(before[field])
      const b = text(after[field])
      if (a !== b) out.push({ field, kind: 'text', before: a, after: b })
    }
  }
  return out
}

/** Copies only the chosen fields from `incoming` onto `base` — "apply selected fields" of an update. */
export function applyFields(base: CharacterCardData, incoming: CharacterCardData, fields: Iterable<DiffField>): CharacterCardData {
  const next: CharacterCardData = { ...base }
  const target = next as unknown as Record<string, unknown>
  for (const field of fields) target[field] = incoming[field]
  return next
}

export type LineOp = { op: 'same' | 'add' | 'del'; text: string }

/**
 * Line diff via longest-common-subsequence. Inputs past `maxCells` (lines × lines) fall back to a
 * whole-block replace instead of allocating a huge table.
 */
export function lineDiff(before: string, after: string, maxCells = 4_000_000): LineOp[] {
  const a = before.split('\n')
  const b = after.split('\n')
  if (a.length * b.length > maxCells) {
    return [...a.map((t) => ({ op: 'del' as const, text: t })), ...b.map((t) => ({ op: 'add' as const, text: t }))]
  }
  const n = a.length
  const m = b.length
  const lcs: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1])
    }
  }
  const ops: LineOp[] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ op: 'same', text: a[i] })
      i++
      j++
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      ops.push({ op: 'del', text: a[i++] })
    } else {
      ops.push({ op: 'add', text: b[j++] })
    }
  }
  while (i < n) ops.push({ op: 'del', text: a[i++] })
  while (j < m) ops.push({ op: 'add', text: b[j++] })
  return ops
}
