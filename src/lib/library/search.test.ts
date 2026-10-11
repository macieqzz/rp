import { describe, expect, it } from 'vitest'
import type { Character, CharacterCardData } from '@/lib/characters/cardSpec'
import {
  buildEntries,
  cycleTagState,
  matchesSearch,
  matchesTagFilter,
  parseSearch,
  runQuery,
  sortEntries,
  type LibraryQuery,
  type TagFilter,
} from './search'
import type { Playlist } from './types'

function character(id: string, card: Partial<CharacterCardData>, extra: Partial<Character> = {}): Character {
  return {
    id,
    card: { name: id, description: '', personality: '', scenario: '', first_mes: '', mes_example: '', ...card },
    createdAt: 1,
    updatedAt: 1,
    ...extra,
  }
}

const elf = character('elf', {
  name: 'Lyra',
  tags: ['Fantasy', 'Elf', 'Female'],
  creator: 'JohnSmith',
  creator_notes: 'A dark elf ranger from the northern woods.',
  character_version: '1.2',
  extensions: { fav: true, rp_link: { provider: 'chub', id: 'johnsmith/lyra' } },
})
const robot = character('robot', {
  name: 'Unit 7',
  tags: ['Sci-Fi', 'Robot'],
  creator: 'Anon',
  extensions: { chub: { full_path: 'anon/unit7' } },
})
const plain = character('plain', { name: 'Bob', tags: [], creator: '' })

const playlists: Playlist[] = [{ id: 'p1', name: 'Backlog', icon: 'list', color: '#fff', characterIds: ['robot', 'elf'], createdAt: 0, updatedAt: 0 }]
const entries = buildEntries([elf, robot, plain], { playlists, mediaCounts: { robot: 3 } })
const byId = (id: string) => entries.find((e) => e.id === id)!

describe('parseSearch', () => {
  it('pulls prefix filters out and leaves free text', () => {
    const q = parseSearch('creator:john linked:yes Dark Elf')
    expect(q.creator).toBe('john')
    expect(q.links).toEqual([{ provider: 'any', want: true }])
    expect(q.text).toBe('dark elf')
  })

  it('handles favorites, provider aliases and none-values', () => {
    const q = parseSearch('fav:no ct:yes bb:no version:none playlist:any')
    expect(q.favorite).toBe(false)
    expect(q.links).toEqual([
      { provider: 'chartavern', want: true },
      { provider: 'botbooru', want: false },
    ])
    expect(q.version).toBe('none')
    expect(q.playlist).toBe('any')
    expect(q.text).toBe('')
  })

  it('accepts quoted values and favorite: spelled out', () => {
    const q = parseSearch('creator:"John Smith" favorite:yes')
    expect(q.creator).toBe('john smith')
    expect(q.favorite).toBe(true)
  })

  it('leaves unknown prefixes and unparseable yes/no values in the free text', () => {
    expect(parseSearch('re:zero').text).toBe('re:zero')
    expect(parseSearch('chub:maybe rem').text).toBe('chub:maybe rem')
  })

  it('collects tag: requirements', () => {
    expect(parseSearch('tag:elf tag:Fantasy').tags).toEqual(['elf', 'fantasy'])
  })
})

describe('matchesSearch', () => {
  it('matches free text across name, tags and creator but not notes by default', () => {
    expect(matchesSearch(byId('elf'), parseSearch('lyra'))).toBe(true)
    expect(matchesSearch(byId('elf'), parseSearch('fantasy'))).toBe(true)
    expect(matchesSearch(byId('elf'), parseSearch('johnsmith'))).toBe(true)
    expect(matchesSearch(byId('elf'), parseSearch('ranger'))).toBe(false)
    expect(matchesSearch(byId('elf'), parseSearch('ranger'), { name: false, tags: false, creator: false, notes: true })).toBe(true)
  })

  it('applies link prefixes, including SillyTavern chub links', () => {
    const chubYes = parseSearch('chub:yes')
    expect(matchesSearch(byId('elf'), chubYes)).toBe(true)
    expect(matchesSearch(byId('robot'), chubYes)).toBe(true)
    expect(matchesSearch(byId('plain'), chubYes)).toBe(false)
    expect(matchesSearch(byId('plain'), parseSearch('linked:no'))).toBe(true)
    // A provider the library can't link to is never "linked".
    expect(matchesSearch(byId('elf'), parseSearch('janny:yes'))).toBe(false)
    expect(matchesSearch(byId('elf'), parseSearch('janny:no'))).toBe(true)
  })

  it('applies version, gallery, uid and playlist prefixes', () => {
    expect(matchesSearch(byId('elf'), parseSearch('version:1.2'))).toBe(true)
    expect(matchesSearch(byId('robot'), parseSearch('version:none'))).toBe(true)
    expect(matchesSearch(byId('robot'), parseSearch('gallery:any'))).toBe(true)
    expect(matchesSearch(byId('plain'), parseSearch('gallery:none'))).toBe(true)
    expect(matchesSearch(byId('elf'), parseSearch('uid:el'))).toBe(true)
    expect(matchesSearch(byId('elf'), parseSearch('playlist:back'))).toBe(true)
    expect(matchesSearch(byId('plain'), parseSearch('playlist:none'))).toBe(true)
    expect(matchesSearch(byId('plain'), parseSearch('playlist:any'))).toBe(false)
  })

  it('combines prefixes with free text as AND', () => {
    expect(matchesSearch(byId('elf'), parseSearch('creator:john fav:yes lyra'))).toBe(true)
    expect(matchesSearch(byId('elf'), parseSearch('creator:john fav:no lyra'))).toBe(false)
  })
})

