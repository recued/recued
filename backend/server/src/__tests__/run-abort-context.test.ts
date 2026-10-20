import { describe, expect, it } from 'vitest';
import { currentRunAbortContext, withRunAbortContext } from '../execution/run-abort-context.js';

describe('host run cancellation context', () => {
  it('keeps concurrent roots separate across asynchronous work', async () => {
    const a = new AbortController(); const b = new AbortController();
    let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
    const run = (run_id: string, signal: AbortSignal) => withRunAbortContext({ run_id, signal }, async () => {
      await gate; return currentRunAbortContext();
    });
    const first = run('a', a.signal); const second = run('b', b.signal);
    expect(currentRunAbortContext()).toBeUndefined(); a.abort(); release();
    expect(await first).toEqual({ run_id: 'a', signal: a.signal });
    expect(await second).toEqual({ run_id: 'b', signal: b.signal });
    expect(b.signal.aborted).toBe(false); expect(currentRunAbortContext()).toBeUndefined();
  });

  it('restores parent identity after a child fails and keeps child abort local', async () => {
    const parent = new AbortController(); const child = new AbortController(); const refused = new Error('Fixture child failed');
    await withRunAbortContext({ run_id: 'parent', signal: parent.signal }, async () => {
      await expect(withRunAbortContext({ run_id: 'child', signal: child.signal }, async () => {
        await Promise.resolve(); child.abort();
        expect(currentRunAbortContext()?.run_id).toBe('child');
        expect(currentRunAbortContext()?.signal?.aborted).toBe(true); throw refused;
      })).rejects.toBe(refused);
      expect(currentRunAbortContext()).toEqual({ run_id: 'parent', signal: parent.signal });
      expect(parent.signal.aborted).toBe(false);
    });
    expect(currentRunAbortContext()).toBeUndefined();
  });
});
