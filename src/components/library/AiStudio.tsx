import { useCallback, useEffect, useRef, useState } from 'react'
import { Highlighter, Lightbulb, Redo2, RotateCcw, Send, Square, Undo2, WandSparkles, X } from 'lucide-react'
import { Modal } from '@/components/ui/Modal'
import { Button } from '@/components/ui/Button'
import { Chip } from '@/components/ui/Chip'
import { Spinner } from '@/components/ui/Spinner'
import { useChatBackendClient } from '@/lib/hooks/useChatBackendClient'
import { useSettingsStore } from '@/lib/store/useSettingsStore'
import { errorMessage } from '@/lib/store/useToastStore'
import { refineCardField } from '@/lib/characters/aiAssist'
import {
  STUDIO_FIELD_LABELS,
  SUGGESTION_CHIPS,
  normalizeSelection,
  spliceSelection,
  wordCount,
  type StudioField,
  type StudioSelection,
  type StudioTurn,
} from '@/lib/characters/aiStudio'
import type { CharacterCardData } from '@/lib/characters/cardSpec'

interface LogTurn extends StudioTurn {
  kind: 'full' | 'selection' | 'brainstorm'
}

interface History {
  stack: string[]
  index: number
}

/** Enough undo depth for a long session without holding every draft of a huge field forever. */
const HISTORY_LIMIT = 100

/** The wand trigger that sits in a field's label row (the `actions` slot of `TextAreaField`). */
export function AiStudioButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title="Open AI Studio: refine this field over several rounds, or revise a highlighted part"
      aria-label="Open AI Studio"
      className="text-text-muted transition-colors hover:text-accent"
    >
      <WandSparkles size={13} strokeWidth={2} />
    </button>
  )
}

/**
 * AI Studio: a multi-turn refine loop over one card field. Each instruction rewrites the working
 * draft (or, with a locked text selection, only that span, spliced back in), every round lands on
 * an undo/redo stack, and nothing touches the card until "Apply to card".
 */
