import { useMemo, useState } from 'react'
import { Pencil, Trash2 } from 'lucide-react'
import { useApiQuery } from '@/lib/hooks/useApiQuery'
import { libraryApi } from '@/lib/library/api'
import { confirmDialog } from '@/lib/store/useConfirmStore'
import { errorMessage, toastError, toastSuccess } from '@/lib/store/useToastStore'
import type { Character } from '@/lib/characters/cardSpec'
import { Button } from '@/components/ui/Button'
import { Modal } from '@/components/ui/Modal'
import { SegmentedControl } from '@/components/ui/SegmentedControl'

function splitTags(raw: string): string[] {
  return [...new Set(raw.split(',').map((t) => t.trim()).filter(Boolean))]
}

/** Add or remove tags across every selected character in one server-side batch. */
export function BatchTagDialog({ characters, allTags, onClose }: { characters: Character[]; allTags: string[]; onClose: () => void }) {
  const [mode, setMode] = useState<'addTags' | 'removeTags'>('addTags')
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  // Tags present on the selection, with how many of the selected carry each — the removal palette.
  const present = useMemo(() => {
    const counts = new Map<string, number>()
    for (const c of characters) for (const t of c.card.tags ?? []) counts.set(t, (counts.get(t) ?? 0) + 1)
    return [...counts].sort((a, b) => b[1] - a[1])
  }, [characters])
  const tags = splitTags(input)

  const apply = async () => {
    setBusy(true)
    try {
      const { updated } = await libraryApi.batch(
        characters.map((c) => c.id),
        { action: mode, tags },
      )
      toastSuccess(`${mode === 'addTags' ? 'Tagged' : 'Untagged'} ${updated} character${updated === 1 ? '' : 's'}.`)
      onClose()
    } catch (e) {
      toastError(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  const toggle = (t: string) => setInput(tags.includes(t) ? tags.filter((x) => x !== t).join(', ') : [...tags, t].join(', '))

  return (
    <Modal title={`Tags for ${characters.length} character${characters.length === 1 ? '' : 's'}`} size="lg" onClose={onClose}>
      <SegmentedControl
        fill
        value={mode}
        onChange={setMode}
        options={[
          { value: 'addTags', label: 'Add tags' },
          { value: 'removeTags', label: 'Remove tags' },
        ]}
        className="mb-3"
      />
      <input
        autoFocus
        list="batch-tag-suggestions"
        value={input}
        onChange={(e) => setInput(e.target.value)}
        placeholder="Comma-separated tags"
        className="mb-3 w-full rounded-xl bg-bg-sunken px-3 py-2 text-sm text-text outline-none ring-1 ring-transparent focus:ring-accent/40"
      />
      <datalist id="batch-tag-suggestions">
        {allTags.map((t) => (
          <option key={t} value={t} />
        ))}
      </datalist>
      <div className="mb-4 flex max-h-40 flex-wrap gap-1.5 overflow-y-auto">
        {(mode === 'removeTags' ? present.map(([t, n]) => ({ t, n })) : allTags.slice(0, 60).map((t) => ({ t, n: 0 }))).map(({ t, n }) => (
          <button
            key={t}
            type="button"
            onClick={() => toggle(t)}
            className={`rounded-lg px-2 py-0.5 text-xs ${tags.includes(t) ? 'bg-accent/15 text-accent ring-1 ring-accent/30' : 'bg-bg-sunken text-text-muted hover:text-text'}`}
          >
            {t}
            {n > 0 && <span className="ml-1 opacity-60">{n}</span>}
          </button>
        ))}
      </div>
      <div className="flex justify-end gap-2">
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="primary" disabled={!tags.length || busy} onClick={apply}>
          {mode === 'addTags' ? 'Add' : 'Remove'} {tags.length || ''} tag{tags.length === 1 ? '' : 's'}
        </Button>
      </div>
    </Modal>
  )
}

/** Library-wide tag maintenance: usage counts, rename (merging into an existing tag), delete. */
export function TagsManagerDialog({ onClose, onFilterTag }: { onClose: () => void; onFilterTag: (tag: string) => void }) {
  const tags = useApiQuery('characters', () => libraryApi.tags(), []) ?? []
  const [query, setQuery] = useState('')
  const [renaming, setRenaming] = useState<{ from: string; to: string } | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const visible = tags.filter((t) => t.tag.toLowerCase().includes(query.toLowerCase()))

  const rename = async () => {
    if (!renaming || !renaming.to.trim() || renaming.to.trim() === renaming.from) return setRenaming(null)
    const merging = tags.some((t) => t.tag.toLowerCase() === renaming.to.trim().toLowerCase())
    try {
      const { updated } = await libraryApi.renameTag(renaming.from, renaming.to.trim())
      toastSuccess(`${merging ? 'Merged' : 'Renamed'} on ${updated} character${updated === 1 ? '' : 's'}.`)
    } catch (e) {
      toastError(errorMessage(e))
    }
    setRenaming(null)
  }

  const removeSelected = async (list: string[]) => {
    const count = tags.filter((t) => list.includes(t.tag)).reduce((n, t) => n + t.count, 0)
    const ok = await confirmDialog({
      title: `Delete ${list.length === 1 ? `"${list[0]}"` : `${list.length} tags`}?`,
      body: `Removes ${list.length === 1 ? 'it' : 'them'} from ${count} card${count === 1 ? '' : 's'}.`,
      confirmLabel: 'Delete',
      tone: 'danger',
    })
    if (!ok) return
    await libraryApi.deleteTags(list)
    setSelected(new Set())
  }

  return (
    <Modal title="Tags manager" description="Rename a tag onto an existing one to merge them." size="2xl" scrollable onClose={onClose}>
      <div className="mb-3 flex gap-2">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={`Search ${tags.length} tags`}
          className="flex-1 rounded-xl bg-bg-sunken px-3 py-1.5 text-sm text-text outline-none ring-1 ring-transparent focus:ring-accent/40"
        />
        <Button variant="danger" disabled={!selected.size} onClick={() => removeSelected([...selected])}>
          Delete {selected.size || ''}
        </Button>
      </div>
      <div className="min-h-0 space-y-1 overflow-y-auto">
        {visible.map((t) => (
          <div key={t.tag} className="flex items-center gap-2 rounded-lg px-2 py-1 hover:bg-bg-sunken">
            <input
              type="checkbox"
              checked={selected.has(t.tag)}
              onChange={() =>
                setSelected((s) => {
                  const n = new Set(s)
                  if (n.has(t.tag)) n.delete(t.tag)
                  else n.add(t.tag)
                  return n
                })
              }
              aria-label={`Select ${t.tag}`}
            />
            {renaming?.from === t.tag ? (
              <input
                autoFocus
                value={renaming.to}
                onChange={(e) => setRenaming({ from: t.tag, to: e.target.value })}
                onBlur={rename}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
                  if (e.key === 'Escape') {
                    e.stopPropagation()
                    setRenaming(null)
                  }
                }}
                className="flex-1 rounded bg-bg-elevated px-2 py-0.5 text-sm text-text outline-none"
              />
            ) : (
              <button
                type="button"
                onClick={() => {
                  onFilterTag(t.tag)
                  onClose()
                }}
                title="Show characters with this tag"
                className="flex-1 truncate text-left text-sm text-text hover:text-accent"
              >
                {t.tag}
              </button>
            )}
            <span className="text-xs text-text-muted">{t.count}</span>
            <button type="button" title="Rename / merge" onClick={() => setRenaming({ from: t.tag, to: t.tag })} className="p-1 text-text-muted hover:text-text">
              <Pencil size={13} />
            </button>
            <button type="button" title="Delete" onClick={() => removeSelected([t.tag])} className="p-1 text-text-muted hover:text-danger">
              <Trash2 size={13} />
            </button>
          </div>
        ))}
        {visible.length === 0 && <p className="py-6 text-center text-sm text-text-muted">No tags.</p>}
      </div>
    </Modal>
  )
}
