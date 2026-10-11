import { useState } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { FIELD_LABELS, lineDiff, type DiffField, type FieldDiff } from '@/lib/library/diff'

/** Diffs at or under this many changed lines open expanded; longer ones start collapsed. */
const AUTO_EXPAND_LINES = 8

function TextDiff({ before, after }: { before: string; after: string }) {
  const ops = lineDiff(before, after)
  return (
    <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-bg-sunken p-2 font-mono text-[11px] leading-relaxed">
      {ops.map((op, i) => (
        <div
          key={i}
          className={
            op.op === 'add'
              ? 'bg-success/15 text-success'
              : op.op === 'del'
                ? 'bg-danger/15 text-danger line-through decoration-danger/40'
                : 'text-text-muted'
          }
        >
          <span className="select-none pr-2 opacity-60">{op.op === 'add' ? '+' : op.op === 'del' ? '−' : ' '}</span>
          {op.text || '\u00a0'}
        </div>
      ))}
    </pre>
  )
}

function changedLines(diff: FieldDiff): number {
  if (diff.kind === 'text') return lineDiff(diff.before, diff.after).filter((o) => o.op !== 'same').length
  if (diff.kind === 'tags') return diff.added.length + diff.removed.length
  if (diff.kind === 'list') return Math.max(diff.before.length, diff.after.length)
  return AUTO_EXPAND_LINES + 1
}

function GreetingsDiff({ before, after }: { before: string[]; after: string[] }) {
  const count = Math.max(before.length, after.length)
  return (
    <div className="space-y-2">
      {Array.from({ length: count }, (_, i) => {
        const a = before[i]
        const b = after[i]
        const badge = a === undefined ? 'added' : b === undefined ? 'removed' : a === b ? 'unchanged' : 'changed'
        return (
          <details key={i} open={badge !== 'unchanged' && count <= 3} className="rounded-lg border border-border">
            <summary className="flex cursor-pointer items-center gap-2 px-2 py-1 text-xs text-text-muted">
              Greeting {i + 1}
              <span
                className={`rounded px-1.5 text-[10px] ${
                  badge === 'added'
                    ? 'bg-success/15 text-success'
                    : badge === 'removed'
                      ? 'bg-danger/15 text-danger'
                      : badge === 'changed'
                        ? 'bg-accent/15 text-accent'
                        : 'bg-bg-sunken'
                }`}
              >
                {badge}
              </span>
            </summary>
            <div className="p-2">
              <TextDiff before={a ?? ''} after={b ?? ''} />
            </div>
          </details>
        )
      })}
    </div>
  )
}

function DiffBody({ diff }: { diff: FieldDiff }) {
  if (diff.kind === 'tags') {
    return (
      <div className="flex flex-wrap gap-1.5">
        {diff.added.map((t) => (
          <span key={`a-${t}`} className="rounded-md bg-success/15 px-2 py-0.5 text-xs text-success">
            + {t}
          </span>
        ))}
        {diff.removed.map((t) => (
          <span key={`r-${t}`} className="rounded-md bg-danger/15 px-2 py-0.5 text-xs text-danger line-through">
            {t}
          </span>
        ))}
        {diff.kept.map((t) => (
          <span key={`k-${t}`} className="rounded-md bg-bg-sunken px-2 py-0.5 text-xs text-text-muted">
            {t}
          </span>
        ))}
      </div>
    )
  }
  if (diff.kind === 'list') return <GreetingsDiff before={diff.before} after={diff.after} />
  if (diff.kind === 'lorebook') {
    return (
      <div className="space-y-1">
        <p className="text-xs text-text-muted">
          {diff.beforeEntries} → {diff.afterEntries} entries
        </p>
        <TextDiff before={diff.before} after={diff.after} />
      </div>
    )
  }
  return <TextDiff before={diff.before} after={diff.after} />
}

function DiffRow({
  diff,
  selected,
  onToggle,
}: {
  diff: FieldDiff
  selected?: boolean
  onToggle?: () => void
}) {
  const [open, setOpen] = useState(() => changedLines(diff) <= AUTO_EXPAND_LINES)
  return (
    <div className="rounded-xl border border-border bg-bg-elevated">
      <div className="flex items-center gap-2 px-3 py-2">
        {onToggle && (
          <input
            type="checkbox"
            checked={!!selected}
            onChange={onToggle}
            aria-label={`Apply ${FIELD_LABELS[diff.field]}`}
            className="accent-[rgb(var(--c-accent))]"
          />
        )}
        <button type="button" onClick={() => setOpen((v) => !v)} className="flex flex-1 items-center gap-1.5 text-left text-sm font-medium text-text">
          {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          {FIELD_LABELS[diff.field]}
        </button>
      </div>
      {open && (
        <div className="border-t border-border px-3 py-2">
          <DiffBody diff={diff} />
        </div>
      )}
    </div>
  )
}

/**
 * Field-by-field card diff, shared by the Edit tab's preview, the Versions tab and provider update
 * checks. Pass `onToggle` to make each field selectable (e.g. "apply only these fields").
 */
export function CardDiffView({
  diffs,
  selected,
  onToggle,
}: {
  diffs: FieldDiff[]
  selected?: Set<DiffField>
  onToggle?: (field: DiffField) => void
}) {
  if (diffs.length === 0) return <p className="text-sm text-text-muted">No differences.</p>
  return (
    <div className="min-h-0 space-y-2 overflow-y-auto">
      {diffs.map((d) => (
        <DiffRow key={d.field} diff={d} selected={selected?.has(d.field)} onToggle={onToggle ? () => onToggle(d.field) : undefined} />
      ))}
    </div>
  )
}
