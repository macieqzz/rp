/**
 * Pure prompt building and text splicing behind the character editor's AI Studio (a multi-turn
 * refine loop over one card field, with highlight revision of a selected span) and the AI tag
 * suggester. No model calls here — `refineCardField` / `suggestCardTags` in `aiAssist.ts` wrap
 * these with `generateWithTimeout`, which keeps every prompt testable as a plain string.
 */

import type { CharacterCardData } from './cardSpec'
import { PROSE_STYLE_CORE, writerStyleNote } from './proseStyle'
import { findSlop } from '@/lib/text/slop'
import { parseLenientJson } from '@/lib/jsonRepair'

export type StudioField =
  | 'description'
  | 'personality'
  | 'scenario'
  | 'first_mes'
  | 'mes_example'
  | 'creator_notes'
  | 'system_prompt'
  | 'post_history_instructions'

export const STUDIO_FIELDS: StudioField[] = [
  'description',
  'personality',
  'scenario',
  'first_mes',
  'mes_example',
  'creator_notes',
  'system_prompt',
  'post_history_instructions',
]

export const STUDIO_FIELD_LABELS: Record<StudioField, string> = {
  description: 'Description',
  personality: 'Personality',
  scenario: 'Scenario',
  first_mes: 'First message',
  mes_example: 'Example dialogue',
  creator_notes: 'Creator notes',
  system_prompt: 'System prompt',
  post_history_instructions: 'Post-history instructions',
}

/** What a good version of each field is for, so a refine pass has a target and not just a delta. */
const STUDIO_FIELD_GUIDANCE: Record<StudioField, string> = {
  description:
    'The description holds appearance and background: concrete physical details and a history with real events, places, and names, not a sketch of a personality type.',
  personality:
    'The personality says how this character actually behaves: how they talk, what they do when cornered, what they want, what they will not do. Traits with edges and contradictions, matching the voice of their first message and example dialogue.',
  scenario:
    'The scenario is the concrete situation the chat opens in, in the present tense: where {{char}} and {{user}} are, what just happened, why they are together right now. Usually one short paragraph.',
  first_mes:
    "The first message is {{char}}'s opening turn of the roleplay. Wrap physical actions and narration in *single asterisks* and spoken words in \"double quotes\". End on something {{user}} can clearly respond to, and never speak or act for {{user}}.",
  mes_example:
    'Example dialogue is few-shot exchanges that teach the model this voice. Begin each exchange with <START> on its own line, then a "{{user}}:" line, then a "{{char}}:" line in the same *asterisks* / "quotes" convention as the first message.',
  creator_notes:
    'Creator notes are for whoever uses or edits this card next: the intended tone, how to get the best out of it, anything worth knowing. Plain and practical; it is not part of the roleplay prompt.',
  system_prompt:
    'The system prompt is an instruction to the roleplay model, addressed to it directly: how to portray {{char}}, the tone and format to keep, the rules to follow. Imperative and specific, no story prose.',
  post_history_instructions:
    "Post-history instructions are injected right before the model's turn every message. Keep them short, imperative reminders of the style and rules that matter most.",
}

/** Fields that are instructions or meta-notes, not fiction — the anti-slop prose block is noise there. */
const META_FIELDS: Partial<Record<StudioField, true>> = { creator_notes: true, system_prompt: true, post_history_instructions: true }

/** One-click starting instructions per field, shown as chips in the studio. */
export const SUGGESTION_CHIPS: Record<StudioField, string[]> = {
  description: [
    'Add distinctive physical details',
    'Give them a hidden past',
    'Describe them through habits and mannerisms',
    'Write it as a clinical dossier',
    'Make it more concise',
    'Add sensory details: sounds, scents, textures',
  ],
  personality: [
    'Make them sarcastic and witty',
    'Add an internal contradiction',
    'Cold and logical with a hidden soft side',
    'Cheerful but hiding deep insecurities',
    'Show how they act when cornered',
    'Make their speech patterns more distinct',
  ],
  scenario: [
    'Make it a tense first encounter',
    'Set it during a late-night conversation',
    'Something just went wrong',
    'They need {{user}}\'s help',
    'An awkward reunion',
    'Add a shared secret',
  ],
  first_mes: [
    'Open in the middle of the action',
    'Make it a casual slice-of-life greeting',
    'Start with them doing something unexpected',
    'Make it shorter and punchier',
    'End on a clearer hook for {{user}}',
    'More dialogue, less narration',
  ],
  mes_example: [
    'Write three exchanges that show their voice',
    'Show how they react to being teased',
    'Show them under pressure',
    'Make the replies shorter',
    'Add their verbal tics and catchphrases',
  ],
  creator_notes: [
    'Summarize the intended tone and themes',
    'Add tips for getting the best roleplay',
    'Recommend sampler and model settings',
    'Make it shorter',
  ],
  system_prompt: [
    'Write a focused system prompt for this character',
    'Enforce third-person narration',
    'Never speak or act for {{user}}',
    'Keep replies short and dialogue-driven',
  ],
  post_history_instructions: [
    'Remind the model to stay in character',
    'Keep replies under three paragraphs',
    'Reinforce the formatting rules',
    'Make it more concise',
  ],
}

