import { describe, expect, it } from 'vitest';
import { CreateActivityRequest, ImportMessagesRequest, ListActivitiesQuery, RecordMessageRequest, UpdateNoteRequest, endpoints } from '../src/index.ts';

// Communications C1 contracts (docs/communications-c1.md §5): strict bodies, no forged provenance.
const message = {
  direction: 'INBOUND', occurredAt: '2026-10-01T09:00:00Z', body: 'Hello',
  participants: [{ role: 'FROM', address: 'pat@client.example' }],
};

describe('Communications C1 contracts', () => {
  it('only notes are restricted; direction and channel fit their types', () => {
    const base = { customerId: '00000000-0000-4000-8000-000000000001', body: 'x' };
    expect(CreateActivityRequest.safeParse({ ...base, type: 'note', visibility: 'RESTRICTED' }).success).toBe(true);
    expect(CreateActivityRequest.safeParse({ ...base, type: 'call', visibility: 'RESTRICTED' }).success).toBe(false);
    expect(CreateActivityRequest.safeParse({ ...base, type: 'interaction', channel: 'SMS', direction: 'INBOUND' }).success).toBe(true);
    expect(CreateActivityRequest.safeParse({ ...base, type: 'interaction' }).success).toBe(false);
    expect(CreateActivityRequest.safeParse({ ...base, type: 'note', direction: 'INBOUND' }).success).toBe(false);
    expect(CreateActivityRequest.safeParse({ ...base, type: 'message.recorded' }).success).toBe(false);
  });

  it('a note edit changes subject or body only', () => {
    expect(UpdateNoteRequest.safeParse({ body: 'new' }).success).toBe(true);
    expect(UpdateNoteRequest.safeParse({}).success).toBe(false);
    expect(UpdateNoteRequest.safeParse({ body: 'x', actorUserId: '00000000-0000-4000-8000-000000000001' }).success).toBe(false);
  });

  it('a recorded message needs one sender and carries no recorder, recorded time, source or delivery state', () => {
    expect(RecordMessageRequest.safeParse(message).success).toBe(true);
    expect(RecordMessageRequest.safeParse({ ...message, participants: [{ role: 'TO', address: 'x@y.example' }] }).success).toBe(false);
    for (const extra of [{ recordedAt: '2026-01-01T00:00:00Z' }, { recordedById: '00000000-0000-4000-8000-000000000001' }, { source: 'IMPORT' }, { status: 'SENT' }]) {
      expect(RecordMessageRequest.safeParse({ ...message, ...extra }).success, JSON.stringify(extra)).toBe(false);
    }
  });

  it('imports carry an external id and are bounded to 100 per call', () => {
    const one = { ...message, external: { source: 'gmail-export', messageId: '<1@x>' } };
    expect(ImportMessagesRequest.safeParse({ messages: [one] }).success).toBe(true);
    expect(ImportMessagesRequest.safeParse({ messages: [message] }).success).toBe(false);
    expect(ImportMessagesRequest.safeParse({ messages: Array.from({ length: 101 }, () => one) }).success).toBe(false);
  });

  it('timeline filters are bounded, and every C1 path is versioned and tenant-scoped', () => {
    expect(ListActivitiesQuery.parse({ types: 'note,call' }).types).toEqual(['note', 'call']);
    expect(ListActivitiesQuery.safeParse({ types: 'NOTE' }).success).toBe(false);
    expect(ListActivitiesQuery.safeParse({ limit: '101' }).success).toBe(false);
    for (const name of ['getActivity', 'updateNote', 'removeActivity', 'listConversations', 'createConversation', 'getConversation', 'listMessages', 'recordMessage', 'importMessages'] as const) {
      expect(endpoints[name].path).toMatch(/^\/api\/v1\/b\/:slug\//);
    }
  });
});
