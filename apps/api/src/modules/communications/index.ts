// Public API of the communications module (docs/communications-c1.md §3): conversations and the
// read-only history of messages exchanged outside Business OS. Depends on activity, access and core.
export {
  createConversation, getConversation, importMessages, listConversations, listMessages, recordMessage,
} from './server/communications';
export type { ImportInput, MessageInput, ParticipantInput } from './server/communications';
