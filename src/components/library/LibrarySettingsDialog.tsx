import { useLibraryStore } from '@/lib/library/store'
import { Modal } from '@/components/ui/Modal'
import { Section } from '@/components/ui/Section'
import { SelectField } from '@/components/ui/Field'
import { Slider } from '@/components/ui/Slider'
import { Toggle } from '@/components/ui/Toggle'

/** Character Library display preferences and the filter preset applied on open. */
export function LibrarySettingsDialog({ onClose }: { onClose: () => void }) {
  const s = useLibraryStore()
  return (
    <Modal title="Library settings" size="lg" scrollable onClose={onClose}>
      <div className="min-h-0 space-y-5 overflow-y-auto">
        <Section title="Filters" surface="sunken">
          <SelectField label="Default filter preset" value={s.defaultPresetId ?? ''} onChange={(e) => s.setDefaultPreset(e.target.value || null)} hint="Applied every time the library opens.">
            <option value="">None (keep the last view)</option>
            {s.presets.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </SelectField>
        </Section>
        <Section title="Card grid" surface="sunken">
          <Slider label="Card size" min={120} max={280} step={10} value={s.cardWidth} onChange={(v) => s.setPrefs({ cardWidth: v })} formatValue={(v) => `${v}px`} />
          <p className="mt-2 text-xs font-medium text-text-muted">Hover card info shows</p>
          <Toggle checked={s.hover.creator} onChange={(v) => s.setHover({ creator: v })} label="Creator" />
          <Toggle checked={s.hover.tags} onChange={(v) => s.setHover({ tags: v })} label="Tags" />
          <Toggle checked={s.hover.tokens} onChange={(v) => s.setHover({ tokens: v })} label="Token count" />
          <Toggle checked={s.hover.chats} onChange={(v) => s.setHover({ chats: v })} label="Chat and message counts" />
          <Toggle checked={s.hover.notes} onChange={(v) => s.setHover({ notes: v })} label="Creator's notes preview" />
        </Section>
        <Section title="Character details" surface="sunken">
          <Toggle checked={s.prevNextNav} onChange={(v) => s.setPrefs({ prevNextNav: v })} label="Prev/next navigation" description="Step through the current sort and filter without going back to the grid (← / → keys too)." />
          <Toggle
            checked={s.localizeMedia}
            onChange={(v) => s.setPrefs({ localizeMedia: v })}
            label="Media localization"
            description="Show downloaded local copies in place of remote images in card text. The card itself is never changed."
          />
          <Toggle checked={s.showInfoTab} onChange={(v) => s.setPrefs({ showInfoTab: v })} label="Info tab" description="Debug/metadata panel." />
        </Section>
      </div>
    </Modal>
  )
}
