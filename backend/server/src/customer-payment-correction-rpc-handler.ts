import { RpcError,type CustomerPaymentCorrectionPrepareInput,type CustomerPaymentCorrectionHistoryInput } from '@recued/contracts';
import type { ReceptionRpcDeps } from './reception-rpc-handler.js';
import { QuoteSignoffError } from './quote-signoff-service.js';
import type { CustomerPaymentCorrectionService } from './customer-payment-correction-service.js';
type Caller = { instance_id?: string | null } | undefined;
const run = async <T>(deps: ReceptionRpcDeps,input: unknown,caller: Caller,keys: string[],
  body: (service: CustomerPaymentCorrectionService,instance: string) => Promise<T>): Promise<T> => {
  if (!caller?.instance_id) throw new RpcError('unauthorized','Payment corrections require a paired owner client.',401);
  if (!deps.getCustomerPaymentCorrectionService) throw new RpcError('not_configured','Customer payment corrections are unavailable.',503);
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !keys.includes(key))) {
    throw new RpcError('customer_correction_invalid','Invalid payment correction fields.',400);
  }
  try { return await body(deps.getCustomerPaymentCorrectionService(),caller.instance_id); }
  catch (error) { if (error instanceof QuoteSignoffError) throw new RpcError(error.code,error.message,error.status);throw error; }
};
export const handleCustomerPaymentCorrectionPrepare = (deps: ReceptionRpcDeps,input: CustomerPaymentCorrectionPrepareInput,caller: Caller) =>
  run(deps,input,caller,['request_key','signoff_id','payment_id','expected_snapshot_hash','action','reason','amount','received_on','method','reference'],
    (service,instance) => service.prepare(input,instance));
export const handleCustomerPaymentCorrectionHistory = (deps: ReceptionRpcDeps,input: CustomerPaymentCorrectionHistoryInput,caller: Caller) =>
  run(deps,input,caller,['signoff_id','limit','cursor'],service => service.history(input));
