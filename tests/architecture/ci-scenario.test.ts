import { expect, test } from 'vitest';

// CI scenario: a deliberately failing test must block the required gate.
test('deliberately failing test', () => {
  expect(1).toBe(2);
});
