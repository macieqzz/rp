import { useMemo, useState } from 'react'
import type { Character } from '@/lib/characters/cardSpec'
import { findRelated, matchStrength, type RelatedOptions } from '@/lib/library/related'
import { displayNameOf } from '@/lib/library/links'
import { Chip } from '@/components/ui/Chip'
import { EmptyState } from '@/components/ui/EmptyState'

const STRENGTH_CLASS = {
  strong: 'bg-success/15 text-success',
  moderate: 'bg-accent/15 text-accent',
  weak: 'bg-bg-sunken text-text-muted',
} as const

/** Characters related by rarity-weighted shared tags, the same creator and shared universe keywords. */
export function RelatedTab({ character, characters, onOpen }: { character: Character; characters: Character[]; onOpen: (id: string) => void }) {
  const [options, setOptions] = useState<RelatedOptions>({ tags: true, creator: true, content: true })
  const byId = useMemo(() => new Map(characters.map((c) => [c.id, c])), [characters])
  const matches = useMemo(() => findRelated(character, characters, options), [character, characters, options])
  const best = matches[0]?.score ?? 0

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center gap-2 text-xs text-text-muted">
        Match on
        {(['tags', 'creator', 'content'] as const).map((k) => (
          <Chip key={k} on={options[k]} onClick={() => setOptions((o) => ({ ...o, [k]: !o[k] }))}>
            {k === 'tags' ? 'Shared tags' : k === 'creator' ? 'Same creator' : 'Content keywords'}
          </Chip>
        ))}
      </div>
      {matches.length === 0 && <EmptyState>No related characters found with these signals.</EmptyState>}
      <div className="grid gap-2 sm:grid-cols-2">
        {matches.map((m) => {
          const c = byId.get(m.id)
          if (!c) return null
          const strength = matchStrength(m.score, best)
          return (
            <button
              key={m.id}
              type="button"
              onClick={() => onOpen(m.id)}
              className="flex gap-3 rounded-xl border border-border bg-bg-elevated p-2.5 text-left transition-colors hover:border-accent/40"
            >
              <div className="h-16 w-12 shrink-0 overflow-hidden rounded-lg bg-bg-sunken">
                {c.avatarDataUrl && <img src={c.avatarDataUrl} alt="" loading="lazy" className="h-full w-full object-cover" />}
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="truncate text-sm font-medium text-text">{displayNameOf(c.card)}</span>
                  <span className={`shrink-0 rounded px-1.5 text-[10px] ${STRENGTH_CLASS[strength]}`}>
                    {strength} · {m.score}
                  </span>
                </div>
                {m.reasons.map((r) => (
                  <p key={r} className="truncate text-xs text-text-muted" title={r}>
                    {r}
                  </p>
                ))}
              </div>
            </button>
          )
        })}
      </div>
    </div>
  )
}
