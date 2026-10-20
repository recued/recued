import { expect, it, vi } from 'vitest';
import type { Conn, ServerRpcRegistry } from '@recued/contracts';
import { createConnectionReplacementCaller } from '../connections/connection-replacement-caller.js';
it('uses only reserved local account-reference RPCs and carries exact request identities', async () => {
  const call = vi.fn(async () => ({})), caller = createConnectionReplacementCaller(call as unknown as Conn<ServerRpcRegistry>);
  const inspect = { from_connection: 'old', to_connection: 'next' }, review = { ...inspect, targets: [{ pack_slug: 'pack', slot: 'account' }], dish_ids: [], request_id: 'review' };
  const rollback = { receipt_id: 'review', request_id: 'rollback' }, apply = { review_id: 'review', request_id: 'apply', acknowledge_account_change: true };
  await caller.inspect(inspect);await caller.review(review);await caller.rollback(rollback);await caller.apply(apply);
  expect(call.mock.calls).toEqual([['packs.connections.replace.inspect', inspect], ['packs.connections.replace.review', review], ['packs.connections.replace.rollback', rollback], ['packs.connections.replace.apply', apply]]);
});
