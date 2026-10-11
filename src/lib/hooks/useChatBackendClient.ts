import { useMemo } from 'react'
import { useSettingsStore } from '@/lib/store/useSettingsStore'
import { createChatBackend } from '@/lib/api/createChatBackend'
import { invalidateTokenCache } from '@/lib/tokenCache'
import type { ChatBackend, ChatBackendId } from '@/lib/api/chatBackend'

/**
 * Section 8's "additional model backends" — the shared hook every generation call site (the main
 * chat loop, character generation, field regeneration, world info suggestions, outreach messages,
 * new-chat greeting) uses to get a `ChatBackend` that respects the user's Settings choice, instead
 * of each one separately reading `baseUrl` and constructing `new KoboldClient(baseUrl)` directly.
 * Defaults to `koboldcpp` (unaffected behavior) until the user opts into `'openai-compatible'` from
 * Settings.
 */
export function useChatBackendClient(): ChatBackend {
  const baseUrl = useSettingsStore((s) => s.baseUrl)
  const chatBackend = useSettingsStore((s) => s.chatBackend)
  const chatBackendBaseUrl = useSettingsStore((s) => s.chatBackendBaseUrl)
  const chatBackendApiKey = useSettingsStore((s) => s.chatBackendApiKey)
  const chatBackendModel = useSettingsStore((s) => s.chatBackendModel)
  return useMemo(() => {
    // A different backend or model means a different tokenizer, so every memoized token count from
    // the previous one is now wrong.
    invalidateTokenCache()
    return createChatBackend({ chatBackend, baseUrl, chatBackendBaseUrl, chatBackendApiKey, chatBackendModel })
  }, [chatBackend, baseUrl, chatBackendBaseUrl, chatBackendApiKey, chatBackendModel])
}

/**
 * The backend for the Assistant view and character/lorebook generation: the chat backend, but with
 * `assistantModel` swapped in when one is set (hosted OpenAI-compatible backends only). Roleplay and
 * every background judge keep using `useChatBackendClient`.
 */
export function useAssistantBackendClient(): ChatBackend {
  const baseUrl = useSettingsStore((s) => s.baseUrl)
  const chatBackend = useSettingsStore((s) => s.chatBackend)
  const chatBackendBaseUrl = useSettingsStore((s) => s.chatBackendBaseUrl)
  const chatBackendApiKey = useSettingsStore((s) => s.chatBackendApiKey)
  const chatBackendModel = useSettingsStore((s) => s.chatBackendModel)
  const assistantModel = useSettingsStore((s) => s.assistantModel)
  return useMemo(
    () =>
      createChatBackend({
        chatBackend,
        baseUrl,
        chatBackendBaseUrl,
        chatBackendApiKey,
        chatBackendModel: assistantModelFor(chatBackend, assistantModel, chatBackendModel),
      }),
    [chatBackend, baseUrl, chatBackendBaseUrl, chatBackendApiKey, chatBackendModel, assistantModel],
  )
}

/** `assistantModel` when it applies, else the chat model. Exported for `useAssistant`, which builds its client itself. */
export function assistantModelFor(chatBackend: ChatBackendId, assistantModel: string, chatBackendModel: string): string {
  return chatBackend === 'openai-compatible' && assistantModel.trim() ? assistantModel.trim() : chatBackendModel
}
