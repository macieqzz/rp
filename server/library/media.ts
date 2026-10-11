/**
 * A character's library media folder: `data/avatars/characters/<id>/media/`. Unlike the CG gallery
 * (`gallery/`, pruned to exactly the files `Character.gallery` references), this folder is free-form
 * — images, video and audio downloaded from a card's embedded links, provider galleries and album
 * extractors, or uploaded by hand. It lives inside the character's folder, so deleting the character
 * (`removeAvatar`) and full backup/restore (`listAvatarFiles`) already cover it.
 *
 * `.sources.json` beside the files maps each file name to the remote URL it came from, which is what
 * lets the details view swap remote URLs for local copies at display time.
 */

import fs from 'node:fs'
import path from 'node:path'
import net from 'node:net'
import dns from 'node:dns/promises'
import { avatarsDir } from '../db.ts'
import type { MediaFetchResult, MediaItem, MediaKind } from '../../src/lib/library/types.ts'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const SOURCES_FILE = '.sources.json'
export const MAX_MEDIA_BYTES = 64 * 1024 * 1024
const FETCH_TIMEOUT_MS = 30000

const EXT_KIND: Record<string, MediaKind> = {
  png: 'image',
  jpg: 'image',
  jpeg: 'image',
  webp: 'image',
  gif: 'image',
  avif: 'image',
  bmp: 'image',
  mp4: 'video',
  webm: 'video',
  mov: 'video',
  m4v: 'video',
  mp3: 'audio',
  wav: 'audio',
  ogg: 'audio',
  oga: 'audio',
  m4a: 'audio',
  flac: 'audio',
  opus: 'audio',
}

const EXT_BY_MIME: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/avif': 'avif',
  'image/bmp': 'bmp',
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'video/quicktime': 'mov',
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/wave': 'wav',
  'audio/ogg': 'ogg',
  'audio/mp4': 'm4a',
  'audio/x-m4a': 'm4a',
  'audio/flac': 'flac',
  'audio/opus': 'opus',
}

export function mediaKindOf(fileName: string): MediaKind | undefined {
  return EXT_KIND[path.extname(fileName).slice(1).toLowerCase()]
}

export function assertCharacterId(id: string): void {
  if (!UUID_RE.test(id)) throw new Error('Invalid character id')
}

export function mediaDir(characterId: string): string {
  assertCharacterId(characterId)
  return path.join(avatarsDir, 'characters', characterId, 'media')
}

function readSources(dir: string): Record<string, string> {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(dir, SOURCES_FILE), 'utf8')) as unknown
    return raw && typeof raw === 'object' ? (raw as Record<string, string>) : {}
  } catch {
    return {}
  }
}

function writeSources(dir: string, sources: Record<string, string>): void {
  fs.writeFileSync(path.join(dir, SOURCES_FILE), JSON.stringify(sources))
}

function toItem(characterId: string, dir: string, name: string, sources: Record<string, string>): MediaItem | undefined {
  const kind = mediaKindOf(name)
  if (!kind) return undefined
  const stat = fs.statSync(path.join(dir, name))
  return {
    name,
    url: `/avatars/characters/${characterId}/media/${encodeURIComponent(name)}`,
    kind,
    size: stat.size,
    modifiedAt: Math.round(stat.mtimeMs),
    sourceUrl: sources[name],
  }
}

export function listMedia(characterId: string): MediaItem[] {
  const dir = mediaDir(characterId)
  if (!fs.existsSync(dir)) return []
  const sources = readSources(dir)
  const items: MediaItem[] = []
  for (const name of fs.readdirSync(dir)) {
    if (name.startsWith('.')) continue
    const item = toItem(characterId, dir, name, sources)
    if (item) items.push(item)
  }
  return items.sort((a, b) => b.modifiedAt - a.modifiedAt)
}

/** Counts per character, for the grid's `gallery:` search filter and hover info. */
export function mediaCounts(characterIds: string[]): Record<string, number> {
  const out: Record<string, number> = {}
  for (const id of characterIds) {
    if (!UUID_RE.test(id)) continue
    const dir = path.join(avatarsDir, 'characters', id, 'media')
    if (!fs.existsSync(dir)) continue
    out[id] = fs.readdirSync(dir).filter((n) => !n.startsWith('.') && mediaKindOf(n)).length
  }
  return out
}

