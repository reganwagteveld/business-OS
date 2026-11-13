declare module '../scripts/check-boundaries.mjs' {
  export function violations(files: Array<[string, string]>): string[];
}
