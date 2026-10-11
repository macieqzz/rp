import type { Lorebook, LorebookEntry, WorldInfoActivationMode } from '@/lib/characters/cardSpec'

/**
 * SillyTavern world-file interop. ST stores a world as `{ entries: { [uid]: entry } }` with numeric
 * positions and camelCase fields; embedded character books use the V2 `{ entries: [...] }` shape with
 * ST-only settings tucked into each entry's `extensions` (snake_case). Our `LorebookEntry` models a
 * subset of ST's options, so everything we don't model is parked in `entry.extensions` under the
 * same snake_case names ST's own character-book export uses — that way it survives an import → edit
 * → export round trip and lands back in the right ST field.
 */

type Json = Record<string, unknown>
type Position = NonNullable<LorebookEntry['position']>

/** ST position numbers → our three positions. Author's-note / example-message / outlet slots have no
 *  equivalent here, so they fold into the nearest prompt side; the raw number is kept for export. */
const ST_POSITION_TO_OURS: Record<number, Position> = {
  0: 'before_char',
  1: 'after_char',
  2: 'before_char', // top of author's note
  3: 'after_char', // bottom of author's note
  4: 'at_depth',
  5: 'before_char', // top of example messages
  6: 'after_char', // bottom of example messages
  7: 'after_char', // outlet (named macro)
}

const OUR_POSITION_TO_ST: Record<Position, number> = { before_char: 0, after_char: 1, at_depth: 4 }

/** ST world-entry fields we don't model: the world-file key, the key ST's character-book export files
 *  it under, and ST's default (values equal to it aren't worth keeping in our extensions). */
const UNMODELED_FIELDS: ReadonlyArray<readonly [world: string, ext: string, fallback: unknown]> = [
  ['selectiveLogic', 'selectiveLogic', 0],
  ['role', 'role', 0],
  ['excludeRecursion', 'exclude_recursion', false],
  ['preventRecursion', 'prevent_recursion', false],
  ['delayUntilRecursion', 'delay_until_recursion', 0],
  ['vectorized', 'vectorized', false],
  ['matchWholeWords', 'match_whole_words', null],
  ['useGroupScoring', 'use_group_scoring', null],
  ['groupOverride', 'group_override', false],
  ['automationId', 'automation_id', ''],
  ['scanDepth', 'scan_depth', null],
  ['ignoreBudget', 'ignore_budget', false],
  ['outletName', 'outlet_name', ''],
  ['triggers', 'triggers', []],
  ['matchPersonaDescription', 'match_persona_description', false],
  ['matchCharacterDescription', 'match_character_description', false],
  ['matchCharacterPersonality', 'match_character_personality', false],
  ['matchCharacterDepthPrompt', 'match_character_depth_prompt', false],
  ['matchScenario', 'match_scenario', false],
  ['matchCreatorNotes', 'match_creator_notes', false],
]

/** Extension keys dropped on import: copies of fields we model directly (a stale copy could override
 *  an edit made in our editor), and `display_index`, which our array order already captures. */
const STALE_EXT_KEYS = [
  'depth',
  'probability',
  'useProbability',
  'group',
  'group_weight',
  'sticky',
  'cooldown',
  'delay',
  'case_sensitive',
  'display_index',
] as const

/** Our "manual" activation has no ST equivalent; it rides along in the exported entry's extensions. */
const ACTIVATION_EXT_KEY = 'rp_activation_mode'

const isObj = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v)
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)
const str = (v: unknown): string => (typeof v === 'string' ? v : '')
const strList = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((k): k is string => typeof k === 'string') : typeof v === 'string' && v ? [v] : []
const positiveInt = (v: unknown): number | undefined => {
  const n = num(v)
  return n !== undefined && n > 0 ? Math.floor(n) : undefined
}

/**
 * Reads any lorebook-ish JSON into our `Lorebook`: an ST world file (`entries` keyed object), a V2
 * character book (`entries` array), or a whole card (V2/V3 `data.character_book`, or a bare card
 * data object). Throws when nothing recognisable is found.
 */
