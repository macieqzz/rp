/**
 * Album/gallery extractors: turn a link to a hosted album, post or share page into the direct media
 * URLs behind it, then download each into the character's media folder. Ported from
 * SillyTavern-CharacterLibrary's `modules/gallery-extractors/*` — but running server-side, so hosts
 * that needed its `cl-helper` plugin there (CORS, Referer-gated CDNs, cookie handshakes) work with
 * plain requests here. No host is contacted with credentials: public content only.
 *
 * Every page/API request goes through `safeFetch` (public-address check on every redirect hop) and
 * `readCapped`. `src/lib/library/embeddedMedia.ts` keeps a copy of the URL patterns below so the
 * client can classify card links without importing server code — keep the two in sync.
 */

import crypto from 'node:crypto'
import { setTimeout as sleep } from 'node:timers/promises'
import type { ExtractResult, MediaFetchResult } from '../../src/lib/library/types.ts'
import { MAX_MEDIA_BYTES, assertPublicUrl, downloadToMedia, listMedia, mediaKindOf, readCapped, safeFetch, saveMediaBuffer } from './media.ts'

/** One direct media file an extractor resolved from an album page. */
interface ResolvedMedia {
  url: string
  name?: string
  referer?: string
  /** Custom download for hosts whose bytes need post-processing (MEGA encrypts client-side). */
  download?: (characterId: string) => Promise<MediaFetchResult>
}

interface Extractor {
  id: string
  name: string
  patterns: readonly RegExp[]
  /** Throws an `Error` with a user-facing message when the link can't be resolved. */
  resolve: (url: string, ctx: { context: string }) => Promise<ResolvedMedia[]>
}

type FetchInit = NonNullable<Parameters<typeof safeFetch>[1]>

/** HTML/JSON pages are small; anything past this is not the page we expect. */
const PAGE_CAP = 8 * 1024 * 1024
const MAX_ITEMS_PER_ALBUM = 200
const HTML_ACCEPT = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'

// ---------------------------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------------------------

async function fetchText(url: string, init: FetchInit = {}): Promise<string> {
  const res = await safeFetch(url, { ...init, headers: { Accept: HTML_ACCEPT, ...init.headers } })
  if (!res.ok) {
    await res.body?.cancel()
    throw new Error(`${new URL(url).hostname} answered HTTP ${res.status}.`)
  }
  return (await readCapped(res, PAGE_CAP)).toString('utf8')
}

async function fetchJson<T>(url: string, init: FetchInit = {}): Promise<T> {
  const text = await fetchText(url, { ...init, headers: { Accept: 'application/json', ...init.headers } })
  try {
    return JSON.parse(text) as T
  } catch {
    throw new Error(`${new URL(url).hostname} returned something other than JSON.`)
  }
}

const NAMED_ENTITIES: Record<string, string> = { quot: '"', amp: '&', lt: '<', gt: '>', apos: "'", nbsp: '\u00a0' }

/** Decodes the HTML entities that appear inside attribute values (`data-page="{&quot;…"`). */
export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, body: string) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10)
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? whole
  })
}

function lastSegment(url: string): string | undefined {
  try {
    const seg = new URL(url).pathname.split('/').filter(Boolean).pop()
    return seg ? decodeURIComponent(seg) : undefined
  } catch {
    return undefined
  }
}

/** The `og:image` (or `image_src`) of a single-image share page — that's the full-size original. */
export function parseOgImage(html: string): string | undefined {
  const m =
    /<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i.exec(html) ??
    /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i.exec(html) ??
    /<link[^>]+rel=["']image_src["'][^>]+href=["']([^"']+)["']/i.exec(html)
  return m ? decodeEntities(m[1]) : undefined
}

// ---------------------------------------------------------------------------------------------
// Civitai — public REST API for posts/models, page scrape for single images (the API has no
// lookup by image id). civitai.red mirrors civitai.com with a different content filter, so both
// are queried and merged, as in the reference.
// ---------------------------------------------------------------------------------------------

interface CivitaiImage {
  id?: number | string
  url?: string
}

const CIVITAI_CDN_RE = /https:\/\/image\.civitai\.com\/[^\s"'<>)\\]+/gi

/** Fetches the same path from every host, keeping successes; throws the first error only if all failed. */
async function fromAllHosts<T>(hosts: string[], run: (host: string) => Promise<T>): Promise<T[]> {
  const settled = await Promise.allSettled(hosts.map(run))
  const values = settled.flatMap((s) => (s.status === 'fulfilled' ? [s.value] : []))
  if (values.length === 0) {
    const first = settled.find((s): s is PromiseRejectedResult => s.status === 'rejected')
    throw first?.reason instanceof Error ? first.reason : new Error('Civitai is unreachable.')
  }
  return values
}

/** `original=true` beats any sized variant; otherwise the larger `width=N` wins. */
function preferLarger(candidate: string, current: string): boolean {
  const candOrig = /original=true/i.test(candidate)
  const currOrig = /original=true/i.test(current)
  if (candOrig !== currOrig) return candOrig
  const width = (u: string) => parseInt(/width=(\d+)/i.exec(u)?.[1] ?? '0', 10)
  return width(candidate) > width(current)
}

/** Civitai CDN images on an image page, keyed by image UUID with the largest variant kept. */
export function parseCivitaiImagePage(html: string): { id: string; url: string }[] {
  const byUuid = new Map<string, string>()
  for (const m of html.matchAll(CIVITAI_CDN_RE)) {
    const clean = m[0].replace(/&amp;/g, '&').replace(/[.,;:!?)}\]]+$/, '')
    const uuid = /image\.civitai\.com\/[^/]+\/([a-f0-9-]{8,})\//i.exec(clean)?.[1]
    if (!uuid) continue
    const existing = byUuid.get(uuid)
    if (!existing || preferLarger(clean, existing)) byUuid.set(uuid, clean)
  }
  return [...byUuid].map(([id, url]) => ({ id, url }))
}

