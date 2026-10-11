import crypto from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import {
  EXTRACTOR_HOSTS,
  decodeEntities,
  decryptMegaAttributes,
  decryptMegaContent,
  detectExtractor,
  dropboxDirectUrl,
  extractAlbum,
  findImgchestPassword,
  googleDriveDownloadUrl,
  googleDriveFileId,
  megaCtrIv,
  megaFileKey,
  parseCatboxAlbum,
  parseCivitaiImagePage,
  parseDropboxFolder,
  parseGdriveFolder,
  parseImgbbDataObjects,
  parseImgboxGallery,
  parseImgchestPage,
  parseMegaLink,
  parseOgImage,
  parsePixivId,
  parsePostimgGallery,
} from './extractors.ts'

// media.ts opens the data directory via db.ts; these tests are pure parsing, so stub it out
// (vi.mock is hoisted above the imports).
vi.mock('./media.ts', () => ({
  MAX_MEDIA_BYTES: 64 * 1024 * 1024,
  assertPublicUrl: (raw: string) => new URL(raw),
  downloadToMedia: vi.fn(),
  listMedia: () => [],
  mediaKindOf: (name: string) => (/\.(png|jpe?g|gif|webp|mp4|webm|mp3)$/i.test(name) ? 'image' : undefined),
  readCapped: vi.fn(),
  safeFetch: vi.fn(async () => {
    throw new Error('network disabled in tests')
  }),
  saveMediaBuffer: vi.fn(),
}))

describe('detectExtractor', () => {
  it.each([
    ['https://civitai.com/posts/123456', 'civitai'],
    ['https://civitai.com/images/987654', 'civitai'],
    ['https://civitai.com/models/4201/some-model?modelVersionId=130072', 'civitai'],
    ['https://civitai.red/posts/1', 'civitai'],
    ['https://imgchest.com/p/abc123XYZ', 'imgchest'],
    ['https://catbox.moe/c/a1b2c3', 'catbox'],
    ['https://imgbox.com/g/AbCdEf1234', 'imgbox'],
    ['https://ibb.co/album/xYz123', 'imgbb'],
    ['https://ibb.co/Lq3tP1Zk', 'imgbb'],
    ['https://postimg.cc/gallery/AbC123', 'postimg'],
    ['https://postimg.cc/Lq3tP1Zk', 'postimg'],
    ['https://drive.google.com/drive/folders/1AbC_dEf-GhI', 'gdrive'],
    ['https://drive.google.com/drive/u/0/folders/1AbC_dEf-GhI', 'gdrive'],
    ['https://drive.google.com/file/d/1AbC_dEf-GhI/view?usp=sharing', 'gdrive'],
    ['https://drive.google.com/open?id=1AbC_dEf-GhI', 'gdrive'],
    ['https://mega.nz/file/AbCdEfGh#key_-123', 'mega'],
    ['https://mega.nz/folder/AbCdEfGh#key_-123', 'mega'],
    ['https://mega.nz/#!AbCdEfGh!key123', 'mega'],
    ['https://mega.co.nz/#F!AbCdEfGh!key123', 'mega'],
    ['https://www.pixiv.net/en/artworks/12345678', 'pixiv'],
    ['https://www.pixiv.net/member_illust.php?mode=medium&illust_id=12345678', 'pixiv'],
    ['https://www.dropbox.com/scl/fo/abc123/def456?rlkey=xyz&dl=0', 'dropbox'],
    ['https://www.dropbox.com/scl/fi/abc123/pic.png?rlkey=xyz&dl=0', 'dropbox'],
  ])('%s → %s', (url, id) => {
    expect(detectExtractor(url)).toBe(id)
  })

  it.each([
    'https://files.catbox.moe/abc123.png',
    'https://i.ibb.co/abc123/pic.png',
    'https://i.postimg.cc/abc123/pic.png',
    'https://cdn.imgchest.com/files/abc.png',
    'https://images2.imgbox.com/aa/bb/ID_o.png',
    'https://ibb.co/album/',
    'https://postimg.cc/gallery/',
    'https://mega.nz/file/AbCdEfGh',
    'https://civitai.com/user/someone',
    'https://example.com/p/abc',
  ])('ignores %s', (url) => {
    expect(detectExtractor(url)).toBeUndefined()
  })

  it('lists every host id once', () => {
    const ids = EXTRACTOR_HOSTS.map((h) => h.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids).toEqual(['civitai', 'imgchest', 'catbox', 'imgbox', 'imgbb', 'postimg', 'gdrive', 'mega', 'pixiv', 'dropbox'])
  })
})

