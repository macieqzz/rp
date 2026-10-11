import { describe, expect, it, vi } from 'vitest'
import {
  buildChubCard,
  buildWyvernCard,
  extractPngCard,
  isAllowedImageHost,
  normalizeBotbooruSearch,
  normalizeChubCommit,
  normalizeChubSearch,
  normalizeCtSearch,
  normalizeWyvernSearch,
  proxiedImage,
  resolveProviderUrl,
  toCardData,
} from './providers.ts'

// providers.ts only needs media.ts for network calls; mocking it (vi.mock is hoisted above the
// imports) keeps the DB module and any network out of these pure parsing tests.
vi.mock('./media.ts', () => ({ safeFetch: vi.fn(), readCapped: vi.fn() }))

describe('resolveProviderUrl', () => {
  it('recognizes Chub character pages on every host spelling', () => {
    expect(resolveProviderUrl('https://chub.ai/characters/Anonymous/my-girl-1234')).toEqual({ provider: 'chub', id: 'Anonymous/my-girl-1234' })
    expect(resolveProviderUrl('https://www.characterhub.org/characters/foo/bar?tab=x')).toEqual({ provider: 'chub', id: 'foo/bar' })
    expect(resolveProviderUrl('venus.chub.ai/characters/foo/bar')).toEqual({ provider: 'chub', id: 'foo/bar' })
    expect(resolveProviderUrl('https://chub.ai/foo/bar')).toEqual({ provider: 'chub', id: 'foo/bar' })
  })

  it('rejects Chub pages that are not characters', () => {
    expect(resolveProviderUrl('https://chub.ai/lorebooks/foo/bar')).toBeNull()
    expect(resolveProviderUrl('https://chub.ai/characters/onlyone')).toBeNull()
  })

  it('recognizes Wyvern, CharacterTavern and Botbooru pages', () => {
    expect(resolveProviderUrl('https://app.wyvern.chat/characters/_LbhnWCqY3xnBnpaAa8qYt')).toEqual({ provider: 'wyvern', id: '_LbhnWCqY3xnBnpaAa8qYt' })
    expect(resolveProviderUrl('https://app.wyvern.chat/profiles/uid123/characters/abc-DEF')).toEqual({ provider: 'wyvern', id: 'abc-DEF' })
    expect(resolveProviderUrl('https://character-tavern.com/character/someone/shy-cousin')).toEqual({ provider: 'chartavern', id: 'someone/shy-cousin' })
    expect(resolveProviderUrl('https://botbooru.com/character/4821')).toEqual({ provider: 'botbooru', id: '4821' })
    expect(resolveProviderUrl('https://botbooru.com/post/77')).toEqual({ provider: 'botbooru', id: '77' })
  })

  it('returns null for unsupported or malformed input', () => {
    expect(resolveProviderUrl('https://janitorai.com/characters/abc')).toBeNull()
    expect(resolveProviderUrl('https://evilchub.ai/characters/a/b')).toBeNull()
    expect(resolveProviderUrl('')).toBeNull()
    expect(resolveProviderUrl('not a url at all')).toBeNull()
  })
})

describe('image allowlist', () => {
  it('allows provider CDNs and their subdomains only', () => {
    expect(isAllowedImageHost('avatars.charhub.io')).toBe(true)
    expect(isAllowedImageHost('imagedelivery.net')).toBe(true)
    expect(isAllowedImageHost('ct-cards.storage.character-tavern.com')).toBe(true)
    expect(isAllowedImageHost('botbooru.com')).toBe(true)
    expect(isAllowedImageHost('notcharhub.io')).toBe(false)
    expect(isAllowedImageHost('example.com')).toBe(false)
  })

  it('builds same-origin proxy URLs', () => {
    expect(proxiedImage('https://avatars.charhub.io/a b.png')).toBe('/api/library/online/image?url=https%3A%2F%2Favatars.charhub.io%2Fa%20b.png')
    expect(proxiedImage(undefined)).toBeUndefined()
  })
})