async function resolveCivitai(url: string): Promise<ResolvedMedia[]> {
  const u = new URL(url)
  const m = /^\/(posts|images|models)\/(\d+)/i.exec(u.pathname)
  if (!m) throw new Error('Unsupported Civitai link (posts, images and models are supported).')
  const kind = m[1].toLowerCase()
  const id = m[2]
  const own = u.hostname.replace(/^www\./, '')
  const hosts = [own, own === 'civitai.com' ? 'civitai.red' : 'civitai.com']

  const lists = await fromAllHosts(hosts, async (host): Promise<CivitaiImage[]> => {
    if (kind === 'images') return parseCivitaiImagePage(await fetchText(`https://${host}/images/${id}`))
    if (kind === 'posts') {
      const data = await fetchJson<{ items?: CivitaiImage[] }>(`https://${host}/api/v1/images?postId=${id}&limit=200&nsfw=X`)
      return Array.isArray(data.items) ? data.items : []
    }
    // Models: the showcase images on each version (or only the one picked via ?modelVersionId=).
    const data = await fetchJson<{ modelVersions?: { id?: number; images?: CivitaiImage[] }[] }>(`https://${host}/api/v1/models/${id}`)
    const versionId = u.searchParams.get('modelVersionId')
    const versions = (data.modelVersions ?? []).filter((v) => !versionId || String(v.id) === versionId)
    return versions.flatMap((v) => v.images ?? [])
  })

  const byId = new Map<string, ResolvedMedia>()
  for (const item of lists.flat()) {
    if (typeof item?.url !== 'string' || !item.url) continue
    const key = String(item.id ?? item.url)
    if (byId.has(key)) continue
    const last = lastSegment(item.url)
    byId.set(key, { url: item.url, name: last && /\.[a-z0-9]{2,5}$/i.test(last) ? last : `civitai_${item.id ?? id}` })
  }
  return [...byId.values()]
}

// ---------------------------------------------------------------------------------------------
// Imgchest — post pages embed an Inertia `data-page` JSON with `props.post.files[].link`.
// Password-protected posts are unlocked with the same three-step cookie handshake cl-helper does,
// using a password found in the card text.
// ---------------------------------------------------------------------------------------------

const IMGCHEST_CDN_RE = /https?:\/\/cdn\.imgchest\.com\/files\/[^\s"'<>]+?\.(?:png|jpe?g|gif|webp|mp4|webm)/gi
const IMGCHEST_PASSWORD_RE = /(?:pass\s*(?:word|code)|p\.?\s*w\.?|pass)\s*(?:[:=\-]|is)\s*["']?([^\s"'<>]+)/i

/** Direct file URLs of an Imgchest post page: the `data-page` JSON first, a CDN regex as fallback. */
export function parseImgchestPage(html: string): string[] {
  const dataPage = /data-page="([^"]+)"/.exec(html)
  if (dataPage) {
    try {
      const data = JSON.parse(decodeEntities(dataPage[1])) as { props?: { post?: { files?: { link?: unknown }[] } } }
      const links = (data.props?.post?.files ?? []).map((f) => f.link).filter((l): l is string => typeof l === 'string' && !!l)
      if (links.length > 0) return [...new Set(links)]
    } catch {
      // Malformed embed — fall through to the regex.
    }
  }
  return [...new Set([...html.matchAll(IMGCHEST_CDN_RE)].map((m) => m[0]))]
}

/** The first "password: xyz"-style phrase in card text (HTML tags stripped), if any. */
export function findImgchestPassword(text: string): string | undefined {
  return IMGCHEST_PASSWORD_RE.exec(text.replace(/<[^>]*>/g, ' '))?.[1]
}

const IMGCHEST_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'

function imgchestCookies(headers: Headers): { xsrf?: string; session?: string } {
  const out: { xsrf?: string; session?: string } = {}
  for (const sc of headers.getSetCookie()) {
    const xsrf = /XSRF-TOKEN=([^;]+)/.exec(sc)
    if (xsrf) out.xsrf = xsrf[1]
    const sess = /image_chest_session=([^;]+)/.exec(sc)
    if (sess) out.session = sess[1]
  }
  return out
}

