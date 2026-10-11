/**
 * Online character catalogs for the Character Library, mounted at `/api/library/online`.
 *
 * Only providers whose anonymous browse + card fetch work as plain public HTTP from a server are
 * here: Chub, Wyvern, CharacterTavern (SFW without a session cookie) and Botbooru (SFW-only when
 * anonymous). JanitorAI/JannyAI/DataCat sit behind Cloudflare challenges that need a real browser,
 * Pygmalion needs a login, and Saucepan needs a token to import — none fit a plain server fetch.
 *
 * Every upstream call goes through `safeFetch` against a fixed per-provider host; the only route
 * that takes a caller-supplied URL is `/image`, which is limited to the providers' image CDNs.
 */

import { Router, type Request, type Response as ExpressResponse } from 'express'
import { readCapped, safeFetch } from './media.ts'
import type { CharacterCardData, Lorebook, LorebookEntry } from '../../src/lib/characters/cardSpec.ts'
import type {
  OnlineCharacterDetail,
  OnlineCharacterSummary,
  OnlineSearchResult,
  OnlineSort,
  ProviderId,
  RemoteVersion,
} from '../../src/lib/library/types.ts'

type Json = Record<string, unknown>

const CHUB_API = 'https://api.chub.ai'
const CHUB_GATEWAY = 'https://gateway.chub.ai'
const CHUB_AVATARS = 'https://avatars.charhub.io/avatars/'
const CHUB_SITE = 'https://chub.ai'
const WYVERN_API = 'https://api.wyvern.chat'
const WYVERN_SITE = 'https://app.wyvern.chat'
const WYVERN_IMAGES = 'https://imagedelivery.net/Dv4koOwHQU3XnXLqtl0aVQ/'
const CT_API = 'https://character-tavern.com/api'
const CT_SITE = 'https://character-tavern.com'
const CT_CARDS = 'https://ct-cards.storage.character-tavern.com'
const BOTBOORU = 'https://botbooru.com'

/** Image hosts `/image` will proxy (exact host or any subdomain). */
const IMAGE_HOSTS = [
  'charhub.io',
  'chub.ai',
  'characterhub.org',
  'imagedelivery.net',
  'wyvern.chat',
  'character-tavern.com',
  'botbooru.com',
]

const UPSTREAM_TIMEOUT_MS = 20000
const MAX_IMAGE_BYTES = 20 * 1024 * 1024
const MAX_CARD_PNG_BYTES = 32 * 1024 * 1024
const PAGE_SIZE = { chub: 48, wyvern: 48, chartavern: 30, botbooru: 40 } as const
const SORTS: readonly OnlineSort[] = ['popular', 'newest', 'updated', 'rating', 'downloads', 'random']
const PROVIDERS: readonly ProviderId[] = ['chub', 'wyvern', 'chartavern', 'botbooru']

/** An error carrying the HTTP status the route should answer with. */
class HttpError extends Error {
  readonly status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

// ---- Small coercion helpers (upstream JSON is untrusted and loosely shaped) ----

function obj(v: unknown): Json {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : {}
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined
}

function strings(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string' && !!s.trim()) : []
}

/** ISO strings, epoch milliseconds, or epoch seconds → epoch milliseconds. */
function time(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v) && v > 0) return v < 1e12 ? v * 1000 : v
  if (typeof v === 'string' && v) {
    const t = Date.parse(v)
    return Number.isNaN(t) ? undefined : t
  }
  return undefined
}

function stripHtml(text: string): string {
  return text
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
}

/** Same-origin proxy URL for a provider image (what the client renders/downloads). */
export function proxiedImage(url: string | undefined): string | undefined {
  return url ? `/api/library/online/image?url=${encodeURIComponent(url)}` : undefined
}

export function isAllowedImageHost(hostname: string): boolean {
  const host = hostname.toLowerCase()
  return IMAGE_HOSTS.some((d) => host === d || host.endsWith(`.${d}`))
}

// ---- Card normalization ----

/** One lorebook entry, SillyTavern's optional activation fields included (the client re-normalizes fully). */
function normalizeEntry(raw: unknown, fallbackId: number): LorebookEntry {
  const e = obj(raw)
  return {
    id: typeof e.id === 'number' ? e.id : fallbackId,
    keys: strings(e.keys).length ? strings(e.keys) : strings(e.key),
    secondary_keys: strings(e.secondary_keys),
    comment: str(e.comment) || str(e.name),
    content: str(e.content),
    constant: !!e.constant,
    selective: !!e.selective,
    insertion_order: num(e.insertion_order) ?? 100,
    enabled: e.enabled === undefined ? e.disable !== true : !!e.enabled,
    position: e.position === 'after_char' ? 'after_char' : e.position === 'at_depth' ? 'at_depth' : 'before_char',
    case_sensitive: !!e.case_sensitive,
    depth: num(e.depth),
    // ST ignores `probability` unless `useProbability` is on; dropping it here mirrors that.
    probability: e.useProbability === false ? undefined : num(e.probability),
    group: str(e.group) || undefined,
    groupWeight: num(e.groupWeight),
    sticky: num(e.sticky),
    cooldown: num(e.cooldown),
    delay: num(e.delay),
    extensions: obj(e.extensions),
  }
}

