import { useEffect, useMemo, useState } from 'react'
import { Lock, Plus, Unlock, Wand2, X } from 'lucide-react'
import type { Character, CharacterCardData } from '@/lib/characters/cardSpec'
import { charactersApi } from '@/lib/api/client'
import { libraryApi } from '@/lib/library/api'
import { diffCards } from '@/lib/library/diff'
import { errorMessage, toastError, toastSuccess } from '@/lib/store/useToastStore'
import type { StudioField } from '@/lib/characters/aiStudio'
import { Button } from '@/components/ui/Button'
import { Modal } from '@/components/ui/Modal'
import { TextAreaField, TextField } from '@/components/ui/Field'
import { CardDiffView } from '../CardDiffView'
import { AiStudio } from '../AiStudio'
import { SuggestTagsButton } from '../SuggestTagsButton'

const LONG_FIELDS: { key: StudioField; label: string; rows: number }[] = [
  { key: 'description', label: 'Description', rows: 8 },
  { key: 'personality', label: 'Personality', rows: 4 },
  { key: 'scenario', label: 'Scenario', rows: 3 },
  { key: 'first_mes', label: 'First message', rows: 6 },
  { key: 'mes_example', label: 'Example dialogue', rows: 6 },
  { key: 'creator_notes', label: "Creator's notes", rows: 5 },
  { key: 'system_prompt', label: 'System prompt', rows: 3 },
  { key: 'post_history_instructions', label: 'Post-history instructions', rows: 3 },
]

/**
 * The details modal's card editor: opens locked so browsing can't change anything by accident,
 * tracks which fields differ from the saved card, previews the change as a diff, and takes an
 * automatic snapshot before saving. The full Characters editor (sprites, outfits, relationship
 * authoring…) stays one click away for everything beyond the portable card fields.
 */