async function unlockImgchest(postId: string, context: string): Promise<string[]> {
  const password = findImgchestPassword(context)
  if (!password) throw new Error('Password-protected post, and no password was found in the card.')
  const validateUrl = `https://imgchest.com/p/${postId}/validate`

  // 1. The validate page hands out the XSRF + session cookies (and the Inertia asset version).
  const step1 = await safeFetch(validateUrl, { headers: { 'User-Agent': IMGCHEST_UA, Accept: 'text/html' } })
  if (!step1.ok) {
    await step1.body?.cancel()
    throw new Error(`Imgchest password page answered HTTP ${step1.status}.`)
  }
  const c1 = imgchestCookies(step1.headers)
  const html1 = (await readCapped(step1, PAGE_CAP)).toString('utf8')
  if (!c1.xsrf || !c1.session) throw new Error('Imgchest did not start a session for the password check.')
  const version = /"version":"([^"]+)"/.exec(decodeEntities(/data-page="([^"]+)"/.exec(html1)?.[1] ?? ''))?.[1]

  // 2. Submit the password. Success is a 302 whose Set-Cookie carries the unlocked session, so this
  // one request must not follow redirects — safeFetch always does. The target is a fixed public
  // imgchest.com URL, so the address validation safeFetch adds has nothing to check here.
  const step2 = await fetch(validateUrl, {
    method: 'POST',
    redirect: 'manual',
    signal: AbortSignal.timeout(30000),
    headers: {
      'User-Agent': IMGCHEST_UA,
      'Content-Type': 'application/json',
      Accept: 'text/html, application/xhtml+xml',
      'X-Requested-With': 'XMLHttpRequest',
      'X-Inertia': 'true',
      ...(version ? { 'X-Inertia-Version': version } : {}),
      'X-XSRF-TOKEN': decodeURIComponent(c1.xsrf),
      Cookie: `XSRF-TOKEN=${c1.xsrf}; image_chest_session=${c1.session}`,
      Origin: 'https://imgchest.com',
      Referer: validateUrl,
    },
    body: JSON.stringify({ password }),
  })
  await step2.body?.cancel()
  if (step2.status === 422) throw new Error(`Password-protected post: the password found in the card ("${password}") was rejected.`)
  if (step2.status !== 302 && step2.status !== 303) throw new Error(`Imgchest password check failed (HTTP ${step2.status}).`)
  const c2 = imgchestCookies(step2.headers)

  // 3. Re-read the post with the unlocked session.
  const html = await fetchText(`https://imgchest.com/p/${postId}`, {
    headers: { 'User-Agent': IMGCHEST_UA, Cookie: `XSRF-TOKEN=${c2.xsrf ?? c1.xsrf}; image_chest_session=${c2.session ?? c1.session}` },
  })
  return parseImgchestPage(html)
}

async function resolveImgchest(url: string, ctx: { context: string }): Promise<ResolvedMedia[]> {
  const postId = /imgchest\.com\/p\/([a-zA-Z0-9]+)/i.exec(url)?.[1]
  if (!postId) throw new Error('Not an Imgchest post link.')
  const html = await fetchText(`https://imgchest.com/p/${postId}`)
  const links = html.includes('PostPassword') ? await unlockImgchest(postId, ctx.context) : parseImgchestPage(html)
  return links.map((link) => ({ url: link, name: lastSegment(link) }))
}

// ---------------------------------------------------------------------------------------------
// Catbox albums — the album page lists its files as files.catbox.moe links.
// ---------------------------------------------------------------------------------------------

export function parseCatboxAlbum(html: string): string[] {
  return [...new Set([...html.matchAll(/https:\/\/files\.catbox\.moe\/([a-z0-9_-]+\.[a-z0-9]{2,5})/gi)].map((m) => `https://files.catbox.moe/${m[1]}`))]
}

// ---------------------------------------------------------------------------------------------
// Imgbox galleries — thumbnails `thumbsN.imgbox.com/xx/yy/ID_b.ext` map to originals
// `imagesN.imgbox.com/xx/yy/ID_o.ext`.
// ---------------------------------------------------------------------------------------------

export function parseImgboxGallery(html: string): string[] {
  const re = /https?:\/\/thumbs(\d+)\.imgbox\.com\/([a-f0-9]{2})\/([a-f0-9]{2})\/([a-zA-Z0-9]+)_[bt]\.([a-zA-Z0-9]+)/g
  return [...new Set([...html.matchAll(re)].map((m) => `https://images${m[1]}.imgbox.com/${m[2]}/${m[3]}/${m[4]}_o.${m[5]}`))]
}

// ---------------------------------------------------------------------------------------------
// ImgBB (ibb.co) — album pages embed one URL-encoded `data-object` JSON per image; further pages
// come from a same-origin `/json` POST with a seek cursor. Single-image pages: `og:image`.
// ---------------------------------------------------------------------------------------------

export function parseImgbbDataObjects(html: string): string[] {
  const out: string[] = []
  for (const m of html.matchAll(/data-object='([^']+)'/g)) {
    try {
      const obj = JSON.parse(decodeURIComponent(decodeEntities(m[1]))) as { image?: { url?: unknown } }
      if (typeof obj.image?.url === 'string' && obj.image.url) out.push(obj.image.url)
    } catch {
      // Malformed entry — skip it.
    }
  }
  return out
}

