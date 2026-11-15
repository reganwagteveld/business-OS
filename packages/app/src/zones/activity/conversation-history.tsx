import type { Conversation, Message } from '@business-os/contracts';
import { useState } from 'react';
import type { ConversationPage, MessagePage } from '../../api/customers';
import type { Outcome } from '../../api/tenancy';
import { secondaryClass } from '../../shell/frame';
import { formatWhen } from '../customers/format';
import { Problem, Skeleton } from '../problem';
import { useLoad } from '../use-load';
import { CHANNEL_LABEL } from './labels';

const DIRECTION_TEXT: Record<Message['direction'], string> = {
  INBOUND: 'Received', OUTBOUND: 'Sent outside Business OS', INTERNAL: 'Internal',
};

/**
 * Read-only history of conversations recorded for one record (docs/communications-c1.md): each
 * conversation opens to its messages, oldest first, with sender, recipients and when it happened.
 * Every message is labelled as recorded or imported; nothing here says Business OS sent it.
 */
export function ConversationHistory({ loadConversations, loadMessages, loadKey, names, locale, timeZone, onSessionEnded }: {
  loadConversations: (cursor: string | undefined, signal: AbortSignal) => Promise<Outcome<ConversationPage>>;
  loadMessages: (conversationId: string, cursor: string | undefined, signal: AbortSignal) => Promise<Outcome<MessagePage>>;
  loadKey: string; names: Map<string, string> | null; locale?: string; timeZone: string; onSessionEnded: () => void;
}) {
  const [openId, setOpenId] = useState<string | null>(null);
  const { state, reload } = useLoad(`conversations|${loadKey}`, (signal) => loadConversations(undefined, signal));
  if (state.status === 'loading') return <Skeleton rows={2} label="Loading conversations…" />;
  if (state.outcome.kind !== 'ok') return <Problem outcome={state.outcome} what="Conversations" onRetry={reload} onSessionEnded={onSessionEnded} />;
  const conversations = state.outcome.data.conversations;
  if (conversations.length === 0) {
    return <p className="text-sm text-muted-foreground">No conversations recorded yet. Messages exchanged outside Business OS appear here once someone records or imports them.</p>;
  }
  return (
    <ul className="space-y-2">
      {conversations.map((c) => (
        <li key={c.id} className="rounded-xl border border-border">
          <button type="button" aria-expanded={openId === c.id} onClick={() => setOpenId(openId === c.id ? null : c.id)}
            className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left">
            <span className="min-w-0">
              <span className="block text-sm font-medium [overflow-wrap:anywhere]">{c.subject ?? `${CHANNEL_LABEL[c.channel] ?? c.channel} conversation`}</span>
              <span className="block text-xs text-muted-foreground">{conversationMeta(c, timeZone, locale)}</span>
            </span>
            <span aria-hidden="true" className="text-xs text-muted-foreground">{openId === c.id ? 'Hide' : 'Show'}</span>
          </button>
          {openId === c.id ? (
            <div className="border-t border-border px-4 py-3">
              <Messages conversationId={c.id} load={loadMessages} names={names} locale={locale} timeZone={timeZone} onSessionEnded={onSessionEnded} />
            </div>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

function conversationMeta(c: Conversation, timeZone: string, locale?: string): string {
  const channel = CHANNEL_LABEL[c.channel] ?? c.channel;
  const last = c.lastMessageAt ? `last message ${formatWhen(c.lastMessageAt, timeZone, locale)}` : 'no messages yet';
  return `${channel} · ${c.source === 'IMPORT' ? 'imported' : 'recorded'} · ${last}`;
}

function Messages({ conversationId, load, names, locale, timeZone, onSessionEnded }: {
  conversationId: string; load: (conversationId: string, cursor: string | undefined, signal: AbortSignal) => Promise<Outcome<MessagePage>>;
  names: Map<string, string> | null; locale?: string; timeZone: string; onSessionEnded: () => void;
}) {
  const [pages, setPages] = useState<string[]>([]);
  const cursor = pages[pages.length - 1];
  const { state, reload } = useLoad(`messages|${conversationId}|${cursor ?? ''}`, (signal) => load(conversationId, cursor, signal));
  if (state.status === 'loading') return <Skeleton rows={2} label="Loading messages…" />;
  if (state.outcome.kind !== 'ok') return <Problem outcome={state.outcome} what="Messages" onRetry={reload} onSessionEnded={onSessionEnded} />;
  const { messages, nextCursor } = state.outcome.data;
  if (messages.length === 0) return <p className="text-sm text-muted-foreground">No messages in this conversation yet.</p>;
  return (
    <>
      <ol aria-label="Messages" className="space-y-4">
        {messages.map((m) => <MessageItem key={m.id} m={m} names={names} locale={locale} timeZone={timeZone} />)}
      </ol>
      {pages.length > 0 || nextCursor ? (
        <nav aria-label="Message pages" className="mt-4 flex justify-between">
          <button type="button" className={secondaryClass} disabled={pages.length === 0} onClick={() => setPages(pages.slice(0, -1))}>Earlier</button>
          <button type="button" className={secondaryClass} disabled={!nextCursor} onClick={() => nextCursor && setPages([...pages, nextCursor])}>Later</button>
        </nav>
      ) : null}
    </>
  );
}

function person(p: Message['participants'][number], names: Map<string, string> | null): string {
  const member = p.userId ? names?.get(p.userId) : undefined;
  const name = p.displayName ?? member;
  if (name && p.address) return `${name} <${p.address}>`;
  return name ?? p.address ?? (p.contactId ? 'A contact' : 'A team member');
}

/** One recorded message: who, to whom, when it happened, when it was recorded and how. */
export function MessageItem({ m, names, locale, timeZone }: { m: Message; names: Map<string, string> | null; locale?: string; timeZone: string }) {
  const from = m.participants.filter((p) => p.role === 'FROM').map((p) => person(p, names));
  const to = m.participants.filter((p) => p.role !== 'FROM').map((p) => `${p.role === 'TO' ? '' : `${p.role.toLowerCase()}: `}${person(p, names)}`);
  return (
    <li data-direction={m.direction} className="space-y-1">
      <p className="text-xs text-muted-foreground">
        <span className="font-medium text-foreground">{DIRECTION_TEXT[m.direction]}</span>
        {' · '}<time dateTime={m.occurredAt}>{formatWhen(m.occurredAt, timeZone, locale)}</time>
        {' · '}{m.source === 'IMPORT' ? `Imported${m.externalSource ? ` from ${m.externalSource}` : ''}` : 'Recorded'} {formatWhen(m.recordedAt, timeZone, locale)}
      </p>
      <p className="text-xs [overflow-wrap:anywhere]">From {from.join(', ') || 'unknown'}{to.length ? ` to ${to.join(', ')}` : ''}</p>
      {m.subject ? <p className="text-sm font-medium [overflow-wrap:anywhere]">{m.subject}</p> : null}
      {m.body ? <p className="whitespace-pre-wrap text-sm text-muted-foreground [overflow-wrap:anywhere]">{m.body}</p> : null}
    </li>
  );
}
