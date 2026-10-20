import type { Conn, ServerRpcRegistry, PackRepairReview, PackRepairPlan, PackRepairApply, PackRepairApplyResult, PackRepairInspection } from '@recued/contracts';
export interface PackRepairCaller {
  inspect(): Promise<PackRepairInspection>;
  review(request: PackRepairReview): Promise<PackRepairPlan>;
  apply(request: PackRepairApply): Promise<PackRepairApplyResult>;
}
export const createPackRepairCaller = (call: Conn<ServerRpcRegistry>): PackRepairCaller => ({
  inspect: () => call('packs.repair.inspect', {}),
  review: request => call('packs.repair.review', request),
  apply: request => call('packs.repair.apply', request),
});
