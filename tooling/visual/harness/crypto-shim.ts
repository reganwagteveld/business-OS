// The test fakes import randomUUID from node:crypto (aliased here by vite.config.ts). A seeded counter
// instead of real randomness keeps every id, and so every id-ordered list, the same on each run.
let n = 0;
export const randomUUID = (): `${string}-${string}-${string}-${string}-${string}` => {
  n += 1;
  const hex = n.toString(16).padStart(12, '0');
  return `00000000-0000-4000-8000-${hex}`;
};
// Fixture code that calls the global (crypto.randomUUID()) gets the same sequence.
globalThis.crypto.randomUUID = randomUUID;
