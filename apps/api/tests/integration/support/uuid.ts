const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

/**
 * Replaces every UUID in serialised output with a fixed token. Use before a negative substring assertion with a short
 * numeric or hex-like needle (for example an amount such as '4321'): a random UUID contains such a needle by chance
 * (about 1 run in 4,000 for four digits), which would fail the test without any real leak. Real ids are still
 * asserted separately where they matter.
 */
export function withoutUuids(text: string): string {
  return text.replace(UUID, '<uuid>');
}
