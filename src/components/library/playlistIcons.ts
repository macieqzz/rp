import {
  Bookmark,
  Crown,
  Flame,
  Folder,
  Ghost,
  Heart,
  ListMusic,
  Moon,
  Rocket,
  Skull,
  Smile,
  Star,
  Sun,
  Sword,
  Wand2,
  Zap,
  type LucideIcon,
} from 'lucide-react'

/** The icons a playlist can wear; the key is what's stored in `Playlist.icon`. */
export const PLAYLIST_ICONS: Record<string, LucideIcon> = {
  'list-music': ListMusic,
  folder: Folder,
  star: Star,
  heart: Heart,
  bookmark: Bookmark,
  flame: Flame,
  crown: Crown,
  sword: Sword,
  wand: Wand2,
  rocket: Rocket,
  ghost: Ghost,
  skull: Skull,
  moon: Moon,
  sun: Sun,
  smile: Smile,
  zap: Zap,
}

export const PLAYLIST_COLORS = ['#8b5cf6', '#ec4899', '#ef4444', '#f97316', '#eab308', '#22c55e', '#14b8a6', '#3b82f6', '#64748b']
