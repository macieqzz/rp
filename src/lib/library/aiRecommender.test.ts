import { describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_CONTEXT_FIELDS,
  buildRecommenderPool,
  buildRecommenderPrompt,
  buildReducePrompt,
  estimatePromptTokens,
  parseRecommendations,
  plainText,
  runRecommender,
  sampleCharacters,
} from './aiRecommender'
import type { ChatBackend } from '@/lib/api/chatBackend'
import type { GenerateRequest } from '@/lib/api/types'
import type { Character, CharacterCardData } from '@/lib/characters/cardSpec'

function char(id: string, card: Partial<CharacterCardData> = {}, createdAt = 1000): Character {
  return {
    id,
    card: { name: id.toUpperCase(), description: '', personality: '', scenario: '', first_mes: '', mes_example: '', ...card },
    createdAt,
    updatedAt: createdAt,
  }
}

const CHARS: Character[] = [
  char('a', { tags: ['Fantasy', 'elf'], extensions: { fav: true } }, 100),
  char('b', { tags: ['sci-fi'] }, 200),
  char('c', { tags: ['fantasy', 'horror'] }, 300),
  char('d', {}, 400),
]

/** Deterministic rng cycling through fixed values. */
function seq(values: number[]): () => number {
  let i = 0
  return () => values[i++ % values.length]
}

function client(reply: (prompt: string) => string, extra: Partial<ChatBackend> = {}): ChatBackend & { calls: GenerateRequest[] } {
  const calls: GenerateRequest[] = []
  return {
    calls,
    generate: vi.fn(async (p: GenerateRequest) => {
      calls.push(p)
      return reply(p.prompt)
    }),
    generateStream: vi.fn(),
    getEffectiveMaxContext: vi.fn().mockResolvedValue(32768),
    tokenCount: vi.fn(),
    abort: vi.fn(),
    getChatTemplate: vi.fn().mockResolvedValue(null),
    ...extra,
  }
}

describe('buildRecommenderPool', () => {
  const stats = { a: { chats: 2 }, c: { chats: 0 } }

  it('applies the tri-state filters', () => {
    expect(buildRecommenderPool(CHARS, { hasChats: true }, stats).map((c) => c.id)).toEqual(['a'])
    expect(buildRecommenderPool(CHARS, { hasChats: false }, stats).map((c) => c.id)).toEqual(['b', 'c', 'd'])
    expect(buildRecommenderPool(CHARS, { favorite: true }, stats).map((c) => c.id)).toEqual(['a'])
    expect(buildRecommenderPool(CHARS, { favorite: false }, stats).map((c) => c.id)).toEqual(['b', 'c', 'd'])
    expect(buildRecommenderPool(CHARS, {}, stats)).toHaveLength(4)
  })

  it('matches include (all) and exclude (any) tags case-insensitively', () => {
    expect(buildRecommenderPool(CHARS, { includeTags: ['FANTASY'] }, {}).map((c) => c.id)).toEqual(['a', 'c'])
    expect(buildRecommenderPool(CHARS, { includeTags: ['fantasy', 'elf'] }, {}).map((c) => c.id)).toEqual(['a'])
    expect(buildRecommenderPool(CHARS, { excludeTags: ['horror', 'sci-fi'] }, {}).map((c) => c.id)).toEqual(['a', 'd'])
  })

  it('filters by creation date range', () => {
    expect(buildRecommenderPool(CHARS, { createdAfter: 200, createdBefore: 300 }, {}).map((c) => c.id)).toEqual(['b', 'c'])
  })
})

describe('sampleCharacters', () => {
  it('is deterministic for an injected rng and never repeats', () => {
    const pool = [1, 2, 3, 4, 5, 6]
    const first = sampleCharacters(pool, 3, seq([0.5, 0.1, 0.9]))
    expect(first).toEqual(sampleCharacters(pool, 3, seq([0.5, 0.1, 0.9])))
    expect(first).toHaveLength(3)
    expect(new Set(first).size).toBe(3)
    expect(pool).toEqual([1, 2, 3, 4, 5, 6])
  })

  it('returns the whole pool when the size exceeds it', () => {
    expect(sampleCharacters([1, 2, 3], 10, seq([0])).sort()).toEqual([1, 2, 3])
    expect(sampleCharacters([1, 2, 3], 0)).toEqual([])
  })
})

describe('prompts', () => {
  it('lists characters by index with the selected context fields', () => {
    const sample = [char('x', { tags: ['noir'], creator: 'sam', creator_notes: '<b>Gritty</b> detective', description: 'Long coat.' })]
    const prompt = buildRecommenderPrompt('detectives', sample, DEFAULT_CONTEXT_FIELDS, { maxResults: 5 })
    expect(prompt).toContain('#1 "X" [tags: noir] [creator: sam] [creator notes: Gritty detective]')
    expect(prompt).not.toContain('Long coat.')
    expect(prompt).toContain('USER REQUEST: detectives')
    expect(prompt).toContain('Recommend up to 5 characters')
    const withDesc = buildRecommenderPrompt('detectives', sample, { tags: false, creator: false, creatorNotes: false, description: true })
    expect(withDesc).toContain('#1 "X" [description: Long coat.]')
    expect(estimatePromptTokens('detectives', sample, DEFAULT_CONTEXT_FIELDS)).toBeGreaterThan(0)
  })

  it('carries first-pass reasons into the reduce prompt', () => {
    const prompt = buildReducePrompt('elves', [{ character: CHARS[0], reason: 'is an elf' }], DEFAULT_CONTEXT_FIELDS, 3)
    expect(prompt).toContain('#1 "A" [tags: Fantasy, elf] [initial pick reason: is an elf]')
    expect(prompt).toContain('Pick the best 3')
  })

  it('strips html and css from card text', () => {
    expect(plainText('<style>.x{color:red}</style><p>Hello&nbsp;<i>there</i></p>')).toBe('Hello there')
  })
})

