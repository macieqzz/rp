import { describe, expect, it } from 'vitest'
import {
  SELECTION_END,
  SELECTION_START,
  STUDIO_FIELDS,
  SUGGESTION_CHIPS,
  buildRefinePrompt,
  buildTagPrompt,
  cleanModelOutput,
  normalizeSelection,
  parseLooseJson,
  parseTagSuggestions,
  refineMaxLength,
  spliceSelection,
} from './aiStudio'
import type { CharacterCardData } from './cardSpec'

const CARD: CharacterCardData = {
  name: 'Mira',
  description: 'A tall scientist with ink-stained fingers.',
  personality: 'Blunt. Hates small talk.',
  scenario: 'A lab at midnight.',
  first_mes: '*Mira looks up.* "You again."',
  mes_example: '',
  tags: ['sci-fi', 'scientist'],
  creator: 'anon',
}

describe('spliceSelection', () => {
  it('replaces only the selected span', () => {
    expect(spliceSelection('The quick brown fox', { start: 4, end: 9 }, 'slow')).toBe('The slow brown fox')
  })

  it('keeps the whitespace bordering the original span', () => {
    // "quick " selected with its trailing space; the model returns a trimmed word.
    expect(spliceSelection('The quick brown fox', { start: 4, end: 10 }, 'slow')).toBe('The slow brown fox')
    expect(spliceSelection('a\n\nmiddle\n\nz', { start: 1, end: 10 }, 'MID')).toBe('a\n\nMID\n\nz')
  })

  it('accepts a reversed or out-of-range span', () => {
    expect(spliceSelection('abcdef', { start: 4, end: 2 }, 'X')).toBe('abXef')
    expect(spliceSelection('abcdef', { start: 3, end: 99 }, 'X')).toBe('abcX')
  })

  it('inserts at the caret for an empty span and deletes for an empty replacement', () => {
    expect(spliceSelection('abc', { start: 1, end: 1 }, 'X')).toBe('aXbc')
    expect(spliceSelection('abc', { start: 1, end: 2 }, '')).toBe('ac')
  })
})

describe('normalizeSelection', () => {
  it('clamps, orders, and rejects empty spans', () => {
    expect(normalizeSelection('hello', { start: 4, end: 1 })).toEqual({ start: 1, end: 4 })
    expect(normalizeSelection('hello', { start: 2, end: 2 })).toBeNull()
    expect(normalizeSelection('hello', undefined)).toBeNull()
  })
})

describe('buildRefinePrompt', () => {
  it('full-field mode shows the current text, the instruction, and earlier instructions', () => {
    const prompt = buildRefinePrompt({
      card: CARD,
      field: 'description',
      current: 'A tall scientist with ink-stained fingers.',
      turns: [{ instruction: 'make her older', result: 'An older scientist.' }],
      instruction: 'add a scar',
      wordTarget: 150,
      styleGuidance: 'Second person only.',
    })
    expect(prompt).toContain('Current description:\nA tall scientist with ink-stained fingers.')
    expect(prompt).toContain('Instruction: add a scar')
    expect(prompt).toContain('1. make her older')
    expect(prompt).toContain('roughly 150 words')
    expect(prompt).toContain('Second person only.')
    expect(prompt).toContain('Keep every fact')
    expect(prompt).not.toContain(SELECTION_START)
    // The worked-on field is left out of the context block; other fields are in.
    expect(prompt).toContain('Personality:\nBlunt. Hates small talk.')
    expect(prompt).not.toContain('Description:\nA tall scientist')
  })

  it('selection mode marks the span and asks only for its replacement', () => {
    const current = 'She is tall. She is very mysterious. She likes tea.'
    const start = current.indexOf('She is very')
    const end = start + 'She is very mysterious.'.length
    const prompt = buildRefinePrompt({
      card: CARD,
      field: 'description',
      current,
      turns: [],
      instruction: 'be specific',
      wordTarget: 400,
      selection: { start, end },
    })
    expect(prompt).toContain(`She is tall. ${SELECTION_START}She is very mysterious.${SELECTION_END} She likes tea.`)
    expect(prompt).toContain('Revise ONLY the marked part, following this instruction: be specific')
    expect(prompt).toContain('Output only the replacement')
    expect(prompt).not.toContain('roughly 400 words')
  })

  it('brainstorm mode ignores the current text and history', () => {
    const prompt = buildRefinePrompt({
      card: CARD,
      field: 'personality',
      current: 'OLD PERSONALITY TEXT',
      turns: [{ instruction: 'OLD INSTRUCTION', result: 'x' }],
      instruction: 'make it fun',
      brainstorm: true,
      selection: { start: 0, end: 3 },
    })
    expect(prompt).toContain('from scratch')
    expect(prompt).toContain("The writer's direction: make it fun")
    expect(prompt).not.toContain('OLD INSTRUCTION')
    expect(prompt).not.toContain(SELECTION_START)
    expect(prompt).toContain('Tags: sci-fi, scientist')
  })

  it('leaves the anti-slop prose block out of instruction fields', () => {
    const base = { card: CARD, current: '', turns: [], instruction: 'tighten' }
    expect(buildRefinePrompt({ ...base, field: 'system_prompt' })).not.toContain('Write like a person')
    expect(buildRefinePrompt({ ...base, field: 'first_mes' })).toContain('Write like a person')
  })

  it('has suggestion chips for every field', () => {
    for (const field of STUDIO_FIELDS) expect(SUGGESTION_CHIPS[field].length).toBeGreaterThan(0)
  })
})