async function resolveImgbb(url: string): Promise<ResolvedMedia[]> {
  const albumId = /ibb\.co(?:\.com)?\/album\/([a-zA-Z0-9]+)/i.exec(url)?.[1]
  const html = await fetchText(url)
  if (!albumId) {
    const direct = parseOgImage(html)
    if (!direct || !/\/\/i\.ibb\.co(?:\.com)?\//i.test(direct)) throw new Error('No direct image found on the ImgBB page.')
    return [{ url: direct, name: lastSegment(direct) }]
  }

  const urls = parseImgbbDataObjects(html)
  const seek = /data-seek="([^"]+)"/.exec(html)?.[1]
  const token = /PF\.obj\.config\.auth_token\s*=\s*"([^"]+)"/.exec(html)?.[1]
  if (/class="pagination-next"/.test(html) && seek && token) {
    const origin = new URL(url).origin
    let cursor = seek
    for (let page = 2; page <= 20; page++) {
      await sleep(300)
      const body = new URLSearchParams({ action: 'list', page: String(page), seek: cursor, auth_token: token, pathname: `/album/${albumId}` })
      let data: { html?: string; seekEnd?: string }
      try {
        data = await fetchJson(`${origin}/json`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Requested-With': 'XMLHttpRequest', Referer: url },
          body: body.toString(),
        })
      } catch {
        break
      }
      if (!data.html) break
      urls.push(...parseImgbbDataObjects(data.html))
      if (!data.seekEnd || data.seekEnd === cursor) break
      cursor = data.seekEnd
    }
  }
  if (urls.length === 0) throw new Error('No images in the album (empty, or hidden from anonymous viewers).')
  return urls.map((u) => ({ url: u, name: lastSegment(u) }))
}

// ---------------------------------------------------------------------------------------------
// Postimg — gallery cards carry data-hotlink/data-name/data-ext; single-image pages: `og:image`.
// ---------------------------------------------------------------------------------------------

export function parsePostimgGallery(html: string): string[] {
  const out = [...html.matchAll(/data-hotlink="([^"]+)"\s+data-name="([^"]+)"\s+data-ext="([^"]+)"/g)].map(
    (m) => `https://i.postimg.cc/${m[1]}/${m[2]}.${m[3]}`,
  )
  if (out.length === 0) out.push(...[...html.matchAll(/data-pswp-src="(https:\/\/i\.postimg\.cc\/[^"]+)"/g)].map((m) => decodeEntities(m[1])))
  return [...new Set(out)]
}