function normalizeBook(raw: unknown): Lorebook | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const book = obj(raw)
  const list = Array.isArray(book.entries) ? book.entries : book.entries && typeof book.entries === 'object' ? Object.values(book.entries) : []
  if (list.length === 0) return undefined
  return {
    name: str(book.name),
    description: str(book.description),
    scan_depth: num(book.scan_depth),
    token_budget: num(book.token_budget),
    recursive_scanning: !!book.recursive_scanning,
    extensions: obj(book.extensions),
    entries: list.map(normalizeEntry),
  }
}

/**
 * V1 (flat) / V2 / V3 card JSON → our card shape. A server-side mirror of the essentials of
 * `normalizeCardJson` (which the server can't import at runtime); the client re-runs the full one.
 */
export function toCardData(raw: unknown): CharacterCardData {
  const root = obj(raw)
  const source = root.data && typeof root.data === 'object' ? obj(root.data) : root
  return {
    name: str(source.name).trim() || 'Imported Character',
    description: str(source.description),
    personality: str(source.personality),
    scenario: str(source.scenario),
    first_mes: str(source.first_mes),
    mes_example: str(source.mes_example),
    creator_notes: str(source.creator_notes),
    system_prompt: str(source.system_prompt),
    post_history_instructions: str(source.post_history_instructions),
    alternate_greetings: strings(source.alternate_greetings),
    character_book: normalizeBook(source.character_book),
    tags: strings(source.tags),
    creator: str(source.creator),
    character_version: str(source.character_version),
    extensions: obj(source.extensions),
  }
}

/** Reads the embedded `ccv3`/`chara` card JSON out of a PNG's tEXt chunks, or undefined. */
export function extractPngCard(buf: Uint8Array): unknown {
  const signature = [137, 80, 78, 71, 13, 10, 26, 10]
  if (buf.length < 8 || signature.some((b, i) => buf[i] !== b)) return undefined
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  const found: Record<string, string> = {}
  let offset = 8
  while (offset + 8 <= buf.length) {
    const length = view.getUint32(offset)
    const type = String.fromCharCode(buf[offset + 4], buf[offset + 5], buf[offset + 6], buf[offset + 7])
    const start = offset + 8
    if (start + length > buf.length) break
    if (type === 'tEXt') {
      const data = buf.subarray(start, start + length)
      const nul = data.indexOf(0)
      if (nul > 0) {
        const keyword = Buffer.from(data.subarray(0, nul)).toString('latin1')
        if (keyword === 'chara' || keyword === 'ccv3') found[keyword] = Buffer.from(data.subarray(nul + 1)).toString('latin1')
      }
    }
    if (type === 'IEND') break
    offset = start + length + 4
  }
  const encoded = found.ccv3 ?? found.chara
  if (!encoded) return undefined
  try {
    return JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'))
  } catch {
    return undefined
  }
}

// ---- URL resolution ----