export function EditTab({
  character,
  allTags,
  onDirtyChange,
  onOpenFullEditor,
}: {
  character: Character
  allTags: string[]
  onDirtyChange: (dirty: boolean) => void
  onOpenFullEditor: () => void
}) {
  const [locked, setLocked] = useState(true)
  const [draft, setDraft] = useState<CharacterCardData>(character.card)
  const [tagInput, setTagInput] = useState('')
  const [showDiff, setShowDiff] = useState(false)
  const [studio, setStudio] = useState<StudioField | null>(null)
  const [saving, setSaving] = useState(false)

  // A different character (prev/next) or a save landing from elsewhere resets the draft.
  useEffect(() => {
    setDraft(character.card)
    setLocked(true)
  }, [character.id, character.updatedAt])

  const diffs = useMemo(() => diffCards(character.card, draft), [character.card, draft])
  const changed = useMemo(() => new Set(diffs.map((d) => d.field as string)), [diffs])
  useEffect(() => onDirtyChange(diffs.length > 0), [diffs.length])

  const set = <K extends keyof CharacterCardData>(key: K, value: CharacterCardData[K]) => setDraft((d) => ({ ...d, [key]: value }))
  const tags = draft.tags ?? []
  const addTags = (raw: string[]) => {
    const next = [...tags]
    for (const t of raw.map((s) => s.trim()).filter(Boolean)) if (!next.some((x) => x.toLowerCase() === t.toLowerCase())) next.push(t)
    set('tags', next)
  }

  const save = async () => {
    setSaving(true)
    try {
      await libraryApi.takeSnapshot(character.id, { auto: true, reason: 'Before edit' })
      await charactersApi.update(character.id, { card: draft })
      setShowDiff(false)
      setLocked(true)
      toastSuccess('Character saved. The previous version is in the Versions tab.')
    } catch (e) {
      toastError(`Save failed: ${errorMessage(e)}`)
    } finally {
      setSaving(false)
    }
  }

  const dot = (field: string) => (changed.has(field) ? <span className="ml-1 inline-block h-1.5 w-1.5 rounded-full bg-accent" title="Changed" /> : null)
  const greetings = draft.alternate_greetings ?? []

  return (
    <div>
      <div className="sticky top-0 z-10 -mx-1 mb-4 flex flex-wrap items-center gap-2 bg-bg px-1 py-2">
        {locked ? (
          <Button variant="primary" onClick={() => setLocked(false)} className="flex items-center gap-1.5">
            <Unlock size={14} /> Unlock editing
          </Button>
        ) : (
          <Button onClick={() => setLocked(true)} className="flex items-center gap-1.5">
            <Lock size={14} /> Lock
          </Button>
        )}
        <span className="text-xs text-text-muted">
          {diffs.length ? `${diffs.length} field${diffs.length === 1 ? '' : 's'} changed` : 'No unsaved changes'}
        </span>
        <div className="ml-auto flex gap-2">
          <Button variant="ghost" onClick={onOpenFullEditor}>
            Full editor
          </Button>
          <Button disabled={!diffs.length} onClick={() => setDraft(character.card)}>
            Discard
          </Button>
          <Button disabled={!diffs.length} onClick={() => setShowDiff(true)}>
            Preview changes
          </Button>
          <Button variant="primary" disabled={!diffs.length || saving} onClick={save}>
            {saving ? 'Saving…' : 'Save'}
          </Button>
        </div>
      </div>

      <fieldset disabled={locked} className={locked ? 'opacity-75' : ''}>
        <div className="grid gap-x-3 sm:grid-cols-3">
          <TextField label={`Name${changed.has('name') ? ' •' : ''}`} value={draft.name} onChange={(e) => set('name', e.target.value)} />
          <TextField label={`Creator${changed.has('creator') ? ' •' : ''}`} value={draft.creator ?? ''} onChange={(e) => set('creator', e.target.value)} />
          <TextField
            label={`Version${changed.has('character_version') ? ' •' : ''}`}
            value={draft.character_version ?? ''}
            onChange={(e) => set('character_version', e.target.value)}
          />
        </div>

        <div className="mb-3">
          <span className="mb-1 flex items-center justify-between text-xs font-medium text-text-muted">
            <span>
              Tags{dot('tags')}
            </span>
            {!locked && <SuggestTagsButton card={draft} onAdd={addTags} />}
          </span>
          <div className="flex flex-wrap items-center gap-1.5 rounded-xl bg-bg-sunken p-2">
            {tags.map((t) => (
              <span key={t} className="flex items-center gap-1 rounded-lg bg-bg-elevated px-2 py-0.5 text-xs text-text">
                {t}
                {!locked && (
                  <button type="button" aria-label={`Remove ${t}`} onClick={() => set('tags', tags.filter((x) => x !== t))}>
                    <X size={11} />
                  </button>
                )}
              </span>
            ))}
            <input
              list="library-tag-suggestions"
              value={tagInput}
              onChange={(e) => setTagInput(e.target.value)}
              onKeyDown={(e) => {
                if ((e.key === 'Enter' || e.key === ',') && tagInput.trim()) {
                  e.preventDefault()
                  addTags(tagInput.split(','))
                  setTagInput('')
                }
              }}
              placeholder={locked ? '' : 'Add tag…'}
              className="min-w-24 flex-1 bg-transparent text-sm text-text outline-none"
            />
            <datalist id="library-tag-suggestions">
              {allTags.map((t) => (
                <option key={t} value={t} />
              ))}
            </datalist>
          </div>
        </div>

        {LONG_FIELDS.map(({ key, label, rows }) => (
          <TextAreaField
            key={key}
            label={`${label}${changed.has(key) ? ' •' : ''}`}
            rows={rows}
            value={draft[key] ?? ''}
            onChange={(e) => set(key, e.target.value)}
            actions={
              !locked ? (
                <button type="button" onClick={() => setStudio(key)} className="flex items-center gap-1 text-[11px] text-text-muted hover:text-accent">
                  <Wand2 size={12} /> AI Studio
                </button>
              ) : undefined
            }
          />
        ))}

        <div className="mb-3">
          <span className="mb-1 flex items-center justify-between text-xs font-medium text-text-muted">
            <span>
              Alternate greetings{dot('alternate_greetings')}
            </span>
            {!locked && (
              <button type="button" onClick={() => set('alternate_greetings', [...greetings, ''])} className="flex items-center gap-1 hover:text-accent">
                <Plus size={12} /> Add
              </button>
            )}
          </span>
          <div className="space-y-2">
            {greetings.map((g, i) => (
              <div key={i} className="relative">
                <textarea
                  rows={4}
                  value={g}
                  onChange={(e) => set('alternate_greetings', greetings.map((x, j) => (j === i ? e.target.value : x)))}
                  className="w-full resize-y rounded-xl bg-bg-sunken px-3 py-2 text-sm leading-relaxed text-text outline-none ring-1 ring-transparent focus:ring-accent/40"
                />
                {!locked && (
                  <button
                    type="button"
                    aria-label={`Remove greeting ${i + 1}`}
                    onClick={() => set('alternate_greetings', greetings.filter((_, j) => j !== i))}
                    className="absolute right-2 top-2 text-text-muted hover:text-danger"
                  >
                    <X size={13} />
                  </button>
                )}
              </div>
            ))}
            {greetings.length === 0 && <p className="text-xs text-text-muted">None.</p>}
          </div>
        </div>
      </fieldset>

      {showDiff && (
        <Modal title="Review changes" size="3xl" scrollable onClose={() => setShowDiff(false)}>
          <CardDiffView diffs={diffs} />
          <div className="mt-4 flex justify-end gap-2">
            <Button onClick={() => setShowDiff(false)}>Keep editing</Button>
            <Button variant="primary" disabled={saving} onClick={save}>
              Save changes
            </Button>
          </div>
        </Modal>
      )}

      {studio && (
        <AiStudio
          card={draft}
          field={studio}
          onApply={(text) => {
            set(studio, text)
            setStudio(null)
          }}
          onClose={() => setStudio(null)}
        />
      )}
    </div>
  )
}
