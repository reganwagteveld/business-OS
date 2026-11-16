import type { Evaluation, Inventory, NeonBranch, NeonEndpoint, Registry } from './policy.mjs';

export class NeonApiError extends Error {}
export interface NeonClient {
  projectId: string;
  listBranches(): Promise<NeonBranch[]>;
  listEndpoints(): Promise<NeonEndpoint[]>;
  deleteBranch(branchId: string): Promise<unknown>;
}
export interface LogEntry {
  at: string;
  run: string;
  action: 'audit' | 'decision' | 'delete';
  branchId?: string;
  name?: string;
  decision?: string;
  outcome?: string;
  reasons?: string[];
  [key: string]: unknown;
}
export function neonctlClient(projectId: string, opts?: { bin?: string; timeoutMs?: number }): NeonClient;
export function fetchInventory(client: NeonClient): Promise<Inventory>;
export function loadRegistry(path: string): Registry;
export function readLog(path: string): LogEntry[];
export function appendLog(path: string, entries: LogEntry[]): void;
export function decisionDigest(result: Evaluation): string;
export function runAudit(opts: {
  client: NeonClient;
  registry: Registry;
  now: Date;
  logPath: string;
  postComment?: ((report: string) => Promise<unknown>) | null;
}): Promise<{ result: Evaluation; report: string; digest: string; changed: boolean }>;
export function renderReport(result: Evaluation, registry: Registry): string;
export function runDeletion(opts: {
  client: NeonClient;
  registry: Registry;
  now?: () => Date;
  logPath: string;
  lockPath: string;
  branchIds: string[];
  approval: string;
  snapshot: Map<string, string>;
  execute?: boolean;
}): Promise<LogEntry[]>;
