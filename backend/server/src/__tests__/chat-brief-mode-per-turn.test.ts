import Database from 'better-sqlite3';
import { expect, it } from 'vitest';
import type { InternalToolRegistry } from '@recued/contracts';
import { createChatStore, ensureChatSchema } from '../storage/chat-store.js';
import { createChatOrchestrator } from '../chat-orchestrator.js';
import { BRIEF_INSTRUCTION } from '../chat-rolling-brief.js';
import { STANDARD_BRIEF_ACTION_GUIDANCE } from '../chat-turn-executor.js';

// The owner, 2026-11-18: "the brief is an independent session running on its own without owner's
// interaction, and it should only produce a summary without making any tool calls, and it should start
// at context bloated or almost … so that extra wait time only happens at that stage". The retired
// Consolidated style read each owner request with model calls before every turn. Nothing reads a request
// before a turn now; the reader takes the note setting once for its turn.
it('reads no owner request before a turn; the reader takes the note setting for its turn, and a settings change applies to the next owner turn', async () => {
  const db = new Database(':memory:');
  try {
    ensureChatSchema(db); const chat = createChatStore(db, () => new Uint8Array(32).fill(8));
    chat.createSession({ id: 's', now: 1 }); chat.setRollingBriefEnabled(true);
    const registry: InternalToolRegistry = { list: () => [], listByTier: () => [], getByName: () => null,
      subscribeRefresh: () => () => {}, dispatch: async () => { throw new Error('No tool is requested'); } };
    const main: { guidance: boolean; assignment?: unknown }[] = []; let readings = 0, ids = 0, time = 100;
    const orchestrator = createChatOrchestrator({ chatStore: chat, registry,
      selfSignature: { server_kind: 'recued', version: 'test', instance_id: 'scope-settings' },
      broadcast: { emit: () => {} }, mintId: () => 'settings-' + (++ids), now: () => ++time,
      executeAiCall: async (_manifest, input) => {
        const packet = JSON.parse(String(input['llm.prompt']));
        const system = String(input['llm.system_prompt']);
        // Any call that is neither the chat's own (it carries the owner's message) nor the brief's reads the request.
        if (!('user_message' in packet) && !system.startsWith(BRIEF_INSTRUCTION)) {
          readings++;
          throw new Error('Nothing reads the owner request before a turn');
        }
        main.push({ guidance: system.includes(STANDARD_BRIEF_ACTION_GUIDANCE),
          assignment: packet.request_execution_context?.current_assignment });
        return { body: { response: 'No work remains.', events: [], tool_calls: [], nothing_outstanding: true } };
      },
    });
    await orchestrator.runTurn({ session_id: 's', message: 'Report status only.', picker_state: { current: 'self' } });
    expect(main[0]).toEqual({ guidance: true, assignment: undefined });
    chat.setRollingBriefEnabled(false);
    await orchestrator.runTurn({ session_id: 's', message: 'Hello.', picker_state: { current: 'self' } });
    expect(main[1]).toEqual({ guidance: false, assignment: undefined }); expect(readings).toBe(0);
  } finally { db.close(); }
});