export function parseWorldFile(raw: unknown, fallbackName: string): Lorebook {
  if (!isObj(raw)) throw new Error('Not a lorebook: expected a JSON object.')
  if (isObj(raw.entries)) {
    const entries = Object.entries(raw.entries)
      .filter((pair): pair is [string, Json] => isObj(pair[1]))
      .map(([key, e], i) => ({ entry: fromWorldEntry(e, key, i), displayIndex: num(e.displayIndex) }))
    return makeBook(raw, str(raw.name) || fallbackName, inDisplayOrder(entries))
  }
  if (Array.isArray(raw.entries)) return fromCharacterBook(raw, str(raw.name) || fallbackName)
  const data = isObj(raw.data) ? raw.data : raw
  if (isObj(data.character_book)) {
    const book = data.character_book
    return fromCharacterBook(book, str(book.name) || str(data.name) || fallbackName)
  }
  throw new Error('Not a recognised lorebook (no world entries, character book, or card lorebook found).')
}

function fromCharacterBook(book: Json, name: string): Lorebook {
  const list = Array.isArray(book.entries) ? book.entries.filter(isObj) : []
  const entries = list.map((e, i) => ({
    entry: fromBookEntry(e, i),
    displayIndex: isObj(e.extensions) ? num(e.extensions.display_index) : undefined,
  }))
  return makeBook(book, name, inDisplayOrder(entries))
}

function makeBook(source: Json, name: string, entries: LorebookEntry[]): Lorebook {
  return {
    name,
    description: str(source.description),
    // ST world files carry no scan/budget settings (they're global there); match `createBook`'s defaults.
    scan_depth: num(source.scan_depth) ?? 8,
    token_budget: num(source.token_budget) ?? 512,
    recursive_scanning: source.recursive_scanning === true,
    extensions: isObj(source.extensions) ? { ...source.extensions } : {},
    entries,
  }
}

/** ST lists entries by `displayIndex` in its editor; keep that order instead of raw key order. */
function inDisplayOrder(items: { entry: LorebookEntry; displayIndex: number | undefined }[]): LorebookEntry[] {
  return items
    .map((item, i) => ({ ...item, rank: item.displayIndex ?? Number.MAX_SAFE_INTEGER, i }))
    .sort((a, b) => a.rank - b.rank || a.i - b.i)
    .map(({ entry }) => entry)
}

function fromWorldEntry(e: Json, key: string, index: number): LorebookEntry {
  const ext: Json = isObj(e.extensions) ? { ...e.extensions } : {}
  for (const [worldKey, extKey] of UNMODELED_FIELDS) {
    if (e[worldKey] !== undefined) ext[extKey] = e[worldKey]
  }
  const rawPosition = num(e.position)
  if (rawPosition !== undefined) ext.position = rawPosition
  const keyId = Number(key)
  return buildEntry({
    id: num(e.uid) ?? (Number.isInteger(keyId) ? keyId : index),
    keys: strList(e.key),
    secondary: strList(e.keysecondary),
    comment: str(e.comment),
    content: str(e.content),
    constant: e.constant === true,
    selective: e.selective !== false,
    order: num(e.order),
    enabled: e.disable !== true,
    position: rawPosition !== undefined ? ST_POSITION_TO_OURS[rawPosition] : undefined,
    depth: num(e.depth),
    caseSensitive: e.caseSensitive === true,
    probability: e.useProbability === false ? undefined : num(e.probability),
    group: str(e.group),
    groupWeight: num(e.groupWeight),
    sticky: e.sticky,
    cooldown: e.cooldown,
    delay: e.delay,
    ext,
  })
}

