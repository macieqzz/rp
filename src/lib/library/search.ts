/**
 * The Character Library grid's query pipeline: a per-character search index (`LibraryEntry`), the
 * `prefix:value` search syntax, tri-state tag filtering and sorting. Pure, so the grid can rerun it
 * on every keystroke and tests can pin the semantics down.
 */

import type { Character } from '@/lib/characters/cardSpec'
import { estimateTokens } from '@/lib/tokenEstimate'
import { displayNameOf, getProviderLink, isFavorite } from './links'
import type { Playlist, ProviderLink } from './types'

export interface LibraryEntry {
  character: Character
  id: string
  /** Display name (the override when set). */
  name: string
  lowerName: string
  /** The card's own name, lowercased — searched too when an override hides it. */
  lowerCardName: string
  tags: string[]
  lowerTags: string[]
  lowerCreator: string
  lowerNotes: string
  version: string
  favorite: boolean
  link?: ProviderLink
  /** Estimated tokens across the prompt-bearing card fields. */
  tokens: number
  createdAt: number
  updatedAt: number
  /** Lowercased names of every playlist this character is in. */
  playlists: string[]
  mediaCount: number
  cgCount: number
  chats: number
  messages: number
  lastChatAt: number
}

export interface EntryContext {
  playlists?: Playlist[]
  mediaCounts?: Record<string, number>
  chatStats?: Record<string, { chats: number; messages: number; lastChatAt: number }>
}

/** Card fields that are sent to the model every turn — what "token count" sorts by. */
export function cardTokenCount(character: Character): number {
  const c = character.card
  return estimateTokens(
    [c.description, c.personality, c.scenario, c.first_mes, c.mes_example, c.system_prompt, c.post_history_instructions]
      .filter(Boolean)
      .join('\n'),
  )
}

export function buildEntries(characters: Character[], ctx: EntryContext = {}): LibraryEntry[] {
  const playlistsById = new Map<string, string[]>()
  for (const p of ctx.playlists ?? []) {
    for (const id of p.characterIds) {
      const list = playlistsById.get(id) ?? []
      list.push(p.name.toLowerCase())
      playlistsById.set(id, list)
    }
  }
  return characters.map((character) => {
    const card = character.card
    const name = displayNameOf(card)
    const tags = (card.tags ?? []).filter((t): t is string => typeof t === 'string' && !!t.trim())
    const stats = ctx.chatStats?.[character.id]
    return {
      character,
      id: character.id,
      name,
      lowerName: name.toLowerCase(),
      lowerCardName: (card.name ?? '').toLowerCase(),
      tags,
      lowerTags: tags.map((t) => t.toLowerCase()),
      lowerCreator: (card.creator ?? '').toLowerCase(),
      lowerNotes: (card.creator_notes ?? '').toLowerCase(),
      version: (card.character_version ?? '').toLowerCase(),
      favorite: isFavorite(card),
      link: getProviderLink(card),
      tokens: cardTokenCount(character),
      createdAt: character.createdAt,
      updatedAt: character.updatedAt,
      playlists: playlistsById.get(character.id) ?? [],
      mediaCount: ctx.mediaCounts?.[character.id] ?? 0,
      cgCount: character.gallery?.length ?? 0,
      chats: stats?.chats ?? 0,
      messages: stats?.messages ?? 0,
      lastChatAt: stats?.lastChatAt ?? 0,
    }
  })
}

// ---- Search syntax ----

/** `chub:yes` etc. Providers the library can't link to (JanitorAI, Pygmalion, …) are still parsed so a
 *  query written for SillyTavern's library behaves sensibly: nothing here is ever linked to them. */
const LINK_PREFIXES: Record<string, string> = {
  linked: 'any',
  chub: 'chub',
  wyvern: 'wyvern',
  ct: 'chartavern',
  charactertavern: 'chartavern',
  botbooru: 'botbooru',
  bb: 'botbooru',
  janny: 'jannyai',
  janitorai: 'janitorai',
  jai: 'janitorai',
  pygmalion: 'pygmalion',
  datacat: 'datacat',
  dc: 'datacat',
  saucepan: 'saucepan',
}

const VALUE_PREFIXES = ['creator', 'version', 'gallery', 'uid', 'playlist', 'tag', 'fav', 'favorite', 'chats'] as const

export interface ParsedSearch {
  /** Free text left after removing every recognized `prefix:value` token, trimmed and lowercased. */
  text: string
  creator?: string
  version?: string
  /** `none`/`empty` = no library media and no CG art; any other value (`any`, `yes`) = has some.
   *  RP Suite folders are per-character by id, so there's no SillyTavern gallery-id to match. */
  gallery?: string
  uid?: string
  playlist?: string
  /** Extra exact-tag requirement (`tag:elf`), ANDed with the tag filter. */
  tags: string[]
  favorite?: boolean
  hasChats?: boolean
  /** One requirement per link prefix; `provider: 'any'` = linked anywhere. */
  links: { provider: string; want: boolean }[]
}