describe('refineMaxLength', () => {
  it('scales with the word target, the selection, or the current text', () => {
    expect(refineMaxLength({ current: '', wordTarget: 1000 })).toBe(1680)
    expect(refineMaxLength({ current: 'one two three four', selection: { start: 0, end: 7 } })).toBe(125)
    expect(refineMaxLength({ current: '' })).toBe(450)
    expect(refineMaxLength({ current: 'word '.repeat(5000) })).toBe(4096)
  })
})

describe('cleanModelOutput', () => {
  it('strips fences, labels, markers, and wrapping quotes', () => {
    expect(cleanModelOutput('```\nShe is tall.\n```')).toBe('She is tall.')
    expect(cleanModelOutput('Here is the revised description:\nShe is tall.')).toBe('She is tall.')
    expect(cleanModelOutput('**Revised description:** She is tall.')).toBe('She is tall.')
    expect(cleanModelOutput('Personality: Blunt.')).toBe('Blunt.')
    expect(cleanModelOutput(`${SELECTION_START}new bit${SELECTION_END}`)).toBe('new bit')
    expect(cleanModelOutput('"She is tall."')).toBe('She is tall.')
    expect(cleanModelOutput('Here is the text:\n```markdown\nShe is tall.\n```')).toBe('She is tall.')
  })

  it('keeps dialogue quotes that are part of the text', () => {
    expect(cleanModelOutput('"Hi," she said. "Bye."')).toBe('"Hi," she said. "Bye."')
    expect(cleanModelOutput('{{user}}: hello\n{{char}}: hi')).toBe('{{user}}: hello\n{{char}}: hi')
  })
})

describe('tag suggestions', () => {
  it('builds a prompt with the existing tags', () => {
    const prompt = buildTagPrompt(CARD, ['sci-fi'])
    expect(prompt).toContain('do not repeat them): sci-fi')
    expect(prompt).toContain('{"tags"')
  })

  it('parses an object or bare array, lowercases, dedupes, and caps', () => {
    expect(parseTagSuggestions('{"tags": ["Fantasy", "fantasy", "SCI-FI", " slow  burn ", 3]}', ['sci-fi'])).toEqual([
      'fantasy',
      'slow burn',
    ])
    expect(parseTagSuggestions('Sure!\n```json\n["a","b"]\n```', [])).toEqual(['a', 'b'])
    const many = JSON.stringify({ tags: Array.from({ length: 20 }, (_, i) => `t${i}`) })
    expect(parseTagSuggestions(many, [])).toHaveLength(12)
  })

  it('throws when there is no list', () => {
    expect(() => parseTagSuggestions('{"nope": 1}', [])).toThrow()
  })
})

describe('parseLooseJson', () => {
  it('recovers a truncated bare array up to the last complete element', () => {
    expect(parseLooseJson('[{"index": 1, "reason": "a"}, {"index": 2, "rea')).toEqual([{ index: 1, reason: 'a' }])
  })
})
