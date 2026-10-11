import { describe, expect, it } from 'vitest'
import { extractJsonObject, looksLikeCard, parseAssistantCommand } from './commands'

describe('parseAssistantCommand', () => {
  it('reads Polish and English spellings, with the brief after the command', () => {
    expect(parseAssistantCommand('/postać barmanka z klubu jazzowego')).toEqual({ kind: 'character', brief: 'barmanka z klubu jazzowego' })
    expect(parseAssistantCommand('/postac elfka')).toEqual({ kind: 'character', brief: 'elfka' })
    expect(parseAssistantCommand('/story a heist in Kraków')).toEqual({ kind: 'story', brief: 'a heist in Kraków' })
    expect(parseAssistantCommand('/Zapisz')).toEqual({ kind: 'save' })
    expect(parseAssistantCommand('/pomoc')).toEqual({ kind: 'help' })
  })

  it('treats a producer command with no brief as a request for help', () => {
    expect(parseAssistantCommand('/postać')).toEqual({ kind: 'help' })
  })

  it('leaves ordinary messages and unknown commands alone', () => {
    expect(parseAssistantCommand('zrób postać')).toBeUndefined()
    expect(parseAssistantCommand('/nieznana coś')).toBeUndefined()
  })
})

describe('extractJsonObject', () => {
  it('finds a fenced card, braces inside strings included', () => {
    const text = 'Oto karta:\n```json\n{"spec":"chara_card_v2","data":{"name":"Vi","description":"Lubi znak } w tekście"}}\n```'
    expect(extractJsonObject(text)).toEqual({ spec: 'chara_card_v2', data: { name: 'Vi', description: 'Lubi znak } w tekście' } })
  })

  it('yields nothing for a card cut off mid-way', () => {
    expect(extractJsonObject('{"spec":"chara_card_v2","data":{"name":"Vi","description":"Za')).toBeUndefined()
  })
})

describe('looksLikeCard', () => {
  it('accepts V2 and flat cards, rejects other objects', () => {
    expect(looksLikeCard({ data: { name: 'Vi', description: 'x' } })).toBe(true)
    expect(looksLikeCard({ name: 'Vi', first_mes: 'Hej' })).toBe(true)
    expect(looksLikeCard({ title: 'nie karta' })).toBe(false)
  })
})
