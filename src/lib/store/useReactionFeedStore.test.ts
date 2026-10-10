import { beforeEach, describe, expect, it } from 'vitest'
import { pushReaction, useReactionFeedStore } from './useReactionFeedStore'

describe('reaction feed', () => {
  beforeEach(() => useReactionFeedStore.setState({ items: [] }))

  it('ignores a turn where nothing moved', () => {
    pushReaction({ chatId: 'c', deltas: { trust: 0, affection: 0 } })
    expect(useReactionFeedStore.getState().items).toHaveLength(0)
  })

  it('keeps only the most recent few and can dismiss one', () => {
    for (let i = 1; i <= 5; i++) pushReaction({ chatId: 'c', deltas: { trust: i }, reason: `r${i}` })
    const items = useReactionFeedStore.getState().items
    expect(items.map((r) => r.reason)).toEqual(['r3', 'r4', 'r5'])
    useReactionFeedStore.getState().dismiss(items[0].id)
    expect(useReactionFeedStore.getState().items).toHaveLength(2)
  })
})
