/** D-336 slice K — `projectFields` reads a few top-level fields of every row and nothing else,
 *  so the Memory view's count of relationships never parses a body. */
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { isFieldProjectable } from '@recued/storage';

import { createSQLiteCollection } from '../sqlite-collection.js';

interface Row { id: string; n?: number; claim?: { relation: string }; flag?: boolean; body?: string }

const opened: Database.Database[] = [];
afterEach(() => { for (const db of opened.splice(0)) db.close(); });
const collection = () => {
  const db = new Database(':memory:');
  opened.push(db);
  return createSQLiteCollection<Row>(db, 'rows');
};

describe('D-336 slice K — a collection reads named fields of every row', () => {
  it('keeps each value as it was stored, and leaves out a field a row lacks', async () => {
    const c = collection();
    expect(isFieldProjectable(c)).toBe(true);
    await c.set('a', { id: 'a', n: 3, claim: { relation: 'daughter of' }, flag: false, body: 'x'.repeat(10_000) });
    await c.set('b', { id: 'b' });
    const rows = await c.projectFields(['id', 'n', 'claim', 'flag']);
    expect(rows).toEqual([{ id: 'a', n: 3, claim: { relation: 'daughter of' }, flag: false }, { id: 'b' }]);
    // A string that reads like JSON stays a string.
    await c.set('c', { id: '{"x":1}' });
    expect((await c.projectFields(['id'])).map((r) => r.id)).toContain('{"x":1}');
  });

  it('answers one field as an object too, nothing for no fields, and refuses a name that is not a field', async () => {
    const c = collection();
    await c.set('a', { id: 'a', n: 1 });
    expect(await c.projectFields(['n'])).toEqual([{ n: 1 }]);
    expect(await c.projectFields([])).toEqual([]);
    await expect(c.projectFields(["id') FROM rows; --" as 'id'])).rejects.toThrow();
  });
});
