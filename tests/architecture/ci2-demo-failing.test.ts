import { expect, test } from 'vitest';
test('CI-2 demo: deliberately failing required check', () => {
  expect(1).toBe(2);
});
