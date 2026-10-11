import { describe, expect, it } from 'vitest'
import { extractReadAloudText, toSpeakableText } from './speakableText'

describe('toSpeakableText', () => {
  it('strips an action wrapped in asterisks, leaving surrounding dialogue', () => {
    expect(toSpeakableText('*smiles warmly* Hello there.')).toBe('Hello there.')
  })

  it('strips multiple actions and squeezes the remaining gaps to single spaces', () => {
    expect(toSpeakableText('*leans in* I missed you *smiles*')).toBe('I missed you')
  })

  it('removes stray markdown characters without removing their letters', () => {
    expect(toSpeakableText('_hello_ ~world~ `code` #tag')).toBe('hello world code tag')
  })

  it('collapses internal whitespace runs to a single space and trims the ends', () => {
    expect(toSpeakableText('  too   much   space  ')).toBe('too much space')
  })

  it('returns an empty string when the text is only action text', () => {
    expect(toSpeakableText('*just an action*')).toBe('')
  })

  it('leaves an unmatched single asterisk alone, since the pair pattern requires a closing one', () => {
    expect(toSpeakableText('a stray * mark')).toBe('a stray * mark')
  })

  it('returns an empty string for empty input', () => {
    expect(toSpeakableText('')).toBe('')
  })
})

describe('extractReadAloudText', () => {
  it("'all' reads the whole reply through the usual speakable cleanup", () => {
    expect(extractReadAloudText('*smiles* Hello (there).', 'all')).toBe('Hello (there).')
  })

  it("'brackets' reads only ( ) and [ ] segments, in order, joined with sentence breaks", () => {
    const text = '*She waves.* "Hi!" (Good to see you) and then [it is late]. (Really late!)'
    expect(extractReadAloudText(text, 'brackets')).toBe('Good to see you. it is late. Really late!')
  })

  it("'brackets' speaks nothing when the reply has no brackets", () => {
    expect(extractReadAloudText('"Hello," she said. *nods*', 'brackets')).toBe('')
  })

  it("'brackets' strips actions inside a segment and skips segments that end up empty", () => {
    expect(extractReadAloudText('(*sighs*) (*leans in* fine, you win)', 'brackets')).toBe('fine, you win.')
  })

  it("'brackets' never reads OOC asides or the app's scene directive", () => {
    const text = '(Hello.) (OOC: keep it short) <<scene:happy|park>> [Bye.]'
    expect(extractReadAloudText(text, 'brackets')).toBe('Hello. Bye.')
  })

  it("'brackets' takes the innermost pair when brackets nest", () => {
    expect(extractReadAloudText('(outer (inner) tail)', 'brackets')).toBe('inner.')
  })

  it("'quotes' reads straight, curly, Polish and guillemet quotes but not brackets", () => {
    const text = '"Hi." (aside) “How are you?” „Dobrze” «Merci»'
    expect(extractReadAloudText(text, 'quotes')).toBe('Hi. How are you? Dobrze. Merci.')
  })

  it("'quotes' does not let an unbalanced quote swallow later lines", () => {
    expect(extractReadAloudText('She said "wait\nand "go" now', 'quotes')).toBe('go.')
  })
})
