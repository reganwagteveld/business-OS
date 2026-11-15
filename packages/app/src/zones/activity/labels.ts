import type { Activity } from '@business-os/contracts';

// Wording for the unified timeline (docs/communications-c1.md). Logged and recorded entries describe
// something that happened outside Business OS; no label ever says Business OS sent anything.

export const CHANNEL_LABEL: Record<string, string> = {
  EMAIL: 'Email', PHONE: 'Phone', SMS: 'SMS', CHAT: 'Chat', SOCIAL: 'Social media', IN_PERSON: 'In person', OTHER: 'Other',
};
const DIRECTION_WORD: Record<string, string> = { INBOUND: 'incoming', OUTBOUND: 'outgoing', INTERNAL: 'internal' };

export type BadgeKind = 'note' | 'call' | 'meeting' | 'email' | 'interaction' | 'message' | 'system';

/** Which badge an entry gets. */
export function badgeKind(a: Activity): BadgeKind {
  if (a.type === 'message.recorded') return 'message';
  if (a.type.includes('.')) return 'system';
  return (['note', 'call', 'meeting', 'email', 'interaction'] as const).find((k) => k === a.type) ?? 'note';
}

const str = (v: unknown) => (typeof v === 'string' ? v : undefined);

/** Short badge text: "Note", "Call · outgoing", "SMS · incoming", "Recorded email · incoming". */
export function badgeLabel(a: Activity): string {
  const direction = DIRECTION_WORD[str(a.data.direction) ?? ''];
  const suffix = direction ? ` · ${direction}` : '';
  switch (badgeKind(a)) {
    case 'note': return 'Note';
    case 'call': return `Call${suffix}`;
    case 'meeting': return 'Meeting';
    case 'email': return `Email${suffix}`;
    case 'interaction': return `${CHANNEL_LABEL[str(a.data.channel) ?? ''] ?? 'Interaction'}${suffix}`;
    case 'message': return `Recorded ${(CHANNEL_LABEL[str(a.data.channel) ?? ''] ?? 'message').toLowerCase()}${suffix}`;
    default: return 'Update';
  }
}

/** Headline for a recorded message entry (it carries no subject of its own: the message holds the content). */
export function messageEntryTitle(a: Activity): string {
  const channel = (CHANNEL_LABEL[str(a.data.channel) ?? ''] ?? 'message').toLowerCase();
  const source = str(a.data.source) === 'IMPORT' ? 'Imported' : 'Recorded';
  switch (str(a.data.direction)) {
    case 'INBOUND': return `${source} ${channel} received`;
    case 'OUTBOUND': return `${source} ${channel} sent outside Business OS`;
    default: return `${source} internal ${channel}`;
  }
}

/** Timeline filter choices: each maps to the activity types it shows. */
export const TIMELINE_FILTERS: { value: string; label: string; types: string[] | undefined }[] = [
  { value: 'all', label: 'Everything', types: undefined },
  { value: 'notes', label: 'Notes', types: ['note'] },
  { value: 'interactions', label: 'Calls, meetings and emails', types: ['call', 'meeting', 'email', 'interaction'] },
  { value: 'messages', label: 'Recorded messages', types: ['message.recorded'] },
];