describe('Chub normalization', () => {
  const sample = {
    data: {
      count: 1234,
      cursor: 'abc',
      nodes: [
        {
          id: 98765,
          name: 'Aria the Bard',
          fullPath: 'bardlover/aria-the-bard-1a2b',
          tagline: '<b>Sings</b> for coin',
          topics: ['Fantasy', 'Female', 'NSFW'],
          avatar_url: 'https://avatars.charhub.io/avatars/bardlover/aria-the-bard-1a2b/avatar.webp',
          starCount: 5100,
          n_favorites: 320,
          nTokens: 1800,
          createdAt: '2025-03-01T12:00:00Z',
          lastActivityAt: '2025-06-02T08:30:00Z',
        },
        { id: 1, name: 'Broken' },
      ],
    },
  }

  it('maps search nodes to summaries and drops nodes without a full path', () => {
    const result = normalizeChubSearch(sample, 2)
    expect(result.page).toBe(2)
    expect(result.hasMore).toBe(true)
    expect(result.total).toBe(1234)
    expect(result.items).toHaveLength(1)
    expect(result.items[0]).toEqual({
      provider: 'chub',
      id: 'bardlover/aria-the-bard-1a2b',
      name: 'Aria the Bard',
      creator: 'bardlover',
      avatarUrl: proxiedImage('https://avatars.charhub.io/avatars/bardlover/aria-the-bard-1a2b/avatar.webp'),
      tagline: 'Sings for coin',
      tags: ['Fantasy', 'Female', 'NSFW'],
      nsfw: true,
      url: 'https://chub.ai/characters/bardlover/aria-the-bard-1a2b',
      tokens: 1800,
      downloads: 5100,
      likes: 320,
      createdAt: Date.parse('2025-03-01T12:00:00Z'),
      updatedAt: Date.parse('2025-06-02T08:30:00Z'),
    })
  })

  it('reports no more pages without a cursor', () => {
    expect(normalizeChubSearch({ nodes: [] }, 1).hasMore).toBe(false)
  })

  it("translates Chub's definition field names to the card spec", () => {
    const card = buildChubCard({
      id: 98765,
      fullPath: 'bardlover/aria',
      topics: ['Fantasy'],
      tagline: 'tag',
      definition: {
        name: 'Aria',
        personality: 'DESC',
        tavern_personality: 'PERS',
        first_message: 'Hello',
        example_dialogs: 'EX',
        description: 'NOTES',
        alternate_greetings: ['Hi again'],
        embedded_lorebook: { entries: [{ keys: ['harp'], content: 'A harp.' }] },
      },
    })
    expect(card).toMatchObject({
      name: 'Aria',
      description: 'DESC',
      personality: 'PERS',
      first_mes: 'Hello',
      mes_example: 'EX',
      creator_notes: 'NOTES',
      alternate_greetings: ['Hi again'],
      tags: ['Fantasy'],
      creator: 'bardlover',
    })
    expect(card.character_book?.entries[0]).toMatchObject({ keys: ['harp'], content: 'A harp.', enabled: true })
    expect(card.extensions?.chub).toMatchObject({ id: 98765, full_path: 'bardlover/aria', tagline: 'tag' })
  })

  it('maps git commits to remote versions', () => {
    expect(normalizeChubCommit({ id: 'deadbeef1', title: 'Update', committed_date: '2025-01-01T00:00:00Z' })).toEqual({
      id: 'deadbeef1',
      message: 'Update',
      createdAt: Date.parse('2025-01-01T00:00:00Z'),
    })
    expect(normalizeChubCommit({})).toBeUndefined()
  })
})

describe('Wyvern normalization', () => {
  const sample = {
    hasMore: true,
    results: [
      {
        id: '_Lbhn',
        name: 'Reina Reyes | The Twilight Serenade',
        chat_name: 'Reina ',
        avatar: 'https://imagedelivery.net/Dv4koOwHQU3XnXLqtl0aVQ/abc/public',
        tags: ['Romance', 'Singer'],
        rating: 'explicit',
        creator: { uid: 'u1', displayName: 'Writer', username: 'writer' },
        statistics_record: { likes: 42, messages: 900 },
        created_at: '2025-04-04T00:00:00Z',
      },
      { id: '_other', name: 'Other', tags: ['Horror'], rating: 'none', avatar: 'abc123' },
    ],
  }

  it('uses chat_name as the name, flags non-"none" ratings and filters excluded tags', () => {
    const result = normalizeWyvernSearch(sample, 1, ['horror'])
    expect(result.hasMore).toBe(true)
    expect(result.items).toHaveLength(1)
    expect(result.items[0]).toMatchObject({
      provider: 'wyvern',
      id: '_Lbhn',
      name: 'Reina',
      creator: 'Writer',
      tags: ['Romance', 'Singer'],
      nsfw: true,
      likes: 42,
      url: 'https://app.wyvern.chat/characters/_Lbhn',
      avatarUrl: proxiedImage('https://imagedelivery.net/Dv4koOwHQU3XnXLqtl0aVQ/abc/public'),
    })
  })

  it('expands bare avatar ids onto the image CDN', () => {
    const item = normalizeWyvernSearch(sample, 1).items[1]
    expect(item.avatarUrl).toBe(proxiedImage('https://imagedelivery.net/Dv4koOwHQU3XnXLqtl0aVQ/abc123/public'))
    expect(item.nsfw).toBe(false)
  })

  it('builds cards the way Wyvern exports them', () => {
    const card = buildWyvernCard({
      id: 'x',
      chat_name: 'Reina',
      description: 'Desc',
      shared_info: 'Shared',
      character_note: 'Note',
      pre_history_instructions: 'Sys',
      enable_advanced_greetings: true,
      greetings: [
        { id: 'default', content: 'first' },
        { id: 'g2', content: 'second' },
        { id: 'g3', content: '  ' },
      ],
      lorebooks: [{ name: 'LB', entries: { a: { keys: ['k'], content: 'c', position: 'after_char' } } }],
    })
    expect(card.description).toBe('Desc\n\n---\n\nShared')
    expect(card.system_prompt).toBe('Sys')
    expect(card.alternate_greetings).toEqual(['second'])
    expect(card.character_book?.entries[0]).toMatchObject({ keys: ['k'], content: 'c', position: 'after_char' })
    expect(card.extensions?.depth_prompt).toEqual({ prompt: 'Note', depth: 4, role: 'system' })
  })
})