describe('tri-state tag filter', () => {
  it('cycles neutral → include → exclude → neutral, case-insensitively', () => {
    let f: TagFilter = {}
    f = cycleTagState(f, 'Elf')
    expect(f).toEqual({ elf: 'include' })
    f = cycleTagState(f, 'ELF')
    expect(f).toEqual({ elf: 'exclude' })
    f = cycleTagState(f, 'elf')
    expect(f).toEqual({})
  })

  it('include any vs all', () => {
    const filter: TagFilter = { fantasy: 'include', robot: 'include' }
    expect(matchesTagFilter(['fantasy', 'elf'], filter, 'any')).toBe(true)
    expect(matchesTagFilter(['fantasy', 'elf'], filter, 'all')).toBe(false)
    expect(matchesTagFilter(['fantasy', 'robot'], filter, 'all')).toBe(true)
    expect(matchesTagFilter([], filter, 'any')).toBe(false)
  })

  it('exclude any vs all, and exclusion beats inclusion', () => {
    const filter: TagFilter = { nsfw: 'exclude', gore: 'exclude' }
    expect(matchesTagFilter(['nsfw'], filter, 'any', 'any')).toBe(false)
    expect(matchesTagFilter(['nsfw'], filter, 'any', 'all')).toBe(true)
    expect(matchesTagFilter(['nsfw', 'gore'], filter, 'any', 'all')).toBe(false)
    expect(matchesTagFilter(['fantasy', 'nsfw'], { fantasy: 'include', nsfw: 'exclude' })).toBe(false)
  })

  it('an empty filter passes everything', () => {
    expect(matchesTagFilter([], {})).toBe(true)
  })
})

describe('runQuery / sort', () => {
  const base: LibraryQuery = {
    search: '',
    fields: { name: true, tags: true, creator: true, notes: false },
    tagFilter: {},
    includeMode: 'any',
    excludeMode: 'any',
    favoritesOnly: false,
    sort: 'name',
    dir: 'asc',
    seed: 0,
  }

  it('sorts by name naturally and respects direction', () => {
    expect(runQuery(entries, base).map((e) => e.name)).toEqual(['Bob', 'Lyra', 'Unit 7'])
    expect(runQuery(entries, { ...base, dir: 'desc' }).map((e) => e.name)).toEqual(['Unit 7', 'Lyra', 'Bob'])
  })

  it('filters favorites and tags together', () => {
    expect(runQuery(entries, { ...base, favoritesOnly: true }).map((e) => e.id)).toEqual(['elf'])
    expect(runQuery(entries, { ...base, tagFilter: { robot: 'exclude' } }).map((e) => e.id)).toEqual(['plain', 'elf'])
  })

  it('keeps the playlist order when sorting by playlist', () => {
    expect(runQuery(entries, { ...base, playlist: playlists[0], sort: 'playlist' }).map((e) => e.id)).toEqual(['robot', 'elf'])
  })

  it('random order is stable per seed', () => {
    const a = sortEntries(entries, 'random', 'asc', 42).map((e) => e.id)
    expect(sortEntries(entries, 'random', 'asc', 42).map((e) => e.id)).toEqual(a)
    expect(new Set(a)).toEqual(new Set(['elf', 'robot', 'plain']))
  })
})
