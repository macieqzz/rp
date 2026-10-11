import type { Character } from '@/lib/characters/cardSpec'
import { useSettingsStore } from '@/lib/store/useSettingsStore'
import type { TtsConfig } from './ttsProviders'

/**
 * The configured TTS setup as `synthesizeSpeech` wants it, with a character's own voice override
 * (if any) applied on top. `chat-audio` has no connection fields of its own: it borrows the chat
 * backend's base URL and key, the same ones replies already use.
 */
export function ttsConfigFor(voice?: Character['voice']): TtsConfig {
  const s = useSettingsStore.getState()
  if (voice?.provider && voice.provider !== s.ttsProvider) {
    throw new Error('This character overrides the voice provider. Select that provider in Settings → Voice first, or use the global default for this character.')
  }
  const provider = voice?.provider ?? s.ttsProvider
  return {
    provider,
    apiKey: provider === 'openmayhem' ? s.openMayhemApiKey : provider === 'chat-audio' ? s.chatBackendApiKey : s.ttsApiKey,
    model: s.ttsModel,
    baseUrl: provider === 'chat-audio' ? s.chatBackendBaseUrl : s.ttsBaseUrl,
    region: s.ttsRegion,
    voice: voice?.voiceId || s.ttsVoice,
  }
}
