/** D-215 slice 1a — background automation dispatches CONTRACT-FREE.
 *
 *  `4f4268a41 feat(d-209)` stamped `contract_id: OWNER_CONTRACT_ID` onto the
 *  `schedule` and `reactive` execution sources to reach the `read` trust
 *  ceiling. That included cron, periodic auto-run, and event-trigger
 *  producers. It bought nothing on either authority axis and broke dispatch:
 *
 *    CEILING  — identical either way. `resolveTrustCeiling` returns
 *               `CONTRACTED_DEFAULT_TRUST_CEILING` for a contracted source AND
 *               for a contract-free non-housekeeping `system` source.
 *    GRANTS   — identical. `gateGrantGoverningContractId` rejects the owner
 *               sentinel outright (`isReservedOwnerContractId`): the owner
 *               contract is DERIVED from provenance, never BOUND as a door id.
 *    SNAPSHOT — the only difference. `executionSourceHasContract` is true for
 *               ANY `contract_id`, so `gateRecipeAgainstPolicy` threw
 *               "requires a ContractSnapshot" on every fire and the scheduler
 *               recorded `last_status: 'error'`. No scheduled recipe ran.
 *
 *  Nothing caught it: `d-153-phase-2c-policy-gate.test.ts` builds its
 *  `scheduleSource` with no `contract_id` (it predates D-209), and
 *  `scheduling.test.ts` asserts only that the recipe was looked up — never
 *  that the run succeeded. This file pins BOTH halves so the stamp cannot
 *  come back silently.
 *
 *  ⚠ A synthesized owner snapshot is NOT the alternative fix: `allowed_tools`
 *  is a closed allowlist with no wildcard (`admitContractToolAccess` denies
 *  anything off it) and there is no `contract_definition` to resolve one from.
 *
 *  Spec: D-215 § 5a.
 */

import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CONTRACTED_DEFAULT_TRUST_CEILING,
  OWNER_CONTRACT_ID,
  executionSourceHasContract,
  resolveTrustCeiling,
  type ExecutionSource,
} from '@recued/contracts';
import { createScheduleStore } from '../schedule-store.js';
import { createScheduler } from '../scheduler.js';
import type { ExecuteHandlerDeps } from '../execute-handler.js';

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
});

const FIRE_AT = new Date(2026, 3, 14, 9, 0, 0).getTime();

const scheduleSource: ExecutionSource = {
  channel: 'schedule',
  actor: 'system',
  cron: '0 9 * * *',
  source_recipe: 'daily-briefing',
};
const autoRunSource: ExecutionSource = {
  channel: 'reactive',
  actor: 'system',
  event_kind: 'auto_run_tick',
  source_recipe: 'daily-briefing',
};
const eventTriggerSource: ExecutionSource = {
  channel: 'reactive',
  actor: 'system',
  event_kind: 'data.mail.inbox.message.created',
  source_recipe: 'inbox-triage',
};

describe('D-215 slice 1a — the stamp bought nothing on the ceiling axis', () => {
  it.each([
    ['schedule', scheduleSource],
    ['auto-run', autoRunSource],
    ['event-trigger', eventTriggerSource],
  ] as const)(
    '%s resolves the SAME `read` ceiling with and without a contract_id',
    (_name, source) => {
      const withoutStamp = resolveTrustCeiling(source);
      const withStamp = resolveTrustCeiling(
        { ...source, contract_id: OWNER_CONTRACT_ID } as ExecutionSource,
        // A contracted source would carry a snapshot; the ceiling does not
        // read it for a non-webhook door, which is the point.
        {
          contract_id: OWNER_CONTRACT_ID,
          contract_version: 'test',
          allowed_tools: [],
          approval_required: [],
          scope_restrictions: [],
          resolved_at: FIRE_AT,
        },
      );
      expect(withoutStamp).toBe(CONTRACTED_DEFAULT_TRUST_CEILING);
      expect(withStamp).toBe(withoutStamp);
    },
  );
});

describe('D-215 slice 1a — the schedulers emit contract-free sources', () => {
  it('a scheduled fire SUCCEEDS — the gate is never reached with a bare contract_id', async () => {
    const db = new Database(':memory:');
    cleanups.push(() => db.close());
    const store = createScheduleStore(db);
    const sources: ExecutionSource[] = [];

    store.set({
      schedule_id: 's1',
      recipe_id: 'test-recipe',
      publisher_id: 'me',
      cron_expression: '0 9 * * *',
      enabled: true,
      created_at: FIRE_AT - 100_000,
      last_run_at: null,
      next_run_at: null,
      last_status: null,
      last_error: null,
    });

    const execDeps: ExecuteHandlerDeps = {
      recipeStore: {
        get: (id: string) => ({
          recipe_id: id,
          version: 1,
          ttl: 60,
          metadata: { name: 'Test', description: 'd', author: 'a', supported_platforms: [] },
          variables: {},
          prefetch_steps: [],
          steps: [],
          output: { sidebar: [] },
        } as never),
        size: () => 1,
      } as unknown as ExecuteHandlerDeps['recipeStore'],
      executorConfig: {
        manifests: { get: () => undefined, size: () => 0 } as never,
        vault: {},
      },
      baseVault: {},
      instanceId: 's',
    };

    await createScheduler({ store, executeDeps: execDeps, now: () => FIRE_AT }).tick();

    const after = store.get('s1')!;
    // The regression this file exists for: before slice 1a this was 'error'
    // with "requires a ContractSnapshot".
    expect(after.last_error).toBeNull();
    expect(after.last_status).toBe('success');
    void sources;
  });

  it('⛔ RATCHET — no background automation producer may stamp a contract_id', async () => {
    // Source-level ratchet: these are the three production producers of cron,
    // periodic auto-run, and event-trigger recipe dispatch. A re-stamp would
    // silently reintroduce the outage. Reading
    // the source is deliberate — the behavioural test above proves the effect,
    // this proves the CAUSE stays removed even if a future gate change hides
    // the symptom.
    const { readFileSync } = await import('node:fs');
    for (const file of [
      'scheduler.ts',
      'auto-run-scheduler.ts',
      'composition/bin/wire-event-triggers.ts',
    ]) {
      const src = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
      // Strip line + block comments — the files DOCUMENT the removed stamp at
      // length, and a substring match would trip on the explanation itself.
      const code = src
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .split('\n')
        .map((l) => l.replace(/\/\/.*$/, ''))
        .join('\n');
      expect(code).not.toMatch(/contract_id\s*:/);
      expect(code).not.toMatch(/OWNER_CONTRACT_ID/);
    }
  });

  it('executionSourceHasContract is false for every background source', () => {
    expect(executionSourceHasContract(scheduleSource)).toBe(false);
    expect(executionSourceHasContract(autoRunSource)).toBe(false);
    expect(executionSourceHasContract(eventTriggerSource)).toBe(false);
  });
});
