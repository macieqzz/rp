import { describe, expect, it } from 'vitest'
import { buildPrompt, type ChatMessage, type PromptBuildInput } from './builder'
import { getInstructTemplate } from './instructTemplates'
import type { Lorebook } from '@/lib/characters/cardSpec'

const template = getInstructTemplate('plain-chat')

function input(overrides: Partial<PromptBuildInput> = {}): PromptBuildInput {
  return {
    character: { name: 'Aria', description: 'DESC_MARKER', personality: '', scenario: '', first_mes: '', mes_example: 'EXAMPLE_MARKER' },
    personaName: 'You',
    personaDescription: '',
    history: [],
    lorebooks: [],
    template,
    contextBudget: 4000,
    scanDepth: 8,
    countTokens: async (text: string) => Math.ceil(text.length / 4),
    ...overrides,
  }
}

const turns = (n: number): ChatMessage[] =>
  Array.from({ length: n }, (_, i) => ({
    id: `m${i}`,
    role: i % 2 === 0 ? ('user' as const) : ('char' as const),
    name: i % 2 === 0 ? 'You' : 'Aria',
    text: `turn ${i} ${'word '.repeat(40)}`,
  }))

const commonPrefix = (a: string, b: string) => {
  let i = 0
  while (i < a.length && i < b.length && a[i] === b[i]) i++
  return i
}

describe('cacheFriendly layout', () => {
  it('moves the summary to the end of the fixed block, after the description and examples', async () => {
    const r = await buildPrompt(input({ cacheFriendly: true, chatSummary: 'SUMMARY_MARKER', history: turns(2) }))
    const p = r.prompt
    expect(p.indexOf('SUMMARY_MARKER')).toBeGreaterThan(p.indexOf('EXAMPLE_MARKER'))
    expect(p.indexOf('SUMMARY_MARKER')).toBeLessThan(p.indexOf('turn 0'))
  })

  it('keeps the summary right after the system prompt when not cache-friendly', async () => {
    const r = await buildPrompt(input({ chatSummary: 'SUMMARY_MARKER', history: turns(2) }))
    expect(r.prompt.indexOf('SUMMARY_MARKER')).toBeLessThan(r.prompt.indexOf('DESC_MARKER'))
  })

  it('puts keyword and fact lore after the history but leaves constant lore in the prefix', async () => {
    const lore: Lorebook = {
      name: 'book',
      entries: [
        { id: 1, keys: [], content: 'CONSTANT_LORE', constant: true, selective: false, insertion_order: 1, enabled: true, activationMode: 'always' },
        { id: 2, keys: ['turn'], content: 'KEYWORD_LORE', constant: false, selective: false, insertion_order: 2, enabled: true },
        { id: 3, keys: [], content: 'FACT_LORE', constant: true, volatile: true, selective: false, insertion_order: 3, enabled: true, activationMode: 'always' },
      ],
    }
    const r = await buildPrompt(input({ cacheFriendly: true, lorebooks: [lore], history: turns(2) }))
    const p = r.prompt
    const historyAt = p.indexOf('turn 0')
    expect(p.indexOf('CONSTANT_LORE')).toBeLessThan(historyAt)
    expect(p.indexOf('KEYWORD_LORE')).toBeGreaterThan(p.indexOf('turn 1'))
    expect(p.indexOf('FACT_LORE')).toBeGreaterThan(p.indexOf('turn 1'))
    expect(r.activatedEntries).toHaveLength(3)
  })

  it('leaves lore where it always was when not cache-friendly', async () => {
    const lore: Lorebook = {
      name: 'book',
      entries: [{ id: 2, keys: ['turn'], content: 'KEYWORD_LORE', constant: false, selective: false, insertion_order: 2, enabled: true }],
    }
    const r = await buildPrompt(input({ lorebooks: [lore], history: turns(2) }))
    expect(r.prompt.indexOf('KEYWORD_LORE')).toBeLessThan(r.prompt.indexOf('turn 0'))
  })

  it('a changing keyword hit no longer disturbs the prefix before the history', async () => {
    const lore: Lorebook = {
      name: 'book',
      entries: [{ id: 2, keys: ['dragon'], content: 'KEYWORD_LORE', constant: false, selective: false, insertion_order: 2, enabled: true }],
    }
    const base = turns(6)
    const quiet = await buildPrompt(input({ cacheFriendly: true, lorebooks: [lore], history: base }))
    const hit = await buildPrompt(
      input({ cacheFriendly: true, lorebooks: [lore], history: [...base.slice(0, 5), { ...base[5], text: `${base[5].text} dragon` }] }),
    )
    // Identical up to (nearly) the last turn: only the edited turn and what follows may differ.
    expect(commonPrefix(quiet.prompt, hit.prompt)).toBeGreaterThan(quiet.prompt.indexOf('turn 5'))
  })
})