export interface StudioTurn {
  instruction: string
  result: string
}

export interface StudioSelection {
  start: number
  end: number
}

export interface RefinePromptOptions {
  card: CharacterCardData
  field: StudioField
  /** The working text — the latest result, including any hand edits since. */
  current: string
  /** Earlier rounds of this studio session, oldest first. */
  turns: StudioTurn[]
  instruction: string
  /** Soft word target for the whole field (ignored in selection mode, which matches the span's length). */
  wordTarget?: number
  /** Revise only this span of `current`; the model returns just its replacement. */
  selection?: StudioSelection
  /** Write the field from scratch from the rest of the card, ignoring its current text and history. */
  brainstorm?: boolean
  styleGuidance?: string
}

export const SELECTION_START = '[[SELECTION START]]'
export const SELECTION_END = '[[SELECTION END]]'

/** Per-field cap on how much of each other field goes into the context block. */
const CONTEXT_FIELD_CHARS = 1500
/** How many earlier instructions to remind the model of. */
const MAX_TURNS_IN_PROMPT = 8

function clip(text: string, max: number): string {
  const t = text.trim()
  return t.length > max ? `${t.slice(0, max).trimEnd()} …` : t
}

export function wordCount(text: string): number {
  const t = text.trim()
  return t ? t.split(/\s+/).length : 0
}

/** The rest of the card as grounding context, leaving out the field being worked on. */
function cardContext(card: CharacterCardData, omit: StudioField): string {
  const lines = [`Name: ${card.name || '(unnamed)'}`]
  const add = (key: StudioField, value: string | undefined) => {
    if (key !== omit && value?.trim()) lines.push(`${STUDIO_FIELD_LABELS[key]}:\n${clip(value, CONTEXT_FIELD_CHARS)}`)
  }
  if (card.tags?.length) lines.push(`Tags: ${card.tags.join(', ')}`)
  if (card.creator?.trim()) lines.push(`Creator: ${card.creator.trim()}`)
  add('description', card.description)
  add('personality', card.personality)
  add('scenario', card.scenario)
  add('first_mes', card.first_mes)
  add('mes_example', card.mes_example)
  add('creator_notes', card.creator_notes)
  return lines.join('\n\n')
}

/** Clamped and ordered, or `null` for an empty/out-of-range span. */
export function normalizeSelection(text: string, selection: StudioSelection | undefined | null): StudioSelection | null {
  if (!selection) return null
  const start = Math.max(0, Math.min(text.length, Math.min(selection.start, selection.end)))
  const end = Math.max(0, Math.min(text.length, Math.max(selection.start, selection.end)))
  return end > start ? { start, end } : null
}

/**
 * The prompt for one studio round. Three modes:
 * - brainstorm: write the field fresh from the rest of the card only;
 * - selection: show the whole field with the span marked, ask for only that span's replacement;
 * - full field: rewrite the whole field per the instruction, keeping its established facts.
 */