const YES = new Set(['yes', 'true', 'y', '1', 'linked', 'on'])
const NO = new Set(['no', 'false', 'n', '0', 'unlinked', 'off'])

function yesNo(value: string): boolean | undefined {
  return YES.has(value) ? true : NO.has(value) ? false : undefined
}

/**
 * Parses the library search box. Recognized `prefix:value` tokens (values may be "double quoted" to
 * include spaces) become filters; everything else is free text. Unknown prefixes stay in the free
 * text, so searching for `re:zero` still works.
 */
export function parseSearch(raw: string): ParsedSearch {
  const parsed: ParsedSearch = { text: '', tags: [], links: [] }
  const prefixes = [...VALUE_PREFIXES, ...Object.keys(LINK_PREFIXES)].join('|')
  const re = new RegExp(`(^|\\s)(${prefixes}):(?:"([^"]*)"|(\\S+))`, 'gi')
  const rest = raw.replace(re, (whole, lead: string, prefixRaw: string, quoted?: string, bare?: string) => {
    const prefix = prefixRaw.toLowerCase()
    const value = (quoted ?? bare ?? '').trim().toLowerCase()
    if (!value) return whole
    if (prefix in LINK_PREFIXES) {
      const want = yesNo(value)
      if (want === undefined) return whole
      parsed.links.push({ provider: LINK_PREFIXES[prefix], want })
    } else if (prefix === 'fav' || prefix === 'favorite') {
      const want = yesNo(value)
      if (want === undefined) return whole
      parsed.favorite = want
    } else if (prefix === 'chats') {
      const want = yesNo(value)
      if (want === undefined) return whole
      parsed.hasChats = want
    } else if (prefix === 'tag') {
      parsed.tags.push(value)
    } else {
      parsed[prefix as 'creator' | 'version' | 'gallery' | 'uid' | 'playlist'] = value
    }
    return lead
  })
  parsed.text = rest.replace(/\s+/g, ' ').trim().toLowerCase()
  return parsed
}

const EMPTY_VALUES = new Set(['none', 'empty'])

/** `version:none`-style matcher shared by the version/uid prefixes. */
function matchesValue(actual: string, wanted: string): boolean {
  if (EMPTY_VALUES.has(wanted)) return !actual
  return actual === wanted || actual.includes(wanted)
}

export interface SearchFields {
  name: boolean
  tags: boolean
  creator: boolean
  notes: boolean
}

export const DEFAULT_SEARCH_FIELDS: SearchFields = { name: true, tags: true, creator: true, notes: false }

export function matchesSearch(entry: LibraryEntry, q: ParsedSearch, fields: SearchFields = DEFAULT_SEARCH_FIELDS): boolean {
  if (q.creator && !entry.lowerCreator.includes(q.creator)) return false
  if (q.version && !matchesValue(entry.version, q.version)) return false
  if (q.uid && !matchesValue(entry.id.toLowerCase(), q.uid)) return false
  if (q.gallery) {
    const has = entry.mediaCount + entry.cgCount > 0
    if (EMPTY_VALUES.has(q.gallery) ? has : !has) return false
  }
  if (q.playlist) {
    if (EMPTY_VALUES.has(q.playlist)) {
      if (entry.playlists.length > 0) return false
    } else if (q.playlist === 'any' || q.playlist === 'yes') {
      if (entry.playlists.length === 0) return false
    } else if (!entry.playlists.some((p) => p.includes(q.playlist!))) return false
  }
  if (q.favorite !== undefined && entry.favorite !== q.favorite) return false
  if (q.hasChats !== undefined && entry.chats > 0 !== q.hasChats) return false
  for (const tag of q.tags) if (!entry.lowerTags.includes(tag)) return false
  for (const req of q.links) {
    const linked = req.provider === 'any' ? !!entry.link : entry.link?.provider === req.provider
    if (linked !== req.want) return false
  }
  if (!q.text) return true
  return (
    (fields.name && (entry.lowerName.includes(q.text) || entry.lowerCardName.includes(q.text))) ||
    (fields.tags && entry.lowerTags.some((t) => t.includes(q.text))) ||
    (fields.creator && entry.lowerCreator.includes(q.text)) ||
    (fields.notes && entry.lowerNotes.includes(q.text))
  )
}

// ---- Tri-state tag filter ----

export type TagState = 'include' | 'exclude'
/** Lowercased tag → state; a tag absent from the map is neutral. */
export type TagFilter = Record<string, TagState>
/** `any`: OR across the listed tags; `all`: AND. */
export type TagMatchMode = 'any' | 'all'

