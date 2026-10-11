import { useEffect, useRef, useState } from 'react'
import { Sparkles } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Chip } from '@/components/ui/Chip'
import { Spinner } from '@/components/ui/Spinner'
import { useChatBackendClient } from '@/lib/hooks/useChatBackendClient'
import { errorMessage } from '@/lib/store/useToastStore'
import { suggestCardTags } from '@/lib/characters/aiAssist'
import type { CharacterCardData } from '@/lib/characters/cardSpec'

/**
 * "Suggest tags" for a card: asks the model for new library tags (`suggestCardTags`), shows them as
 * chips — all picked by default, click to drop one — and hands the picked ones to `onAdd`.
 */
export function SuggestTagsButton({ card, onAdd }: { card: CharacterCardData; onAdd: (tags: string[]) => void }) {
  const client = useChatBackendClient()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [suggestions, setSuggestions] = useState<string[] | null>(null)
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const abortRef = useRef<AbortController | null>(null)

  useEffect(() => () => abortRef.current?.abort(), [])

  const run = async () => {
    if (busy) return
    const controller = new AbortController()
    abortRef.current = controller
    setBusy(true)
    setError(null)
    try {
      const tags = await suggestCardTags(client, card, card.tags ?? [], controller.signal)
      if (controller.signal.aborted) return
      setSuggestions(tags)
      setPicked(new Set(tags))
    } catch (e) {
      if (!controller.signal.aborted) setError(errorMessage(e))
    } finally {
      if (abortRef.current === controller) {
        abortRef.current = null
        setBusy(false)
      }
    }
  }

  const toggle = (tag: string) =>
    setPicked((p) => {
      const next = new Set(p)
      if (next.has(tag)) next.delete(tag)
      else next.add(tag)
      return next
    })

  const dismiss = () => {
    setSuggestions(null)
    setError(null)
  }

  return (
    <div className="space-y-2">
      <Button onClick={run} disabled={busy} title="Ask the model for tags that fit this card">
        <span className="inline-flex items-center gap-1.5">
          {busy ? <Spinner /> : <Sparkles size={14} />} {suggestions ? 'Suggest again' : 'Suggest tags'}
        </span>
      </Button>
      {error && <p className="rounded-lg bg-danger/10 p-2 text-xs text-danger">{error}</p>}
      {suggestions && (
        <div className="space-y-2 rounded-xl border border-border bg-bg-sunken p-3">
          {suggestions.length ? (
            <div className="flex flex-wrap gap-1.5">
              {suggestions.map((tag) => (
                <Chip key={tag} on={picked.has(tag)} onClick={() => toggle(tag)}>
                  {tag}
                </Chip>
              ))}
            </div>
          ) : (
            <p className="text-xs text-text-muted">No new tags to suggest. The card already covers what the model found.</p>
          )}
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={dismiss}>
              Dismiss
            </Button>
            <Button
              variant="primary"
              disabled={picked.size === 0}
              onClick={() => {
                onAdd(suggestions.filter((t) => picked.has(t)))
                dismiss()
              }}
            >
              Add selected ({picked.size})
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}
