import { useState } from 'react'
import { BookOpen, ChevronDown, ChevronRight, Download, Link2, Unlink } from 'lucide-react'
import { charactersApi, worldInfoBooksApi } from '@/lib/api/client'
import { useApiQuery } from '@/lib/hooks/useApiQuery'
import type { Character } from '@/lib/characters/cardSpec'
import type { WorldInfoBook } from '@/lib/types'
import { displayNameOf } from '@/lib/library/links'
import { isGlobalBook } from '@/lib/worldinfo/scope'
import { downloadWorldFile } from '@/lib/worldinfo/stWorld'
import { Button } from '@/components/ui/Button'
import { Section } from '@/components/ui/Section'
import { confirmDialog } from '@/lib/store/useConfirmStore'
import { errorMessage, toastError, toastSuccess } from '@/lib/store/useToastStore'

/**
 * Copies a character's embedded lorebook into a standalone World Info book bound to that character,
 * then offers to drop the embedded copy — with both in place every entry would be injected twice in
 * that character's chats. Shared by the details modal and the World Info view's "Import from character".
 */
export async function copyEmbeddedLorebook(character: Character): Promise<WorldInfoBook | undefined> {
  const embedded = character.card.character_book
  if (!embedded || embedded.entries.length === 0) return undefined
  const charName = displayNameOf(character.card)
  const name = embedded.name?.trim() || `${charName} lore`
  try {
    const created = await worldInfoBooksApi.create({
      name,
      // `sourceKey` is assigned per-source at prompt time; a stale `char:` key would share sticky state.
      book: { ...embedded, name, sourceKey: undefined },
      boundChatIds: [],
      boundCharacterIds: [character.id],
      boundWorldIds: [],
    })
    const removeEmbedded = await confirmDialog({
      title: 'Remove the embedded copy?',
      body: `"${name}" is now a World Info book linked to ${charName}. The card still embeds the same entries, so both copies would apply in ${charName}'s chats. Remove the embedded copy to avoid duplicate lore?`,
      confirmLabel: 'Remove embedded copy',
      cancelLabel: 'Keep both',
      tone: 'default',
    })
    if (removeEmbedded) {
      await charactersApi.update(character.id, { card: { ...character.card, character_book: undefined } })
    }
    toastSuccess(`Copied ${embedded.entries.length} entries to World Info as "${name}".`)
    return created
  } catch (e) {
    toastError(`Couldn't copy the lorebook: ${errorMessage(e)}`)
    return undefined
  }
}

