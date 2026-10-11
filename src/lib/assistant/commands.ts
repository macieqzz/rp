/**
 * Slash commands typed into the Assistant's composer: a direct way to run the character / story
 * producers, or to save a card the model wrote as plain JSON, without relying on the offer chip's
 * phrase detection. Polish and English spellings both work.
 */

export type AssistantCommand =
  | { kind: 'character' | 'story'; brief: string }
  | { kind: 'save' }
  | { kind: 'help' }

const ALIASES: Record<string, AssistantCommand['kind']> = {
  postać: 'character',
  postac: 'character',
  character: 'character',
  opowiadanie: 'story',
  story: 'story',
  zapisz: 'save',
  save: 'save',
  pomoc: 'help',
  help: 'help',
}

/** Shown under the composer while a command is being typed, and by `/pomoc`. */
export const ASSISTANT_COMMAND_HELP = [
  '/postać <opis>: buduje pełną postać z opisu i proponuje zapis do biblioteki',
  '/opowiadanie <opis>: planuje i pisze opowiadanie w rozdziałach',
  '/zapisz: zapisuje do postaci ostatnią kartę w JSON z tej rozmowy',
  '/pomoc: ta lista',
]

/** The command in `text`, or `undefined` when it isn't one (ordinary messages, unknown commands). */
export function parseAssistantCommand(text: string): AssistantCommand | undefined {
  const match = /^\/(\S+)\s*([\s\S]*)$/u.exec(text.trim())
  if (!match) return undefined
  const kind = ALIASES[match[1].toLowerCase()]
  const rest = match[2].trim()
  if (kind === 'character' || kind === 'story') return rest ? { kind, brief: rest } : { kind: 'help' }
  if (kind) return { kind }
  return undefined
}

/**
 * The first complete JSON object in a message, fenced or bare, or `undefined`. A reply cut off
 * mid-card has no closing brace that balances, so it yields nothing rather than half a card.
 */
export function extractJsonObject(text: string): unknown {
  const start = text.indexOf('{')
  if (start < 0) return undefined
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = start; i < text.length; i++) {
    const c = text[i]
    if (inString) {
      if (escaped) escaped = false
      else if (c === '\\') escaped = true
      else if (c === '"') inString = false
      continue
    }
    if (c === '"') inString = true
    else if (c === '{') depth++
    else if (c === '}' && --depth === 0) {
      try {
        return JSON.parse(text.slice(start, i + 1))
      } catch {
        return undefined
      }
    }
  }
  return undefined
}

/** Whether a parsed object looks like a character card (V1 flat, or V2/V3 with `data`). */
export function looksLikeCard(raw: unknown): boolean {
  if (!raw || typeof raw !== 'object') return false
  const obj = raw as Record<string, unknown>
  const source = (obj.data && typeof obj.data === 'object' ? obj.data : obj) as Record<string, unknown>
  return typeof source.name === 'string' && (typeof source.description === 'string' || typeof source.first_mes === 'string')
}
