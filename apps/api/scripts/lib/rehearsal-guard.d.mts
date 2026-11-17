export declare const BRANCH_NAME_PATTERN: RegExp;
export declare const MAX_BRANCH_AGE_HOURS: number;
export declare class RehearsalTargetError extends Error {}
export declare function endpointHost(hostname: string): string;
export declare function verifyRehearsalTarget(input: {
  urls: { owner?: string; app?: string; admin?: string };
  env: Record<string, string | undefined>;
  fetchImpl?: (url: string, init?: { headers?: Record<string, string> }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;
  now?: Date;
}): Promise<{ mode: 'local' } | { mode: 'neon-branch'; branchName: string }>;
