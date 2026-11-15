import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// Audit C1-02: every read of the activities table goes through the one visibility predicate
// (visibleTo), so a restricted note or a message entry can never be returned by a new read path
// that forgot it. Writes and the post-write re-read (after visibleRow proved access) are the only
// exceptions, and the re-read is a single named helper.
const SRC = resolve(__dirname, '../../src');
const READ = /db\.activity\.(findFirst|findFirstOrThrow|findMany|findUnique|findUniqueOrThrow|count|aggregate|groupBy)\(/g;

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (name === 'generated') return [];
    return statSync(path).isDirectory() ? files(path) : /\.tsx?$/.test(name) ? [path] : [];
  });
}

describe('activity visibility (audit C1-02)', () => {
  it('only the activity module reads activities, and every read applies visibleTo or is the post-write re-read', () => {
    const offenders: string[] = [];
    for (const file of files(SRC)) {
      const text = readFileSync(file, 'utf8');
      for (const match of text.matchAll(READ)) {
        const rel = file.slice(SRC.length + 1);
        if (rel !== 'modules/activity/server/activities.ts') {
          offenders.push(`${rel}: ${match[0]}`);
          continue;
        }
        const statement = text.slice(match.index!, text.indexOf(';', match.index!));
        const line = text.slice(text.lastIndexOf('\n', match.index!), text.indexOf('\n', match.index!));
        if (!statement.includes('visibleTo(viewer)') && !line.includes('visibility: checked by visibleRow before the write')) offenders.push(`${rel}: ${statement.slice(0, 80)}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
