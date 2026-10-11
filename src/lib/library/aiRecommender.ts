/**
 * The Character Library's LLM card recommender: filter the library to a pool, sample it, send the
 * model a compact numbered list (indices instead of ids — far fewer tokens, and nothing to garble),
 * and map its JSON picks back to characters. Batch mode fans the pool out over parallel calls and
 * then runs one reduce pass to rank the combined picks, so coverage scales without a bigger prompt.
 */

import type { Character } from '@/lib/characters/cardSpec'
import type { ChatBackend } from '@/lib/api/chatBackend'
import { generateWithTimeout } from '@/lib/api/generateWithTimeout'
import { parseLooseJson } from '@/lib/characters/aiStudio'
import { estimateTokens } from '@/lib/tokenEstimate'
import { displayNameOf, isFavorite } from './links'

export interface RecommenderFilters {
  /** `true` = only characters with chats, `false` = only without, unset = any. */
  hasChats?: boolean
  favorite?: boolean
  /** All of these (case-insensitive). */
  includeTags?: string[]
  /** None of these (case-insensitive). */
  excludeTags?: string[]
  createdAfter?: number
  createdBefore?: number
}

/** Which card metadata goes into each list line besides the name. */
export interface RecommenderContextFields {
  tags: boolean
  creatorNotes: boolean
  creator: boolean
  description: boolean
}

export const DEFAULT_CONTEXT_FIELDS: RecommenderContextFields = {
  tags: true,
  creatorNotes: true,
  creator: true,
  description: false,
}

export interface Recommendation {
  characterId: string
  reason: string
}

/** Characters' free-text fields are clipped to this many characters each in the list. */
const FIELD_CLIP = 400
const RECOMMENDER_TIMEOUT_MS = 120_000

export function buildRecommenderPool(
  characters: Character[],
  filters: RecommenderFilters,
  chatStats: Record<string, { chats: number }>,
): Character[] {
  const include = (filters.includeTags ?? []).map((t) => t.trim().toLowerCase()).filter(Boolean)
  const exclude = (filters.excludeTags ?? []).map((t) => t.trim().toLowerCase()).filter(Boolean)
  return characters.filter((c) => {
    if (filters.hasChats !== undefined && (chatStats[c.id]?.chats ?? 0) > 0 !== filters.hasChats) return false
    if (filters.favorite !== undefined && isFavorite(c.card) !== filters.favorite) return false
    if (filters.createdAfter !== undefined && c.createdAt < filters.createdAfter) return false
    if (filters.createdBefore !== undefined && c.createdAt > filters.createdBefore) return false
    if (include.length || exclude.length) {
      const tags = new Set((c.card.tags ?? []).map((t) => t.trim().toLowerCase()))
      if (!include.every((t) => tags.has(t))) return false
      if (exclude.some((t) => tags.has(t))) return false
    }
    return true
  })
}

/** A random `size`-subset in random order (partial Fisher-Yates); `rng` is injectable for tests. */
export function sampleCharacters<T>(pool: T[], size: number, rng: () => number = Math.random): T[] {
  const out = [...pool]
  const n = Math.max(0, Math.min(Math.floor(size), out.length))
  for (let i = 0; i < n; i++) {
    const j = i + Math.floor(rng() * (out.length - i))
    ;[out[i], out[j]] = [out[j], out[i]]
  }
  return out.slice(0, n)
}

/**
 * Card text as one plain line: creator notes are often HTML with embedded CSS, which costs tokens
 * and tells the model nothing.
 */
