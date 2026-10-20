import { expect, it, vi } from 'vitest';
import type { Conn, ServerRpcRegistry } from '@recued/contracts';
import { createPackRepairCaller } from '../settings/pack-repair-caller.js';
it('uses the reserved owner repair RPCs with closed identifier and acknowledgement requests', async () => {
  const call = vi.fn(async () => ({})), caller = createPackRepairCaller(call as unknown as Conn<ServerRpcRegistry>);
  const review = { inventory_key: 'pack', request_id: 'review' }, apply = { review_id: 'opaque-review', request_id: 'apply', acknowledge_local_cleanup: true };
  await caller.inspect();await caller.review(review);await caller.apply(apply);
  expect(call.mock.calls).toEqual([['packs.repair.inspect', {}], ['packs.repair.review', review], ['packs.repair.apply', apply]]);
});
