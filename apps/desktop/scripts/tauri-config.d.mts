export function apiOrigin(value: string | undefined): string;
export function generatedConfig(
  baseConfig: { app: { security: { csp: Record<string, string> } } },
  origin: string,
): { app: { security: { csp: Record<string, string> } } };
