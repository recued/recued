import { expect,it } from 'vitest';
import type { Conn,ServerRpcRegistry } from '@recued/contracts';
import { createRecipeRunCaptureCaller } from '../recipe-run-capture-caller.js';
import { WEBCLIENT_RUN_RPC_TIMEOUT_MS } from '../../../realtime/rpc-conn.js';
it('uses the normal live-run wait budget and never retries a failed capture run',async () => {
  const calls: Array<{ method: string; args: unknown; options: unknown }> = [];
  const call: Conn<ServerRpcRegistry> = (async (method: string,args?: unknown,options?: unknown) => {
    calls.push({ method,args,options }); throw new Error('Reply lost');
  }) as Conn<ServerRpcRegistry>;
  const caller = createRecipeRunCaptureCaller(call);
  await expect(caller.run({ capture_id: 'prepared-id' })).rejects.toThrow('Reply lost');
  expect(calls).toEqual([{ method: 'recipe.capture.run',args: { capture_id: 'prepared-id' },options: { timeout: WEBCLIENT_RUN_RPC_TIMEOUT_MS } }]);
  await expect(caller.get({ capture_id: 'prepared-id' })).rejects.toThrow('Reply lost'); expect(calls).toHaveLength(2);
});