/** A filesystem-safe base name (no separators, no dot-files, bounded length). */
export function safeFileBase(name: string): string {
  const base = name
    .replace(/\.[a-z0-9]{2,5}$/i, '')
    .replace(/[^a-z0-9_-]+/gi, '_')
    .replace(/^[_.-]+|[_.-]+$/g, '')
    .slice(0, 60)
  return base || 'media'
}

function uniqueName(dir: string, base: string, ext: string): string {
  let candidate = `${base}.${ext}`
  for (let i = 2; fs.existsSync(path.join(dir, candidate)); i++) candidate = `${base}-${i}.${ext}`
  return candidate
}

function extFromUrl(url: string): string | undefined {
  try {
    const ext = path.extname(new URL(url).pathname).slice(1).toLowerCase()
    return EXT_KIND[ext] ? (ext === 'jpeg' ? 'jpg' : ext) : undefined
  } catch {
    return undefined
  }
}

/** Writes a buffer into the media folder under a unique, sanitized name. */
export function saveMediaBuffer(
  characterId: string,
  opts: { suggestedName: string; buffer: Buffer; contentType?: string; sourceUrl?: string },
): MediaItem {
  const dir = mediaDir(characterId)
  const mime = (opts.contentType ?? '').split(';')[0].trim().toLowerCase()
  const ext =
    EXT_BY_MIME[mime] ??
    (mediaKindOf(opts.suggestedName) ? path.extname(opts.suggestedName).slice(1).toLowerCase() : undefined) ??
    (opts.sourceUrl ? extFromUrl(opts.sourceUrl) : undefined)
  if (!ext || !EXT_KIND[ext]) throw new Error(`Unsupported media type${mime ? ` "${mime}"` : ''}.`)
  if (opts.buffer.length > MAX_MEDIA_BYTES) throw new Error('File is too large (max 64MB).')
  if (opts.buffer.length === 0) throw new Error('Empty file.')
  fs.mkdirSync(dir, { recursive: true })
  const name = uniqueName(dir, safeFileBase(opts.suggestedName), ext)
  fs.writeFileSync(path.join(dir, name), opts.buffer)
  const sources = readSources(dir)
  if (opts.sourceUrl) {
    sources[name] = opts.sourceUrl
    writeSources(dir, sources)
  }
  return toItem(characterId, dir, name, sources)!
}

export function deleteMedia(characterId: string, name: string): void {
  const dir = mediaDir(characterId)
  if (!name || name.startsWith('.') || name.includes('/') || name.includes('\\')) throw new Error('Invalid file name')
  const file = path.join(dir, name)
  if (fs.existsSync(file)) fs.unlinkSync(file)
  const sources = readSources(dir)
  if (name in sources) {
    delete sources[name]
    writeSources(dir, sources)
  }
}

/** Remote URL → local media URL for every downloaded file with a recorded source. */
export function localizationMap(characterId: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const item of listMedia(characterId)) if (item.sourceUrl) out[item.sourceUrl] = item.url
  return out
}

/** True for loopback, link-local, private and otherwise non-public IP literals. */
function isPrivateAddress(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, '').toLowerCase()
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')) return true
  const kind = net.isIP(h)
  if (kind === 4) {
    const [a, b] = h.split('.').map(Number)
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127)
  }
  if (kind === 6) return h === '::1' || h === '::' || h.startsWith('fc') || h.startsWith('fd') || h.startsWith('fe80') || h.startsWith('::ffff:')
  return false
}

/**
 * Validates a user/card-supplied URL before the server fetches it: public http(s) only, so a card
 * that embeds `http://192.168.0.1/...` can't make the local server probe the user's own network.
 */
export function assertPublicUrl(raw: string): URL {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error('Not a valid URL.')
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('Only http(s) URLs can be downloaded.')
  if (url.username || url.password) throw new Error('URLs with credentials are not allowed.')
  if (isPrivateAddress(url.hostname)) throw new Error('Refusing to fetch a private/local address.')
  return url
}

