import { useState } from 'react'
import { ChevronLeft, Copy, Download, Search, Upload } from 'lucide-react'
import { useApiQuery } from '@/lib/hooks/useApiQuery'
import { charactersApi, worldInfoBooksApi, worldsApi } from '@/lib/api/client'
import { isGlobalBook } from '@/lib/worldinfo/scope'
import { downloadWorldFile, lorebookMatches, parseWorldFile } from '@/lib/worldinfo/stWorld'
import type { WorldInfoBook } from '@/lib/types'
import { LorebookEditor } from './LorebookEditor'
import { BookScopePicker } from './BookScopePicker'
import { copyEmbeddedLorebook } from '@/components/library/LinkedLorebooks'
import { Button } from '@/components/ui/Button'
import { FileButton } from '@/components/ui/FileButton'
import { Modal } from '@/components/ui/Modal'
import { Section } from '@/components/ui/Section'
import { ViewShell } from '@/components/ui/ViewShell'
import { EmptyState } from '@/components/ui/EmptyState'
import { confirmDialog } from '@/lib/store/useConfirmStore'
import { errorMessage, toastError, toastInfo, toastSuccess } from '@/lib/store/useToastStore'

function scopeSummary(
  book: WorldInfoBook,
  names: { characters: Map<string, string>; worlds: Map<string, string> },
): string {
  if (isGlobalBook(book)) return 'Every chat'
  const chats = book.boundChatIds?.length ?? 0
  const labels = [
    ...(book.boundWorldIds ?? []).map((id) => names.worlds.get(id) ?? 'a world'),
    ...(book.boundCharacterIds ?? []).map((id) => names.characters.get(id) ?? 'a character'),
    ...(chats > 0 ? [`${chats} ${chats === 1 ? 'chat' : 'chats'}`] : []),
  ]
  if (labels.length === 0) return 'Every chat'
  if (labels.length <= 2) return labels.join(', ')
  return `${labels.slice(0, 2).join(', ')} +${labels.length - 2}`
}

