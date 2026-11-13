// Runs once when a Next.js server instance starts: refuse to boot with invalid configuration.
export async function register() {
  const { parseEnv } = await import('./core/config/schema');
  parseEnv(process.env);
}
