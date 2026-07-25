/** D-153 P1.B — AuditLogStore tier-scope listBy* methods.
 *
 *  Verifies the three new methods (`listByChannelSession` /
 *  `listByCognitionSession` / `listByCorrelation`) match the same
 *  shape + behavior as the existing `listByRecipe`: in-memory filter
 *  + sorted DESC by `started_at` + optional limit.
 *
 *  Spec: docs/d-153-spec.md § Three-tier session IDs. */

import { describe, expect, it } from 'vitest';

import {
  buildAuditEntry,
  createAuditLogStore,
  createInMemoryCollection,
  type ActivityEntry,
  type AuditEntry,
  type AuditEntryInput,
  type AuditLogStore,
} from '../index.js';

const mkLog = (): AuditLogStore =>
  createAuditLogStore(
    createInMemoryCollection<AuditEntry>(),
    createInMemoryCollection<ActivityEntry>(),
  );

const baseInput = (over: Partial<AuditEntryInput> = {}): AuditEntryInput => ({
  recipe_id: 'r',
  recipe_hash: 'h',
  commit_status: 'succeeded',
  duration_ms: 100,
  errors: [],
  ...over,
});

describe('AuditLogStore.listByChannelSession', () => {
  it('returns matching rows newest-first', async () => {
    const log = mkLog();
    await log.append(buildAuditEntry(baseInput({
      run_id: 'a', channel_session_id: 'ch-1', now: 1_000,
    })));
    await log.append(buildAuditEntry(baseInput({
      run_id: 'b', channel_session_id: 'ch-1', now: 3_000,
    })));
    await log.append(buildAuditEntry(baseInput({
      run_id: 'c', channel_session_id: 'ch-2', now: 5_000,
    })));
    const got = await log.listByChannelSession('ch-1');
    expect(got.map((e) => e.run_id)).toEqual(['b', 'a']);
  });

  it('returns [] for empty id', async () => {
    const log = mkLog();
    await log.append(buildAuditEntry(baseInput({ channel_session_id: 'ch-1' })));
    expect(await log.listByChannelSession('')).toEqual([]);
  });

  it('returns [] for unknown id', async () => {
    const log = mkLog();
    await log.append(buildAuditEntry(baseInput({ channel_session_id: 'ch-1' })));
    expect(await log.listByChannelSession('ch-99')).toEqual([]);
  });

  it('skips rows lacking the field entirely (legacy / non-engine writes)', async () => {
    const log = mkLog();
    await log.append(buildAuditEntry(baseInput({ run_id: 'legacy' })));
    await log.append(buildAuditEntry(baseInput({
      run_id: 'tagged', channel_session_id: 'ch-1',
    })));
    const got = await log.listByChannelSession('ch-1');
    expect(got.map((e) => e.run_id)).toEqual(['tagged']);
  });

  it('respects the limit when supplied', async () => {
    const log = mkLog();
    for (let i = 0; i < 5; i++) {
      await log.append(buildAuditEntry(baseInput({
        run_id: `r${i}`, channel_session_id: 'ch-1', now: 1_000 + i * 100,
      })));
    }
    const got = await log.listByChannelSession('ch-1', 2);
    expect(got.map((e) => e.run_id)).toEqual(['r4', 'r3']);
  });
});

describe('AuditLogStore.listByCognitionSession', () => {
  it('returns only rows whose cognition_session_id matches', async () => {
    const log = mkLog();
    await log.append(buildAuditEntry(baseInput({
      run_id: 'a', cognition_session_id: 'cog-1', now: 1_000,
    })));
    await log.append(buildAuditEntry(baseInput({
      run_id: 'b', cognition_session_id: 'cog-2', now: 2_000,
    })));
    await log.append(buildAuditEntry(baseInput({
      run_id: 'c', cognition_session_id: 'cog-1', now: 3_000,
    })));
    const got = await log.listByCognitionSession('cog-1');
    expect(got.map((e) => e.run_id)).toEqual(['c', 'a']);
  });

  it('does not match against channel_session_id with the same string', async () => {
    const log = mkLog();
    await log.append(buildAuditEntry(baseInput({
      run_id: 'misc', channel_session_id: 'overlap',
    })));
    expect(await log.listByCognitionSession('overlap')).toEqual([]);
  });

  it('returns [] for empty id', async () => {
    const log = mkLog();
    await log.append(buildAuditEntry(baseInput({ cognition_session_id: 'cog-1' })));
    expect(await log.listByCognitionSession('')).toEqual([]);
  });
});

describe('AuditLogStore.listByCorrelation', () => {
  it('returns the full intent burst newest-first', async () => {
    const log = mkLog();
    await log.append(buildAuditEntry(baseInput({
      run_id: '1', correlation_id: 'corr-dentist', now: 1_000,
    })));
    await log.append(buildAuditEntry(baseInput({
      run_id: '2', correlation_id: 'corr-dentist', now: 1_500,
    })));
    await log.append(buildAuditEntry(baseInput({
      run_id: '3', correlation_id: 'corr-other', now: 1_700,
    })));
    await log.append(buildAuditEntry(baseInput({
      run_id: '4', correlation_id: 'corr-dentist', now: 2_500,
    })));
    const got = await log.listByCorrelation('corr-dentist');
    expect(got.map((e) => e.run_id)).toEqual(['4', '2', '1']);
  });

  it('returns [] for empty id', async () => {
    const log = mkLog();
    await log.append(buildAuditEntry(baseInput({ correlation_id: 'corr-1' })));
    expect(await log.listByCorrelation('')).toEqual([]);
  });
});
