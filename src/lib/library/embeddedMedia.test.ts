import { describe, expect, it } from 'vitest'
import type { CharacterCardData } from '../characters/cardSpec'
import { classifyMediaUrl, extractEmbeddedMedia, findUrls, localizeHtml } from './embeddedMedia'

function card(fields: Partial<CharacterCardData>): CharacterCardData {
  return { name: 'Test', description: '', personality: '', scenario: '', first_mes: '', mes_example: '', ...fields }
}

describe('findUrls', () => {
  it('finds markdown, HTML attribute, srcset, CSS and bare URLs', () => {
    const text = [
      '![pic](https://files.catbox.moe/abc.png "title") and [link](https://example.com/page)',
      `<img src="https://i.imgur.com/xyz.jpg"><video poster='https://cdn.example.com/p.webp' src=https://cdn.example.com/v.mp4>`,
      '<img srcset="https://cdn.example.com/a.avif 1x, https://cdn.example.com/b.avif 2x">',
      `<div style="background:url('https://cdn.example.com/bg.gif')"></div>`,
      'Gallery: https://catbox.moe/c/abc123.',
    ].join('\n')
    expect(new Set(findUrls(text))).toEqual(
      new Set([
        'https://files.catbox.moe/abc.png',
        'https://example.com/page',
        'https://i.imgur.com/xyz.jpg',
        'https://cdn.example.com/p.webp',
        'https://cdn.example.com/v.mp4',
        'https://cdn.example.com/a.avif',
        'https://cdn.example.com/b.avif',
        'https://cdn.example.com/bg.gif',
        'https://catbox.moe/c/abc123',
      ]),
    )
  })

  it('strips trailing punctuation but keeps balanced parentheses', () => {
    expect(findUrls('(see https://x.example/a.png), or https://x.example/wiki/Foo_(bar)!')).toEqual([
      'https://x.example/a.png',
      'https://x.example/wiki/Foo_(bar)',
    ])
  })

  it('decodes &amp; and dedupes', () => {
    expect(findUrls('<a href="https://x.example/a?b=1&amp;c=2">x</a> https://x.example/a?b=1&c=2')).toEqual(['https://x.example/a?b=1&c=2'])
  })

  it('ignores relative and non-http links', () => {
    expect(findUrls('<img src="/local.png"> <a href="mailto:a@b.c">m</a> ftp://x.example/a.png')).toEqual([])
  })
})

describe('classifyMediaUrl', () => {
  it.each([
    ['https://files.catbox.moe/abc.png', 'direct'],
    ['https://cdn.example.com/v/clip.MOV', 'direct'],
    ['https://i.imgur.com/NoExt', 'direct'],
    ['https://catbox.moe/c/abc123', 'album'],
    ['https://www.dropbox.com/scl/fi/abc/pic.png?rlkey=k&dl=0', 'album'],
    ['https://mega.nz/file/AbC#key', 'album'],
    ['https://files.catbox.moe/archive.zip', undefined],
    ['https://example.com/page', undefined],
    ['not a url', undefined],
  ])('%s → %s', (url, kind) => {
    expect(classifyMediaUrl(url)).toBe(kind)
  })
})

describe('extractEmbeddedMedia', () => {
  it('splits direct media from album links across every text field', () => {
    const result = extractEmbeddedMedia(
      card({
        description: '![a](https://files.catbox.moe/abc.png) https://files.catbox.moe/archive.zip https://example.com/page',
        personality: 'https://i.imgur.com/NoExt',
        scenario: '<audio src="https://cdn.example.com/theme.mp3"></audio>',
        first_mes: 'Album: https://catbox.moe/c/abc123.',
        mes_example: 'https://www.dropbox.com/scl/fi/abc/pic.png?rlkey=k&amp;dl=0',
        creator_notes: 'MEGA: https://mega.nz/folder/AbC123#keyKEY_-1 and https://files.catbox.moe/abc.png again',
        system_prompt: 'https://drive.google.com/file/d/1AbC_dEf/view',
        post_history_instructions: 'https://www.pixiv.net/en/artworks/123',
        alternate_greetings: ['<img src="https://imgchest.com/p/xyz789">', 'https://cdn.example.com/clip.webm'],
      }),
    )
    // Markdown targets are collected first, then HTML attributes, then bare URLs.
    expect(result.direct).toEqual([
      'https://files.catbox.moe/abc.png',
      'https://cdn.example.com/theme.mp3',
      'https://i.imgur.com/NoExt',
      'https://cdn.example.com/clip.webm',
    ])
    expect(new Set(result.albums)).toEqual(
      new Set([
        'https://catbox.moe/c/abc123',
        'https://www.dropbox.com/scl/fi/abc/pic.png?rlkey=k&dl=0',
        'https://mega.nz/folder/AbC123#keyKEY_-1',
        'https://drive.google.com/file/d/1AbC_dEf/view',
        'https://www.pixiv.net/en/artworks/123',
        'https://imgchest.com/p/xyz789',
      ]),
    )
  })

  it('returns nothing for a card without links', () => {
    expect(extractEmbeddedMedia(card({ description: 'Just text.' }))).toEqual({ direct: [], albums: [] })
  })

  it('treats direct-host CDN files as direct, not as albums', () => {
    const result = extractEmbeddedMedia(card({ description: 'https://i.ibb.co/abc/pic.png https://i.postimg.cc/H/x.jpg https://ibb.co/album/AbC1' }))
    expect(result.direct).toEqual(['https://i.ibb.co/abc/pic.png', 'https://i.postimg.cc/H/x.jpg'])
    expect(result.albums).toEqual(['https://ibb.co/album/AbC1'])
  })
})

describe('localizeHtml', () => {
  const map = {
    'https://files.catbox.moe/abc.png': '/avatars/characters/c1/media/abc.png',
    'https://x.example/a?b=1&c=2': '/avatars/characters/c1/media/a.webp',
  }

  it('replaces exact URLs in attributes and text', () => {
    expect(localizeHtml('<img src="https://files.catbox.moe/abc.png"> see https://files.catbox.moe/abc.png.', map)).toBe(
      '<img src="/avatars/characters/c1/media/abc.png"> see /avatars/characters/c1/media/abc.png.',
    )
  })

  it('leaves longer URLs that merely start with a mapped one', () => {
    const html = '<img src="https://files.catbox.moe/abc.png?w=2"> https://files.catbox.moe/abc.pngx'
    expect(localizeHtml(html, map)).toBe(html)
  })

  it('matches the &amp;-encoded spelling', () => {
    expect(localizeHtml('<img src="https://x.example/a?b=1&amp;c=2">', map)).toBe('<img src="/avatars/characters/c1/media/a.webp">')
  })

  it('is a no-op with an empty map', () => {
    expect(localizeHtml('<p>https://files.catbox.moe/abc.png</p>', {})).toBe('<p>https://files.catbox.moe/abc.png</p>')
  })
})
