/** D-182 — chat activity honesty: a FAILED recipe run carries a user-facing
 *  `run_failed` signal so the activity row reads as an error (not "used X ✓"),
 *  while the MODEL-facing result stays `ok: true` (the tuned anti-loop posture). */

import { describe, expect, it } from 'vitest';

import { wrapRecipeRunResult } from '../chat-tool-handlers.js';
import { toolCallProvenanceEntry } from '../chat-turn-executor.js';
import {
  stampExecuteResponseAuditRun,
  type ExecuteResponse,
} from '../types.js';

type ProvenanceArgs = Parameters<typeof toolCallProvenanceEntry>;
const provEntry = (result: ProvenanceArgs[1]) =>
  toolCallProvenanceEntry(
    { tool: 'recipe.run', args: {} } as ProvenanceArgs[0],
    result,
    {} as ProvenanceArgs[2],
    1, // started_at
    2, // completed_at
    'sess',
    'turn',
    2, // tier_override (so the empty registry stub is never consulted)
  );

const resp = (over: Partial<ExecuteResponse>): ExecuteResponse =>
  ({ recipe_id: 'r1', success: true, errors: [], ...over }) as ExecuteResponse;

describe('D-182 — wrapRecipeRunResult run_failed', () => {
  it('threads only a host-stamped durable run id outside the model-visible result', () => {
    const response = stampExecuteResponseAuditRun(
      resp({ success: true }),
      'run-exact-1',
    );
    const r = wrapRecipeRunResult(response);

    expect(r.ok).toBe(true);
    expect(r.run_id).toBe('run-exact-1');
    expect(JSON.stringify(response)).not.toContain('run-exact-1');
    expect(Object.keys(response)).not.toContain('run_id');
  });

  it('a FAILED run → ok:true (model anti-loop) + run_failed = the first error message', () => {
    const r = wrapRecipeRunResult(resp({
      success: false,
      errors: [{ message: "cli tool 'whisper' was not found", code: 'CLI_TOOL_NOT_FOUND' }],
    }));
    expect(r.ok).toBe(true);
    expect(r.ok && r.run_failed?.detail).toBe("cli tool 'whisper' was not found");
  });

  it('a failed run with no error message → a generic fallback detail', () => {
    const r = wrapRecipeRunResult(resp({ success: false, errors: [] }));
    expect(r.ok && r.run_failed?.detail).toBe('the run did not complete');
  });

  it('a SUCCESSFUL run → ok:true, NO run_failed', () => {
    const r = wrapRecipeRunResult(resp({ success: true }));
    expect(r.ok).toBe(true);
    expect(r.ok && r.run_failed).toBeUndefined();
  });

  it('a HELD run (awaiting_approval) → ok:true, NO run_failed (it has its own plan card)', () => {
    const r = wrapRecipeRunResult(resp({ success: false, awaiting_approval: true }));
    expect(r.ok).toBe(true);
    expect(r.ok && r.run_failed).toBeUndefined();
    expect(r.ok && r.run_held).toEqual({ kind: 'approval' });
  });

  it('an OWNER-cancelled run → ok:false reason run_cancelled (NOT run_failed)', () => {
    const r = wrapRecipeRunResult(resp({ success: false, run_terminated: 'killed' }), 'do-thing');
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason).toBe('run_cancelled');
  });
});

describe('D-182 — persisted tool-call provenance honours run_failed (the row STICKS)', () => {
  it('a run_failed dispatch PERSISTS as status:error (not "ok") so message_complete keeps the error row', () => {
    const entry = provEntry({
      ok: true,
      result: {},
      run_failed: { detail: "cli tool 'whisper' was not found" },
    });
    expect(entry.status).toBe('error');
    expect(entry.reason).toBe('execution_error');
    expect(entry.detail).toBe("cli tool 'whisper' was not found");
    // An error row carries no result_ref (no payload to expand).
    expect(entry.result_ref).toBeUndefined();
  });

  it('an ordinary ok dispatch still persists as status:ok with a result_ref', () => {
    const entry = provEntry({ ok: true, result: { rows: [] } });
    expect(entry.status).toBe('ok');
    expect(entry.result_ref).toBe('sess:turn:recipe.run');
  });
});