/** V2 character-book entry; ST's own export puts its numeric position/depth/etc. in `extensions`. */
function fromBookEntry(e: Json, index: number): LorebookEntry {
  const ext: Json = isObj(e.extensions) ? { ...e.extensions } : {}
  const named = e.position
  const namedPosition: Position | undefined =
    named === 'before_char' || named === 'after_char' || named === 'at_depth' ? named : undefined
  const extPosition = num(ext.position)
  const mapped = extPosition !== undefined ? ST_POSITION_TO_OURS[extPosition] : undefined
  // ST writes `before_char` for slot 0 and `after_char` for every other slot; a named position that
  // contradicts the numeric slot means the entry was moved since, so the name wins.
  const extAgrees =
    mapped !== undefined &&
    (namedPosition === undefined || namedPosition === mapped || namedPosition === (extPosition === 0 ? 'before_char' : 'after_char'))
  const position = extAgrees ? mapped : namedPosition
  const useProbability = e.useProbability ?? ext.useProbability
  return buildEntry({
    id: num(e.id) ?? index,
    keys: strList(e.keys ?? e.key),
    secondary: strList(e.secondary_keys ?? e.keysecondary),
    comment: str(e.comment),
    content: str(e.content),
    constant: e.constant === true,
    selective: e.selective === true,
    order: num(e.insertion_order) ?? num(e.order),
    enabled: e.enabled === undefined ? e.disable !== true : e.enabled === true,
    position,
    depth: num(e.depth) ?? num(ext.depth),
    caseSensitive: (e.case_sensitive ?? ext.case_sensitive) === true,
    probability: useProbability === false ? undefined : (num(e.probability) ?? num(ext.probability)),
    group: str(e.group) || str(ext.group),
    groupWeight: num(e.groupWeight) ?? num(ext.group_weight),
    sticky: e.sticky ?? ext.sticky,
    cooldown: e.cooldown ?? ext.cooldown,
    delay: e.delay ?? ext.delay,
    activationMode: e.activationMode,
    ext,
  })
}

interface EntryFields {
  id: number
  keys: string[]
  secondary: string[]
  comment: string
  content: string
  constant: boolean
  selective: boolean
  order: number | undefined
  enabled: boolean
  position: Position | undefined
  depth: number | undefined
  caseSensitive: boolean
  probability: number | undefined
  group: string
  groupWeight: number | undefined
  sticky: unknown
  cooldown: unknown
  delay: unknown
  activationMode?: unknown
  ext: Json
}

function buildEntry(f: EntryFields): LorebookEntry {
  const ext = { ...f.ext }
  const storedMode = ext[ACTIVATION_EXT_KEY] ?? f.activationMode
  delete ext[ACTIVATION_EXT_KEY]
  for (const k of STALE_EXT_KEYS) delete ext[k]
  for (const [, extKey, fallback] of UNMODELED_FIELDS) {
    if (extKey in ext && JSON.stringify(ext[extKey]) === JSON.stringify(fallback)) delete ext[extKey]
  }
  const activationMode: WorldInfoActivationMode =
    storedMode === 'manual' || storedMode === 'always' || storedMode === 'keyword'
      ? storedMode
      : f.constant
        ? 'always'
        : 'keyword'
  const position = f.position ?? 'before_char'
  return {
    id: f.id,
    keys: f.keys,
    secondary_keys: f.secondary,
    comment: f.comment,
    content: f.content,
    constant: activationMode === 'always',
    selective: f.selective,
    insertion_order: f.order ?? 100,
    enabled: f.enabled,
    position,
    depth: f.depth !== undefined && f.depth >= 0 ? f.depth : undefined,
    case_sensitive: f.caseSensitive,
    activationMode,
    probability: f.probability,
    group: f.group.trim() ? f.group : undefined,
    groupWeight: f.groupWeight !== undefined && f.groupWeight >= 0 ? f.groupWeight : undefined,
    sticky: positiveInt(f.sticky),
    cooldown: positiveInt(f.cooldown),
    delay: positiveInt(f.delay),
    extensions: ext,
  }
}

/**
 * Our `Lorebook` as an ST world file: entries keyed by uid with every field ST's editor expects, so
 * the file imports cleanly through ST's World Info "Import" button.
 */