describe('extractAlbum', () => {
  it('reports unsupported links without throwing', async () => {
    const result = await extractAlbum('https://example.com/whatever', { characterId: 'x' })
    expect(result).toMatchObject({ ok: false, found: 0, downloaded: [], host: 'example.com' })
    expect(result.error).toMatch(/No extractor/)
  })

  it('turns resolution failures into { ok: false, error }', async () => {
    const result = await extractAlbum('https://catbox.moe/c/abc123', { characterId: 'x' })
    expect(result).toMatchObject({ ok: false, host: 'catbox', error: 'network disabled in tests' })
  })

  it('rejects a malformed MEGA link before any request', async () => {
    const result = await extractAlbum('https://mega.nz/file/AbCdEfGh#tooShort', { characterId: 'x' })
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/Invalid MEGA link/)
  })
})

describe('HTML parsers', () => {
  it('decodes entities', () => {
    expect(decodeEntities('&quot;a&quot; &amp; &#039;b&#39; &#x41;&lt;&gt; &bogus;')).toBe(`"a" & 'b' A<> &bogus;`)
  })

  it('reads og:image in either attribute order', () => {
    expect(parseOgImage('<meta property="og:image" content="https://i.ibb.co/x/a.png">')).toBe('https://i.ibb.co/x/a.png')
    expect(parseOgImage(`<meta content='https://i.postimg.cc/y/b.jpg?dl=1&amp;x=2' property='og:image'/>`)).toBe('https://i.postimg.cc/y/b.jpg?dl=1&x=2')
    expect(parseOgImage('<html></html>')).toBeUndefined()
  })

  it('parses catbox album file links', () => {
    const html = `<a href="https://files.catbox.moe/abc123.png">x</a><p>https://files.catbox.moe/def456.mp4</p>
      <a href="https://files.catbox.moe/abc123.png">dup</a>`
    expect(parseCatboxAlbum(html)).toEqual(['https://files.catbox.moe/abc123.png', 'https://files.catbox.moe/def456.mp4'])
  })

  it('maps imgbox thumbnails to originals', () => {
    const html = `<img src="https://thumbs2.imgbox.com/4a/7f/AbC123_b.png"><img src="https://thumbs2.imgbox.com/4a/7f/AbC123_b.png">
      <img src="https://thumbs3.imgbox.com/00/ff/Zz9_t.jpg">`
    expect(parseImgboxGallery(html)).toEqual(['https://images2.imgbox.com/4a/7f/AbC123_o.png', 'https://images3.imgbox.com/00/ff/Zz9_o.jpg'])
  })

  it('parses postimg gallery cards, with the pswp fallback', () => {
    const cards = `<div data-hotlink="Hash1" data-name="first" data-ext="png"></div><div data-hotlink="Hash2" data-name="second" data-ext="jpg"></div>`
    expect(parsePostimgGallery(cards)).toEqual(['https://i.postimg.cc/Hash1/first.png', 'https://i.postimg.cc/Hash2/second.jpg'])
    expect(parsePostimgGallery('<a data-pswp-src="https://i.postimg.cc/H/x.webp">')).toEqual(['https://i.postimg.cc/H/x.webp'])
  })

  it('parses imgbb data-object entries', () => {
    const obj = encodeURIComponent(JSON.stringify({ image: { url: 'https://i.ibb.co/abc/full.png' } }))
    const html = `<div data-object='${obj}'></div><div data-object='%7Bbroken'></div>`
    expect(parseImgbbDataObjects(html)).toEqual(['https://i.ibb.co/abc/full.png'])
  })

  it('parses the imgchest data-page JSON, falling back to CDN links', () => {
    const page = JSON.stringify({ props: { post: { files: [{ link: 'https://cdn.imgchest.com/files/a.png' }, { link: 'https://cdn.imgchest.com/files/b.mp4' }] } } })
    const html = `<div id="app" data-page="${page.replace(/&/g, '&amp;').replace(/"/g, '&quot;')}"></div>`
    expect(parseImgchestPage(html)).toEqual(['https://cdn.imgchest.com/files/a.png', 'https://cdn.imgchest.com/files/b.mp4'])
    expect(parseImgchestPage('<img src="https://cdn.imgchest.com/files/xyz.jpg">')).toEqual(['https://cdn.imgchest.com/files/xyz.jpg'])
  })

  it('finds an imgchest password in card text', () => {
    expect(findImgchestPassword('Gallery: https://imgchest.com/p/abc <b>Password:</b> hunter2')).toBe('hunter2')
    expect(findImgchestPassword('pw = "s3cret"')).toBe('s3cret')
    expect(findImgchestPassword('no secrets here')).toBeUndefined()
  })

  it('keeps the largest civitai variant per image', () => {
    const html = `
      <img src="https://image.civitai.com/xG1nkq/0a1b2c3d-1111-2222-3333-444455556666/width=450/1.jpeg">
      <img src="https://image.civitai.com/xG1nkq/0a1b2c3d-1111-2222-3333-444455556666/width=1024/1.jpeg">
      <img src="https://image.civitai.com/xG1nkq/ffffffff-1111-2222-3333-444455556666/original=true/2.jpeg">
      <img src="https://image.civitai.com/xG1nkq/ffffffff-1111-2222-3333-444455556666/width=2048/2.jpeg">`
    expect(parseCivitaiImagePage(html)).toEqual([
      { id: '0a1b2c3d-1111-2222-3333-444455556666', url: 'https://image.civitai.com/xG1nkq/0a1b2c3d-1111-2222-3333-444455556666/width=1024/1.jpeg' },
      { id: 'ffffffff-1111-2222-3333-444455556666', url: 'https://image.civitai.com/xG1nkq/ffffffff-1111-2222-3333-444455556666/original=true/2.jpeg' },
    ])
  })

  it('parses Google Drive folder entries with names', () => {
    const id1 = '1AbCdEfGhIjKlMnOpQrStUvWx'
    const id2 = '1ZyXwVuTsRqPoNmLkJiHgFeDc'
    const html =
      `[null,&quot;${id1}&quot;],null,null,null,&quot;image/png&quot;,x,&quot;cover.png&quot;,null,true]` +
      `[null,\\x22${id2}\\x22],null,null,null,\\x22video/mp4\\x22` +
      `[null,&quot;1NotMediaNotMediaNotMedia&quot;],null,null,null,&quot;application/pdf&quot;`
    expect(parseGdriveFolder(html)).toEqual([
      { id: id1, name: 'cover.png' },
      { id: id2, name: `${id2}.mp4` },
    ])
  })

  it('extracts Google Drive file ids', () => {
    expect(googleDriveFileId('https://drive.google.com/file/d/1AbC_dEf-GhI/view?usp=sharing')).toBe('1AbC_dEf-GhI')
    expect(googleDriveFileId('https://drive.google.com/uc?export=download&id=1AbC_dEf-GhI')).toBe('1AbC_dEf-GhI')
    expect(googleDriveFileId('https://drive.google.com/drive/folders/1AbC')).toBeUndefined()
    expect(googleDriveDownloadUrl('X')).toBe('https://drive.usercontent.google.com/download?id=X&export=download&confirm=t')
  })

  it('parses pixiv artwork ids', () => {
    expect(parsePixivId('https://www.pixiv.net/en/artworks/123/')).toBe('123')
    expect(parsePixivId('https://www.pixiv.net/artworks/456')).toBe('456')
    expect(parsePixivId('https://www.pixiv.net/member_illust.php?mode=medium&illust_id=789')).toBe('789')
    expect(parsePixivId('https://www.pixiv.net/users/1')).toBeUndefined()
  })
})