export function WorldInfoView() {
  const books = useApiQuery('world-info-books', () => worldInfoBooksApi.list(), []) ?? []
  const characters = useApiQuery('characters', () => charactersApi.list(), []) ?? []
  const worlds = useApiQuery('worlds', () => worldsApi.list(), []) ?? []
  const [activeId, setActiveId] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [pickingCharacter, setPickingCharacter] = useState(false)
  const active = books.find((b) => b.id === activeId)
  const visibleBooks = books.filter((b) => lorebookMatches(b.book, query))
  const charactersWithLore = characters.filter((c) => (c.card.character_book?.entries.length ?? 0) > 0)

  const names = {
    characters: new Map(characters.map((c) => [c.id, c.card.name])),
    worlds: new Map(worlds.map((w) => [w.id, w.name])),
  }

  const createBook = async () => {
    const created = await worldInfoBooksApi.create({
      name: 'New World Info',
      book: { name: 'New World Info', entries: [], token_budget: 512, scan_depth: 8 },
      boundChatIds: [],
      boundCharacterIds: [],
      boundWorldIds: [],
    })
    setActiveId(created.id)
  }

  const removeBook = async (id: string) => {
    const book = books.find((b) => b.id === id)
    const ok = await confirmDialog({
      title: `Delete "${book?.book.name || 'this book'}"?`,
      body: 'Its entries are removed from every chat they were active in. This cannot be undone.',
      confirmLabel: 'Delete book',
      tone: 'danger',
    })
    if (!ok) return
    await worldInfoBooksApi.remove(id)
    if (activeId === id) setActiveId(null)
  }

  /** Each file becomes its own unscoped (global) book — ST world files carry no scope to map from. */
  const importFiles = async (files: FileList) => {
    let imported = 0
    for (const file of Array.from(files)) {
      try {
        const book = parseWorldFile(JSON.parse(await file.text()), file.name.replace(/\.json$/i, '').trim() || 'Imported World Info')
        await worldInfoBooksApi.create({
          name: book.name,
          book,
          boundChatIds: [],
          boundCharacterIds: [],
          boundWorldIds: [],
        })
        imported++
      } catch (e) {
        toastError(`Couldn't import "${file.name}": ${errorMessage(e)}`)
      }
    }
    if (imported > 0) {
      toastInfo(
        `Imported ${imported} ${imported === 1 ? 'book' : 'books'}. Unscoped books apply to every chat; open one and set its scope to narrow it to a character or world.`,
      )
    }
  }

  const duplicateBook = async (b: WorldInfoBook) => {
    const name = `${b.book.name || b.name || 'Untitled'} (copy)`
    try {
      await worldInfoBooksApi.create({
        name,
        book: { ...b.book, name },
        boundChatIds: [...(b.boundChatIds ?? [])],
        boundCharacterIds: [...(b.boundCharacterIds ?? [])],
        boundWorldIds: [...(b.boundWorldIds ?? [])],
      })
      toastSuccess(`Duplicated as "${name}".`)
    } catch (e) {
      toastError(`Couldn't duplicate: ${errorMessage(e)}`)
    }
  }

  const importFromCharacter = async (characterId: string) => {
    const character = characters.find((c) => c.id === characterId)
    if (!character) return
    setPickingCharacter(false)
    await copyEmbeddedLorebook(character)
  }

  if (active) {
    return (
      <div className="mx-auto w-full max-w-3xl flex-1 overflow-y-auto p-6 sm:p-8">
        <Button variant="ghost" onClick={() => setActiveId(null)} className="mb-6 -ml-2 flex items-center gap-1">
          <ChevronLeft size={15} strokeWidth={2} />
          All books
        </Button>

        <Section title="Scope" description="Where this book's entries are eligible to activate." className="mb-8">
          <BookScopePicker
            scope={active}
            onChange={(patch) => worldInfoBooksApi.update(active.id, patch)}
          />
        </Section>

        <Section title="Entries" surface="bare">
          <LorebookEditor
            book={active.book}
            onChange={(book) => worldInfoBooksApi.update(active.id, { book, name: book.name || active.name })}
          />
        </Section>
      </div>
    )
  }

  return (
    <ViewShell
      title="World Info"
      description="Standalone lorebooks. Locations, factions, history, world rules. A book with no scope is available to every chat; scope it to a character or world to keep unrelated lore out. Lore that belongs to one character lives on the character card instead."
      actions={
        <>
          <FileButton accept=".json,application/json" multiple onPick={importFiles} title="Import SillyTavern world files, character books, or card JSON">
            <Upload size={14} />
            Import
          </FileButton>
          {charactersWithLore.length > 0 && (
            <Button onClick={() => setPickingCharacter(true)} title="Copy a character's embedded lorebook into a book linked to them">
              From character
            </Button>
          )}
          <Button variant="primary" onClick={createBook}>
            New book
          </Button>
        </>
      }
    >
      {books.length > 0 && (
        <label className="mb-3 flex items-center gap-2 rounded-xl bg-bg-sunken px-3 py-2 ring-1 ring-transparent focus-within:ring-accent/40">
          <Search size={14} className="shrink-0 text-text-muted" />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search books, keys, and content"
            aria-label="Search World Info books"
            className="w-full bg-transparent text-base text-text outline-none placeholder:text-text-muted/55 sm:text-sm"
          />
        </label>
      )}
      <div className="space-y-2">
        {visibleBooks.map((b) => {
          const total = b.book.entries.length
          const enabled = b.book.entries.filter((e) => e.enabled).length
          return (
            <div
              key={b.id}
              className="group flex items-center justify-between rounded-xl border border-border bg-bg-elevated px-5 py-4 transition-colors hover:border-accent/40"
            >
              <button className="min-w-0 flex-1 text-left" onClick={() => setActiveId(b.id)}>
                <div className="truncate text-sm font-medium text-text">{b.book.name || 'Untitled'}</div>
                <div className="mt-0.5 flex items-center gap-2 text-xs text-text-muted">
                  <span>
                    {total} {total === 1 ? 'entry' : 'entries'}
                    {enabled < total && ` (${enabled} enabled)`}
                  </span>
                  <span className="text-border">·</span>
                  <span className={isGlobalBook(b) ? '' : 'text-accent'}>{scopeSummary(b, names)}</span>
                </div>
              </button>
              <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
                <Button variant="ghost" onClick={() => duplicateBook(b)} title="Duplicate" aria-label={`Duplicate ${b.book.name || 'book'}`}>
                  <Copy size={14} />
                </Button>
                <Button
                  variant="ghost"
                  onClick={() => downloadWorldFile(b.book, b.book.name || b.name)}
                  title="Export as a SillyTavern world file"
                  aria-label={`Export ${b.book.name || 'book'}`}
                >
                  <Download size={14} />
                </Button>
                <Button variant="ghost" onClick={() => removeBook(b.id)}>
                  Delete
                </Button>
              </div>
            </div>
          )
        })}
        {books.length > 0 && visibleBooks.length === 0 && (
          <p className="py-6 text-center text-sm text-text-muted">No books match "{query.trim()}".</p>
        )}
        {books.length === 0 && (
          <EmptyState
            action={
              <Button variant="primary" onClick={createBook}>
                Create your first book
              </Button>
            }
          >
            No standalone world info books yet. Most lore can live on a character or world instead. Reach for a book when the same lore spans several of them, or import a SillyTavern world file.
          </EmptyState>
        )}
      </div>
      {pickingCharacter && (
        <Modal
          title="Import from character"
          description="Copies the character's embedded lorebook into a World Info book linked to that character."
          size="md"
          scrollable
          onClose={() => setPickingCharacter(false)}
        >
          <ul className="space-y-1.5 overflow-y-auto">
            {charactersWithLore.map((c) => (
              <li key={c.id}>
                <button
                  type="button"
                  onClick={() => importFromCharacter(c.id)}
                  className="flex w-full items-center justify-between gap-3 rounded-xl border border-border px-4 py-3 text-left transition-colors hover:border-accent/40"
                >
                  <span className="truncate text-sm text-text">{c.card.name}</span>
                  <span className="shrink-0 text-xs text-text-muted">
                    {c.card.character_book?.entries.length ?? 0} entries
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </Modal>
      )}
    </ViewShell>
  )
}
