/** D-343 (2026-11-15) — a failed chat turn's log says where its error was thrown, never what it said:
 *  "turn failed <id>" alone hid the store refusing a Telegram reply, found only with a patched build. */
import { describe, expect, it } from 'vitest';
import { turnFailureWhere } from '../chat-turn-queue.js';

describe('D-343 — where a failed turn was thrown, without its message', () => {
  it('names the error and its first frames as function (file:line)', () => {
    const error = new Error('chat-store: the owner said "my PIN is 4321"');
    error.stack = [
      'Error: chat-store: the owner said "my PIN is 4321"',
      '    at Object.appendMessage (/srv/recued/backend/server/src/storage/chat-store.ts:2876:13)',
      '    at runTurnWithId (/srv/recued/backend/server/src/chat-orchestrator.ts:5641:51)',
      '    at process.processTicksAndRejections (node:internal/process/task_queues:104:5)',
      '    at async /srv/recued/backend/server/src/chat-held-results.ts:391:19',
    ].join('\n');
    const where = turnFailureWhere(error);
    expect(where).toBe('Error at Object.appendMessage (chat-store.ts:2876) < runTurnWithId (chat-orchestrator.ts:5641) < process.processTicksAndRejections (task_queues:104)');
    expect(where).not.toContain('4321');
    expect(where).not.toContain('/srv/');
  });

  it('says only the type for a thrown non-error', () => {
    expect(turnFailureWhere('secret text')).toBe('(string)');
    expect(turnFailureWhere(new TypeError('x'))).toMatch(/^TypeError at /u);
  });
});
