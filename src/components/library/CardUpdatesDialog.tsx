import { useEffect, useMemo, useState } from 'react'
import { AlertCircle, CheckCircle2, ChevronDown, ChevronRight } from 'lucide-react'
import { Modal } from '@/components/ui/Modal'
import { Button } from '@/components/ui/Button'
import { Spinner } from '@/components/ui/Spinner'
import { CardDiffView } from '@/components/library/CardDiffView'
import { charactersApi } from '@/lib/api/client'
import type { Character, CharacterCardData } from '@/lib/characters/cardSpec'
import { libraryApi, onlineApi } from '@/lib/library/api'
import { applyFields, diffCards, type DiffField, type FieldDiff } from '@/lib/library/diff'
import { PROVIDER_LABELS, displayNameOf, getProviderLink } from '@/lib/library/links'
import { remoteCardForLocal } from '@/lib/library/onlineImport'
import { errorMessage, toastError, toastSuccess } from '@/lib/store/useToastStore'

/** Parallel provider requests while checking — enough to be quick, few enough to stay polite. */
const CHECK_CONCURRENCY = 3

type RowState =
  | { status: 'checking' }
  | { status: 'error'; error: string }
  | { status: 'current' }
  | { status: 'changed'; remote: CharacterCardData; diffs: FieldDiff[]; selected: Set<DiffField>; applying?: boolean; applyError?: string }
  | { status: 'applied'; fields: number }

/**
 * Checks every provider-linked character for changes on its source page and applies chosen fields
 * per character (each update preceded by an automatic snapshot, so it can be undone).
 */