export function buildRefinePrompt(opts: RefinePromptOptions): string {
  const { card, field, instruction } = opts
  const label = STUDIO_FIELD_LABELS[field]
  const lower = label.toLowerCase()
  const current = opts.current
  const selection = opts.brainstorm ? null : normalizeSelection(current, opts.selection)
  const ask = instruction.trim()
  const prose = META_FIELDS[field] ? '' : PROSE_STYLE_CORE
  const style = writerStyleNote(opts.styleGuidance)
  const target = opts.wordTarget && opts.wordTarget > 0 ? Math.round(opts.wordTarget) : 0
  const history = opts.brainstorm
    ? []
    : opts.turns
        .slice(-MAX_TURNS_IN_PROMPT)
        .map((t) => t.instruction.trim())
        .filter(Boolean)

  const parts: string[] = [
    `You are helping a writer craft one field of a character card for a roleplay app: the ${lower}.`,
    `The rest of the character. Stay consistent with all of it:\n${cardContext(card, field)}`,
    STUDIO_FIELD_GUIDANCE[field],
  ]

  if (opts.brainstorm) {
    parts.push(
      `Write the ${lower} from scratch, using only the card details above as your source. Fill the gaps they leave with specific, plausible choices.`,
      ask ? `The writer's direction: ${ask}` : '',
      prose,
      style,
      target ? `Aim for roughly ${target} words. A soft target, not a hard limit.` : '',
      `Output only the ${lower} text. No label, no surrounding quotes, no commentary, no markdown headings.`,
    )
  } else if (selection) {
    const marked = `${current.slice(0, selection.start)}${SELECTION_START}${current.slice(selection.start, selection.end)}${SELECTION_END}${current.slice(selection.end)}`
    parts.push(
      history.length ? `Earlier instructions in this session, already reflected in the text:\n${history.map((h, i) => `${i + 1}. ${h}`).join('\n')}` : '',
      `The full current ${lower}, with the part to revise marked between ${SELECTION_START} and ${SELECTION_END}:\n${marked}`,
      `Revise ONLY the marked part, following this instruction: ${ask || 'improve it'}`,
      'The replacement must read naturally where it sits: match the surrounding tense, voice, and formatting, and keep roughly the same length unless the instruction says otherwise. Do not repeat anything from outside the marked part.',
      prose,
      style,
      `Output only the replacement for the marked part. No markers, no surrounding text, no quotes around it, no commentary.`,
    )
  } else {
    const slop = current.trim()
      ? findSlop(current)
          .slice(0, 5)
          .map((h) => h.label)
      : []
    parts.push(
      history.length ? `Earlier instructions in this session, already reflected in the current text. Keep honoring them unless the new instruction overrides one:\n${history.map((h, i) => `${i + 1}. ${h}`).join('\n')}` : '',
      current.trim()
        ? `Current ${lower}:\n${current.trim()}`
        : `The ${lower} is empty. Write it from scratch, grounded in everything above.`,
      `Instruction: ${ask || `Improve the ${lower}.`}`,
      current.trim()
        ? `Rewrite the whole ${lower} following the instruction. Keep every fact it establishes unless the instruction changes it.`
        : '',
      prose,
      style,
      slop.length ? `The current text leans on these tells. Do not reuse them: ${slop.join('; ')}.` : '',
      target ? `Aim for roughly ${target} words. A soft target, not a hard limit.` : '',
      `Output only the complete new ${lower}. No label, no surrounding quotes, no commentary, no markdown headings.`,
    )
  }

  return parts.filter(Boolean).join('\n\n')
}

/**
 * Generation budget for one round: scales with the word target, the span being revised, or the
 * current text, so a long description isn't cut off and a one-line selection doesn't get 2k tokens.
 */
export function refineMaxLength(opts: Pick<RefinePromptOptions, 'current' | 'wordTarget' | 'selection' | 'brainstorm'>): number {
  const clamp = (n: number) => Math.max(120, Math.min(4096, Math.round(n)))
  const selection = opts.brainstorm ? null : normalizeSelection(opts.current, opts.selection)
  if (selection) return clamp(wordCount(opts.current.slice(selection.start, selection.end)) * 2.5 + 120)
  if (opts.wordTarget && opts.wordTarget > 0) return clamp(opts.wordTarget * 1.6 + 80)
  const words = opts.brainstorm ? 0 : wordCount(opts.current)
  return clamp(Math.max(450, words * 1.8 + 120))
}

/**
 * Replaces `selection` in `text`. The model returns a trimmed replacement, so the original span's
 * leading/trailing whitespace is carried over — otherwise revising "word " eats the space after it.
 */
export function spliceSelection(text: string, selection: StudioSelection, replacement: string): string {
  const sel = normalizeSelection(text, selection)
  if (!sel) {
    const at = Math.max(0, Math.min(text.length, selection.start))
    return text.slice(0, at) + replacement + text.slice(at)
  }
  const original = text.slice(sel.start, sel.end)
  const lead = original.match(/^\s*/)?.[0] ?? ''
  const trail = original.match(/\s*$/)?.[0] ?? ''
  let body = replacement
  if (body.trim()) body = (/^\s/.test(body) ? body : lead + body) + (/\s$/.test(body) ? '' : trail)
  return text.slice(0, sel.start) + body + text.slice(sel.end)
}

const LABEL_WORDS =
  'description|personality|scenario|first message|greeting|example dialogue|example messages|creator notes|system prompt|post-history instructions|replacement|revised selection|selection|revision|revised text|rewritten text|text|result|output|version'

/** A leading "Here is the revised description:" / "Personality:" / "**Revised text:**" line. */
const LEADING_LABEL = new RegExp(
  `^(?:here(?:'s| is| are)\\b[^\\n]*:[ \\t]*(?:\\n|$)|\\**(?:(?:the )?(?:new|revised|rewritten|updated|improved|final) )?(?:${LABEL_WORDS})\\**\\s*:\\**[ \\t]*\\n?)`,
  'i',
)

