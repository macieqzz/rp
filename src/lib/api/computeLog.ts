// Session-only tally of model calls, so Settings can show where GPU time goes.

export interface ComputeEntry {
  label: string
  ms: number
  promptChars: number
  outChars: number
}

export interface ComputeTotal {
  calls: number
  ms: number
  promptChars: number
  outChars: number
}

const totals = new Map<string, ComputeTotal>()
const listeners = new Set<() => void>()
let version = 0

export function recordCompute(entry: ComputeEntry): void {
  const t = totals.get(entry.label) ?? { calls: 0, ms: 0, promptChars: 0, outChars: 0 }
  t.calls += 1
  t.ms += entry.ms
  t.promptChars += entry.promptChars
  t.outChars += entry.outChars
  totals.set(entry.label, t)
  version++
  listeners.forEach((l) => l())
}

export function getComputeTotals(): [string, ComputeTotal][] {
  return [...totals.entries()].sort((a, b) => b[1].ms - a[1].ms)
}

export function resetCompute(): void {
  totals.clear()
  version++
  listeners.forEach((l) => l())
}

export function subscribeCompute(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function computeVersion(): number {
  return version
}
