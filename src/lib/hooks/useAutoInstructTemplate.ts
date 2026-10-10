import { useEffect } from 'react'
import { useSettingsStore } from '@/lib/store/useSettingsStore'
import { KoboldClient } from '@/lib/api/kobold'
import { BUILTIN_INSTRUCT_TEMPLATES, detectInstructTemplateId } from '@/lib/prompt/instructTemplates'
import { toastInfo, toastSuccess } from '@/lib/store/useToastStore'

/** Switches the old Gemma template to Gemma 4 when the loaded model is Gemma 4; any other mismatch is only pointed out. Mounted once in `App`. */
export function useAutoInstructTemplate() {
  const chatBackend = useSettingsStore((s) => s.chatBackend)
  const baseUrl = useSettingsStore((s) => s.baseUrl)

  useEffect(() => {
    if (chatBackend !== 'koboldcpp') return
    let cancelled = false
    const client = new KoboldClient(baseUrl)

    async function check() {
      const detected = detectInstructTemplateId(await client.getChatTemplate())
      if (cancelled || !detected) return
      const { instructTemplateId, setInstructTemplateId } = useSettingsStore.getState()
      if (detected === instructTemplateId) return
      const target = BUILTIN_INSTRUCT_TEMPLATES.find((t) => t.id === detected)
      if (!target) return
      if (detected === 'gemma4' && instructTemplateId === 'gemma') {
        setInstructTemplateId('gemma4')
        toastSuccess('Switched the instruct template to Gemma 4: this model uses the newer turn format.')
      } else if (BUILTIN_INSTRUCT_TEMPLATES.some((t) => t.id === instructTemplateId)) {
        toastInfo(`This model's chat template looks like ${target.name}. Switch the instruct template in Settings → Connection for better replies.`)
      }
    }

    const timer = setTimeout(() => void check().catch(() => {}), 2500)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [chatBackend, baseUrl])
}
