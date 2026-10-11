import { useState } from 'react'
import { MessageSquarePlus, Pin, Play, Users } from 'lucide-react'
import type { Character } from '@/lib/characters/cardSpec'
import { useApiQuery } from '@/lib/hooks/useApiQuery'
import { libraryApi } from '@/lib/library/api'
import { Button } from '@/components/ui/Button'
import { EmptyState } from '@/components/ui/EmptyState'
import { Spinner } from '@/components/ui/Spinner'
import { NewChatDialog } from '@/components/chat/NewChatDialog'

/** Every conversation this character is in (primary or group participant), newest first, with resume. */
export function ChatsTab({ character, onOpenChat }: { character: Character; onOpenChat: (chatId: string) => void }) {
  const chats = useApiQuery(['chats', 'messages'], () => libraryApi.characterChats(character.id), [character.id])
  const [creating, setCreating] = useState(false)

  return (
    <div>
      <div className="mb-3 flex items-center justify-between">
        <p className="text-xs text-text-muted">
          {chats ? `${chats.length} chat${chats.length === 1 ? '' : 's'} · ${chats.reduce((n, c) => n + c.messageCount, 0)} messages` : ''}
        </p>
        <Button variant="primary" onClick={() => setCreating(true)} className="flex items-center gap-1.5">
          <MessageSquarePlus size={14} /> New chat
        </Button>
      </div>
      {!chats && <Spinner />}
      {chats?.length === 0 && <EmptyState>No chats with {character.card.name} yet.</EmptyState>}
      <div className="space-y-2">
        {chats?.map((chat) => (
          <div key={chat.id} className="flex items-start gap-3 rounded-xl border border-border bg-bg-elevated px-4 py-3">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5 text-sm font-medium text-text">
                {chat.pinned && <Pin size={12} className="text-accent" />}
                {chat.group && <Users size={12} className="text-text-muted" />}
                <span className="truncate">{chat.title || 'Untitled chat'}</span>
              </div>
              <div className="mt-0.5 text-xs text-text-muted">
                {chat.messageCount} message{chat.messageCount === 1 ? '' : 's'} · last active {new Date(chat.updatedAt).toLocaleString()}
              </div>
              {chat.lastMessage && (
                <p className="mt-1 line-clamp-2 text-xs text-text-muted/80">
                  <span className="font-medium">{chat.lastMessage.role === 'user' ? 'You' : character.card.name}:</span> {chat.lastMessage.text}
                </p>
              )}
            </div>
            <Button onClick={() => onOpenChat(chat.id)} className="flex shrink-0 items-center gap-1.5">
              <Play size={13} /> Resume
            </Button>
          </div>
        ))}
      </div>
      {creating && (
        <NewChatDialog
          initialCharacterId={character.id}
          onClose={() => setCreating(false)}
          onCreated={(id) => {
            setCreating(false)
            onOpenChat(id)
          }}
        />
      )}
    </div>
  )
}
