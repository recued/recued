import { expect,it,vi } from 'vitest';
import type { Conn,ServerRpcRegistry } from '@recued/contracts';
import { createPackRemovalCaller } from '../settings/pack-removal-caller.js';
it('uses identifier-only reviewed removal requests with an explicit apply timeout',async () => {
  const call = vi.fn(async () => ({})),caller = createPackRemovalCaller(call as unknown as Conn<ServerRpcRegistry>);
  const review = { pack_slug: 'pack',request_id: 'review' },apply = { review_id: 'opaque-review',request_id: 'apply',acknowledge_unknown_dependencies: true };
  await caller.review(review);await caller.apply(apply);
  expect(call.mock.calls).toEqual([['packs.removal.review',review],['packs.removal.apply',apply,{ timeout: 65_000 }]]);
});