function parseLooseUrl(raw: string): URL | undefined {
  const trimmed = raw.trim()
  if (!trimmed) return undefined
  try {
    return new URL(/^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`)
  } catch {
    return undefined
  }
}

const CHUB_HOSTS = /^(www\.|venus\.)?(chub\.ai|characterhub\.org)$/i
const CHUB_NON_CHARACTER: Record<string, true> = { lorebooks: true, users: true, presets: true, search: true, tags: true, api: true }

function segment(s: string): string {
  try {
    return decodeURIComponent(s)
  } catch {
    return s
  }
}

/** A pasted provider URL → `{ provider, id }`, or null when it isn't a character page we know. */
export function resolveProviderUrl(raw: string): { provider: ProviderId; id: string } | null {
  const u = parseLooseUrl(raw)
  if (!u) return null
  const host = u.hostname.toLowerCase()
  if (CHUB_HOSTS.test(host)) {
    const parts = u.pathname.replace(/^\/characters\//, '/').split('/').filter(Boolean).map(segment)
    if (parts.length >= 2 && !CHUB_NON_CHARACTER[parts[0].toLowerCase()]) return { provider: 'chub', id: `${parts[0]}/${parts[1]}` }
    return null
  }
  if (host === 'app.wyvern.chat' || host === 'www.app.wyvern.chat') {
    const m = u.pathname.match(/^\/(?:profiles\/[^/]+\/)?characters\/([^/]+)/)
    return m ? { provider: 'wyvern', id: segment(m[1]) } : null
  }
  if (host === 'character-tavern.com' || host === 'www.character-tavern.com') {
    const m = u.pathname.match(/^\/character\/([^/]+)\/([^/]+)/)
    return m ? { provider: 'chartavern', id: `${segment(m[1])}/${segment(m[2])}` } : null
  }
  if (host === 'botbooru.com' || host === 'www.botbooru.com') {
    const m = u.pathname.match(/^\/(?:character|posts?)\/(\d+)/)
    return m ? { provider: 'botbooru', id: m[1] } : null
  }
  return null
}

/** `creator/slug`-style ids (Chub, CharacterTavern) → URL-encoded path, rejecting anything else. */
function twoPartPath(id: string): string {
  const parts = id.split('/')
  if (parts.length !== 2 || parts.some((p) => !p || p === '.' || p === '..')) throw new HttpError(400, 'Expected an id like "creator/name".')
  return parts.map(encodeURIComponent).join('/')
}

// ---- Upstream fetch ----

async function upstream(url: string, label: string, headers: Record<string, string> = {}): Promise<Response> {
  let res: Response
  try {
    res = await safeFetch(url, { headers, timeoutMs: UPSTREAM_TIMEOUT_MS })
  } catch (e) {
    throw new HttpError(502, `Could not reach ${label}: ${e instanceof Error ? e.message : String(e)}`)
  }
  if (res.status === 404) {
    await res.body?.cancel()
    throw new HttpError(404, `${label} has no such character.`)
  }
  if (!res.ok) {
    await res.body?.cancel()
    const hint = res.status === 403 || res.status === 503 ? ' (it may be blocking server requests right now)' : ''
    throw new HttpError(502, `${label} returned HTTP ${res.status}${hint}.`)
  }
  return res
}

async function getJson(url: string, label: string, headers: Record<string, string> = {}): Promise<unknown> {
  const res = await upstream(url, label, { Accept: 'application/json', ...headers })
  const text = (await readCapped(res, 16 * 1024 * 1024)).toString('utf8')
  try {
    return JSON.parse(text)
  } catch {
    const page = /^\s*</.test(text) ? ' an error page instead of data (likely a Cloudflare challenge)' : ' data that is not JSON'
    throw new HttpError(502, `${label} returned${page}.`)
  }
}

// ---- Search params ----

export interface SearchQuery {
  query: string
  page: number
  sort: OnlineSort
  nsfw: boolean
  tags: string[]
  excludeTags: string[]
  creator: string
}

function queryString(req: Request, key: string): string {
  const v = req.query[key]
  return typeof v === 'string' ? v.trim() : ''
}

function tagParam(raw: string): string[] {
  return [...new Set(raw.split(',').map((t) => t.trim()).filter(Boolean))].slice(0, 20)
}

export function parseSearchQuery(req: Request): SearchQuery {
  const page = Math.floor(Number(queryString(req, 'page')) || 1)
  const sort = queryString(req, 'sort') as OnlineSort
  const nsfw = queryString(req, 'nsfw')
  return {
    query: queryString(req, 'q').slice(0, 200),
    page: Math.min(Math.max(page, 1), 500),
    sort: SORTS.includes(sort) ? sort : 'popular',
    nsfw: nsfw === '1' || nsfw === 'true',
    tags: tagParam(queryString(req, 'tags')),
    excludeTags: tagParam(queryString(req, 'excludeTags')),
    creator: queryString(req, 'creator').slice(0, 100),
  }
}

function withoutExcluded(items: OnlineCharacterSummary[], exclude: string[]): OnlineCharacterSummary[] {
  if (exclude.length === 0) return items
  const banned = new Set(exclude.map((t) => t.toLowerCase()))
  return items.filter((i) => !i.tags.some((t) => banned.has(t.toLowerCase())))
}

// ======================================================================
// Chub
// ======================================================================

const CHUB_SORT: Record<OnlineSort, string> = {
  popular: 'trending',
  downloads: 'download_count',
  rating: 'rating',
  newest: 'id',
  updated: 'last_activity_at',
  random: 'random',
}

/** Extracts the node list from Chub's several search envelope shapes. */
export function chubNodes(data: unknown): unknown[] {
  const root = obj(data)
  if (Array.isArray(root.nodes)) return root.nodes
  const inner = obj(root.data)
  if (Array.isArray(inner.nodes)) return inner.nodes
  if (Array.isArray(root.data)) return root.data
  return Array.isArray(data) ? data : []
}

export function normalizeChubNode(raw: unknown): OnlineCharacterSummary | undefined {
  const n = obj(raw)
  const fullPath = str(n.fullPath) || str(n.full_path)
  if (!fullPath.includes('/')) return undefined
  const tags = strings(n.topics)
  return {
    provider: 'chub',
    id: fullPath,
    name: str(n.name) || fullPath.split('/')[1],
    creator: fullPath.split('/')[0],
    avatarUrl: proxiedImage(str(n.avatar_url) || `${CHUB_AVATARS}${fullPath}/avatar.webp`),
    tagline: stripHtml(str(n.tagline)) || undefined,
    tags,
    nsfw: n.nsfw === true || n.nsfw_image === true || tags.some((t) => t.toLowerCase() === 'nsfw'),
    url: `${CHUB_SITE}/characters/${fullPath}`,
    tokens: num(n.nTokens) ?? num(n.n_tokens),
    // Chub's naming is backwards: `starCount` is downloads, `n_favorites` the hearts.
    downloads: num(n.starCount) ?? num(n.star_count),
    likes: num(n.n_favorites) ?? num(n.nFavorites),
    createdAt: time(n.createdAt ?? n.created_at),
    updatedAt: time(n.lastActivityAt ?? n.last_activity_at),
  }
}

export function normalizeChubSearch(data: unknown, page: number): OnlineSearchResult {
  const root = obj(data)
  const items = chubNodes(data)
    .map(normalizeChubNode)
    .filter((i): i is OnlineCharacterSummary => !!i)
  const cursor = root.cursor ?? obj(root.data).cursor
  const total = num(root.count) ?? num(obj(root.data).count)
  // Chub sends a cursor even on the last page, so the reported total decides when it reports one.
  const more = items.length > 0 && (total != null ? page * PAGE_SIZE.chub < total : cursor != null)
  return { items, page, hasMore: more, total }
}

/**
 * Chub's `trending` only covers what's hot right now, so as the sort for a typed search or tag
 * filter it finds next to nothing ("barmaid": 0 trending vs 5 by downloads). "Popular" means
 * trending only while just browsing, and all-time downloads once there's something to match.
 */
export function chubSortFor(q: Pick<SearchQuery, 'sort' | 'query' | 'tags' | 'creator'>): string {
  if (q.sort === 'popular' && (q.query || q.tags.length || q.creator)) return CHUB_SORT.downloads
  return CHUB_SORT[q.sort]
}

async function chubSearch(q: SearchQuery): Promise<OnlineSearchResult> {
  const params = new URLSearchParams({
    first: String(PAGE_SIZE.chub),
    page: String(q.page),
    nsfw: String(q.nsfw),
    nsfl: String(q.nsfw),
    include_forks: 'true',
    venus: 'false',
    min_tokens: '50',
    sort: chubSortFor(q),
  })
  if (q.query) params.set('search', q.query)
  if (q.creator) params.set('username', q.creator)
  if (q.tags.length) params.set('topics', q.tags.join(','))
  if (q.excludeTags.length) params.set('excludetopics', q.excludeTags.join(','))
  return normalizeChubSearch(await getJson(`${CHUB_API}/search?${params}`, 'Chub'), q.page)
}

async function chubMetadata(fullPath: string): Promise<Json> {
  const data = obj(await getJson(`${CHUB_API}/api/characters/${twoPartPath(fullPath)}?full=true`, 'Chub'))
  const node = obj(data.node)
  if (!node.fullPath && !node.id) throw new HttpError(404, 'Chub has no such character.')
  return node
}

/** Chub project ids never change, so a plain bounded map spares the version routes a lookup. */
const chubProjectIds = new Map<string, number>()

async function chubProjectId(fullPath: string): Promise<number> {
  const key = fullPath.toLowerCase()
  const known = chubProjectIds.get(key)
  if (known) return known
  const id = num((await chubMetadata(fullPath)).id)
  if (!id) throw new HttpError(502, 'Chub did not return a project id for this character.')
  if (chubProjectIds.size >= 500) chubProjectIds.delete(chubProjectIds.keys().next().value!)
  chubProjectIds.set(key, id)
  return id
}

async function chubCommits(projectId: number): Promise<Json[]> {
  const commits = await getJson(`${CHUB_API}/api/v4/projects/${projectId}/repository/commits`, 'Chub')
  return Array.isArray(commits) ? commits.map(obj) : []
}

async function chubCardAt(projectId: number, ref: string): Promise<unknown> {
  // `raw%252Fcard.json` is Chub's (double-encoded) path to the exported card in the project repo.
  return getJson(`${CHUB_API}/api/v4/projects/${projectId}/repository/files/raw%252Fcard.json/raw?ref=${encodeURIComponent(ref)}`, 'Chub')
}

/**
 * Chub's metadata API uses its own field names; this is the same mapping SillyTavern's
 * `downloadChubCharacter` applies (definition.personality → description, description → creator notes…).
 */
export function buildChubCard(node: Json, linkedBook?: unknown): CharacterCardData {
  const def = obj(node.definition)
  const fullPath = str(node.fullPath)
  const ext = obj(def.extensions)
  return {
    name: str(def.name).trim() || str(node.name) || 'Unknown',
    description: str(def.personality),
    personality: str(def.tavern_personality),
    scenario: str(def.scenario),
    first_mes: str(def.first_message),
    mes_example: str(def.example_dialogs),
    creator_notes: str(def.description),
    system_prompt: str(def.system_prompt),
    post_history_instructions: str(def.post_history_instructions),
    alternate_greetings: strings(def.alternate_greetings),
    character_book: normalizeBook(linkedBook) ?? normalizeBook(def.embedded_lorebook),
    tags: strings(node.topics),
    creator: fullPath.split('/')[0] ?? '',
    character_version: str(def.character_version),
    extensions: { ...ext, chub: { ...obj(ext.chub), id: num(node.id) ?? null, full_path: fullPath, tagline: str(node.tagline) || str(def.tagline) } },
  }
}

async function chubGallery(projectId: number): Promise<string[]> {
  const data = obj(await getJson(`${CHUB_GATEWAY}/api/gallery/project/${projectId}?limit=100&count=false`, 'Chub gallery'))
  const nodes = Array.isArray(data.nodes) ? data.nodes : []
  return nodes.map((n) => str(obj(n).primary_image_path)).filter((u) => /^https:\/\//i.test(u))
}

async function chubCharacter(fullPath: string): Promise<OnlineCharacterDetail> {
  const node = await chubMetadata(fullPath)
  const summary = normalizeChubNode(node)
  if (!summary) throw new HttpError(502, 'Chub returned an unrecognized character.')
  const projectId = num(node.id)
  // Linked (non-embedded) lorebooks only resolve in the project's exported card.json.
  let linkedBook: unknown
  if (projectId && Array.isArray(node.related_lorebooks) && node.related_lorebooks.length > 0) {
    const ref = str((await chubCommits(projectId))[0]?.id)
    if (ref) linkedBook = toCardData(await chubCardAt(projectId, ref)).character_book
  }
  // The gallery lives on a separate gateway; an outage there shouldn't block previews, imports or
  // update checks of the card itself, so it degrades to "no gallery".
  const gallery = projectId && node.hasGallery ? await chubGallery(projectId).catch(() => []) : []
  return {
    ...summary,
    card: buildChubCard(node, linkedBook),
    imageUrl: proxiedImage(str(node.max_res_url) || str(node.avatar_url) || `${CHUB_AVATARS}${summary.id}/chara_card_v2.png`),
    gallery,
  }
}

export function normalizeChubCommit(raw: unknown): RemoteVersion | undefined {
  const c = obj(raw)
  const id = str(c.id)
  if (!id) return undefined
  return { id, message: (str(c.message) || str(c.title)).trim(), createdAt: time(c.committed_date ?? c.created_at) ?? 0 }
}

async function chubVersions(fullPath: string): Promise<RemoteVersion[]> {
  const commits = await chubCommits(await chubProjectId(fullPath))
  return commits.map(normalizeChubCommit).filter((v): v is RemoteVersion => !!v)
}

async function chubVersion(fullPath: string, ref: string): Promise<OnlineCharacterDetail> {
  if (!/^[0-9a-f]{7,64}$/i.test(ref)) throw new HttpError(400, 'Invalid version id.')
  const node = await chubMetadata(fullPath)
  const summary = normalizeChubNode(node)
  const projectId = num(node.id)
  if (!summary || !projectId) throw new HttpError(502, 'Chub returned an unrecognized character.')
  const card = toCardData(await chubCardAt(projectId, ref))
  return { ...summary, card, imageUrl: proxiedImage(str(node.max_res_url) || str(node.avatar_url)) }
}

// ======================================================================
// Wyvern
// ======================================================================

const WYVERN_SORT: Record<OnlineSort, string> = {
  popular: 'popular',
  downloads: 'popular',
  rating: 'votes',
  newest: 'created_at',
  updated: 'created_at',
  random: 'recommended',
}

function wyvernAvatar(c: Json): string | undefined {
  const src = str(c.avatar_url) || str(c.avatar)
  if (!src) return undefined
  return /^https:\/\//i.test(src) ? src : `${WYVERN_IMAGES}${src}/public`
}

/** Wyvern's `name` is the listing title; `chat_name` is the character's actual name. */
function wyvernName(c: Json): string {
  return str(c.chat_name).trim() || str(c.name).trim() || 'Unknown'
}

export function normalizeWyvernCharacter(raw: unknown): OnlineCharacterSummary | undefined {
  const c = obj(raw)
  const id = str(c.id)
  if (!id) return undefined
  const creator = obj(c.creator)
  const stats = { ...obj(c.entity_statistics), ...obj(c.statistics_record) }
  const rating = str(c.rating)
  return {
    provider: 'wyvern',
    id,
    name: wyvernName(c),
    creator: str(creator.displayName) || str(creator.username),
    avatarUrl: proxiedImage(wyvernAvatar(c)),
    tagline: stripHtml(str(c.tagline)) || undefined,
    tags: strings(c.tags),
    nsfw: !!rating && rating !== 'none',
    url: `${WYVERN_SITE}/characters/${id}`,
    likes: num(stats.likes) ?? num(stats.total_likes) ?? num(c.likes),
    createdAt: time(c.created_at),
    updatedAt: time(c.updated_at),
  }
}

export function normalizeWyvernSearch(data: unknown, page: number, excludeTags: string[] = []): OnlineSearchResult {
  const root = obj(data)
  const list = Array.isArray(root.results) ? root.results : Array.isArray(root.characters) ? root.characters : []
  const items = list.map(normalizeWyvernCharacter).filter((i): i is OnlineCharacterSummary => !!i)
  return { items: withoutExcluded(items, excludeTags), page, hasMore: root.hasMore === true, total: num(root.total) }
}

async function wyvernCreatorId(name: string): Promise<string | undefined> {
  const data = obj(await getJson(`${WYVERN_API}/exploreSearch/users?q=${encodeURIComponent(name)}&page=1&limit=10`, 'Wyvern'))
  const users = (Array.isArray(data.results) ? data.results : []).map(obj)
  const lower = name.toLowerCase()
  const exact = users.find((u) => [u.displayName, u.username, u.vanityUrl].some((v) => str(v).toLowerCase() === lower))
  return str((exact ?? users[0])?.uid) || undefined
}

async function wyvernSearch(q: SearchQuery): Promise<OnlineSearchResult> {
  if (q.creator) {
    // Wyvern has no creator filter on search; its per-user listing is one unpaginated page.
    const uid = await wyvernCreatorId(q.creator)
    if (!uid || q.page > 1) return { items: [], page: q.page, hasMore: false }
    const result = normalizeWyvernSearch(await getJson(`${WYVERN_API}/characters/user/${encodeURIComponent(uid)}`, 'Wyvern'), 1, q.excludeTags)
    const needle = q.query.toLowerCase()
    const wanted = q.tags.map((t) => t.toLowerCase())
    const items = result.items.filter(
      (i) =>
        (!needle || i.name.toLowerCase().includes(needle)) &&
        (q.nsfw || !i.nsfw) &&
        wanted.every((t) => i.tags.some((x) => x.toLowerCase() === t)),
    )
    return { items, page: 1, hasMore: false, total: items.length }
  }
  const params = new URLSearchParams({ limit: String(PAGE_SIZE.wyvern), page: String(q.page) })
  if (q.tags.length) params.set('tags', q.tags.join(','))
  // A search query searches globally; a sort restricts to that sort's pool, so only send one.
  if (q.query) params.set('q', q.query)
  else {
    params.set('sort', WYVERN_SORT[q.sort])
    params.set('order', 'DESC')
  }
  if (!q.nsfw) params.set('rating', 'none')
  return normalizeWyvernSearch(await getJson(`${WYVERN_API}/exploreSearch/characters?${params}`, 'Wyvern'), q.page, q.excludeTags)
}

function wyvernAltGreetings(c: Json): string[] {
  if (c.enable_advanced_greetings && Array.isArray(c.greetings) && c.greetings.length > 0) {
    return c.greetings
      .map(obj)
      .filter((g) => g.id !== 'default' && str(g.content).trim())
      .map((g) => str(g.content))
  }
  return strings(c.alternate_greetings)
}

/** Mirrors Wyvern's own card export: shared_info appends to description, character_note → depth prompt. */
export function buildWyvernCard(c: Json): CharacterCardData {
  const creator = obj(c.creator)
  const shared = str(c.shared_info)
  const description = [str(c.description), shared].filter(Boolean).join('\n\n---\n\n')
  const lorebooks = Array.isArray(c.lorebooks) ? c.lorebooks : []
  const extensions: Json = { wyvern: { id: str(c.id) || null, tagline: str(c.tagline) } }
  if (str(c.character_note)) extensions.depth_prompt = { prompt: str(c.character_note), depth: 4, role: 'system' }
  return {
    name: wyvernName(c),
    description,
    personality: str(c.personality),
    scenario: str(c.scenario),
    first_mes: str(c.first_mes),
    mes_example: str(c.mes_example),
    creator_notes: str(c.creator_notes),
    system_prompt: str(c.pre_history_instructions),
    post_history_instructions: str(c.post_history_instructions),
    alternate_greetings: wyvernAltGreetings(c),
    character_book: normalizeBook(lorebooks[0]),
    tags: strings(c.tags),
    creator: str(creator.displayName) || str(creator.username),
    character_version: '',
    extensions,
  }
}

async function wyvernCharacter(id: string): Promise<OnlineCharacterDetail> {
  if (!/^[\w-]{1,64}$/.test(id)) throw new HttpError(400, 'Invalid Wyvern character id.')
  const c = obj(await getJson(`${WYVERN_API}/characters/${encodeURIComponent(id)}`, 'Wyvern'))
  const summary = normalizeWyvernCharacter(c)
  if (!summary) throw new HttpError(404, 'Wyvern has no such character.')
  const gallery = (Array.isArray(c.gallery) ? c.gallery : []).map((g) => str(obj(g).imageURL)).filter((u) => /^https:\/\//i.test(u))
  return { ...summary, card: buildWyvernCard(c), imageUrl: summary.avatarUrl, gallery }
}

// ======================================================================
// CharacterTavern
// ======================================================================

const CT_SORT: Record<OnlineSort, string> = {
  popular: 'most_popular',
  downloads: 'most_popular',
  rating: 'most_likes',
  newest: 'newest',
  updated: 'newest',
  random: 'trending',
}

function ctTags(v: unknown): string[] {
  if (typeof v === 'string') return v.split(/\s+/).filter(Boolean)
  return strings(v)
}

/** CT's `name` is the listing title; `inChatName` is the character's actual name. */
function ctName(c: Json): string {
  return str(c.inChatName).trim() || str(c.name).trim() || 'Unknown'
}

export function normalizeCtHit(raw: unknown): OnlineCharacterSummary | undefined {
  const h = obj(raw)
  const path = str(h.path)
  if (!path.includes('/')) return undefined
  return {
    provider: 'chartavern',
    id: path,
    name: ctName(h),
    creator: str(h.author) || path.split('/')[0],
    avatarUrl: proxiedImage(`${CT_CARDS}/${path}.png`),
    tagline: stripHtml(str(h.tagline) || str(h.pageDescription)) || undefined,
    tags: ctTags(h.tags),
    nsfw: h.isNSFW === true,
    url: `${CT_SITE}/character/${path}`,
    tokens: num(h.totalTokens) ?? num(h.tokenTotal),
    downloads: num(h.downloads) ?? num(h.analytics_downloads),
    likes: num(h.likes),
    createdAt: time(h.createdAt),
    updatedAt: time(h.lastUpdateAt ?? h.updatedAt),
  }
}

export function normalizeCtSearch(data: unknown, page: number, creator = ''): OnlineSearchResult {
  const root = obj(data)
  let items = (Array.isArray(root.hits) ? root.hits : []).map(normalizeCtHit).filter((i): i is OnlineCharacterSummary => !!i)
  // CT has no author filter; the creator is folded into the keyword query and narrowed here.
  if (creator) items = items.filter((i) => i.creator.toLowerCase() === creator.toLowerCase() || i.id.toLowerCase().startsWith(`${creator.toLowerCase()}/`))
  const totalPages = num(root.totalPages) ?? 0
  return { items, page, hasMore: page < totalPages, total: num(root.totalHits) }
}

async function ctSearch(q: SearchQuery): Promise<OnlineSearchResult> {
  const exclude = [...q.excludeTags]
  // CT has no NSFW switch; excluding the tag is how its own site filters.
  if (!q.nsfw && !exclude.some((t) => t.toLowerCase() === 'nsfw')) exclude.push('nsfw')
  const params = new URLSearchParams({
    query: [q.query, q.creator].filter(Boolean).join(' '),
    sort: CT_SORT[q.sort],
    page: String(q.page),
    limit: String(PAGE_SIZE.chartavern),
  })
  if (q.tags.length) params.set('tags', q.tags.join(','))
  if (exclude.length) params.set('exclude_tags', exclude.join(','))
  return normalizeCtSearch(await getJson(`${CT_API}/search/cards?${params}`, 'CharacterTavern'), q.page, q.creator)
}

/** Detail-API fallback when the card PNG can't be read (it omits alternate greetings and lorebook). */
function buildCtCard(c: Json, author: string): CharacterCardData {
  return {
    name: ctName(c),
    description: str(c.definition_character_description),
    personality: str(c.definition_personality),
    scenario: str(c.definition_scenario),
    first_mes: str(c.definition_first_message),
    mes_example: str(c.definition_example_messages),
    creator_notes: str(c.description),
    system_prompt: str(c.definition_system_prompt),
    post_history_instructions: str(c.definition_post_history_prompt),
    alternate_greetings: [],
    tags: ctTags(c.tags),
    creator: author,
    character_version: '',
    extensions: { chartavern: { id: c.id ?? null, path: str(c.path) || null, tagline: str(c.tagline) } },
  }
}

async function ctPngCard(path: string): Promise<CharacterCardData | undefined> {
  try {
    const res = await upstream(`${CT_CARDS}/${path}.png`, 'CharacterTavern', { Accept: 'image/png' })
    const raw = extractPngCard(await readCapped(res, MAX_CARD_PNG_BYTES))
    return raw ? toCardData(raw) : undefined
  } catch {
    // The PNG only enriches the detail API's card; its absence isn't an error for the caller.
    return undefined
  }
}

async function ctCharacter(id: string): Promise<OnlineCharacterDetail> {
  const path = twoPartPath(id)
  const author = segment(path.split('/')[0])
  const [detail, pngCard] = await Promise.all([getJson(`${CT_API}/character/${path}`, 'CharacterTavern'), ctPngCard(path)])
  const c = obj(obj(detail).card)
  if (!Object.keys(c).length) throw new HttpError(404, 'CharacterTavern has no such character.')
  const fromApi = buildCtCard(c, author)
  // The card PNG is canonical (it carries greetings and lorebook); the API knows the real name.
  const card: CharacterCardData = pngCard
    ? {
        ...pngCard,
        name: fromApi.name,
        system_prompt: pngCard.system_prompt || fromApi.system_prompt,
        creator_notes: pngCard.creator_notes || fromApi.creator_notes,
        tags: pngCard.tags?.length ? pngCard.tags : fromApi.tags,
        creator: pngCard.creator || author,
        extensions: { ...pngCard.extensions, chartavern: fromApi.extensions?.chartavern },
      }
    : fromApi
  const summary = normalizeCtHit({ ...c, path: str(c.path) || id, author })
  if (!summary) throw new HttpError(502, 'CharacterTavern returned an unrecognized character.')
  return { ...summary, card, imageUrl: summary.avatarUrl, gallery: [] }
}

// ======================================================================
// Botbooru
// ======================================================================

const BOTBOORU_SORT: Record<OnlineSort, string> = {
  popular: 'views',
  downloads: 'downloads',
  rating: 'favorites',
  newest: 'latest',
  updated: 'latest',
  random: 'random',
}

function botbooruTags(post: Json): { name: string; category: string }[] {
  const raw = Array.isArray(post.tags) ? post.tags : []
  return raw
    .map((t) => (typeof t === 'string' ? { name: t, category: '' } : { name: str(obj(t).name), category: str(obj(t).category) }))
    .filter((t) => t.name)
}

export function normalizeBotbooruPost(raw: unknown): OnlineCharacterSummary | undefined {
  const p = obj(raw)
  const id = p.id == null ? '' : String(p.id)
  if (!/^\d+$/.test(id)) return undefined
  const allTags = botbooruTags(p)
  const tags = allTags.filter((t) => t.category !== 'Writer').map((t) => t.name)
  const filename = str(p.filename)
  return {
    provider: 'botbooru',
    id,
    name: str(p.character_name).trim() || str(p.meta_name).trim() || `Botbooru #${id}`,
    // Botbooru credits the card's writer with a Writer-category tag; the uploader is a fallback.
    creator: allTags.find((t) => t.category === 'Writer')?.name || str(p.uploader_name),
    avatarUrl: proxiedImage(filename ? `${BOTBOORU}/images/preview/480/${encodeURIComponent(filename)}?v=${num(p.card_image_revision) ?? 1}` : undefined),
    tagline: stripHtml(str(p.tagline) || str(p.creator_notes_excerpt) || str(p.description_excerpt)) || undefined,
    tags,
    nsfw: p.is_nsfw === true || tags.some((t) => ['nsfw', 'nsfl'].includes(t.toLowerCase())),
    url: `${BOTBOORU}/character/${id}`,
    tokens: num(p.token_count),
    downloads: num(p.downloads),
    likes: num(p.favorite_count),
    createdAt: time(p.created_at),
    updatedAt: time(p.updated_at),
  }
}

export function normalizeBotbooruSearch(data: unknown, page: number): OnlineSearchResult {
  const root = obj(data)
  const posts = Array.isArray(root.posts) ? root.posts : []
  const items = posts.map(normalizeBotbooruPost).filter((i): i is OnlineCharacterSummary => !!i)
  const total = num(root.total)
  const seen = (page - 1) * PAGE_SIZE.botbooru + posts.length
  return { items, page, hasMore: posts.length > 0 && (total === undefined ? posts.length >= PAGE_SIZE.botbooru : seen < total), total }
}

/** Botbooru tag names are underscore-joined; a space would split one tag into two search terms. */
function bbTerm(tag: string): string {
  return tag.trim().replace(/\s+/g, '_')
}

async function botbooruSearch(q: SearchQuery): Promise<OnlineSearchResult> {
  const terms = [q.query, ...q.tags.map(bbTerm), ...q.excludeTags.map((t) => `-${bbTerm(t)}`), q.creator && bbTerm(q.creator)].filter(Boolean)
  const params = new URLSearchParams({
    sort: BOTBOORU_SORT[q.sort],
    limit: String(PAGE_SIZE.botbooru),
    offset: String((q.page - 1) * PAGE_SIZE.botbooru),
  })
  if (terms.length) params.set('q', terms.join(' '))
  // Anonymous requests are SFW-only server-side regardless; this keeps the switch honest anyway.
  if (!q.nsfw) params.set('sfw_only', 'true')
  return normalizeBotbooruSearch(await getJson(`${BOTBOORU}/posts/?${params}`, 'Botbooru'), q.page)
}

async function botbooruCharacter(id: string): Promise<OnlineCharacterDetail> {
  if (!/^\d{1,12}$/.test(id)) throw new HttpError(400, 'Invalid Botbooru post id.')
  const [post, cardJson] = await Promise.all([getJson(`${BOTBOORU}/post/${id}`, 'Botbooru'), getJson(`${BOTBOORU}/download/json/${id}`, 'Botbooru')])
  const p = obj(post)
  const summary = normalizeBotbooruPost(p)
  if (!summary) throw new HttpError(404, 'Botbooru has no such post.')
  const card = toCardData(cardJson)
  card.creator = summary.creator || card.creator
  const gallery = (Array.isArray(obj(p.mini_gallery).images) ? (obj(p.mini_gallery).images as unknown[]) : [])
    .map(obj)
    .filter((img) => img.status === 'approved' && str(img.download_url).startsWith('/'))
    .map((img) => `${BOTBOORU}${str(img.download_url)}`)
  return { ...summary, card, imageUrl: proxiedImage(`${BOTBOORU}/download/png/${id}`), gallery }
}

// ======================================================================
// Router
// ======================================================================

interface Provider {
  search(q: SearchQuery): Promise<OnlineSearchResult>
  character(id: string): Promise<OnlineCharacterDetail>
}

const IMPLS: Record<ProviderId, Provider> = {
  chub: { search: chubSearch, character: chubCharacter },
  wyvern: { search: wyvernSearch, character: wyvernCharacter },
  chartavern: { search: ctSearch, character: ctCharacter },
  botbooru: { search: botbooruSearch, character: botbooruCharacter },
}

function providerOf(req: Request): ProviderId {
  const p = req.params.provider as ProviderId
  if (!PROVIDERS.includes(p)) throw new HttpError(404, `Unknown provider "${String(req.params.provider)}".`)
  return p
}

function requiredId(req: Request): string {
  const id = queryString(req, 'id')
  if (!id || id.length > 300) throw new HttpError(400, 'Missing "id".')
  return id
}

function sendError(res: ExpressResponse, e: unknown): void {
  const status = e instanceof HttpError ? e.status : 502
  res.status(status).json({ error: e instanceof Error ? e.message : 'Provider request failed.' })
}

/** Runs a JSON route, mapping provider failures to friendly status codes instead of a generic 400. */
function json(fn: (req: Request) => Promise<unknown>) {
  return async (req: Request, res: ExpressResponse) => {
    try {
      res.json(await fn(req))
    } catch (e) {
      sendError(res, e)
    }
  }
}

export function onlineRouter(): Router {
  const router = Router()

  router.get(
    '/resolve',
    json(async (req) => {
      const hit = resolveProviderUrl(queryString(req, 'url'))
      if (!hit) throw new HttpError(404, 'Not a character link from a supported site (Chub, Wyvern, CharacterTavern, Botbooru).')
      return hit
    }),
  )

  router.get('/image', async (req, res) => {
    try {
      const raw = queryString(req, 'url')
      let target: URL
      try {
        target = new URL(raw)
      } catch {
        throw new HttpError(400, 'Invalid image URL.')
      }
      if (target.protocol !== 'https:' || !isAllowedImageHost(target.hostname)) throw new HttpError(403, 'That image host is not allowed.')
      // No AVIF in Accept: Cloudflare-style CDNs negotiate on it, and avatars must stay PNG/JPEG/WebP/GIF.
      const upstreamRes = await upstream(target.toString(), target.hostname, { Accept: 'image/webp,image/png,image/jpeg,image/gif;q=0.9,*/*;q=0.5' })
      const type = (upstreamRes.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase()
      if (!type.startsWith('image/') || type === 'image/svg+xml') {
        await upstreamRes.body?.cancel()
        throw new HttpError(415, 'The provider did not return an image.')
      }
      const body = await readCapped(upstreamRes, MAX_IMAGE_BYTES)
      res.setHeader('Content-Type', type)
      res.setHeader('Cache-Control', 'public, max-age=86400')
      res.setHeader('X-Content-Type-Options', 'nosniff')
      res.send(body)
    } catch (e) {
      sendError(res, e)
    }
  })

  router.get(
    '/:provider/search',
    json((req) => IMPLS[providerOf(req)].search(parseSearchQuery(req))),
  )

  router.get(
    '/:provider/character',
    json((req) => IMPLS[providerOf(req)].character(requiredId(req))),
  )

  router.get(
    '/:provider/versions',
    json(async (req) => {
      if (providerOf(req) !== 'chub') throw new HttpError(404, 'Remote version history is only available for Chub characters.')
      return chubVersions(requiredId(req))
    }),
  )

  router.get(
    '/:provider/version',
    json(async (req) => {
      if (providerOf(req) !== 'chub') throw new HttpError(404, 'Remote version history is only available for Chub characters.')
      const version = queryString(req, 'version')
      if (!version) throw new HttpError(400, 'Missing "version".')
      return chubVersion(requiredId(req), version)
    }),
  )

  return router
}