/**
 * `assertPublicUrl` only sees the hostname as written, so a public-looking name whose DNS points at
 * a LAN address (`evil.example` → 192.168.1.1) would slip through. Resolves the name and rejects it
 * when any address it maps to is private. Literal IPs were already checked, so they skip the lookup.
 */
export async function assertPublicHost(url: URL): Promise<void> {
  const host = url.hostname.replace(/^\[|\]$/g, '')
  if (net.isIP(host)) return
  let addresses: { address: string }[]
  try {
    addresses = await dns.lookup(host, { all: true })
  } catch {
    throw new Error(`Could not resolve ${host}.`)
  }
  if (addresses.some((a) => isPrivateAddress(a.address))) throw new Error('Refusing to fetch a private/local address.')
}

const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36'

/**
 * Server-side fetch with a timeout, a byte cap and public-address validation on every redirect hop.
 * Used by the media downloader, the album extractors and the online providers alike.
 */
export async function safeFetch(
  raw: string,
  init: { headers?: Record<string, string>; method?: string; body?: string; timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<Response> {
  let url = assertPublicUrl(raw)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), init.timeoutMs ?? FETCH_TIMEOUT_MS)
  const onAbort = () => controller.abort()
  init.signal?.addEventListener('abort', onAbort)
  try {
    for (let hop = 0; hop < 6; hop++) {
      await assertPublicHost(url)
      const res = await fetch(url, {
        method: init.method ?? 'GET',
        body: init.body,
        headers: { 'User-Agent': BROWSER_UA, ...init.headers },
        redirect: 'manual',
        signal: controller.signal,
      })
      if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
        await res.body?.cancel()
        url = assertPublicUrl(new URL(res.headers.get('location')!, url).toString())
        continue
      }
      return res
    }
    throw new Error('Too many redirects.')
  } finally {
    clearTimeout(timer)
    init.signal?.removeEventListener('abort', onAbort)
  }
}

/** Reads a response body into a buffer, aborting past `MAX_MEDIA_BYTES`. */
export async function readCapped(res: Response, cap = MAX_MEDIA_BYTES): Promise<Buffer> {
  const declared = Number(res.headers.get('content-length') ?? 0)
  if (declared > cap) {
    await res.body?.cancel()
    throw new Error('File is too large.')
  }
  if (!res.body) return Buffer.alloc(0)
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    total += chunk.byteLength
    if (total > cap) throw new Error('File is too large.')
    chunks.push(Buffer.from(chunk))
  }
  return Buffer.concat(chunks, total)
}

function nameFromUrl(url: string): string {
  try {
    const last = decodeURIComponent(new URL(url).pathname.split('/').filter(Boolean).pop() ?? '')
    return last || 'media'
  } catch {
    return 'media'
  }
}

/**
 * Downloads one remote file into a character's media folder. A URL already recorded in
 * `.sources.json` is skipped rather than downloaded twice.
 */
export async function downloadToMedia(
  characterId: string,
  url: string,
  opts: { referer?: string; headers?: Record<string, string>; suggestedName?: string } = {},
): Promise<MediaFetchResult> {
  try {
    const dir = mediaDir(characterId)
    const sources = fs.existsSync(dir) ? readSources(dir) : {}
    const existing = Object.entries(sources).find(([name, src]) => src === url && fs.existsSync(path.join(dir, name)))
    if (existing) {
      const item = toItem(characterId, dir, existing[0], sources)
      return { url, ok: true, skipped: true, item }
    }
    const res = await safeFetch(url, {
      headers: { Accept: 'image/*,video/*,audio/*,*/*;q=0.5', ...(opts.referer ? { Referer: opts.referer } : {}), ...opts.headers },
    })
    if (!res.ok) {
      await res.body?.cancel()
      return { url, ok: false, error: `HTTP ${res.status}` }
    }
    const contentType = res.headers.get('content-type') ?? ''
    if (/^text\/html/i.test(contentType)) {
      await res.body?.cancel()
      return { url, ok: false, error: 'The link points to a web page, not a media file.' }
    }
    const buffer = await readCapped(res)
    const item = saveMediaBuffer(characterId, {
      suggestedName: opts.suggestedName ?? nameFromUrl(url),
      buffer,
      contentType,
      sourceUrl: url,
    })
    return { url, ok: true, item }
  } catch (e) {
    return { url, ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}
