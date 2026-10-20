import type { Conn,ServerRpcRegistry,PackRemovalReview,PackRemovalPlan,PackRemovalApply,PackRemovalApplyResult } from '@recued/contracts';
export interface PackRemovalCaller {
  review(request: PackRemovalReview): Promise<PackRemovalPlan>;
  apply(request: PackRemovalApply): Promise<PackRemovalApplyResult>;
}
export const createPackRemovalCaller = (call: Conn<ServerRpcRegistry>): PackRemovalCaller => ({
  review: request => call('packs.removal.review',request),
  apply: request => call('packs.removal.apply',request,{ timeout: 65_000 }),
});