export function plainText(raw: string): string {
  return raw
    .replace(/<(style|script)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
}

function characterLine(c: Character, index: number, fields: RecommenderContextFields, reason?: string): string {
  const parts = [`#${index} "${displayNameOf(c.card) || 'Unknown'}"`]
  if (fields.tags && c.card.tags?.length) parts.push(`[tags: ${c.card.tags.join(', ')}]`)
  if (fields.creator && c.card.creator?.trim()) parts.push(`[creator: ${c.card.creator.trim()}]`)
  if (fields.creatorNotes && c.card.creator_notes) {
    const notes = plainText(c.card.creator_notes).slice(0, FIELD_CLIP)
    if (notes) parts.push(`[creator notes: ${notes}]`)
  }
  if (fields.description && c.card.description) {
    const desc = plainText(c.card.description).slice(0, FIELD_CLIP)
    if (desc) parts.push(`[description: ${desc}]`)
  }
  if (reason) parts.push(`[initial pick reason: ${reason}]`)
  return parts.join(' ')
}

const RESPONSE_FORMAT =
  'Output ONLY a JSON object shaped {"recommendations": [{"index": 1, "reason": "brief explanation"}]}, best match first. No markdown fences, no commentary.'

export function buildRecommenderPrompt(
  prompt: string,
  sample: Character[],
  contextFields: RecommenderContextFields,
  opts: { maxResults?: number } = {},
): string {
  const maxResults = opts.maxResults ?? 10
  return [
    "You are a character recommendation engine for a roleplay character library. Below is a numbered list of characters with their metadata. Recommend the ones that best match the user's request.",
    `Rules:
- Only recommend characters from the list. Never invent characters.
- Identify each pick by its number: #5 is "index": 5.
- Give a brief, specific reason for each pick, citing what in its metadata matches.
- If nothing matches well, pick the closest options and say so in the reasons.`,
    `CHARACTER LIBRARY (${sample.length} characters):\n${sample.map((c, i) => characterLine(c, i + 1, contextFields)).join('\n')}`,
    `USER REQUEST: ${prompt.trim()}`,
    `Recommend up to ${maxResults} characters. ${RESPONSE_FORMAT}`,
  ].join('\n\n')
}

/** Batch mode's final ranking pass over the per-batch picks, each carrying its first-pass reason. */
export function buildReducePrompt(
  prompt: string,
  finalists: { character: Character; reason: string }[],
  contextFields: RecommenderContextFields,
  maxResults: number,
): string {
  const fields = { ...contextFields, description: false, creatorNotes: false }
  return [
    'You are a character recommendation engine doing a final ranking. The candidates below were pre-selected from a larger library over several evaluation batches; each comes with the reason it was picked.',
    `Rules:
- Only pick characters from the candidate list.
- Identify each pick by its number: #5 is "index": 5.
- Give a final reason for each pick; you may refine the initial one.`,
    `CANDIDATES (${finalists.length}):\n${finalists.map((f, i) => characterLine(f.character, i + 1, fields, f.reason)).join('\n')}`,
    `USER REQUEST: ${prompt.trim()}`,
    `Pick the best ${maxResults}. ${RESPONSE_FORMAT}`,
  ].join('\n\n')
}

/** A rough token count for the list prompt — what the live estimate in the panel shows. */
export function estimatePromptTokens(prompt: string, sample: Character[], contextFields: RecommenderContextFields): number {
  return estimateTokens(buildRecommenderPrompt(prompt, sample, contextFields))
}

function toIndex(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value)
  if (typeof value === 'string') {
    const m = value.match(/\d+/)
    if (m) return Number(m[0])
  }
  return null
}

function recommendationList(parsed: unknown): unknown[] | null {
  if (Array.isArray(parsed)) return parsed
  if (!parsed || typeof parsed !== 'object') return null
  for (const key of ['recommendations', 'picks', 'results', 'characters']) {
    if (key in parsed) {
      const value: unknown = Reflect.get(parsed, key)
      if (Array.isArray(value)) return value
    }
  }
  const firstArray = Object.values(parsed).find(Array.isArray)
  return Array.isArray(firstArray) ? firstArray : null
}

/**
 * Model output → picks mapped onto `sample` by their 1-based index. Lenient: fenced or truncated
 * JSON, bare arrays or an object envelope, `"#3"` string indices; out-of-range and repeated picks
 * are dropped. A regex scan over `"index"` entries is the last resort for JSON past repair.
 */
export function parseRecommendations(text: string, sample: Character[]): Recommendation[] {
  let list: unknown[] | null = null
  try {
    list = recommendationList(parseLooseJson(text))
  } catch {
    list = null
  }
  const raw: { index: number | null; reason: string }[] = list
    ? list.map((item) => {
        if (!item || typeof item !== 'object') return { index: toIndex(item), reason: '' }
        const index = toIndex('index' in item ? item.index : 'id' in item ? item.id : 'number' in item ? item.number : undefined)
        const reason = 'reason' in item && typeof item.reason === 'string' ? item.reason.trim() : ''
        return { index, reason }
      })
    : [...text.matchAll(/"index"\s*:\s*"?#?(\d+)"?(?:\s*,\s*"reason"\s*:\s*"((?:[^"\\]|\\.)*)")?/g)].map((m) => ({
        index: Number(m[1]),
        reason: (m[2] ?? '').replace(/\\"/g, '"').trim(),
      }))
  const seen = new Set<string>()
  const out: Recommendation[] = []
  for (const { index, reason } of raw) {
    if (index === null || index < 1 || index > sample.length) continue
    const id = sample[index - 1].id
    if (seen.has(id)) continue
    seen.add(id)
    out.push({ characterId: id, reason })
  }
  return out
}

export interface RecommenderRunOptions {
  prompt: string
  pool: Character[]
  /** Characters per call (per batch in batch mode). */
  sampleSize: number
  maxResults: number
  contextFields: RecommenderContextFields
  /** More than 1 runs batch mode: that many parallel calls, then a reduce pass. */
  batchCount?: number
  /** Ids already recommended this session — left out so a reroll surfaces fresh picks. */
  excludeIds?: Iterable<string>
  rng?: () => number
  signal?: AbortSignal
  onProgress?: (message: string) => void
}

export interface RecommenderRunResult {
  recommendations: Recommendation[]
  /** How many characters the model actually saw. */
  evaluated: number
  failedBatches: number
  /** Set when results came from a degraded path (some batches failed, reduce fell back). */
  warning?: string
}