describe('Dropbox', () => {
  it('normalizes share links to direct downloads', () => {
    expect(dropboxDirectUrl('https://www.dropbox.com/scl/fi/abc/pic.png?rlkey=k&amp;st=tok&amp;dl=0')).toBe(
      'https://www.dropbox.com/scl/fi/abc/pic.png?rlkey=k&dl=1',
    )
    expect(dropboxDirectUrl('https://www.dropbox.com/scl/fi/abc/pic.png?rlkey=k')).toBe('https://www.dropbox.com/scl/fi/abc/pic.png?rlkey=k&dl=1')
  })

  it('greps file links out of the folder blob', () => {
    const inner = 'x'.repeat(4000) + 'https://www.dropbox.com/scl/fo/f1/r1/a.png?rlkey=k&dl=0 junk https://www.dropbox.com/scl/fo/f1/r1/b.mp4?rlkey=k'
    const html = `<script>var x = "${Buffer.from(inner, 'latin1').toString('base64')}";</script>`
    expect(parseDropboxFolder(html)).toEqual([
      'https://www.dropbox.com/scl/fo/f1/r1/a.png?rlkey=k&dl=1',
      'https://www.dropbox.com/scl/fo/f1/r1/b.mp4?rlkey=k&dl=1',
    ])
  })
})

