// Plays a few canned lines against the live model as the seeded Sumire and prints the replies.
// Usage: npx tsx scripts/voice-test.mts [koboldUrl]
import { buildPrompt, DEFAULT_SYSTEM_PROMPT, type ChatMessage } from '../src/lib/prompt/builder'
import { getInstructTemplate } from '../src/lib/prompt/instructTemplates'
import { KoboldClient } from '../src/lib/api/kobold'
import { cleanModelOutput } from '../src/lib/text/slop'
import { seedCharacter } from '../server/seedContent.ts'

const client = new KoboldClient(process.argv[2] ?? 'http://localhost:5001')
const template = getInstructTemplate('gemma4')
const card = seedCharacter.card
const countTokens = async (t: string) => (await client.tokenCount(t)).count

const lines = [
  'Hey. Mind if I sit here?',
  'I brought you some melon bread.',
  'You looked pretty angry at that vending machine earlier.',
  'Hey, you did really well in that seminar today.',
  "I'm heading out. See you tomorrow.",
]

for (const line of lines) {
  const history: ChatMessage[] = [
    { id: 'g', role: 'char', name: card.name, text: card.first_mes },
    { id: 'u', role: 'user', name: 'Kai', text: line },
  ]
  const built = await buildPrompt({
    character: card, personaName: 'Kai', personaDescription: 'A second-year who works weekends at a bookshop.',
    history, lorebooks: card.character_book ? [card.character_book] : [], template, contextBudget: 6000, scanDepth: 8,
    countTokens, globalSystemPrompt: DEFAULT_SYSTEM_PROMPT, cacheFriendly: true,
    styleGuidanceItems: [
      { text: 'Put every action and piece of narration in *asterisks* and every line of spoken dialogue in "quotes".', essential: true },
      { text: 'Length: keep this turn to two to four sentences. Lead with what they say or do.', essential: true },
    ],
  })
  const raw = await client.generate({
    prompt: built.prompt, max_length: 220, max_context_length: 8192, temperature: 0.9, top_p: 0.95, top_k: 0, min_p: 0.05,
    rep_pen: 1.05, rep_pen_range: 1024, stop_sequence: [...template.stopSequences, '\nKai:'],
  } as never)
  const text = cleanModelOutput(raw, { charName: card.name, personaName: 'Kai', replaceEmDashes: true })
  console.log(`\nKAI: ${line}\nSUMIRE: ${text}`)
  console.log(`  em dashes in raw: ${(raw.match(/—/g) ?? []).length}`)
}
