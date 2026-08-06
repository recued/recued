/** Ratchet: the calendar TEST fixture must have the same column set as the
 *  table production actually creates.
 *
 *  ⛔ This is the guard that was missing. Six producers read `hot_fields` off
 *  a calendar table for as long as they have existed, and every test passed,
 *  because every test created its calendar fixture with MAIL's DDL. The
 *  fixture was the only table anywhere with the column the producers read.
 *  A green suite proved nothing about production.
 *
 *  A hand-written fixture is only safe if something forces it to track the
 *  real schema. That is this file. */

import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';

import { createCalendarTable } from '../collections/calendar/calendar-table.js';
import { createCalendarFixtureTable } from './_calendar-fixture.js';

const columnsOf = (db: Database.Database, table: string): string[] =>
  (
    db.prepare(`SELECT name FROM pragma_table_info(?)`).all(table) as Array<{
      name: string;
    }>
  )
    .map((r) => r.name)
    .sort();

describe('calendar fixture matches production', () => {
  it('has the identical column set to createCalendarTable', () => {
    const db = new Database(':memory:');
    const real = createCalendarTable({ db, slug: 'prod' });
    createCalendarFixtureTable(db, 'collection_calendar_ffffffffff');

    const realCols = columnsOf(db, real.tableName);
    const fixtureCols = columnsOf(db, 'collection_calendar_ffffffffff');

    expect(realCols.length).toBeGreaterThan(0);
    expect(fixtureCols).toEqual(realCols);

    // The specific claim that was false for years: production has NO
    // `hot_fields` column, and the fixture must not invent one.
    expect(realCols).not.toContain('hot_fields');
    expect(fixtureCols).not.toContain('hot_fields');
    expect(realCols).toContain('record_payload');

    db.close();
  });

  it('no test creates a calendar table with mail-shaped DDL', () => {
    // The footgun guard. A future test that hand-rolls `hot_fields TEXT` on a
    // `collection_calendar_*` table reintroduces the exact blind spot.
    const { readdirSync, readFileSync } = require('node:fs') as typeof import('node:fs');
    const dir = new URL('.', import.meta.url).pathname;
    const offenders: string[] = [];
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.ts')) continue;
      const text = readFileSync(`${dir}${name}`, 'utf8');
      if (!/collection_calendar/.test(text)) continue;
      // A CREATE TABLE naming a calendar table AND declaring hot_fields.
      for (const m of text.matchAll(/CREATE TABLE[^;]*?;/gs)) {
        if (/hot_fields\s+TEXT/.test(m[0]) && /calendar/i.test(m[0])) {
          offenders.push(name);
        }
      }
      // The common indirection: `for (const t of [CAL_A, CAL_B]) CREATE TABLE ${t}`
      if (
        /CAL[A-Z_]*TABLE/.test(text)
        && /CREATE TABLE[^;]*hot_fields\s+TEXT/s.test(text)
        && !/collection_mail/.test(text)
      ) {
        offenders.push(name);
      }
    }
    expect([...new Set(offenders)]).toEqual([]);
  });
});