describe('MEGA', () => {
  const nodeKey = crypto.randomBytes(32)
  const folderKey = crypto.randomBytes(16)

  it('parses modern and legacy links', () => {
    const fileKey = nodeKey.toString('base64url')
    expect(parseMegaLink(`https://mega.nz/file/AbC123#${fileKey}`)).toEqual({ kind: 'file', id: 'AbC123', key: nodeKey })
    expect(parseMegaLink(`https://mega.nz/#!AbC123!${fileKey}`)).toEqual({ kind: 'file', id: 'AbC123', key: nodeKey })
    const fk = folderKey.toString('base64url')
    expect(parseMegaLink(`https://mega.nz/folder/Fold1#${fk}/file/Handle`)).toEqual({ kind: 'folder', id: 'Fold1', key: folderKey })
    expect(parseMegaLink(`https://mega.co.nz/#F!Fold1!${fk}`)).toEqual({ kind: 'folder', id: 'Fold1', key: folderKey })
    // A folder-length key on a file link is wrong.
    expect(parseMegaLink(`https://mega.nz/file/AbC123#${fk}`)).toBeUndefined()
    expect(parseMegaLink('https://mega.nz/file/AbC123')).toBeUndefined()
  })

  it('decrypts attributes and content', () => {
    const key = megaFileKey(nodeKey)
    const plainAttr = Buffer.from('MEGA{"n":"photo.png"}')
    const padded = Buffer.concat([plainAttr, Buffer.alloc((16 - (plainAttr.length % 16)) % 16)])
    const cbc = crypto.createCipheriv('aes-128-cbc', key, Buffer.alloc(16))
    cbc.setAutoPadding(false)
    const encAttr = Buffer.concat([cbc.update(padded), cbc.final()])
    expect(decryptMegaAttributes(key, encAttr)).toEqual({ n: 'photo.png' })
    expect(decryptMegaAttributes(crypto.randomBytes(16), encAttr)).toBeUndefined()

    const content = crypto.randomBytes(1000)
    const ctr = crypto.createCipheriv('aes-128-ctr', key, megaCtrIv(nodeKey))
    const encrypted = Buffer.concat([ctr.update(content), ctr.final()])
    expect(decryptMegaContent(nodeKey, encrypted).equals(content)).toBe(true)
  })

  it('derives the file key and nonce from the node key', () => {
    const key = megaFileKey(nodeKey)
    for (let i = 0; i < 16; i++) expect(key[i]).toBe(nodeKey[i] ^ nodeKey[i + 16])
    const iv = megaCtrIv(nodeKey)
    expect(iv.subarray(0, 8).equals(nodeKey.subarray(16, 24))).toBe(true)
    expect(iv.subarray(8).equals(Buffer.alloc(8))).toBe(true)
  })
})
