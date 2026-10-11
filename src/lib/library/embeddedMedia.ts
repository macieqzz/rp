/**
 * Finds the media a card links to in its own text — markdown images/links, HTML `src`/`href`/
 * `srcset`/`poster`, CSS `url(...)` and bare URLs — and sorts it into direct files (downloadable
 * as-is) and album/share pages (resolved server-side by `server/library/extractors.ts`). Also
 * rewrites a card's HTML to point at the local copies once they're downloaded. Pure: no I/O.
 */

import type { CharacterCardData } from '../characters/cardSpec'

/** Card fields scanned for links, in display order. */
const TEXT_FIELDS = ['description', 'personality', 'scenario', 'first_mes', 'mes_example', 'creator_notes', 'system_prompt', 'post_history_instructions'] as const

const MEDIA_EXT = /\.(?:png|jpe?g|webp|gif|avif|mp4|webm|mov|mp3|wav|ogg|m4a|flac)$/i

/** CDN hosts that only ever serve files, so an extension-less path there is still direct media. */
const DIRECT_HOSTS = /^(?:files\.catbox\.moe|i\.imgur\.com|i\.ibb\.co|i\.postimg\.cc|images\d*\.imgbox\.com|cdn\.imgchest\.com|image\.civitai\.com)$/i

/**
 * Album/share pages the server can extract. A copy of the patterns in `EXTRACTOR_HOSTS`
 * (`server/library/extractors.ts`) — the client can't import server code, so keep both in sync.
 */
