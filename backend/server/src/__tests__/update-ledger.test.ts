import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createUpdateLedger, unreplayedEntries, type UpdateLedgerEntry } from '../update/update-ledger.js';

const tmpPath = (): string => join(mkdtempSync(join(tmpdir(), 'recued-ledger-')), 'updates.log');

const entry = (id: string, kind: UpdateLedgerEntry['kind'] = 'apply_committed'): UpdateLedgerEntry => ({
  id, kind, at: 1, from_version: '1.3.0', to_version: '1.4.0', channel: 'stable',
  trigger: 'auto', release_identity: 'rel-1',
});

describe('update ledger', () => {
  it('appends + reads back oldest-first across reopen', () => {
    const path = tmpPath();
    const a = createUpdateLedger(path);
    a.append(entry('e1', 'apply_started'));
    a.append(entry('e2', 'apply_committed'));
    // fresh handle over the same file — append-only durability
    const b = createUpdateLedger(path);
    expect(b.readAll().map((e) => e.id)).toEqual(['e1', 'e2']);
  });

  it('returns [] for a missing file', () => {
    expect(createUpdateLedger(tmpPath()).readAll()).toEqual([]);
  });

  it('skips a malformed trailing line without losing prior history', () => {
    const path = tmpPath();
    const l = createUpdateLedger(path);
    l.append(entry('e1'));
    // simulate a torn final write
    writeFileSync(path, `${JSON.stringify(entry('e1'))}\n{"id":"e2",bad`, 'utf8');
    expect(createUpdateLedger(path).readAll().map((e) => e.id)).toEqual(['e1']);
  });

  it('a good append after a torn final line preserves BOTH (newline-boundary guard)', () => {
    const path = tmpPath();
    const l = createUpdateLedger(path);
    l.append(entry('e1'));
    // simulate a crash mid-append: a torn line with no trailing newline
    writeFileSync(path, `${JSON.stringify(entry('e1'))}\n${JSON.stringify(entry('e2')).slice(0, 10)}`, 'utf8');
    // the next good append must not concatenate onto the torn line
    createUpdateLedger(path).append(entry('e3'));
    const ids = createUpdateLedger(path).readAll().map((e) => e.id);
    expect(ids).toContain('e1');
    expect(ids).toContain('e3');
  });

  it('tail returns the newest n', () => {
    const path = tmpPath();
    const l = createUpdateLedger(path);
    ['e1', 'e2', 'e3'].forEach((id) => l.append(entry(id)));
    expect(l.tail(2).map((e) => e.id)).toEqual(['e2', 'e3']);
    expect(l.tail(99).map((e) => e.id)).toEqual(['e1', 'e2', 'e3']);
  });

  it('unreplayedEntries filters out ids already in audit (idempotent replay)', () => {
    const path = tmpPath();
    const l = createUpdateLedger(path);
    ['e1', 'e2', 'e3'].forEach((id) => l.append(entry(id)));
    expect(unreplayedEntries(l, new Set(['e1', 'e3'])).map((e) => e.id)).toEqual(['e2']);
  });
});
