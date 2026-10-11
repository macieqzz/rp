/** Strips roleplay formatting that reads badly out loud — *actions*, stray markdown — before handing text to TTS. */
export function toSpeakableText(text: string): string {
  return text
    .replace(/\*[^*]*\*/g, ' ')
    .replace(/[_~`#]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Settings → Voice "Read aloud": the whole reply, or only what sits inside ( )/[ ] brackets, or only quoted speech. */
export type TtsReadMode = 'all' | 'brackets' | 'quotes'

export const TTS_READ_MODE_LABELS: Record<TtsReadMode, string> = {
  all: 'All text',
  brackets: 'Only text in (brackets) and [brackets]',
  quotes: 'Only text in "quotes"',
}

// Innermost `( … )` or `[ … ]`, in reading order.
const BRACKET_RE = /\(([^()]*)\)|\[([^[\]]*)\]/g
// "…", “…”, Polish/German „…” (closed by ”, “ or a straight quote), and «…». Never across a line break, so one unbalanced mark can't swallow the rest of the reply.
const QUOTE_RE = /"([^"\n]*)"|“([^”\n]*)”|„([^”“"\n]*)[”“"]|«([^»\n]*)»/g
// The app's own `<<scene:…>>` directive — already stripped from stored text, removed again defensively so it can never be read out.
const META_TAG_RE = /<<[^>]*>>/g
const OOC_RE = /^\s*ooc\s*:/i

/**
 * The part of a reply that should actually be spoken under `mode`. Extracted segments are cleaned
 * like any other speakable text and joined with sentence breaks; an empty string means "say
 * nothing" (no brackets/quotes found), never a fallback to the whole reply.
 */
export function extractReadAloudText(text: string, mode: TtsReadMode): string {
  const source = text.replace(META_TAG_RE, ' ')
  if (mode === 'all') return toSpeakableText(source)
  const re = mode === 'brackets' ? BRACKET_RE : QUOTE_RE
  const segments: string[] = []
  for (const match of source.matchAll(re)) {
    const inner = match.slice(1).find((g) => g !== undefined) ?? ''
    if (OOC_RE.test(inner)) continue
    const spoken = toSpeakableText(inner)
    if (spoken) segments.push(/[.!?…。]["'”»]*$/.test(spoken) ? spoken : `${spoken}.`)
  }
  return segments.join(' ')
}
