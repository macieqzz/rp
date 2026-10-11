import { describe, expect, it } from 'vitest'
import { assistantReplyBudget } from './useAssistant'

describe('assistantReplyBudget', () => {
  it('keeps the old 900-token floor for a small local context', () => {
    expect(assistantReplyBudget(2048)).toBe(900)
  })

  it('scales with the context in between', () => {
    expect(assistantReplyBudget(16384)).toBe(4096)
  })

  it('caps at 8192 for a huge hosted context, enough for a full character card', () => {
    expect(assistantReplyBudget(1_048_576)).toBe(8192)
  })
})
