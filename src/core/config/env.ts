import 'server-only';
import { parseEnv, type Env } from './schema';

let cached: Env | undefined;

/** Validated server environment. Throws with a readable message if anything is missing or invalid. */
export function getEnv(): Env {
  cached ??= parseEnv(process.env);
  return cached;
}