/** The details modal's lorebook box: the card's embedded lorebook plus World Info books linked to it. */
export function LinkedLorebooks({ character }: { character: Character }) {
  const books = useApiQuery('world-info-books', () => worldInfoBooksApi.list(), []) ?? []
  const [expanded, setExpanded] = useState(false)
  const [busy, setBusy] = useState(false)
  const embedded = character.card.character_book
  const entries = embedded?.entries ?? []
  const charName = displayNameOf(character.card)
  const linked = books.filter((b) => b.boundCharacterIds?.includes(character.id))
  const linkable = books.filter((b) => !b.boundCharacterIds?.includes(character.id))

  const copyToWorldInfo = async () => {
    setBusy(true)
    try {
      await copyEmbeddedLorebook(character)
    } finally {
      setBusy(false)
    }
  }

  const unlink = async (book: WorldInfoBook) => {
    const boundCharacterIds = (book.boundCharacterIds ?? []).filter((id) => id !== character.id)
    if (isGlobalBook({ ...book, boundCharacterIds })) {
      const ok = await confirmDialog({
        title: `Unlink "${book.name || 'Untitled'}"?`,
        body: `${charName} is the only scope on this book. With no scope left it becomes global and applies to every chat. Scope it to something else in World Info, or delete it there, if that's not what you want.`,
        confirmLabel: 'Unlink, make global',
        tone: 'default',
      })
      if (!ok) return
    }
    try {
      await worldInfoBooksApi.update(book.id, { boundCharacterIds })
    } catch (e) {
      toastError(`Couldn't unlink: ${errorMessage(e)}`)
    }
  }

  const link = async (bookId: string) => {
    const book = books.find((b) => b.id === bookId)
    if (!book) return
    // Any binding narrows a global book, so linking one silently pulls it out of every other chat.
    if (isGlobalBook(book)) {
      const ok = await confirmDialog({
        title: `Link "${book.name || 'Untitled'}" to ${charName}?`,
        body: `This book is global right now and applies to every chat. Linking it scopes it, so it will only apply to ${charName}'s chats (plus any other scope you add in World Info).`,
        confirmLabel: 'Link and scope',
        tone: 'default',
      })
      if (!ok) return
    }
    try {
      await worldInfoBooksApi.update(book.id, { boundCharacterIds: [...(book.boundCharacterIds ?? []), character.id] })
    } catch (e) {
      toastError(`Couldn't link: ${errorMessage(e)}`)
    }
  }

  return (
    <div className="space-y-4">
      <Section
        title="Embedded lorebook"
        icon={BookOpen}
        surface="sunken"
        description={
          entries.length > 0
            ? `${entries.length} ${entries.length === 1 ? 'entry' : 'entries'}, ${entries.filter((e) => e.enabled).length} enabled. Saved inside the card and exported with it.`
            : 'This card has no embedded lorebook.'
        }
        action={
          entries.length > 0 && (
            <div className="flex items-center gap-1">
              <Button
                variant="ghost"
                className="flex items-center gap-1.5"
                title="Download as a SillyTavern world file"
                onClick={() => downloadWorldFile(embedded!, embedded!.name?.trim() || `${charName} lore`)}
              >
                <Download size={14} />
                Export
              </Button>
              <Button variant="ghost" disabled={busy} onClick={copyToWorldInfo}>
                Copy to World Info
              </Button>
            </div>
          )
        }
      >
        {entries.length > 0 && (
          <>
            <button
              type="button"
              onClick={() => setExpanded((v) => !v)}
              className="flex items-center gap-1 text-xs font-medium text-text-muted hover:text-text"
            >
              {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
              {expanded ? 'Hide entries' : 'Show entries'}
            </button>
            {expanded && (
              <ul className="mt-2 space-y-2">
                {entries.map((e, i) => (
                  <li key={e.id ?? i} className={`rounded-lg border border-border px-3 py-2 ${e.enabled ? '' : 'opacity-50'}`}>
                    <div className="flex flex-wrap items-center gap-1.5 text-xs">
                      {e.comment && <span className="font-medium text-text">{e.comment}</span>}
                      {e.constant ? (
                        <span className="text-accent">Always on</span>
                      ) : (
                        e.keys.map((k) => (
                          <span key={k} className="rounded bg-bg px-1.5 py-0.5 text-text-muted">
                            {k}
                          </span>
                        ))
                      )}
                      {!e.enabled && <span className="text-text-muted">(disabled)</span>}
                    </div>
                    <p className="mt-1 line-clamp-2 whitespace-pre-line text-xs text-text-muted">{e.content}</p>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </Section>

      <Section
        title="Linked World Info"
        icon={Link2}
        surface="sunken"
        description="Standalone World Info books scoped to this character. Edit entries and other scopes in World Info."
      >
        {linked.length === 0 && <p className="text-sm text-text-muted">No World Info books are linked to {charName}.</p>}
        {linked.length > 0 && (
          <ul className="space-y-1.5">
            {linked.map((b) => (
              <li key={b.id} className="flex items-center justify-between gap-3 rounded-lg border border-border px-3 py-2">
                <div className="min-w-0">
                  <div className="truncate text-sm text-text">{b.book.name || b.name || 'Untitled'}</div>
                  <div className="text-xs text-text-muted">
                    {b.book.entries.length} {b.book.entries.length === 1 ? 'entry' : 'entries'}
                  </div>
                </div>
                <Button variant="ghost" className="flex shrink-0 items-center gap-1.5" onClick={() => unlink(b)}>
                  <Unlink size={14} />
                  Unlink
                </Button>
              </li>
            ))}
          </ul>
        )}
        {linkable.length > 0 && (
          <select
            aria-label="Link a World Info book"
            value=""
            onChange={(e) => {
              if (e.target.value) void link(e.target.value)
            }}
            className="mt-3 w-full cursor-pointer rounded-xl bg-bg px-3 py-2 text-sm text-text outline-none ring-1 ring-border focus:ring-accent/40"
          >
            <option value="">Link an existing book…</option>
            {linkable.map((b) => (
              <option key={b.id} value={b.id}>
                {(b.book.name || b.name || 'Untitled') + (isGlobalBook(b) ? ' (global)' : '')}
              </option>
            ))}
          </select>
        )}
      </Section>
    </div>
  )
}