const QUOTE_PAIRS: [string, string][] = [
  ['"', '"'],
  ["'", "'"],
  ['“', '”'],
  ['‘', '’'],
]

/**
 * Strips the wrapping a model adds around what should be bare field text: a whole-output markdown
 * fence, a leading label line, echoed selection markers, and quotes around the entire output (only
 * when the quote char doesn't also appear inside — a first message often legitimately starts and
 * ends with dialogue).
 */
export function cleanModelOutput(text: string): string {
  let out = text.trim().replace(LEADING_LABEL, '').trim()
  const fence = out.match(/^```[\w-]*[ \t]*\n([\s\S]*?)\n?```$/)
  if (fence) out = fence[1].trim().replace(LEADING_LABEL, '').trim()
  out = out.split(SELECTION_START).join('').split(SELECTION_END).join('').trim()
  for (const [open, close] of QUOTE_PAIRS) {
    if (out.length >= 2 && out.startsWith(open) && out.endsWith(close)) {
      const inner = out.slice(open.length, out.length - close.length)
      if (!inner.includes(open) && !inner.includes(close)) {
        out = inner.trim()
        break
      }
    }
  }
  return out
}

/**
 * `parseLenientJson` for output that may be a bare array as well as an object. Its repair pipeline
 * keys on `{…}`, so a bare array is wrapped in an object first; an unterminated array is left open
 * so the pipeline's truncation repair closes it after the last complete element.
 */
export function parseLooseJson(text: string): unknown {
  const raw = text.trim()
  const bracket = raw.indexOf('[')
  const brace = raw.indexOf('{')
  if (bracket !== -1 && (brace === -1 || bracket < brace)) {
    const end = raw.lastIndexOf(']')
    const wrapped = end > bracket ? `{"items":${raw.slice(bracket, end + 1)}}` : `{"items":${raw.slice(bracket)}`
    const parsed = parseLenientJson(wrapped)
    return parsed && typeof parsed === 'object' && 'items' in parsed ? parsed.items : undefined
  }
  return parseLenientJson(raw)
}

export const MAX_SUGGESTED_TAGS = 12

/** The tag-suggestion prompt; asks for an object envelope so JSON-mode backends can comply. */
export function buildTagPrompt(card: CharacterCardData, existingTags: string[]): string {
  const lines = [`Name: ${card.name || '(unnamed)'}`]
  if (card.description?.trim()) lines.push(`Description: ${clip(card.description, 1200)}`)
  if (card.personality?.trim()) lines.push(`Personality: ${clip(card.personality, 600)}`)
  if (card.scenario?.trim()) lines.push(`Scenario: ${clip(card.scenario, 500)}`)
  if (card.first_mes?.trim()) lines.push(`First message: ${clip(card.first_mes, 500)}`)
  if (card.creator_notes?.trim()) lines.push(`Creator notes: ${clip(card.creator_notes, 400)}`)
  return [
    'You tag character cards in a roleplay character library so they can be filtered and found.',
    `The character:\n${lines.join('\n')}`,
    existingTags.length ? `Tags it already has (do not repeat them): ${existingTags.join(', ')}` : '',
    `Suggest up to ${MAX_SUGGESTED_TAGS} new tags covering genre, setting, the character's role or archetype, personality, and notable themes. Each tag is one to three lowercase words, the kind people actually browse by (e.g. "fantasy", "tsundere", "slow burn", "cyberpunk"). Only tags the card clearly supports.`,
    'Output ONLY a JSON object shaped {"tags": ["tag one", "tag two"]}. No markdown fences, no commentary.',
  ]
    .filter(Boolean)
    .join('\n\n')
}

/** Model output → clean new tags: lowercase, deduped against each other and `existingTags`, capped. */
export function parseTagSuggestions(text: string, existingTags: string[]): string[] {
  const parsed = parseLooseJson(text)
  const list = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === 'object' && 'tags' in parsed && Array.isArray(parsed.tags)
      ? parsed.tags
      : null
  if (!list) throw new Error('Model did not return a list of tags')
  const seen = new Set(existingTags.map((t) => t.trim().toLowerCase()))
  const out: string[] = []
  for (const item of list) {
    if (typeof item !== 'string') continue
    const tag = item.trim().toLowerCase().replace(/^#/, '').replace(/\s+/g, ' ')
    if (!tag || tag.length > 40 || seen.has(tag)) continue
    seen.add(tag)
    out.push(tag)
    if (out.length >= MAX_SUGGESTED_TAGS) break
  }
  return out
}
