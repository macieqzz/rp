import { describe, expect, it } from 'vitest'
import type { Lorebook } from '@/lib/characters/cardSpec'
import { lorebookMatches, parseWorldFile, toWorldFile, worldFileName } from './stWorld'

/** Trimmed from a real SillyTavern world export (entries keyed by uid, numeric positions). */
const ST_WORLD = {
  entries: {
    '0': {
      uid: 0,
      key: ['Eldoria', 'kingdom'],
      keysecondary: ['capital'],
      comment: 'The kingdom',
      content: 'Eldoria is a coastal kingdom.',
      constant: false,
      vectorized: false,
      selective: true,
      selectiveLogic: 3,
      addMemo: true,
      order: 50,
      position: 0,
      disable: false,
      excludeRecursion: true,
      probability: 80,
      useProbability: true,
      depth: 4,
      group: 'places',
      groupWeight: 60,
      caseSensitive: true,
      sticky: 2,
      cooldown: null,
      delay: 3,
      role: 0,
      displayIndex: 1,
    },
    '5': {
      uid: 5,
      key: [],
      keysecondary: [],
      comment: 'Rules',
      content: 'Magic costs blood.',
      constant: true,
      selective: false,
      order: 10,
      position: 4,
      disable: true,
      probability: 100,
      useProbability: false,
      depth: 2,
      groupWeight: 100,
      role: 1,
      displayIndex: 0,
    },
    '7': {
      uid: 7,
      key: ['note'],
      content: 'Author note slot.',
      order: 100,
      position: 2,
      depth: 4,
      groupWeight: 100,
      displayIndex: 2,
    },
  },
}

describe('parseWorldFile', () => {
  it('imports an ST world file, ordering entries by displayIndex', () => {
    const book = parseWorldFile(ST_WORLD, 'Eldoria')
    expect(book.name).toBe('Eldoria')
    expect(book.entries.map((e) => e.id)).toEqual([5, 0, 7])

    const [rules, kingdom, note] = book.entries
    expect(kingdom).toMatchObject({
      keys: ['Eldoria', 'kingdom'],
      secondary_keys: ['capital'],
      comment: 'The kingdom',
      content: 'Eldoria is a coastal kingdom.',
      insertion_order: 50,
      enabled: true,
      position: 'before_char',
      depth: 4,
      case_sensitive: true,
      activationMode: 'keyword',
      constant: false,
      probability: 80,
      group: 'places',
      groupWeight: 60,
      sticky: 2,
      cooldown: undefined,
      delay: 3,
    })
    expect(kingdom.extensions).toMatchObject({ selectiveLogic: 3, exclude_recursion: true, position: 0 })

    expect(rules).toMatchObject({
      enabled: false,
      constant: true,
      activationMode: 'always',
      position: 'at_depth',
      depth: 2,
      insertion_order: 10,
      probability: undefined,
    })
    // Author's-note slot has no equivalent; it folds to a prompt side but keeps the raw slot.
    expect(note.position).toBe('before_char')
    expect(note.extensions?.position).toBe(2)
  })

  it('imports a V2 character book, reading ST settings from entry extensions', () => {
    const book = parseWorldFile(
      {
        name: 'Book',
        entries: [
          {
            id: 3,
            keys: ['sword'],
            secondary_keys: [],
            content: 'A cursed blade.',
            enabled: true,
            insertion_order: 20,
            constant: false,
            position: 'after_char',
            extensions: { position: 4, depth: 6, probability: 40, useProbability: true, group_weight: 5, display_index: 0 },
          },
        ],
      },
      'fallback',
    )
    expect(book.name).toBe('Book')
    expect(book.entries[0]).toMatchObject({
      id: 3,
      keys: ['sword'],
      position: 'at_depth',
      depth: 6,
      probability: 40,
      groupWeight: 5,
      insertion_order: 20,
    })
    // Modeled fields don't linger in extensions where they could go stale.
    expect(book.entries[0].extensions).not.toHaveProperty('depth')
  })

  it('pulls the lorebook out of a whole V2 card', () => {
    const card = {
      spec: 'chara_card_v2',
      data: { name: 'Mira', character_book: { entries: [{ keys: ['moon'], content: 'Mira loves the moon.', enabled: true }] } },
    }
    const book = parseWorldFile(card, 'file')
    expect(book.name).toBe('Mira')
    expect(book.entries[0]).toMatchObject({ id: 0, keys: ['moon'], content: 'Mira loves the moon.', insertion_order: 100 })
  })

  it('rejects JSON with no lorebook', () => {
    expect(() => parseWorldFile({ data: { name: 'x' } }, 'f')).toThrow(/lorebook/)
    expect(() => parseWorldFile([], 'f')).toThrow()
  })
})

