import { describe, expect, it, vi } from 'vitest';
import { createMcpProgressReceiver } from '../mcp-progress.js';

describe('MCP progress admission', () => {
  it('admits only finite increasing measurements for the exact request, without provider prose', () => {
    const report = vi.fn();
    const receive = createMcpProgressReceiver(7, report);
    for (const params of [null, [], { progressToken: 8, progress: 1 },
      { progressToken: '7', progress: 1 }, { progressToken: 7, progress: NaN },
      { progressToken: 7, progress: 3, total: 2 }, { progressToken: 7, progress: -1 }]) receive(params);
    expect(report).not.toHaveBeenCalled();
    receive({ progressToken: 7, progress: 1, total: 5, message: 'private filename', secret: 'private' });
    receive({ progressToken: 7, progress: 1 });
    receive({ progressToken: 7, progress: 0 });
    receive({ progressToken: 7, progress: 2 });
    expect(report.mock.calls).toEqual([
      [{ kind: 'provider', current: 1, total: 5 }], [{ kind: 'provider', current: 2 }],
    ]);
  });
});