export function CardUpdatesDialog({ characters, onClose }: { characters: Character[]; onClose: () => void }) {
  // The set to check is fixed when the dialog opens; later list refreshes (from our own updates)
  // must not restart the check.
  const [targets] = useState(() => characters.filter((c) => getProviderLink(c.card)))
  const [skipped] = useState(() => characters.filter((c) => !getProviderLink(c.card)))
  const [rows, setRows] = useState<Record<string, RowState>>({})
  const [open, setOpen] = useState<Record<string, boolean>>({})
  const [batchRunning, setBatchRunning] = useState(false)

  const setRow = (id: string, row: RowState) => setRows((prev) => ({ ...prev, [id]: row }))

  useEffect(() => {
    let cancelled = false
    const queue = [...targets]
    const worker = async () => {
      for (let c = queue.shift(); c && !cancelled; c = queue.shift()) {
        const character = c
        const link = getProviderLink(character.card)!
        setRows((prev) => ({ ...prev, [character.id]: { status: 'checking' } }))
        try {
          const detail = await onlineApi.character(link.provider, link.id)
          const remote = remoteCardForLocal(character.card, detail.card)
          const diffs = diffCards(character.card, remote)
          if (cancelled) return
          // Tags start unticked: local tags are usually curated, and providers' are noisy.
          const selected = new Set(diffs.map((d) => d.field).filter((f) => f !== 'tags'))
          const row: RowState = diffs.length ? { status: 'changed', remote, diffs, selected } : { status: 'current' }
          setRows((prev) => ({ ...prev, [character.id]: row }))
        } catch (e) {
          if (!cancelled) setRows((prev) => ({ ...prev, [character.id]: { status: 'error', error: errorMessage(e) } }))
        }
      }
    }
    void Promise.all(Array.from({ length: Math.min(CHECK_CONCURRENCY, queue.length) }, worker))
    return () => {
      cancelled = true
    }
  }, [targets])

  const latest = useMemo(() => new Map(characters.map((c) => [c.id, c])), [characters])

  /** Applies one character's selected fields; returns whether it succeeded. */
  const apply = async (id: string): Promise<boolean> => {
    const row = rows[id]
    const character = latest.get(id)
    if (row?.status !== 'changed' || !character || row.selected.size === 0) return false
    setRow(id, { ...row, applying: true, applyError: undefined })
    try {
      await libraryApi.takeSnapshot(id, { auto: true, reason: 'Before card update' })
      await charactersApi.update(id, { card: applyFields(character.card, row.remote, row.selected) })
      setRow(id, { status: 'applied', fields: row.selected.size })
      return true
    } catch (e) {
      setRow(id, { ...row, applying: false, applyError: errorMessage(e) })
      return false
    }
  }

  const changedIds = targets.filter((c) => rows[c.id]?.status === 'changed').map((c) => c.id)
  const pendingApply = changedIds.filter((id) => {
    const row = rows[id]
    return row?.status === 'changed' && row.selected.size > 0
  })

  const applyAll = async () => {
    setBatchRunning(true)
    let ok = 0
    for (const id of pendingApply) if (await apply(id)) ok++
    setBatchRunning(false)
    if (ok === pendingApply.length) toastSuccess(`Updated ${ok} character${ok === 1 ? '' : 's'}.`)
    else toastError(`Updated ${ok} of ${pendingApply.length}; see the errors below.`)
  }

  const toggleField = (id: string, field: DiffField) =>
    setRows((prev) => {
      const row = prev[id]
      if (row?.status !== 'changed') return prev
      const selected = new Set(row.selected)
      if (selected.has(field)) selected.delete(field)
      else selected.add(field)
      return { ...prev, [id]: { ...row, selected } }
    })

  const counts = { checked: 0, changed: 0, current: 0, errors: 0, applied: 0 }
  for (const c of targets) {
    const status = rows[c.id]?.status
    if (status && status !== 'checking') counts.checked++
    if (status === 'changed') counts.changed++
    else if (status === 'current') counts.current++
    else if (status === 'error') counts.errors++
    else if (status === 'applied') counts.applied++
  }
  const checking = counts.checked < targets.length

  return (
    <Modal
      title="Check for card updates"
      description="Compares each linked character with its source page. Pick the fields to take; a snapshot is saved before every update."
      size="3xl"
      scrollable
      onClose={onClose}
    >
      <div className="mb-3 flex shrink-0 flex-wrap items-center gap-3 text-xs text-text-muted">
        {checking && <Spinner />}
        <span>
          Checked {counts.checked}/{targets.length}
        </span>
        <span>{counts.changed} with changes</span>
        <span>{counts.current} up to date</span>
        {counts.applied > 0 && <span>{counts.applied} updated</span>}
        {counts.errors > 0 && <span className="text-danger">{counts.errors} failed</span>}
        <span>{skipped.length} not linked</span>
        <Button className="ml-auto" variant="primary" disabled={batchRunning || pendingApply.length === 0} onClick={() => void applyAll()}>
          {batchRunning ? 'Applying…' : `Apply all selected (${pendingApply.length})`}
        </Button>
      </div>

      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto pr-1">
        {targets.length === 0 && <p className="text-sm text-text-muted">None of these characters are linked to an online source yet.</p>}
        {targets.map((c) => {
          const row = rows[c.id]
          const link = getProviderLink(c.card)!
          const name = displayNameOf(c.card)
          if (row?.status === 'changed') {
            const expanded = open[c.id] ?? changedIds.length === 1
            return (
              <div key={c.id} className="rounded-xl border border-border bg-bg-elevated">
                <div className="flex items-center gap-2 px-3 py-2">
                  <button
                    type="button"
                    onClick={() => setOpen((o) => ({ ...o, [c.id]: !expanded }))}
                    className="flex min-w-0 flex-1 items-center gap-1.5 text-left text-sm font-medium text-text"
                  >
                    {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                    <span className="truncate">{name}</span>
                    <span className="shrink-0 text-xs font-normal text-text-muted">
                      {PROVIDER_LABELS[link.provider]} · {row.diffs.length} changed field{row.diffs.length === 1 ? '' : 's'}
                    </span>
                  </button>
                  <Button variant="secondary" disabled={row.applying || batchRunning || row.selected.size === 0} onClick={() => void apply(c.id)}>
                    {row.applying ? 'Applying…' : `Apply selected (${row.selected.size})`}
                  </Button>
                </div>
                {row.applyError && <p className="px-3 pb-2 text-xs text-danger">{row.applyError}</p>}
                {expanded && (
                  <div className="border-t border-border p-3">
                    <CardDiffView diffs={row.diffs} selected={row.selected} onToggle={(field) => toggleField(c.id, field)} />
                  </div>
                )}
              </div>
            )
          }
          return (
            <div key={c.id} className="flex items-center gap-2 rounded-xl px-3 py-1.5 text-sm">
              {!row || row.status === 'checking' ? (
                <Spinner className="text-text-muted" />
              ) : row.status === 'error' ? (
                <AlertCircle size={14} className="shrink-0 text-danger" />
              ) : (
                <CheckCircle2 size={14} className="shrink-0 text-accent" />
              )}
              <span className="truncate text-text">{name}</span>
              <span className="min-w-0 flex-1 truncate text-xs text-text-muted">
                {!row || row.status === 'checking'
                  ? `Checking ${PROVIDER_LABELS[link.provider]}…`
                  : row.status === 'error'
                    ? row.error
                    : row.status === 'applied'
                      ? `Updated ${row.fields} field${row.fields === 1 ? '' : 's'}`
                      : 'Up to date'}
              </span>
            </div>
          )
        })}
        {skipped.length > 0 && (
          <details className="rounded-xl px-3 py-1.5 text-sm">
            <summary className="cursor-pointer text-text-muted">Skipped — not linked to a provider ({skipped.length})</summary>
            <ul className="mt-1 space-y-0.5 text-xs text-text-muted">
              {skipped.map((c) => (
                <li key={c.id} className="truncate">
                  {displayNameOf(c.card)}
                </li>
              ))}
            </ul>
          </details>
        )}
      </div>
    </Modal>
  )
}
