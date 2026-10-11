import type { ChatBackend } from '@/lib/api/chatBackend'
import { generateWithTimeout } from '@/lib/api/generateWithTimeout'
import type { CharacterCardData } from './cardSpec'

/**
 * The Generate dialog's "Przetłumacz [PL]" for a card read from a file: translates it into Polish
 * and moves it into Polish everyday life. One short call picks the Polish name, then every text
 * field is translated with that name in hand so all of them agree.
 */

/** Folded into the writing-style notes when [PL] is on for brief/traits/portrait generation. */
export const POLISH_STYLE_NOTE =
  'Write the whole character in natural, fluent Polish and set them in present-day Polish life: a Polish name, Polish towns and places, złoty, Polish schools, food and holidays.'

/** Long card fields can take a while; the default assist timeout is sized for short calls. */
const FIELD_TIMEOUT_MS = 180_000

const FIELDS: { key: keyof CharacterCardData; label: string }[] = [
  { key: 'description', label: 'description' },
  { key: 'personality', label: 'personality' },
  { key: 'scenario', label: 'scenario' },
  { key: 'first_mes', label: 'first message' },
  { key: 'mes_example', label: 'example dialogue' },
  { key: 'creator_notes', label: "creator's notes" },
]

export function namePrompt(card: CharacterCardData): string {
  return [
    'A roleplay character is being moved into present-day Polish life, and needs a Polish name.',
    `Their name is "${card.name}". Description: ${card.description.slice(0, 1500)}`,
    `First check: is this a character from an existing franchise (a game, anime, manga, film, series or book), or a non-human / fantasy / sci-fi being? If so, reply with exactly "${card.name}" and nothing else.`,
    'Otherwise give them a real, common Polish name as Polish people use today (a Polish first name, plus a Polish surname if the original has a surname), e.g. "Karolina Wiśniewska" or "Kuba Nowak", fitting their age and personality. Do not translate the meaning of the original name.',
    'Reply with the name only.',
  ].join('\n\n')
}

export function fieldPrompt(label: string, text: string, oldName: string, newName: string): string {
  return [
    `Your task: translate the text between the markers (the ${label} of a roleplay character card) into natural, fluent Polish, moving it into present-day Polish life. Every word must end up in Polish, even a short list of adjectives.`,
    newName !== oldName ? `The character is now called "${newName}" (originally "${oldName}"); use the new name everywhere.` : '',
    'Replace foreign places, schools, currency, food, holidays and brands with fitting Polish equivalents, consistently. Keep the scene and the character otherwise unchanged.',
    'Keep {{char}}, {{user}} and <START> exactly as written, keep line breaks and *asterisks*, use Polish „quotation marks” for dialogue, and match the original\'s tone and voice. Do not add, remove, summarize or soften anything.',
    'Output only the Polish translation.',
    `<<<TEXT\n${text}\nTEXT>>>`,
  ]
    .filter(Boolean)
    .join('\n\n')
}

/** Drops a code fence or a lead-in label a model sometimes wraps its answer in. */
export function cleanOutput(raw: string): string {
  let t = raw.trim()
  const fence = /^```[a-z]*\n([\s\S]*?)\n```$/i.exec(t)
  if (fence) t = fence[1].trim()
  return t.replace(/^(?:tłumaczenie|translation)\s*:\s*/i, '')
}

export async function translateCardToPolish(
  client: ChatBackend,
  card: CharacterCardData,
  opts: { signal?: AbortSignal; onProgress?: (label: string) => void } = {},
): Promise<CharacterCardData> {
  const out: CharacterCardData = structuredClone(card)
  const maxContext = await client.getEffectiveMaxContext()
  const ask = (prompt: string, text: string) =>
    generateWithTimeout(
      client,
      { prompt, max_length: Math.min(8192, Math.ceil(text.length / 2.5) + 300), max_context_length: maxContext, temperature: 0.4, top_p: 0.95 },
      'Translate card',
      opts.signal,
      undefined,
      FIELD_TIMEOUT_MS,
    )

  opts.onProgress?.('name')
  const name = cleanOutput(await ask(namePrompt(card), card.name)).split('\n')[0].trim()
  if (name && name.length <= 80) out.name = name

  const translate = async (label: string, text: string) => {
    opts.onProgress?.(label)
    return cleanOutput(await ask(fieldPrompt(label, text, card.name, out.name), text)) || text
  }
  for (const { key, label } of FIELDS) {
    const text = out[key]
    if (typeof text === 'string' && text.trim()) (out[key] as string) = await translate(label, text)
  }
  const greetings = out.alternate_greetings ?? []
  for (let i = 0; i < greetings.length; i++) if (greetings[i].trim()) greetings[i] = await translate('alternate greeting', greetings[i])
  for (const entry of out.character_book?.entries ?? []) if (entry.content?.trim()) entry.content = await translate('lorebook entry', entry.content)
  return out
}
