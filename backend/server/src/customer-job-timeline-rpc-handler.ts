import { RpcError,type CustomerJobTimelineInput } from '@recued/contracts';
import type { ReceptionRpcDeps } from './reception-rpc-handler.js';
import { QuoteSignoffError } from './quote-signoff-service.js';

export const handleCustomerJobTimeline = async (deps: ReceptionRpcDeps,input: CustomerJobTimelineInput,
  caller: { instance_id?: string | null } | undefined) => {
  if (!caller?.instance_id) throw new RpcError('unauthorized','Job timelines require a paired owner client.',401);
  if (!deps.getCustomerJobTimelineService) throw new RpcError('not_configured','Job timelines are unavailable on this server.',503);
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || Object.keys(input).some(key => !['job_id','category','search','limit','cursor'].includes(key))) {
    throw new RpcError('customer_job_timeline_invalid','Invalid job timeline query.',400);
  }
  try { return await deps.getCustomerJobTimelineService().get(input); }
  catch (error) { if (error instanceof QuoteSignoffError) throw new RpcError(error.code,error.message,error.status);throw error; }
};
