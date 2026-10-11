import { describe, expect, it } from 'vitest'
import { deflateRawSync } from 'node:zlib'
import type { CharacterCardData } from '@/lib/characters/cardSpec'
import { createZip, crc32, readZip } from './zip'
import { applyFields, diffCards, lineDiff } from './diff'
import { findDuplicates, jaccard, nameSimilarity } from './duplicates'
import { markdownToHtml, renderCardDocument, sanitizeHtml } from './richText'

function card(p: Partial<CharacterCardData>): CharacterCardData {
  return { name: 'X', description: '', personality: '', scenario: '', first_mes: '', mes_example: '', ...p }
}

describe('zip', () => {
  it('round-trips stored entries with UTF-8 names', async () => {
    const zip = createZip([
      { path: 'bundle.json', data: '{"a":1}' },
      { path: 'Ünïcode/媒体.bin', data: new Uint8Array([0, 1, 2, 255]) },
    ])
    const entries = await readZip(zip)
    expect(entries.map((e) => e.path)).toEqual(['bundle.json', 'Ünïcode/媒体.bin'])
    expect(new TextDecoder().decode(entries[0].data)).toBe('{"a":1}')
    expect([...entries[1].data]).toEqual([0, 1, 2, 255])
  })

  it('computes the standard CRC-32', () => {
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926)
  })

  it('reads deflated entries written by other archivers', async () => {
    const text = 'hello hello hello hello'
    const raw = deflateRawSync(Buffer.from(text))
    const stored = createZip([{ path: 'a.txt', data: new Uint8Array(raw) }])
    // Patch the method fields (local + central) to 8 and sizes to match a real deflated entry.
    const view = new DataView(stored.buffer)
    view.setUint16(8, 8, true)
    view.setUint32(14, crc32(new TextEncoder().encode(text)), true)
    view.setUint32(22, text.length, true)
    const central = 30 + 'a.txt'.length + raw.length
    view.setUint16(central + 10, 8, true)
    view.setUint32(central + 24, text.length, true)
    const [entry] = await readZip(stored)
    expect(new TextDecoder().decode(entry.data)).toBe(text)
  })

  it('rejects non-zip input', async () => {
    await expect(readZip(new Uint8Array([1, 2, 3]))).rejects.toThrow(/Not a ZIP/)
  })
})

describe('diff', () => {
  it('reports only changed fields, with tag pills', () => {
    const diffs = diffCards(card({ description: 'a', tags: ['x', 'y'] }), card({ description: 'b', tags: ['y', 'z'] }))
    expect(diffs.map((d) => d.field)).toEqual(['description', 'tags'])
    const tags = diffs.find((d) => d.kind === 'tags')
    expect(tags).toMatchObject({ added: ['z'], removed: ['x'], kept: ['y'] })
  })

  it('applies only the selected fields', () => {
    const next = applyFields(card({ name: 'Old', description: 'keep' }), card({ name: 'New', description: 'drop' }), ['name'])
    expect(next).toMatchObject({ name: 'New', description: 'keep' })
  })

  it('produces an LCS line diff', () => {
    expect(lineDiff('a\nb\nc', 'a\nx\nc')).toEqual([
      { op: 'same', text: 'a' },
      { op: 'del', text: 'b' },
      { op: 'add', text: 'x' },
      { op: 'same', text: 'c' },
    ])
  })
})

describe('duplicates', () => {
  it('scores names and content', () => {
    expect(nameSimilarity('Lyra (v2)', 'lyra')).toBe(1)
    expect(nameSimilarity('Lyra', 'Unit 7')).toBeLessThan(0.3)
    expect(jaccard(new Set(['a', 'b']), new Set(['b', 'c']))).toBeCloseTo(1 / 3)
  })

  it('groups same-name same-content cards and skips divergent variants', () => {
    const text = 'a tall ranger who guards the northern woods with her bow and her wolf companion'
    const groups = findDuplicates(
      [
        { id: 'a', createdAt: 2, card: card({ name: 'Lyra', creator: 'j', description: text }) },
        { id: 'b', createdAt: 1, card: card({ name: 'Lyra', creator: 'j', description: text }) },
        { id: 'c', createdAt: 3, card: card({ name: 'Lyra', creator: 'j', description: 'completely different robot mechanic living on mars station' }) },
      ],
      60,
    )
    expect(groups).toHaveLength(1)
    expect(groups[0].ids).toEqual(['b', 'a'])
  })

  it('exact mode requires identical card text', () => {
    const groups = findDuplicates(
      [
        { id: 'a', createdAt: 1, card: card({ name: 'Lyra', description: 'same' }) },
        { id: 'b', createdAt: 2, card: card({ name: 'lyra', description: 'same' }) },
        { id: 'c', createdAt: 3, card: card({ name: 'Lyra', description: 'same.' }) },
      ],
      100,
    )
    expect(groups.map((g) => g.ids)).toEqual([['a', 'b']])
  })
})

describe('richText', () => {
  it('strips scripts, handlers and javascript: URLs', () => {
    const out = sanitizeHtml('<p onclick="x()">hi</p><script>alert(1)</script><a href="javascript:alert(1)">x</a><iframe src="//e"></iframe>')
    expect(out).not.toMatch(/script|onclick|javascript|iframe/i)
    expect(out).toContain('<p>hi</p>')
  })

  it('renders markdown images, links and emphasis, keeping roleplay asterisks as italics', () => {
    const html = markdownToHtml('![pic](https://i.imgur.com/a.png)\n**bold** *waves* [site](https://x.com)')
    expect(html).toContain('<img src="https://i.imgur.com/a.png" alt="pic">')
    expect(html).toContain('<strong>bold</strong>')
    expect(html).toContain('<em>waves</em>')
    expect(html).toContain('<a href="https://x.com" target="_blank"')
    expect(html).toContain('<br>')
  })

  it('does not add <br> inside author HTML layouts, and leaves <style> alone', () => {
    const html = markdownToHtml('<div>\n<style>a{color:red}\n*b*</style>\n</div>')
    expect(html).not.toContain('<br>')
    expect(html).toContain('a{color:red}\n*b*')
  })

  it('builds a CSP-locked document with macros and localized URLs', () => {
    const doc = renderCardDocument('Hi {{user}}, I am {{char}} <img src="https://x.com/a.png">', {
      names: { char: 'Lyra', user: 'Sam' },
      origin: 'http://localhost:5173',
      colors: { text: '#fff', muted: '#aaa', accent: '#f0f', background: '#000' },
      localize: { 'https://x.com/a.png': '/avatars/characters/1/media/a.png' },
    })
    expect(doc).toContain('Content-Security-Policy')
    expect(doc).toContain("default-src 'none'")
    expect(doc).toContain('Hi Sam, I am Lyra')
    expect(doc).toContain('/avatars/characters/1/media/a.png')
    expect(doc).not.toContain('https://x.com/a.png')
  })
})
