import { useSyncExternalStore } from 'react'
import { computeVersion, getComputeTotals, resetCompute, subscribeCompute } from '@/lib/api/computeLog'
import { Section } from '@/components/ui/Section'
import { Button } from '@/components/ui/Button'

/** Where model time went this session, by kind of call — the quickest way to see which background assist is worth turning off. */
export function ComputeUsage() {
  useSyncExternalStore(subscribeCompute, computeVersion)
  const totals = getComputeTotals()
  const totalMs = totals.reduce((sum, [, t]) => sum + t.ms, 0)
  return (
    <Section
      title="Model time this session"
      description="Wall-clock time spent waiting on the model, per kind of call. Background assists share the same GPU as your next reply."
      action={totals.length ? <Button variant="ghost" onClick={resetCompute}>Reset</Button> : undefined}
    >
      {totals.length === 0 ? (
        <p className="text-xs text-text-muted">Nothing yet. Send a message and the breakdown appears here.</p>
      ) : (
        <ul className="space-y-1.5 text-sm">
          {totals.map(([label, t]) => (
            <li key={label} className="flex items-baseline justify-between gap-3">
              <span className="min-w-0 truncate text-text">{label}</span>
              <span className="shrink-0 text-xs tabular-nums text-text-muted">
                {t.calls} × · {(t.ms / 1000).toFixed(1)}s · {Math.round((t.ms / totalMs) * 100)}%
              </span>
            </li>
          ))}
          <li className="flex items-baseline justify-between gap-3 border-t border-border/40 pt-1.5 text-xs text-text-muted">
            <span>Total</span>
            <span className="tabular-nums">{(totalMs / 1000).toFixed(1)}s</span>
          </li>
        </ul>
      )}
    </Section>
  )
}