describe('historyTrimGrid', () => {
  // Budget sized so only part of a long history fits.
  const windowStarts = async (grid: number, cacheFriendly: boolean) => {
    const starts: number[] = []
    const prompts: string[] = []
    for (let n = 40; n <= 64; n += 2) {
      const r = await buildPrompt(input({ contextBudget: 1400, history: turns(n), historyTrimGrid: grid, cacheFriendly }))
      starts.push(r.excludedMessageCount)
      prompts.push(r.prompt)
    }
    return { starts, prompts }
  }

  it('slides one exchange at a time without a grid', async () => {
    const { starts } = await windowStarts(1, false)
    expect(new Set(starts).size).toBeGreaterThan(8)
  })

  it('holds the window start still between grid steps', async () => {
    const { starts } = await windowStarts(8, false)
    expect(new Set(starts).size).toBeLessThanOrEqual(5)
    for (const s of starts) expect(s % 8).toBe(0)
  })

  it('keeps most of the prompt prefix-stable across consecutive turns', async () => {
    const reuse = (prompts: string[]) => {
      let shared = 0
      let total = 0
      for (let i = 1; i < prompts.length; i++) {
        shared += commonPrefix(prompts[i - 1], prompts[i])
        total += prompts[i].length
      }
      return shared / total
    }
    const sliding = reuse((await windowStarts(1, false)).prompts)
    const gridded = reuse((await windowStarts(8, false)).prompts)
    expect(gridded).toBeGreaterThan(sliding + 0.3)
  })

  it('never trims away the latest turn, however coarse the grid', async () => {
    const r = await buildPrompt(input({ contextBudget: 1400, history: turns(60), historyTrimGrid: 500 }))
    expect(r.includedMessageCount).toBeGreaterThanOrEqual(1)
    expect(r.prompt).toContain('turn 59')
  })
})

describe('history capacity reporting', () => {
  it('reports the budget history was allowed and what it used', async () => {
    const r = await buildPrompt(input({ history: turns(4) }))
    expect(r.historyCapacity).toBeGreaterThan(r.historyTokens)
    expect(r.historyTokens).toBeGreaterThan(0)
  })
})

describe('Gemma 4 template', () => {
  it('opens the reply after an empty thought channel but keeps finished turns clean', async () => {
    const r = await buildPrompt(input({ template: getInstructTemplate('gemma4'), history: turns(3) }))
    expect(r.prompt.trimEnd().endsWith('<|turn>model\n<|channel>thought\n<channel|>Aria:')).toBe(true)
    // The earlier model turn carries no thought-channel marker, as in Gemma 4's own template.
    expect(r.prompt).toContain('<|turn>model\nAria: turn 1')
    expect(r.prompt.match(/<\|channel>/g)).toHaveLength(1)
    expect(r.prompt).toContain('<|turn>system\n')
  })
})

describe('generation cue', () => {
  it('ends on the speaker colon with no trailing space', async () => {
    const r = await buildPrompt(input({ history: turns(2) }))
    expect(r.prompt.endsWith('Aria:')).toBe(true)
  })

  it('keeps the existing text of a continued turn exactly as it is', async () => {
    const history = turns(2)
    history[1] = { ...history[1], text: 'half a sentence ' }
    const r = await buildPrompt(input({ history, continueLastTurn: true }))
    expect(r.prompt.endsWith('Aria: half a sentence ')).toBe(true)
  })
})
