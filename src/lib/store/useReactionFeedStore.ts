// Short-lived per-turn feedback chips ("Trust +1") shown over the chat after the relationship check.
import { create } from 'zustand'

export interface Reaction {
  id: string
  chatId: string
  /** Non-zero relationship deltas, keyed by dimension. */
  deltas: Record<string, number>
  reason?: string
}

interface ReactionFeedState {
  items: Reaction[]
  push: (r: Omit<Reaction, 'id'>) => void
  dismiss: (id: string) => void
}

let counter = 0
const MAX_ITEMS = 3

export const useReactionFeedStore = create<ReactionFeedState>((set) => ({
  items: [],
  push: (r) => set((s) => ({ items: [...s.items, { ...r, id: `reaction-${Date.now()}-${counter++}` }].slice(-MAX_ITEMS) })),
  dismiss: (id) => set((s) => ({ items: s.items.filter((i) => i.id !== id) })),
}))

export function pushReaction(r: Omit<Reaction, 'id'>): void {
  if (Object.values(r.deltas).every((d) => !d)) return
  useReactionFeedStore.getState().push(r)
}