describe('parseRecommendations', () => {
  const sample = CHARS.slice(0, 3)

  it('maps indices in an object envelope or bare array', () => {
    expect(parseRecommendations('{"recommendations":[{"index":2,"reason":"space"},{"index":1,"reason":"elf"}]}', sample)).toEqual([
      { characterId: 'b', reason: 'space' },
      { characterId: 'a', reason: 'elf' },
    ])
    expect(parseRecommendations('```json\n[{"index":"#3","reason":"spooky"}]\n```', sample)).toEqual([{ characterId: 'c', reason: 'spooky' }])
  })

  it('drops out-of-range and duplicate picks', () => {
    expect(parseRecommendations('[{"index":0},{"index":9},{"index":1,"reason":"x"},{"index":1,"reason":"y"}]', sample)).toEqual([
      { characterId: 'a', reason: 'x' },
    ])
  })

  it('recovers from truncated output', () => {
    expect(parseRecommendations('{"recommendations":[{"index":1,"reason":"a"},{"index":2,"reas', sample)).toEqual([{ characterId: 'a', reason: 'a' }])
  })

  it('returns nothing for prose', () => {
    expect(parseRecommendations('Sorry, none of these match.', sample)).toEqual([])
  })
})

describe('runRecommender', () => {
  it('runs a single pass and excludes previously picked ids', async () => {
    const backend = client(() => '{"recommendations":[{"index":1,"reason":"first"}]}')
    const result = await runRecommender(backend, {
      prompt: 'anything',
      pool: CHARS,
      sampleSize: 10,
      maxResults: 5,
      contextFields: DEFAULT_CONTEXT_FIELDS,
      excludeIds: ['a', 'b'],
      rng: seq([0]),
    })
    expect(result.evaluated).toBe(2)
    expect(['c', 'd']).toContain(result.recommendations[0].characterId)
    expect(backend.calls[0].prompt).not.toContain('"A"')
    expect(backend.calls[0].prompt).not.toContain('"B"')
  })

  it('throws when the reply has no picks or the pool is exhausted', async () => {
    const base = { prompt: 'x', sampleSize: 5, maxResults: 3, contextFields: DEFAULT_CONTEXT_FIELDS }
    await expect(runRecommender(client(() => 'no idea'), { ...base, pool: CHARS })).rejects.toThrow(/no usable picks/)
    await expect(runRecommender(client(() => ''), { ...base, pool: CHARS, excludeIds: CHARS.map((c) => c.id) })).rejects.toThrow(/already been recommended/)
  })

  it('maps over batches in parallel, then reduces the combined picks', async () => {
    const pool = Array.from({ length: 12 }, (_, i) => char(`c${i}`))
    const backend = client((prompt) =>
      prompt.startsWith('You are a character recommendation engine doing a final ranking')
        ? '{"recommendations":[{"index":3,"reason":"best"}]}'
        : '{"recommendations":[{"index":1,"reason":"r1"},{"index":2,"reason":"r2"}]}',
    )
    const result = await runRecommender(backend, {
      prompt: 'x',
      pool,
      sampleSize: 4,
      maxResults: 2,
      batchCount: 3,
      contextFields: DEFAULT_CONTEXT_FIELDS,
      rng: seq([0]),
    })
    // 3 map calls + 1 reduce call; 6 unique finalists > maxResults, so the reduce pass ranks them.
    expect(backend.calls).toHaveLength(4)
    expect(result.evaluated).toBe(12)
    expect(result.recommendations).toHaveLength(1)
    expect(result.recommendations[0].reason).toBe('best')
    expect(result.failedBatches).toBe(0)
  })

  it('falls back to first-pass picks when a batch fails and the reduce pass is unreadable', async () => {
    const pool = Array.from({ length: 9 }, (_, i) => char(`c${i}`))
    let call = 0
    const backend = client(() => {
      call++
      if (call === 1) return 'garbage'
      if (call <= 3) return '[{"index":1,"reason":"a"},{"index":2,"reason":"b"}]'
      return 'still garbage'
    })
    const result = await runRecommender(backend, {
      prompt: 'x',
      pool,
      sampleSize: 3,
      maxResults: 3,
      batchCount: 3,
      contextFields: DEFAULT_CONTEXT_FIELDS,
      rng: seq([0]),
    })
    expect(result.failedBatches).toBe(1)
    expect(result.recommendations).toHaveLength(3)
    expect(result.warning).toMatch(/1 of 3 batches failed/)
    expect(result.warning).toMatch(/first-pass/)
  })

  it('asks JSON-mode backends for JSON output', async () => {
    const backend = client(() => '[{"index":1}]', { prefersJsonObject: true })
    await runRecommender(backend, { prompt: 'x', pool: CHARS, sampleSize: 2, maxResults: 1, contextFields: DEFAULT_CONTEXT_FIELDS })
    expect(backend.calls[0].jsonOutput).toBe(true)
  })
})
