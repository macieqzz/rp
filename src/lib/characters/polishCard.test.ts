import { describe, expect, it, vi } from 'vitest'
import type { ChatBackend } from '@/lib/api/chatBackend'
import type { CharacterCardData } from './cardSpec'

const prompts: string[] = []
vi.mock('@/lib/api/generateWithTimeout', () => ({
  generateWithTimeout: vi.fn(async (_client: unknown, params: { prompt: string }) => {
    prompts.push(params.prompt)
    if (params.prompt.includes('needs a Polish name')) return 'Karolina Nowak\n'
    const text = /<<<TEXT\n([\s\S]*)\nTEXT>>>/.exec(params.prompt)![1]
    return `\`\`\`\nTłumaczenie: PL:${text}\n\`\`\``
  }),
}))

const { cleanOutput, translateCardToPolish } = await import('./polishCard')

const card = {
  name: 'Scarlet Hayes',
  description: 'A barmaid in Chicago.',
  personality: 'Flirty.',
  scenario: '',
  first_mes: '*She smiles.* "Hi, {{user}}."',
  mes_example: '',
  creator_notes: '',
  system_prompt: '',
  post_history_instructions: '',
  alternate_greetings: ['"Back again?"'],
  tags: [],
  creator: '',
  character_version: '',
  extensions: {},
  character_book: { name: 'lore', entries: [{ id: 1, keys: ['bar'], content: 'She owns the bar.', enabled: true, insertion_order: 100 }] },
} as unknown as CharacterCardData

const client = { getEffectiveMaxContext: async () => 32768 } as unknown as ChatBackend

describe('translateCardToPolish', () => {
  it('picks a Polish name first, then translates every text field with it', async () => {
    const out = await translateCardToPolish(client, card)
    expect(out.name).toBe('Karolina Nowak')
    expect(out.description).toBe('PL:A barmaid in Chicago.')
    expect(out.first_mes).toBe('PL:*She smiles.* "Hi, {{user}}."')
    expect(out.alternate_greetings).toEqual(['PL:"Back again?"'])
    expect(out.character_book!.entries[0].content).toBe('PL:She owns the bar.')
    // Empty fields are skipped, and every field call carries the new name.
    const fieldCalls = prompts.filter((p) => p.includes('<<<TEXT'))
    expect(fieldCalls).toHaveLength(5)
    expect(fieldCalls.every((p) => p.includes('"Karolina Nowak" (originally "Scarlet Hayes")'))).toBe(true)
    // The input card is left untouched.
    expect(card.name).toBe('Scarlet Hayes')
  })
})

describe('cleanOutput', () => {
  it('keeps dialogue quotes that open and close the text', () => {
    expect(cleanOutput('„Cześć” — mówi. „Pa”')).toBe('„Cześć” — mówi. „Pa”')
  })
})
