import type { GenerationStats } from '@/lib/hooks/useChatSession'

/**
 * Section 15's "Generation HUD" — live feedback while (and just after) the model is working,
 * distinct from `showTokenCounts`' per-message-after-the-fact count. Gated behind the
 * `showGenerationHud` setting (Settings → Appearance, next to `showTokenCounts`), since not every
 * user wants a stats strip competing for attention next to the composer.
 */
// Slowest ms per prompt token seen this session (a cold read); a much faster first token means the cache was reused.
let coldMsPerToken = 0
const labelled = new WeakMap<GenerationStats, string | null>()

// Judged against earlier replies only, so the first sample (the baseline) gets no label.
function cacheLabel(stats: GenerationStats): string | null {
  if (!stats.measured || stats.contextUsed < 1500) return null
  if (labelled.has(stats)) return labelled.get(stats)!
  const msPerToken = stats.firstTokenMs / stats.contextUsed
  const baseline = coldMsPerToken
  coldMsPerToken = Math.max(coldMsPerToken, msPerToken)
  const label = baseline < 0.1 ? null : msPerToken < baseline * 0.35 ? 'cache reused' : msPerToken > baseline * 0.7 ? 'full prompt re-read' : null
  labelled.set(stats, label)
  return label
}

export function GenerationHud({ stats, variant = 'default' }: { stats: GenerationStats | null; variant?: 'default' | 'vn' }) {
  if (!stats) return null
  const tone = variant === 'vn' ? 'text-white/55' : 'text-text-muted'
  const cache = cacheLabel(stats)
  const contextPct = stats.contextBudget > 0 ? Math.min(100, Math.round((stats.contextUsed / stats.contextBudget) * 100)) : 0
  return (
    <div
      className={`flex flex-wrap items-center gap-x-3 gap-y-0.5 py-1 text-[11px] ${tone} ${
        variant === 'vn' ? 'px-4' : 'mx-auto w-full max-w-chat px-4'
      }`}
      aria-live="polite"
    >
      <span>{stats.tokensPerSec.toFixed(1)} tok/s</span>
      <span>{(stats.firstTokenMs / 1000).toFixed(2)}s to first token</span>
      <span>
        {stats.contextUsed} / {stats.contextBudget} tok ({contextPct}% context)
      </span>
      {cache && <span title="Whether the model reused its cache or re-read the whole prompt. A slow first token can also be queueing behind background checks.">{cache}</span>}
      {!stats.measured && <span className="italic opacity-70">streaming…</span>}
    </div>
  )
}