export function AiStudio({
  card,
  field,
  onApply,
  onClose,
}: {
  card: CharacterCardData
  field: StudioField
  onApply: (text: string) => void
  onClose: () => void
}) {
  const client = useChatBackendClient()
  const styleGuidance = useSettingsStore((s) => s.styleGuidance)
  const initial = card[field] ?? ''
  const label = STUDIO_FIELD_LABELS[field]

  const [text, setText] = useState(initial)
  const [history, setHistory] = useState<History>({ stack: [initial], index: 0 })
  const [turns, setTurns] = useState<LogTurn[]>([])
  const [prompt, setPrompt] = useState('')
  const [wordTarget, setWordTarget] = useState('')
  const [selection, setSelection] = useState<StudioSelection | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const promptRef = useRef<HTMLTextAreaElement>(null)
  const abortRef = useRef<AbortController | null>(null)

  // Closing mid-generation aborts the request; any late result is ignored via the aborted signal.
  useEffect(() => () => abortRef.current?.abort(), [])

  const dirty = text !== history.stack[history.index]

  /** Records `entries` as the newest history states, dropping any redo branch. */
  const pushHistory = (entries: string[]) =>
    setHistory((h) => {
      const stack = h.stack.slice(0, h.index + 1)
      for (const entry of entries) if (entry !== stack[stack.length - 1]) stack.push(entry)
      const trimmed = stack.slice(-HISTORY_LIMIT)
      return { stack: trimmed, index: trimmed.length - 1 }
    })

  const undo = useCallback(() => {
    if (busy) return
    setSelection(null)
    if (dirty) {
      // Hand edits since the last round become their own state, so redo can bring them back.
      const stack = [...history.stack.slice(0, history.index + 1), text].slice(-HISTORY_LIMIT)
      const index = stack.length - 2
      setHistory({ stack, index })
      setText(stack[index])
      return
    }
    if (history.index === 0) return
    setHistory({ ...history, index: history.index - 1 })
    setText(history.stack[history.index - 1])
  }, [busy, dirty, history, text])

  const redo = useCallback(() => {
    if (busy || dirty || history.index >= history.stack.length - 1) return
    setSelection(null)
    setHistory({ ...history, index: history.index + 1 })
    setText(history.stack[history.index + 1])
  }, [busy, dirty, history])

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey) return
      if (e.target === promptRef.current) return
      const key = e.key.toLowerCase()
      if (key === 'z' && !e.shiftKey) {
        e.preventDefault()
        undo()
      } else if (key === 'y' || (key === 'z' && e.shiftKey)) {
        e.preventDefault()
        redo()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [undo, redo])

  const run = async (instruction: string, brainstorm = false) => {
    const ask = instruction.trim()
    if (busy || (!ask && !brainstorm)) return
    const base = text
    const sel = brainstorm ? null : normalizeSelection(base, selection)
    const target = Number(wordTarget)
    const controller = new AbortController()
    abortRef.current = controller
    setBusy(true)
    setError(null)
    try {
      const out = await refineCardField(client, {
        card: { ...card, [field]: base },
        field,
        current: base,
        turns,
        instruction: ask,
        wordTarget: Number.isFinite(target) && target > 0 ? target : undefined,
        selection: sel ?? undefined,
        brainstorm,
        styleGuidance,
        signal: controller.signal,
      })
      if (controller.signal.aborted) return
      const next = sel ? spliceSelection(base, sel, out) : out
      pushHistory([base, next])
      setText(next)
      setTurns((t) => [
        ...t,
        { instruction: ask, result: next, kind: brainstorm ? 'brainstorm' : sel ? 'selection' : 'full' },
      ])
      setSelection(null)
      setPrompt('')
    } catch (e) {
      if (!controller.signal.aborted) setError(errorMessage(e))
    } finally {
      if (abortRef.current === controller) {
        abortRef.current = null
        setBusy(false)
      }
    }
  }

  const stop = () => {
    abortRef.current?.abort()
    abortRef.current = null
    setBusy(false)
  }

  const restore = (result: string) => {
    if (busy) return
    pushHistory([text, result])
    setText(result)
    setSelection(null)
  }

  const locked = selection ? text.slice(selection.start, selection.end) : ''

  return (
    <Modal
      title={`AI Studio · ${label}`}
      description="Refine this field over several rounds. Select part of the draft to revise only that part. Nothing changes on the card until you apply."
      size="3xl"
      scrollable
      onClose={onClose}
    >
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto pr-1">
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="ghost" onClick={undo} disabled={busy || (!dirty && history.index === 0)} title="Undo (Ctrl+Z)" aria-label="Undo">
            <Undo2 size={14} />
          </Button>
          <Button
            variant="ghost"
            onClick={redo}
            disabled={busy || dirty || history.index >= history.stack.length - 1}
            title="Redo (Ctrl+Y)"
            aria-label="Redo"
          >
            <Redo2 size={14} />
          </Button>
          <span className="text-xs text-text-muted">{wordCount(text)} words</span>
          <span className="ml-auto flex items-center gap-2">
            <label className="flex items-center gap-1.5 text-xs text-text-muted">
              Word target
              <input
                type="number"
                min={0}
                step={10}
                value={wordTarget}
                onChange={(e) => setWordTarget(e.target.value)}
                placeholder="any"
                className="w-20 rounded-lg bg-bg-sunken px-2 py-1 text-xs text-text outline-none ring-1 ring-transparent focus:ring-accent/40"
              />
            </label>
            <Button
              onClick={() => run(prompt, true)}
              disabled={busy}
              title="Write this field from scratch using only the rest of the card. The prompt box, if filled, steers it."
            >
              <span className="inline-flex items-center gap-1.5">
                <Lightbulb size={14} /> Brainstorm
              </span>
            </Button>
          </span>
        </div>

        <textarea
          value={text}
          onChange={(e) => {
            setText(e.target.value)
            // Offsets of a locked span no longer point at the same text once it's hand-edited.
            setSelection(null)
          }}
          onSelect={(e) => {
            const { selectionStart, selectionEnd } = e.currentTarget
            if (selectionEnd > selectionStart) setSelection({ start: selectionStart, end: selectionEnd })
          }}
          readOnly={busy}
          rows={12}
          placeholder={`The ${label.toLowerCase()} is empty. Describe what you want below, or Brainstorm.`}
          className="w-full resize-y rounded-xl bg-bg-sunken px-3 py-2 text-sm leading-relaxed text-text outline-none ring-1 ring-transparent transition-shadow placeholder:text-text-muted/55 focus:ring-accent/40"
        />

        {selection && (
          <div className="flex items-start gap-2 rounded-xl border border-accent/30 bg-accent/10 p-2.5 text-xs">
            <Highlighter size={14} className="mt-0.5 shrink-0 text-accent" />
            <div className="min-w-0 flex-1">
              <span className="font-medium text-accent">Revising selection only</span>
              <p className="mt-1 line-clamp-3 whitespace-pre-wrap italic text-text">“{locked}”</p>
            </div>
            <button
              type="button"
              onClick={() => setSelection(null)}
              className="inline-flex shrink-0 items-center gap-1 text-text-muted hover:text-text"
              title="Clear selection and go back to whole-field mode"
            >
              <X size={13} /> Clear selection
            </button>
          </div>
        )}

        <div className="flex flex-wrap gap-1.5">
          {SUGGESTION_CHIPS[field].map((chip) => (
            <Chip key={chip} onClick={() => run(chip)} disabled={busy}>
              {chip}
            </Chip>
          ))}
        </div>

        <div className="flex items-end gap-2">
          <textarea
            ref={promptRef}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                run(prompt)
              }
            }}
            rows={2}
            placeholder={selection ? 'How should the selected part change?' : `What should change? e.g. "colder, ex-military", "shorter"`}
            className="min-w-0 flex-1 resize-none rounded-xl bg-bg-sunken px-3 py-2 text-sm leading-relaxed text-text outline-none ring-1 ring-transparent transition-shadow placeholder:text-text-muted/55 focus:ring-accent/40"
          />
          {busy ? (
            <Button variant="danger" onClick={stop} title="Stop generating">
              <span className="inline-flex items-center gap-1.5">
                <Square size={13} /> Stop
              </span>
            </Button>
          ) : (
            <Button variant="primary" onClick={() => run(prompt)} disabled={!prompt.trim()}>
              <span className="inline-flex items-center gap-1.5">
                <Send size={13} /> Send
              </span>
            </Button>
          )}
        </div>

        {busy && (
          <p className="flex items-center gap-2 text-xs text-text-muted">
            <Spinner /> {selection ? 'Revising the selection…' : 'Writing…'}
          </p>
        )}
        {error && <p className="rounded-lg bg-danger/10 p-2 text-xs text-danger">{error}</p>}

        {turns.length > 0 && (
          <div className="space-y-1.5">
            <span className="text-xs font-medium text-text-muted">This session</span>
            <ol className="max-h-48 space-y-1.5 overflow-y-auto">
              {turns.map((t, i) => (
                <li key={i} className="flex items-start gap-2 rounded-lg bg-bg-sunken px-2.5 py-1.5 text-xs">
                  <WandSparkles size={12} className="mt-0.5 shrink-0 text-accent" />
                  <div className="min-w-0 flex-1">
                    <p className="text-text">
                      {t.kind !== 'full' && (
                        <span className="mr-1.5 rounded bg-accent/10 px-1 py-px text-[10px] uppercase tracking-wide text-accent">
                          {t.kind}
                        </span>
                      )}
                      {t.instruction || 'Written fresh from the rest of the card'}
                    </p>
                    <p className="text-text-muted">{wordCount(t.result)} words</p>
                  </div>
                  <button
                    type="button"
                    onClick={() => restore(t.result)}
                    disabled={busy || t.result === text}
                    className="inline-flex shrink-0 items-center gap-1 text-text-muted hover:text-text disabled:opacity-40"
                    title="Bring this version back into the draft"
                  >
                    <RotateCcw size={12} /> Restore
                  </button>
                </li>
              ))}
            </ol>
          </div>
        )}
      </div>

      <div className="mt-4 flex shrink-0 justify-end gap-2">
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button
          variant="primary"
          onClick={() => {
            onApply(text)
            onClose()
          }}
          disabled={busy || text === initial}
        >
          Apply to card
        </Button>
      </div>
    </Modal>
  )
}