async function askModel(client: ChatBackend, prompt: string, maxResults: number, signal?: AbortSignal): Promise<string> {
  const maxLength = Math.min(2048, 160 + maxResults * 90)
  const maxContext = await client.getEffectiveMaxContext()
  const promptTokens = estimateTokens(prompt)
  if (promptTokens + maxLength > maxContext) {
    throw new Error(
      `The recommender prompt is about ${promptTokens.toLocaleString()} tokens, more than the model's ${maxContext.toLocaleString()}-token context leaves room for. Lower the sample size or turn off some context fields.`,
    )
  }
  const text = await generateWithTimeout(
    client,
    {
      prompt,
      max_length: maxLength,
      max_context_length: maxContext,
      temperature: 0.7,
      top_p: 0.95,
      top_k: 0,
      min_p: 0.05,
      rep_pen: 1,
      ...(client.prefersJsonObject ? { jsonOutput: true } : {}),
      trim_stop: true,
    },
    'Card recommender',
    signal,
    undefined,
    RECOMMENDER_TIMEOUT_MS,
  )
  if (!text.trim()) throw new Error('The model returned an empty response. Try again or lower the sample size.')
  return text
}

const NO_PICKS = "The model's reply had no usable picks. Try again, rephrase the request, or use a stronger model."

export async function runRecommender(client: ChatBackend, opts: RecommenderRunOptions): Promise<RecommenderRunResult> {
  const excluded = new Set(opts.excludeIds ?? [])
  const available = opts.pool.filter((c) => !excluded.has(c.id))
  if (!available.length) {
    throw new Error(excluded.size ? 'Every character in the pool has already been recommended. Widen the filters or start a new search.' : 'No characters match the pool filters.')
  }
  const batchCount = Math.max(1, Math.floor(opts.batchCount ?? 1))

  if (batchCount === 1) {
    const sample = sampleCharacters(available, opts.sampleSize, opts.rng)
    opts.onProgress?.(`Evaluating ${sample.length} characters…`)
    const text = await askModel(client, buildRecommenderPrompt(opts.prompt, sample, opts.contextFields, { maxResults: opts.maxResults }), opts.maxResults, opts.signal)
    const recommendations = parseRecommendations(text, sample).slice(0, opts.maxResults)
    if (!recommendations.length) throw new Error(NO_PICKS)
    return { recommendations, evaluated: sample.length, failedBatches: 0 }
  }

  const all = sampleCharacters(available, opts.sampleSize * batchCount, opts.rng)
  const size = Math.ceil(all.length / batchCount)
  const batches: Character[][] = []
  for (let i = 0; i < all.length; i += size) batches.push(all.slice(i, i + size))

  let done = 0
  opts.onProgress?.(`Evaluating ${all.length} characters across ${batches.length} batches…`)
  const settled = await Promise.allSettled(
    batches.map(async (batch) => {
      const text = await askModel(client, buildRecommenderPrompt(opts.prompt, batch, opts.contextFields, { maxResults: opts.maxResults }), opts.maxResults, opts.signal)
      done++
      if (done < batches.length) opts.onProgress?.(`Evaluated ${done}/${batches.length} batches…`)
      return parseRecommendations(text, batch)
    }),
  )
  if (opts.signal?.aborted) throw new DOMException('Aborted', 'AbortError')

  const byId = new Map(all.map((c) => [c.id, c]))
  const finalists: { character: Character; reason: string }[] = []
  const seen = new Set<string>()
  let failedBatches = 0
  for (const result of settled) {
    if (result.status === 'rejected' || !result.value.length) {
      failedBatches++
      continue
    }
    for (const rec of result.value) {
      const character = byId.get(rec.characterId)
      if (!character || seen.has(rec.characterId)) continue
      seen.add(rec.characterId)
      finalists.push({ character, reason: rec.reason })
    }
  }
  if (!finalists.length) {
    const firstError = settled.find((r): r is PromiseRejectedResult => r.status === 'rejected')
    if (firstError) throw firstError.reason instanceof Error ? firstError.reason : new Error(String(firstError.reason))
    throw new Error(NO_PICKS)
  }
  const batchWarning = failedBatches ? `${failedBatches} of ${batches.length} batches failed.` : undefined
  const firstPass = (warning?: string): RecommenderRunResult => ({
    recommendations: finalists.slice(0, opts.maxResults).map((f) => ({ characterId: f.character.id, reason: f.reason })),
    evaluated: all.length,
    failedBatches,
    warning: [batchWarning, warning].filter(Boolean).join(' ') || undefined,
  })
  if (finalists.length <= opts.maxResults) return firstPass()

  opts.onProgress?.(`Ranking ${finalists.length} candidates…`)
  try {
    const text = await askModel(client, buildReducePrompt(opts.prompt, finalists, opts.contextFields, opts.maxResults), opts.maxResults, opts.signal)
    const recommendations = parseRecommendations(
      text,
      finalists.map((f) => f.character),
    ).slice(0, opts.maxResults)
    if (!recommendations.length) return firstPass('The final ranking was unreadable, so these are the first-pass picks.')
    return { recommendations, evaluated: all.length, failedBatches, warning: batchWarning }
  } catch (e) {
    if (opts.signal?.aborted) throw e
    return firstPass('The final ranking failed, so these are the first-pass picks.')
  }
}
