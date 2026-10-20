import type { Conn, ServerRpcRegistry, ConnectionReplacementInspect, ConnectionReplacementInspection,
  ConnectionReplacementReview, ConnectionReplacementRollback, ConnectionReplacementPlan,
  ConnectionReplacementApply, ConnectionReplacementResult } from '@recued/contracts';
export interface ConnectionReplacementCaller {
  inspect(request: ConnectionReplacementInspect): Promise<ConnectionReplacementInspection>;
  review(request: ConnectionReplacementReview): Promise<ConnectionReplacementPlan>;
  rollback(request: ConnectionReplacementRollback): Promise<ConnectionReplacementPlan>;
  apply(request: ConnectionReplacementApply): Promise<ConnectionReplacementResult>;
}
export const createConnectionReplacementCaller = (call: Conn<ServerRpcRegistry>): ConnectionReplacementCaller => ({
  inspect: request => call('packs.connections.replace.inspect', request),
  review: request => call('packs.connections.replace.review', request),
  rollback: request => call('packs.connections.replace.rollback', request),
  apply: request => call('packs.connections.replace.apply', request),
});
