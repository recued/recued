import type { CustomerCreditCorrectionPrepareInput,CustomerCreditCorrectionHistoryInput } from '@recued/contracts';
import { RpcError,type CustomerInvoiceCreditPrepareInput,type CustomerInvoiceCreditHistoryInput,type CustomerInvoiceCreditCopyInput } from '@recued/contracts';
import type { ReceptionRpcDeps } from './reception-rpc-handler.js';
import { QuoteSignoffError } from './quote-signoff-service.js';
import type { CustomerInvoiceCreditService } from './customer-invoice-credit-service.js';
type Caller = { instance_id?: string | null } | undefined;
const run = async <T>(deps: ReceptionRpcDeps,input: unknown,caller: Caller,keys: string[],body: (service: CustomerInvoiceCreditService,instance: string) => Promise<T>): Promise<T> => {
  if (!caller?.instance_id) throw new RpcError('unauthorized','Invoice credits require a paired owner client.',401);
  if (!deps.getCustomerInvoiceCreditService) throw new RpcError('not_configured','Customer invoice credits are unavailable.',503);
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !keys.includes(key))) throw new RpcError('customer_credit_invalid','Invalid invoice credit fields.',400);
  try { return await body(deps.getCustomerInvoiceCreditService(),caller.instance_id); }
  catch (error) { if (error instanceof QuoteSignoffError) throw new RpcError(error.code,error.message,error.status);throw error; }
};
export const handleCustomerInvoiceCreditPrepare = (deps: ReceptionRpcDeps,input: CustomerInvoiceCreditPrepareInput,caller: Caller) =>
  run(deps,input,caller,['request_key','signoff_id','expected_snapshot_hash','amount','issued_on','reason'],(service,instance) => service.prepare(input,instance));
export const handleCustomerInvoiceCreditHistory = (deps: ReceptionRpcDeps,input: CustomerInvoiceCreditHistoryInput,caller: Caller) =>
  run(deps,input,caller,['signoff_id','limit','cursor'],service => service.history(input));
export const handleCustomerInvoiceCreditCopy = (deps: ReceptionRpcDeps,input: CustomerInvoiceCreditCopyInput,caller: Caller) =>
  run(deps,input,caller,['signoff_id','credit_id'],service => service.copy(input));
export const handleCustomerCreditCorrectionPrepare = (deps: ReceptionRpcDeps,input: CustomerCreditCorrectionPrepareInput,caller: Caller) =>
  run(deps,input,caller,['request_key','signoff_id','credit_id','expected_snapshot_hash','action','reason','reversed_on','amount','issued_on','replacement_reason'],(service,instance) => service.prepareCorrection(input,instance));
export const handleCustomerCreditCorrectionHistory = (deps: ReceptionRpcDeps,input: CustomerCreditCorrectionHistoryInput,caller: Caller) =>
  run(deps,input,caller,['signoff_id','limit','cursor'],service => service.correctionHistory(input));