const ALBUM_PATTERNS: readonly RegExp[] = [
  /\/\/(?:www\.)?civitai\.(?:com|red)\/(?:posts|images|models)\/\d+/i,
  /\/\/(?:www\.)?imgchest\.com\/p\/[a-zA-Z0-9]+/i,
  /\/\/(?:www\.)?catbox\.moe\/c\/[a-zA-Z0-9]+/i,
  /\/\/(?:www\.)?imgbox\.com\/g\/[a-zA-Z0-9]+/i,
  /\/\/(?:www\.)?ibb\.co(?:\.com)?\/album\/[a-zA-Z0-9]+/i,
  /\/\/(?:www\.)?ibb\.co(?:\.com)?\/(?!album\b|json\b|login\b|upload\b)[a-zA-Z0-9]{6,16}\/?(?:[?#][^\s]*)?$/i,
  /\/\/(?:www\.)?postimg\.cc\/gallery\/[a-zA-Z0-9]+/i,
  /\/\/(?:www\.)?postimg\.cc\/(?:image\/)?(?!gallery\b)[a-zA-Z0-9]{6,12}\/?(?:[?#][^\s]*)?$/i,
  /\/\/drive\.google\.com\/drive\/(?:u\/\d+\/)?folders\/[\w-]+/i,
  /\/\/drive\.google\.com\/file\/d\/[\w-]+/i,
  /\/\/drive\.google\.com\/(?:open|uc)\?(?:[^#\s]*&)?id=[\w-]+/i,
  /\/\/(?:www\.)?mega\.(?:nz|io)\/(?:file|folder)\/[\w-]+#[\w-]+/i,
  /\/\/(?:www\.)?mega\.(?:nz|co\.nz)\/#F?![\w-]+![\w-]+/i,
  /\/\/(?:www\.)?pixiv\.net\/(?:[a-z]{2}\/)?artworks\/\d+/i,
  /\/\/(?:www\.)?pixiv\.net\/member_illust\.php\?(?:[^#\s]*&)?illust_id=\d+/i,
  /\/\/(?:www\.)?dropbox\.com\/scl\/(?:fo|fi)\/[\w-]+\//i,
  /\/\/(?:www\.)?dropbox\.com\/s\/[\w-]+\/[^?#\s]+/i,
]

const TRAILING_PUNCT = '.,;:!?)]}\'"*>'

/**
 * Trims sentence punctuation and markdown residue glued to the end of a URL. A `)` is kept when
 * it closes a `(` inside the URL itself (`/wiki/Foo_(bar)`).
 */
function cleanUrl(raw: string): string {
  let url = raw.replace(/&amp;/g, '&')
  while (url.length > 0 && TRAILING_PUNCT.includes(url[url.length - 1])) {
    if (url.endsWith(')') && url.split('(').length > url.split(')').length - 1) break
    url = url.slice(0, -1)
  }
  return url
}

/** Every http(s) URL in a block of card text, deduped. */
export function findUrls(text: string): string[] {
  const found: string[] = []
  const add = (raw: string) => {
    const url = cleanUrl(raw.trim())
    if (/^https?:\/\/[^/\s]+/i.test(url) && !found.includes(url)) found.push(url)
  }
  // Markdown `![alt](url "title")` / `[text](url)`.
  for (const m of text.matchAll(/\]\(\s*<?(https?:\/\/[^\s)>]+(?:\([^\s)]*\))?[^\s)>]*)/gi)) add(m[1])
  // HTML attributes, quoted or not.
  for (const m of text.matchAll(/\b(?:src|href|poster|data-src)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/gi)) add(m[1] ?? m[2] ?? m[3])
  // srcset: comma-separated "url descriptor" candidates.
  for (const m of text.matchAll(/\bsrcset\s*=\s*(?:"([^"]*)"|'([^']*)')/gi)) {
    for (const candidate of (m[1] ?? m[2]).split(/,\s+/)) add(candidate.trim().split(/\s+/)[0])
  }
  // CSS url(...).
  for (const m of text.matchAll(/url\(\s*["']?(https?:\/\/[^"')\s]+)["']?\s*\)/gi)) add(m[1])
  // Bare URLs anywhere else.
  for (const m of text.matchAll(/https?:\/\/[^\s<>"'`\]]+/gi)) add(m[0])
  return found
}

/**
 * `'album'` for a page a server extractor resolves, `'direct'` for a downloadable media file,
 * undefined for anything else. Album patterns win over extensions: a Dropbox `…/pic.png?dl=0`
 * share is a page, not a file.
 */
export function classifyMediaUrl(url: string): 'album' | 'direct' | undefined {
  if (ALBUM_PATTERNS.some((p) => p.test(url))) return 'album'
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return undefined
  }
  const last = parsed.pathname.split('/').pop() ?? ''
  if (MEDIA_EXT.test(last)) return 'direct'
  return DIRECT_HOSTS.test(parsed.hostname) && !/\.[a-z0-9]{2,5}$/i.test(last) ? 'direct' : undefined
}

/** Splits every URL in the card's text fields into direct media files and album/share pages. */
export function extractEmbeddedMedia(card: CharacterCardData): { direct: string[]; albums: string[] } {
  const texts = [...TEXT_FIELDS.map((f) => card[f]), ...(card.alternate_greetings ?? [])].filter(
    (t): t is string => typeof t === 'string' && t.length > 0,
  )
  const direct: string[] = []
  const albums: string[] = []
  for (const url of findUrls(texts.join('\n'))) {
    const kind = classifyMediaUrl(url)
    if (kind === 'album') albums.push(url)
    else if (kind === 'direct') direct.push(url)
  }
  return { direct, albums }
}

/**
 * Replaces each remote URL in `html` that has a local copy in `map` (remote → local). Matches are
 * exact: a URL only counts when it isn't the prefix of a longer one (`a.png` vs `a.png?w=2`), with
 * trailing sentence punctuation allowed. `&amp;`-encoded spellings of the same URL match too.
 */
export function localizeHtml(html: string, map: Record<string, string>): string {
  const lookup: Record<string, string> = {}
  for (const [remote, local] of Object.entries(map)) {
    if (!remote || !local) continue
    lookup[remote] = local
    if (remote.includes('&')) lookup[remote.replace(/&/g, '&amp;')] = local
  }
  const keys = Object.keys(lookup).sort((a, b) => b.length - a.length)
  if (keys.length === 0) return html
  const alternation = keys.map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')
  const re = new RegExp(`(${alternation})(?=$|[\\s"'<>)\\]]|[.,;:!?*](?:$|[\\s"'<>)\\]]))`, 'g')
  return html.replace(re, (match) => lookup[match] ?? match)
}