async function resolvePostimg(url: string): Promise<ResolvedMedia[]> {
  const html = await fetchText(url)
  if (/postimg\.cc\/gallery\//i.test(url)) return parsePostimgGallery(html).map((u) => ({ url: u, name: lastSegment(u) }))
  const direct = parseOgImage(html)
  if (!direct || !/\/\/i\.postimg\.cc\//i.test(direct)) throw new Error('No direct image found on the Postimg page.')
  return [{ url: direct.replace(/\?.*$/, ''), name: lastSegment(direct) }]
}

// ---------------------------------------------------------------------------------------------
// Google Drive — public file links become a direct download; public folder pages embed the file
// list (id, MIME type, name) as entity-encoded JSON, no API key needed.
// ---------------------------------------------------------------------------------------------

/** The file id of a Drive file link (`/file/d/ID`, `open?id=ID`, `uc?id=ID`). */
export function googleDriveFileId(url: string): string | undefined {
  return /drive\.google\.com\/file\/d\/([\w-]+)/i.exec(url)?.[1] ?? /drive\.google\.com\/(?:open|uc)\?(?:[^#]*&)?id=([\w-]+)/i.exec(url)?.[1]
}

/** `confirm=t` skips Drive's "can't scan this file for viruses" interstitial on larger files. */
export function googleDriveDownloadUrl(fileId: string): string {
  return `https://drive.usercontent.google.com/download?id=${fileId}&export=download&confirm=t`
}

const GDRIVE_MIME_EXT: Record<string, string> = {
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp',
  'video/mp4': 'mp4', 'video/webm': 'webm', 'audio/mpeg': 'mp3', 'audio/wav': 'wav', 'audio/ogg': 'ogg',
}

export function parseGdriveFolder(html: string): { id: string; name: string }[] {
  // Newer pages escape quotes as \x22 instead of &quot; — normalize to one form.
  const text = html.replace(/\\x22/g, '&quot;')
  const entryRe = /\[null,&quot;([a-zA-Z0-9_-]{20,50})&quot;\],null,null,null,&quot;((?:image|video|audio)\/[a-z0-9.+-]+)&quot;/g
  const out: { id: string; name: string }[] = []
  const seen = new Set<string>()
  for (const m of text.matchAll(entryRe)) {
    const ext = GDRIVE_MIME_EXT[m[2]]
    if (!ext || seen.has(m[1])) continue
    seen.add(m[1])
    const after = text.slice(m.index + m[0].length, m.index + m[0].length + 2000)
    const name = /&quot;([^&]+\.(?:png|jpe?g|gif|webp|mp4|webm|mp3|wav|ogg))&quot;,null,true\]/i.exec(after)?.[1]
    out.push({ id: m[1], name: name ?? `${m[1]}.${ext}` })
  }
  return out
}

async function resolveGdrive(url: string): Promise<ResolvedMedia[]> {
  const fileId = googleDriveFileId(url)
  if (fileId) return [{ url: googleDriveDownloadUrl(fileId), name: `gdrive_${fileId}` }]
  const html = await fetchText(url)
  const files = parseGdriveFolder(html)
  if (files.length === 0) throw new Error('No media files found in the folder (it may not be shared publicly).')
  return files.map((f) => ({ url: googleDriveDownloadUrl(f.id), name: f.name }))
}

// ---------------------------------------------------------------------------------------------
// MEGA — files are encrypted client-side. The public `cs` API returns the encrypted attributes and
// a storage URL; the key comes from the link's #fragment. Node's AES replaces the reference's
// hand-rolled cipher: ECB unwraps folder node keys, CBC decrypts attributes, CTR decrypts content.
// ---------------------------------------------------------------------------------------------

const MEGA_API = 'https://g.api.mega.co.nz/cs'
const MEGA_ERRORS: Record<number, string> = {
  [-2]: 'invalid link',
  [-3]: 'MEGA is busy, try again',
  [-4]: 'rate limited',
  [-9]: 'not found (deleted or wrong link)',
  [-11]: 'access denied',
  [-16]: 'taken down',
  [-17]: 'transfer quota exceeded',
  [-18]: 'temporarily unavailable',
}
let megaSeq = Math.floor(Math.random() * 0x7fffffff)

export interface MegaLink {
  kind: 'file' | 'folder'
  id: string
  key: Buffer
}

/** Parses `mega.nz/file|folder/ID#KEY` and the legacy `mega.nz/#!ID!KEY` / `#F!ID!KEY` forms. */
export function parseMegaLink(url: string): MegaLink | undefined {
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return undefined
  }
  const modern = /^\/(file|folder)\/([\w-]+)/.exec(u.pathname)
  const legacy = /^#(F?)!([\w-]+)!([\w-]+)/.exec(u.hash)
  const kind = modern ? (modern[1] as 'file' | 'folder') : legacy ? (legacy[1] ? 'folder' : 'file') : undefined
  const id = modern?.[2] ?? legacy?.[2]
  // A folder link may carry a `/file/HANDLE` or `/folder/SUB` suffix after the key.
  const keyText = modern ? u.hash.slice(1).split('/')[0] : legacy?.[3]
  if (!kind || !id || !keyText) return undefined
  const key = Buffer.from(keyText, 'base64url')
  if (key.length !== (kind === 'file' ? 32 : 16)) return undefined
  return { kind, id, key }
}

function aes(mode: 'aes-128-ecb' | 'aes-128-cbc' | 'aes-128-ctr', key: Buffer, iv: Buffer | null, data: Buffer): Buffer {
  const decipher = crypto.createDecipheriv(mode, key, iv)
  decipher.setAutoPadding(false)
  return Buffer.concat([decipher.update(data), decipher.final()])
}

/** A file node's 32-byte key folds into the 16-byte AES key... */
export function megaFileKey(nodeKey: Buffer): Buffer {
  const out = Buffer.alloc(16)
  for (let i = 0; i < 16; i++) out[i] = nodeKey[i] ^ nodeKey[i + 16]
  return out
}

/** ...and its bytes 16–24 are the CTR nonce (low 64 bits start at zero). */
export function megaCtrIv(nodeKey: Buffer): Buffer {
  const iv = Buffer.alloc(16)
  nodeKey.copy(iv, 0, 16, 24)
  return iv
}

/** Decrypts a node's `a` attribute blob (`MEGA{"n":"name.png"}`), or undefined if the key is wrong. */
export function decryptMegaAttributes(fileKey: Buffer, attr: Buffer): { n?: string } | undefined {
  if (attr.length === 0 || attr.length % 16 !== 0) return undefined
  const text = aes('aes-128-cbc', fileKey, Buffer.alloc(16), attr).toString('utf8')
  if (!text.startsWith('MEGA{')) return undefined
  try {
    return JSON.parse(text.slice(4).replace(/\0+$/, '')) as { n?: string }
  } catch {
    return undefined
  }
}

/** Decrypts a downloaded MEGA file. */
export function decryptMegaContent(nodeKey: Buffer, data: Buffer): Buffer {
  return aes('aes-128-ctr', megaFileKey(nodeKey), megaCtrIv(nodeKey), data)
}

async function megaApi(command: Record<string, unknown>, folderId?: string): Promise<Record<string, unknown>> {
  const res = await safeFetch(`${MEGA_API}?id=${megaSeq++}${folderId ? `&n=${folderId}` : ''}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify([command]),
  })
  if (!res.ok) {
    await res.body?.cancel()
    throw new Error(`MEGA API answered HTTP ${res.status}.`)
  }
  const data = JSON.parse((await readCapped(res, PAGE_CAP)).toString('utf8')) as unknown
  const first = Array.isArray(data) ? (data[0] as unknown) : data
  if (typeof first === 'number') throw new Error(`MEGA: ${MEGA_ERRORS[first] ?? `error ${first}`}.`)
  if (!first || typeof first !== 'object') throw new Error('MEGA returned an unexpected response.')
  return first as Record<string, unknown>
}

/** Downloads, decrypts and saves one MEGA file, skipping it if the same source is already saved. */
async function downloadMega(
  characterId: string,
  sourceUrl: string,
  file: { name: string; size: number; nodeKey: Buffer; storageUrl: () => Promise<string> },
): Promise<MediaFetchResult> {
  try {
    const existing = listMedia(characterId).find((item) => item.sourceUrl === sourceUrl)
    if (existing) return { url: sourceUrl, ok: true, skipped: true, item: existing }
    if (file.size > MAX_MEDIA_BYTES) return { url: sourceUrl, ok: false, error: 'File is too large (max 64MB).' }
    // Storage hosts are handed out as http://; they all speak TLS.
    const res = await safeFetch((await file.storageUrl()).replace(/^http:\/\//i, 'https://'))
    if (!res.ok) {
      await res.body?.cancel()
      return { url: sourceUrl, ok: false, error: `HTTP ${res.status}` }
    }
    const decrypted = decryptMegaContent(file.nodeKey, await readCapped(res))
    const buffer = file.size > 0 && decrypted.length > file.size ? decrypted.subarray(0, file.size) : decrypted
    const item = saveMediaBuffer(characterId, { suggestedName: file.name, buffer, sourceUrl })
    return { url: sourceUrl, ok: true, item }
  } catch (e) {
    return { url: sourceUrl, ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

function storageUrlOf(res: Record<string, unknown>): string {
  if (typeof res.g !== 'string' || !res.g) throw new Error('MEGA did not provide a download URL.')
  return res.g
}

async function resolveMegaFile(url: string, link: MegaLink): Promise<ResolvedMedia[]> {
  const info = await megaApi({ a: 'g', g: 1, ssl: 2, p: link.id })
  const attrs = typeof info.at === 'string' ? decryptMegaAttributes(megaFileKey(link.key), Buffer.from(info.at, 'base64url')) : undefined
  if (!attrs?.n) throw new Error('Could not decrypt the MEGA file (wrong key in the link?).')
  if (!mediaKindOf(attrs.n)) throw new Error(`"${attrs.n}" is not an image, video or audio file.`)
  const name = attrs.n
  const size = typeof info.s === 'number' ? info.s : 0
  const storage = storageUrlOf(info)
  return [{ url, name, download: (characterId) => downloadMega(characterId, url, { name, size, nodeKey: link.key, storageUrl: async () => storage }) }]
}

interface MegaNode {
  h: string
  p: string
  t: number
  a?: string
  k?: string
  s?: number
}

/** Unwraps a node key (`k` = "handle:b64key/handle:b64key…") with whichever parent key we hold. */
function unwrapNodeKey(node: MegaNode, keys: Map<string, Buffer>): Buffer | undefined {
  for (const entry of (node.k ?? '').split('/')) {
    const sep = entry.indexOf(':')
    if (sep < 1) continue
    const parent = keys.get(entry.slice(0, sep))
    if (!parent) continue
    const wrapped = Buffer.from(entry.slice(sep + 1), 'base64url')
    if (wrapped.length === 0 || wrapped.length % 16 !== 0) continue
    try {
      return aes('aes-128-ecb', parent, null, wrapped)
    } catch {
      continue
    }
  }
  return undefined
}

async function resolveMegaFolder(link: MegaLink): Promise<ResolvedMedia[]> {
  const listing = await megaApi({ a: 'f', c: 1, r: 1 }, link.id)
  const nodes = (Array.isArray(listing.f) ? listing.f : []) as MegaNode[]
  if (nodes.length === 0) throw new Error('The MEGA folder is empty or not accessible.')

  // The root folder's key is the link key; subfolder keys unwrap from their parents, so resolve
  // repeatedly until nothing new turns up.
  const handles = new Set(nodes.map((n) => n.h))
  const keys = new Map<string, Buffer>()
  const root = nodes.find((n) => n.t >= 1 && !handles.has(n.p))
  if (root) keys.set(root.h, link.key)
  for (let progress = true, pass = 0; progress && pass < nodes.length; pass++) {
    progress = false
    for (const n of nodes) {
      if (n.t !== 1 || keys.has(n.h)) continue
      const key = unwrapNodeKey(n, keys)
      if (key?.length === 16) {
        keys.set(n.h, key)
        progress = true
      }
    }
  }

  const out: ResolvedMedia[] = []
  for (const n of nodes) {
    if (n.t !== 0 || !n.a) continue
    const nodeKey = unwrapNodeKey(n, keys)
    if (!nodeKey || nodeKey.length < 32) continue
    const attrs = decryptMegaAttributes(megaFileKey(nodeKey), Buffer.from(n.a, 'base64url'))
    if (!attrs?.n || !mediaKindOf(attrs.n)) continue
    const name = attrs.n
    const handle = n.h
    const sourceUrl = `https://mega.nz/folder/${link.id}/file/${handle}`
    out.push({
      url: sourceUrl,
      name,
      download: (characterId) =>
        downloadMega(characterId, sourceUrl, {
          name,
          size: n.s ?? 0,
          nodeKey,
          storageUrl: async () => storageUrlOf(await megaApi({ a: 'g', g: 1, ssl: 2, n: handle }, link.id)),
        }),
    })
  }
  if (out.length === 0) throw new Error('No image, video or audio files found in the MEGA folder.')
  return out
}

async function resolveMega(url: string): Promise<ResolvedMedia[]> {
  const link = parseMegaLink(url)
  if (!link) throw new Error('Invalid MEGA link (the #key part is missing or malformed).')
  return link.kind === 'file' ? resolveMegaFile(url, link) : resolveMegaFolder(link)
}

// ---------------------------------------------------------------------------------------------
// Pixiv — artwork metadata (`/ajax/illust/ID`) is public; i.pximg.net only needs a pixiv Referer.
// Without a login, R-18 works return no image URLs, so those are reported rather than fetched.
// ---------------------------------------------------------------------------------------------

const PIXIV_REFERER = 'https://www.pixiv.net/'

export function parsePixivId(url: string): string | undefined {
  return /pixiv\.net\/(?:[a-z]{2}\/)?artworks\/(\d+)/i.exec(url)?.[1] ?? /pixiv\.net\/member_illust\.php\?(?:[^#]*&)?illust_id=(\d+)/i.exec(url)?.[1]
}

interface PixivUrls {
  original?: string | null
  regular?: string | null
}

async function pixivAjax<T>(path: string): Promise<T> {
  const res = await safeFetch(`https://www.pixiv.net${path}`, { headers: { Accept: 'application/json', Referer: PIXIV_REFERER } })
  const text = (await readCapped(res, PAGE_CAP)).toString('utf8')
  let data: { error?: boolean; message?: string; body?: T }
  try {
    data = JSON.parse(text)
  } catch {
    throw new Error(`Pixiv answered HTTP ${res.status}.`)
  }
  if (!res.ok || data.error || data.body === undefined) {
    throw new Error(res.status === 404 ? 'Pixiv artwork not found (deleted or private).' : data.message || `Pixiv answered HTTP ${res.status}.`)
  }
  return data.body
}

async function resolvePixiv(url: string): Promise<ResolvedMedia[]> {
  const id = parsePixivId(url)
  if (!id) throw new Error('Not a Pixiv artwork link.')
  const meta = await pixivAjax<{ illustType?: number; xRestrict?: number; pageCount?: number; urls?: PixivUrls }>(`/ajax/illust/${id}`)
  if (meta.illustType === 2) throw new Error('Pixiv animations (ugoira) are not supported.')
  const first = meta.urls?.original || meta.urls?.regular
  if (!first) {
    throw new Error(
      Number(meta.xRestrict) > 0
        ? 'This is an R-18 Pixiv artwork; its images are only served to logged-in accounts.'
        : 'Pixiv returned no image URLs for this artwork (it may be restricted).',
    )
  }
  let urls = [first]
  if (Number(meta.pageCount) > 1) {
    const pages = await pixivAjax<{ urls?: PixivUrls }[]>(`/ajax/illust/${id}/pages`).catch(() => [])
    const all = pages.map((p) => p.urls?.original || p.urls?.regular).filter((u): u is string => !!u)
    if (all.length > 0) urls = all
  }
  return urls.map((u, i) => ({ url: u, name: `pixiv_${id}_p${i}`, referer: PIXIV_REFERER }))
}

// ---------------------------------------------------------------------------------------------
// Dropbox — file shares flip to `dl=1`; folder share pages embed the file list as a base64
// protobuf blob, from which file share URLs are grepped. Needs browser-shaped request headers.
// ---------------------------------------------------------------------------------------------

const DROPBOX_FILE_RE = /https:\/\/www\.dropbox\.com\/scl\/(?:fo|fi)\/[A-Za-z0-9_\-/%~.]+?\.(?:png|jpe?g|gif|webp|avif|mp4|webm|mov|mp3|wav|ogg|m4a|flac)\?[A-Za-z0-9=&_-]+/gi

/** Strips card-HTML residue (`&amp;`) and the viewer-session `st=` token, and forces `dl=1`. */
export function dropboxDirectUrl(raw: string): string {
  let url = raw.replace(/&amp;/g, '&').replace(/([?&])st=[^&#]*(&|$)/, (_, lead: string, tail: string) => (tail ? lead : ''))
  url = url.replace(/([?&])dl=0(?=$|&)/, '$1dl=1')
  if (!/[?&]dl=1(?=$|&)/.test(url)) url += url.includes('?') ? '&dl=1' : '?dl=1'
  return url
}

export function parseDropboxFolder(html: string): string[] {
  const seen = new Set<string>()
  for (const m of html.matchAll(/"([A-Za-z0-9+/]{5000,}={0,2})"/g)) {
    const decoded = Buffer.from(m[1], 'base64').toString('latin1')
    for (const f of decoded.matchAll(DROPBOX_FILE_RE)) seen.add(dropboxDirectUrl(f[0]))
    if (seen.size > 0) break
  }
  return [...seen]
}

async function resolveDropbox(url: string): Promise<ResolvedMedia[]> {
  const clean = dropboxDirectUrl(url)
  if (!/\/scl\/fo\//.test(clean)) return [{ url: clean, name: lastSegment(clean.split('?')[0]) }]
  const html = await fetchText(clean.replace(/([?&])dl=1(?=$|&)/, '$1dl=0'), {
    headers: { 'Accept-Language': 'en-US,en;q=0.9', 'Sec-Fetch-Dest': 'document', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Site': 'none' },
  })
  const files = parseDropboxFolder(html)
  if (files.length === 0) throw new Error('No media files found in the Dropbox folder.')
  return files.map((f) => ({ url: f, name: lastSegment(f.split('?')[0]) }))
}

// ---------------------------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------------------------

const EXTRACTORS: readonly Extractor[] = [
  { id: 'civitai', name: 'Civitai', patterns: [/\/\/(?:www\.)?civitai\.(?:com|red)\/(?:posts|images|models)\/\d+/i], resolve: resolveCivitai },
  { id: 'imgchest', name: 'Imgchest', patterns: [/\/\/(?:www\.)?imgchest\.com\/p\/[a-zA-Z0-9]+/i], resolve: resolveImgchest },
  {
    id: 'catbox',
    name: 'Catbox',
    patterns: [/\/\/(?:www\.)?catbox\.moe\/c\/[a-zA-Z0-9]+/i],
    resolve: async (url) => parseCatboxAlbum(await fetchText(url)).map((u) => ({ url: u, name: lastSegment(u) })),
  },
  {
    id: 'imgbox',
    name: 'Imgbox',
    patterns: [/\/\/(?:www\.)?imgbox\.com\/g\/[a-zA-Z0-9]+/i],
    resolve: async (url) => parseImgboxGallery(await fetchText(url)).map((u) => ({ url: u, name: lastSegment(u) })),
  },
  {
    id: 'imgbb',
    name: 'ImgBB',
    patterns: [
      /\/\/(?:www\.)?ibb\.co(?:\.com)?\/album\/[a-zA-Z0-9]+/i,
      /\/\/(?:www\.)?ibb\.co(?:\.com)?\/(?!album\b|json\b|login\b|upload\b)[a-zA-Z0-9]{6,16}\/?(?:[?#][^\s]*)?$/i,
    ],
    resolve: resolveImgbb,
  },
  {
    id: 'postimg',
    name: 'Postimg',
    patterns: [/\/\/(?:www\.)?postimg\.cc\/gallery\/[a-zA-Z0-9]+/i, /\/\/(?:www\.)?postimg\.cc\/(?:image\/)?(?!gallery\b)[a-zA-Z0-9]{6,12}\/?(?:[?#][^\s]*)?$/i],
    resolve: resolvePostimg,
  },
  {
    id: 'gdrive',
    name: 'Google Drive',
    patterns: [
      /\/\/drive\.google\.com\/drive\/(?:u\/\d+\/)?folders\/[\w-]+/i,
      /\/\/drive\.google\.com\/file\/d\/[\w-]+/i,
      /\/\/drive\.google\.com\/(?:open|uc)\?(?:[^#\s]*&)?id=[\w-]+/i,
    ],
    resolve: resolveGdrive,
  },
  { id: 'mega', name: 'MEGA', patterns: [/\/\/(?:www\.)?mega\.(?:nz|io)\/(?:file|folder)\/[\w-]+#[\w-]+/i, /\/\/(?:www\.)?mega\.(?:nz|co\.nz)\/#F?![\w-]+![\w-]+/i], resolve: resolveMega },
  {
    id: 'pixiv',
    name: 'Pixiv',
    patterns: [/\/\/(?:www\.)?pixiv\.net\/(?:[a-z]{2}\/)?artworks\/\d+/i, /\/\/(?:www\.)?pixiv\.net\/member_illust\.php\?(?:[^#\s]*&)?illust_id=\d+/i],
    resolve: resolvePixiv,
  },
  { id: 'dropbox', name: 'Dropbox', patterns: [/\/\/(?:www\.)?dropbox\.com\/scl\/(?:fo|fi)\/[\w-]+\//i, /\/\/(?:www\.)?dropbox\.com\/s\/[\w-]+\/[^?#\s]+/i], resolve: resolveDropbox },
]

/** Supported album hosts (id, display name, URL patterns) — mirrored client-side in `embeddedMedia.ts`. */
export const EXTRACTOR_HOSTS: readonly { id: string; name: string; patterns: readonly RegExp[] }[] = EXTRACTORS.map(({ id, name, patterns }) => ({ id, name, patterns }))

/** The id of the extractor that handles `url`, if any. */
export function detectExtractor(url: string): string | undefined {
  return EXTRACTORS.find((e) => e.patterns.some((p) => p.test(url)))?.id
}

function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname
  } catch {
    return 'unknown'
  }
}

/**
 * Resolves one album/post/share link and downloads everything in it into the character's media
 * folder, one file at a time. `context` (card text) is where a password for protected albums is
 * looked up. Never throws — failures come back as `{ ok: false, error }`.
 */
export async function extractAlbum(url: string, opts: { characterId: string; context?: string }): Promise<ExtractResult> {
  const extractor = EXTRACTORS.find((e) => e.patterns.some((p) => p.test(url)))
  const host = extractor?.id ?? hostnameOf(url)
  if (!extractor) return { url, host, ok: false, found: 0, downloaded: [], error: 'No extractor supports this link.' }
  try {
    assertPublicUrl(url)
    const seen = new Set<string>()
    const items = (await extractor.resolve(url, { context: opts.context ?? '' })).filter((item) => !seen.has(item.url) && !!seen.add(item.url))
    if (items.length === 0) return { url, host, ok: false, found: 0, downloaded: [], error: `No media found on ${extractor.name}.` }
    const downloaded: MediaFetchResult[] = []
    for (const item of items.slice(0, MAX_ITEMS_PER_ALBUM)) {
      downloaded.push(
        item.download
          ? await item.download(opts.characterId)
          : await downloadToMedia(opts.characterId, item.url, { referer: item.referer ?? url, suggestedName: item.name }),
      )
    }
    const ok = downloaded.some((d) => d.ok)
    return { url, host, ok, found: items.length, downloaded, error: ok ? undefined : 'Every download from this album failed.' }
  } catch (e) {
    return { url, host, ok: false, found: 0, downloaded: [], error: e instanceof Error ? e.message : String(e) }
  }
}
