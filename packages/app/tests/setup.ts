// No test may reach a real network. Every test injects its own clients over an in-memory fetch; a client
// the app creates by default (for example the dashboard's, when a test passes only some clients) fails at
// once as "unreachable" instead of trying DNS for the fake API host.
globalThis.fetch = (async () => {
  throw new TypeError('Failed to fetch (tests have no network)');
}) as typeof fetch;
