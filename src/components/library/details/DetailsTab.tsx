import { useState } from 'react'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import type { Character } from '@/lib/characters/cardSpec'
import { cardTokenCount } from '@/lib/library/search'
import { getProviderLink, PROVIDER_LABELS } from '@/lib/library/links'
import { Section } from '@/components/ui/Section'
import { RichTextFrame } from '../RichTextFrame'
import { LinkedLorebooks } from '../LinkedLorebooks'

function PlainBlock({ label, text }: { label: string; text?: string }) {
  if (!text?.trim()) return null
  return (
    <details className="rounded-xl border border-border bg-bg-elevated">
      <summary className="cursor-pointer px-3 py-2 text-sm font-medium text-text">{label}</summary>
      <p className="whitespace-pre-wrap border-t border-border px-3 py-2 text-sm leading-relaxed text-text-muted">{text}</p>
    </details>
  )
}

/** Read-only overview: rich-rendered description/notes/greetings, metadata and lorebooks. */
export function DetailsTab({
  character,
  names,
  localize,
  onTagClick,
  onCreatorClick,
}: {
  character: Character
  names: { char: string; user: string }
  localize?: Record<string, string>
  onTagClick: (tag: string) => void
  onCreatorClick: (creator: string) => void
}) {
  const card = character.card
  const greetings = [card.first_mes, ...(card.alternate_greetings ?? [])].filter((g) => g?.trim())
  const [greeting, setGreeting] = useState(0)
  const link = getProviderLink(card)
  const current = Math.min(greeting, Math.max(0, greetings.length - 1))

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-text-muted">
        {card.creator && (
          <button type="button" className="hover:text-accent" onClick={() => onCreatorClick(card.creator!)}>
            by <span className="text-text">{card.creator}</span>
          </button>
        )}
        {card.character_version && <span>v{card.character_version}</span>}
        <span>~{cardTokenCount(character).toLocaleString()} tokens</span>
        <span>Created {new Date(character.createdAt).toLocaleDateString()}</span>
        <span>Modified {new Date(character.updatedAt).toLocaleDateString()}</span>
        {link && (
          <a href={link.url} target="_blank" rel="noreferrer" className="text-accent hover:underline">
            {PROVIDER_LABELS[link.provider]}: {link.id}
          </a>
        )}
      </div>

      {(card.tags ?? []).length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {(card.tags ?? []).map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => onTagClick(t)}
              title="Filter the library by this tag"
              className="rounded-lg bg-bg-sunken px-2 py-0.5 text-xs text-text-muted hover:text-accent"
            >
              {t}
            </button>
          ))}
        </div>
      )}

      {card.creator_notes?.trim() && (
        <Section title="Creator's notes" surface="bare">
          <RichTextFrame title="Creator's notes" text={card.creator_notes} names={names} localize={localize} height={300} />
        </Section>
      )}

      <Section title="Description" surface="bare">
        <RichTextFrame title="Description" text={card.description} names={names} localize={localize} height={240} />
      </Section>

      {greetings.length > 0 && (
        <Section
          title={current === 0 ? 'First message' : `Alternate greeting ${current}`}
          surface="bare"
          action={
            greetings.length > 1 ? (
              <div className="flex items-center gap-1 text-xs text-text-muted">
                <button type="button" aria-label="Previous greeting" onClick={() => setGreeting((current - 1 + greetings.length) % greetings.length)} className="rounded p-1 hover:bg-bg-sunken">
                  <ChevronLeft size={14} />
                </button>
                {current + 1} / {greetings.length}
                <button type="button" aria-label="Next greeting" onClick={() => setGreeting((current + 1) % greetings.length)} className="rounded p-1 hover:bg-bg-sunken">
                  <ChevronRight size={14} />
                </button>
              </div>
            ) : undefined
          }
        >
          <RichTextFrame title="Greeting" text={greetings[current]} names={names} localize={localize} height={220} />
        </Section>
      )}

      <div className="space-y-2">
        <PlainBlock label="Personality" text={card.personality} />
        <PlainBlock label="Scenario" text={card.scenario} />
        <PlainBlock label="Example dialogue" text={card.mes_example} />
        <PlainBlock label="System prompt" text={card.system_prompt} />
        <PlainBlock label="Post-history instructions" text={card.post_history_instructions} />
      </div>

      <LinkedLorebooks character={character} />
    </div>
  )
}
