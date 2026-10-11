/**
 * House prose style for every card-authoring prompt — the whole-card drafts and single-field
 * rewrite in `aiAssist.ts`, and the AI Studio refine/revise prompts in `aiStudio.ts`. Its own
 * module so both can share it without `aiAssist` ↔ `aiStudio` importing each other.
 */

/** The core anti-slop guidance, verbatim house style from `systemPrompts.ts`. */
export const PROSE_STYLE_CORE = `Write like a person, not like an AI. Plain, specific language with a real point of view. No em dashes. Drop the habits of machine-written roleplay: hedging, naming a feeling instead of showing it, "a mix of X and Y", "not just X but Y", tidy lists of three, "voice barely above a whisper", "a shiver down her spine", any sentence that tells the reader how to feel.`

/**
 * The user's global "Writing style" setting (Settings → Generation → Writing style) folded into an
 * authoring prompt, so a generated or rewritten card matches the prose they've asked for in every
 * chat. Placed right after the built-in style block and told to win on any conflict — the same
 * "closest to generation wins" placement `buildPrompt` gives it in the live chat prompt. `''` when
 * unset, so it costs nothing for the common case.
 */
export function writerStyleNote(styleGuidance: string | undefined): string {
  const s = styleGuidance?.trim()
  return s
    ? `The writer keeps these style notes for everything they make in this app. Follow them, and where they conflict with the guidance above, they take priority:\n${s}`
    : ''
}
