import type { Evaluation, Inventory, NeonBranch, NeonEndpoint, Registry } from './policy.mjs';

export class NeonApiError extends Error {}
/** Read-only by design: there is no delete method. */
export interface NeonClient {
  projectId: string;
  listBranches(): Promise<NeonBranch[]>;
  listEndpoints(): Promise<NeonEndpoint[]>;
}
export interface LogEntry {
  at: string;
  run: string;
  action: 'audit' | 'decision' | 'delete';
  branchId?: string;
  name?: string;
  decision?: string;
  outcome?: string;
  notification?: string;
  reasons?: string[];
  [key: string]: unknown;
}
export interface Snapshot {
  evaluatedAt: string;
  registryHash: string;
  fingerprints: Record<string, string>;
}
export interface Verdict {
  branchId: string;
  name?: string;
  verdict: 'allowed' | 'refused' | 'already-absent' | 'aborted';
  reasons: string[];
}
export function neonctlClient(projectId: string, opts?: { bin?: string; timeoutMs?: number }): NeonClient;
export function fetchInventory(client: NeonClient): Promise<Inventory>;
export function loadRegistry(path: string): Registry;
export function readLog(path: string): LogEntry[];
export function appendLog(path: string, entries: LogEntry[]): void;
export function decisionDigest(result: Evaluation): string;
export function snapshotOf(result: Evaluation): Snapshot;
export function runAudit(opts: {
  client: NeonClient;
  registry: Registry;
  now: Date;
  logPath: string;
  postComment?: ((report: string) => Promise<unknown>) | null;
}): Promise<{ result: Evaluation; report: string; digest: string; changed: boolean; notification: 'sent' | 'failed' | 'not-needed' | 'not-configured' }>;
export function renderReport(result: Evaluation, registry: Registry): string;
export function checkDeletion(opts: {
  client: NeonClient;
  registry: Registry;
  now?: () => Date;
  branchIds: string[];
  snapshot: Snapshot;
}): Promise<Verdict[]>;
export function exitCodeFor(verdicts: Verdict[]): 0 | 1 | 2;
