import { RpcError,type CustomerJobCloseoutInput,type CustomerJobArchiveInput,type CustomerJobRestoreInput } from '@recued/contracts';
import type { ReceptionRpcDeps } from './reception-rpc-handler.js';
import { QuoteSignoffError } from './quote-signoff-service.js';
import type { CustomerJobCloseoutService } from './customer-job-closeout-service.js';
type Caller = { instance_id?: string | null } | undefined;
const run = async <T>(deps: ReceptionRpcDeps,input: unknown,caller: Caller,keys: string[],body: (service: CustomerJobCloseoutService,actor: string) => Promise<T>) => {
  if (!caller?.instance_id) throw new RpcError('unauthorized','Job closeout requires a paired owner client.',401);
  if (!deps.getCustomerJobCloseoutService) throw new RpcError('not_configured','Job closeout is unavailable on this server.',503);
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !keys.includes(key))) throw new RpcError('customer_job_closeout_invalid','Invalid job closeout input.',400);
  try { return await body(deps.getCustomerJobCloseoutService(),caller.instance_id); }
  catch (error) { if (error instanceof QuoteSignoffError) throw new RpcError(error.code,error.message,error.status);throw error; }
};
export const handleCustomerJobCloseoutGet = (deps: ReceptionRpcDeps,input: CustomerJobCloseoutInput,caller: Caller) =>
  run(deps,input,caller,['job_id'],service => service.get(input.job_id));
export const handleCustomerJobArchive = (deps: ReceptionRpcDeps,input: CustomerJobArchiveInput,caller: Caller) =>
  run(deps,input,caller,['job_id','expected_revision','expected_snapshot_hash','confirmed'],(service,actor) => service.archive(input,actor));
export const handleCustomerJobRestore = (deps: ReceptionRpcDeps,input: CustomerJobRestoreInput,caller: Caller) =>
  run(deps,input,caller,['job_id','expected_revision'],(service,actor) => service.restore(input,actor));
