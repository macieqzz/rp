import { describe, expect, it } from 'vitest'
import { assistantModelFor } from './useChatBackendClient'

describe('assistantModelFor', () => {
  it('uses the assistant model on a hosted OpenAI-compatible backend', () => {
    expect(assistantModelFor('openai-compatible', 'anthropic/claude-sonnet-5.5', 'deepseek/deepseek-v4-flash')).toBe('anthropic/claude-sonnet-5.5')
  })

  it('falls back to the chat model when no assistant model is set', () => {
    expect(assistantModelFor('openai-compatible', '  ', 'deepseek/deepseek-v4-flash')).toBe('deepseek/deepseek-v4-flash')
  })

  it('ignores the assistant model on backends without a free model choice', () => {
    expect(assistantModelFor('koboldcpp', 'anthropic/claude-sonnet-5.5', '')).toBe('')
    expect(assistantModelFor('novelai', 'anthropic/claude-sonnet-5.5', 'kayra-v1')).toBe('kayra-v1')
  })
})