export function toWorldFile(book: Lorebook): { name: string; entries: Record<string, Json> } {
  const entries: Record<string, Json> = {}
  const used = new Set<number>()
  // Ids other entries already claim, so an id-less entry doesn't steal one and force a renumber.
  const reserved = new Set(book.entries.map((e) => e.id))
  let next = 0
  const claimUid = (wanted: number | undefined): number => {
    if (wanted !== undefined && Number.isInteger(wanted) && wanted >= 0 && !used.has(wanted)) {
      used.add(wanted)
      return wanted
    }
    while (used.has(next) || reserved.has(next)) next++
    used.add(next)
    return next
  }
  book.entries.forEach((entry, index) => {
    const uid = claimUid(entry.id)
    entries[String(uid)] = toWorldEntry(entry, uid, index)
  })
  return { name: book.name ?? '', entries }
}

function toWorldEntry(entry: LorebookEntry, uid: number, index: number): Json {
  const ext: Json = { ...(entry.extensions ?? {}) }
  const position = entry.position ?? 'before_char'
  const rawPosition = num(ext.position)
  // Keep ST's finer-grained slot (e.g. author's note) only while it still agrees with our position.
  const stPosition =
    rawPosition !== undefined && ST_POSITION_TO_OURS[rawPosition] === position ? rawPosition : OUR_POSITION_TO_ST[position]
  delete ext.position
  const mode = entry.activationMode ?? (entry.constant ? 'always' : 'keyword')
  const secondary = entry.secondary_keys ?? []
  const out: Json = {
    uid,
    key: [...entry.keys],
    keysecondary: [...secondary],
    comment: entry.comment ?? '',
    content: entry.content,
    constant: mode === 'always',
    selective: entry.selective || secondary.length > 0,
    addMemo: !!entry.comment,
    order: entry.insertion_order,
    position: stPosition,
    disable: !entry.enabled,
    probability: entry.probability ?? 100,
    useProbability: entry.probability !== undefined,
    depth: entry.depth ?? 4,
    group: entry.group ?? '',
    groupWeight: entry.groupWeight ?? 100,
    caseSensitive: entry.case_sensitive ? true : null,
    sticky: entry.sticky ?? null,
    cooldown: entry.cooldown ?? null,
    delay: entry.delay ?? null,
    // ST's displayIndex follows our list order, not whatever order the file was imported in.
    displayIndex: index,
  }
  for (const [worldKey, extKey, fallback] of UNMODELED_FIELDS) {
    out[worldKey] = ext[extKey] ?? fallback
    delete ext[extKey]
  }
  if (mode === 'manual') ext[ACTIVATION_EXT_KEY] = 'manual'
  if (Object.keys(ext).length > 0) out.extensions = ext
  return out
}

/** File name ST would accept for a world: strips path-illegal characters, keeps spaces. */
export function worldFileName(name: string): string {
  const cleaned = name.replace(/[/?<>\\:*|"\x00-\x1f]/g, '').replace(/[. ]+$/, '').trim()
  return `${cleaned || 'World Info'}.json`
}

/** Saves `book` as an ST world JSON download. */
export function downloadWorldFile(book: Lorebook, name = book.name ?? ''): void {
  const blob = new Blob([JSON.stringify(toWorldFile({ ...book, name }), null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = worldFileName(name)
  a.click()
  URL.revokeObjectURL(url)
}

/** Case-insensitive match on a book's name, entry titles, keys, or content — the manager's search box. */
export function lorebookMatches(book: Lorebook, query: string): boolean {
  const q = query.trim().toLowerCase()
  if (!q) return true
  if ((book.name ?? '').toLowerCase().includes(q)) return true
  return book.entries.some(
    (e) =>
      (e.comment ?? '').toLowerCase().includes(q) ||
      e.keys.some((k) => k.toLowerCase().includes(q)) ||
      (e.secondary_keys ?? []).some((k) => k.toLowerCase().includes(q)) ||
      e.content.toLowerCase().includes(q),
  )
}
