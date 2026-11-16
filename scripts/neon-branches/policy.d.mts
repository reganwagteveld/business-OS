export interface NeonBranch {
  id: string;
  name: string;
  parent_id?: string | null;
  parent_lsn?: string | null;
  created_at?: string;
  updated_at?: string;
  current_state?: string;
  default?: boolean;
  primary?: boolean;
  protected?: boolean;
  logical_size?: number;
}
export interface NeonEndpoint {
  id: string;
  branch_id: string;
}
export interface Inventory {
  branches: NeonBranch[];
  endpoints: NeonEndpoint[];
}
export interface Policy {
  protectHours: number;
  priorityDays: number;
  minRecoveryPoints: number;
}
export type Decision = 'protected' | 'keep' | 'eligible' | 'needs-approval';
export interface BranchDecision {
  branchId: string;
  name: string;
  category: string;
  decision: Decision;
  priority: 'review' | 'cleanup' | null;
  reasons: string[];
  ageHours: number | null;
  createdAt: string | undefined;
  parentId: string | null;
  logicalSizeBytes: number | null;
  links: { migrations: string[]; prs: number[]; appliedAt: string | null } | null;
  fingerprint: string;
}
export interface Evaluation {
  evaluatedAt: string;
  registryHash: string;
  decisions: BranchDecision[];
  warnings: string[];
  verifiedRecoveryPoints: number;
  usableRecoveryPoints: number;
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Registry = Record<string, any>;
export const DEFAULT_POLICY: Policy;
export const CATEGORY: Record<'PRODUCTION' | 'RECOVERY' | 'DEVELOPMENT' | 'TESTING' | 'UNKNOWN', string>;
export const DECISION: { PROTECTED: 'protected'; KEEP: 'keep'; ELIGIBLE: 'eligible'; NEEDS_APPROVAL: 'needs-approval' };
export function validateRegistry<T extends Registry>(registry: T): T;
export function registryHash(registry: Registry): string;
export function restoreDrillVerified(entry: unknown): boolean;
export function fingerprint(branch: NeonBranch): string;
export function classify(branch: NeonBranch, registry: Registry): { category: string; source: string; note?: string };
export function evaluate(inventory: Inventory, registry: Registry, now: Date, policy?: Policy): Evaluation;
export function estimateBranchCost(branchCount: number, billing: unknown): { extraBranches: number; monthlyUsd: number; basis: string } | null;