/** neutral → include → exclude → neutral, the click cycle of a tag chip. */
export function cycleTagState(filter: TagFilter, tag: string): TagFilter {
  const key = tag.toLowerCase()
  const next = { ...filter }
  const current = filter[key]
  if (!current) next[key] = 'include'
  else if (current === 'include') next[key] = 'exclude'
  else delete next[key]
  return next
}

/**
 * Include: with mode `any` the character needs at least one included tag, with `all` every one.
 * Exclude: with mode `any` any excluded tag rejects it, with `all` only having every excluded tag does.
 */
export function matchesTagFilter(
  lowerTags: string[],
  filter: TagFilter,
  includeMode: TagMatchMode = 'any',
  excludeMode: TagMatchMode = 'any',
): boolean {
  const included: string[] = []
  const excluded: string[] = []
  for (const [tag, state] of Object.entries(filter)) (state === 'include' ? included : excluded).push(tag)
  if (excluded.length) {
    const hit = excludeMode === 'all' ? excluded.every((t) => lowerTags.includes(t)) : excluded.some((t) => lowerTags.includes(t))
    if (hit) return false
  }
  if (included.length) {
    const hit = includeMode === 'all' ? included.every((t) => lowerTags.includes(t)) : included.some((t) => lowerTags.includes(t))
    if (!hit) return false
  }
  return true
}

// ---- Sorting ----

export type SortKey = 'name' | 'modified' | 'created' | 'tokens' | 'chats' | 'lastChat' | 'random' | 'playlist'
export type SortDir = 'asc' | 'desc'

/** Cheap deterministic string hash, so a "random" order is stable until the seed changes. */
function hashSeed(s: string): number {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

export function sortEntries(entries: LibraryEntry[], key: SortKey, dir: SortDir, seed = 0): LibraryEntry[] {
  const sign = dir === 'asc' ? 1 : -1
  const byName = (a: LibraryEntry, b: LibraryEntry) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true })
  const out = [...entries]
  if (key === 'random') {
    const keyed = new Map(out.map((e) => [e.id, hashSeed(`${seed}:${e.id}`)]))
    return out.sort((a, b) => keyed.get(a.id)! - keyed.get(b.id)!)
  }
  const value: Record<Exclude<SortKey, 'name' | 'random' | 'playlist'>, (e: LibraryEntry) => number> = {
    modified: (e) => e.updatedAt,
    created: (e) => e.createdAt,
    tokens: (e) => e.tokens,
    chats: (e) => e.chats,
    lastChat: (e) => e.lastChatAt,
  }
  if (key === 'name' || key === 'playlist') return out.sort((a, b) => sign * byName(a, b))
  const get = value[key]
  return out.sort((a, b) => sign * (get(a) - get(b)) || byName(a, b))
}

// ---- The whole pipeline ----

export interface LibraryQuery {
  search: string
  fields: SearchFields
  tagFilter: TagFilter
  includeMode: TagMatchMode
  excludeMode: TagMatchMode
  favoritesOnly: boolean
  /** Restricts to one playlist; sort `playlist` then keeps the playlist's own order. */
  playlist?: Playlist
  sort: SortKey
  dir: SortDir
  seed: number
}

export function runQuery(entries: LibraryEntry[], query: LibraryQuery): LibraryEntry[] {
  const parsed = parseSearch(query.search)
  const members = query.playlist ? new Set(query.playlist.characterIds) : undefined
  const filtered = entries.filter(
    (e) =>
      (!members || members.has(e.id)) &&
      (!query.favoritesOnly || e.favorite) &&
      matchesTagFilter(e.lowerTags, query.tagFilter, query.includeMode, query.excludeMode) &&
      matchesSearch(e, parsed, query.fields),
  )
  if (query.playlist && query.sort === 'playlist') {
    const order = new Map(query.playlist.characterIds.map((id, i) => [id, i]))
    const sorted = filtered.sort((a, b) => order.get(a.id)! - order.get(b.id)!)
    return query.dir === 'desc' ? sorted.reverse() : sorted
  }
  return sortEntries(filtered, query.sort, query.dir, query.seed)
}

/** Every tag in the library with its usage count, most used first. */
export function tagCounts(entries: LibraryEntry[]): { tag: string; key: string; count: number }[] {
  const counts = new Map<string, { tag: string; count: number }>()
  for (const e of entries) {
    e.tags.forEach((tag, i) => {
      const key = e.lowerTags[i]
      const c = counts.get(key)
      if (c) c.count++
      else counts.set(key, { tag, count: 1 })
    })
  }
  return [...counts].map(([key, v]) => ({ key, ...v })).sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag))
}
