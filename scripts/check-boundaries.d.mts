export const SERVER_ROOT: string;
export const CLIENT_ROOTS: string[];
export function serverViolations(files: Array<[string, string]>): string[];
export function clientViolations(files: Array<[string, string]>): string[];
export function readSourceTree(root: string, relativeTo?: string): Array<[string, string]>;
export function checkRepository(repoRoot: string): { files: number; errors: string[] };