describe('CharacterTavern normalization', () => {
  const sample = {
    hits: [
      {
        id: 'ct1',
        path: 'someone/shy-cousin',
        name: 'Shy Cousin',
        inChatName: 'Elara',
        author: 'someone',
        tagline: '<p>Quiet &amp; kind</p>',
        tags: ['Fantasy', 'SFW'],
        isNSFW: false,
        totalTokens: 1500,
        downloads: 10,
        likes: 3,
        createdAt: 1735689600,
      },
      { id: 'ct2', path: 'other/thing', name: 'Thing', author: 'other', tags: 'one two' },
    ],
    totalHits: 61,
    totalPages: 3,
    page: 1,
  }

  it('maps hits, converting epoch seconds and legacy space-separated tags', () => {
    const result = normalizeCtSearch(sample, 1)
    expect(result).toMatchObject({ page: 1, hasMore: true, total: 61 })
    expect(result.items[0]).toMatchObject({
      provider: 'chartavern',
      id: 'someone/shy-cousin',
      name: 'Elara',
      creator: 'someone',
      tagline: 'Quiet & kind',
      tags: ['Fantasy', 'SFW'],
      nsfw: false,
      tokens: 1500,
      createdAt: 1735689600 * 1000,
      avatarUrl: proxiedImage('https://ct-cards.storage.character-tavern.com/someone/shy-cousin.png'),
    })
    expect(result.items[1].tags).toEqual(['one', 'two'])
  })

  it('narrows keyword results to the requested creator', () => {
    expect(normalizeCtSearch(sample, 3, 'Other').items.map((i) => i.id)).toEqual(['other/thing'])
    expect(normalizeCtSearch(sample, 3).hasMore).toBe(false)
  })
})

describe('Botbooru normalization', () => {
  const sample = {
    total: 41,
    posts: [
      {
        id: 4821,
        character_name: 'Mira',
        filename: 'abc.png',
        card_image_revision: 2,
        tags: [
          { name: 'fantasy', category: 'General' },
          { name: 'quill', category: 'Writer' },
        ],
        uploader_name: 'uploader',
        token_count: 900,
        downloads: 12,
        favorite_count: 4,
        created_at: '2025-05-05T00:00:00Z',
      },
      { id: 'nope', character_name: 'Bad id' },
    ],
  }

  it('credits the Writer tag as creator and keeps it out of the tag list', () => {
    const result = normalizeBotbooruSearch(sample, 1)
    expect(result.items).toHaveLength(1)
    expect(result.items[0]).toMatchObject({
      provider: 'botbooru',
      id: '4821',
      name: 'Mira',
      creator: 'quill',
      tags: ['fantasy'],
      nsfw: false,
      tokens: 900,
      likes: 4,
      url: 'https://botbooru.com/character/4821',
      avatarUrl: proxiedImage('https://botbooru.com/images/preview/480/abc.png?v=2'),
    })
  })

  it('pages by offset against the total', () => {
    expect(normalizeBotbooruSearch(sample, 1).hasMore).toBe(true)
    expect(normalizeBotbooruSearch({ total: 2, posts: sample.posts }, 1).hasMore).toBe(false)
  })
})

describe('card helpers', () => {
  it('normalizes V1 flat and V2 wrapped cards alike', () => {
    expect(toCardData({ name: 'Flat', first_mes: 'Hi', tags: ['a', 3] })).toMatchObject({ name: 'Flat', first_mes: 'Hi', tags: ['a'] })
    expect(toCardData({ spec: 'chara_card_v2', data: { name: 'Wrapped', alternate_greetings: ['x'] } })).toMatchObject({
      name: 'Wrapped',
      alternate_greetings: ['x'],
      extensions: {},
    })
  })

  it('reads the embedded card from PNG tEXt chunks, preferring ccv3', () => {
    const chunk = (type: string, data: Buffer) => {
      const len = Buffer.alloc(4)
      len.writeUInt32BE(data.length)
      return Buffer.concat([len, Buffer.from(type, 'latin1'), data, Buffer.alloc(4)])
    }
    const text = (keyword: string, json: unknown) =>
      chunk('tEXt', Buffer.concat([Buffer.from(keyword, 'latin1'), Buffer.from([0]), Buffer.from(Buffer.from(JSON.stringify(json)).toString('base64'), 'latin1')]))
    const png = Buffer.concat([
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      text('chara', { data: { name: 'V2' } }),
      text('ccv3', { data: { name: 'Ünïcode V3' } }),
      chunk('IEND', Buffer.alloc(0)),
    ])
    expect(extractPngCard(png)).toEqual({ data: { name: 'Ünïcode V3' } })
    expect(extractPngCard(Buffer.from('not a png'))).toBeUndefined()
  })
})
