// Public API of the communications module (docs/communications-c1.md §3, docs/communications-c2.md):
// conversations and the read-only history of messages exchanged outside Business OS (C1), and
// connected mailboxes, their credentials and sync jobs (C2-A), and business mailbox identity, members
// and the retention setting (C2-B1). Depends on activity, access and core.
export {
  createConversation, getConversation, importMessages, listConversations, listMessages, recordMessage,
} from './server/communications';
export type { ImportInput, MessageInput, ParticipantInput } from './server/communications';
export {
  AuthorizationFailure, completeAuthorization, consumeAuthorization, disconnectConnection, getConnection, listConnections, listProviders,
  listSyncJobs, parseState, recordAuthorizationFailure, requestSync, startAuthorization, updateConnection,
} from './server/connections';
export type { CallbackFailure, ConnectionViewer, MailboxKind, PendingAuthorization } from './server/connections';
export { purposeOf } from './server/connections';
export {
  addDomain, designateAddress, dnsHasToken, domainToVerify, listAddresses, listDomains, listMembers, recordDomainVerification, removeAddress, removeDomain,
  removeMember, setMember,
} from './server/business-mailboxes';
export type { BusinessMailboxActor } from './server/business-mailboxes';
export { getRetention, setRetention } from './server/retention';
export { obtainAccessToken } from './server/credentials';
export type { TenantRun } from './server/credentials';
export { claimSyncJob, completeSyncJob, failSyncJob, heartbeatSyncJob } from './server/sync-jobs';
export type { ClaimedJob, SyncFailureCode } from './server/sync-jobs';
export { oauthRedirectUri, ProviderError, providerAdapter } from './server/providers';
export type { BusinessMailboxProof, MailProvider } from './server/providers';