describe('toWorldFile', () => {
  it('round-trips an ST world file through our model', () => {
    const book = parseWorldFile(ST_WORLD, 'Eldoria')
    const exported = toWorldFile(book)
    expect(Object.keys(exported.entries).sort()).toEqual(['0', '5', '7'])

    const kingdom = exported.entries['0']
    expect(kingdom).toMatchObject({
      uid: 0,
      key: ['Eldoria', 'kingdom'],
      keysecondary: ['capital'],
      content: 'Eldoria is a coastal kingdom.',
      order: 50,
      position: 0,
      disable: false,
      depth: 4,
      selectiveLogic: 3,
      excludeRecursion: true,
      probability: 80,
      useProbability: true,
      caseSensitive: true,
      group: 'places',
      groupWeight: 60,
      sticky: 2,
      cooldown: null,
      delay: 3,
    })
    expect(exported.entries['5']).toMatchObject({ position: 4, depth: 2, disable: true, constant: true, order: 10, role: 1, useProbability: false })
    expect(exported.entries['7'].position).toBe(2)

    const reimported = parseWorldFile(exported, 'x')
    expect(reimported.entries).toEqual(book.entries)
  })

  it('drops a stale ST slot once the entry is moved, and preserves manual mode and our extensions', () => {
    const book: Lorebook = {
      name: 'Mine',
      entries: [
        {
          id: 1,
          keys: ['a'],
          content: 'A',
          constant: false,
          selective: false,
          insertion_order: 100,
          enabled: true,
          position: 'at_depth',
          depth: 0,
          activationMode: 'manual',
          extensions: { position: 2, affectionMin: 40 },
        },
        { keys: ['b'], content: 'B', constant: true, selective: false, insertion_order: 5, enabled: true },
      ],
    }
    const exported = toWorldFile(book)
    expect(exported.name).toBe('Mine')
    expect(exported.entries['1']).toMatchObject({ position: 4, depth: 0, constant: false, extensions: { affectionMin: 40, rp_activation_mode: 'manual' } })
    // The id-less entry gets the first free uid without colliding with entry 1.
    expect(exported.entries['0']).toMatchObject({ uid: 0, constant: true, order: 5, position: 0 })

    const back = parseWorldFile(exported, 'x')
    expect(back.entries[0]).toMatchObject({ activationMode: 'manual', position: 'at_depth', depth: 0 })
    expect(back.entries[0].extensions).toEqual({ affectionMin: 40, position: 4 })
  })
})

describe('helpers', () => {
  it('makes an ST-safe file name', () => {
    expect(worldFileName('My: World?')).toBe('My World.json')
    expect(worldFileName('...')).toBe('World Info.json')
  })

  it('searches names, keys, and content', () => {
    const book = parseWorldFile(ST_WORLD, 'Eldoria')
    expect(lorebookMatches(book, 'blood')).toBe(true)
    expect(lorebookMatches(book, 'KINGDOM')).toBe(true)
    expect(lorebookMatches(book, 'dragon')).toBe(false)
    expect(lorebookMatches(book, '  ')).toBe(true)
  })
})
